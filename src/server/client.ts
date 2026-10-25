/** 终端与桌面共用的 REST 传输；Agent、工具与会话文件始终由服务端持有。 */
import { randomUUID } from 'node:crypto';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { Output, TokenUsage, StreamProgress, ToolResultDetail } from '../output/types.js';
import type { ConfigOverrides } from '../config/index.js';
import type { RunOptions, SubagentEvent } from '../agent/types.js';
import type { ModelEndpoint } from '../client.js';

export interface ServerConnection { url: string; token: string; workspaceId?: string; serverUrl?: string }
export interface ServerEvent { seq: number; type: string; data: Record<string, any> }
export interface ServerSnapshot {
  seq: number;
  status: Record<string, any>;
  approvals?: Record<string, any>[];
  asks?: Record<string, any>[];
  active?: unknown;
}

export class ServerHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** 显式地址必须是 HTTP(S) 且不得把凭据放入 URL。 */
export function serverConnection(url: string, token = process.env.OMNI_SERVER_TOKEN ?? ''): ServerConnection {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('--server 需要不含凭据和查询参数的 HTTP(S) 地址');
  }
  if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw new Error('远程 server 连接须使用 HTTPS');
  }
  return { url: parsed.href.replace(/\/$/, ''), token };
}

export async function connectTerminalServer(cwd: string, overrides: ConfigOverrides = {}, url?: string): Promise<ServerConnection> {
  if (url) return serverConnection(url);
  const { ensureSharedServer } = await import('./manager.js');
  return ensureSharedServer({ cwd, overrides });
}

export class ServerClient {
  constructor(readonly connection: ServerConnection) {}
  async request<T = any>(route: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.connection.token) headers.authorization = `Bearer ${this.connection.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const timeout = AbortSignal.timeout(30_000);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    timeout.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      const response = await fetch(this.connection.url + route, {
        method: body === undefined ? 'GET' : 'POST', headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal,
        redirect: 'error',
      });
      let result: any;
      try { result = await response.json(); } catch { throw new Error(`Server 返回非 JSON 响应（${response.status}）`); }
      if (!response.ok) throw new ServerHttpError(response.status, String(result.error ?? `Server HTTP ${response.status}`));
      return result as T;
    } finally {
      signal?.removeEventListener('abort', abort);
      timeout.removeEventListener('abort', abort);
    }
  }

  async createSession(config: Record<string, unknown> = {}, resume?: string): Promise<ServerSession> {
    const response = await this.request<{ id: string }>('/api/sessions', { config, ...(resume ? { resume } : {}) });
    return new ServerSession(this, response.id);
  }
}

/** 可恢复长轮询：不依赖 Node EventSource，Node 18、bun、Electron 共用。 */
export class ServerSession {
  status: Record<string, any> = {};
  messages: ChatCompletionMessageParam[] = [];
  lastReason = 'completed';
  private cursor = 0;
  private watcher: Promise<void> | null = null;
  private watchAbort = new AbortController();
  private output: Output | null = null;
  private ended: ((reason: string) => void) | null = null;
  private pending = new Set<string>();
  private resolved = new Set<string>();
  private callbacks: { status?: (status: Record<string, any>) => void; event?: (event: ServerEvent) => void; meta?: (text: string) => void } = {};
  private suppressUser = 0;
  private running = false;

  constructor(readonly client: ServerClient, public id: string) {}
  async history(): Promise<ChatCompletionMessageParam[]> {
    const response = await this.client.request<{ messages: ChatCompletionMessageParam[] }>(`/api/sessions/${encodeURIComponent(this.id)}/messages`);
    this.messages = response.messages;
    return this.messages;
  }
  async snapshot(): Promise<ServerSnapshot> {
    const snapshot = await this.client.request<ServerSnapshot>(`/api/snapshot?sessionId=${encodeURIComponent(this.id)}`);
    this.status = snapshot.status ?? {};
    this.callbacks.status?.(this.status);
    return snapshot;
  }
  async start(output: Output, callbacks: ServerSession['callbacks'] = {}): Promise<void> {
    this.output = output;
    this.callbacks = callbacks;
    if (this.watcher) return;
    const snapshot = await this.snapshot();
    this.cursor = snapshot.seq;
    this.restorePending(snapshot);
    this.watcher = this.watch();
  }
  private restorePending(snapshot: ServerSnapshot): void {
    for (const request of snapshot.approvals ?? []) this.dispatch({ seq: this.cursor, type: 'approval.request', data: request });
    for (const request of snapshot.asks ?? []) this.dispatch({ seq: this.cursor, type: 'ask.request', data: request });
  }
  private async watch(): Promise<void> {
    let failures = 0;
    while (!this.watchAbort.signal.aborted) {
      try {
        const batch = await this.client.request<{ seq: number; events: ServerEvent[]; reset?: boolean; truncated?: boolean }>(
          `/api/events/poll?since=${this.cursor}&timeout=20`, undefined, this.watchAbort.signal);
        if (batch.reset || batch.truncated || batch.seq < this.cursor) {
          const snapshot = await this.snapshot();
          this.cursor = snapshot.seq;
          this.restorePending(snapshot);
          this.callbacks.meta?.('连接已恢复，正在同步会话历史');
          await this.history();
          // 事件缓冲已被覆盖时不能凭缺失的 run.end 永久等待。
          if (this.ended && !(this.status.runningSessions ?? []).includes(this.id)) this.finish('interrupted');
        } else {
          for (const event of batch.events ?? []) {
            if (event.seq <= this.cursor) continue;
            this.dispatch(event);
            this.cursor = event.seq;
          }
          this.cursor = Math.max(this.cursor, batch.seq);
        }
        failures = 0;
      } catch (error) {
        if (this.watchAbort.signal.aborted) return;
        if (error instanceof ServerHttpError && [401, 403, 404].includes(error.status)) {
          this.output?.onRequestFailed(error);
          this.finish('error');
          return;
        }
        failures += 1;
        if (failures === 1) this.callbacks.meta?.('Server 连接中断，正在重连…');
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); this.watchAbort.signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, Math.min(failures * 250, 3000));
          this.watchAbort.signal.addEventListener('abort', done, { once: true });
        });
      }
    }
  }
  private finish(reason: string): void {
    this.lastReason = reason;
    this.running = false;
    const resolve = this.ended;
    this.ended = null;
    resolve?.(reason);
  }
  private dispatch(event: ServerEvent): void {
    const out = this.output;
    const data = event.data;
    if (event.type === 'status') {
      // 状态广播可能属于工作区默认模型；按会话快照读取，避免覆盖显式模型/权限。
      if (data.sessionId === this.id) { this.status = data; this.callbacks.status?.(data); }
      else void this.snapshot().catch(() => {});
      return;
    }
    if (!out || data.sessionId !== this.id) return;
    this.callbacks.event?.(event);
    switch (event.type) {
      case 'thinking.start': out.thinking.start?.(); break;
      case 'thinking.chunk': out.thinking.write(String(data.text ?? '')); break;
      case 'thinking.end': out.thinking.finish(); break;
      case 'answer.chunk': out.onStreamStart(); out.onAnswer(String(data.text ?? '')); break;
      case 'answer.end': out.onAnswerEnd(); break;
      case 'turn.step': out.onRound(data.step, data.maxSteps); break;
      case 'stream.progress': out.onStreamProgress?.(data as unknown as StreamProgress); break;
      case 'usage': out.onUsage(data as unknown as TokenUsage); break;
      case 'lap': out.onLlmLap?.(data.llmMs, data.firstTokenMs, data.genMs); break;
      case 'toolsLap': out.onToolsLap?.(data.toolsMs); break;
      case 'tool.start': out.onToolStep(data.step, data.maxSteps, data.name, data.argsPreview, data.args, data.seq); break;
      case 'tool.result': out.onToolResult(data.ok, data.chars, data.preview, data.detail as ToolResultDetail, data.seq, data.totalLines); break;
      case 'tool.output': out.onCommandOutput?.(data.chunk, data.isError, data.seq); break;
      case 'tool.full': out.onToolOutput?.(data.text, data.seq); break;
      case 'user.message':
        if (this.suppressUser > 0) this.suppressUser -= 1;
        else out.onUserMessage(data.text, data.mode);
        break;
      case 'hook.output': out.onHookOutput?.(data.event, data.lines); break;
      case 'subagent': out.onSubagentEvent?.(data.ev as SubagentEvent); break;
      case 'subagent.background': out.onBackgroundSubagentDone?.(data as any); break;
      case 'error': out.onRequestFailed(new Error(data.message)); break;
      case 'meta.add': this.callbacks.meta?.(data.text); break;
      case 'clear': out.clearScrollback(); break;
      case 'run.end': this.finish(String(data.reason ?? 'completed')); break;
      case 'approval.request': void this.resolveApproval(data); break;
      case 'ask.request': void this.resolveAsk(data); break;
      case 'approval.resolved': this.resolved.add(data.approvalId); break;
      case 'ask.resolved': this.resolved.add(data.askId); break;
    }
  }
  private async resolveApproval(data: Record<string, any>): Promise<void> {
    const id = data.approvalId;
    if (!id || this.pending.has(id) || this.resolved.has(id)) return;
    this.pending.add(id);
    try {
      const allow = await this.output?.requestApproval?.({ tool: data.tool, summary: data.summary, reason: data.reason });
      if (!this.resolved.has(id) && !this.watchAbort.signal.aborted) {
        await this.client.request(`/api/sessions/${encodeURIComponent(this.id)}/approval`, { approvalId: id, allow: allow === true });
      }
    } catch (error) {
      if (!(error instanceof ServerHttpError && error.status === 404)) this.callbacks.meta?.(`审批提交失败：${(error as Error).message}`);
    } finally { this.pending.delete(id); this.resolved.add(id); }
  }
  private async resolveAsk(data: Record<string, any>): Promise<void> {
    const id = data.askId;
    if (!id || this.pending.has(id) || this.resolved.has(id)) return;
    this.pending.add(id);
    try {
      const result = await this.output?.askUser?.(data.question, data.options ?? [], data.multiple === true);
      if (!this.resolved.has(id) && !this.watchAbort.signal.aborted) {
        await this.client.request(`/api/sessions/${encodeURIComponent(this.id)}/ask`, { askId: id, choices: result?.choices ?? (result?.choice ? [result.choice] : null) });
      }
    } catch (error) {
      if (!(error instanceof ServerHttpError && error.status === 404)) this.callbacks.meta?.(`提问提交失败：${(error as Error).message}`);
    } finally { this.pending.delete(id); this.resolved.add(id); }
  }
  async run(text: string, options: { runOpts?: RunOptions; attachments?: unknown[]; echoed?: boolean; config?: Record<string, unknown>; shell?: boolean } = {}): Promise<string> {
    if (!this.output || !this.watcher) throw new Error('ServerSession.start 必须先于 run');
    if (this.ended) throw new Error('当前客户端已有任务正在执行');
    this.running = true;
    this.output.onTurnStart?.();
    if (options.echoed) this.suppressUser += 1;
    const done = new Promise<string>(resolve => { this.ended = resolve; });
    let attached: AbortSignal | undefined;
    const onAbort = () => {
      const interrupt = options.runOpts?.takeInterrupt?.();
      const operation = interrupt ? this.steer(interrupt) : this.cancel();
      void operation.catch(error => this.output?.onRequestFailed(error));
      if (interrupt) {
        options.runOpts?.rearmAbort?.();
        attachAbort();
      }
    };
    const attachAbort = () => {
      attached?.removeEventListener('abort', onAbort);
      attached = options.runOpts?.abortSignal;
      attached?.addEventListener('abort', onAbort, { once: true });
      if (attached?.aborted) queueMicrotask(onAbort);
    };
    try {
      const body = { ...(options.shell ? { command: text } : { text }), requestId: randomUUID(), ...(options.attachments ? { attachments: options.attachments } : {}), ...(options.config ? { config: options.config } : {}) };
      const route = `/api/sessions/${encodeURIComponent(this.id)}/${options.shell ? 'shell' : 'messages'}`;
      try { await this.client.request(route, body); }
      catch (error) {
        // 响应丢失时使用同一个幂等 ID 重试，绝不生成第二轮。
        if (error instanceof ServerHttpError) throw error;
        await this.client.request(route, body);
      }
      attachAbort();
      const reason = await done;
      await this.history();
      return reason;
    } catch (error) {
      this.suppressUser = 0;
      this.finish('error');
      throw error;
    } finally { attached?.removeEventListener('abort', onAbort); }
  }
  async cancel(): Promise<void> { await this.client.request(`/api/sessions/${encodeURIComponent(this.id)}/cancel`, {}); }
  async steer(text: string): Promise<void> { await this.client.request(`/api/sessions/${encodeURIComponent(this.id)}/steer`, { text }); }
  async command(command: string): Promise<string[]> {
    const result = await this.client.request<{ lines: string[]; status?: Record<string, any> }>('/api/command', { command, sessionId: this.id, background: this.running });
    if (result.status) { this.status = result.status; this.callbacks.status?.(this.status); }
    else await this.snapshot();
    return result.lines ?? [];
  }
  async select(id: string): Promise<void> {
    if (this.running) throw new Error('请先取消当前运行，再切换会话');
    this.id = id;
    this.suppressUser = 0;
    this.pending.clear();
    await this.history();
    const snapshot = await this.snapshot();
    this.restorePending(snapshot);
  }
  async close(): Promise<void> {
    this.watchAbort.abort();
    await this.watcher;
    this.finish('disconnected');
  }
  async switchConnection(connection: ServerConnection, id: string): Promise<void> {
    if (this.running) throw new Error('请先取消当前运行，再切换工作区');
    const out = this.output;
    const callbacks = this.callbacks;
    await this.close();
    Object.assign(this.client.connection, connection);
    this.watchAbort = new AbortController();
    this.watcher = null;
    this.cursor = 0;
    this.id = id;
    await this.history();
    if (out) await this.start(out, callbacks);
  }
}

/** 把服务端状态同步给已有 composer；这里只管理展示状态，不构建工具/SDK 客户端。 */
export function syncRemoteRunOptions(remote: ServerSession, runOpts: RunOptions): void {
  const status = remote.status;
  runOpts.models = (status.models ?? []) as ModelEndpoint[];
  runOpts.permission = status.permission ?? 'safe';
  runOpts.reasoningEffort = status.reasoningEffort;
  runOpts.reasoningEffortOptions = status.reasoningEffortOptions;
  runOpts.planMode = status.planMode === true;
  runOpts.activeVariant = status.activeVariant;
  if (runOpts.cfg) {
    runOpts.cfg.model = status.model ?? runOpts.cfg.model;
    runOpts.cfg.contextLimit = status.contextOverride ? status.contextLimit : undefined;
  }
}

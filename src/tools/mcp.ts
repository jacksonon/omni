/**
 * MCP（Model Context Protocol）客户端：接入外部工具生态。
 *
 * 协议：JSON-RPC 2.0，支持两种传输：
 *   · **stdio** —— 每个 MCP 服务器是一个独立子进程（command + args + env），newline-delimited JSON；
 *   · **streamable HTTP**（P2）—— 远端 http(s) 端点（url 配置），POST JSON + SSE 响应，
 *     支持 OAuth（/mcp login）与自定义 headers。
 *
 * 生命周期：入口启动时发现（initialize 握手 → instructions / capabilities →
 * tools|resources|prompts 列表 → 包装成 Tool 注册进工具表，名称加 server 前缀防冲突）；
 * 进程退出时 kill 子进程。
 * 服务器启动/握手失败 → 只警告并跳过该服务器（fail-open，不阻塞主流程）。
 *
 * 安全：MCP 工具与其他工具一样过 Safety 闸门（权限分级 + 审批 + 审计）——
 * 外部工具的破坏力与 run_command 同级，不该绕过护栏。
 * 额外支持：
 *   · server 级 enabledTools / disabledTools 白黑名单过滤；
 *   · defaultToolsApprovalMode（auto/prompt/writes/approve）烘焙到每个工具上
 *     （per-tool 审批模式，safety/policy.ts 消费）。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { loadMcpToken, oauthLogin, type McpOAuthToken } from './mcp-oauth.js';
import type { Tool } from './types.js';
import type { ToolApprovalMode } from './types.js';

export type { ToolApprovalMode } from './types.js';

export interface McpServerConfig {
  /** stdio 传输：启动命令（与 url 二选一；command 优先） */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** streamable HTTP 传输：远端端点（与 command 二选一） */
  url?: string;
  /** streamable HTTP 自定义请求头（如 Authorization: Bearer xxx） */
  headers?: Record<string, string>;
  /** 工具白名单：只暴露这些工具（缺省 = 全部） */
  enabledTools?: string[];
  /** 工具黑名单：排除这些工具 */
  disabledTools?: string[];
  /** 该 server 全部工具的默认审批模式（auto/prompt/writes/approve；缺省 auto = 跟随全局档位） */
  defaultToolsApprovalMode?: ToolApprovalMode;
}

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptDef {
  name: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

/** initialize 响应（能力声明 + server instructions） */
interface InitResult {
  protocolVersion?: string;
  capabilities?: { tools?: unknown; resources?: unknown; prompts?: unknown; logging?: unknown };
  serverInfo?: { name?: string; version?: string };
  /** server instructions：客户端应注入系统提示（跨工具约束/限流指引） */
  instructions?: string;
}

/** 传输层抽象：stdio 与 streamable HTTP 统一为 request/notify */
interface McpTransport {
  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params: Record<string, unknown>): void;
  close(): void;
}

const PROTOCOL_VERSION = '2024-11-05';
const REQUEST_TIMEOUT = 30_000;
/** 启动握手（initialize）预算：发现阶段不能拖垮整个进程启动（Electron 壳 30s 就判超时） */
const CONNECT_TIMEOUT = 15_000;

// ── stdio 传输 ──────────────────────────────────────────────

class StdioTransport implements McpTransport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: Interface | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private closed = false;
  /** spawn 失败（Windows 上 spawn npx/cmd 类命令必现：异步 ENOENT）——置位后请求立即失败，不再等满超时 */
  private spawnError: Error | null = null;

  constructor(private cfg: McpServerConfig) {}

  async start(): Promise<void> {
    const child = spawn(this.cfg.command ?? '', this.cfg.args ?? [], {
      env: { ...process.env, ...this.cfg.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.on('error', (err) => {
      // 不能只吞掉：否则 initialize 等在途请求会干等 REQUEST_TIMEOUT（拖垮整个启动）
      this.spawnError = err;
      for (const [, p] of this.pending) p.reject(new Error(`MCP 进程启动失败：${err.message}`));
      this.pending.clear();
    });
    child.stderr.on('data', (d: Buffer) => {
      if (process.env.OMNI_DEBUG) console.error(`[MCP:${this.cfg.command}] ${d.toString().trimEnd()}`);
    });
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => this.onMessage(line));
    this.lines = rl;
  }

  private onMessage(line: string): void {
    let msg: { id?: number; error?: { message?: string }; result?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id == null) return; // 服务器主动通知：忽略
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message ?? 'MCP 请求错误'));
    else p.resolve(msg.result);
  }

  request(method: string, params: Record<string, unknown>, timeoutMs: number = REQUEST_TIMEOUT): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.closed || !this.child?.stdin.writable || this.spawnError) {
        reject(new Error(this.spawnError
          ? `MCP 进程启动失败：${this.spawnError.message}`
          : `MCP 传输已关闭：${method}`));
        return;
      }
      const id = ++this.seq;
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP 请求超时：${method}`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (this.closed || !this.child?.stdin.writable) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  close(): void {
    this.closed = true;
    this.lines?.close();
    this.child?.kill();
    this.child = null;
  }
}

// ── streamable HTTP 传输（2025-03-26 协议）──────────────────

/** 解析 SSE 响应体：逐帧取 `data:` 行的 JSON */
async function readSse(resp: Response): Promise<unknown[]> {
  const reader = resp.body?.getReader();
  if (!reader) return [];
  const out: unknown[] = [];
  let buffer = '';
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (line.startsWith('data:')) {
          const raw = line.slice(5).trim();
          if (!raw) continue;
          try {
            out.push(JSON.parse(raw));
          } catch {
            // 忽略非法帧
          }
        }
      }
    }
  }
  return out;
}

class HttpTransport implements McpTransport {
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private sessionId: string | null = null;
  private token: McpOAuthToken | null = null;
  private closed = false;

  constructor(private cfg: McpServerConfig) {}

  async start(): Promise<void> {
    // 预读已存 token（OAuth 登录过才有）
    if (this.cfg.url) this.token = await loadMcpToken(this.cfg.url);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(this.cfg.headers ?? {}),
    };
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    if (this.cfg.headers?.['Authorization']) {
      // 用户显式配置的 Authorization 优先
    } else if (this.token) {
      h['Authorization'] = `${this.token.tokenType} ${this.token.accessToken}`;
    }
    return h;
  }

  async request(method: string, params: Record<string, unknown>, timeoutMs: number = CONNECT_TIMEOUT): Promise<unknown> {
    if (this.closed) throw new Error(`MCP 传输已关闭：${method}`);
    const id = ++this.seq;
    const body = { jsonrpc: '2.0', id, method, params };
    const url = this.cfg.url;
    if (!url) throw new Error('HTTP 传输缺少 url 配置');
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new Error(`MCP HTTP 请求失败：${err instanceof Error ? err.message : String(err)}`);
    }
    // 会话 id：服务器在响应头回传
    const sid = resp.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (resp.status === 401 && !this.cfg.headers?.['Authorization']) {
      const msg = `服务器需要 OAuth 登录（运行 /mcp login ${this.serverNameHint()}）`;
      throw new Error(msg);
    }
    if (!resp.ok) throw new Error(`MCP HTTP ${resp.status}`);
    const contentType = resp.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      const msgs = await readSse(resp);
      const m = msgs.find((x): x is { id?: number; result?: unknown; error?: { message?: string } } =>
        typeof x === 'object' && x !== null && (x as { id?: number }).id === id
      );
      if (!m) throw new Error(`MCP 响应超时：${method}`);
      if (m.error) throw new Error(m.error.message ?? 'MCP 请求错误');
      return m.result;
    }
    const data = (await resp.json()) as { result?: unknown; error?: { message?: string } };
    if (data.error) throw new Error(data.error.message ?? 'MCP 请求错误');
    return data.result;
  }

  private serverNameHint(): string {
    return this.cfg.url ?? this.cfg.command ?? '?';
  }

  notify(method: string, params: Record<string, unknown>): void {
    const url = this.cfg.url;
    if (!url || this.closed) return;
    void fetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
    }).catch(() => {});
  }

  /**
   * 服务器通知流（第八节 P2，2025-03-26 协议 GET SSE）：对同一 url 发起 **GET**
   * 长连接（Accept: text/event-stream + Mcp-Session-Id），接收服务器主动推送的
   * JSON-RPC 通知（notifications/resources/*、notifications/tools/* 等）。
   * 每条通知经 onNotify 回调分发；断线自动重连（指数退避封顶 30s）；close() 终止。
   * 服务器不支持 GET 流（405 Method Not Allowed = 明确拒绝）→ 安静放弃（协议允许）。
   */
  subscribeNotifications(onNotify: (method: string, params: Record<string, unknown>) => void): void {
    const url = this.cfg.url;
    if (!url || this.closed) return;
    this.notifyCallback = onNotify;
    if (this.notifying) return; // 已在订阅
    this.notifying = true;
    void this.notificationLoop();
  }

  private notifyCallback: ((method: string, params: Record<string, unknown>) => void) | null = null;
  private notifying = false;
  /** 通知流重连代数（close 后自增使旧循环退出） */
  private notifyGen = 0;

  private async notificationLoop(): Promise<void> {
    const gen = ++this.notifyGen;
    let backoff = 1000;
    while (!this.closed && gen === this.notifyGen) {
      try {
        const resp = await fetch(this.cfg.url!, {
          method: 'GET',
          headers: { ...this.headers(), Accept: 'text/event-stream' },
        });
        // 405 = 服务器不支持 GET 流（协议明确允许）→ 不再重试
        if (resp.status === 405) {
          this.notifying = false;
          return;
        }
        if (!resp.ok) throw new Error(`GET ${resp.status}`);
        backoff = 1000; // 连上即复位退避
        const reader = resp.body?.getReader();
        if (!reader) return;
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done || this.closed || gen !== this.notifyGen) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            let method: string | null = null;
            let params: unknown = {};
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data:')) continue;
              try {
                const msg = JSON.parse(line.slice(5).trim()) as { method?: string; params?: unknown };
                if (msg.method) {
                  method = msg.method;
                  params = msg.params ?? {};
                }
              } catch {
                // 忽略非法帧
              }
            }
            if (method && this.notifyCallback && !this.closed) {
              try {
                this.notifyCallback(method, params as Record<string, unknown>);
              } catch {
                // 回调异常不拖垮通知循环
              }
            }
          }
        }
      } catch {
        // 断线：退避后重连
      }
      if (this.closed || gen !== this.notifyGen) break;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
    this.notifying = false;
  }

  /** OAuth 登录（/mcp login <name> 调用）：成功后更新 token */
  async login(): Promise<boolean> {
    if (!this.cfg.url) return false;
    const tok = await oauthLogin(this.cfg.url);
    if (tok) {
      this.token = tok;
      return true;
    }
    return false;
  }

  close(): void {
    this.closed = true;
    this.notifyGen++; // 使通知循环退出
  }
}

// ── MCP 客户端（传输封装 + 高层能力方法）────────────────────

export class McpClient {
  private transport: McpTransport | null = null;
  private initResult: InitResult | null = null;

  constructor(
    private cfg: McpServerConfig,
    private serverName: string
  ) {}

  get isHttp(): boolean {
    return !this.cfg.command && !!this.cfg.url;
  }

  /** 启动连接 + initialize 握手（CONNECT_TIMEOUT 预算——发现阶段不能拖垮进程启动） */
  async start(): Promise<void> {
    const transport = this.cfg.command
      ? new StdioTransport(this.cfg)
      : new HttpTransport(this.cfg);
    this.transport = transport;
    await transport.start();
    const res = (await transport.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { resources: {}, prompts: {} },
      clientInfo: { name: 'omni', version: '0.1.0' },
    }, CONNECT_TIMEOUT)) as InitResult | undefined;
    this.initResult = res ?? null;
    transport.notify('notifications/initialized', {});
    // HTTP 服务器通知流（第八节 P2）：GET SSE 长连接接收服务器主动推送
    // （resources 变更 / tools 列表变化等）；当前仅 debug 日志呈现——消费动作
    // （如自动刷新工具列表）待后续按需接入。405 安静放弃（协议允许）。
    if (transport instanceof HttpTransport) {
      transport.subscribeNotifications((method, params) => {
        if (process.env.OMNI_DEBUG) {
          console.error(`[MCP:${this.serverName}] 通知 ${method} ${JSON.stringify(params).slice(0, 200)}`);
        }
      });
    }
  }

  /** OAuth 登录（仅 HTTP 传输） */
  async login(): Promise<boolean> {
    if (this.transport instanceof HttpTransport) {
      return this.transport.login();
    }
    return false;
  }

  /** server instructions（initialize 响应；注入系统提示用） */
  get instructions(): string | null {
    if (this.initResult?.instructions && typeof this.initResult.instructions === 'string') {
      return this.initResult.instructions.slice(0, 2048);
    }
    return null;
  }

  /** 服务器是否声明了某能力 */
  hasCapability(cap: 'tools' | 'resources' | 'prompts'): boolean {
    return !!(this.initResult?.capabilities && cap in this.initResult.capabilities);
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.transport) return Promise.reject(new Error('MCP 客户端未启动'));
    return this.transport.request(method, params);
  }

  /** 工具列表（应用 enabledTools/disabledTools 白黑名单） */
  async listTools(): Promise<McpToolDef[]> {
    const res = (await this.request('tools/list', {})) as { tools?: McpToolDef[] } | undefined;
    const all = res?.tools ?? [];
    const enabled = this.cfg.enabledTools;
    const disabled = this.cfg.disabledTools;
    return all.filter((t) => {
      if (enabled && enabled.length > 0 && !enabled.includes(t.name)) return false;
      if (disabled && disabled.includes(t.name)) return false;
      return true;
    });
  }

  /** 资源列表 */
  async listResources(): Promise<McpResource[]> {
    try {
      const res = (await this.request('resources/list', {})) as { resources?: McpResource[] } | undefined;
      return res?.resources ?? [];
    } catch (err) {
      // 服务器不支持/失败 → 空（不阻塞发现流程）
      if (process.env.OMNI_DEBUG) console.error(`[MCP:${this.serverName}] resources/list: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  /** 读取资源内容 */
  async readResource(uri: string): Promise<{ uri: string; mimeType?: string; text?: string } | null> {
    const res = (await this.request('resources/read', { uri })) as
      | { contents?: { uri?: string; mimeType?: string; text?: string; blob?: string }[] }
      | undefined;
    const first = res?.contents?.[0];
    if (!first) return null;
    let text = first.text ?? '';
    if (!text && first.blob) {
      // base64 blob → 文本（尽力解码）
      try {
        text = Buffer.from(first.blob, 'base64').toString('utf8');
      } catch {
        text = `(二进制资源 ${first.uri}，base64 ${first.blob.length} 字符)`;
      }
    }
    return { uri: first.uri ?? uri, mimeType: first.mimeType, text };
  }

  /** 提示词模板列表 */
  async listPrompts(): Promise<McpPromptDef[]> {
    try {
      const res = (await this.request('prompts/list', {})) as { prompts?: McpPromptDef[] } | undefined;
      return res?.prompts ?? [];
    } catch (err) {
      if (process.env.OMNI_DEBUG) console.error(`[MCP:${this.serverName}] prompts/list: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  /** 获取提示词模板内容（messages 数组） */
  async getPrompt(name: string, args?: Record<string, unknown>): Promise<{ description?: string; messages: { role: string; text: string }[] } | null> {
    const res = (await this.request('prompts/get', { name, arguments: args })) as
      | {
          description?: string;
          messages?: { role?: string; content?: { type?: string; text?: string } | string }[];
        }
      | undefined;
    const msgs = (res?.messages ?? []).map((m) => {
      const content = typeof m.content === 'string' ? m.content : m.content?.text ?? '';
      return { role: m.role ?? 'user', text: content };
    });
    return { description: res?.description, messages: msgs };
  }

  /** 调用工具（execute 闭包用） */
  async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const res = (await this.request('tools/call', { name, arguments: args })) as
      | { content?: { type?: string; text?: string }[]; isError?: boolean }
      | undefined;
    const parts: string[] = [];
    for (const c of res?.content ?? []) {
      if (c?.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    }
    return { text: parts.join('\n') || '(MCP 工具无文本输出)', isError: !!res?.isError };
  }

  /** 该 server 的默认审批模式 */
  get approvalMode(): ToolApprovalMode {
    return this.cfg.defaultToolsApprovalMode ?? 'auto';
  }

  close(): void {
    this.transport?.close();
    this.transport = null;
  }
}

// ── 服务器句柄（发现结果：工具 + 资源 + 提示词 + instructions）──

export interface McpServerHandle {
  name: string;
  client: McpClient;
  /** 已过滤 + 审批模式烘焙的 Tool（名称带 server 前缀） */
  tools: Tool[];
  resources: McpResource[];
  prompts: McpPromptDef[];
  instructions: string | null;
}

// 存活 MCP 客户端：模块级跟踪（进程退出统一 kill；/mcp 重连时 close 旧进程）
const activeClients: McpClient[] = [];
let exitHandlerRegistered = false;

/** 关闭全部 MCP 客户端（/mcp 重连前调用；进程退出由模块级 handler 统一处理） */
export function closeMcpClients(): void {
  for (const c of activeClients.splice(0)) c.close();
}

/** 工具名 server 前缀（demo_ping 风格：server 名净化 + 下划线 + 工具名） */
export function mcpToolName(serverName: string, toolName: string): string {
  const prefix = serverName.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  return `${prefix}_${toolName}`;
}

/**
 * 从配置发现 MCP 服务器（完整句柄：工具 + 资源 + 提示词 + instructions）：
 * 逐 server 握手 → instructions/capabilities → tools|resources|prompts 列表 →
 * 包装成 Tool（名称加 server 前缀，审批模式烘焙）。失败只警告并跳过（fail-open）。
 */
export async function discoverMcpServers(
  servers?: Record<string, McpServerConfig>
): Promise<McpServerHandle[]> {
  const entries = Object.entries(servers ?? {});
  if (entries.length === 0) return [];
  // 并行发现：单个 server 失败/慢只影响自己（≤CONNECT_TIMEOUT），不再串行累加
  // 拖垮整个进程启动（Windows 上 npx 类命令必失败，串行两个 preset = 60s > 壳层超时）
  const settled = await Promise.all(entries.map(async ([name, cfg]): Promise<McpServerHandle | null> => {
    try {
      const client = new McpClient(cfg, name);
      await client.start();
      const defs = await client.listTools();
      const tools: Tool[] = defs.map((def) => {
        const toolName = mcpToolName(name, def.name);
        // 1.0 P1-5 tool annotations 消费：readOnlyHint → 标记只读 + 审批 auto
        //（safe 档位天然放行只读；writes 档位也不再误询问纯读工具）
        const readOnly = (def as McpToolDef & { annotations?: { readOnlyHint?: boolean } }).annotations?.readOnlyHint === true;
        return {
          name: toolName,
          description: `[MCP:${name}] ${def.description ?? ''}（外部工具，经 MCP 服务器 ${name} 执行；同样受权限/审批管控）${readOnly ? '（server 声明只读）' : ''}`,
          parameters: (def.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
          approvalMode: readOnly ? 'auto' : client.approvalMode,
          readOnly,
          execute: async (args) => {
            const r = await client.callTool(def.name, args);
            return (r.isError ? '错误：' : '') + r.text;
          },
        };
      });
      // 资源/提示词：尽力获取（失败返回空，不阻塞）
      const resources = await client.listResources();
      const prompts = await client.listPrompts();
      return {
        name,
        client,
        tools,
        resources,
        prompts,
        instructions: client.instructions,
      };
    } catch (err) {
      console.error(
        `⚠️ MCP 服务器「${name}」启动失败：${err instanceof Error ? err.message : err}（已跳过该服务器）`
      );
      return null;
    }
  }));
  const out = settled.filter((h): h is McpServerHandle => h !== null);
  const clients = out.map((h) => h.client);
  activeClients.push(...clients);
  if (clients.length > 0 && !exitHandlerRegistered) {
    exitHandlerRegistered = true;
    // 进程退出时 kill MCP 子进程（CLI 生命周期内常驻；模块级只注册一次，重连不叠加）
    process.on('exit', closeMcpClients);
  }
  return out;
}

/** 兼容旧 API：只返回工具列表（handles 的 tools 扁平合并） */
export async function discoverMcpTools(
  servers?: Record<string, McpServerConfig>
): Promise<Tool[]> {
  const handles = await discoverMcpServers(servers);
  return buildMcpTools(handles);
}

/**
 * 组装 MCP 工具链：server 工具 + Resources/Prompts 辅助工具（仅当 server 实际声明时注册）。
 * attachRuntime 与 /mcp reconnect/add 共用——保证工具链一致。
 */
export function buildMcpTools(handles: McpServerHandle[]): Tool[] {
  return handles.flatMap((h) => {
    const tools = [...h.tools];
    if (h.resources.length > 0) {
      const list = h.resources.slice(0, 20).map((r) => `${r.uri}（${r.name}）`).join('、');
      tools.push({
        name: mcpToolName(h.name, 'read_resource'),
        description:
          `[MCP:${h.name}] 读取该 MCP 服务器的外部资源（data/file 等）内容进上下文。` +
          `可用资源：${list}${h.resources.length > 20 ? ` 等 ${h.resources.length} 个` : ''}`,
        parameters: {
          type: 'object',
          properties: {
            uri: { type: 'string', description: `资源 URI（上述可用资源之一）` },
          },
          required: ['uri'],
        },
        approvalMode: h.client.approvalMode,
        readOnly: true,
        execute: async (args) => {
          try {
            const r = await h.client.readResource(String(args.uri ?? ''));
            if (!r) return `资源「${args.uri}」不存在或不可读`;
            return `### ${r.uri}${r.mimeType ? `（${r.mimeType}）` : ''}\n${r.text ?? ''}`;
          } catch (err) {
            return `资源「${args.uri}」读取失败：${err instanceof Error ? err.message : err}`;
          }
        },
      });
    }
    if (h.prompts.length > 0) {
      const names = h.prompts.map((p) => p.name).join('、');
      tools.push({
        name: mcpToolName(h.name, 'get_prompt'),
        description: `[MCP:${h.name}] 获取该 MCP 服务器的可复用提示词模板（返回 messages 消息序列，可按需应用）。可用模板：${names}`,
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '提示词模板名（上述可用模板之一）' },
            args: { type: 'object', description: '模板参数（模板有 arguments 时填写）' },
          },
          required: ['name'],
        },
        approvalMode: h.client.approvalMode,
        readOnly: true,
        execute: async (args) => {
          try {
            const p = await h.client.getPrompt(String(args.name ?? ''), (args.args as Record<string, unknown> | undefined) ?? {});
            if (!p) return `提示词模板「${args.name}」不存在`;
            const body = p.messages.map((m) => `${m.role}: ${m.text}`).join('\n');
            return `### 提示词模板 ${args.name}${p.description ? `（${p.description}）` : ''}\n${body}`;
          } catch (err) {
            return `提示词模板「${args.name}」获取失败：${err instanceof Error ? err.message : err}`;
          }
        },
      });
    }
    return tools;
  });
}

/** MCP server instructions → system 消息内容（多条按 server 名顺序叠放；无 instructions 返回 null） */
export function mcpInstructionsMessage(handles: McpServerHandle[]): string | null {
  const instructions = handles.filter((h) => h.instructions);
  if (instructions.length === 0) return null;
  return instructions
    .map((h) => `[MCP server instructions：${h.name}]\n${h.instructions}`)
    .join('\n\n');
}

// ── MCP Registry 一键安装（1.0 P1-5）────────────────────────────

export interface McpInstallResult {
  ok: boolean;
  message: string;
  /** 解析出的服务器配置（ok 时携带；调用方负责持久化 + 重连） */
  config?: McpServerConfig;
}

interface RegistryServer {
  name?: string;
  description?: string;
  remotes?: { url?: string; headers?: Record<string, string> }[];
  packages?: { registry_type?: string; identifier?: string; environment_variables?: Record<string, string> }[];
}

/**
 * 从官方 MCP Registry 检索并解析安装配置（best-effort，离线/结构变化时明确报错）：
 * · 远端 server（remotes[0].url）→ HTTP 传输配置；
 * · npm 包（packages[].registry_type=npm）→ `npx -y <pkg>` stdio 配置。
 */
export async function installFromRegistry(id: string): Promise<McpInstallResult> {
  const base = process.env.OMNI_MCP_REGISTRY || 'https://registry.modelcontextprotocol.io';
  const url = `${base}/v0/servers?search=${encodeURIComponent(id)}&version=latest`;
  let data: { servers?: { server?: RegistryServer }[] };
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { ok: false, message: `MCP Registry 查询失败：HTTP ${res.status}` };
    data = (await res.json()) as typeof data;
  } catch (err) {
    return { ok: false, message: `MCP Registry 不可达（${err instanceof Error ? err.message : err}）——可手动编辑 mcpServers 配置。` };
  }
  const servers = data.servers ?? [];
  if (servers.length === 0) return { ok: false, message: `Registry 中没有匹配「${id}」的服务器。` };
  const first = servers.find((s) => s.server?.name === id)?.server ?? servers[0]!.server;
  if (!first?.name) return { ok: false, message: `Registry 返回数据无法解析「${id}」。` };
  const remote = first.remotes?.find((r) => r.url);
  if (remote?.url) {
    return {
      ok: true,
      message: `已从 Registry 解析远端服务器 ${first.name}${first.description ? `（${first.description.slice(0, 80)}）` : ''}`,
      config: { url: remote.url, ...(remote.headers ? { headers: remote.headers as Record<string, string> } : {}) },
    };
  }
  const pkg = first.packages?.find((p) => p.registry_type === 'npm' && p.identifier);
  if (pkg?.identifier) {
    return {
      ok: true,
      message: `已从 Registry 解析 npm 包 ${pkg.identifier}${first.description ? `（${first.description.slice(0, 80)}）` : ''}`,
      config: { command: 'npx', args: ['-y', pkg.identifier] },
    };
  }
  return { ok: false, message: `「${id}」没有可自动安装的传输（无 remotes/npm 包）——请按其文档手动配置。` };
}

/** 复用现有终端编辑器和 Output，把执行权交给统一 server。 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ConfigOverrides } from '../config/index.js';
import type { Output } from '../output/types.js';
import type { RunOptions } from '../agent/types.js';
import { ConsoleOutput } from '../output/console.js';
import { MiniOutput } from '../output/mini.js';
import { runMiniInteractive, splitMiniOneShotFlags } from '../cli/mini.js';
import { runInteractive } from '../cli/interactive.js';
import { collectImageAttachments, loadImageAttachment, MAX_IMAGE_FILES, type ImageAttachment } from '../agent/context.js';
import { ServerClient, connectTerminalServer, syncRemoteRunOptions, type ServerSession } from './client.js';

/** 恢复跨项目会话时先选择其 worker，绝不在当前项目执行旧会话的工具。 */
async function routeSessionWorkspace(client: ServerClient, id: string): Promise<string> {
  const all = await client.request<{ id: string; project?: string }[]>('/api/sessions');
  const matches = all.filter(item => item.id === id || item.id.startsWith(id));
  const exact = matches.find(item => item.id === id);
  if (!exact && matches.length > 1) throw new Error(`会话前缀不唯一：${matches.map(item => item.id).join('、')}`);
  const target = exact ?? matches[0];
  if (!target) return id;
  const status = await client.request<{ cwd: string }>('/api/status');
  if (target.project && target.project !== status.cwd) {
    const result = await client.request<{ url?: string; cwd: string }>('/api/workspace', { dir: target.project });
    if (result.url) {
      const next = new URL(result.url, client.connection.url);
      if (next.origin !== new URL(client.connection.url).origin) throw new Error('Server 返回跨来源工作区地址，已拒绝传递凭据');
      client.connection.url = next.href.replace(/\/$/, '');
    }
    if (['localhost', '127.0.0.1', '[::1]'].includes(new URL(client.connection.url).hostname)) {
      try { process.chdir(result.cwd); } catch { /* 显式连接容器内 server 时本机不一定存在对应目录 */ }
    }
  }
  return target.id;
}

export interface ServerTerminalOptions {
  mode: 'mini' | 'console';
  taskArgs: string[];
  overrides: ConfigOverrides;
  resumeId?: string | null;
  continueSession?: boolean;
  serverUrl?: string;
  sessionConfig?: Record<string, unknown>;
  fork?: { kind: 'id'; id: string } | { kind: 'last' | 'pick'; all: boolean };
}

/** 历史只由 server 读取；终端回放可见文本，不写 JSONL。 */
export function replayRemoteHistory(messages: ChatCompletionMessageParam[], out: Output): void {
  let rendered = false;
  for (const message of messages) {
    if (message.role === 'user') {
      const content = typeof message.content === 'string' ? message.content
        : message.content.filter(part => part.type === 'text').map(part => part.type === 'text' ? part.text : '').join('\n');
      if (content) { out.onUserMessage(content); rendered = true; }
    } else if (message.role === 'assistant') {
      const extended = message as { reasoning?: string; reasoningMs?: number };
      if (extended.reasoning) out.onThinkingRestored?.(extended.reasoning, extended.reasoningMs);
      if (typeof message.content === 'string' && message.content) {
        out.onAnswer(message.content); out.onAnswerEnd(); rendered = true;
      }
    }
  }
  if (rendered) out.onTurnEnd();
}

export async function prepareServerTerminal(options: Omit<ServerTerminalOptions, 'mode' | 'taskArgs'>): Promise<{
  ctx: import('../main.js').RunContext; remote: ServerSession;
}> {
  const { prepareRun, resolveWorkspaceTrust } = await import('../main.js');
  const ctx = prepareRun(options.overrides, { allowMissingKey: true });
  // 先完成用户级信任登记，再唤起 worker，使首个运行时也采用正确的信任边界。
  if (!options.serverUrl) await resolveWorkspaceTrust(process.cwd(), new ConsoleOutput({ stream: true, showThinking: false }));
  const connection = await connectTerminalServer(process.cwd(), options.overrides, options.serverUrl);
  const client = new ServerClient(connection);
  let resume = options.resumeId ?? undefined;
  if (options.fork?.kind === 'id') resume = options.fork.id;
  if (!resume && (options.continueSession || options.fork)) {
    const status = await client.request<{ cwd: string }>('/api/status');
    const list = await client.request<{ id: string; title?: string; project?: string; archived?: boolean }[]>('/api/sessions');
    const filtered = list.filter(item => !item.archived && item.project && (options.fork && options.fork.kind !== 'id' && options.fork.all || item.project === status.cwd));
    if (options.fork?.kind === 'pick') {
      const out = new ConsoleOutput({ stream: true, showThinking: false });
      const labels = filtered.map(item => `${item.title || '新会话'} · ${item.id}`);
      const choice = await out.askUser('选择要分叉的会话', labels, false);
      resume = filtered[labels.indexOf(choice?.choice ?? '')]?.id;
    } else resume = filtered[0]?.id;
    if (!resume) throw new Error('当前工作区暂无可继续的会话');
  }
  if (resume) resume = await routeSessionWorkspace(client, resume);
  // 配置发现用于显示/编辑器选项；不附加本地工具链、MCP、hooks 或会话落盘。
  const config: Record<string, unknown> = { autoTitle: false, ...options.sessionConfig };
  if (options.overrides.model) config.model = ctx.cfg.model;
  if (options.overrides.askForApproval) config.permission = ctx.cfg.permission;
  if (options.overrides.approveForMe) config.autoReview = true;
  const remote = await client.createSession(config, resume);
  ctx.runOpts.tools = [];
  ctx.runOpts.cfg = ctx.cfg;
  ctx.runOpts.remote = remote;
  ctx.runOpts.context = { autoMemory: false };
  ctx.runOpts.initialImages = options.overrides.images;
  ctx.messages.push(...await remote.history());
  if (options.fork) {
    const fork = await client.request<{ id: string }>(`/api/sessions/${encodeURIComponent(remote.id)}/fork`, { n: ctx.messages.filter(message => message.role !== 'system').length });
    await client.createSession(config, fork.id);
    await remote.select(fork.id);
    ctx.messages.splice(0, ctx.messages.length, ...remote.messages);
  }
  const snapshot = await remote.snapshot();
  remote.status = snapshot.status;
  syncRemoteRunOptions(remote, ctx.runOpts);
  return { ctx, remote };
}

export async function remoteAttachments(text: string, initial: string[] = []): Promise<unknown[]> {
  const images: ImageAttachment[] = await collectImageAttachments(text, process.cwd()).catch(() => []);
  for (const file of initial) {
    if (images.length >= MAX_IMAGE_FILES) break;
    if (images.some(image => path.resolve(image.path) === path.resolve(file))) continue;
    const image = await loadImageAttachment(path.resolve(file), file).catch(() => null);
    if (image) images.push(image);
  }
  return images.map(image => ({ kind: 'image', name: image.path, dataUrl: image.dataUrl }));
}

/** 各终端保留自己的输入菜单；选择确认才发送命令。 */
export async function runRemoteCommand(remote: ServerSession, command: string, out: Output,
  pick?: (title: string, values: string[], current?: string) => Promise<string | null>
): Promise<string[]> {
  const [head, ...args] = command.trim().split(/\s+/);
  if (head === '/new') {
    const next = await remote.client.createSession({ autoTitle: false, model: remote.status.model, permission: remote.status.permission, reasoningEffort: remote.status.reasoningEffort });
    await remote.select(next.id);
    out.clearScrollback();
    return [];
  }
  if (head === '/clear') {
    const lines = await remote.command(command);
    await remote.history();
    out.clearScrollback();
    return lines;
  }
  if (head === '/resume' || head === '/session') {
    let id = args.join(' ');
    if (!id) {
      const all = await remote.client.request<{ id: string; title: string; project?: string; archived?: boolean }[]>('/api/sessions');
      const cwd = remote.status.cwd;
      const sessions = all.filter(item => !item.archived && (!item.project || item.project === cwd));
      const labels = sessions.map(item => `${item.title || '新会话'} · ${item.id}`);
      const answer = await out.askUser?.('恢复会话', labels, false);
      const index = labels.indexOf(answer?.choice ?? '');
      if (index < 0) return [];
      id = sessions[index]!.id;
    }
    const target = await remote.client.createSession({ autoTitle: false }, id);
    await remote.select(target.id);
    out.clearScrollback();
    replayRemoteHistory(remote.messages, out);
    return [`已恢复会话 ${remote.id}`];
  }
  if (!args.length && ['/model', '/variants', '/permission', '/context'].includes(head)) {
    let values: string[];
    if (head === '/model') values = (remote.status.models ?? []).map((model: { name: string }) => model.name);
    else if (head === '/variants') {
      const model = (remote.status.models ?? []).find((model: { name: string }) => model.name === remote.status.model);
      values = [...(remote.status.reasoningEffortOptions ?? []), ...Object.keys(model?.variants ?? {})];
    } else if (head === '/permission') values = ['read', 'ask', 'safe', 'full'];
    else values = ['默认', '256', '400', '512', '750', '1000'];
    if (!values.length) return remote.command(command);
    const title = head === '/model' ? 'Select Model' : head === '/variants' ? 'Select Reasoning Effort' : head === '/permission' ? 'Select Permission' : 'Context Window';
    const selected = pick ? await pick(title, values, remote.status.model)
      : (await out.askUser?.(title, values, false))?.choice;
    if (!selected) return [];
    return remote.command(`${head} ${selected}`);
  }
  if (head === '/cd') {
    if (!args.length) return [String(remote.status.cwd ?? '')];
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(remote.client.connection.url).hostname);
    const raw = args.join(' ');
    const dir = local ? path.resolve(String(remote.status.cwd ?? process.cwd()), raw) : raw;
    const response = await remote.client.request<{ cwd: string; url?: string }>('/api/workspace', { dir });
    const nextConnection = { ...remote.client.connection };
    if (response.url) {
      const nextUrl = new URL(response.url, nextConnection.url);
      if (nextUrl.origin !== new URL(nextConnection.url).origin) throw new Error('Server 返回跨来源工作区地址，已拒绝传递凭据');
      nextConnection.url = nextUrl.href.replace(/\/$/, '');
    }
    const nextClient = new ServerClient(nextConnection);
    // 调用方使用单一 remote 句柄，切换链接后仍保留原输入框和队列。
    const next = await nextClient.createSession({ autoTitle: false });
    await remote.switchConnection(nextConnection, next.id);
    if (local) process.chdir(response.cwd);
    out.clearScrollback();
    return [`工作区：${response.cwd}`];
  }
  if (head === '/stop') { await remote.cancel(); return []; }
  return remote.command(command);
}

export async function runServerTerminal(options: ServerTerminalOptions): Promise<void> {
  let taskArgs = [...options.taskArgs];
  let outputPath: string | null = null;
  const overrides = { ...options.overrides };
  if (options.mode === 'mini') {
    const flags = splitMiniOneShotFlags(taskArgs);
    taskArgs = flags.taskArgs;
    outputPath = flags.outputLastMessage;
    overrides.images = [...(overrides.images ?? []), ...flags.images];
  }
  let task = taskArgs.join(' ').trim();
  if (task === '-') {
    if (process.stdin.isTTY) throw new Error('任务为 - 但 stdin 无输入');
    const buffers: Buffer[] = [];
    for await (const chunk of process.stdin) buffers.push(Buffer.from(chunk));
    task = Buffer.concat(buffers).toString('utf8');
  }
  const { ctx, remote } = await prepareServerTerminal({ ...options, overrides });
  const out: Output = options.mode === 'mini'
    ? new MiniOutput({ stream: true, showThinking: ctx.cfg.showThinking })
    : new ConsoleOutput({ stream: true, showThinking: ctx.cfg.showThinking });
  const print = (text: string) => out instanceof MiniOutput ? out.print(text) : console.log(text);
  out.banner(ctx.cfg, (remote.status.tools ?? []) as string[]);
  replayRemoteHistory(ctx.messages, out);
  await remote.start(out, {
    status: () => syncRemoteRunOptions(remote, ctx.runOpts), meta: print,
  });
  try {
    if (task) {
      out.onUserMessage(task);
      const attachments = await remoteAttachments(task, overrides.images);
      const reason = await remote.run(task, { echoed: true, attachments, runOpts: ctx.runOpts });
      out.onTurnEnd(reason);
      if (reason !== 'completed') process.exitCode = 1;
      if (outputPath) {
        const answer = [...remote.messages].reverse().find(message => message.role === 'assistant' && typeof message.content === 'string');
        writeFileSync(outputPath, typeof answer?.content === 'string' ? answer.content : '');
      }
    } else if (options.mode === 'mini') {
      await runMiniInteractive(ctx.client, ctx.cfg.model, ctx.messages, ctx.runOpts, out);
    } else {
      await runInteractive(ctx.client, ctx.cfg.model, ctx.messages, ctx.runOpts, out);
    }
  } finally { await remote.close(); }
}

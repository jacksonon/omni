/** ACP 的 stdio 层只转发协议；任务、历史和工具由共享 server 持有。 */
import { createInterface } from 'node:readline';
import path from 'node:path';
import type { ConfigOverrides } from '../config/index.js';
import type { Output } from '../output/types.js';
import { connectTerminalServer, ServerClient, type ServerSession } from './client.js';

export async function runSharedAcp(overrides: ConfigOverrides, serverUrl?: string): Promise<void> {
  const sessions = new Map<string, ServerSession>();
  const write = (message: unknown) => process.stdout.write(JSON.stringify(message) + '\n');
  const reply = (id: unknown, result: unknown) => write({ jsonrpc: '2.0', id, result });
  const fail = (id: unknown, message: string, code = -32000) => write({ jsonrpc: '2.0', id, error: { code, message } });
  let tail = Promise.resolve();
  let closed = false;
  async function handle(method: string, params: Record<string, any>, id?: number | string): Promise<void> {
    if (method === 'session/cancel') {
      const remote = sessions.get(String(params.sessionId ?? ''));
      if (remote) await remote.cancel();
      if (id !== undefined) reply(id, {});
      return;
    }
    if (id === undefined) return;
    if (method === 'initialize') {
      reply(id, { protocolVersion: 1, agentCapabilities: { loadSession: false, promptCapabilities: { embeddedContext: false } }, agentInfo: { name: 'omni', title: 'Omni coding agent' } }); return;
    }
    if (method === 'auth/authenticate') { reply(id, { method: 'env' }); return; }
    if (method === 'session/new') {
      const cwd = typeof params.cwd === 'string' ? path.resolve(params.cwd) : process.cwd();
      const client = new ServerClient(await connectTerminalServer(cwd, overrides, serverUrl));
      const config: Record<string, unknown> = {};
      if (overrides.model) config.model = overrides.model;
      const remote = await client.createSession(config);
      let streamError: Error | null = null;
      const noop = () => {};
      const output: Output = {
        banner: noop, thinking: { shown: false, write: noop, finish: noop },
        onRound: noop, onStreamStart: noop, onAnswer: noop, onAnswerEnd: noop, onUsage: noop,
        onRequestFailed: (error) => { streamError = error instanceof Error ? error : new Error(String(error)); },
        onThinkingSaved: noop, onToolStep: noop, onToolResult: noop, onMaxSteps: noop,
        onUserMessage: noop, onTurnEnd: noop, onWaitForInput: noop, clearScrollback: noop, showHelp: noop,
        requestApproval: async () => false, askUser: async () => null,
      };
      await remote.start(output);
      // 每轮取最近错误，保持 ACP 错误响应与任务状态一致。
      Object.assign(remote, { acpError: () => streamError, clearAcpError: () => { streamError = null; } });
      sessions.set(remote.id, remote);
      reply(id, { sessionId: remote.id }); return;
    }
    const remote = sessions.get(String(params.sessionId ?? ''));
    if (!remote) { fail(id, '未知会话（先 session/new）', -32602); return; }
    if (method === 'session/prompt') {
      const prompt = Array.isArray(params.prompt) ? params.prompt.map((part: any) => typeof part?.text === 'string' ? part.text : '').join('') : String(params.prompt ?? '');
      if (!prompt.trim()) { fail(id, 'prompt 为空', -32602); return; }
      const errors = remote as ServerSession & { acpError(): Error | null; clearAcpError(): void };
      errors.clearAcpError();
      const reason = await remote.run(prompt);
      const error = errors.acpError();
      if (error || reason === 'error') { fail(id, error?.message ?? '任务失败'); return; }
      const answer = [...remote.messages].reverse().find((message) => message.role === 'assistant' && typeof message.content === 'string');
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: remote.id, update: { sessionUpdate: 'agent_message', content: { type: 'text', text: answer?.content ?? '' } } } });
      reply(id, { stopReason: reason === 'aborted' ? 'cancelled' : 'end_turn' }); return;
    }
    fail(id, `未知方法 ${method}`, -32601);
  }
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    let message: { id?: number | string; method?: string; params?: Record<string, any> };
    try { message = JSON.parse(line); } catch { return; }
    if (!message.method) return;
    const run = () => handle(message.method!, message.params ?? {}, message.id).catch((error) => {
      if (message.id !== undefined) fail(message.id, error instanceof Error ? error.message : String(error));
    });
    // 取消必须越过 prompt 的串行队列，否则会一直等任务结束。
    if (message.method === 'session/cancel') void run();
    else tail = tail.then(run);
  });
  await new Promise<void>((resolve) => { rl.once('close', () => { closed = true; resolve(); }); if (closed) resolve(); });
  await tail;
  await Promise.all([...sessions.values()].map((remote) => remote.close()));
}

/**
 * ACP（Agent Client Protocol）端点（`omni acp`，第十二节 P2，对标 Qwen Code / Kilo Code）：
 * stdio JSON-RPC 暴露 agent 能力给编辑器生态（Zed 等）。
 *
 * 协议子集（agent side，最小可用集）：
 *   initialize            → { protocolVersion, agentCapabilities }
 *   session/new           → { sessionId }（新建会话；cwd 取进程工作目录）
 *   session/prompt        → { stopReason }（同步跑一轮：消息入会话 → runAgent →
 *                            最终回答作为 session/update 通知回传 → 落盘）
 *   session/cancel        → {} （中止当前运行——AbortController）
 *
 * 设计：与 `omni mcp-server` 同构的 stdio JSON-RPC 骨架（请求串行 + 完成后响应）；
 * 会话复用 sessionsDir JSONL 持久化（--continue 生态互通）；工具审批在无 UI 的
 * stdio 下 fail-safe 拒绝（read 档位建议——由调用方配置决定）。
 */
import { createInterface } from 'node:readline';
import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { prepareRun } from './main.js';
import type { ConfigOverrides } from './config/index.js';
import { createSession, appendSessionMessages, finalizeSession, persistableMessages } from './agent/session.js';
import { EventRecorder } from './agent/events.js';
import { prepareContext } from './agent/context.js';
import { runAgent } from './agent/loop.js';
import type { RunOptions } from './agent/types.js';

/** ACP 协议版本（对齐 agentclientprotocol.com 当前版本） */
const ACP_PROTOCOL_VERSION = 1;

interface AcpSession {
  id: string;
  file: string;
  messages: ChatCompletionMessageParam[];
  runOpts: RunOptions;
  abort: AbortController | null;
}

/** 安静 Output：ACP 的输出走 JSON-RPC 响应/通知，终端过程不打印 */
const quietOutput = {
  banner() {},
  thinking: {
    get shown() {
      return false;
    },
    write() {},
    finish() {},
  },
  onRound() {}, onStreamStart() {}, onAnswer() {}, onAnswerEnd() {}, onUsage() {},
  onRequestFailed() {}, onThinkingSaved() {}, onToolStep() {}, onToolResult() {},
  onMaxSteps() {}, onUserMessage() {}, onTurnEnd() {}, onWaitForInput() {},
  clearScrollback() {}, showHelp() {},
};

/** 提取最后一个带正文的 assistant 消息（session/prompt 的回答来源） */
function lastAssistantText(messages: ChatCompletionMessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) return m.content;
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const text = m.content
        .map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text?: unknown }).text ?? '') : ''))
        .join('');
      if (text.trim()) return text;
    }
  }
  return '';
}

export async function runAcpServer(overrides: ConfigOverrides): Promise<void> {
  // 复用完整入口装配（模型/端点/权限/MCP/hooks 全一致）；stdio 下无审批 UI → fail-safe
  const ctx = prepareRun(overrides);
  await import('./main.js').then(async (m) => {
    await m.attachRuntime(ctx, quietOutput as never, {});
  });
  let cfg = ctx.cfg;

  const sessions = new Map<string, AcpSession>();
  let seq = 0;
  /** 当前活跃会话（runAgent 共用 runOpts 的单运行约束——串行处理请求） */
  let active: AcpSession | null = null;
  // tail promise 链：请求严格串行（与 mcp-server 同模式）
  let tail: Promise<void> = Promise.resolve();

  const writeMsg = (msg: Record<string, unknown>): void => {
    process.stdout.write(JSON.stringify(msg) + '\n');
  };
  const respond = (id: number | string, result: unknown): void => writeMsg({ jsonrpc: '2.0', id, result });
  const respondError = (id: number | string, code: number, message: string): void =>
    writeMsg({ jsonrpc: '2.0', id, error: { code, message } });
  const notify = (method: string, params: Record<string, unknown>): void =>
    writeMsg({ jsonrpc: '2.0', method, params });

  async function newSession(): Promise<AcpSession> {
    const file = (await createSession({ project: process.cwd(), model: cfg.model }))!;
    const messages: ChatCompletionMessageParam[] = [];
    // 每会话独立 runOpts 克隆（共享 tools/闸门引用——串行下安全）
    const runOpts: RunOptions = { ...ctx.runOpts };
    return {
      id: `sess-${++seq}`,
      file,
      messages,
      runOpts,
      abort: null,
    };
  }

  async function handle(method: string, params: Record<string, any>, id: number | string): Promise<void> {
    switch (method) {
      case 'initialize': {
        respond(id, {
          protocolVersion: ACP_PROTOCOL_VERSION,
          agentCapabilities: { loadSession: false, promptCapabilities: { embeddedContext: false } },
          agentInfo: { name: 'omni', title: 'Omni coding agent' },
        });
        return;
      }
      case 'session/new': {
        const s = await newSession();
        sessions.set(s.id, s);
        respond(id, { sessionId: s.id });
        return;
      }
      case 'session/prompt': {
        const sid = String(params.sessionId ?? '');
        const s = sessions.get(sid);
        if (!s) {
          respondError(id, -32602, `未知会话 ${sid}（先 session/new）`);
          return;
        }
        if (active && active !== s) {
          respondError(id, -32000, `会话 ${active.id} 正在运行（ACP 单运行串行；先 session/cancel 或等待完成）`);
          return;
        }
        // 提取 prompt 内容块（content blocks 数组或字符串）
        const blocks = params.prompt;
        const text = Array.isArray(blocks)
          ? blocks.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('')
          : String(blocks ?? '');
        if (!text.trim()) {
          respondError(id, -32602, 'prompt 为空');
          return;
        }
        active = s;
        s.abort = new AbortController();
        try {
          s.messages.push({ role: 'user', content: text });
          const client = s.runOpts.modelRuntime?.client ?? ctx.client;
          const model = s.runOpts.modelRuntime?.model ?? cfg.model;
          await prepareContext(client, model, s.messages, s.runOpts.context ?? {}, s.runOpts.events);
          await runAgent(client, model, s.messages, s.runOpts, quietOutput as never);
          // 回答经 session/update 通知回传（流式 chunk 不逐个推——完成后一次性）
          notify('session/update', {
            sessionId: s.id,
            update: { sessionUpdate: 'agent_message', content: { type: 'text', text: lastAssistantText(s.messages) } },
          });
          // 持久化（JSONL 生态互通）
          await appendSessionMessages(s.file, persistableMessages(s.messages)).catch(() => {});
          if (s.runOpts.events) await s.runOpts.events.flush().catch(() => {});
          await finalizeSession(s.file).catch(() => {});
          respond(id, { stopReason: s.abort.signal.aborted ? 'cancelled' : 'end_turn' });
        } catch (err) {
          respondError(id, -32000, err instanceof Error ? err.message : String(err));
        } finally {
          s.abort = null;
          active = null;
        }
        return;
      }
      case 'session/cancel': {
        const sid = String(params.sessionId ?? '');
        const s = sessions.get(sid);
        if (s?.abort) s.abort.abort();
        respond(id, {});
        return;
      }
      case 'auth/authenticate': {
        // omni 用配置文件/环境变量的 API Key——无需交互认证，直接确认
        respond(id, { method: 'env' });
        return;
      }
      default:
        respondError(id, -32601, `未知方法 ${method}`);
    }
  }

  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg: { id?: number | string; method?: string; params?: Record<string, any> };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // 非 JSON 行忽略
    }
    if (msg.id == null || !msg.method) return; // 通知忽略（客户端→服务器的 notification 无需处理）
    // 请求串行：tail 链保证顺序处理（共享 runOpts 无并发交错）
    tail = tail.then(() => handle(msg.method!, msg.params ?? {}, msg.id!)).catch(() => {});
  });
  rl.on('close', () => {
    process.exit(0);
  });
}

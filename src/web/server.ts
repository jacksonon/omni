/**
 * omni web 本地后端服务（REST + SSE，零外部依赖）。
 *
 * 架构：
 *   · 服务端复用现有 Agent 栈（prepareRun + attachRuntime + runAgent），
 *     进程内持有一组会话（messages[] + 落盘 JSONL），**全局单运行**——同一时刻
 *     只有一个会话在跑（与 TUI 单对话模型一致），避免共享 runOpts/闸门/撤销栈
 *     的并发交错；其它会话可浏览/新建，运行中的会话拒绝新消息（可取消）。
 *   · SSE（GET /api/events）向所有已连接客户端推送运行事件（thinking / tool /
 *     answer / approval / ask / usage…），Web UI 按事件名渲染；
 *   · REST：会话创建/列表/历史、发送消息、取消运行、审批/提问应答、设置。
 *
 * 审批 / 提问：Output 的回调经 PendingRegistry 注册，SSE 发出 request 事件，
 * 客户端按钮 → POST /api/.../approval|ask → registry resolve → loop 继续。
 *
 * 静态页面：优先读 web/ 目录（开发热更新），失败回退到内嵌 assets.ts
 * （bundle 单文件发布时无需外部文件）。
 */
import http from 'node:http';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type OpenAI from 'openai';
import type { ChatCompletionContentPart, ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import { createClient } from '../client.js';
import { prepareContext, summarizeContext } from '../agent/context.js';
import { runAgent } from '../agent/loop.js';
import { EventRecorder } from '../agent/events.js';
import { generateSessionTitle } from '../agent/title.js';
import { buildTraceTextLines } from '../agent/trace.js';
import {
  appendSessionMessages,
  createSession,
  finalizeSession,
  findSessionById,
  findSessionCandidates,
  isPersistable,
  listSessions,
  loadSession,
  persistableMessages,
  removeEmptySession,
  sessionIdFromPath,
  sessionsDir,
  updateSessionTitle,
} from '../agent/session.js';
import { forkSession } from '../agent/session-fork.js';
import { applyProjectMemoryPending } from '../agent/memory.js';
import {
  captureCommand,
  collectDiff,
  detectCheckCommand,
  reviewCode,
} from '../agent/review.js';
import {
  configReport,
  contextReport,
  detectScaffolds,
  doctorReport,
  exportSession,
  memoryFilesFromMessages,
  statusReport,
} from '../agent/report.js';
import { runGoal, runOrchestrate } from '../agent/orchestrate.js';
import {
  discoverSkills,
  loadSkillContent,
  parseSkillFindResults,
  runSkillsCli,
} from '../agent/skill.js';
import {
  findProjectRoot,
  generateAgentsFile,
  generateGlobalAgentsFile,
  writeAgentsFile,
  writeGlobalAgentsFile,
} from '../agent/init.js';
import { applyUndo, UndoStack, withUndoSnapshot } from '../tools/undo.js';
import {
  checkpointDiffStats,
  checkpointSummaryLine,
  createCheckpoint,
  loadCheckpoint,
  loadCheckpoints,
  removeCheckpoints,
  restoreCheckpoint,
} from '../agent/rewind.js';
import { closeMcpClients, discoverMcpServers, buildMcpTools } from '../tools/mcp.js';
import type { RunContext } from '../main.js';
import type { RunOptions } from '../agent/types.js';
import type { Output } from '../output/types.js';
import { attachRuntime, prepareRun } from '../main.js';
import { isTrustedWorkspace } from '../safety/trust.js';
import type { ConfigOverrides, OmniConfig } from '../config/index.js';
import { maybeWriteGlobalMemory } from '../agent/memory.js';
import {
  parseModelAddArgs,
  persistLanguageToConfig,
  persistModelDefaultToConfig,
  persistModelToConfig,
  persistModelConfigToGlobal,
  persistModelDefaultToGlobal,
  persistProviderConfigToGlobal,
  persistProviderModelToGlobal,
  removeProviderFromGlobal,
  removeProviderModelFromGlobal,
  migrateFlatModelToGlobal,
  persistReasoningEffortToConfig,
  persistStatuslineToConfig,
  persistVariantToConfig,
  persistWebWorkspaceToConfig,
  persistWebThemeToConfig,
  persistWebConcurrencyToConfig,
  removeWebWorkspaceFromConfig,
} from '../config/write.js';
import type { PermissionTier } from '../safety/policy.js';
import type { McpServerConfig } from '../tools/mcp.js';
import type { ApprovalRequest } from '../safety/index.js';
import type { AskResult } from '../tools/ask.js';
import { VERSION } from '../version.js';
import { WEB_ASSETS } from './assets.js';
import type { WebBroadcast } from './events.js';
import { type PendingApproval, type PendingAsk, WebOutput } from './output.js';
import { STATUSLINE_DEFAULT } from '../tui/layout.js';

/* ---------------- 静态资源 ---------------- */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_WEB_DIR = path.resolve(__dirname, '..', '..', 'web');
const CWD_WEB_DIR = path.resolve(process.cwd(), 'web');

/** 读取页面资源：开发模式优先 web/ 目录（热更新），否则用内嵌 assets.ts */
function getAsset(name: string): string | null {
  const candidates = process.env.OMNI_WEB_DIR ? [process.env.OMNI_WEB_DIR] : [SRC_WEB_DIR, CWD_WEB_DIR];
  for (const dir of candidates) {
    try {
      const f = path.join(dir, name);
      if (existsSync(f)) return readFileSync(f, 'utf8');
    } catch {
      // 继续尝试下一个候选
    }
  }
  return WEB_ASSETS[name] ?? null;
}

/** 读取应用图标 PNG：开发模式优先 web/icon.png，bundle 回退内嵌 base64 */
function getIconPng(): Buffer | null {
  const candidates = process.env.OMNI_WEB_DIR ? [process.env.OMNI_WEB_DIR] : [SRC_WEB_DIR, CWD_WEB_DIR];
  for (const dir of candidates) {
    try {
      const f = path.join(dir, 'icon.png');
      if (existsSync(f)) return readFileSync(f);
    } catch {
      // 继续尝试下一个候选
    }
  }
  const embedded = WEB_ASSETS['icon.png'];
  if (embedded && embedded.startsWith('data:image/png;base64,')) {
    return Buffer.from(embedded.slice('data:image/png;base64,'.length), 'base64');
  }
  return null;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/* ---------------- 工具函数 ---------------- */
function json(res: http.ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

function readBody(req: http.IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/* ----------------------------------------------------------------
 * WebOut 路由（attachRuntime 用）
 *
 * attachRuntime 只需 output 的 审批 / 提问 / hook 输出 / 子代理事件 四个通道。
 * 由于我们**全局单运行**，路由对象把调用转发给「当前运行会话」的 WebOutput
 *（currentOutput 在每次运行开始时设置、结束后清空）——并发安全且有单一语义。
 * ---------------------------------------------------------------- */
let currentOutput: WebOutput | null = null;

/** attachRuntime 输入的 Output 路由对象（导出供 web/index.ts 透传） */
export const routingOutput = {
  requestApproval: (req: ApprovalRequest) =>
    currentOutput ? currentOutput.requestApproval(req) : Promise.resolve(false),
  askUser: (q: string, opts: string[], multi?: boolean) =>
    currentOutput ? currentOutput.askUser(q, opts, multi ?? false) : Promise.resolve(null),
  onHookOutput: (event: string, lines: string[]) => {
    for (const l of listeners) l('hook.output', { sessionId: null, event, lines: lines.slice(0, 5) });
  },
  onSubagentEvent: (ev: unknown) => {
    const sid = currentOutput?.sessionId ?? null;
    for (const l of listeners) l('subagent', { sessionId: sid, ev });
  },
};

/* ---------------- 会话存储与运行管理（1.0 P0-2 多会话并发）---------------- */
interface WebSession {
  id: string;
  file: string | null;
  messages: ChatCompletionMessageParam[];
  /** 已持久化的可落盘消息数（增量追加起点；/clear 式压缩后重置为 0） */
  persisted: number;
  title: string;
  created: number;
  updated: number;
}

interface RunningRun {
  sessionId: string;
  controller: AbortController;
  /** steer 打断槽（每运行独立——多会话并发下不再用共享变量） */
  interruptText: string | null;
}

const sessions = new Map<string, WebSession>();
const listeners = new Set<WebBroadcast>();
const approvals = new Map<string, PendingApproval>();
const asks = new Map<string, PendingAsk>();
/** 并发运行表：sessionId → 运行句柄（每会话限 1 个并发；全局上限 cfg.webConcurrency） */
const runs = new Map<string, RunningRun>();
/** 兼容别名：全局是否至少有一个会话在跑 */
function anyRunning(): boolean {
  return runs.size > 0;
}

/** /send 排队（第六节 P2 轻量多会话协调）：容量空闲时逐条执行（FIFO） */
const queuedSends: { targetId: string; text: string }[] = [];


const pendingRegistry = {
  addApproval(sessionId: string, req: ApprovalRequest): Promise<boolean> {
    const id = `ap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    return new Promise<boolean>((resolve) => {
      approvals.set(id, { sessionId, resolve });
      for (const l of listeners) {
        l('approval.request', {
          sessionId,
          approvalId: id,
          tool: req.tool,
          summary: req.summary,
          reason: req.reason,
        });
      }
    });
  },
  addAsk(
    sessionId: string,
    question: string,
    options: string[],
    multiple: boolean
  ): Promise<AskResult | null> {
    const id = `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    return new Promise<AskResult | null>((resolve) => {
      asks.set(id, { sessionId, options, multiple, resolve });
      for (const l of listeners) {
        l('ask.request', { sessionId, askId: id, question, options, multiple });
      }
    });
  },
};

/** 从 EventRecorder 取本轮结束原因（completed / aborted / error / max-steps） */
function lastRunReason(recorder?: EventRecorder): string {
  const evs = recorder?.events ?? [];
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e.k === 'turn/end') return (e as unknown as { reason: string }).reason ?? 'completed';
  }
  return 'completed';
}

/** 生成会话标题（fire-and-forget）：首轮对话后异步调用，写入 meta + 广播。
 *  语言跟随配置 language（第十二节 P2 标题本地化）。 */
function maybeAutoTitle(s: WebSession, client: OpenAI, model: string, lang: 'zh' | 'en' = 'zh'): void {
  if (s.title) return;
  const hasAnswer = s.messages.some((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content);
  if (!hasAnswer) return;
  void generateSessionTitle(client, model, s.messages, lang)
    .then((title) => {
      if (!title || s.title) return;
      s.title = title;
      if (s.file) void updateSessionTitle(s.file, title);
      for (const l of listeners) l('title', { sessionId: s.id, title });
    })
    .catch(() => {
      // 标题是可选增强，任何异常静默忽略
    });
}

/* ---------------- git 快照（分支 / 脏文件数 / 分支列表，供输入区上下文条展示） ----------------
 * 1.0 P0-2 并发安全：execSync 会阻塞事件循环——并发多会话时一个会话的 git 探测会
 * 卡住其它会话的请求（实测并发 202 竞态）。改异步 execAsync + 2s 缓存。 */
const gitInfoCache = new Map<string, { at: number; info: Record<string, unknown> }>();
async function getGitInfo(cwd: string): Promise<Record<string, unknown>> {
  const hit = gitInfoCache.get(cwd);
  if (hit && Date.now() - hit.at < 2000) return hit.info;
  const { execAsync } = await import('node:child_process').then((m) => ({ execAsync: (cmd: string, o: unknown) => new Promise<string>((resolve) => {
    const { exec } = m as unknown as { exec: (c: string, op: any, cb: (e: unknown, s: { stdout: string }) => void) => void };
    exec(cmd, { cwd, timeout: 1500, maxBuffer: 1024 * 1024 } as never, (e, s) => resolve(e ? '' : (s.stdout ?? '')));
  }) }));
  const out: Record<string, unknown> = {};
  try {
    const branch = (await execAsync('git rev-parse --abbrev-ref HEAD', {})).trim();
    if (!branch) return out;
    out.gitBranch = branch;
    const st = (await execAsync('git status --porcelain', {})).trim();
    out.gitDirty = st ? st.split('\n').filter((l) => l.trim()).length : 0;
    const br = (await execAsync('git branch --format="%(refname:short)"', {})).trim();
    const branches = br.split('\n').map((x) => x.trim().replace(/^"|"$/g, '')).filter(Boolean);
    out.gitBranches = branches.length ? branches : [branch];
  } catch {
    // 非 git / 其它失败 → 空
  }
  gitInfoCache.set(cwd, { at: Date.now(), info: out });
  return out;
}

/* ---------------- 状态快照 ---------------- */

/** 下发 providers 分组结构（设置面板「模型配置」渲染，settings-providers-spec）：
 *  cfg.providers 逐组展开 + 未分组扁平模型（runOpts.models 中 provider 为空的显式顶层条目）。
 *  未分组同端点自动合并展示在前端（D3）；apiKey 沿用 models 既有下发方式。 */
function buildProvidersStatus(runOpts: RunContext['runOpts']): unknown[] {
  const out: Record<string, unknown>[] = [];
  for (const [name, p] of Object.entries(runOpts.cfg?.providers ?? {})) {
    out.push({
      name,
      baseURL: p.baseURL,
      apiKey: p.apiKey,
      userAgent: p.userAgent,
      models: Object.entries(p.models ?? {}).map(([mid, m]) => ({
        name: mid,
        apiModel: m.apiModel,
        displayName: m.displayName,
        reasoningEffortOptions: m.reasoningEffortOptions,
        reasoningEffort: m.reasoningEffort,
        limit: m.limit,
        variants: m.variants,
        overrideBaseURL: m.baseURL, // 模型级覆盖（继承/覆盖开关）
        overrideApiKey: m.apiKey,
      })),
    });
  }
  const flat = (runOpts.models ?? [])
    .filter((m) => !m.provider)
    .map((m) => ({
      name: m.name,
      baseURL: m.baseURL,
      apiKey: m.apiKey,
      userAgent: m.userAgent,
      apiModel: m.apiModel,
      displayName: m.displayName,
      reasoningEffortOptions: m.reasoningEffortOptions,
      reasoningEffort: m.reasoningEffort,
      limit: m.limit,
      variants: m.variants,
    }));
  if (flat.length > 0) out.push({ name: '', models: flat });
  return out;
}

async function buildStatus(runOpts: RunContext['runOpts']): Promise<Record<string, unknown>> {
  const git = await getGitInfo(process.cwd());
  return {
    version: VERSION,
    cwd: process.cwd(),
    model: runOpts.modelRuntime?.model ?? '',
    models: runOpts.models ?? [],
    providers: buildProvidersStatus(runOpts),
    permission: runOpts.permission ?? 'safe',
    planMode: runOpts.planMode ?? false,
    reasoningEffort: runOpts.reasoningEffort ?? undefined,
    reasoningEffortOptions: runOpts.reasoningEffortOptions ?? undefined,
    activeVariant: runOpts.activeVariant ?? undefined,
    webTheme: runOpts.cfg?.webTheme ?? 'system',
    language: runOpts.cfg?.language ?? 'zh',
    // 输入区下方状态行段（设置 → 状态栏配置；同 CLI/TUI footer stats）
    statusline: Array.isArray(runOpts.cfg?.statusline) ? runOpts.cfg!.statusline : STATUSLINE_DEFAULT,
    // 1.0 P0-2 多会话并发：running = 是否存在任一运行；runningSessions = 全部运行中的会话 id
    running: runs.size > 0,
    runningSession: [...runs.keys()][0] ?? null,
    runningSessions: [...runs.keys()],
    concurrency: runOpts.cfg?.webConcurrency ?? 3,
    tools: runOpts.tools?.map((t) => t.name) ?? [],
    // 已知工作区列表（设置面板一键切换用）
    workspaces: runOpts.cfg?.webWorkspaces ?? [],
    ...git,
  };
}

/* ---------------- 服务 ---------------- */
export interface WebServiceOptions {
  ctx: RunContext;
  host?: string;
  port?: number;
  overrides?: ConfigOverrides;
}

export async function startWebService(opts: WebServiceOptions): Promise<http.Server> {
  const { ctx } = opts;
  let cfg = ctx.cfg;
  const runOpts = ctx.runOpts;
  const overrides = opts.overrides ?? {};
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 3080;

  /**
   * 会话级运行时（1.0 P0-2 多会话并发）：以共享 runOpts 为原型做 **Object.create
   * 原型链克隆**——未遮蔽的字段（工具链/闸门/模型/配置）实时跟随共享对象（/model、
   * /permission 运行时切换对所有会话生效），每会话独有字段（sessionPath/events/
   * abortSignal/undoStack/interrupt 三件套/showThinking 视图）在克隆上遮蔽隔离。
   * undoStack 需要真实独立实例：对 baseTools 重新包一层 withUndoSnapshot。
   */
  const sessionRuntimes = new Map<string, RunOptions>();
  const invalidateSessionRuntimes = (): void => {
    sessionRuntimes.clear(); // 工具链重建（/mcp reconnect）或换工作区后调用
  };
  function runtimeFor(s: WebSession): RunOptions {
    let ro = sessionRuntimes.get(s.id);
    if (ro) return ro;
    const undo = new UndoStack();
    // 基础工具（静态 + delegate + ask/todo/webfetch/diagnose/skill）重包撤销快照；
    // MCP 工具无文件副作用，直接复用当前句柄构建
    const baseWrapped = (runOpts.baseTools ?? []).map((t) => withUndoSnapshot(t, undo));
    const mcpTools = buildMcpTools(runOpts.mcpHandles ?? []);
    ro = Object.assign(Object.create(runOpts), {
      undoStack: undo,
      tools: [...baseWrapped, ...mcpTools],
      sessionPath: s.file ?? undefined,
    }) as RunOptions;
    sessionRuntimes.set(s.id, ro);
    return ro;
  }

  /** 容量判定：全局并发上限（cfg.webConcurrency，默认 3）+ 每会话 1 个 */
  function capacityError(sessionId: string): string | null {
    if (runs.has(sessionId)) return '当前会话正在运行，可点击「取消」';
    const max = Math.max(1, cfg.webConcurrency ?? 3);
    if (runs.size >= max) return `已达并发上限（${max} 个会话同时运行）——等待任一完成后再试`;
    return null;
  }

  /**
   * 消费排队的跨会话消息（第六节 P2 轻量多会话协调）：容量空闲时逐条执行
   * （目标会话载入 → 追加消息 → runAgent → 本轮新增落盘）。结果广播 meta 提示。
   */
  const drainQueuedSends = async (): Promise<void> => {
    while (queuedSends.length > 0) {
      const job = queuedSends[0]!;
      if (runs.has(job.targetId)) break; // 目标会话正忙：等下一轮 drain
      if (capacityError(job.targetId)) break; // 无空位：等
      queuedSends.shift();
      const target = sessions.get(job.targetId);
      const file = target?.file ?? (await findSessionById(job.targetId));
      if (!file) continue;
      try {
        await sendMessage(job.targetId, job.text, { quiet: true });
        for (const l of listeners) l('meta.add', { sessionId: job.targetId, text: `[跨会话消息已处理] ${job.text.slice(0, 50)}` });
      } catch {
        // 失败静默（排队任务不打断主流程）
      }
    }
  };

  const broadcast: WebBroadcast = (type, data) => {
    for (const l of listeners) {
      try {
        l(type, data);
      } catch {
        // 单个客户端异常不影响其它
      }
    }
  };

  /** 前端 `+` 文件/图片选择器提交的附件（D11：扩展 POST /api/sessions/:id/messages 的 body） */
  type WebAttachment = {
    kind: 'image' | 'text' | 'path';
    name?: string;
    dataUrl?: string; // image：data:image/… base64
    content?: string; // text：读取后的内容（前端已截断 30KB）
    path?: string; // path：占位文件名
  };

  /** 校验附件：非法项静默丢弃（dataUrl 必须以 data:image/ 开头且 ≤8MB 防超长 body） */
  function sanitizeAttachments(atts: WebAttachment[] | undefined): WebAttachment[] {
    if (!Array.isArray(atts)) return [];
    return atts.filter((a) => {
      if (!a || typeof a !== 'object') return false;
      if (a.kind === 'image') {
        return typeof a.dataUrl === 'string' && a.dataUrl.startsWith('data:image/') && a.dataUrl.length <= 8 * 1024 * 1024;
      }
      if (a.kind === 'text') return typeof a.content === 'string' && a.content.length > 0;
      if (a.kind === 'path') return true;
      return false;
    });
  }

  /** 组装用户消息 content：无附件 → 原字符串（完全向后兼容）；有附件 → content 数组。
   *  UserPromptSubmit hook 改写的仍是文本部分（prompt），附件 part 原样保留（hook 后追加）。 */
  function buildUserContent(prompt: string, atts: WebAttachment[]): string | ChatCompletionContentPart[] {
    if (!atts.length) return prompt;
    const parts: ChatCompletionContentPart[] = [];
    for (const a of atts) {
      const name = a.name || '附件';
      if (a.kind === 'image') {
        parts.push({ type: 'image_url', image_url: { url: a.dataUrl! } });
      } else if (a.kind === 'text') {
        parts.push({ type: 'text', text: `【附件：${name}】\n${a.content}` });
      } else {
        parts.push({ type: 'text', text: `[附件：${name}（二进制/不支持，路径已提供，可用 read_file 读取）]` });
      }
    }
    if (prompt.trim()) parts.push({ type: 'text', text: prompt });
    return parts;
  }

  /** 发送消息 → 启动一轮 Agent 运行（后台执行，事件经 SSE 推送）。
   *  1.0 P0-2：并发安全——每会话一个运行句柄 + 原型链克隆的会话级 runOpts。 */
  async function sendMessage(
    sessionId: string,
    text: string,
    o: { quiet?: boolean; attachments?: WebAttachment[] } = {}
  ): Promise<{ error?: string }> {
    const s = sessions.get(sessionId);
    if (!s) return { error: '会话不存在' };
    const capErr = capacityError(sessionId);
    if (capErr) return { error: capErr };
    const atts = sanitizeAttachments(o.attachments);
    if (!text.trim() && !atts.length) return { error: '消息为空' };

    const ro = runtimeFor(s);
    const controller = new AbortController();
    const run: RunningRun = { sessionId, controller, interruptText: null };
    runs.set(sessionId, run);
    s.updated = Date.now();

    // 会话私有字段落在本运行的克隆上（共享 runOpts 不被污染）
    ro.sessionPath = s.file ?? undefined;
    ro.events = await EventRecorder.open(s.file ?? null);
    ro.abortSignal = controller.signal;
    ro.takeInterrupt = () => {
      const t = run.interruptText;
      run.interruptText = null;
      return t;
    };
    ro.interruptPending = () => run.interruptText !== null;
    ro.rearmAbort = () => {
      const newController = new AbortController();
      run.controller = newController;
      ro.abortSignal = newController.signal;
    };

    const output = new WebOutput(sessionId, broadcast, pendingRegistry, () => ro.showThinking ?? true, runOpts.modelRuntime?.model);
    currentOutput = output;

    // 广播运行状态（客户端据此按会话显示取消按钮 / 其它会话可继续发送）
    void broadcast('status', await buildStatus(runOpts));

    // Hooks：UserPromptSubmit——hook 返回 updatedPrompt 可改写 prompt
    let prompt = text;
    if (ro.hooks?.has('UserPromptSubmit')) {
      try {
        prompt = (await ro.hooks.userPromptSubmit(text)).prompt;
      } catch {
        prompt = text;
      }
    }

    s.messages.push({ role: 'user', content: buildUserContent(prompt, atts) });
    if (!o.quiet) output.onUserMessage(prompt); // 排队跨会话消息不在当前对话流回显
    // 会话检查点（/rewind 数据源）：每轮用户消息提交后快照工作区修改文件（存盘）；
    // 失败静默不打扰对话
    await createCheckpoint(s.file ?? undefined, prompt).catch(() => null);

    // 后台运行：事件流经 broadcast 推给客户端，REST 路由立即返回 202
    void (async () => {
      const client = runOpts.modelRuntime!.client;
      const model = runOpts.modelRuntime!.model;
      try {
        await prepareContext(client, model, s.messages, ro.context ?? {}, ro.events);
        await runAgent(client, model, s.messages, ro, output);
      } catch (err) {
        output.onRequestFailed(err);
      } finally {
        // 持久化本轮新增消息（可落盘过滤脚手架 system；摘要压缩后头部被替换 → 重置增量起点）
        const persistable = persistableMessages(s.messages);
        if (s.persisted > persistable.length) s.persisted = 0;
        if (s.file && persistable.length > s.persisted) {
          await appendSessionMessages(s.file, persistable.slice(s.persisted)).catch(() => {});
        }
        s.persisted = persistable.length;
        if (ro.events) await ro.events.flush().catch(() => {});
        if (s.file) await finalizeSession(s.file).catch(() => {});

        // 运行结束后自动生成标题（首轮）
        maybeAutoTitle(s, runOpts.modelRuntime!.client, runOpts.modelRuntime!.model, cfg.language);

        const reason = lastRunReason(ro.events);
        currentOutput = null;
        runs.delete(sessionId);
        broadcast('run.end', { sessionId, reason });
        void broadcast('status', await buildStatus(runOpts));
        // 空闲容量：消费排队跨会话消息 / 收件箱任务
        void drainQueuedSends();
      }
    })();

    return {};
  }

  /** /model 切换：按端点重建客户端并更新共享 modelRuntime（主循环/子代理同步） */
  async function switchModel(name: string): Promise<boolean> {
    const ep = (runOpts.models ?? []).find((m) => m.name === name);
    if (!ep) return false;
    try {
      const client = createClient(ep, ep.apiKey ?? cfg.apiKey ?? '');
      runOpts.modelRuntime = { client, model: name };
      runOpts.reasoningEffort = ep.reasoningEffort ?? cfg.reasoningEffort;
      runOpts.reasoningEffortOptions = ep.reasoningEffortOptions ?? cfg.reasoningEffortOptions;
      runOpts.activeVariant = ep.variant; // 命名 variant 随端点带出（1.0 P0-3）
    } catch {
      return false;
    }
    void broadcast('status', await buildStatus(runOpts));
    return true;
  }

  /** 按模型名重建当前运行时客户端（端点字段变化时）；失败保持现状 */
  function rebuildRuntimeFor(modelName: string): void {
    const ep = (runOpts.models ?? []).find((m) => m.name === modelName);
    if (!ep) return;
    try {
      const client = createClient(
        {
          name: modelName,
          baseURL: ep.baseURL ?? cfg.baseURL,
          apiKey: ep.apiKey ?? cfg.apiKey,
          userAgent: ep.userAgent ?? cfg.userAgent,
        },
        ep.apiKey ?? cfg.apiKey ?? ''
      );
      runOpts.modelRuntime = { client, model: modelName };
    } catch {
      // 失败保持现状
    }
  }

  /* ---------------- providers 运行时同步（设置 → 模型配置：一个端点配置多个模型） ---------------- */

  /** 同步 provider 级字段到所有属于该 provider 的扁平模型；当前模型端点变化 → 重建 client */
  function syncProviderFields(provider: string, fields: { baseURL?: string; apiKey?: string; userAgent?: string }): void {
    if (!runOpts.models) return;
    let needRebuild = false;
    runOpts.models.forEach((m, i) => {
      if (m.provider !== provider) return;
      const p: Record<string, unknown> = {};
      if (fields.baseURL !== undefined) p.baseURL = fields.baseURL;
      if (fields.apiKey !== undefined) p.apiKey = fields.apiKey;
      if (fields.userAgent !== undefined) p.userAgent = fields.userAgent;
      runOpts.models![i] = { ...runOpts.models![i], ...p };
      if (fields.baseURL !== undefined || fields.apiKey !== undefined) needRebuild = true;
    });
    if (needRebuild) {
      const cur = runOpts.modelRuntime?.model ?? '';
      if (runOpts.models.some((m) => m.name === cur && m.provider === provider)) rebuildRuntimeFor(cur);
    }
  }

  /** 把一个 provider 模型条目加入运行时扁平表（按 config 同款 key 策略：冲突 → provider/name） */
  function addProviderModelToRunOpts(provider: string, modelName: string, entry: Record<string, unknown>): string {
    if (!runOpts.models) return '';
    const collides = runOpts.models.some((m) => m.name === modelName && !m.provider);
    const key = collides ? `${provider}/${modelName}` : modelName;
    const idx = runOpts.models.findIndex((m) => m.name === key);
    if (idx >= 0) runOpts.models[idx] = { ...runOpts.models[idx], ...entry, name: key } as never;
    else runOpts.models.push({ name: key, ...entry } as never);
    return key;
  }

  /** 删除运行时扁平表中属于某 provider 的全部条目（或单个模型）；当前模型被删 → 回退剩余首个 */
  function removeProviderFromRunOpts(provider: string, modelName?: string): void {
    if (!runOpts.models) return;
    const targets = modelName
      ? runOpts.models.filter((m) => m.provider === provider && (m.name === modelName || m.name === `${provider}/${modelName}`))
      : runOpts.models.filter((m) => m.provider === provider);
    const cur = runOpts.modelRuntime?.model ?? '';
    const removingCurrent = targets.some((m) => m.name === cur);
    runOpts.models = runOpts.models.filter((m) => !targets.includes(m));
    if (removingCurrent && runOpts.models.length > 0) {
      void switchModel(runOpts.models[0].name);
    }
  }

  /** 镜像 provider 改动到 runOpts.cfg.providers（buildStatus 数据源；mutate 返回 null = 删除该 provider） */
  function syncCfgProvider(
    provider: string,
    mutate: (p: Record<string, unknown> | undefined) => Record<string, unknown> | null
  ): void {
    const provs = ((runOpts.cfg?.providers ?? {}) as Record<string, Record<string, unknown>>);
    const next = { ...provs };
    const res = mutate(next[provider]);
    if (res) next[provider] = res;
    else delete next[provider];
    if (runOpts.cfg) (runOpts.cfg as { providers?: unknown }).providers = next;
  }

  /** 切换工作目录（chdir + 重建 ctx/runOpts），失败回滚并抛出。
   *  供 /api/workspace、/api/git/worktree 与 /api/workspace/remove 共用。 */
  async function switchWorkspaceInternal(dir: string): Promise<void> {
    const prev = process.cwd();
    try {
      process.chdir(dir);
      const newCtx = prepareRun(overrides);
      const oldMcp = (runOpts as { mcpServers?: unknown }).mcpServers;
      if (oldMcp && typeof oldMcp === 'object' && Object.keys(oldMcp).length > 0) {
        await import('../tools/mcp.js').then((m) => m.closeMcpClients()).catch(() => {});
      }
      await attachRuntime(newCtx, routingOutput as unknown as import('../output/types.js').Output, {
        trust: isTrustedWorkspace(dir),
      });
      ctx.cfg = newCtx.cfg;
      Object.assign(runOpts, newCtx.runOpts);
      cfg = newCtx.cfg;
      invalidateSessionRuntimes(); // 换工作区后所有会话级运行时（工具链/撤销栈）重建
    } catch (e) {
      try {
        if (prev) process.chdir(prev);
      } catch {
        // 回滚失败（极少）——保持现状
      }
      throw e;
    }
  }

  /** 执行 / 命令（复用 CLI 全部命令逻辑），返回输出行数组。
   *  s = null 表示无会话上下文（/status /model /config 等仍可用）。 */
  async function runSlashCommand(
    cmd: string,
    s: WebSession | null,
  ): Promise<{ lines: string[] }> {
    const lines: string[] = [];
    const client = runOpts.modelRuntime?.client;
    const model = runOpts.modelRuntime?.model ?? cfg.model;
    const messages = s?.messages ?? [];

    const add = (t: string) => lines.push(t);

    // -- 不需要 LLM 的命令 --

    if (cmd === '/help') {
      add('可用命令：/status /context /export /config /diff [--stat|--full] /rewind /doctor /trace /agents');
      add('/model [名称|add] /variants [级别] /permission [档位] /plan /clear /undo /redo');
      add('/skill [find|add|show] /compact /review /rename /session /resume /mcp /init');
      add('/orchestrate /goal /settings /help');
      return { lines };
    }

    if (cmd === '/clear') {
      if (!s) { add('（无当前会话）'); return { lines }; }
      s.messages.length = 0;
      s.persisted = 0;
      runOpts.hooks?.resetSessionStart();
      // 广播 clear 事件 → 前端清空消息流
      for (const l of listeners) l('clear', { sessionId: s.id });
      add('已清空上下文，开始新一轮对话。');
      return { lines };
    }

    if (cmd === '/plan') {
      runOpts.planMode = !runOpts.planMode;
      add(runOpts.planMode ? '已进入计划模式（只读调研，不会修改文件；/plan 退出）。' : '已退出计划模式（可正常修改文件/执行命令）。');
      return { lines };
    }

    if (cmd === '/thinking') {
      // /thinking：前端切换展开/收起（纯 UI 行为），后端不改变事件广播。
      add('请在输入框中使用 /thinking 展开或收起全部思考过程。');
      return { lines };
    }

    if (cmd === '/permission' || cmd.startsWith('/permission ')) {
      const want = cmd.slice('/permission'.length).trim();
      const PERMS: Record<string, PermissionTier> = { 低: 'read', 中: 'safe', 高: 'ask', 全量: 'full', read: 'read', safe: 'safe', ask: 'ask', full: 'full' };
      const LABEL: Record<string, string> = { read: '低（只读）', safe: '中（标准）', ask: '高（谨慎）', full: '全量（直通）' };
      if (!want) {
        add(`当前安全权限：${LABEL[runOpts.permission ?? 'safe']}（/permission 低|中|高|全量 切换）`);
      } else {
        const next = PERMS[want];
        if (!next) { add(`未知权限「${want}」——可选：低=只读 / 中=标准 / 高=谨慎 / 全量=直通`); }
        else { runOpts.permission = next; runOpts.safetyGate?.setTier(next); add(`已切换安全权限 → ${LABEL[next]}`); }
      }
      return { lines };
    }

    if (cmd === '/undo' || cmd.startsWith('/undo ')) {
      // 无会话上下文（s=null）时 undoStack 仍在但 messages 注入无意义——如实提示，
      // 不静默「成功」（修复：此前 messages ?? [] 把 system 提示推进了临时数组，用户看不到）
      if (!s) { add('当前没有会话上下文——/undo 需要先选择一个会话。'); return { lines }; }
      const stack = runtimeFor(s).undoStack;
      if (!stack || stack.size === 0) { add('没有可撤销的写操作。'); return { lines }; }
      const all = /(?:^|\s)all(?=\s|$)/.test(cmd.slice(5));
      if (all) {
        const entries = await stack.popAllForUndo();
        const results: string[] = [];
        for (const e of entries) results.push(await applyUndo(e).catch(() => `撤销失败：${e.path}`));
        add(`已撤销全部 ${results.length} 个写操作`);
        for (const r of results) add(`· ${r}`);
        messages.push({ role: 'system', content: `[已执行 /undo all] 本次会话 ${results.length} 个文件修改已全部回滚。` });
      } else {
        const entry = await stack.popForUndo();
        if (!entry) return { lines };
        const msg = await applyUndo(entry).catch(() => `撤销失败：${entry.path}`);
        add(stack.size > 0 ? `${msg}（还有 ${stack.size} 个可撤销，/undo all 全部撤销）` : `${msg}（无更多可撤销）`);
        messages.push({ role: 'system', content: `[已执行 /undo] ${msg}。` });
      }
      return { lines };
    }

    if (cmd === '/redo' || cmd.startsWith('/redo ')) {
      // 同 /undo：无会话上下文时如实提示（messages ?? [] 临时数组 bug 修复）
      if (!s) { add('当前没有会话上下文——/redo 需要先选择一个会话。'); return { lines }; }
      const stack = runtimeFor(s).undoStack;
      if (!stack || stack.redoSize === 0) { add('没有可重做的操作。'); return { lines }; }
      const all = /(?:^|\s)all(?=\s|$)/.test(cmd.slice(5));
      if (all) {
        const entries = stack.redoAll();
        const results: string[] = [];
        for (const e of entries) results.push(await applyUndo(e).catch(() => `重做失败：${e.path}`));
        add(`已重做全部 ${results.length} 个操作`);
        for (const r of results) add(`· ${r}`);
        messages.push({ role: 'system', content: `[已执行 /redo all] 已恢复 ${results.length} 个被撤销的写操作。` });
      } else {
        const entry = stack.redo();
        if (!entry) return { lines };
        const msg = await applyUndo(entry).catch(() => `重做失败：${entry.path}`);
        add(stack.redoSize > 0 ? `${msg}（还有 ${stack.redoSize} 个可重做）` : `${msg}（无更多可重做）`);
        messages.push({ role: 'system', content: `[已执行 /redo] ${msg}。` });
      }
      return { lines };
    }

    if (cmd === '/status') {
      for (const l of statusReport({
        model, permission: runOpts.permission ?? 'safe',
        planMode: runOpts.planMode ?? false, reasoningEffort: runOpts.reasoningEffort,
        sessionPath: runOpts.sessionPath, scaffolds: detectScaffolds(messages),
        sandbox: runOpts.sandbox, trusted: runOpts.trusted,
        memoryFiles: memoryFilesFromMessages(messages),
        globalMemory: messages.some((m) => typeof m.content === 'string' && m.content.startsWith('[全局记忆')),
      })) add(l);
      return { lines };
    }

    if (cmd === '/context') {
      for (const l of contextReport(messages, cfg.summarizeAt ?? 40)) add(l);
      return { lines };
    }

    if (cmd === '/export') {
      const file = exportSession(messages, process.cwd());
      add(file ? `已导出会话 → ${file}（${messages.length} 条消息）` : '导出失败（无法写入 .omni/ 目录）');
      return { lines };
    }

    if (cmd === '/config') {
      for (const l of configReport(cfg)) add(l);
      return { lines };
    }

    if (cmd === '/diff' || cmd.startsWith('/diff ')) {
      // /diff：查看未提交改动；--stat 只看统计摘要、--full 不截断（缺省前 60 行）
      const arg = cmd.slice('/diff'.length).trim();
      const stat = /(?:^|\s)--stat(?=\s|$)/.test(arg);
      const full = /(?:^|\s)--full(?=\s|$)/.test(arg);
      add('正在收集 git diff…');
      const d = await collectDiff({ stat, full });
      if (!d.ok) add(`无法获取 git diff：${d.output.slice(0, 200)}`);
      else if (d.output === '（无改动）') add('工作区没有未提交的改动');
      else if (stat) {
        for (const l of d.output.split('\n')) add(l);
      } else {
        const dlines = d.output.split('\n');
        const shown = full ? dlines : dlines.slice(0, 60);
        add(full ? `git diff（${dlines.length} 行）：` : `git diff（${dlines.length} 行，前 60 行）：`);
        for (const l of shown) add(l);
        if (!full && dlines.length > 60) add(`… 还有 ${dlines.length - 60} 行（/diff --full 查看全部）`);
      }
      return { lines };
    }

    if (cmd === '/rewind' || cmd.startsWith('/rewind ')) {
      // /rewind：会话检查点——无参列出全部；<N> 恢复到第 N 个检查点的文件状态
      //（只回滚文件，对话保留）。检查点每轮用户消息提交时自动创建并存盘。
      const arg = cmd.slice('/rewind'.length).trim();
      const sessionFile = s?.file ?? undefined;
      const cps = await loadCheckpoints(sessionFile);
      if (!arg) {
        if (cps.length === 0) {
          add('暂无检查点——对话轮次会自动打点（每轮用户消息提交时快照工作区修改文件）');
          return { lines };
        }
        add(`会话检查点（${cps.length} 个，/rewind <序号> 回滚工作区文件到该时刻）：`);
        for (const c of cps) add(`· ${checkpointSummaryLine(c)}`);
        return { lines };
      }
      const n = Number(arg);
      if (!Number.isInteger(n) || !cps.some((c) => c.index === n)) {
        add(`/rewind <序号>：序号须为已有检查点（${cps.map((c) => c.index).join('、') || '无'}）`);
        return { lines };
      }
      const target = await loadCheckpoint(sessionFile, n);
      if (!target) return { lines };
      const results = await restoreCheckpoint(target).catch(() => ['恢复失败']);
      add(`已回滚到检查点 #${n}（${results.length} 个文件处理）：`);
      for (const r of results) add(`· ${r}`);
      if (s) s.messages.push({ role: 'system', content: `[已执行 /rewind] 工作区已回滚到检查点 #${n}（用户消息「${target.userMessage.slice(0, 80)}」提交时的状态）。请勿再基于回滚前的文件内容操作。` });
      return { lines };
    }

    if (cmd === '/doctor') {
      add('正在诊断环境…');
      for (const l of await doctorReport(cfg)) add(l);
      return { lines };
    }

    if (cmd === '/trace') {
      const events = runOpts.events?.events ?? [];
      if (events.length === 0) {
        add('暂无轨迹——开始对话后这里会记录每一轮请求/工具/消息');
      } else {
        add(`轨迹账本（${events.length} 条事件）：`);
        for (const l of buildTraceTextLines(events, { full: true })) add(l);
      }
      return { lines };
    }

    if (cmd === '/agents' || cmd.startsWith('/agents ')) {
      const showName = cmd.slice('/agents'.length).trim();
      if (showName) {
        const defs = runOpts.subagents ?? [];
        const def = defs.find((d) => d.name === showName);
        if (!def) { add(`未找到子代理定义「${showName}」`); return { lines }; }
        add(`子代理：${def.name} — ${def.description}`);
        add(`· 模型：${def.model ?? '（继承）'} · 权限：${def.permission ?? '（继承）'}`);
        add(`· 工具：${def.tools?.join('、') || '（全部默认）'} · 技能：${def.skills?.join('、') || '（无）'}`);
        add(`· 步数上限：${def.maxSteps ?? '（继承）'} · 定义文件：${def.path}`);
        for (const l of def.instructions.split('\n')) add(`  ${l}`);
      } else {
        const tools = runOpts.tools ?? [];
        const hasDelegate = tools.some((t) => t.name === 'delegate');
        add(`子代理：${hasDelegate ? '已启用' : '未启用'} · 模型：${model}`);
        add(`· 最大步数：${runOpts.maxSubagentSteps ?? 10} · 最大嵌套深度：${runOpts.maxSubagentDepth ?? 5}`);
        const defs = runOpts.subagents ?? [];
        if (defs.length > 0) { add(`· 已定义子代理（${defs.length}）：`); for (const d of defs) add(`  · ${d.name} — ${d.description}`); }
        else add('· 已定义子代理：无');
      }
      return { lines };
    }

    if (cmd === '/mcp' || cmd.startsWith('/mcp ')) {
      const servers = runOpts.mcpServers ?? {};
      const names = Object.keys(servers);
      const handles = runOpts.mcpHandles ?? [];
      const arg = cmd.slice(4).trim();
      const sub = arg.split(/\s+/)[0] ?? '';
      if (sub === 'resources') {
        if (names.length === 0) { add('未配置 MCP 服务器'); return { lines }; }
        const target = arg.split(/\s+/)[1] ?? '';
        const hs = handles.filter((h) => !target || h.name === target);
        for (const h of hs) {
          if (h.resources.length === 0) { add(`${h.name}：无资源`); continue; }
          add(`${h.name} 资源（${h.resources.length}）：`);
          for (const r of h.resources) add(`  ${r.uri}  ${r.name}`);
        }
        return { lines };
      }
      if (sub === 'prompts') {
        if (names.length === 0) { add('未配置 MCP 服务器'); return { lines }; }
        const target = arg.split(/\s+/)[1] ?? '';
        const hs = handles.filter((h) => !target || h.name === target);
        for (const h of hs) {
          if (h.prompts.length === 0) { add(`${h.name}：无提示词模板`); continue; }
          add(`${h.name} 提示词模板（${h.prompts.length}）：`);
          for (const p of h.prompts) add(`  ${p.name}${p.description ? ` — ${p.description}` : ''}`);
        }
        return { lines };
      }
      if (names.length === 0) { add('未配置 MCP 服务器（配置文件 mcpServers 字段；/mcp add 添加）'); return { lines }; }
      const mcpToolNames = (runOpts.tools ?? []).filter((t) => names.some((n) => t.name.startsWith(n.replace(/[^a-z0-9_]/gi, '_').toLowerCase() + '_')));
      add(`已配置 ${names.length} 个服务器：${names.join('、')} · 工具：${mcpToolNames.length > 0 ? mcpToolNames.map((t) => t.name).join('、') : '（无）'}`);
      for (const h of handles) {
        const bits: string[] = [];
        if (h.resources.length > 0) bits.push(`资源 ${h.resources.length} 个`);
        if (h.prompts.length > 0) bits.push(`提示词 ${h.prompts.length} 个`);
        if (h.instructions) bits.push('instructions ✓');
        if (bits.length > 0) add(`  ${h.name}：${bits.join(' · ')}`);
      }
      if (sub === 'reconnect') {
        add('正在重连 MCP…');
        closeMcpClients();
        const newHandles = await discoverMcpServers(runOpts.mcpServers);
        runOpts.mcpHandles = newHandles;
        runOpts.tools = [...(runOpts.baseTools ?? []), ...buildMcpTools(newHandles)];
        invalidateSessionRuntimes(); // 工具链变化 → 会话级克隆重建
        add(`已重连（当前 ${runOpts.tools.length} 个工具）`);
      } else { add('子命令：resources / prompts / reconnect；add/remove/login 请用 CLI 或编辑配置文件'); }
      return { lines };
    }

    if (cmd === '/rename' || cmd.startsWith('/rename ')) {
      const title = cmd.slice('/rename'.length).trim();
      if (!title) { add('用法：/rename <标题>'); return { lines }; }
      if (s) { s.title = title; if (s.file) await updateSessionTitle(s.file, title).catch(() => {}); }
      add(`会话标题已改为「${title}」`);
      return { lines };
    }

    if (cmd === '/session' || cmd.startsWith('/session ')) {
      const arg = cmd.slice('/session'.length).trim();
      const isAll = arg === 'all' || arg === 'list';
      if (!arg || isAll) {
        const list = await listSessions(isAll ? undefined : process.cwd());
        if (list.length === 0) { add(isAll ? '没有已保存的会话' : '当前目录没有历史会话'); }
        else { add(isAll ? `已保存 ${list.length} 个会话：` : `当前目录 ${list.length} 个会话：`); for (const x of list.slice(0, 20)) add(`· ${x.id} — ${x.title || '（无标题）'}（${x.messages} 条）`); }
      } else {
        const cands = await findSessionCandidates(arg);
        if (cands.length === 0) { add(`会话「${arg}」不存在`); }
        else if (cands.length > 1) { add(`「${arg}」匹配 ${cands.length} 个会话，请用完整 id`); for (const c of cands.slice(0, 9)) add(`· ${c.id}`); }
        else { add(`已找到会话 ${cands[0].id}（${cands[0].messages} 条消息）——侧栏点击恢复。`); }
      }
      return { lines };
    }

    if (cmd === '/fork' || cmd.startsWith('/fork ')) {
      // /fork：从当前会话分叉出新会话（web 端做文件级 fork，不切换会话——侧栏刷新可见）
      const arg = cmd.slice('/fork'.length).trim();
      const persistable = persistableMessages(messages ?? []);
      if (!arg) {
        add(`当前会话 ${persistable.length} 条可保留消息。/fork <N> 保留前 N 条（1..${persistable.length}）：`);
        for (let i = 0; i < persistable.length && i < 15; i++) {
          const m = persistable[i];
          const who = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : m.role;
          const txt = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '').slice(0, 60);
          add(`  ${i + 1}. [${who}] ${txt.slice(0, 60)}`);
        }
        return { lines };
      }
      const n = Number(arg);
      if (!Number.isInteger(n) || n < 1 || n > persistable.length) {
        add(`/fork <N>：N 须为 1..${persistable.length} 的整数`);
        return { lines };
      }
      if (!runOpts.sessionPath) { add('当前会话未落盘（无法 fork）'); return { lines }; }
      const forkFile = await forkSession(runOpts.sessionPath, n, process.cwd(), model);
      add(forkFile ? `已分叉新会话（${sessionIdFromPath(forkFile)} · ${n} 条消息 · 原会话保留，侧栏刷新可见）` : 'fork 失败');
      return { lines };
    }

    if (cmd === '/send' || cmd.startsWith('/send ')) {
      // /send（第六节 P2 轻量多会话协调）：web 端把目标会话消息**排队为后台任务**——
      // 目标会话在当前运行结束后自动执行（复用全局单运行的串行闸门，不并发交错）；
      // 结果落盘到目标会话文件（侧栏刷新可见），不注入 web 当前对话流。
      const arg = cmd.slice('/send'.length).trim();
      const m2 = arg.match(/^(\S+)\s+([\s\S]+)$/);
      if (!m2) { add('用法：/send <会话id> <消息>'); return { lines }; }
      const cands = await findSessionCandidates(m2[1]);
      const currentId = s ? s.id : '';
      const target = cands.find((c) => c.id !== currentId);
      if (!target) { add(`会话「${m2[1]}」不存在（或即当前会话）`); return { lines }; }
      queuedSends.push({ targetId: target.id, text: m2[2].trim() });
      add(`已排队：向会话 ${target.id} 发送「${m2[2].trim().slice(0, 50)}」（当前任务结束后自动执行，结果写入目标会话）。`);
      return { lines };
    }

    if (cmd === '/memory-apply' || cmd.startsWith('/memory-apply ')) {
      // /memory-apply：应用待提交的项目记忆片段（.omni/memory-pending.md → 项目根 AGENTS.md）
      const res = await applyProjectMemoryPending(process.cwd());
      add(res.message);
      return { lines };
    }

    if (cmd === '/resume' || cmd.startsWith('/resume ')) {
      const arg = cmd.slice('/resume'.length).trim();
      if (!arg) { const list = await listSessions(); add(`已保存 ${list.length} 个会话（/resume <id> 恢复）：`); for (const x of list.slice(0, 15)) add(`· ${x.id} — ${x.title || '（无标题）'}（${x.messages} 条）`); }
      else { const cands = await findSessionCandidates(arg); if (cands.length === 0) add(`会话「${arg}」不存在`); else add(`已找到会话 ${cands[0].id}——侧栏点击恢复。`); }
      return { lines };
    }

    if (cmd === '/variants' || cmd.startsWith('/variants ')) {
      // /variants：字符串级别 + 命名 variants（1.0 P0-3）——<id> 命中当前模型的
      // variants 表时切叠加层并持久化 models."<模型>".variant；未知报错列可用项。
      const opts = runOpts.reasoningEffortOptions ?? ['low', 'medium', 'high'];
      const ep = (runOpts.models ?? []).find((m) => m.name === model);
      const namedIds = Object.keys(ep?.variants ?? {});
      const want = cmd.slice('/variants'.length).trim();
      if (!want) {
        add(
          runOpts.activeVariant
            ? `当前：命名变体 ${runOpts.activeVariant}（级别 ${runOpts.reasoningEffort ?? '默认'}）`
            : `当前思考级别：${runOpts.reasoningEffort ?? '（未设置）'}`
        );
        add(`可选：${[...opts, ...namedIds.map((id) => `${id}(命名)`)].join(' / ')}`);
      } else if (namedIds.includes(want) && !opts.includes(want)) {
        runOpts.activeVariant = want;
        add(`已切换命名变体 → ${want}`);
        const res = persistVariantToConfig(want, cfg, model);
        add(res.message);
      } else if (!opts.includes(want)) {
        add(`未知思考级别「${want}」——可选：${[...opts, ...namedIds.map((id) => `${id}(命名)`)].join(' / ')}`);
      } else {
        runOpts.reasoningEffort = want;
        runOpts.activeVariant = undefined; // 普通级别清除命名叠加
        add(`已切换思考级别 → ${want}`);
        const res = persistReasoningEffortToConfig(want, cfg, model);
        add(res.message);
      }
      return { lines };
    }

    if (cmd === '/model fetch' || cmd.startsWith('/model fetch ')) {
      // /model fetch [名称]（1.0 P1）：GET {baseURL}/models 自动补全远端模型清单
      const target = cmd.slice('/model fetch'.length).trim();
      const eps = runOpts.models ?? [];
      const ep = target ? eps.find((m) => m.name === target) : eps.find((m) => m.name === model);
      if (!ep?.baseURL) { add(`/model fetch${target ? ` ${target}` : ''}：未找到带 baseURL 的端点`); return { lines }; }
      add(`正在拉取 ${ep.baseURL}/models …`);
      try {
        const { discoverModels } = await import('../client.js');
        const ids = await discoverModels(ep);
        const known = new Set(eps.flatMap((m) => [m.name, m.apiModel ?? '']));
        const fresh = ids.filter((id) => !known.has(id));
        add(`远端共 ${ids.length} 个模型，未在本地列表的 ${fresh.length} 个：`);
        for (const id of fresh.slice(0, 30)) add(`· ${id}`);
        if (fresh.length > 30) add(`… 还有 ${fresh.length - 30} 个`);
        add('添加：/model add <名> --base-url <端点> --api-key <key>；或编辑 config providers/models');
      } catch (err) {
        add(`模型发现失败：${err instanceof Error ? err.message : err}`);
      }
      return { lines };
    }

    if (cmd === '/model' || cmd.startsWith('/model ')) {
      const want = cmd.slice('/model'.length).trim();
      const models = runOpts.models ?? [];
      if (!want) {
        add(`当前模型：${model}（可用：${models.map((m) => m.name).join(' / ')}）`);
      } else if (want.startsWith('add')) {
        const parsed = parseModelAddArgs(want.slice(3));
        if (!parsed.ok) { add(parsed.error); return { lines }; }
        const endpoint = {
          name: parsed.name, baseURL: parsed.baseURL ?? cfg.baseURL,
          apiKey: parsed.apiKey ?? cfg.apiKey, userAgent: parsed.userAgent ?? cfg.userAgent,
          reasoningEffortOptions: cfg.reasoningEffortOptions, reasoningEffort: cfg.reasoningEffort,
        };
        const existing = models.find((m) => m.name === parsed.name);
        if (existing) Object.assign(existing, endpoint);
        else runOpts.models = [...models, endpoint];
        if (await switchModel(parsed.name)) add(`已添加并切换模型 → ${parsed.name}`);
        else add(`切换失败：${parsed.name}`);
        const res = persistModelToConfig(parsed.name, { baseURL: parsed.baseURL, apiKey: parsed.apiKey, userAgent: parsed.userAgent }, cfg);
        add(res.message);
      } else {
        const ep = models.find((m) => m.name === want);
        if (!ep) { add(`未知模型「${want}」`); }
        else if (want === model) { add(`已是当前模型 ${want}`); }
        else {
          if (await switchModel(want)) {
            add(`已切换模型 → ${want}`);
            const res = persistModelDefaultToConfig(want, cfg);
            add(res.message);
          } else { add(`切换失败：${want}`); }
        }
      }
      return { lines };
    }

    // -- 需要 LLM 的命令（无 client 时提示）--

    if (!client) {
      add('此命令需要可用的模型客户端（当前未配置模型端点）。');
      return { lines };
    }

    if (cmd === '/compact') {
      const before = messages.length;
      await summarizeContext(client, model, messages, { summarizeAt: 1, summarizeWindow: 8 }, runOpts.events);
      add(messages.length < before ? `已压缩 ${before - messages.length} 条旧消息为摘要。` : '上下文还很短，无需压缩。');
      return { lines };
    }

    if (cmd === '/review') {
      add('正在收集改动并运行 typecheck…');
      const checkCmd = detectCheckCommand();
      const check = checkCmd ? { command: checkCmd, output: (await captureCommand(checkCmd, 120_000)).output } : { command: null, output: '（无脚本）' };
      const diff = await collectDiff();
      if (!diff.ok) { add(`无法获取 git diff：${diff.output.slice(0, 200)}`); return { lines }; }
      if (diff.output === '（无改动）') { add('工作区没有改动可审查。'); return { lines }; }
      add(`typecheck：${check.output === '（无输出）' ? '通过' : check.output.split('\n').slice(0, 3).join(' · ')}`);
      const review = await reviewCode(client, model, diff.output, { command: check.command, output: check.output });
      if (!review) { add('审查失败（网络/API 问题），请重试。'); }
      else { add(`审查结果（${diff.output.length} 字符改动）：`); for (const l of review.split('\n')) add(l); }
      return { lines };
    }

    if (cmd === '/init' || cmd.startsWith('/init ')) {
      const isGlobal = /(?:^|\s)--global(?=\s|$)/.test(cmd);
      if (isGlobal) {
        add('正在扫描用户环境并生成全局记忆 AGENTS.md…');
        const content = await generateGlobalAgentsFile(client, model);
        if (!content) { add('生成失败（网络/API 问题），请重试。'); return { lines }; }
        const res = await writeGlobalAgentsFile(content);
        add(res.ok ? `已生成全局记忆 ${res.path}` : `已存在 ${res.path}，/init --global 不覆盖。`);
      } else {
        const root = findProjectRoot(process.cwd());
        add(`正在扫描项目并生成 AGENTS.md（项目根：${root}）…`);
        const content = await generateAgentsFile(client, model, root);
        if (!content) { add('生成失败（网络/API 问题），请重试。'); return { lines }; }
        const res = await writeAgentsFile(root, content);
        add(res.ok ? `已生成 ${res.path}` : `已存在 ${res.path}，/init 不覆盖。`);
      }
      return { lines };
    }

    if (cmd === '/orchestrate' || cmd.startsWith('/orchestrate ')) {
      if (!runOpts.safetyGate) { add('需要安全闸（当前环境异常）'); return { lines }; }
      try {
        const { combined, review } = await runOrchestrate(cmd.slice('/orchestrate'.length).trim(), runOpts.subagents, {
          client, model, runOpts,
          log: (t) => add(t),
          onSubagentEvent: (ev) => { /* 静默，不阻塞 */ },
        });
        add('═══ 综合结果 ═══'); for (const l of combined.split('\n')) add(l);
        add('═══ 对抗审查 ═══'); for (const l of review.split('\n')) add(l);
      } catch (err) { add(String((err as Error)?.message ?? err)); }
      return { lines };
    }

    const goalCmd = cmd === '/goal' || cmd.startsWith('/goal ') || cmd === '/loop' || cmd.startsWith('/loop ');
    if (goalCmd) {
      if (!runOpts.safetyGate) { add('需要安全闸（当前环境异常）'); return { lines }; }
      try {
        const raw = (cmd.startsWith('/goal') ? cmd.slice('/goal'.length) : cmd.slice('/loop'.length)).trim();
        const result = await runGoal(raw, {
          client, model, runOpts,
          log: (t) => add(t),
          onStream: () => ({
            start(prefix: string) { add(prefix); },
            chunk() { /* 流式逐字暂不实现，整行输出 */ },
            end() {},
          }),
          onSubagentEvent: () => {},
        });
        add(result);
      } catch (err) { add(String((err as Error)?.message ?? err)); }
      return { lines };
    }

    if (cmd === '/spec' || cmd.startsWith('/spec ')) {
      // /spec <特性>（1.0 P1-7）：生成 .omni/specs/<slug>/{requirements,design,tasks}.md
      const feature = cmd.slice('/spec'.length).trim();
      if (!feature) { add('用法：/spec <功能特性>'); return { lines }; }
      const { generateSpec } = await import('../agent/spec.js');
      const r = await generateSpec(client, model, feature, process.cwd(), runOpts.todoList);
      add(r.message);
      return { lines };
    }

    if (cmd === '/preset' || cmd.startsWith('/preset ')) {
      // /preset browser（1.0 P1-6）：一键安装浏览器自动化双雄 MCP（写全局配置）
      const { runPreset } = await import('../agent/preset.js');
      const r = await runPreset(cmd.slice('/preset'.length).trim());
      for (const l of r.lines) add(l);
      return { lines };
    }

    if (cmd === '/skill' || cmd.startsWith('/skill ')) {
      const args = cmd.slice('/skill'.length).trim();
      if (!args) {
        const skills = await discoverSkills();
        if (skills.length === 0) {
          add('未发现技能。用 /skill find <关键词> 网络检索，或 /skill add <owner/repo> 安装。');
        } else {
          add(`已发现 ${skills.length} 个技能：`);
          for (const sk of skills) add(`· ${sk.name} — ${sk.description}${sk.global ? '（全局）' : ''}`);
        }
        return { lines };
      }
      const findM = args.match(/^find\s+(.+)$/);
      if (findM) {
        add(`正在网络检索（npx skills find ${findM[1]}）…`);
        const { ok, output } = await runSkillsCli(['find', findM[1]]);
        if (!ok) { add(`检索失败：${output.slice(0, 300) || 'npx skills 不可用'}`); }
        else {
          const results = parseSkillFindResults(output);
          if (results.length === 0) { add(`没有匹配「${findM[1]}」的技能。`); }
          else { add(`找到 ${results.length} 个技能：`); for (const r of results.slice(0, 20)) add(`· ${r}`); }
        }
        return { lines };
      }
      const addM = args.match(/^add\s+(\S+)(?:\s+--skill\s+(.+))?$/);
      if (addM) {
        add(`正在安装 ${addM[1]}…`);
        const { ok, output } = await runSkillsCli(['add', addM[1], ...(addM[2] ? ['--skill', addM[2]] : []), '-y'], 180_000);
        add(ok ? '安装完成（已装入 .agents/skills 等目录，下次会话自动发现）。' : `安装失败：${output.slice(0, 300)}`);
        return { lines };
      }
      const showM = args.match(/^show\s+(\S+)$/);
      if (showM) {
        const content = await loadSkillContent(showM[1]);
        if (!content) { add(`未找到技能「${showM[1]}」`); }
        else { add(`技能「${showM[1]}」内容：`); for (const l of content.split('\n')) add(l); }
        return { lines };
      }
      add('用法：/skill（列出）· /skill find <词>（检索）· /skill add <repo>（安装）· /skill show <名>（查看）');
      return { lines };
    }

    add(`未知命令「${cmd}」。/help 查看可用命令。`);
    return { lines };
  }

  async function createWebSession(resumeId?: string): Promise<WebSession> {
    if (resumeId) {
      const file = await findSessionById(resumeId);
      if (!file) throw new Error('会话不存在');
      const loaded = await loadSession(file);
      if (!loaded) throw new Error('会话文件损坏，无法恢复');
      const existing = sessions.get(loaded.meta.id);
      if (existing) return existing;
      const ws: WebSession = {
        id: loaded.meta.id,
        file,
        messages: [...loaded.messages],
        persisted: persistableMessages(loaded.messages).length,
        title: loaded.meta.title ?? '',
        created: loaded.meta.created,
        updated: loaded.meta.updated,
      };
      sessions.set(ws.id, ws);
      broadcast('session.created', { id: ws.id, title: ws.title });
      return ws;
    }
    const file = await createSession({ project: process.cwd(), model: runOpts.modelRuntime?.model ?? cfg.model });
    if (!file) throw new Error('创建会话失败（无法写入会话目录）');
    const id = sessionIdFromPath(file);
    const now = Date.now();
    const ws: WebSession = { id, file, messages: [], persisted: 0, title: '', created: now, updated: now };
    sessions.set(id, ws);
    broadcast('session.created', { id, title: '' });
    return ws;
  }

  /** 会话消息 → Markdown（/export 与下载端点共用；脚手架 system 不导出，与 report.exportSession 同语义） */
  function exportMarkdownOf(messages: ChatCompletionMessageParam[], title: string): string {
    const lines: string[] = [`# ${title}`, '', `> 导出自 Omni Web · ${new Date().toLocaleString('zh-CN')}`, ''];
    for (const m of messages.filter(isPersistable)) {
      const who = m.role === 'user' ? '👤 用户' : m.role === 'assistant' ? '🤖 助手' : m.role === 'tool' ? '🔧 工具结果' : '⚙️ 系统';
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
      lines.push(`### ${who}`, '', content, '');
    }
    return lines.join('\n');
  }

  /** 无标题会话的展示兜底：取首条用户消息前 30 字符作缩略标题（不落盘） */
  function firstUserSnippet(messages: ChatCompletionMessageParam[], max = 30): string {
    const m = messages.find((x) => x.role === 'user' && typeof x.content === 'string' && x.content.trim());
    const text = m ? (m.content as string).replace(/\s+/g, ' ').trim() : '';
    if (!text) return '';
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }

  async function listWebSessions(): Promise<
    Array<{ id: string; title: string; messages: number; created: number; updated: number; project?: string }>
  > {
    // 返回**全部**会话（含 project 字段）——侧栏按工作区分组展示（组=工作区、
    // 组内元素=会话），由前端分组渲染；不再按 cwd 过滤。
    // 自动标题生成失败的会话（网关不支持辅助请求等）用首条用户消息缩略兜底，
    // 避免列表里全是「新会话」无法分辨。
    const persisted = await listSessions();
    const out = [];
    for (const s of persisted) {
      const live = sessions.get(s.id);
      let title = s.title ?? '';
      if (!title) {
        const fromMemory = live ? firstUserSnippet(live.messages) : '';
        title = fromMemory;
        if (!fromMemory && s.path) {
          const loaded = await loadSession(s.path).catch(() => null);
          title = loaded ? firstUserSnippet(loaded.messages) : '';
        }
      }
      out.push({
        id: s.id,
        title,
        messages: live ? live.messages.length : s.messages,
        created: s.created,
        updated: live ? live.updated : s.updated,
        project: s.project,
      });
    }
    // 内存中尚未落盘会话（防御性兜底——创建即落盘，正常不会出现）
    for (const s of sessions.values()) {
      if (!out.some((o) => o.id === s.id)) {
        out.push({ id: s.id, title: s.title, messages: s.messages.length, created: s.created, updated: s.updated, project: process.cwd() });
      }
    }
    return out.sort((a, b) => b.updated - a.updated);
  }

  /** 按需取会话（内存没有时从磁盘加载——服务重启后历史会话只在磁盘上） */
  async function ensureSession(sessionId: string): Promise<WebSession> {
    const existing = sessions.get(sessionId);
    if (existing) return existing;
    const file = await findSessionById(sessionId);
    if (!file) throw new NotFoundError(`会话不存在：${sessionId}`);
    const loaded = await loadSession(file);
    if (!loaded) throw new NotFoundError('会话文件损坏，无法读取');
    const ws: WebSession = {
      id: loaded.meta.id,
      file,
      messages: [...loaded.messages],
      persisted: persistableMessages(loaded.messages).length,
      title: loaded.meta.title ?? '',
      created: loaded.meta.created,
      updated: loaded.meta.updated,
    };
    sessions.set(ws.id, ws);
    return ws;
  }

  /** 取会话消息（过滤脚手架 system；供客户端刷历史/重连恢复） */
  async function sessionMessages(
    sessionId: string
  ): Promise<{ meta: { title: string | null } | null; messages: ChatCompletionMessageParam[] }> {
    const s = await ensureSession(sessionId);
    return { meta: { title: s.title || null }, messages: s.messages.filter(isPersistable) };
  }

  /** 404 语义错误（路由 catch 区分 404 与 400） */
  class NotFoundError extends Error {}

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const p = url.pathname;
    const parts = p.split('/').filter(Boolean);

    try {
      // ---------- SSE ----------
      if (p === '/api/events' && req.method === 'GET') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        res.write(`event: ready\ndata: ${JSON.stringify({ version: VERSION, cwd: process.cwd() })}\n\n`);
        const l: WebBroadcast = (type, data) => {
          res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        listeners.add(l);
        const hb = setInterval(() => res.write(': ping\n\n'), 15000);
        req.on('close', () => {
          clearInterval(hb);
          listeners.delete(l);
        });
        return;
      }

      // ---------- 静态页面 ----------
      if (req.method === 'GET' && (p === '/' || p === '/index.html' || p === '/style.css' || p === '/app.js')) {
        const name = p === '/' ? 'index.html' : p.replace(/^\//, '');
        const asset = getAsset(name);
        if (asset === null) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(`资源缺失：web/${name} 不存在（npm run web:sync 重新生成）`);
          return;
        }
        const ext = path.extname(name);
        res.writeHead(200, { 'content-type': MIME[ext] ?? 'text/plain; charset=utf-8' });
        res.end(asset);
        return;
      }
      if (req.method === 'GET' && p === '/icon.png') {
        const buf = getIconPng();
        if (!buf) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('icon.png 缺失（npm run web:sync 重新生成）');
          return;
        }
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
        res.end(buf);
        return;
      }
      if (req.method === 'GET' && p === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }

      // ---------- REST API ----------
      if (parts[0] !== 'api') {
        json(res, 404, { error: 'Not Found' });
        return;
      }

      if (p === '/api/status' && req.method === 'GET') {
        json(res, 200, await buildStatus(runOpts));
        return;
      }

      // @ 提及文件：列出工作区下的文件/目录
      if (p === '/api/files' && req.method === 'GET') {
        const url = new URL(req.url || '', 'http://localhost');
        const query = url.searchParams.get('q') || '';
        const cwd = process.cwd();
        const NOISE_DIRS = new Set(['node_modules', '.git', 'dist', '__pycache__', '.next', '.cache', 'build', '.turbo', 'coverage']);
        const isHidden = (n: string) => n.startsWith('.') && !query.startsWith('.');
        const results: { name: string; path: string; isDir: boolean }[] = [];
        const dirPart = query.includes('/') ? query.slice(0, query.lastIndexOf('/') + 1) : '';
        const filePart = query.includes('/') ? query.slice(query.lastIndexOf('/') + 1) : query;
        const baseDir = dirPart ? cwd + '/' + dirPart : cwd;
        const collect = (dir: string, depth: number) => {
          if (depth > 3 || results.length >= 50) return;
          let entries: import('node:fs').Dirent[];
          try { entries = readdirSync(dir, { withFileTypes: true }); }
          catch { return; }
          if (!filePart) {
            for (const ent of entries) {
              if (NOISE_DIRS.has(ent.name) || isHidden(ent.name)) continue;
              const full = path.join(dir, ent.name);
              const rel = path.relative(cwd, full);
              results.push({ name: ent.name, path: rel, isDir: ent.isDirectory() });
              if (results.length >= 50) break;
            }
          } else {
            for (const ent of entries) {
              if (NOISE_DIRS.has(ent.name)) continue;
              const full = path.join(dir, ent.name);
              const rel = path.relative(cwd, full);
              const lower = ent.name.toLowerCase();
              if (lower.startsWith(filePart.toLowerCase()) || lower.includes(filePart.toLowerCase())) {
                if (!isHidden(ent.name)) results.push({ name: ent.name, path: rel, isDir: ent.isDirectory() });
              }
              if (results.length >= 50) return;
              if (ent.isDirectory()) collect(full, depth + 1);
            }
          }
        };
        try { collect(baseDir, 0); } catch {}
        results.sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        json(res, 200, results);
        return;
      }

      if (p === '/api/sessions' && req.method === 'GET') {
        json(res, 200, await listWebSessions());
        return;
      }

      if (p === '/api/sessions' && req.method === 'POST') {
        const body = await readBody(req);
        const ws = await createWebSession(typeof body.resume === 'string' ? body.resume : undefined);
        json(res, 201, { id: ws.id, title: ws.title });
        return;
      }

      const sid = parts[2]; // /api/sessions/:id/... → parts = ['api','sessions',id,action]
      const sessionPath = (action: string): string => `/api/sessions/${sid}/${action}`;
      if (sid) {
        if (p === sessionPath('messages') && req.method === 'GET') {
          json(res, 200, await sessionMessages(sid));
          return;
        }
        if (p === sessionPath('messages') && req.method === 'POST') {
          const body = await readBody(req);
          const err = await sendMessage(sid, typeof body.text === 'string' ? body.text : '', {
            attachments: Array.isArray(body.attachments) ? body.attachments : undefined,
          });
          if (err.error) {
            json(res, 409, err);
            return;
          }
          json(res, 202, { ok: true });
          return;
        }
        if (p === sessionPath('cancel') && req.method === 'POST') {
          runs.get(sid)?.controller.abort();
          json(res, 200, { ok: true });
          return;
        }
        if (p === sessionPath('steer') && req.method === 'POST') {
          // steer 打断：写入 interruptText + abort → loop 在流中断后取走消息插入同一轮
          const run0 = runs.get(sid);
          if (!run0) {
            json(res, 409, { error: '当前会话未在运行' });
            return;
          }
          const body = await readBody(req);
          const text = typeof body.text === 'string' ? body.text.trim() : '';
          if (!text) { json(res, 400, { error: '消息为空' }); return; }
          // 直接写入本运行的中断槽 + abort（runOpts.interruptPending 是只读探测，不能传参）
          // 注意：这里**不**广播 user.message——loop 处理中断时会经 output.onUserMessage
          // 广播一次（唯一来源）；若在此处再广播，前端会收到两条 user.message（一条 steer、
          // 一条 loop 的），对话流出现**重复的两条打断消息**（用户反馈「Cmd+Enter 一次发出两个」）。
          run0.interruptText = text;
          run0.controller.abort();
          json(res, 202, { ok: true });
          return;
        }
        if (p === sessionPath('approval') && req.method === 'POST') {
          const body = await readBody(req);
          const id = typeof body.approvalId === 'string' ? body.approvalId : '';
          const entry = approvals.get(id);
          if (!entry) {
            json(res, 404, { error: '审批请求不存在或已过期' });
            return;
          }
          approvals.delete(id);
          const allow = body.allow === true;
          entry.resolve(allow);
          broadcast('approval.resolved', { sessionId: entry.sessionId, approvalId: id, allow });
          json(res, 200, { ok: true });
          return;
        }
        if (p === sessionPath('ask') && req.method === 'POST') {
          const body = await readBody(req);
          const id = typeof body.askId === 'string' ? body.askId : '';
          const entry = asks.get(id);
          if (!entry) {
            json(res, 404, { error: '提问请求不存在或已过期' });
            return;
          }
          asks.delete(id);
          const raw = Array.isArray(body.choices) ? body.choices.map(String).filter(Boolean) : null;
          let result: AskResult | null = null;
          if (raw && raw.length > 0) {
            const custom = raw.some((c) => !entry.options.includes(c));
            result = {
              choice: raw.join(entry.multiple ? '、' : ''),
              custom,
              choices: raw,
            };
          }
          entry.resolve(result);
          broadcast('ask.resolved', { sessionId: entry.sessionId, askId: id, choices: raw });
          json(res, 200, { ok: true });
          return;
        }
        if (p === sessionPath('rename') && req.method === 'POST') {
          // 重命名会话（⋯ 菜单）：更新内存 + 会话文件 meta + 广播
          const body = await readBody(req);
          const title = typeof body.title === 'string' ? body.title.trim().slice(0, 60) : '';
          if (!title) {
            json(res, 400, { error: '标题不能为空' });
            return;
          }
          const s = await ensureSession(sid);
          s.title = title;
          if (s.file) await updateSessionTitle(s.file, title).catch(() => {});
          broadcast('title', { sessionId: sid, title });
          json(res, 200, { ok: true, title });
          return;
        }
        if (p === sessionPath('delete') && req.method === 'DELETE') {
          const s = sessions.get(sid);
          if (!s) throw new NotFoundError(`会话不存在：${sid}`);
          if (runs.has(sid)) {
            json(res, 409, { error: '会话正在运行，请先取消' });
            return;
          }
          if (s.file) {
            await rm(s.file, { force: true }).catch(() => {});
            await removeCheckpoints(s.file).catch(() => {});
          }
          sessions.delete(sid);
          sessionRuntimes.delete(sid);
          broadcast('session.deleted', { sessionId: sid });
          json(res, 200, { ok: true });
          return;
        }
      }

      if (p === '/api/settings' && req.method === 'POST') {
        const body = await readBody(req);
        // API Key（可选）：覆盖当前模型端点（仅本次运行，不写配置文件）
        if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
          cfg.apiKey = body.apiKey.trim();
          const ep = runOpts.models?.find((m) => m.name === runOpts.modelRuntime?.model) ?? null;
          const client = createClient(
            {
              name: runOpts.modelRuntime?.model ?? cfg.model,
              baseURL: ep?.baseURL ?? cfg.baseURL,
              apiKey: cfg.apiKey,
              userAgent: ep?.userAgent ?? cfg.userAgent,
            },
            cfg.apiKey
          );
          runOpts.modelRuntime = { client, model: runOpts.modelRuntime?.model ?? cfg.model };
        }
        if (typeof body.model === 'string' && body.model) {
          if (!(await switchModel(body.model))) {
            json(res, 400, { error: `未知模型：${body.model}` });
            return;
          }
        }
        if (typeof body.permission === 'string' && ['read', 'safe', 'ask', 'full'].includes(body.permission)) {
          runOpts.permission = body.permission as RunContext['runOpts']['permission'];
          runOpts.safetyGate?.setTier(body.permission as never);
        }
        if (typeof body.reasoningEffort === 'string' && body.reasoningEffort) {
          runOpts.reasoningEffort = body.reasoningEffort;
        }
        if (typeof body.planMode === 'boolean') {
          runOpts.planMode = body.planMode;
        }
        if (body.webTheme === 'light' || body.webTheme === 'dark' || body.webTheme === 'system') {
          // 设置面板「主题」tab：运行时应用（buildStatus 下发）+ 持久化到配置文件
          if (runOpts.cfg) runOpts.cfg.webTheme = body.webTheme;
          persistWebThemeToConfig(body.webTheme, cfg);
        }
        if (body.language === 'zh' || body.language === 'en') {
          // 设置面板「通用 → 语言」：运行时应用 + 持久化（与 CLI 的 /settings 语言一致）
          if (runOpts.cfg) runOpts.cfg.language = body.language;
          persistLanguageToConfig(body.language, cfg);
        }
        if (typeof body.webConcurrency === 'number' && Number.isFinite(body.webConcurrency) && body.webConcurrency >= 1 && body.webConcurrency <= 16) {
          const val = Math.floor(body.webConcurrency);
          if (runOpts.cfg) runOpts.cfg.webConcurrency = val;
          cfg.webConcurrency = val;
          persistWebConcurrencyToConfig(val, cfg);
        }
        // 设置面板「状态栏」tab：哪些统计段显示在输入区下方（勾选开关 → statusline 数组）
        if (Array.isArray(body.statusline)) {
          const known = new Set(STATUSLINE_DEFAULT);
          const next = (body.statusline as unknown[]).map(String).filter((x) => known.has(x));
          if (runOpts.cfg) runOpts.cfg.statusline = next;
          cfg.statusline = next;
          persistStatuslineToConfig(next, cfg);
        }
        // 设置面板「模型配置」tab：保存所选模型的端点/密钥/级别/上下文到全局配置 + 运行时应用
        if (body.modelConfig && typeof body.modelConfig === 'object') {
          const mc = body.modelConfig as Record<string, unknown>;
          const name = typeof mc.modelName === 'string' && mc.modelName.trim()
            ? mc.modelName.trim() : (runOpts.modelRuntime?.model ?? cfg.model);
          const baseURL = typeof mc.baseURL === 'string' && mc.baseURL.trim() ? mc.baseURL.trim() : undefined;
          const apiKey = typeof mc.apiKey === 'string' && mc.apiKey.trim() ? mc.apiKey.trim() : undefined;
          const efforts = Array.isArray(mc.reasoningEffortOptions)
            ? (mc.reasoningEffortOptions as unknown[]).map(String).filter((x) => x.trim())
            : undefined;
          const effort = typeof mc.reasoningEffort === 'string' && mc.reasoningEffort.trim() ? mc.reasoningEffort.trim() : undefined;
          const ctxLimit = typeof mc.contextLimit === 'number' && mc.contextLimit > 0 ? Math.floor(mc.contextLimit) : undefined;
          persistModelConfigToGlobal(
            { modelName: name, baseURL, apiKey, reasoningEffortOptions: efforts, reasoningEffort: effort, contextLimit: ctxLimit },
            cfg
          );
          // 同步内存 models 表 + 运行时应用（仅当保存的是当前模型）
          const isCurrent = name === (runOpts.modelRuntime?.model ?? cfg.model);
          if (runOpts.models) {
            const idx = runOpts.models.findIndex((m) => m.name === name);
            const patch: Record<string, unknown> = {};
            if (baseURL) patch.baseURL = baseURL;
            if (apiKey) patch.apiKey = apiKey;
            if (efforts) patch.reasoningEffortOptions = efforts;
            if (effort) patch.reasoningEffort = effort;
            if (ctxLimit) patch.limit = { context: ctxLimit };
            if (idx >= 0) runOpts.models[idx] = { ...runOpts.models[idx], ...patch };
            else runOpts.models.push({ name, ...patch });
          }
          if (isCurrent) {
            if (baseURL || apiKey) {
              const ep = runOpts.models?.find((m) => m.name === name);
              const client = createClient(
                {
                  name,
                  baseURL: baseURL ?? ep?.baseURL ?? cfg.baseURL,
                  apiKey: apiKey ?? ep?.apiKey ?? cfg.apiKey,
                  userAgent: ep?.userAgent ?? cfg.userAgent,
                },
                apiKey ?? ep?.apiKey ?? cfg.apiKey ?? ''
              );
              runOpts.modelRuntime = { client, model: name };
            }
            if (efforts) runOpts.reasoningEffortOptions = efforts;
            if (effort) runOpts.reasoningEffort = effort;
          }
        }
        // —— providers 分组动作（settings-providers-spec）：一个端点配置多个模型 ——
        // provider 级新建/更新（共享 baseURL/apiKey/userAgent）
        if (body.providerConfig && typeof body.providerConfig === 'object') {
          const pc = body.providerConfig as Record<string, unknown>;
          const provider = typeof pc.provider === 'string' ? pc.provider.trim() : '';
          if (!provider) { json(res, 400, { error: '缺少 provider 名称' }); return; }
          const baseURL = typeof pc.baseURL === 'string' && pc.baseURL.trim() ? pc.baseURL.trim() : undefined;
          const apiKey = typeof pc.apiKey === 'string' && pc.apiKey.trim() ? pc.apiKey.trim() : undefined;
          const userAgent = typeof pc.userAgent === 'string' && pc.userAgent.trim() ? pc.userAgent.trim() : undefined;
          const pr = persistProviderConfigToGlobal({ provider, baseURL, apiKey, userAgent }, cfg);
          if (!pr.ok) { json(res, 400, { error: pr.message }); return; }
          syncProviderFields(provider, { baseURL, apiKey, userAgent });
          syncCfgProvider(provider, (p) => ({ ...(p ?? {}), ...(baseURL ? { baseURL } : {}), ...(apiKey ? { apiKey } : {}), ...(userAgent ? { userAgent } : {}) }));
        }
        // 组内模型新增/更新（含继承/覆盖开关、元数据）
        if (body.providerModel && typeof body.providerModel === 'object') {
          const pm = body.providerModel as Record<string, unknown>;
          const provider = typeof pm.provider === 'string' ? pm.provider.trim() : '';
          const modelName = typeof pm.modelName === 'string' ? pm.modelName.trim() : '';
          if (!provider || !modelName) { json(res, 400, { error: '缺少 provider 或模型名' }); return; }
          const apiModel = typeof pm.apiModel === 'string' && pm.apiModel.trim() ? pm.apiModel.trim() : undefined;
          const displayName = typeof pm.displayName === 'string' && pm.displayName.trim() ? pm.displayName.trim() : undefined;
          const efforts = Array.isArray(pm.reasoningEffortOptions)
            ? (pm.reasoningEffortOptions as unknown[]).map(String).filter((x) => x.trim())
            : undefined;
          const effort = typeof pm.reasoningEffort === 'string' && pm.reasoningEffort.trim() ? pm.reasoningEffort.trim() : undefined;
          const ctxLimit = typeof pm.contextLimit === 'number' && pm.contextLimit > 0 ? Math.floor(pm.contextLimit) : undefined;
          const overrideBaseURL = typeof pm.overrideBaseURL === 'string' && pm.overrideBaseURL.trim() ? pm.overrideBaseURL.trim() : undefined;
          const overrideApiKey = typeof pm.overrideApiKey === 'string' && pm.overrideApiKey.trim() ? pm.overrideApiKey.trim() : undefined;
          const pr = persistProviderModelToGlobal(
            { provider, modelName, apiModel, displayName, reasoningEffortOptions: efforts, reasoningEffort: effort, contextLimit: ctxLimit, overrideBaseURL, overrideApiKey },
            cfg
          );
          if (!pr.ok) { json(res, 400, { error: pr.message }); return; }
          // 运行时：加入扁平表（继承端点 → 从 provider 取；覆盖 → 用模型级）
          const p = runOpts.cfg?.providers?.[provider];
          const entry: Record<string, unknown> = {
            provider,
            ...(overrideBaseURL ? { baseURL: overrideBaseURL } : p?.baseURL ? { baseURL: p.baseURL } : {}),
            ...(overrideApiKey ? { apiKey: overrideApiKey } : p?.apiKey ? { apiKey: p.apiKey } : {}),
            ...(p?.userAgent ? { userAgent: p.userAgent } : {}),
            ...(apiModel ? { apiModel } : {}),
            ...(displayName ? { displayName } : {}),
            ...(efforts ? { reasoningEffortOptions: efforts } : {}),
            ...(effort ? { reasoningEffort: effort } : {}),
            ...(ctxLimit ? { limit: { context: ctxLimit } } : {}),
          };
          const key = addProviderModelToRunOpts(provider, modelName, entry);
          if ((runOpts.modelRuntime?.model ?? '') === key && (overrideBaseURL !== undefined || overrideApiKey !== undefined)) {
            rebuildRuntimeFor(key);
          }
          // 镜像到 runOpts.cfg.providers（buildStatus 数据源）
          syncCfgProvider(provider, (p) => {
            const cur = { ...(p ?? {}) } as Record<string, unknown>;
            const models = (cur.models && typeof cur.models === 'object' && !Array.isArray(cur.models)
              ? { ...(cur.models as Record<string, unknown>) } : {}) as Record<string, unknown>;
            const me = (models[modelName] && typeof models[modelName] === 'object' && !Array.isArray(models[modelName])
              ? { ...(models[modelName] as Record<string, unknown>) } : {}) as Record<string, unknown>;
            if (apiModel !== undefined) me.apiModel = apiModel;
            if (displayName !== undefined) me.displayName = displayName;
            if (efforts !== undefined) me.reasoningEffortOptions = efforts;
            if (effort !== undefined) me.reasoningEffort = effort;
            if (ctxLimit !== undefined) me.limit = { context: ctxLimit };
            if (overrideBaseURL !== undefined) me.baseURL = overrideBaseURL;
            else delete me.baseURL;
            if (overrideApiKey !== undefined) me.apiKey = overrideApiKey;
            else delete me.apiKey;
            models[modelName] = me;
            cur.models = models;
            return cur;
          });
        }
        // 删除 provider（无 modelName）或组内模型
        if (body.providerRemove && typeof body.providerRemove === 'object') {
          const pr = body.providerRemove as Record<string, unknown>;
          const provider = typeof pr.provider === 'string' ? pr.provider.trim() : '';
          if (!provider) { json(res, 400, { error: '缺少 provider 名称' }); return; }
          const modelName = typeof pr.modelName === 'string' && pr.modelName.trim() ? pr.modelName.trim() : undefined;
          const rem = modelName
            ? removeProviderModelFromGlobal(provider, modelName, cfg)
            : removeProviderFromGlobal(provider, cfg);
          if (!rem.ok) { json(res, 400, { error: rem.message }); return; }
          removeProviderFromRunOpts(provider, modelName);
          syncCfgProvider(provider, (p) => {
            if (!p) return p ?? null;
            if (modelName) {
              const models = { ...((p.models ?? {}) as Record<string, unknown>) } as Record<string, unknown>;
              delete models[modelName];
              p.models = models;
              return p;
            }
            return null; // 删整个 provider
          });
        }
        // 扁平模型迁入 provider（D3：UI 检测同端点后确认触发）
        if (body.providerMigrate && typeof body.providerMigrate === 'object') {
          const pm = body.providerMigrate as Record<string, unknown>;
          const modelName = typeof pm.modelName === 'string' ? pm.modelName.trim() : '';
          const provider = typeof pm.provider === 'string' ? pm.provider.trim() : '';
          if (!modelName || !provider) { json(res, 400, { error: '缺少模型名或 provider' }); return; }
          const mig = migrateFlatModelToGlobal({ modelName, provider }, cfg);
          if (!mig.ok) { json(res, 400, { error: mig.message }); return; }
          // 运行时：扁平条目转为 provider 组条目
          if (runOpts.models) {
            const p = runOpts.cfg?.providers?.[provider];
            const idx = runOpts.models.findIndex((m) => m.name === modelName && !m.provider);
            if (idx >= 0) {
              const flat = runOpts.models[idx];
              runOpts.models[idx] = {
                ...flat,
                name: modelName,
                provider,
                ...(p?.baseURL ? { baseURL: p.baseURL } : {}),
                ...(p?.apiKey ? { apiKey: p.apiKey } : {}),
                ...(p?.userAgent ? { userAgent: p.userAgent } : {}),
              } as never;
            }
            if ((runOpts.modelRuntime?.model ?? '') === modelName) rebuildRuntimeFor(modelName);
          }
          syncCfgProvider(provider, (p) => {
            const cur = { ...(p ?? {}) } as Record<string, unknown>;
            const models = (cur.models ?? {}) as Record<string, unknown>;
            models[modelName] = {};
            cur.models = models;
            return cur;
          });
        }
        // 设为默认模型（D7）：写顶层 model + 运行时切换
        if (body.setDefaultModel && typeof body.setDefaultModel === 'object') {
          const sdm = body.setDefaultModel as Record<string, unknown>;
          const model = typeof sdm.model === 'string' && sdm.model.trim() ? sdm.model.trim() : '';
          if (!model) { json(res, 400, { error: '缺少模型名' }); return; }
          if (!(runOpts.models ?? []).some((m) => m.name === model)) { json(res, 400, { error: `未知模型：${model}` }); return; }
          persistModelDefaultToGlobal(model);
          if (!(await switchModel(model))) { json(res, 400, { error: `切换失败：${model}` }); return; }
        }
        // 获取远端可用模型列表（GET {baseURL}/models；配置完 baseURL+key 后点「获取模型列表」）
        if (body.providerDiscover && typeof body.providerDiscover === 'object') {
          const pd = body.providerDiscover as Record<string, unknown>;
          const baseURL = typeof pd.baseURL === 'string' && pd.baseURL.trim() ? pd.baseURL.trim() : undefined;
          const apiKey = typeof pd.apiKey === 'string' && pd.apiKey.trim() ? pd.apiKey.trim() : undefined;
          if (!baseURL) { json(res, 400, { error: '缺少 baseURL' }); return; }
          try {
            const { discoverModels } = await import('../client.js');
            const ids = await discoverModels({ baseURL, apiKey });
            json(res, 200, { models: ids });
            return;
          } catch (err) {
            json(res, 400, { error: `获取模型列表失败：${(err as Error)?.message ?? err}` });
            return;
          }
        }
        void broadcast('status', await buildStatus(runOpts));
        json(res, 200, await buildStatus(runOpts));
        return;
      }

      if (p === '/api/workspace' && req.method === 'POST') {
        const body = await readBody(req);
        const dir = typeof body.dir === 'string' ? body.dir.trim() : '';
        if (runs.size > 0) {
          json(res, 409, { error: '有会话正在运行（多会话并发下切换工作区会影响所有运行），请先取消全部任务' });
          return;
        }
        if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) {
          json(res, 400, { error: '目录不存在或不是文件夹' });
          return;
        }
        // 切换工作目录（chdir + 重建 ctx/runOpts），失败回滚并报错
        try {
          await switchWorkspaceInternal(dir);
        } catch (e) {
          json(res, 400, { error: `切换工作目录失败：${e instanceof Error ? e.message : String(e)}` });
          return;
        }
        broadcast('workspace.changed', { cwd: process.cwd() });
        void broadcast('status', await buildStatus(runOpts));
        // 持久化到全局配置（webWorkspace 字段）——下次启动 web/Electron 自动应用
        const persistRes = persistWebWorkspaceToConfig(dir);
        json(res, 200, { cwd: process.cwd(), persisted: persistRes.ok, persistMessage: persistRes.message });
        return;
      }

      if (p === '/api/workspace/remove' && req.method === 'POST') {
        // 移除工作区：从持久化清单去掉 + 删除该工作区的全部会话记录；
        // **绝不删除用户的项目目录本身**。若移除的是当前工作区，回退 home 并重建运行时。
        const body = await readBody(req);
        const dir = typeof body.dir === 'string' ? body.dir.trim() : '';
        if (runs.size > 0) {
          json(res, 409, { error: '有会话正在运行，请先取消' });
          return;
        }
        if (!dir) {
          json(res, 400, { error: '缺少 dir' });
          return;
        }
        const target = path.resolve(dir);
        const persistRes = removeWebWorkspaceFromConfig(target);
        cfg.webWorkspaces = persistRes.workspaces;
        // 删除该工作区的全部会话文件 + 内存映射
        const deletedIds = new Set<string>();
        try {
          const sdir = sessionsDir();
          if (existsSync(sdir)) {
            for (const f of readdirSync(sdir)) {
              if (!f.endsWith('.jsonl')) continue;
              const fp = path.join(sdir, f);
              const loaded = await loadSession(fp).catch(() => null);
              if (!loaded) continue;
              if (path.resolve(loaded.meta.project || '') !== target) continue;
              await rm(fp, { force: true }).catch(() => {});
              deletedIds.add(sessionIdFromPath(fp));
            }
          }
        } catch {
          // 尽力而为
        }
        for (const id of deletedIds) sessions.delete(id);
        // 移除的是当前工作区 → 回退 home 并重建运行时（复用 workspace 切换流程）
        let switched = false;
        if (path.resolve(process.cwd()) === target) {
          try {
            await switchWorkspaceInternal(os.homedir());
            switched = true;
          } catch (e) {
            json(res, 400, { error: `已从清单移除，但回退默认工作区失败：${e instanceof Error ? e.message : String(e)}` });
            return;
          }
        }
        broadcast('workspace.changed', { cwd: process.cwd() });
        void broadcast('status', await buildStatus(runOpts));
        json(res, 200, { ok: true, removedSessions: deletedIds.size, switched, cwd: process.cwd(), workspaces: cfg.webWorkspaces ?? [] });
        return;
      }

      if (p === '/api/fs/dirs' && req.method === 'GET') {
        // 列出目录下的子目录（供页面内文件夹浏览器使用；本机单用户服务，
        // Agent 本身已有全盘读写能力，列目录不构成额外风险）
        const q = url.searchParams.get('path') || process.cwd();
        const target = path.resolve(q);
        if (!existsSync(target) || !statSync(target).isDirectory()) {
          json(res, 400, { error: '目录不存在或不是文件夹' });
          return;
        }
        let dirs: string[] = [];
        try {
          for (const e of readdirSync(target, { withFileTypes: true })) {
            // 隐藏目录默认不显示（减少噪音；需要时仍可手动输入路径）
            if (e.isDirectory() && !e.name.startsWith('.')) dirs.push(e.name);
          }
        } catch {
          // 无权限等——返回空列表，「上级/选择此目录」仍可用
        }
        dirs.sort((a, b) => a.localeCompare(b));
        json(res, 200, { current: target, parent: path.dirname(target), dirs: dirs.slice(0, 500) });
        return;
      }

      if (p === '/api/git/checkout' && req.method === 'POST') {
        const body = await readBody(req);
        const branch = typeof body.branch === 'string' ? body.branch.trim() : '';
        const create = body.create === true;
        if (!branch || !/^[A-Za-z0-9._\-\/]+$/.test(branch)) {
          json(res, 400, { error: '分支名不合法' });
          return;
        }
        try {
          const cwd = process.cwd();
          if (create) execSync(`git checkout -b ${JSON.stringify(branch)}`, { cwd, encoding: 'utf8', timeout: 5000 });
          else execSync(`git checkout ${JSON.stringify(branch)}`, { cwd, encoding: 'utf8', timeout: 5000 });
          void broadcast('status', await buildStatus(runOpts));
          json(res, 200, { ok: true, branch });
        } catch (e) {
          json(res, 400, { error: `切换分支失败：${e instanceof Error ? e.message : String(e)}` });
        }
        return;
      }

      if (p === '/api/git/worktree' && req.method === 'POST') {
        const body = await readBody(req);
        const branch = typeof body.branch === 'string' ? body.branch.trim() : '';
        const worktreePath = typeof body.path === 'string' ? body.path.trim() : '';
        if (!branch || !/^[A-Za-z0-9._\-\/]+$/.test(branch)) {
          json(res, 400, { error: '分支名不合法' });
          return;
        }
        try {
          const cwd = process.cwd();
          // 在项目根目录的父目录下创建 worktree（如 omni-feat）
          const projectName = path.basename(cwd);
          const defaultPath = path.resolve(cwd, '..', `${projectName}-${branch.replace(/\//g, '-')}`);
          const targetPath = worktreePath || defaultPath;
          if (existsSync(targetPath)) {
            json(res, 400, { error: `目标路径已存在：${targetPath}` });
            return;
          }
          execSync(`git worktree add ${JSON.stringify(targetPath)} -b ${JSON.stringify(branch)}`, {
            cwd, encoding: 'utf8', timeout: 15000,
          });
          // 自动切换工作区到新 worktree（复用 workspace 切换流程）
          await switchWorkspaceInternal(targetPath);
          void broadcast('status', await buildStatus(runOpts));
          broadcast('workspace.changed', { cwd: process.cwd() });
          json(res, 200, { ok: true, branch, path: targetPath });
        } catch (e) {
          json(res, 400, { error: `创建工作树失败：${e instanceof Error ? e.message : String(e)}` });
        }
        return;
      }

      if (p === '/api/finalize' && req.method === 'POST') {
        // 退出时自动写入偏好到全局记忆（autoMemory）
        const body = await readBody(req).catch(() => ({}) as Record<string, any>);
        const sid = typeof body.sessionId === 'string' ? body.sessionId : null;
        const s = runs.size > 0 ? null : (sid ? sessions.get(sid) ?? null : null);
        try {
          if (s && s.messages.some((m) => m.role === 'user') && runOpts.context?.autoMemory !== false) {
            const client = runOpts.modelRuntime?.client;
            const model = runOpts.modelRuntime?.model ?? cfg.model;
            if (client) await maybeWriteGlobalMemory(client, model, s.messages).catch(() => {});
          }
          json(res, 200, { ok: true });
        } catch (e) {
          json(res, 400, { error: String(e) });
        }
        return;
      }

      if (p === '/api/command' && req.method === 'POST') {
        const body = await readBody(req);
        const cmd = typeof body.command === 'string' ? body.command.trim() : '';
        if (!cmd || !cmd.startsWith('/')) {
          json(res, 400, { error: '命令必须以 / 开头' });
          return;
        }
        if (runs.size > 0 && !body.background) {
          json(res, 409, { error: '有会话正在运行——轻量命令可加 background:true 直发' });
          return;
        }
        // 命令可带 sessionId（恢复/undo 等需要会话上下文的命令）；无则 null
        const sid = typeof body.sessionId === 'string' ? body.sessionId : null;
        const s = sid ? sessions.get(sid) ?? null : null;
        try {
          const result = await runSlashCommand(cmd, s);
          // 命令可能修改了运行时状态（如 /model /permission /plan）→ 广播最新状态
          void broadcast('status', await buildStatus(runOpts));
          json(res, 200, { ok: true, lines: result.lines });
        } catch (err) {
          json(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      /* ---------------- 检查点 / fork / 导出（按钮对齐 REST 面）---------------- */
      const cpMatch = sid ? p.match(new RegExp(`^/api/sessions/${sid}/checkpoints$`)) : null;
      if (cpMatch && req.method === 'GET') {
        const s0 = await ensureSession(sid!);
        const cps = await loadCheckpoints(s0.file ?? undefined);
        const out = [];
        for (const c of cps) {
          const diff = await checkpointDiffStats(c).catch(() => ({ add: 0, rem: 0, files: [] }));
          out.push({ index: c.index, time: c.time, userMessage: c.userMessage, files: c.files.length, diff });
        }
        json(res, 200, out);
        return;
      }
      const rwMatch = sid ? p.match(new RegExp(`^/api/sessions/${sid}/rewind$`)) : null;
      if (rwMatch && req.method === 'POST') {
        const body = await readBody(req);
        const n = Number(body.index);
        const s0 = await ensureSession(sid!);
        const cps = await loadCheckpoints(s0.file ?? undefined);
        const target = cps.find((c) => c.index === n);
        if (!target) {
          json(res, 400, { error: `检查点 #${body.index} 不存在` });
          return;
        }
        const results = await restoreCheckpoint(target).catch(() => ['恢复失败']);
        s0.messages.push({ role: 'system', content: `[已执行 /rewind] 工作区已回滚到检查点 #${n}。请勿再基于回滚前的文件内容操作。` });
        for (const l of listeners) l('meta.add', { sessionId: sid!, text: `已回滚到检查点 #${n}（${results.length} 个文件处理）` });
        json(res, 200, { ok: true, results });
        return;
      }
      const fkMatch = sid ? p.match(new RegExp(`^/api/sessions/${sid}/fork$`)) : null;
      if (fkMatch && req.method === 'POST') {
        const body = await readBody(req);
        const n = Number(body.n);
        const s0 = await ensureSession(sid!);
        if (!runOpts.sessionPath && !s0.file) {
          json(res, 400, { error: '当前会话未落盘，无法 fork' });
          return;
        }
        const file = await forkSession(s0.file ?? runOpts.sessionPath!, n, process.cwd(), runOpts.modelRuntime?.model ?? cfg.model);
        if (!file) {
          json(res, 400, { error: 'fork 失败（序号越界或会话文件不可读）' });
          return;
        }
        broadcast('session.created', { id: sessionIdFromPath(file), title: `${s0.title || '会话'}（分叉）` });
        json(res, 200, { ok: true, id: sessionIdFromPath(file) });
        return;
      }
      const exMatch = sid ? p.match(new RegExp(`^/api/sessions/${sid}/export$`)) : null;
      if (exMatch && req.method === 'GET') {
        const s0 = await ensureSession(sid!);
        const md = exportMarkdownOf(s0.messages, s0.title || s0.id);
        res.writeHead(200, {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': `attachment; filename="omni-${sid}.md"`,
        });
        res.end(md);
        return;
      }

      /* ---------------- MCP 管理（1.0 P1-5 + web 对齐 add/remove/login/install）---------------- */
      if (p === '/api/mcp' && req.method === 'POST') {
        const body = await readBody(req);
        const action = typeof body.action === 'string' ? body.action : '';
        try {
          if (action === 'reconnect') {
            closeMcpClients();
            const handles = await discoverMcpServers(runOpts.mcpServers);
            runOpts.mcpHandles = handles;
            runOpts.tools = [...(runOpts.baseTools ?? []), ...buildMcpTools(handles)];
            invalidateSessionRuntimes();
            json(res, 200, { ok: true, tools: runOpts.tools.length });
            return;
          }
          if (action === 'add') {
            const name2 = String(body.name ?? '').trim();
            if (!name2 || !/^[a-z][\w-]*$/i.test(name2)) throw new Error('服务器名不合法');
            let cfgNew: McpServerConfig | undefined;
            if (typeof body.url === 'string' && body.url.trim()) cfgNew = { url: body.url.trim() };
            else if (typeof body.command === 'string' && body.command.trim())
              cfgNew = { command: body.command.trim(), args: Array.isArray(body.args) ? body.args.map(String) : undefined };
            if (!cfgNew) throw new Error('需要 url 或 command 字段');
            const { persistMcpServerToConfig } = await import('../config/write.js');
            const pr = persistMcpServerToConfig(name2, cfgNew, cfg);
            runOpts.mcpServers = { ...(runOpts.mcpServers ?? {}), [name2]: cfgNew };
            closeMcpClients();
            const handles = await discoverMcpServers(runOpts.mcpServers);
            runOpts.mcpHandles = handles;
            runOpts.tools = [...(runOpts.baseTools ?? []), ...buildMcpTools(handles)];
            invalidateSessionRuntimes();
            json(res, 200, { ok: true, persistMessage: pr.message });
            return;
          }
          if (action === 'remove') {
            const name2 = String(body.name ?? '').trim();
            if (!name2) throw new Error('缺少 name');
            const { removeMcpServerFromConfig } = await import('../config/write.js');
            const pr = removeMcpServerFromConfig(name2, cfg);
            delete runOpts.mcpServers?.[name2];
            closeMcpClients();
            const handles = await discoverMcpServers(runOpts.mcpServers);
            runOpts.mcpHandles = handles;
            runOpts.tools = [...(runOpts.baseTools ?? []), ...buildMcpTools(handles)];
            invalidateSessionRuntimes();
            json(res, 200, { ok: true, persistMessage: pr.message });
            return;
          }
          if (action === 'install') {
            const id = String(body.id ?? '').trim();
            if (!id) throw new Error('缺少 registry id');
            const { installFromRegistry } = await import('../tools/mcp.js');
            const ir = await installFromRegistry(id);
            if (!ir.ok || !ir.config) {
              json(res, 400, { error: ir.message });
              return;
            }
            const name2 = String(body.name ?? id.split('/').pop() ?? id).replace(/[^\w.-]/g, '-').slice(0, 40) || 'mcp-server';
            const { persistMcpServerToConfig } = await import('../config/write.js');
            const pr = persistMcpServerToConfig(name2, ir.config, cfg);
            runOpts.mcpServers = { ...(runOpts.mcpServers ?? {}), [name2]: ir.config };
            closeMcpClients();
            const handles = await discoverMcpServers(runOpts.mcpServers);
            runOpts.mcpHandles = handles;
            runOpts.tools = [...(runOpts.baseTools ?? []), ...buildMcpTools(handles)];
            invalidateSessionRuntimes();
            json(res, 200, { ok: true, name: name2, message: ir.message, persistMessage: pr.message });
            return;
          }
          if (action === 'login') {
            const name2 = String(body.name ?? '').trim();
            const srv = runOpts.mcpServers?.[name2];
            if (!srv?.url) throw new Error('该服务器不是 HTTP 端点或不存在');
            const { oauthLogin } = await import('../tools/mcp-oauth.js');
            const token = await oauthLogin(new URL(srv.url).origin);
            json(res, 200, { ok: !!token, message: token ? 'OAuth 登录成功（token 已持久化）' : '登录未完成' });
            return;
          }
          json(res, 400, { error: `未知 action「${action}」（可选 reconnect/add/remove/install/login）` });
        } catch (err) {
          json(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      if (p === '/api/skills/create' && req.method === 'POST') {
        const body = await readBody(req);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const desc = typeof body.description === 'string' ? body.description.trim() : '';
        if (!name || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
          json(res, 400, { error: '技能名不合法（仅小写字母、数字、连字符，如 my-skill）' });
          return;
        }
        try {
          const skillsDir = path.join(process.cwd(), '.agents', 'skills', name);
          if (existsSync(skillsDir)) {
            json(res, 409, { error: `技能 ${name} 已存在` });
            return;
          }
          const { mkdirSync, writeFileSync } = await import('node:fs');
          mkdirSync(skillsDir, { recursive: true });
          const frontmatter = [
            '---',
            `name: ${name}`,
            `description: ${desc || name}`,
            '---',
            '',
            `# ${name}`,
            '',
            desc ? `${desc}\n` : '',
            '## 指令',
            '',
            '在此编写技能的详细指令...',
          ].join('\n');
          writeFileSync(path.join(skillsDir, 'SKILL.md'), frontmatter, 'utf8');
          json(res, 201, { ok: true, name, path: skillsDir });
        } catch (e) {
          json(res, 400, { error: `创建技能失败：${e instanceof Error ? e.message : String(e)}` });
        }
        return;
      }

      json(res, 404, { error: 'Not Found' });
    } catch (err) {
      const code = err instanceof NotFoundError ? 404 : 400;
      json(res, code, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 启动时清理历史空会话（仅 meta 行、0 条消息）：「新会话」懒创建上线前的
  // 遗留 + 各种中断残留——否则会话列表被空会话淹没。清理失败不阻塞启动。
  // 注意：0 字节文件 loadSession 解析不出 meta 返回 null，removeEmptySession
  // 不会删——这里对空白文件单独处理。
  try {
    const dir = sessionsDir();
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const fp = path.join(dir, f);
        try {
          if (statSync(fp).size === 0) {
            await rm(fp, { force: true });
            continue;
          }
        } catch {
          // stat 失败按原路径走
        }
        await removeEmptySession(fp);
      }
    }
  } catch {
    // 静默——清理是尽力而为
  }

  // 优雅退出：关连接、清 MCP 客户端
  const handleExit = (): void => {
    listeners.clear();
    server.close();
    const mcp = (runOpts as { mcpServers?: unknown }).mcpServers;
    if (mcp && typeof mcp === 'object' && Object.keys(mcp).length > 0) {
      void import('../tools/mcp.js').then((m) => m.closeMcpClients());
    }
  };
  process.once('SIGINT', () => {
    handleExit();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    handleExit();
    process.exit(0);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  return server;
}
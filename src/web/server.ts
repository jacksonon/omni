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
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

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
import { applyUndo } from '../tools/undo.js';
import { closeMcpClients, discoverMcpTools } from '../tools/mcp.js';
import type { RunContext } from '../main.js';
import { attachRuntime, prepareRun } from '../main.js';
import type { ConfigOverrides, OmniConfig } from '../config/index.js';
import { maybeWriteGlobalMemory } from '../agent/memory.js';
import {
  parseModelAddArgs,
  persistModelDefaultToConfig,
  persistModelToConfig,
  persistReasoningEffortToConfig,
  persistWebWorkspaceToConfig,
  removeWebWorkspaceFromConfig,
} from '../config/write.js';
import type { PermissionTier } from '../safety/policy.js';
import type { ApprovalRequest } from '../safety/index.js';
import type { AskResult } from '../tools/ask.js';
import { VERSION } from '../version.js';
import { WEB_ASSETS } from './assets.js';
import type { WebBroadcast } from './events.js';
import { type PendingApproval, type PendingAsk, WebOutput } from './output.js';

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

/* ---------------- 会话存储与运行管理 ---------------- */
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
}

const sessions = new Map<string, WebSession>();
const listeners = new Set<WebBroadcast>();
const approvals = new Map<string, PendingApproval>();
const asks = new Map<string, PendingAsk>();
let running: RunningRun | null = null;

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

/** 生成会话标题（fire-and-forget）：首轮对话后异步调用，写入 meta + 广播 */
function maybeAutoTitle(s: WebSession, client: OpenAI, model: string): void {
  if (s.title) return;
  const hasAnswer = s.messages.some((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content);
  if (!hasAnswer) return;
  void generateSessionTitle(client, model, s.messages)
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

/* ---------------- git 快照（分支 / 脏文件数 / 分支列表，供输入区上下文条展示） ---------------- */
function getGitInfo(cwd: string): { gitBranch?: string; gitDirty?: number; gitBranches?: string[] } {
  try {
    if (!existsSync(path.join(cwd, '.git')) && !existsSync(path.join(cwd, '..', '.git'))) {
      // 向上最多两层查找 git 根，避免大量无 git 目录的开销；失败则直接返回
      execSync('git rev-parse --git-dir', { cwd, encoding: 'utf8', timeout: 1200, stdio: ['ignore', 'pipe', 'ignore'] });
    }
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf8', timeout: 1200, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!branch) return {};
    let dirty = 0;
    try {
      const st = execSync('git status --porcelain', { cwd, encoding: 'utf8', timeout: 1200, stdio: ['ignore', 'pipe', 'ignore'] });
      dirty = st.split('\n').filter((l) => l.trim()).length;
    } catch {}
    let branches: string[] = [];
    try {
      const out = execSync('git branch --format="%(refname:short)"', { cwd, encoding: 'utf8', timeout: 1200, stdio: ['ignore', 'pipe', 'ignore'] });
      branches = out.split('\n').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
    } catch {}
    return { gitBranch: branch, gitDirty: dirty, gitBranches: branches.length ? branches : [branch] };
  } catch {
    return {};
  }
}

/* ---------------- 状态快照 ---------------- */
function buildStatus(runOpts: RunContext['runOpts']): Record<string, unknown> {
  const git = getGitInfo(process.cwd());
  return {
    version: VERSION,
    cwd: process.cwd(),
    model: runOpts.modelRuntime?.model ?? '',
    models: runOpts.models ?? [],
    permission: runOpts.permission ?? 'safe',
    planMode: runOpts.planMode ?? false,
    reasoningEffort: runOpts.reasoningEffort ?? undefined,
    reasoningEffortOptions: runOpts.reasoningEffortOptions ?? undefined,
    running: running !== null,
    runningSession: running?.sessionId ?? null,
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

  const broadcast: WebBroadcast = (type, data) => {
    for (const l of listeners) {
      try {
        l(type, data);
      } catch {
        // 单个客户端异常不影响其它
      }
    }
  };

  /** steer 打断槽（模块级，供 POST /api/sessions/:id/steer 直接写入） */
  let interruptText: string | null = null;

  /** 发送消息 → 启动一轮 Agent 运行（后台执行，事件经 SSE 推送） */
  async function sendMessage(sessionId: string, text: string): Promise<{ error?: string }> {
    const s = sessions.get(sessionId);
    if (!s) return { error: '会话不存在' };
    if (running) {
      return { error: running.sessionId === sessionId ? '当前会话正在运行，可点击「取消」' : '其它会话正在运行，请等待完成' };
    }
    if (!text.trim()) return { error: '消息为空' };

    const controller = new AbortController();
    running = { sessionId, controller };
    s.updated = Date.now();

    // 指向当前会话的持久化与轨迹
    runOpts.sessionPath = s.file ?? undefined;
    runOpts.events = await EventRecorder.open(s.file ?? null);
    runOpts.abortSignal = controller.signal;
    runOpts.takeInterrupt = undefined;
    runOpts.rearmAbort = undefined;
    runOpts.interruptPending = undefined;
    interruptText = null;
    // steer 打断槽：前端 POST /api/sessions/:id/steer → 写入 interruptText + abort
    // loop 在流中/工具中 abort 后取走 interruptText，插入同一轮继续
    runOpts.takeInterrupt = () => {
      const t = interruptText;
      interruptText = null;
      return t;
    };
    runOpts.interruptPending = () => interruptText !== null;
    runOpts.rearmAbort = () => {
      const newController = new AbortController();
      running = { sessionId, controller: newController };
      runOpts.abortSignal = newController.signal;
    };

    const output = new WebOutput(sessionId, broadcast, pendingRegistry);
    currentOutput = output;

    // 广播运行状态（客户端据此禁用其它会话的发送框 / 显示取消按钮）
    broadcast('status', buildStatus(runOpts));

    // Hooks：UserPromptSubmit——hook 返回 updatedPrompt 可改写 prompt
    let prompt = text;
    if (runOpts.hooks?.has('UserPromptSubmit')) {
      try {
        prompt = (await runOpts.hooks.userPromptSubmit(text)).prompt;
      } catch {
        prompt = text;
      }
    }

    s.messages.push({ role: 'user', content: prompt });
    output.onUserMessage(prompt);

    // 后台运行：事件流经 broadcast 推给客户端，REST 路由立即返回 202
    void (async () => {
      const client = runOpts.modelRuntime!.client;
      const model = runOpts.modelRuntime!.model;
      try {
        await prepareContext(client, model, s.messages, runOpts.context ?? {}, runOpts.events);
        await runAgent(client, model, s.messages, runOpts, output);
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
        if (runOpts.events) await runOpts.events.flush().catch(() => {});
        if (s.file) await finalizeSession(s.file).catch(() => {});

        // 运行结束后自动生成标题（首轮）
        maybeAutoTitle(s, runOpts.modelRuntime!.client, runOpts.modelRuntime!.model);

        const reason = lastRunReason(runOpts.events);
        currentOutput = null;
        running = null;
        broadcast('run.end', { sessionId, reason });
        broadcast('status', buildStatus(runOpts));
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
    } catch {
      return false;
    }
    broadcast('status', buildStatus(runOpts));
    return true;
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
      await attachRuntime(newCtx, routingOutput as unknown as import('../output/types.js').Output);
      ctx.cfg = newCtx.cfg;
      Object.assign(runOpts, newCtx.runOpts);
      cfg = newCtx.cfg;
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
      add('可用命令：/status /context /export /config /diff /doctor /trace /agents');
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
      // /thinking：全局切换思考块显示模式（展开/折叠）
      const ctx = runOpts.context as Record<string, unknown>;
      const thinkingHidden = ctx.thinkingHidden ?? false;
      ctx.thinkingHidden = !thinkingHidden;
      // 广播状态让前端同步
      for (const l of listeners) l('thinking.toggle', { sessionId: s?.id ?? null, hidden: !thinkingHidden });
      add(thinkingHidden ? '已展开全部思考过程。' : '已折叠全部思考过程（点击可展开单条）。');
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
      const stack = runOpts.undoStack;
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
      const stack = runOpts.undoStack;
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

    if (cmd === '/diff') {
      add('正在收集 git diff…');
      const d = await collectDiff();
      if (!d.ok) add(`无法获取 git diff：${d.output.slice(0, 200)}`);
      else if (d.output === '（无改动）') add('工作区没有未提交的改动');
      else {
        const dlines = d.output.split('\n');
        add(`git diff（${dlines.length} 行，前 60 行）：`);
        for (const l of dlines.slice(0, 60)) add(l);
        if (dlines.length > 60) add(`… 还有 ${dlines.length - 60} 行`);
      }
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
      if (names.length === 0) { add('未配置 MCP 服务器（配置文件 mcpServers 字段）'); return { lines }; }
      const mcpToolNames = (runOpts.tools ?? []).filter((t) => names.some((n) => t.name.startsWith(n.replace(/[^a-z0-9_]/gi, '_').toLowerCase() + '_')));
      add(`已配置 ${names.length} 个服务器：${names.join('、')} · 工具：${mcpToolNames.length > 0 ? mcpToolNames.map((t) => t.name).join('、') : '（无）'}`);
      if (/(?:^|\s)reconnect(?=\s|$)/.test(cmd)) {
        add('正在重连 MCP…');
        closeMcpClients();
        const mcp = await discoverMcpTools(runOpts.mcpServers);
        runOpts.tools = [...(runOpts.baseTools ?? []), ...mcp];
        add(`已重连（当前 ${runOpts.tools.length} 个工具）`);
      } else { add('用 /mcp reconnect 重连。'); }
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

    if (cmd === '/resume' || cmd.startsWith('/resume ')) {
      const arg = cmd.slice('/resume'.length).trim();
      if (!arg) { const list = await listSessions(); add(`已保存 ${list.length} 个会话（/resume <id> 恢复）：`); for (const x of list.slice(0, 15)) add(`· ${x.id} — ${x.title || '（无标题）'}（${x.messages} 条）`); }
      else { const cands = await findSessionCandidates(arg); if (cands.length === 0) add(`会话「${arg}」不存在`); else add(`已找到会话 ${cands[0].id}——侧栏点击恢复。`); }
      return { lines };
    }

    if (cmd === '/variants' || cmd.startsWith('/variants ')) {
      const opts = runOpts.reasoningEffortOptions ?? ['low', 'medium', 'high'];
      const want = cmd.slice('/variants'.length).trim();
      if (!want) { add(`当前思考级别：${runOpts.reasoningEffort ?? '（未设置）'}（可选：${opts.join(' / ')}）`); }
      else if (!opts.includes(want)) { add(`未知思考级别「${want}」——可选：${opts.join(' / ')}`); }
      else {
        runOpts.reasoningEffort = want;
        add(`已切换思考级别 → ${want}`);
        const res = persistReasoningEffortToConfig(want, cfg, model);
        add(res.message);
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
        json(res, 200, buildStatus(runOpts));
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
          const err = await sendMessage(sid, typeof body.text === 'string' ? body.text : '');
          if (err.error) {
            json(res, 409, err);
            return;
          }
          json(res, 202, { ok: true });
          return;
        }
        if (p === sessionPath('cancel') && req.method === 'POST') {
          if (running && running.sessionId === sid) running.controller.abort();
          json(res, 200, { ok: true });
          return;
        }
        if (p === sessionPath('steer') && req.method === 'POST') {
          // steer 打断：写入 interruptText + abort → loop 在流中断后取走消息插入同一轮
          if (!running || running.sessionId !== sid) {
            json(res, 409, { error: '当前会话未在运行' });
            return;
          }
          const body = await readBody(req);
          const text = typeof body.text === 'string' ? body.text.trim() : '';
          if (!text) { json(res, 400, { error: '消息为空' }); return; }
          // 直接写入中断槽 + abort（runOpts.interruptPending 是只读探测，不能传参）
          interruptText = text;
          running.controller.abort();
          // 广播用户消息（前端立即显示打断消息）
          broadcast('user.message', { sessionId: sid, text, steer: true });
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
          if (running && running.sessionId === sid) {
            json(res, 409, { error: '会话正在运行，请先取消' });
            return;
          }
          if (s.file) await rm(s.file, { force: true }).catch(() => {});
          sessions.delete(sid);
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
        broadcast('status', buildStatus(runOpts));
        json(res, 200, buildStatus(runOpts));
        return;
      }

      if (p === '/api/workspace' && req.method === 'POST') {
        const body = await readBody(req);
        const dir = typeof body.dir === 'string' ? body.dir.trim() : '';
        if (running) {
          json(res, 409, { error: '当前有任务运行中，请先取消' });
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
        broadcast('status', buildStatus(runOpts));
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
        if (running) {
          json(res, 409, { error: '当前有任务运行中，请先取消' });
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
        broadcast('status', buildStatus(runOpts));
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
          broadcast('status', buildStatus(runOpts));
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
          broadcast('status', buildStatus(runOpts));
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
        const s = running ? null : (sid ? sessions.get(sid) ?? null : null);
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
        if (running && !body.background) {
          json(res, 409, { error: '当前有任务运行中，请先取消' });
          return;
        }
        // 命令可带 sessionId（恢复/undo 等需要会话上下文的命令）；无则 null
        const sid = typeof body.sessionId === 'string' ? body.sessionId : null;
        const s = sid ? sessions.get(sid) ?? null : null;
        try {
          const result = await runSlashCommand(cmd, s);
          // 命令可能修改了运行时状态（如 /model /permission /plan）→ 广播最新状态
          broadcast('status', buildStatus(runOpts));
          json(res, 200, { ok: true, lines: result.lines });
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
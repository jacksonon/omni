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
import { existsSync, readFileSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import { createClient } from '../client.js';
import { prepareContext } from '../agent/context.js';
import { runAgent } from '../agent/loop.js';
import { EventRecorder } from '../agent/events.js';
import { generateSessionTitle } from '../agent/title.js';
import {
  appendSessionMessages,
  createSession,
  finalizeSession,
  findSessionById,
  isPersistable,
  listSessions,
  loadSession,
  persistableMessages,
  sessionIdFromPath,
  updateSessionTitle,
} from '../agent/session.js';
import type { RunContext } from '../main.js';
import { attachRuntime, prepareRun } from '../main.js';
import type { ConfigOverrides } from '../config/index.js';
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
  void generateSessionTitle(client, model, s.messages).then((title) => {
    if (!title || s.title) return;
    s.title = title;
    if (s.file) void updateSessionTitle(s.file, title);
    for (const l of listeners) l('title', { sessionId: s.id, title });
  });
}

/* ---------------- 状态快照 ---------------- */
function buildStatus(runOpts: RunContext['runOpts']): Record<string, unknown> {
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

  async function listWebSessions(): Promise<
    Array<{ id: string; title: string; messages: number; created: number; updated: number; project?: string }>
  > {
    const persisted = await listSessions();
    const out = persisted.map((s) => {
      const live = sessions.get(s.id);
      return {
        id: s.id,
        title: s.title ?? '',
        messages: live ? live.messages.length : s.messages,
        created: s.created,
        updated: live ? live.updated : s.updated,
        project: s.project,
      };
    });
    // 内存中尚未落盘会话（防御性兜底——创建即落盘，正常不会出现）
    for (const s of sessions.values()) {
      if (!out.some((o) => o.id === s.id)) {
        out.push({ id: s.id, title: s.title, messages: s.messages.length, created: s.created, updated: s.updated, project: process.cwd() });
      }
    }
    return out.sort((a, b) => b.updated - a.updated);
  }

  /** 取会话消息（过滤脚手架 system；供客户端刷历史/重连恢复） */
  async function sessionMessages(
    sessionId: string
  ): Promise<{ meta: { title: string | null } | null; messages: ChatCompletionMessageParam[] }> {
    const s = sessions.get(sessionId);
    if (!s) throw new NotFoundError(`会话不存在：${sessionId}`);
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
        // 切换工作目录：chdir + 重建 ctx/runOpts（配置从新目录向上重新发现，
        // 新会话以新目录为工作区；已存在的会话保留）。失败则回滚 chdir 并报错。
        let prev = '';
        try {
          prev = process.cwd();
          process.chdir(dir);
          const newCtx = prepareRun(overrides);
          // 关闭旧运行时的 MCP 客户端（子进程），再重建——否则每次切换都泄漏一批 MCP server 进程
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
          json(res, 400, { error: `切换工作目录失败：${e instanceof Error ? e.message : String(e)}` });
          return;
        }
        broadcast('workspace.changed', { cwd: process.cwd() });
        broadcast('status', buildStatus(runOpts));
        json(res, 200, { cwd: process.cwd() });
        return;
      }

      json(res, 404, { error: 'Not Found' });
    } catch (err) {
      const code = err instanceof NotFoundError ? 404 : 400;
      json(res, code, { error: err instanceof Error ? err.message : String(err) });
    }
  });

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
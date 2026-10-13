/**
 * omni web 本地后端的运行状态快照 / git 快照 / 自动标题（从 server.ts 抽出）：
 * 均为读取共享运行态（state.ts 的 runs/listeners）的辅助逻辑，不持有独立状态。
 */
import type OpenAI from 'openai';
import { VERSION } from '../version.js';
import { STATUSLINE_DEFAULT } from '../tui/layout.js';
import { resolveContextLimit } from '../config/model-context.js';
import type { RunContext } from '../main.js';
import { generateSessionTitle } from '../agent/title.js';
import { updateSessionTitle } from '../agent/session.js';
import type { EventRecorder } from '../agent/events.js';
import { runs, listeners, type WebSession } from './state.js';

/** 兼容别名：全局是否至少有一个会话在跑 */
export function anyRunning(): boolean {
  return runs.size > 0;
}

/** 从 EventRecorder 取本轮结束原因（completed / aborted / error / max-steps） */
export function lastRunReason(recorder?: EventRecorder): string {
  const evs = recorder?.events ?? [];
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e.k === 'turn/end') return (e as unknown as { reason: string }).reason ?? 'completed';
  }
  return 'completed';
}

/** 生成会话标题（fire-and-forget）：首轮对话后异步调用，写入 meta + 广播。
 *  语言跟随配置 language（第十二节 P2 标题本地化）。 */
export function maybeAutoTitle(s: WebSession, client: OpenAI, model: string, lang: 'zh' | 'en' = 'zh'): void {
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
export async function getGitInfo(cwd: string): Promise<Record<string, unknown>> {
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

/** 下发 providers 分组结构（设置面板「模型配置」渲染，Doc/specs/settings-providers-spec.md）：
 *  cfg.providers 逐组展开——端点/密钥只认 providers 分组（旧版扁平 models 表已移除）。 */
export function buildProvidersStatus(runOpts: RunContext['runOpts']): unknown[] {
  const out: Record<string, unknown>[] = [];
  for (const [name, p] of Object.entries(runOpts.cfg?.providers ?? {})) {
    out.push({
      name,
      baseURL: p.baseURL,
      apiKey: p.apiKey,
      userAgent: p.userAgent,
      // 自定义请求头（分组级；值可含 {sessionId} 占位符，请求时解析）
      headers: p.headers,
      // 远端模型目录缓存（"获取模型列表" 结果；未拉取过 = undefined，前端据此显示「获取/刷新」）
      modelCatalog: p.modelCatalog,
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
  return out;
}

export async function buildStatus(runOpts: RunContext['runOpts']): Promise<Record<string, unknown>> {
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
    // 生效上下文窗口（手动覆盖（/context <档位>）优先，否则当前模型 limit.context；composer 用量环与压缩分母同源）
    contextLimit: resolveContextLimit(runOpts.cfg?.contextLimit, (runOpts.models ?? []).find((m) => m.name === runOpts.modelRuntime?.model)?.limit?.context),
    contextOverride: typeof runOpts.cfg?.contextLimit === 'number' && (runOpts.cfg?.contextLimit ?? 0) > 0,
    webTheme: runOpts.cfg?.webTheme ?? 'system',
    language: runOpts.cfg?.language ?? 'zh',
    // 输入区下方状态行段（设置 → 状态栏配置；同 CLI/TUI footer stats）
    statusline: Array.isArray(runOpts.cfg?.statusline) ? runOpts.cfg!.statusline : STATUSLINE_DEFAULT,
    // 1.0 P0-2 多会话并发：running = 是否存在任一运行；runningSessions = 全部运行中的会话 id
    running: runs.size > 0,
    runningSession: [...runs.keys()][0] ?? null,
    runningSessions: [...runs.keys()],
    concurrency: runOpts.cfg?.webConcurrency ?? 3,
    // AI 自动审批开关（2026-09 补课）：设置面板勾选初始态
    autoReview: runOpts.cfg?.autoReview === true,
    // 成本展示开关：Web 状态行/回合统计是否显示价格（默认开）
    showCost: runOpts.cfg?.showCost !== false,
    tools: runOpts.tools?.map((t) => t.name) ?? [],
    // 已知工作区列表（设置面板一键切换用）
    workspaces: runOpts.cfg?.webWorkspaces ?? [],
    ...git,
  };
}
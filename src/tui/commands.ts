/**
 * Commands（/ 命令）框架：斜杠命令注册表 + 命令面板交互。
 *
 * 交互模式输入 `/xxx` 提交时，interactive.ts 调 runCommand 按命令名分发。
 * 带面板的命令（如 /permission、/settings 二级菜单）会打开一个圆角方框选项面板（state.menu）：
 * ↑/↓ 或数字键选择、Enter 确认、Esc 取消；面板打开时键盘事件由
 * handleMenuKey 消费（interactive.ts 在全局 keypress 里先于输入框拦截）。
 */
import type { TextareaRenderable } from '@opentui/core';
import path from 'node:path';
import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import {
  generateAgentsFile,
  generateGlobalAgentsFile,
  findProjectRoot,
  writeAgentsFile,
  writeGlobalAgentsFile,
} from '../agent/init.js';
import type { TuiOutput } from './output.js';
import type { TuiKey, TuiSession } from './render.js';
import type { PermissionTier } from '../safety/policy.js';
import { applyUndo, type UndoStack } from '../tools/undo.js';
import {
  checkpointDiffStats,
  checkpointSummaryLine,
  createCheckpoint,
  loadCheckpoint,
  loadCheckpoints,
  restoreCheckpoint,
} from '../agent/rewind.js';
import { truncateToWidth } from '../output/format.js';
import {
  discoverSkills,
  loadSkillContent,
  parseSkillFindResults,
  parseSkillFrontmatter,
  refreshSkillInjections,
  runSkillsCli,
} from '../agent/skill.js';
import { summarizeContext } from '../agent/context.js';
import { runGoal, runOrchestrate } from '../agent/orchestrate.js';
import { collectDiff, detectCheckCommand, reviewCode, captureCommand } from '../agent/review.js';
import {
  configReport,
  contextReport,
  detectScaffolds,
  doctorReport,
  exportSession,
  memoryFilesFromMessages,
  statusReport,
} from '../agent/report.js';
import {
  findSessionCandidates,
  listSessions,
  loadSession,
  sessionIdFromPath,
  updateSessionTitle,
  isPersistable as isPersistableSafe,
  type SessionInfo,
} from '../agent/session.js';
import { forkSession, sendSessionMessage } from '../agent/session-fork.js';
import { applyProjectMemoryPending } from '../agent/memory.js';
import type { McpServerConfig, McpServerHandle } from '../tools/mcp.js';
import { closeMcpClients, discoverMcpTools } from '../tools/mcp.js';
import type { OmniConfig } from '../config/index.js';
import { parseModelAddArgs, parseMcpAddArgs, persistMcpServerToConfig, removeMcpServerFromConfig, persistModelToConfig, persistStatuslineToConfig } from '../config/write.js';
import { autoFillLimit, describeModelContextWindow, refreshModelContextSnapshot, resolveReasoningEffortOptions, snapshotInfo } from '../config/model-context.js';
import { STATUSLINE_DEFAULT, STATUSLINE_SEGMENTS, type StatuslineSegment } from './layout.js';
import type { ModelEndpoint } from '../client.js';
import { EventRecorder } from '../agent/events.js';
import { refreshTrace } from './trace.js';
import { setTerminalTitle } from '../ui.js';
import { openCmdPanel, pushCmdLine, pushLine, type StatuslinePanel, type TuiLine, type TuiState, type TuiThemeMode } from './state.js';
import { t, tf, TUI_LANG_LABELS, TUI_LANGS } from './i18n.js';

/** 命令执行上下文（interactive.ts 组装） */
export interface TuiCommandContext {
  state: TuiState;
  out: TuiOutput;
  session: TuiSession;
  input: TextareaRenderable;
  messages: ChatCompletionMessageParam[];
  /** 需要 LLM 的命令（/init）使用；由 interactive.ts 传入 */
  client?: OpenAI;
  model?: string;
  /** 当前工具链（/agents 展示用；由 interactive.ts 从 runOpts 传入） */
  tools?: { name: string }[];
  /** 可用模型名列表（/model 面板列出；由 interactive.ts 从 runOpts.models 传入） */
  models?: string[];
  /** 命令名后的参数（如 `/init --global` 的 `--global`） */
  args?: string;
  /** 子代理最大循环步数（/agents 展示用；attachRuntime 注入 runOpts） */
  maxSubagentSteps?: number;
  /** 已发现的子代理定义（.agents/subagents/*.md；/agents 列表 /orchestrate --agents 用） */
  subagents?: import('../agent/subagent-defs.js').SubagentDef[];
  /** 子代理最大嵌套深度（/agents 展示用） */
  maxSubagentDepth?: number;
  /** architect/editor 模型路由（/agents 展示用；attachRuntime 注入 runOpts） */
  architectModel?: string;
  editorModel?: string;
  /**
   * 完整运行选项（/orchestrate /goal 用：worker 的安全闸/工具链/hooks/模型路由/轨迹
   * 记录器；由 interactive.ts 传入真实 runOpts）。
   */
  runOpts?: import('../agent/types.js').RunOptions;
  /** /undo 撤销栈（attachRuntime 创建，写入工具已包装快照；interactive 从 runOpts 传入） */
  undoStack?: UndoStack;
  /** 会话文件路径（/status 显示；interactive 从 runOpts.sessionPath 传入） */
  sessionPath?: string;
  /** 完整配置对象（/status /context /doctor /config 用；interactive 从 runOpts.cfg 传入） */
  cfg?: OmniConfig;
  /** MCP 服务器配置（/mcp 列出/重连；interactive 从 runOpts.mcpServers 传入） */
  mcpServers?: Record<string, McpServerConfig>;
  /** MCP 服务器发现句柄（/mcp resources/prompts 展示；interactive 从 runOpts.mcpHandles 传入） */
  mcpHandles?: import('../tools/mcp.js').McpServerHandle[];
  /**
   * /mcp 重连回调（interactive 组装）：closeMcpClients + 重新 discover + 重建 runOpts.tools
   * （命令只调它，具体装配在 interactive——它有 runOpts）。
   */
  onReconnectMcp?: () => Promise<void>;
  /**
   * /mcp add 回调（interactive 组装）：discover 新服务器 + 注入工具链 + 更新 mcpHandles，
   * 返回错误信息或 null（成功）。
   */
  onAddMcp?: (name: string, cfg: McpServerConfig) => Promise<string | null>;
  /**
   * /mcp remove 回调（interactive 组装）：关闭服务器 + 移除工具 + 更新 mcpHandles，
   * 返回错误信息或 null（成功）。
   */
  onRemoveMcp?: (name: string) => Promise<string | null>;
  /**
   * /mcp login 回调（interactive 组装）：对 HTTP 服务器执行 OAuth 登录，返回错误信息或 null（成功）。
   */
  onLoginMcp?: (name: string) => Promise<string | null>;
  /**
   * /resume 恢复回调（interactive 组装）：替换 messages + sessionPath + 重置 savedCount +
   * 把历史消息回放进对话流。命令负责加载会话文件，回调负责落地。
   */
  onResume?: (file: string, msgs: ChatCompletionMessageParam[]) => void;
  /**
   * /model <名称> 切换回调（interactive 组装）：按名称从 runOpts.models 找端点并切换
   * （重建 client + 更新 modelRuntime，主循环/子代理同步）。返回错误信息或 null。
   */
  onSwitchModel?: (name: string) => string | null;
  /**
   * /model add 回调（interactive 组装）：把新端点注册进运行时模型表（runOpts.models +
   * state.models）并切换。返回错误信息或 null。
   */
  onAddModel?: (endpoint: ModelEndpoint) => string | null;
  /**
   * 轨迹事件记录器（/trace 面板与 /compact 事件用；interactive 从 runOpts.events 传入）。
   * 面板数据源 = events.events（内存全量事件，含恢复的历史）。
   */
  events?: EventRecorder;
  /** Hooks 运行器（/clear 后 resetSessionStart；interactive 从 runOpts.hooks 传入） */
  hooks?: import('../hooks/index.js').HookRunner;
}

/**
 * 按 id（支持前缀）解析会话候选：唯一命中返回 SessionInfo；
 * 无命中 / 多个命中（歧义）时把提示与候选列表推入对话流并返回 null——
 * 不静默选一个，避免短前缀继续到错误的会话。
 */
async function resolveSessionCandidates(
  state: TuiState,
  id: string,
  sessionPath?: string | null
): Promise<SessionInfo | null> {
  // 排除当前正在进行的会话（它的占位文件会污染前缀匹配，e2e 抓到）
  const currentId = sessionPath ? sessionIdFromPath(sessionPath) : '';
  const cands = (await findSessionCandidates(id)).filter((c) => c.id !== currentId);
  if (cands.length === 0) {
    pushCmdLine(state, { kind: 'warn', text: `会话「${id}」不存在（/session 查看列表）` });
    return null;
  }
  if (cands.length > 1) {
    pushCmdLine(state, { kind: 'warn', text: `「${id}」匹配 ${cands.length} 个会话，请用完整 id 继续：` });
    for (const c of cands.slice(0, 9)) {
      pushCmdLine(state, { kind: 'meta', text: `· ${c.id} — ${c.title || '（无标题）'}（${c.messages} 条消息 · ${c.model}）` });
    }
    if (cands.length > 9) pushCmdLine(state, { kind: 'meta', text: `… 还有 ${cands.length - 9} 个` });
    return null;
  }
  return cands[0];
}

/** 命令执行结果：'exit' 表示退出交互循环（interactive.ts 据此 break） */
export type TuiCommandResult = 'exit' | void;

export interface TuiCommand {
  name: string;
  description: string;
  /** 英文描述（/settings 语言切换后联想列表按界面语言取 description/descriptionEn） */
  descriptionEn?: string;
  /** 额外别名（如 /quit） */
  aliases?: string[];
  /**
   * 执行型命令：run() 完成后面板短暂停留确认后**自动收起**（无需按 Esc）——
   * 适用于「做了某事 + 一句确认」的命令（/undo /init /rename 等）；
   * 需要阅读输出的列表型命令（/status /help /context /diff /review 等）不设此标记，面板保持打开。
   */
  autoClose?: boolean;
  run(ctx: TuiCommandContext): TuiCommandResult | Promise<TuiCommandResult>;
}

/**
 * 执行型命令完成后的面板自动收起：run() 返回后短暂停留（默认 1.5s，让确认可见）
 * 再自动关闭——用户无需按 Esc；期间任意按键也会立即收起（见 interactive.ts 面板按键处理）。
 * 以面板对象身份判断：期间打开新面板 / 手动关闭 → 定时器不误关（identity 不同即 no-op）。
 * session 可选：测试/无会话上下文（如快照里 session={}）时不调度，面板保持打开。
 */
let panelAutoCloseTimer: ReturnType<typeof setTimeout> | null = null;
export function scheduleCmdPanelAutoClose(
  state: TuiState,
  session?: { paint?: () => Promise<unknown> } | null,
  delayMs = 1500
): void {
  const panel = state.cmdPanel;
  if (!panel || panel.lines.length === 0) return;
  const paint = session?.paint;
  if (typeof paint !== 'function') return; // 测试/无会话上下文：不调度（面板保持）
  if (panelAutoCloseTimer) clearTimeout(panelAutoCloseTimer);
  panelAutoCloseTimer = setTimeout(() => {
    panelAutoCloseTimer = null;
    if (state.cmdPanel === panel) {
      state.cmdPanel = null;
      void Promise.resolve(paint()).catch(() => {}); // 兼容非 Promise 的 paint（测试假 session）
    }
  }, delayMs);
}

/**
 * /mcp 子命令分发（resources / prompts / read / get / add / remove / login / reconnect）。
 * 输出统一进命令面板（pushCmdLine），不污染对话流。
 */
async function runMcpSub(
  ctx: TuiCommandContext,
  sub: string,
  arg: string,
  servers: Record<string, McpServerConfig>,
  names: string[],
  handles: McpServerHandle[]
): Promise<void> {
  const parts = arg.split(/\s+/).filter(Boolean).slice(1);
  // —— reconnect：关旧客户端 → 重新 discover → 重建工具链 ——
  if (sub === 'reconnect') {
    pushCmdLine(ctx.state, { kind: 'meta', text: '正在重连 MCP 服务器…' });
    await ctx.session.paint().catch(() => {});
    if (ctx.onReconnectMcp) {
      await ctx.onReconnectMcp();
      pushCmdLine(ctx.state, { kind: 'meta', text: '已重连（工具链已更新，新工具对模型可见）' });
      scheduleCmdPanelAutoClose(ctx.state, ctx.session);
    } else {
      pushCmdLine(ctx.state, { kind: 'warn', text: '当前环境不支持重连（缺 onReconnectMcp）' });
    }
    return;
  }
  // —— resources：列出全部或指定 server 的资源 ——
  if (sub === 'resources') {
    if (names.length === 0) {
      pushCmdLine(ctx.state, { kind: 'warn', text: '未配置 MCP 服务器' });
      return;
    }
    const target = parts[0];
    const hs = handles.filter((h) => !target || h.name === target);
    if (hs.length === 0) {
      pushCmdLine(ctx.state, { kind: 'warn', text: target ? `服务器「${target}」未连接成功` : '（服务器均未连接成功）' });
      return;
    }
    for (const h of hs) {
      if (h.resources.length === 0) {
        pushCmdLine(ctx.state, { kind: 'meta', text: `${h.name}：无资源（或服务器未声明 resources 能力）` });
        continue;
      }
      pushCmdLine(ctx.state, { kind: 'meta', text: `${h.name} 资源（${h.resources.length}）：` });
      for (const r of h.resources) {
        pushCmdLine(ctx.state, { kind: 'meta', text: `  ${r.uri}  ${r.name}${r.description ? ` — ${r.description}` : ''}` });
      }
    }
    return;
  }
  // —— read <server> <uri>：读取资源内容 ——
  if (sub === 'read') {
    const serverName = parts[0];
    const uri = parts.slice(1).join(' ');
    const h = handles.find((x) => x.name === serverName);
    if (!h) {
      pushCmdLine(ctx.state, { kind: 'warn', text: `服务器「${serverName}」未连接成功（/mcp 查看已配置列表）` });
      return;
    }
    if (!uri) {
      pushCmdLine(ctx.state, { kind: 'warn', text: `用法：/mcp read <server> <uri>` });
      return;
    }
    pushCmdLine(ctx.state, { kind: 'meta', text: `正在读取 ${uri}…` });
    await ctx.session.paint().catch(() => {});
    try {
      const r = await h.client.readResource(uri);
      if (!r) pushCmdLine(ctx.state, { kind: 'warn', text: `资源「${uri}」不存在或不可读` });
      else {
        pushCmdLine(ctx.state, { kind: 'meta', text: `### ${r.uri}${r.mimeType ? `（${r.mimeType}）` : ''}` });
        const lines = (r.text ?? '').split('\n').slice(0, 40);
        for (const l of lines) pushCmdLine(ctx.state, { kind: 'meta', text: l });
        if ((r.text ?? '').split('\n').length > 40) pushCmdLine(ctx.state, { kind: 'meta', text: '…（内容较长，已截断前 40 行）' });
      }
    } catch (err) {
      pushCmdLine(ctx.state, { kind: 'warn', text: `读取失败：${err instanceof Error ? err.message : err}` });
    }
    return;
  }
  // —— prompts：列出全部或指定 server 的提示词模板 ——
  if (sub === 'prompts') {
    if (names.length === 0) {
      pushCmdLine(ctx.state, { kind: 'warn', text: '未配置 MCP 服务器' });
      return;
    }
    const target = parts[0];
    const hs = handles.filter((h) => !target || h.name === target);
    for (const h of hs) {
      if (h.prompts.length === 0) {
        pushCmdLine(ctx.state, { kind: 'meta', text: `${h.name}：无提示词模板（或服务器未声明 prompts 能力）` });
        continue;
      }
      pushCmdLine(ctx.state, { kind: 'meta', text: `${h.name} 提示词模板（${h.prompts.length}）：` });
      for (const p of h.prompts) {
        const argsDesc = p.arguments && p.arguments.length > 0
          ? `（参数：${p.arguments.map((a) => `${a.name}${a.required ? '*' : ''}`).join(', ')})`
          : '';
        pushCmdLine(ctx.state, { kind: 'meta', text: `  ${p.name}${argsDesc}${p.description ? ` — ${p.description}` : ''}` });
      }
    }
    return;
  }
  // —— get <server> <模板>：获取提示词模板内容 ——
  if (sub === 'get') {
    const serverName = parts[0];
    const promptName = parts[1];
    const h = handles.find((x) => x.name === serverName);
    if (!h) {
      pushCmdLine(ctx.state, { kind: 'warn', text: `服务器「${serverName}」未连接成功（/mcp 查看已配置列表）` });
      return;
    }
    if (!promptName) {
      pushCmdLine(ctx.state, { kind: 'warn', text: `用法：/mcp get <server> <模板名>` });
      return;
    }
    try {
      const p = await h.client.getPrompt(promptName, {});
      if (!p) pushCmdLine(ctx.state, { kind: 'warn', text: `提示词模板「${promptName}」不存在` });
      else {
        pushCmdLine(ctx.state, { kind: 'meta', text: `### 提示词模板 ${promptName}${p.description ? `（${p.description}）` : ''}` });
        for (const m of p.messages) pushCmdLine(ctx.state, { kind: 'meta', text: `${m.role}: ${m.text.slice(0, 2000)}` });
      }
    } catch (err) {
      pushCmdLine(ctx.state, { kind: 'warn', text: `获取失败：${err instanceof Error ? err.message : err}` });
    }
    return;
  }
  // —— add：解析 → onAddMcp 连接注入 → 持久化 ——
  if (sub === 'add') {
    const parsed = parseMcpAddArgs(arg.slice(3).trim());
    if (!parsed.ok) {
      pushCmdLine(ctx.state, { kind: 'warn', text: parsed.error });
      return;
    }
    if (parsed.name in servers) {
      pushCmdLine(ctx.state, { kind: 'warn', text: `服务器「${parsed.name}」已存在（用 /mcp remove ${parsed.name} 先移除）` });
      return;
    }
    pushCmdLine(ctx.state, { kind: 'meta', text: `正在连接 MCP 服务器「${parsed.name}」…` });
    await ctx.session.paint().catch(() => {});
    if (!ctx.onAddMcp) {
      pushCmdLine(ctx.state, { kind: 'warn', text: '当前环境不支持添加服务器（缺 onAddMcp）' });
      return;
    }
    const err = await ctx.onAddMcp(parsed.name, parsed.cfg);
    if (err) {
      pushCmdLine(ctx.state, { kind: 'warn', text: `添加失败：${err}` });
      return;
    }
    const persist = persistMcpServerToConfig(parsed.name, parsed.cfg, ctx.cfg!);
    pushCmdLine(ctx.state, { kind: 'meta', text: `已添加并连接 MCP 服务器「${parsed.name}」（工具已对模型可见）` });
    if (persist.ok) pushCmdLine(ctx.state, { kind: 'meta', text: persist.message });
    else pushCmdLine(ctx.state, { kind: 'warn', text: persist.message });
    scheduleCmdPanelAutoClose(ctx.state, ctx.session);
    return;
  }
  // —— remove：onRemoveMcp 断开移除 → 持久化 ——
  if (sub === 'remove') {
    const serverName = parts[0];
    if (!serverName) {
      pushCmdLine(ctx.state, { kind: 'warn', text: `用法：/mcp remove <名称>` });
      return;
    }
    if (!(serverName in servers)) {
      pushCmdLine(ctx.state, { kind: 'warn', text: `未配置 MCP 服务器「${serverName}」（/mcp 查看列表）` });
      return;
    }
    if (!ctx.onRemoveMcp) {
      pushCmdLine(ctx.state, { kind: 'warn', text: '当前环境不支持移除服务器（缺 onRemoveMcp）' });
      return;
    }
    const err = await ctx.onRemoveMcp(serverName);
    if (err) {
      pushCmdLine(ctx.state, { kind: 'warn', text: `移除失败：${err}` });
      return;
    }
    const persist = removeMcpServerFromConfig(serverName, ctx.cfg!);
    pushCmdLine(ctx.state, { kind: 'meta', text: `已移除 MCP 服务器「${serverName}」（工具链已更新）` });
    if (persist.ok) pushCmdLine(ctx.state, { kind: 'meta', text: persist.message });
    else pushCmdLine(ctx.state, { kind: 'warn', text: persist.message });
    scheduleCmdPanelAutoClose(ctx.state, ctx.session);
    return;
  }
  // —— login：OAuth 登录（仅 HTTP 服务器）——
  if (sub === 'login') {
    const serverName = parts[0];
    const h = handles.find((x) => x.name === serverName);
    const serverCfg = servers[serverName];
    if (!serverCfg) {
      pushCmdLine(ctx.state, { kind: 'warn', text: `未配置 MCP 服务器「${serverName}」（/mcp 查看列表）` });
      return;
    }
    if (!serverCfg.url) {
      pushCmdLine(ctx.state, { kind: 'warn', text: `「${serverName}」是 stdio 服务器（不需要 OAuth 登录；HTTP 服务器才用 /mcp login）` });
      return;
    }
    if (!h) {
      pushCmdLine(ctx.state, { kind: 'warn', text: `服务器「${serverName}」未连接（先 /mcp add 或确认配置后再试）` });
      return;
    }
    pushCmdLine(ctx.state, { kind: 'meta', text: '正在打开浏览器完成 OAuth 授权…（60s 内未完成将取消）' });
    await ctx.session.paint().catch(() => {});
    if (!ctx.onLoginMcp) {
      pushCmdLine(ctx.state, { kind: 'warn', text: '当前环境不支持 OAuth 登录（缺 onLoginMcp）' });
      return;
    }
    try {
      const err = await ctx.onLoginMcp(serverName);
      if (err) pushCmdLine(ctx.state, { kind: 'warn', text: `登录失败：${err}` });
      else {
        pushCmdLine(ctx.state, { kind: 'meta', text: `已登录「${serverName}」（token 已保存，之后请求自动携带）` });
        scheduleCmdPanelAutoClose(ctx.state, ctx.session);
      }
    } catch (err) {
      pushCmdLine(ctx.state, { kind: 'warn', text: `登录失败：${err instanceof Error ? err.message : err}` });
    }
    return;
  }
  pushCmdLine(ctx.state, { kind: 'warn', text: `未知子命令 /mcp ${sub}` });
}

/**
 * 执行斜杠命令：解析命令名 → 注册表分发；未找到时提示（不打断对话）。
 * 返回 'exit' 表示应退出交互循环。
 */
export async function runCommand(ctx: TuiCommandContext, raw: string): Promise<TuiCommandResult> {
  const parts = raw.slice(1).trim().split(/\s+/);
  const name = parts[0] ?? '';
  const cmd = findCommand(name);
  if (!cmd) {
    pushCmdLine(ctx.state, { kind: 'warn', text: `未知命令 /${name}（/help 查看可用命令）` });
    return;
  }
  // 所有命令的输出统一进**独立面板**（不进对话流，用户要求 command 不影响对话流）：
  // 分发前打开空面板（标题 = /命令 参数），命令内 pushCmdLine 追加；
  // 执行完仍无输出（如 /plan、/thinking 静默切换）→ 自动收起，不弹空面板。
  openCmdPanel(ctx.state, `/${name}${parts.slice(1).length ? ` ${parts.slice(1).join(' ')}` : ''}`);
  const result = await cmd.run({ ...ctx, args: parts.slice(1).join(' ') });
  const panel = ctx.state.cmdPanel;
  if (panel && panel.lines.length === 0) {
    ctx.state.cmdPanel = null; // 静默命令（/plan /thinking 等）：无输出不弹空面板
  } else if (cmd.autoClose && panel) {
    // 执行型命令：run() 完成后面板短暂停留确认 → 自动收起（无需按 Esc 关闭）
    scheduleCmdPanelAutoClose(ctx.state, ctx.session);
  }
  return result;
}

/** 命令注册表：新增命令在这里登记（interactive.ts 按此分发） */
export const TUI_COMMANDS: TuiCommand[] = [
  {
    name: 'permission',
    description: '切换安全权限（低=只读 / 中=标准 / 高=谨慎 / 全量=直通）',
    descriptionEn: 'Switch security level (read / safe / ask / full)',
    run: (ctx) => {
      // 未信任目录：强制只读，禁止提升档位（read 是工作区信任的硬约束，/permission 不能绕过）
      if (ctx.runOpts?.trusted === false) {
        pushCmdLine(ctx.state, {
          kind: 'warn',
          text: '当前目录未受信任——权限锁定为只读（read），无法提升。信任目录：首次进入时批准信任，或在已信任目录运行。',
        });
        return;
      }
      openPermissionMenu(ctx.state);
    },
  },
  {
    name: 'plan',
    description: '切换计划模式（只读调研，不修改文件）',
    descriptionEn: 'Toggle plan mode (read-only research)',
    run: (ctx) => {
      // 会话级开关：只对模型暴露只读工具（read_file/list_directory/search_code）+ 系统提示
      // 追加只读说明（loop 读 runOpts.planMode；interactive 每轮从 state 同步）。
      // footer 模型行模式前缀显示 `Plan`/`Build` 作为常驻指示；不推 meta 提示文字。
      ctx.state.planMode = !ctx.state.planMode;
    },
  },
  {
    name: 'thinking',
    description: '开/关思考过程展示（关闭后不再流式显示，仍落盘）',
    descriptionEn: 'Show / hide thinking entirely',
    run: (ctx) => {
      // **展示开关**（非折叠）：false = 完全不展示思考流——TuiOutput 停止建模块/写
      // chunk（reasoning 仍捕获落盘 .omni/last-thinking.md），buildBody 过滤历史行；
      // true = 恢复实时流式展示。runOpts.showThinking 同步（/status 等读取运行时值）。
      // 会话级，/clear 不清除；切换时清空两个单独反例集合（避免残留用户点击的
      // 单条展开/收起覆盖全局态）。不推 meta 提示文字（视觉变化自明）。
      const next = !ctx.state.thinkingShow;
      ctx.state.thinkingShow = next;
      ctx.out.showThinking = next;
      if (ctx.runOpts) ctx.runOpts.showThinking = next;
      ctx.state.expandedThinking.clear();
      ctx.state.collapsedThinking.clear();
    },
  },
  {
    name: 'exit',
    aliases: ['quit'],
    description: '退出 TUI',
    descriptionEn: 'Quit TUI',
    run: () => 'exit', // 返回信号：interactive.ts break 循环，tui-entry 的 finally 统一 stop 会话
  },
  {
    name: 'clear',
    description: '清空对话上下文',
    descriptionEn: 'Clear conversation context',
    run: (ctx) => {
      ctx.messages.length = 0;
      ctx.out.clearScrollback();
      // 新一轮会话：SessionStart hook 重新触发（sessionStart 每会话一次，/clear 后重置）
      ctx.hooks?.resetSessionStart();
    },
  },
  {
    name: 'undo',
    description: '撤销本次会话的 write_file 修改（all = 全部撤销）',
    descriptionEn: 'Undo write_file changes (all = undo all)',
    autoClose: true,
    run: async (ctx) => {
      // /undo：pop 最近一次写操作快照并恢复文件（新建文件则删除）；
      // /undo all：逆序恢复全部快照，回到会话开始前的文件状态。
      // 撤销后向 messages 注入 system 提示——模型不再基于已回滚的旧内容继续操作。
      const stack = ctx.undoStack;
      if (!stack || stack.size === 0) {
        pushCmdLine(ctx.state, { kind: 'warn', text: '没有可撤销的写操作（本次会话尚未修改文件）' });
        return;
      }
      const all = /(?:^|\s)all(?=\s|$)/.test(ctx.args ?? '');
      if (all) {
        // popAllForUndo：逆序 pop（新→旧）并逐个捕获 redo 候选（/redo all 可恢复）
        const entries = await stack.popAllForUndo();
        const results: string[] = [];
        for (const e of entries) {
          results.push(await applyUndo(e).catch(() => `撤销失败：${e.path}`));
        }
        pushCmdLine(ctx.state, { kind: 'meta', text: `已撤销全部 ${results.length} 个写操作` });
        for (const r of results) pushCmdLine(ctx.state, { kind: 'meta', text: `· ${r}` });
        ctx.messages.push({ role: 'system', content: `[已执行 /undo all] 本次会话 ${results.length} 个文件修改已全部回滚，请勿再基于旧结果操作。` });
        return;
      }
      // popForUndo：pop 时捕获「撤销前」状态进 redo 栈（/redo 恢复）
      const entry = await stack.popForUndo();
      if (!entry) return;
      const msg = await applyUndo(entry).catch(() => `撤销失败：${entry.path}`);
      const left = stack.size;
      pushCmdLine(ctx.state, { kind: 'meta', text: left > 0 ? `${msg}（还有 ${left} 个可撤销，/undo all 全部撤销）` : `${msg}（无更多可撤销）` });
      ctx.messages.push({ role: 'system', content: `[已执行 /undo] ${msg}。该文件的写操作已回滚，请勿再基于旧内容操作。` });
    },
  },
  {
    name: 'init',
    description: '扫描项目并生成 AGENTS.md 项目记忆文件（--global 生成全局记忆）',
    descriptionEn: 'Generate AGENTS.md project memory (--global for global)',
    autoClose: true,
    run: async (ctx) => {
      // /init：定位项目根 → 扫描结构 → LLM 生成 AGENTS.md → 写入（已存在不覆盖）
      // /init --global：生成 ~/.config/omni/AGENTS.md（跨项目用户偏好）
      const { client, model } = ctx;
      if (!client || !model) {
        pushCmdLine(ctx.state, { kind: 'warn', text: '/init 需要 LLM 客户端（当前环境不可用）' });
        return;
      }
      const isGlobal = /(?:^|\s)--global(?=\s|$)/.test(ctx.args ?? '');
      if (isGlobal) {
        pushCmdLine(ctx.state, { kind: 'meta', text: '正在扫描用户环境并生成全局记忆 AGENTS.md…' });
        await ctx.session.paint().catch(() => {});
        const content = await generateGlobalAgentsFile(client, model);
        if (!content) {
          pushCmdLine(ctx.state, { kind: 'warn', text: '全局记忆生成失败（网络 / API 问题），请重试' });
          return;
        }
        const res = await writeGlobalAgentsFile(content);
        if (!res.ok) {
          pushCmdLine(ctx.state, {
            kind: 'warn',
            text: `已存在 ${res.path}，/init --global 不覆盖（如需重新生成请先删除或重命名）`,
          });
          return;
        }
        pushCmdLine(ctx.state, { kind: 'meta', text: `已生成全局记忆 ${res.path}（所有项目会话自动加载）` });
        return;
      }
      // 子目录生成（P2）：/init <子目录> 在该目录生成局部层级 AGENTS.md
      // （如 /init src/ → src/AGENTS.md，嵌套记忆覆盖外层）
      const subDirArg = (ctx.args ?? '').replace(/\s*--global\s*/, '').trim();
      const root = subDirArg
        ? path.resolve(process.cwd(), subDirArg)
        : findProjectRoot(process.cwd());
      pushCmdLine(ctx.state, { kind: 'meta', text: `正在扫描并生成 AGENTS.md（目标：${root}）…` });
      // 先刷一帧：progress 行在 LLM 调用（可能 10s+）期间可见，否则用户面对冻结 UI
      await ctx.session.paint().catch(() => {});
      const content = await generateAgentsFile(client, model, root);
      if (!content) {
        pushCmdLine(ctx.state, { kind: 'warn', text: 'AGENTS.md 生成失败（网络 / API 问题），请重试' });
        return;
      }
      const res = await writeAgentsFile(root, content);
      if (!res.ok) {
        pushCmdLine(ctx.state, {
          kind: 'warn',
          text: `已存在 ${res.path}，/init 不覆盖（如需重新生成请先删除或重命名）`,
        });
        return;
      }
      pushCmdLine(ctx.state, { kind: 'meta', text: `已生成 ${res.path}（下次会话自动加载为项目记忆${subDirArg ? '；子目录层级优先于外层' : ''}）` });
    },
  },
  {
    name: 'skill',
    description: '技能管理：列出已发现 / find <词> 网络检索 / add <repo> [--skill <名>] [--global] 安装 / show <名> / 安装后本会话即时生效',
    descriptionEn: 'Skill manager: list / find <query> / add <repo> [--skill <name>] [--global] / show <name> — immediate effect in current session',
    run: async (ctx) => {
      const args = (ctx.args ?? '').trim();
      if (!args) {
        const skills = await discoverSkills();
        if (skills.length === 0) {
          pushCmdLine(ctx.state, {
            kind: 'warn',
            text: '未发现技能（.opencode/.claude/.agents/skills 下无 SKILL.md）。用 /skill find <关键词> 网络检索，或 /skill add <owner/repo> --skill <名称> 安装。',
          });
          return;
        }
        // 渐进披露：列表展示全部（不截断）
        pushCmdLine(ctx.state, {
          kind: 'meta',
          text: `已发现 ${skills.length} 个技能（模型可用 skill 工具按 name 加载；/skill find 网络检索更多）：`,
        });
        for (const s of skills) {
          const tags: string[] = [];
          if (s.global) tags.push('全局');
          if (s.disableModelInvocation) tags.push('仅手动');
          if (s.context === 'fork') tags.push('子代理');
          if (s.source) tags.push(s.source);
          const tag = tags.length > 0 ? `（${tags.join(' · ')}）` : '';
          pushCmdLine(ctx.state, { kind: 'meta', text: `· ${s.name} — ${s.description}${tag}` });
        }
        return;
      }
      const findM = args.match(/^find\s+(.+)$/);
      if (findM) {
        const query = findM[1].trim();
        pushCmdLine(ctx.state, { kind: 'meta', text: `正在网络检索技能（npx skills find ${query}）…` });
        await ctx.session.paint().catch(() => {}); // 先刷一帧：进度行在子进程期间可见
        const { ok, output } = await runSkillsCli(['find', query]);
        if (!ok) {
          pushCmdLine(ctx.state, { kind: 'warn', text: `检索失败：${output.slice(0, 300) || 'npx skills 不可用'}` });
          return;
        }
        const results = parseSkillFindResults(output);
        if (results.length === 0) {
          pushCmdLine(ctx.state, { kind: 'warn', text: `没有匹配「${query}」的技能。` });
          return;
        }
        pushCmdLine(ctx.state, {
          kind: 'meta',
          text: `找到 ${results.length} 个技能（安装：/skill add <owner/repo> --skill <技能名>）：`,
        });
        for (const r of results.slice(0, 20)) pushCmdLine(ctx.state, { kind: 'meta', text: `· ${r}` });
        if (results.length > 20) pushCmdLine(ctx.state, { kind: 'meta', text: `… 还有 ${results.length - 20} 个（npx skills find ${query} 查看全部）` });
        return;
      }
      // 更精确的 add 解析：source [--skill <name>] [--global]
      const addTokens = args.split(/\s+/).filter(Boolean);
      if (addTokens[0] === 'add' && addTokens[1]) {
        const source = addTokens[1];
        const skillNameI = addTokens.indexOf('--skill');
        const skillName = skillNameI >= 0 ? addTokens[skillNameI + 1] : undefined;
        const isGlobal = addTokens.includes('--global');
        pushCmdLine(ctx.state, {
          kind: 'meta',
          text: `正在安装 ${source}${skillName ? ` 的 ${skillName}` : '（仓库全部技能）'}…（npx skills add${isGlobal ? ' --global' : ''}，可能需要下载）`,
        });
        await ctx.session.paint().catch(() => {});
        const cliArgs = ['add', source, ...(skillName ? ['--skill', skillName] : []), '-y'];
        const { ok, output } = await runSkillsCli(cliArgs, 180_000);
        if (!ok) {
          pushCmdLine(ctx.state, { kind: 'warn', text: `安装失败：${output.slice(0, 300) || 'npx skills 不可用'}` });
          if (output) { for (const line of output.split('\n').slice(0, 10)) { if (line.trim()) pushCmdLine(ctx.state, { kind: 'meta', text: `· ${line}` }); } }
          return;
        }
        // 安装成功：本会话即时生效——重新 discover + 刷新注入清单
        const oldSkills = await discoverSkills();
        // 如果是 --global，安装到全局目录（npx skills add 默认装到项目 .agents/skills/）
        // 这里通过调用 npx skills add 已装到项目目录，--global 时额外复制到全局目录
        if (isGlobal) {
          const globalDir = (await import('../agent/skill.js')).globalSkillDir();
          // npx skills add 不支持 --global 参数，这里用 --dir 或手动复制
          // 实际上 npx skills 没有 --global，由用户管理。我们提示用户用 --dir 或手动
          pushCmdLine(ctx.state, { kind: 'meta', text: 'npx skills 暂不支持 --global 参数，已安装到项目目录。如需全局安装，请用 /skill add 不带 --global 后手动复制到 ~/.config/omni/skills/' });
        }
        // 重新发现技能并刷新当前会话注入清单
        const newSkills = await discoverSkills();
        const newNames = newSkills.filter((s) => !oldSkills.find((o) => o.name === s.name)).map((s) => s.name);
        if (ctx.messages && Array.isArray(ctx.messages)) {
          refreshSkillInjections(ctx.messages, newSkills);
        }
        pushCmdLine(ctx.state, {
          kind: 'meta',
          text: `安装完成！已安装：${(skillName ? [skillName] : newNames).join('、') || source}（本会话已生效，模型现在可用 skill 工具加载）`,
        });
        if (newNames.length > 0) {
          pushCmdLine(ctx.state, { kind: 'meta', text: `新技能：${newNames.join('、')}（/skill show <名称> 查看内容）` });
        }
        scheduleCmdPanelAutoClose(ctx.state, ctx.session);
        return;
      }
      const showM = args.match(/^show\s+(\S+)$/);
      if (showM) {
        const content = await loadSkillContent(showM[1]);
        pushCmdLine(ctx.state, {
          kind: content ? 'meta' : 'warn',
          text: content ? `技能「${showM[1]}」内容：` : `未找到技能「${showM[1]}」（/skill 查看已发现列表）`,
        });
        if (content) {
          // 解析 frontmatter 展示扩展字段
          const fm = parseSkillFrontmatter(content);
          const ext = [];
          if (fm['disable-model-invocation']) ext.push('仅手动触发');
          if (fm['user-invocable']) ext.push('用户可手动触发');
          if (fm.context === 'fork') ext.push(`子代理执行${fm.agent ? `（agent=${fm.agent}）` : ''}${fm.background ? '·后台' : ''}`);
          if (ext.length > 0) pushCmdLine(ctx.state, { kind: 'meta', text: `属性：${ext.join(' · ')}` });
          pushCmdLine(ctx.state, { kind: 'answer', text: content });
        }
        return;
      }
      pushCmdLine(ctx.state, {
        kind: 'warn',
        text: '用法：/skill（列出已发现）· /skill find <关键词>（网络检索）· /skill add <owner/repo> [--skill <名称>] [--global]（安装，本会话即时生效）· /skill show <名称>（查看内容）',
      });
    },
  },
  {
    name: 'compact',
    description: '手动压缩上下文（把旧消息合并为摘要，保留最近几轮原文）',
    descriptionEn: 'Compress context manually (summarize old messages)',
    autoClose: true,
    run: async (ctx) => {
      // /compact：手动触发长对话摘要压缩——把旧消息压成一条 system 摘要（保留最近
      // summarizeWindow 条原文），避免上下文被早期轮次撑爆。与自动压缩（summarizeAt
      // 阈值）同一实现；压缩失败/消息太少时提示，不打断对话。
      const { client, model } = ctx;
      if (!client || !model) {
        pushCmdLine(ctx.state, { kind: 'warn', text: '/compact 需要 LLM 客户端（当前环境不可用）' });
        return;
      }
      const before = ctx.messages.length;
      // 强制压缩：只要可压缩就压缩（summarizeContext 内部有 split 边界判定，
      // 消息太少/全是 system 时自动跳过并返回）；recorder 记录 compact 轨迹事件
      await summarizeContext(client, model, ctx.messages, { summarizeAt: 1, summarizeWindow: 8 }, ctx.events);
      const after = ctx.messages.length;
      if (after >= before) {
        pushCmdLine(ctx.state, {
          kind: 'warn',
          text: '上下文还很短或无可压缩内容（/compact 在长对话中才有明显效果）',
        });
        return;
      }
      pushCmdLine(ctx.state, { kind: 'meta', text: `已压缩 ${before - after} 条旧消息为摘要（保留最近 8 条原文）` });
    },
  },
  {
    name: 'agents',
    description: '查看子代理配置（模型 / 步骤上限 / 嵌套深度 / 已定义子代理 / 模型路由）',
    descriptionEn: 'View subagent config (model / max steps / depth / defined agents / routing)',
    run: (ctx) => {
      // /agents：展示当前子代理（delegate）配置——是否启用、模型路由（architect/editor）、
      // 步骤上限、嵌套深度、可用工具、已定义子代理（.agents/subagents/*.md）。
      // 只读查看，不改变任何配置。
      // 可选参数：`/agents <name>` 展开查看某个已定义子代理的角色全文（frontmatter + 正文）。
      const show = (ctx.args ?? '').trim();
      if (show) {
        const defs = ctx.subagents ?? [];
        const def = defs.find((d) => d.name === show);
        if (!def) {
          const avail = defs.map((d) => d.name).join('、');
          pushCmdLine(ctx.state, { kind: 'warn', text: `未找到子代理定义「${show}」${avail ? `。可用：${avail}` : '（.agents/subagents/ 下未定义任何子代理）'}` });
          return;
        }
        pushCmdLine(ctx.state, { kind: 'meta', text: `子代理定义：${def.name} — ${def.description}` });
        pushCmdLine(ctx.state, { kind: 'meta', text: `· 模型：${def.model ?? '（继承主代理）'}` });
        pushCmdLine(ctx.state, { kind: 'meta', text: `· 权限：${def.permission ?? '（继承主代理）'}` });
        pushCmdLine(ctx.state, { kind: 'meta', text: `· 工具白名单：${def.tools?.length ? def.tools.join('、') : '（全部默认工具）'}` });
        pushCmdLine(ctx.state, { kind: 'meta', text: `· 技能预载：${def.skills?.length ? def.skills.join('、') : '（无）'}` });
        pushCmdLine(ctx.state, { kind: 'meta', text: `· 步数上限：${def.maxSteps ?? '（继承主代理）'}` });
        pushCmdLine(ctx.state, { kind: 'meta', text: `· 定义文件：${def.path}` });
        pushCmdLine(ctx.state, { kind: 'meta', text: '· 角色指令：' });
        for (const l of def.instructions.split('\n')) pushCmdLine(ctx.state, { kind: 'meta', text: `  ${l}` });
        return;
      }
      const tools = ctx.tools ?? [];
      const hasDelegate = tools.some((t) => t.name === 'delegate');
      const subTools = tools.filter((t) => t.name !== 'delegate');
      pushCmdLine(ctx.state, { kind: 'meta', text: `子代理配置（delegate）：${hasDelegate ? '已启用' : '未启用（allowSubagents=false）'}` });
      pushCmdLine(ctx.state, { kind: 'meta', text: `· 当前模型：${ctx.model ?? '（未知）'}` });
      // architect/editor 模型路由（第六节 P1）：/plan 用 architect 强模型、执行用 editor 轻模型
      pushCmdLine(ctx.state, {
        kind: 'meta',
        text: `· 模型路由：${ctx.architectModel || ctx.editorModel ? `architect=${ctx.architectModel ?? ctx.model}（/plan）· editor=${ctx.editorModel ?? ctx.model}（执行）` : '未配置（全部用当前模型）'}`,
      });
      pushCmdLine(ctx.state, { kind: 'meta', text: `· 最大循环步数：${ctx.maxSubagentSteps ?? '（默认 10）'}` });
      pushCmdLine(ctx.state, { kind: 'meta', text: `· 最大嵌套深度：${ctx.maxSubagentDepth ?? '（默认 5）'}` });
      pushCmdLine(ctx.state, { kind: 'meta', text: `· 子代理可用工具（${subTools.length}）：${subTools.map((t) => t.name).join('、')}` });
      // 已定义子代理（.agents/subagents/*.md）：delegate 的 agent 参数可用；/orchestrate --agents 分工
      const defs = ctx.subagents ?? [];
      if (defs.length > 0) {
        pushCmdLine(ctx.state, {
          kind: 'meta',
          text: `· 已定义子代理（${defs.length}，.agents/subagents/*.md；delegate agent= 或 /orchestrate --agents 选用）：`,
        });
        for (const d of defs) {
          pushCmdLine(ctx.state, {
            kind: 'meta',
            text: `  · ${d.name} — ${d.description}${d.model ? `（模型 ${d.model}）` : ''}${d.permission ? `（权限 ${d.permission}）` : ''}${d.tools ? `（工具 ${d.tools.join(',')}）` : ''}${d.skills ? `（技能 ${d.skills.join(',')}）` : ''}${d.maxSteps ? `（步数 ${d.maxSteps}）` : ''}`,
          });
        }
      } else {
        pushCmdLine(ctx.state, { kind: 'meta', text: '· 已定义子代理：无（.agents/subagents/ 下可放 <name>.md 声明命名子代理，frontmatter 配 model/permission/tools/skills/maxSteps）' });
      }
      pushCmdLine(ctx.state, {
        kind: 'meta',
        text: '说明：模型可用 delegate 工具把独立子任务委托给子代理（隔离上下文，可嵌套）；子代理共用安全闸门，权限与主代理一致（定义子代理可配独立权限）。/orchestrate 并行编排、/goal 目标机制见 /help。',
      });
    },
  },
  {
    name: 'orchestrate',
    description: '并行编排：fan-out 多个子代理 → 汇总 → 对抗审查（/orchestrate <任务> [--agents a,b,c] [--parallel N]）',
    descriptionEn: 'Orchestrate: fan-out subagents → combine → adversarial review',
    run: async (ctx) => {
      // /orchestrate：固定 pipeline——fan-out 并行 delegate（--agents 按定义子代理分工，
      // 缺省 3 个角度 worker）→ 汇总器合并 → 对抗审查找漏洞（第六节 P2 轻量版）。
      // 全程独立于 messages 历史（编排是一次性输出，不污染对话上下文）。
      const { client, model } = ctx;
      if (!client || !model) {
        pushCmdLine(ctx.state, { kind: 'warn', text: '/orchestrate 需要 LLM 客户端（当前环境不可用）' });
        return;
      }
      const log = (text: string): void => pushCmdLine(ctx.state, { kind: 'meta', text });
      const tick = async (): Promise<void> => {
        await ctx.session.paint().catch(() => {}); // 先刷一帧：进度行在子代理/LLM 调用期间可见
      };
      try {
        if (!ctx.runOpts) {
          pushCmdLine(ctx.state, { kind: 'warn', text: '/orchestrate 运行选项不可用（当前环境异常）' });
          return;
        }
        const { combined, review } = await runOrchestrate(ctx.args ?? '', ctx.subagents, {
          client,
          model,
          runOpts: ctx.runOpts,
          log,
          tick,
          onSubagentEvent: (ev) => ctx.out.onSubagentEvent?.(ev),
        });
        pushCmdLine(ctx.state, { kind: 'meta', text: '' });
        pushCmdLine(ctx.state, { kind: 'meta', text: '═══ 综合结果 ═══' });
        pushCmdLine(ctx.state, { kind: 'answer', text: combined });
        pushCmdLine(ctx.state, { kind: 'meta', text: '' });
        pushCmdLine(ctx.state, { kind: 'meta', text: '═══ 对抗审查 ═══' });
        pushCmdLine(ctx.state, { kind: 'answer', text: review });
      } catch (err) {
        pushCmdLine(ctx.state, { kind: 'warn', text: String((err as Error)?.message ?? err) });
      }
    },
  },
  {
    name: 'goal',
    aliases: ['loop'], // 旧名兼容（/loop 习惯）
    description: '目标机制：自动推导验收标准并循环执行直至达标（/goal <目标> [--accept <验收标准>] [--max N]，上限 5 次）',
    descriptionEn: 'Goal mechanism: derive acceptance criteria and execute until met (/goal <goal> [--accept <criteria>] [--max N])',
    run: async (ctx) => {
      // /goal：目标驱动循环——缺省由「目标拆解器」LLM 自动推导验收标准（--accept 显式
      // 指定可跳过）；每轮 worker 子代理带「上一轮结果 + 判定反馈」继续推进，验收判定器
      // 检查达标，不满足的理由反馈进下一轮；--max 调整迭代上限（默认 5）。
      const { client, model } = ctx;
      if (!client || !model) {
        pushCmdLine(ctx.state, { kind: 'warn', text: '/goal 需要 LLM 客户端（当前环境不可用）' });
        return;
      }
      // /goal 是长流程干活型命令：执行过程（目标/推导/迭代/判定）**实时流进对话流**
      // （meta 行，可见可回看），不用命令面板——面板由 runCommand 打开、因无输出自动收起。
      // 推导/验收判定等 LLM 输出经 onStream **逐字流式**累积到同一 meta 行（打字机效果），
      // 而非整行一次性出现。
      const log = (text: string): void => pushLine(ctx.state, { kind: 'meta', text });
      const tick = async (): Promise<void> => {
        await ctx.session.paint().catch(() => {});
      };
      // 流式 sink：start 开新 meta 行（前缀即显示），chunk 原位累积（buildBody 每次
      // paint 从 state.lines 重建，mutate line.text 即可流式更新），end 复位。
      const stream = (() => {
        let line: TuiLine | null = null;
        return {
          start(prefix: string): void {
            line = { kind: 'meta', text: prefix };
            pushLine(ctx.state, line);
            void tick();
          },
          chunk(text: string): void {
            if (line) {
              line.text += text;
              void tick();
            }
          },
          end(): void {
            line = null;
          },
        };
      })();
      try {
        if (!ctx.runOpts) {
          pushCmdLine(ctx.state, { kind: 'warn', text: '/goal 运行选项不可用（当前环境异常）' });
          return;
        }
        const result = await runGoal(ctx.args ?? '', {
          client,
          model,
          runOpts: ctx.runOpts,
          log,
          tick,
          onStream: () => stream,
          onSubagentEvent: (ev) => ctx.out.onSubagentEvent?.(ev),
        });
        // 结果 = worker 总结 + 达成标记（[目标达成：第 N 轮]），直接进对话流收尾
        pushLine(ctx.state, { kind: 'answer', text: result });
      } catch (err) {
        pushLine(ctx.state, { kind: 'warn', text: String((err as Error)?.message ?? err) });
      }
    },
  },
  {
    name: 'review',
    description: '审查代码改动（typecheck + git diff → LLM 审查）',
    descriptionEn: 'Review code changes (typecheck + git diff → LLM)',
    run: async (ctx) => {
      // /review：对工作区改动做代码审查——先跑 typecheck（项目自带脚本），
      // 再收集 git diff，喂给一次独立 LLM 调用输出问题与建议（不进入 messages 历史）。
      const { client, model } = ctx;
      if (!client || !model) {
        pushCmdLine(ctx.state, { kind: 'warn', text: '/review 需要 LLM 客户端（当前环境不可用）' });
        return;
      }
      pushCmdLine(ctx.state, { kind: 'meta', text: '正在收集改动并运行 typecheck…' });
      await ctx.session.paint().catch(() => {}); // 先刷一帧：进度行在子进程期间可见
      // 1) typecheck（项目自带；缺失则降级为 lint，都没有则跳过只审 diff）
      const checkCmd = detectCheckCommand();
      const check: { command: string | null; output: string } = checkCmd
        ? { command: checkCmd, output: (await captureCommand(checkCmd, 120_000)).output }
        : { command: null, output: '（无脚本）' };
      // 2) git diff（工作区 + 未跟踪状态）
      const diff = await collectDiff();
      if (!diff.ok) {
        pushCmdLine(ctx.state, { kind: 'warn', text: `无法获取 git diff：${diff.output.slice(0, 200)}` });
        return;
      }
      if (diff.output === '（无改动）') {
        pushCmdLine(ctx.state, { kind: 'warn', text: '工作区没有改动可审查（git diff 为空）' });
        return;
      }
      pushCmdLine(ctx.state, { kind: 'meta', text: `typecheck：${check.output === '（无输出）' ? '通过（无输出）' : check.output.split('\n').slice(0, 3).join(' · ')}` });
      await ctx.session.paint().catch(() => {});
      const review = await reviewCode(client, model, diff.output, {
        command: check.command,
        output: check.output,
      });
      if (!review) {
        pushCmdLine(ctx.state, { kind: 'warn', text: '审查失败（网络 / API 问题），请重试' });
        return;
      }
      pushCmdLine(ctx.state, { kind: 'meta', text: `审查结果（${diff.output.length} 字符改动）：` });
      pushCmdLine(ctx.state, { kind: 'answer', text: review });
    },
  },
  {
    name: 'variants',
    description: '切换模型思考级别（reasoning_effort；选项来自配置 reasoningEffortOptions）',
    descriptionEn: 'Switch reasoning effort (options from config)',
    run: (ctx) => openVariantsMenu(ctx.state, ctx.runOpts?.models),
  },
  {
    name: 'spec',
    description: '规格三件套（/spec <特性>）：生成 .omni/specs/<slug>/ 的 requirements/design/tasks（EARS 验收条款；任务同步会话清单）',
    descriptionEn: 'Spec trio (/spec <feature>): requirements(EARS)/design/tasks under .omni/specs/',
    autoClose: false,
    run: async (ctx) => {
      const feature = (ctx.args ?? '').trim();
      if (!feature || !ctx.client) {
        pushCmdLine(ctx.state, { kind: 'warn', text: '用法：/spec <功能特性>' + (!ctx.client ? '（需要可用模型客户端）' : '') });
        return;
      }
      pushCmdLine(ctx.state, { kind: 'meta', text: `正在为「${feature}」生成规格三件套…` }, '/spec');
      await ctx.session.paint().catch(() => {});
      const { generateSpec } = await import('../agent/spec.js');
      const r = await generateSpec(ctx.client, ctx.model ?? ctx.state.model, feature, process.cwd(), ctx.runOpts?.todoList);
      pushCmdLine(ctx.state, { kind: r.ok ? 'meta' : 'warn', text: r.message }, '/spec');
    },
  },
  {
    name: 'preset',
    description: '能力一键预设（/preset browser）：安装 Playwright MCP + Chrome DevTools MCP 到全局配置',
    descriptionEn: 'Capability preset (/preset browser): install browser MCP pair into global config',
    autoClose: true,
    run: async (ctx) => {
      const { runPreset } = await import('../agent/preset.js');
      const r = await runPreset((ctx.args ?? '').trim() || 'browser');
      for (const l of r.lines) pushCmdLine(ctx.state, { kind: 'meta', text: l }, '/preset');
    },
  },
  {
    name: 'settings',
    description: '设置（/settings statusline 配置底部状态行：空格勾选 · ←/→ 排序 · a 对齐 · Enter 保存生效；/settings language 切换界面语言；/settings theme 切换主题；/settings tokens 显示 / 隐藏当次 token 统计；/settings doctor 环境诊断）',
    descriptionEn: 'Settings (/settings statusline · /settings language · /settings theme · /settings tokens · /settings doctor)',
    run: async (ctx) => {
      // /settings：列出可用设置项（面板选择后打开对应设置编辑器）；
      // /settings statusline：直接打开底部状态行编辑器（多选 + 排序面板）；
      // /settings language：直接打开语言面板；/settings theme：直接打开主题面板；
      // /settings tokens：切换当次 token 统计显示（静默，同原 /tokens）；
      // /settings doctor：执行环境诊断（输出到命令面板，同原 /doctor）
      const args = (ctx.args ?? '').trim();
      if (/^statusline(?:\s|$)/.test(args)) {
        openStatuslinePanel(ctx.state);
        return;
      }
      if (/^language(?:\s|$)/.test(args)) {
        openLanguageMenu(ctx.state);
        return;
      }
      if (/^theme(?:\s|$)/.test(args)) {
        openThemeMenu(ctx.state);
        return;
      }
      if (/^tokens(?:\s|$)/.test(args)) {
        ctx.state.showTokens = !ctx.state.showTokens;
        return;
      }
      if (/^doctor(?:\s|$)/.test(args)) {
        await runDoctor(ctx);
        return;
      }
      if (!args) {
        openSettingsMenu(ctx.state);
        return;
      }
      pushCmdLine(ctx.state, { kind: 'warn', text: `未知设置「${args}」（可用：statusline 底部状态行 · language 界面语言 · theme 主题 · tokens 当次 token 统计 · doctor 环境诊断）` });
    },
  },
  {
    name: 'model',
    description: '切换/添加模型（/model 面板 · /model <名称> 切换 · /model add <名称> [--base-url] [--api-key] [--user-agent] 添加并持久化）',
    descriptionEn: 'Switch/add model (/model panel · /model <name> · /model add <name> [...])',
    autoClose: true, // 面板路径空输出自动收起；add/<名称> 切换为动作 → 执行完自动收起
    run: (ctx) => {
      // /model fetch [名称]：拉取网关 GET /v1/models 自动补全可用模型（1.0 P1 模型发现）
      if (/^fetch/.test((ctx.args ?? '').trim())) {
        const target = ctx.args!.trim().slice('fetch'.length).trim();
        const eps = ctx.runOpts?.models ?? [];
        const ep = target ? eps.find((m) => m.name === target) : eps.find((m) => m.name === ctx.model);
        if (!ep?.baseURL) {
          pushCmdLine(ctx.state, { kind: 'warn', text: `/model fetch${target ? ` ${target}` : ''}：未找到带 baseURL 的端点` });
          return;
        }
        pushCmdLine(ctx.state, { kind: 'meta', text: `正在拉取 ${ep.baseURL}/models …` }, '/model');
        void import('../client.js')
          .then(({ discoverModels }) => discoverModels(ep))
          .then((ids) => {
            const known = new Set(eps.map((m) => m.name).concat(eps.map((m) => m.apiModel ?? '')));
            const fresh = ids.filter((id) => !known.has(id));
            pushCmdLine(ctx.state, { kind: 'meta', text: `远端共 ${ids.length} 个模型，未在本地列表的 ${fresh.length} 个：` });
            for (const id of fresh.slice(0, 30)) pushCmdLine(ctx.state, { kind: 'answer', text: `· ${id}` });
            if (fresh.length > 30) pushCmdLine(ctx.state, { kind: 'meta', text: `… 还有 ${fresh.length - 30} 个` });
            pushCmdLine(ctx.state, { kind: 'meta', text: '添加：/model add <名> --base-url <端点>；或直接编辑 config providers/models' });
          })
          .catch((err) => {
            pushCmdLine(ctx.state, { kind: 'warn', text: `模型发现失败：${err instanceof Error ? err.message : err}` });
          });
        return;
      }
      // /model：打开切换面板（↑↓/数字 + Enter）
      // /model <名称>：直接切换（交互模式已注册端点）
      // /model add <名称> [--base-url] [--api-key] [--user-agent]：
      //   解析 → 运行时注册（缺省字段回退顶层配置）→ 切换 → 持久化到配置文件
      const args = (ctx.args ?? '').trim();
      if (!args) {
        openModelMenu(ctx.state, modelMenuLabels(ctx.runOpts?.models ?? [], ctx.models ?? []), ctx.runOpts?.models);
        return;
      }
      if (/^add(?:\s|$)/.test(args)) {
        const parsed = parseModelAddArgs(args.slice(3));
        if (!parsed.ok) {
          pushCmdLine(ctx.state, { kind: 'warn', text: parsed.error });
          return;
        }
        const cfg = ctx.cfg;
        const endpoint: ModelEndpoint = {
          name: parsed.name,
          baseURL: parsed.baseURL ?? cfg?.baseURL,
          apiKey: parsed.apiKey ?? cfg?.apiKey,
          userAgent: parsed.userAgent ?? cfg?.userAgent,
          // per-model variants：显式配置优先，未配则按模型名从数据源查表推导
          //（cfg.reasoningEffortOptions 默认 [] 是「未配置」语义——传 undefined 才走查表）
          reasoningEffortOptions: resolveReasoningEffortOptions(
            cfg?.reasoningEffortOptions?.length ? cfg.reasoningEffortOptions : undefined,
            parsed.name
          ),
          reasoningEffort: cfg?.reasoningEffort,
          // context 上限立即从数据源查表补缺（不配置则重启后由端点展开再补——这里让
          // footer 上下文段与 /model 菜单元数据当次会话即可见）
          limit: autoFillLimit(undefined, parsed.name),
        };
        const err = ctx.onAddModel?.(endpoint);
        if (err) {
          pushCmdLine(ctx.state, { kind: 'warn', text: err });
          return;
        }
        pushCmdLine(ctx.state, {
          kind: 'meta',
          text: `已添加并切换模型 → ${parsed.name}${endpoint.baseURL ? `（${endpoint.baseURL}）` : ''}`,
        });
        // 持久化：只写用户**显式给出**的字段（缺省字段运行时回退顶层即可，不烘焙进配置文件）；
        // 纯 JSON 配置文件自动追加；JSONC 提示手动添加（不破坏注释）
        if (cfg) {
          const res = persistModelToConfig(
            parsed.name,
            { baseURL: parsed.baseURL, apiKey: parsed.apiKey, userAgent: parsed.userAgent },
            cfg
          );
          pushCmdLine(ctx.state, { kind: res.ok ? 'meta' : 'warn', text: res.message });
        }
        return;
      }
      // /model <名称>：直接切换（不同模型可配不同端点，见 config models）。
      // 持久化：切换成功 → 记录待落盘意图（interactive 每轮写入配置文件顶层 model
      // 字段——用户要求切换后下次启动默认就是新模型）；只生效不弹提示面板（用户要求）
      const err = ctx.onSwitchModel?.(args);
      if (err) pushCmdLine(ctx.state, { kind: 'warn', text: err });
      else {
        ctx.state.modelSave = args;
      }
    },
  },
  {
    name: 'status',
    description: '查看当前会话状态（模型/权限/token/会话）',
    descriptionEn: 'View session status (model/permission/tokens/session)',
    run: (ctx) => {
      for (const line of statusReport({
        model: ctx.model ?? ctx.state.model,
        permission: ctx.state.permission,
        planMode: ctx.state.planMode,
        reasoningEffort: ctx.state.reasoningEffort || undefined,
        tokens: ctx.state.tokens,
        sessionPath: ctx.sessionPath,
        scaffolds: detectScaffolds(ctx.messages),
        sandbox: ctx.runOpts?.sandbox,
        trusted: ctx.runOpts?.trusted,
        memoryFiles: memoryFilesFromMessages(ctx.messages),
        globalMemory: ctx.messages.some((m) => typeof m.content === 'string' && m.content.startsWith('[全局记忆')),
        contextWindow: describeModelContextWindow(
          (ctx.runOpts?.models ?? []).find((m) => m.name === (ctx.model ?? ctx.state.model))?.limit?.context,
          ctx.model ?? ctx.state.model,
          (ctx.runOpts?.models ?? []).find((m) => m.name === (ctx.model ?? ctx.state.model))?.apiModel
        ),
      })) pushCmdLine(ctx.state, { kind: 'meta', text: line });
    },
  },
  {
    name: 'models',
    description: '模型能力快照：/models 查看状态 · /models refresh 在线更新（models.dev → 用户配置目录）',
    descriptionEn: 'Model snapshot: /models status · /models refresh online',
    run: async (ctx) => {
      const arg = (ctx.args ?? '').trim();
      if (!arg) {
        const info = snapshotInfo();
        pushCmdLine(ctx.state, { kind: 'meta', text: `模型能力快照：${info.source === 'user' ? '用户更新' : '内置快照'} · ${info.count} 模型 · 生成于 ${info.generatedAt.slice(0, 10)}（${info.ageDays} 天前）` });
        pushCmdLine(ctx.state, { kind: 'meta', text: '/models refresh 在线更新（models.dev → 用户配置目录，当前会话立即生效；默认不自动更新）' });
      } else if (arg === 'refresh') {
        pushCmdLine(ctx.state, { kind: 'meta', text: '正在拉取 models.dev 并重建快照…（无需 API Key）' });
        const res = await refreshModelContextSnapshot();
        if (res.ok) {
          pushCmdLine(ctx.state, { kind: 'meta', text: `✅ 快照已更新：${res.info.count} 模型 · 生成于 ${res.info.generatedAt.slice(0, 10)} · 当前会话立即生效` });
          pushCmdLine(ctx.state, { kind: 'meta', text: `已写入 ${res.info.userFile}（下次启动自动覆盖内置；删除该文件恢复内置快照）` });
        } else {
          pushCmdLine(ctx.state, { kind: 'warn', text: `✗ 快照更新失败：${res.error}（保留旧快照，可稍后重试）` });
        }
      } else {
        pushCmdLine(ctx.state, { kind: 'warn', text: `未知子命令「${arg}」——可用：/models（状态）· /models refresh（在线更新）` });
      }
    },
  },
  {
    name: 'context',
    description: '查看上下文用量（消息数/token 估算/已加载脚手架）',
    descriptionEn: 'View context usage (messages/token estimate/scaffolds)',
    run: (ctx) => {
      const summarizeAt = ctx.cfg?.summarizeAt ?? 40;
      const curEp = (ctx.runOpts?.models ?? []).find((m) => m.name === (ctx.model ?? ctx.state.model));
      for (const line of contextReport(
        ctx.messages,
        summarizeAt,
        describeModelContextWindow(curEp?.limit?.context, ctx.model ?? ctx.state.model, curEp?.apiModel),
        ctx.cfg?.contextCompressRatio
      ))
        pushCmdLine(ctx.state, { kind: 'meta', text: line });
    },
  },
  {
    name: 'export',
    description: '把当前会话导出为 Markdown 文件（.omni/）',
    descriptionEn: 'Export session to Markdown (.omni/)',
    autoClose: true,
    run: (ctx) => {
      const file = exportSession(ctx.messages, process.cwd());
      pushCmdLine(ctx.state, {
        kind: file ? 'meta' : 'warn',
        text: file ? `已导出会话 → ${file}（${ctx.messages.length} 条消息）` : '导出失败（无法写入 .omni/ 目录）',
      });
    },
  },
  {
    name: 'config',
    description: '查看/打开配置文件（TUI 下只显示路径，外部编辑后重启生效）',
    descriptionEn: 'View config files (paths; edit externally, restart to apply)',
    run: (ctx) => {
      if (!ctx.cfg) {
        pushCmdLine(ctx.state, { kind: 'warn', text: '配置信息不可用' });
        return;
      }
      for (const line of configReport(ctx.cfg)) pushCmdLine(ctx.state, { kind: 'meta', text: line });
      // TUI 全屏下不 spawn 编辑器（同一 TTY 冲突）；提示外部编辑
      pushCmdLine(ctx.state, {
        kind: 'meta',
        text: '编辑后重启生效（/exit 退出后用 $EDITOR 修改，或直接改全局 ~/.config/omni/omni.json）',
      });
    },
  },
  {
    name: 'mcp',
    description: '管理 MCP 服务器（列出/资源/提示词/增删/OAuth 登录）',
    descriptionEn: 'Manage MCP servers (list/resources/prompts/add/remove/login)',
    run: async (ctx) => {
      const servers = ctx.mcpServers ?? {};
      const names = Object.keys(servers);
      const handles = ctx.mcpHandles ?? [];
      const arg = (ctx.args ?? '').trim();
      // 子命令分发：resources / prompts / read / get / add / remove / login / reconnect
      const sub = arg.split(/\s+/)[0] ?? '';
      if (['resources', 'prompts', 'read', 'get', 'add', 'remove', 'login', 'reconnect'].includes(sub)) {
        await runMcpSub(ctx, sub, arg, servers, names, handles);
        return;
      }
      if (names.length === 0) {
        pushCmdLine(ctx.state, {
          kind: 'warn',
          text: '未配置 MCP 服务器（配置文件 mcpServers 字段；/mcp add <名称> <command> 或 --url <url> 添加；/mcp 查看全部子命令）',
        });
        return;
      }
      pushCmdLine(ctx.state, { kind: 'meta', text: `已配置 ${names.length} 个 MCP 服务器：${names.join('、')}` });
      const toolList = ctx.tools ?? [];
      // MCP 工具名带 server 前缀（server_tool）；delegate/skill 等基础工具不带下划线前缀区分
      const mcpToolNames = toolList.filter((t) => names.some((n) => t.name.startsWith(n.replace(/[^a-z0-9_]/gi, '_').toLowerCase() + '_')));
      if (mcpToolNames.length > 0) {
        pushCmdLine(ctx.state, { kind: 'meta', text: `已发现工具（${mcpToolNames.length}）：${mcpToolNames.map((t) => t.name).join('、')}` });
      } else {
        pushCmdLine(ctx.state, { kind: 'meta', text: '（尚未发现工具——服务器连接失败或未提供工具）' });
      }
      // 资源/提示词摘要
      for (const h of handles) {
        const bits: string[] = [];
        if (h.resources.length > 0) bits.push(`资源 ${h.resources.length} 个`);
        if (h.prompts.length > 0) bits.push(`提示词 ${h.prompts.length} 个`);
        if (h.instructions) bits.push('instructions ✓');
        if (bits.length > 0) pushCmdLine(ctx.state, { kind: 'meta', text: `  ${h.name}：${bits.join(' · ')}` });
      }
      pushCmdLine(ctx.state, { kind: 'meta', text: '子命令：resources / prompts / read <server> <uri> / get <server> <模板> / add / remove <name> / login <name> / reconnect' });
    },
  },
  {
    name: 'diff',
    description: '查看最近修改（git diff；--stat 只看统计 · --full 不截断）',
    descriptionEn: 'View uncommitted changes (git diff; --stat summary · --full untruncated)',
    run: async (ctx) => {
      const arg = (ctx.args ?? '').trim();
      const stat = /(?:^|\s)--stat(?=\s|$)/.test(arg);
      const full = /(?:^|\s)--full(?=\s|$)/.test(arg);
      pushCmdLine(ctx.state, { kind: 'meta', text: '正在收集 git diff…' });
      await ctx.session.paint().catch(() => {});
      const d = await collectDiff({ stat, full });
      if (!d.ok) {
        pushCmdLine(ctx.state, { kind: 'warn', text: `无法获取 git diff：${d.output.slice(0, 200)}` });
        return;
      }
      if (d.output === '（无改动）') {
        pushCmdLine(ctx.state, { kind: 'meta', text: '工作区没有未提交的改动' });
        return;
      }
      if (stat) {
        for (const l of d.output.split('\n')) pushCmdLine(ctx.state, { kind: 'answer', text: l });
        return;
      }
      const lines = d.output.split('\n');
      const shown = full ? lines : lines.slice(0, 60);
      pushCmdLine(ctx.state, { kind: 'meta', text: full ? `git diff（${lines.length} 行）：` : `git diff（${lines.length} 行，前 60 行）：` });
      for (const l of shown) pushCmdLine(ctx.state, { kind: 'answer', text: l });
      if (!full && lines.length > 60) pushCmdLine(ctx.state, { kind: 'meta', text: `… 还有 ${lines.length - 60} 行（/diff --full 查看全部）` });
    },
  },
  {
    name: 'rewind',
    description: '会话检查点：回滚工作区到任意历史回合（/rewind 列表 · /rewind <N> 恢复；文件回滚，对话保留）',
    descriptionEn: 'Session checkpoints: roll back workspace files to any past turn (/rewind list · /rewind <N> restore)',
    run: async (ctx) => {
      // /rewind：会话检查点（P0）——每轮用户消息提交时自动快照工作区修改文件
      // （.omni/checkpoints/<会话id>/，持久化——恢复会话后仍可用）。无参列出全部
      // （含与当前工作区的差异统计 = 可视化 P1）；<N> 恢复（只回滚文件，对话历史
      // 保留，恢复后注入 system 提示告知模型）。
      const arg = (ctx.args ?? '').trim();
      const cps = await loadCheckpoints(ctx.sessionPath);
      if (!arg) {
        if (cps.length === 0) {
          pushCmdLine(ctx.state, { kind: 'warn', text: '暂无检查点——对话轮次会自动打点（每轮用户消息提交时快照工作区修改文件）' });
          return;
        }
        pushCmdLine(ctx.state, { kind: 'meta', text: `会话检查点（${cps.length} 个，/rewind <序号> 回滚；Δ = 与当前工作区的差异）：` });
        for (const c of cps) {
          const stats = await checkpointDiffStats(c).catch(() => ({ add: 0, rem: 0, files: [] as string[] }));
          const delta = stats.add === 0 && stats.rem === 0 ? '· 与当前一致' : `· Δ +${stats.add} −${stats.rem} 行`;
          pushCmdLine(ctx.state, { kind: 'meta', text: `· ${checkpointSummaryLine(c)} ${delta}` });
        }
        return;
      }
      const n = Number(arg);
      if (!Number.isInteger(n) || !cps.some((c) => c.index === n)) {
        pushCmdLine(ctx.state, { kind: 'warn', text: `/rewind <序号>：序号须为已有检查点（${cps.map((c) => c.index).join('、') || '无'}）` });
        return;
      }
      const target = await loadCheckpoint(ctx.sessionPath, n);
      if (!target) return;
      const results = await restoreCheckpoint(target).catch(() => ['恢复失败']);
      pushCmdLine(ctx.state, { kind: 'meta', text: `已回滚到检查点 #${n}（${results.length} 个文件处理）：` });
      for (const r of results) pushCmdLine(ctx.state, { kind: 'meta', text: `· ${r}` });
      ctx.messages.push({ role: 'system', content: `[已执行 /rewind] 工作区已回滚到检查点 #${n}（用户消息「${target.userMessage.slice(0, 80)}」提交时的状态）。请勿再基于回滚前的文件内容操作。` });
      scheduleCmdPanelAutoClose(ctx.state, ctx.session);
    },
  },
  {
    name: 'rename',
    description: '重命名会话标题（/rename <标题>，显示为终端窗口标题）',
    descriptionEn: 'Rename session title (/rename <title>)',
    autoClose: true,
    run: (ctx) => {
      const title = (ctx.args ?? '').trim();
      if (!title) {
        pushCmdLine(ctx.state, {
          kind: 'warn',
          text: `用法：/rename <标题>（当前：${ctx.state.sessionTitle ?? '（未生成）'}）`,
        });
        return;
      }
      ctx.state.sessionTitle = title;
      setTerminalTitle(title);
      // 落盘到会话 meta（/resume 恢复时还原标题）
      if (ctx.sessionPath) void updateSessionTitle(ctx.sessionPath, title);
      pushCmdLine(ctx.state, { kind: 'meta', text: `会话标题已改为「${title}」（终端窗口标题）` });
    },
  },
  {
    name: 'fork',
    description: '从当前会话分叉出新会话（原会话不丢；/fork <N> 保留前 N 条消息）',
    descriptionEn: 'Fork a new session from current (original kept; /fork <N> keeps first N msgs)',
    run: async (ctx) => {
      const arg = (ctx.args ?? '').trim();
      const persistable = ctx.messages.filter(isPersistableSafe);
      // 无参：列出 fork 点（可保留的消息数），提示 /fork <N>
      if (!arg) {
        if (persistable.length === 0) {
          pushCmdLine(ctx.state, { kind: 'warn', text: '当前会话还没有可 fork 的消息（先聊几轮再 /fork）' });
          return;
        }
        pushCmdLine(ctx.state, {
          kind: 'meta',
          text: `当前会话 ${persistable.length} 条可保留消息。/fork <N> 保留前 N 条（1..${persistable.length}）：`,
        });
        for (let i = 0; i < persistable.length; i++) {
          const m = persistable[i];
          const who = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : m.role;
          const txt = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '').slice(0, 60);
          pushCmdLine(ctx.state, { kind: 'meta', text: `  ${i + 1}. [${who}] ${txt.slice(0, 60)}` });
        }
        return;
      }
      // /fork <N>：保留前 N 条消息
      const n = Number(arg);
      if (!Number.isInteger(n) || n < 1 || n > persistable.length) {
        pushCmdLine(ctx.state, { kind: 'warn', text: `/fork <N>：N 须为 1..${persistable.length} 的整数（当前 ${persistable.length} 条可保留消息）` });
        return;
      }
      if (!ctx.sessionPath) {
        pushCmdLine(ctx.state, { kind: 'warn', text: '当前会话未落盘（无法 fork——先产生至少一轮对话）' });
        return;
      }
      pushCmdLine(ctx.state, { kind: 'meta', text: `正在从第 ${n} 条消息分叉新会话…` });
      await ctx.session.paint().catch(() => {});
      const forkFile = await forkSession(ctx.sessionPath, n, process.cwd(), ctx.model ?? '');
      if (!forkFile) {
        pushCmdLine(ctx.state, { kind: 'warn', text: 'fork 失败（读会话或写文件出错）' });
        return;
      }
      const loaded = await loadSession(forkFile);
      if (!loaded) {
        pushCmdLine(ctx.state, { kind: 'warn', text: 'fork 失败（新会话不可读）' });
        return;
      }
      // 切换到新会话（onResume：替换 messages + 会话文件 + 回放历史）
      ctx.onResume?.(forkFile, loaded.messages);
      pushCmdLine(ctx.state, {
        kind: 'meta',
        text: `已分叉新会话 ${loaded.meta.id}（${loaded.messages.length} 条消息 · 原会话保留）`,
      });
      // 动作：fork 完成确认短暂停留后自动收起
      scheduleCmdPanelAutoClose(ctx.state, ctx.session);
    },
  },
  {
    name: 'send',
    description: '向指定会话发消息并取回结果（/send <会话id> <消息>）',
    descriptionEn: 'Send a message to another session and get the result (/send <id> <msg>)',
    run: async (ctx) => {
      const arg = (ctx.args ?? '').trim();
      const m = arg.match(/^(\S+)\s+([\s\S]+)$/);
      if (!m) {
        pushCmdLine(ctx.state, { kind: 'warn', text: '用法：/send <会话id> <消息>（目标会话在后台跑一轮，结果回传当前会话）' });
        return;
      }
      const targetId = m[1];
      const text = m[2].trim();
      // 校验目标会话存在
      const hit = await resolveSessionCandidates(ctx.state, targetId, ctx.sessionPath);
      if (!hit) return; // 未找到/歧义已提示
      if (!ctx.client || !ctx.model) {
        pushCmdLine(ctx.state, { kind: 'warn', text: '当前环境没有 LLM 客户端（无法运行目标会话）' });
        return;
      }
      pushCmdLine(ctx.state, { kind: 'meta', text: `正在向会话 ${hit.id} 发送消息并等待结果…` });
      await ctx.session.paint().catch(() => {});
      const result = await sendSessionMessage(
        hit.id, text, ctx.client, ctx.model,
        ctx.runOpts as never, ctx.out as never, ctx.messages
      );
      if (result === null) {
        pushCmdLine(ctx.state, { kind: 'warn', text: `发送失败（会话 ${hit.id} 不存在或运行出错）` });
        return;
      }
      // 结果注入当前上下文（system 消息，前缀标记），并显示摘要
      ctx.messages.push({ role: 'system', content: `[跨会话响应：会话 ${hit.id}]\n${result.slice(0, 2000)}` });
      pushCmdLine(ctx.state, { kind: 'meta', text: `✓ 会话 ${hit.id} 已回复：` });
      const lines = result.split('\n');
      for (const l of lines.slice(0, 10)) pushCmdLine(ctx.state, { kind: 'meta', text: `  ${l.slice(0, 90)}` });
      if (lines.length > 10) pushCmdLine(ctx.state, { kind: 'meta', text: `  … 共 ${lines.length} 行（完整结果已注入上下文）` });
      // 动作：发送完成确认短暂停留后自动收起
      scheduleCmdPanelAutoClose(ctx.state, ctx.session);
    },
  },
  {
    name: 'memory-apply',
    description: '应用待提交的项目记忆片段（.omni/memory-pending.md → 项目根 AGENTS.md）',
    descriptionEn: 'Apply pending project memory (.omni/memory-pending.md → root AGENTS.md)',
    autoClose: true,
    run: async (ctx) => {
      const res = await applyProjectMemoryPending(process.cwd());
      pushCmdLine(ctx.state, { kind: res.ok ? 'meta' : 'warn', text: res.message });
    },
  },
  {
    name: 'resume',
    description: '恢复历史会话（无参列出 / resume <id> 恢复）',
    descriptionEn: 'Resume a past session (no arg: list / resume <id>)',
    run: async (ctx) => {
      const id = (ctx.args ?? '').trim();
      if (!id) {
        const list = await listSessions();
        if (list.length === 0) {
          pushCmdLine(ctx.state, { kind: 'warn', text: '没有已保存的会话（交互模式退出时自动落盘；/resume <id> 恢复）' });
          return;
        }
        pushCmdLine(ctx.state, { kind: 'meta', text: `已保存 ${list.length} 个会话（/resume <id> 恢复；id 见 -l / --list-sessions）：` });
        for (const s of list.slice(0, 15)) pushCmdLine(ctx.state, { kind: 'meta', text: `· ${s.id} — ${s.title || '（无标题）'}（${s.messages} 条消息 · ${s.model}）` });
        if (list.length > 15) pushCmdLine(ctx.state, { kind: 'meta', text: `… 还有 ${list.length - 15} 个` });
        return;
      }
      // 支持 id 前缀匹配；多个命中时列出候选不静默选（与 /session 同逻辑）
      const hit = await resolveSessionCandidates(ctx.state, id, ctx.sessionPath);
      if (!hit) return;
      const loaded = await loadSession(hit.path);
      if (!loaded) {
        pushCmdLine(ctx.state, { kind: 'warn', text: `会话「${id}」加载失败` });
        return;
      }
      ctx.onResume?.(hit.path, loaded.messages);
      // 恢复会话标题（若有）→ 终端窗口标题
      if (loaded.meta.title) {
        ctx.state.sessionTitle = loaded.meta.title;
        setTerminalTitle(loaded.meta.title);
      }
      pushCmdLine(ctx.state, { kind: 'meta', text: `已恢复会话 ${loaded.meta.id}（${loaded.messages.length} 条消息 · 模型 ${loaded.meta.model}${loaded.meta.title ? ` · 标题「${loaded.meta.title}」` : ''}）` });
      // 动作：恢复完成确认短暂停留后自动收起（无参列出会话不设）
      scheduleCmdPanelAutoClose(ctx.state, ctx.session);
    },
  },
  {
    name: 'session',
    description: '会话管理：列出/继续当前目录的历史会话（/session all 全部 · /session <id> 直接继续）',
    descriptionEn: 'Session manager: list/continue sessions in cwd (/session all · <id>)',
    run: async (ctx) => {
      const arg = (ctx.args ?? '').trim();
      // /session <id>：加载历史会话并继续（支持 id 前缀匹配；ctx.onResume 由 interactive 组装：
      // 替换 messages + 会话文件 + 重置落盘计数 + 把历史回放进对话流）
      if (arg && arg !== 'all' && arg !== 'list') {
        // 支持 id 前缀匹配；多个命中时列出候选不静默选（避免继续到错误的会话）
        const hit = await resolveSessionCandidates(ctx.state, arg, ctx.sessionPath);
        if (!hit) return;
        const loaded = await loadSession(hit.path);
        if (!loaded) {
          pushCmdLine(ctx.state, { kind: 'warn', text: `会话「${arg}」加载失败` });
          return;
        }
        ctx.onResume?.(hit.path, loaded.messages);
        // 恢复会话标题（若有）→ 终端窗口标题
        if (loaded.meta.title) {
          ctx.state.sessionTitle = loaded.meta.title;
          setTerminalTitle(loaded.meta.title);
        }
        pushCmdLine(ctx.state, {
          kind: 'meta',
          text: `已继续会话 ${loaded.meta.id}（${loaded.messages.length} 条消息 · 模型 ${loaded.meta.model}${loaded.meta.title ? ` · 标题「${loaded.meta.title}」` : ''}）`,
        });
        // 动作：继续会话确认短暂停留后自动收起（/session all|list 列表不设）
        scheduleCmdPanelAutoClose(ctx.state, ctx.session);
        return;
      }
      // /session all|list：列出全部历史会话（跨目录）
      if (arg === 'all' || arg === 'list') {
        const all = await listSessions();
        if (all.length === 0) {
          pushCmdLine(ctx.state, {
            kind: 'warn',
            text: '没有已保存的会话（交互模式退出时自动落盘；/session 查看当前目录）',
          });
          return;
        }
        pushCmdLine(ctx.state, {
          kind: 'meta',
          text: `已保存 ${all.length} 个会话（/session <id> 继续；当前目录的会话用 /session 面板选择）：`,
        });
        for (const s of all.slice(0, 15)) {
          pushCmdLine(ctx.state, { kind: 'meta', text: `· ${s.id} — ${s.title || '（无标题）'}（${s.messages} 条消息 · ${s.model}）` });
        }
        if (all.length > 15) pushCmdLine(ctx.state, { kind: 'meta', text: `… 还有 ${all.length - 15} 个` });
        return;
      }
      // /session（无参）：打开面板列出当前目录（同目录）的历史会话，选择后继续
      await openSessionMenu(ctx.state, ctx.sessionPath);
    },
  },
  {
    name: 'redo',
    description: '重做上次撤销（all = 全部重做）',
    descriptionEn: 'Redo last undo (all = redo all)',
    autoClose: true,
    run: async (ctx) => {
      const stack = ctx.undoStack;
      if (!stack || stack.redoSize === 0) {
        pushCmdLine(ctx.state, { kind: 'warn', text: '没有可重做的操作（/undo 撤销后才有；新写入会清空 redo 历史）' });
        return;
      }
      const all = /(?:^|\s)all(?=\s|$)/.test(ctx.args ?? '');
      if (all) {
        const entries = stack.redoAll();
        const results: string[] = [];
        for (const e of entries) results.push(await applyUndo(e).catch(() => `重做失败：${e.path}`));
        pushCmdLine(ctx.state, { kind: 'meta', text: `已重做全部 ${results.length} 个操作` });
        for (const r of results) pushCmdLine(ctx.state, { kind: 'meta', text: `· ${r}` });
        ctx.messages.push({ role: 'system', content: `[已执行 /redo all] 已恢复 ${results.length} 个被撤销的写操作。` });
        return;
      }
      const entry = stack.redo();
      if (!entry) return;
      const msg = await applyUndo(entry).catch(() => `重做失败：${entry.path}`);
      const left = stack.redoSize;
      pushCmdLine(ctx.state, { kind: 'meta', text: left > 0 ? `${msg}（还有 ${left} 个可重做，/redo all 全部重做）` : `${msg}（无更多可重做）` });
      ctx.messages.push({ role: 'system', content: `[已执行 /redo] ${msg}。` });
    },
  },
  {
    name: 'trace',
    description: '展开 / 收起右侧轨迹面板（每轮请求/工具/消息账本）',
    descriptionEn: 'Toggle the right trace panel (per-turn request/tool/message ledger)',
    run: (ctx) => {
      // 右侧轨迹面板开关：刷新投影（数据源 = 事件记录器内存全量事件）后切换显示。
      // 展开时内容宽度收缩（computeRows 读 state.traceOpen），对话流右移不盖面板。
      if (ctx.events) refreshTrace(ctx.state, ctx.events.events);
      ctx.state.traceOpen = !ctx.state.traceOpen;
      if (!ctx.state.traceOpen) {
        ctx.state.traceSelected = -1;
        ctx.state.traceScroll = 0;
        ctx.state.traceDetail = null;
      }
    },
  },
  {
    name: 'help',
    description: '显示帮助',
    descriptionEn: 'Show help',
    // 帮助文本输出到**命令面板**（独立窗口，不混进对话流——用户要求所有命令输出
    // 弹窗展示；runCommand 已打开 /help 面板，这里只追加内容，按界面语言本地化）
    run: (ctx) => {
      const lang = ctx.state.language;
      pushCmdLine(ctx.state, { kind: 'meta', text: t(lang, 'help.intro') }, '/help');
      pushCmdLine(ctx.state, { kind: 'meta', text: t(lang, 'help.shortcuts') }, '/help');
      pushCmdLine(ctx.state, { kind: 'meta', text: t(lang, 'help.commands') }, '/help');
      pushCmdLine(ctx.state, { kind: 'meta', text: t(lang, 'help.scroll') }, '/help');
      pushCmdLine(ctx.state, { kind: 'meta', text: t(lang, 'help.more') }, '/help');
    },
  },
];

/** 按名称（含别名）查找命令，未找到返回 undefined */
export function findCommand(name: string): TuiCommand | undefined {
  const n = name.toLowerCase();
  return TUI_COMMANDS.find((c) => c.name === n || c.aliases?.includes(n));
}

/**
 * 命令联想（输入框以 / 开头时）：按 / 后面的前缀过滤注册表（名字与别名都匹配）。
 * 空查询返回全部命令；无匹配返回空数组（联想列表自动隐藏）。
 *
 * 刻意不 trim：Tab 填入的命令带尾空格（`/theme `）→ 查询 `theme ` 不再前缀匹配
 * → 联想自动隐藏（用户可直接 Enter 执行；继续输入则按新文本重新联想）。
 */
export function commandSuggestions(query: string): TuiCommand[] {
  const q = query.toLowerCase();
  if (!q) return TUI_COMMANDS;
  return TUI_COMMANDS.filter(
    (c) => c.name.startsWith(q) || c.aliases?.some((a) => a.startsWith(q))
  );
}

/** 主题选项（/settings theme 面板） */
const THEME_OPTIONS: { label: string; value: TuiThemeMode }[] = [
  { label: '跟随系统', value: 'system' },
  { label: '亮色', value: 'light' },
  { label: '深色', value: 'dark' },
];

/** 权限选项（/permission 面板）：低=read 只读 / 中=safe 标准（危险命令询问，默认）/ 高=ask 谨慎（全部询问）/ 全量=full 直通 */
export const PERMISSION_OPTIONS: { label: string; value: PermissionTier }[] = [
  { label: '低（只读）', value: 'read' },
  { label: '中（标准）', value: 'safe' },
  { label: '高（谨慎）', value: 'ask' },
  { label: '全量（直通）', value: 'full' },
];

/** 菜单选项 label 按界面语言取（value 对应 i18n key `menu.<kind>.<value>`；无对应 key 回退原 label） */
function menuLabel(state: TuiState, kind: string, opt: { label: string; value: string }): string {
  const s = t(state.language, `menu.${kind}.${opt.value}`);
  return s === `menu.${kind}.${opt.value}` ? opt.label : s;
}

/** 打开主题面板：高亮当前生效项，供 ↑/↓/数字 + Enter/Esc 操作 */
export function openThemeMenu(state: TuiState): void {
  // 面板是绝对定位浮层（menuOverlay），不依赖内容滚动位置，无需调整 scrollTop
  const current = state.themeMode;
  const idx = Math.max(
    0,
    THEME_OPTIONS.findIndex((o) => o.value === current)
  );
  state.menu = {
    id: 'theme',
    title: t(state.language, 'menu.theme.title'),
    options: THEME_OPTIONS.map((o) => ({ label: menuLabel(state, 'theme', o), value: o.value })),
    selectedIndex: idx,
    currentValue: current,
    scrollTop: 0,
  };
  state.status = t(state.language, 'menu.theme.status');
}

/**
 * 处理面板键盘输入（interactive.ts 在全局 keypress 里调用；返回是否消费了按键）。
 * ↑/↓：移动选择（选中项由渲染层 menuPanelRows 兜底收敛进窗口 = 窗口跟随滚动）；
 * 数字：选中**窗口内**第 N 项（与面板视觉一致；窗口外条目用 ↓ 滚动到达）；
 * Enter：确认；Esc：取消。
 */
export function handleMenuKey(key: TuiKey, state: TuiState): boolean {
  const menu = state.menu;
  if (!menu) return false;
  switch (key.name) {
    case 'up': {
      let i = menu.selectedIndex;
      for (let k = 0; k < menu.options.length; k++) {
        i = (i - 1 + menu.options.length) % menu.options.length;
        if (!menu.options[i]!.group) break;
      }
      menu.selectedIndex = i;
      return true;
    }
    case 'down': {
      let i = menu.selectedIndex;
      for (let k = 0; k < menu.options.length; k++) {
        i = (i + 1) % menu.options.length;
        if (!menu.options[i]!.group) break;
      }
      menu.selectedIndex = i;
      return true;
    }
    case 'return':
    case 'kpenter':
    case 'linefeed':
      confirmMenu(state);
      return true;
    case 'escape':
    case 'esc':
      closeMenu(state);
      return true;
    default: {
      // 数字键 1..9 直接选中（窗口内第 N 项；scrollTop 由渲染层收敛）
      const n = Number(key.name);
      if (Number.isInteger(n) && n >= 1 && n <= 9 && menu.scrollTop + n - 1 < menu.options.length) {
        let target = menu.scrollTop + n - 1;
        if (menu.options[target]?.group) { // 落在组头 → 顺延到下一个可选模型
          while (target < menu.options.length - 1 && menu.options[target]?.group) target++;
        }
        menu.selectedIndex = target;
        confirmMenu(state);
        return true;
      }
      return false;
    }
  }
}

/** 打开权限面板：高亮当前档位，供 ↑/↓/数字 + Enter/Esc 操作 */
export function openPermissionMenu(state: TuiState): void {
  const current = state.permission;
  const idx = Math.max(0, PERMISSION_OPTIONS.findIndex((o) => o.value === current));
  state.menu = {
    id: 'permission',
    title: t(state.language, 'menu.permission.title'),
    options: PERMISSION_OPTIONS.map((o) => ({ label: menuLabel(state, 'permission', o), value: o.value })),
    selectedIndex: idx,
    currentValue: current,
    scrollTop: 0,
  };
  state.status = t(state.language, 'menu.permission.status');
}

/**
 * 打开会话面板（/session）：列出**当前目录**（同目录 = 创建会话时的 cwd 与当前一致）的
 * 历史会话供选择继续，高亮当前正在继续的会话（若在列表内）；↑/↓/数字 + Enter/Esc 操作。
 * 列表**全量**放入 options——面板高度有限，渲染层按窗口滚动（menuPanelRows maxVisible），
 * 窗口外条目经 ↑/↓ 滚动到达（上下提示行显示剩余条数）。
 * 异步：面板选项需要先 listSessions 扫描磁盘。确认后 confirmMenu 只记录 intent
 * （state.sessionPick），interactive 每轮异步加载并恢复（与 /model 同模式）。
 */
export async function openSessionMenu(state: TuiState, sessionPath?: string | null): Promise<void> {
  const list = await listSessions(process.cwd());
  if (list.length === 0) {
    pushCmdLine(state, {
      kind: 'warn',
      text: '当前目录没有历史会话（交互模式退出时自动落盘；/session all 查看全部 · /session <id> 直接继续）',
    });
    return;
  }
  // 排除当前正在进行的会话（它的历史就是当前对话，继续它是无意义的）
  const currentId = sessionPath ? sessionIdFromPath(sessionPath) : '';
  const shown = list.filter((s) => s.id !== currentId);
  if (shown.length === 0) {
    pushCmdLine(state, {
      kind: 'warn',
      text: '当前目录没有可继续的历史会话（交互模式退出时自动落盘；/session all 查看全部）',
    });
    return;
  }
  state.menu = {
    id: 'session',
    title: t(state.language, 'menu.session.title'),
    options: shown.map((s) => ({
      // 只显示「标题 · N 条」—— 不显示模型名：对选择会话信息量低，且模型名
      // 超长会撑破面板（用户反馈「模型过长超出显示范围」；cardContentLine 另有兜底截断）。
      // 标题按显示列截断（CJK 全角 2 列）+ 省略号；无标题回退 id 前 16 字符。
      label: `${truncateToWidth(s.title || s.id.slice(0, 16), 24)} · ${s.messages} 条`,
      value: s.id,
    })),
    selectedIndex: 0,
    currentValue: '',
    scrollTop: 0,
  };
  state.status = t(state.language, 'menu.session.status');
}

/** 模型菜单条目：label 附元数据摘要（上下文/输出上限），value = 切换名 */
function modelMenuLabels(
  endpoints: import('../client.js').ModelEndpoint[],
  fallbackNames: string[]
): { label: string; value: string }[] {
  const names = fallbackNames.length > 0 ? fallbackNames : endpoints.map((m) => m.name);
  return names.map((n) => {
    const ep = endpoints.find((m) => m.name === n);
    const bits: string[] = [];
    if (ep?.provider) bits.push(ep.provider);
    if (ep?.limit?.context) bits.push(`${Math.round(ep.limit.context / 1000)}k`);
    if (ep?.limit?.output) bits.push(`出 ${Math.round(ep.limit.output / 1000)}k`);
    if (ep?.disabled) bits.push('已禁用');
    return { label: bits.length > 0 ? `${n} · ${bits.join(' · ')}` : n, value: n };
  });
}

/** 打开模型切换面板（/model）：列出可用模型（附元数据摘要），高亮当前；↑/↓/数字 + Enter/Esc 操作。
 *  endpoints 可选：存在 provider 分组时按 provider 插入组头行（dim、不可选中），
 *  全扁平（无 provider）时不插组头——面板形态与旧版完全一致。 */
export function openModelMenu(
  state: TuiState,
  entries: string[] | { label: string; value: string }[] = state.models,
  endpoints?: import('../client.js').ModelEndpoint[]
): void {
  const base = (entries.length > 0 ? entries : [state.model || 'gpt-4o-mini']).map((m) =>
    typeof m === 'string' ? { label: m, value: m } : m
  );
  const hasGroups = !!endpoints?.some((m) => m.provider);
  const options: { label: string; value: string; group?: boolean }[] = [];
  if (hasGroups) {
    let prev: string | null = null;
    for (const m of base) {
      const ep = endpoints?.find((e) => e.name === m.value);
      const g = ep?.provider ?? '';
      if (g !== prev) {
        options.push({ label: g ? `[${g}]` : t(state.language, 'menu.model.ungrouped'), value: '__group__', group: true });
        prev = g;
      }
      options.push({ ...m, value: g ? `${g}\u0000${m.value}` : m.value });
    }
  } else {
    options.push(...base);
  }
  const current = state.model;
  let idx = Math.max(0, options.findIndex((o) => o.value === current && !o.group));
  if (options[idx]?.group) idx = Math.max(0, options.findIndex((o) => !o.group)); // 兜底：初始不在组头
  state.menu = {
    id: 'model',
    title: t(state.language, 'menu.model.title'),
    options,
    selectedIndex: idx,
    currentValue: current,
    scrollTop: 0,
  };
  state.status = t(state.language, 'menu.model.status');
}

/** 打开思考级别面板（/variants）：字符串级别 + 命名 variants（1.0 P0-3）混合列表；
 *  命名项 value = `variant:<id>`，confirmMenu 据此前缀分流；↑/↓/数字 + Enter/Esc 操作 */
export function openVariantsMenu(
  state: TuiState,
  endpoints?: import('../client.js').ModelEndpoint[]
): void {
  const ep = endpoints?.find((m) => m.name === state.model);
  const efforts = (state.reasoningEffortOptions ?? []).map((v) => ({
    label: v,
    value: v,
  }));
  const named = Object.entries(ep?.variants ?? {}).map(([id, def]) => ({
    label: `${id}（命名${def.description ? ` · ${def.description}` : ''}${def.reasoningEffort ? ` · ${def.reasoningEffort}` : ''}）`,
    value: `variant:${id}`,
  }));
  // 档位与命名 variants 都没有才提示无可切换（有命名项时仍应列出——与 CLI /variants 同语义）
  if (efforts.length === 0 && named.length === 0) {
    state.menu = null;
    state.status = '';
    state.cmdPanel = {
      title: t(state.language, 'menu.variants.title'),
      lines: ['当前模型没有可切换的思考级别。'],
      scroll: 0,
    };
    return;
  }
  const options = [...efforts, ...named];
  const current = state.activeVariant ? `variant:${state.activeVariant}` : (state.reasoningEffort || '');
  const idx = Math.max(0, options.findIndex((o) => o.value === current));
  state.menu = {
    id: 'variants',
    title: t(state.language, 'menu.variants.title'),
    options,
    selectedIndex: idx,
    currentValue: current,
    scrollTop: 0,
  };
  state.status = t(state.language, 'menu.variants.status');
}

/** 环境诊断（/settings doctor）：输出 Node/Bun/API 连通性/配置健康检查报告到命令面板 */
async function runDoctor(ctx: TuiCommandContext): Promise<void> {
  if (!ctx.cfg) {
    pushCmdLine(ctx.state, { kind: 'warn', text: '配置信息不可用' });
    return;
  }
  pushCmdLine(ctx.state, { kind: 'meta', text: '正在诊断环境…' });
  await ctx.session.paint().catch(() => {});
  for (const line of await doctorReport(ctx.cfg)) pushCmdLine(ctx.state, { kind: 'meta', text: line });
}

/** 打开设置菜单（/settings）：列出可用设置项，选择后打开对应编辑器 */
export function openSettingsMenu(state: TuiState): void {
  state.menu = {
    id: 'settings',
    title: t(state.language, 'menu.settings.title'),
    options: [
      { label: t(state.language, 'settings.statusline'), value: 'statusline' },
      { label: t(state.language, 'settings.language'), value: 'language' },
      { label: t(state.language, 'settings.theme'), value: 'theme' },
      { label: t(state.language, 'settings.tokens'), value: 'tokens' },
      { label: t(state.language, 'settings.doctor'), value: 'doctor' },
    ],
    selectedIndex: 0,
    currentValue: '',
    scrollTop: 0,
  };
  state.status = t(state.language, 'menu.settings.status');
}

/** 打开语言面板（/settings language 或设置菜单选择语言）：中文 / English，Enter 确认即切换 */
export function openLanguageMenu(state: TuiState): void {
  state.menu = {
    id: 'language',
    title: t(state.language, 'menu.language.title'),
    options: TUI_LANGS.map((lg) => ({ label: TUI_LANG_LABELS[lg], value: lg })),
    selectedIndex: Math.max(0, TUI_LANGS.indexOf(state.language)),
    currentValue: state.language,
    scrollTop: 0,
  };
  state.status = t(state.language, 'menu.language.status');
}

/**
 * 打开状态行编辑器面板（/settings statusline）：
 * 列出全部段（按当前显示顺序），勾选态来自 state.statusline；
 * 空格 勾选/取消 · ←/→ 排序 · `a` 切换对齐（左/中/右）· Enter 保存生效 · Esc 取消（见 handleSettingsPanelKey）。
 */
export function openStatuslinePanel(state: TuiState): void {
  const order = state.statusline && state.statusline.length > 0 ? state.statusline : STATUSLINE_DEFAULT;
  const en = state.language === 'en';
  state.settingsPanel = {
    items: STATUSLINE_SEGMENTS.map((sg) => ({
      id: sg.id,
      label: en ? sg.labelEn : sg.label,
      enabled: order.includes(sg.id),
    })),
    selected: 0,
    align: state.statuslineAlign, // 工作副本：Enter 保存后写入 state.statuslineAlign 并持久化
  };
  state.status = en
    ? 'Status line: Space toggle · ←/→ reorder · a align · Enter save · Esc cancel'
    : '状态行：空格 勾选/取消 · ←/→ 排序 · a 对齐 · Enter 保存生效 · Esc 取消';
}

/** 交换数组中两个下标（状态行排序用） */
function swapItems<T>(arr: T[], a: number, b: number): void {
  const tmp = arr[a];
  arr[a] = arr[b]!;
  arr[b] = tmp!;
}

/**
 * 处理状态行面板键盘输入（interactive.ts 在全局 keypress 里调用；返回是否消费了按键）。
 * ↑/↓：移动高亮 · 空格：勾选/取消 · ←/→：排序（移动选中项）· `a`：循环切换对齐
 * （left → center → right）· Enter：保存生效 · Esc：取消。
 */
export function handleSettingsPanelKey(key: TuiKey, state: TuiState): boolean {
  const panel = state.settingsPanel;
  if (!panel) return false;
  const items = panel.items;
  const sel = panel.selected;
  switch (key.name) {
    case 'up':
      if (items.length > 0) panel.selected = (sel - 1 + items.length) % items.length;
      return true;
    case 'down':
      if (items.length > 0) panel.selected = (sel + 1) % items.length;
      return true;
    case 'space':
      if (items[sel]) items[sel]!.enabled = !items[sel]!.enabled;
      return true;
    case 'a':
      // 对齐循环：left → center → right → left（面板底部行即时高亮）
      panel.align = panel.align === 'left' ? 'center' : panel.align === 'center' ? 'right' : 'left';
      return true;
    case 'left':
      // ←：选中项左移一位（与前面一项交换顺序）
      if (sel > 0) {
        swapItems(items, sel, sel - 1);
        panel.selected = sel - 1;
      }
      return true;
    case 'right':
      // →：选中项右移一位
      if (sel < items.length - 1) {
        swapItems(items, sel, sel + 1);
        panel.selected = sel + 1;
      }
      return true;
    case 'return':
    case 'kpenter':
    case 'linefeed':
      saveStatusline(state);
      return true;
    case 'escape':
    case 'esc':
      closeStatuslinePanel(state);
      return true;
    default:
      return false;
  }
}

/**
 * 保存状态行（Enter）：按当前勾选与顺序应用到 state.statusline（footer 统计行
 * 立即按新配置重绘）、对齐方式应用到 state.statuslineAlign（footer 位置即时变化），
 * 并记录待持久化意图（interactive 每轮写入配置文件）。
 * **只生效不弹提示面板**（用户要求「做完设置不需要 pop 显示」）。
 */
export function saveStatusline(state: TuiState): void {
  const panel = state.settingsPanel;
  if (!panel) return;
  state.statusline = panel.items.filter((it) => it.enabled).map((it) => it.id);
  state.statuslineSave = [...state.statusline]; // 待落盘意图（interactive 消费）
  state.statuslineAlign = panel.align; // 对齐即时生效（render.ts infoRow 位置）
  state.statuslineAlignSave = panel.align; // 待落盘意图（随 statusline 一起持久化）
  state.settingsPanel = null;
  state.status = '';
}

/** 取消状态行编辑：关闭面板，不改变任何配置 */
export function closeStatuslinePanel(state: TuiState): void {
  state.settingsPanel = null;
  state.status = '';
}

/** 确认当前选项：按面板 id 分发处理（theme → 切换 themeMode；permission → 切换权限档位；variants → 思考级别），然后关闭面板 */
export function confirmMenu(state: TuiState): void {
  const menu = state.menu;
  if (!menu) return;
  const opt = menu.options[menu.selectedIndex];
  if (!opt || opt.group) return; // 组头行不可选中
  const lang = state.language;
  const label = opt.label; // 会话恢复等保留确认面板的菜单项用
  if (menu.id === 'theme') {
    // 切换主题：只生效不弹提示面板（用户要求「做完设置不需要 pop 显示」）
    state.themeMode = opt.value as TuiThemeMode;
  } else if (menu.id === 'permission') {
    // 切换权限档位：interactive 每轮把 state.permission 同步进 runOpts.permission
    // 并 setTier 到共用闸门（子代理同步）；只生效不弹提示面板
    state.permission = opt.value as PermissionTier;
  } else if (menu.id === 'variants') {
    // 切换思考级别 / 命名 variant（1.0 P0-3）：interactive 每轮消费 variantsSave——
    // `variant:<id>` 写 models."<模型>".variant 并同步 runOpts.activeVariant；
    // 普通级别同步 runOpts.reasoningEffort（loop 请求带 reasoning_effort）并清除命名叠加。
    // 只生效不弹提示面板（用户要求）
    if (opt.value.startsWith('variant:')) {
      const id = opt.value.slice('variant:'.length);
      state.activeVariant = id;
    } else {
      state.activeVariant = null;
      state.reasoningEffort = opt.value;
    }
    state.variantsSave = opt.value;
  } else if (menu.id === 'model') {
    // 切换模型：交给 interactive 的 switchModel 回调（重建 client + 更新 modelRuntime）。
    // confirmMenu 是纯 state 操作拿不到回调——这里只记录意图，interactive 每轮
    // 对比 state.model 与运行时模型，变了才真正切换（见 interactive.ts syncModel）。
    // 持久化：记录待落盘意图（interactive 每轮写入配置文件顶层 model 字段——
    // 用户要求切换后下次启动默认就是新模型）；只生效不弹提示面板
    const sep = opt.value.indexOf('\u0000');
    const provider = sep >= 0 ? opt.value.slice(0, sep) : '';
    const model = sep >= 0 ? opt.value.slice(sep + 1) : opt.value;
    state.model = model;
    state.modelProvider = provider || null;
    state.modelSave = model;
    // 即时应用（interactive 注入的 syncModel）：重建 client + footer 组名/思考级别/
    // 上下文上限/压缩预算随新模型刷新——此前只记录意图，要等下一次提交才生效
    state.applyModelSwitch?.();
  } else if (menu.id === 'session') {
    // 恢复会话：confirmMenu 是纯 state 操作拿不到回调——这里只记录意图
    // （state.sessionPick = 会话 id），interactive 每轮异步加载并恢复（见 interactive.ts）。
    state.sessionPick = opt.value;
    pushCmdLine(state, { kind: 'meta', text: tf(lang, 'confirm.session', { label }) }, '/session');
  } else if (menu.id === 'settings') {
    // 设置菜单：选择后打开对应设置编辑器。
    // statusline → settingsPanel 接管（关闭设置菜单；状态栏提示由 openStatuslinePanel 设置，不清空）；
    // language → menu 直接转换为语言面板（新面板接管，不关闭——否则语言面板闪现即关，
    // 用户反馈「单独点击语言没反应」的根因）
    if (opt.value === 'statusline') {
      openStatuslinePanel(state);
      state.menu = null;
    } else if (opt.value === 'language') {
      openLanguageMenu(state);
    } else if (opt.value === 'theme') {
      openThemeMenu(state);
    } else if (opt.value === 'tokens') {
      // 当次 token 统计开关：无编辑器面板，选择即切换（静默，同原 /tokens 命令）——
      // 关闭菜单 + 清状态栏；内容流里 tokens 模块即时出现/消失
      state.showTokens = !state.showTokens;
      state.menu = null;
      state.status = '';
    } else if (opt.value === 'doctor') {
      // 环境诊断：无编辑器面板，但执行需要 ctx（cfg + session.paint）——confirmMenu 是
      // 纯 state 操作拿不到 ctx，这里只记录意图，interactive 每轮命令分发前执行（同 sessionPick 模式）
      state.doctorPending = true;
      state.menu = null;
      state.status = '';
    }
    return;
  } else if (menu.id === 'language') {
    // 切换界面语言：立即生效（state.language 驱动全部界面 chrome 重绘），
    // 记录待持久化意图（interactive 每轮写入配置文件 language 字段）；
    // 只生效不弹提示面板（用户要求）
    const next = opt.value === 'zh' || opt.value === 'en' ? opt.value : 'zh';
    state.language = next;
    state.languageSave = next;
    state.menu = null;
    state.status = '';
    return;
  }
  state.menu = null;
  // 设置编辑器已接管状态栏提示（openStatuslinePanel 设置了操作说明），不再清空；
  // 其余单选面板确认后清空状态栏
  if (state.settingsPanel) return;
  state.status = '';
}

/** 取消面板：原样关闭（导出供测试/其它调用方复用） */
export function closeMenu(state: TuiState): void {
  state.menu = null;
  state.status = '';
}

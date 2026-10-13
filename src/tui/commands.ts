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
  buildRewindPreview,
  checkpointDiffStats,
  checkpointSummaryLine,
  createCheckpoint,
  executeRewind,
  loadCheckpoint,
  loadCheckpoints,
  parseRewindArgs,
  rewindModeLabel,
  type RewindMode,
} from '../agent/rewind.js';
import { truncateToWidth } from '../output/format.js';
import {
  createSkill,
  discoverSkills,
  loadSkillContent,
  parseSkillFindResults,
  parseSkillFrontmatter,
  refreshSkillInjections,
  removeSkill,
  runSkillsCli,
} from '../agent/skill.js';
import { summarizeContext } from '../agent/context.js';
import { runGoal, runOrchestrate } from '../agent/orchestrate.js';
import { collectDiff, detectCheckCommand, reviewCode, captureCommand } from '../agent/review.js';
import {
  detectScaffolds,
  doctorReport,
  exportSession,
  fullStatusReport,
  memoryFilesFromMessages,
  usageReport,
} from '../agent/report.js';
import {
  findSessionCandidates,
  listSessions,
  loadSession,
  sessionIdFromPath,
  updateSessionTitle,
  updateSessionMeta,
  resolveSessionTarget,
  isPersistable as isPersistableSafe,
  type SessionInfo,
} from '../agent/session.js';
import { resolveCdArg } from '../agent/workspace.js';
import { forkSession, sendSessionMessage } from '../agent/session-fork.js';
import { applyProjectMemoryPending } from '../agent/memory.js';
import type { McpServerConfig, McpServerHandle } from '../tools/mcp.js';
import { closeMcpClients, discoverMcpTools } from '../tools/mcp.js';
import type { OmniConfig } from '../config/index.js';
import { parseModelAddArgs, parseMcpAddArgs, persistContextLimitToConfig, persistGlobalBoolToConfig, persistMcpServerToConfig, removeMcpServerFromConfig, persistModelToConfig } from '../config/write.js';
import { autoFillLimit, CONTEXT_K_TIERS, describeModelContextWindow, formatTokenCount, parseContextSetArg, refreshModelContextSnapshot, resolveContextLimit, resolveReasoningEffortOptions, snapshotInfo } from '../config/model-context.js';
import { describeModelIntelligence } from '../config/model-pricing.js';
import type { ModelEndpoint } from '../client.js';
import { EventRecorder } from '../agent/events.js';
import { setTerminalTitle } from '../ui.js';
import { openCmdPanel, pushCmdLine, pushLine, type TuiLine, type TuiState, type TuiThemeMode } from './state.js';
import { formatSubagentLine, hydrateRegistryFromSession, subagentStatusLabel, type SubagentRecord } from '../agent/subagent-registry.js';
import { t, tf, TUI_LANG_LABELS, TUI_LANGS } from './i18n.js';
import {
  applyContextLimitChoice,
  openContextMenu,
  openLanguageMenu,
  openMcpMenu,
  openModelMenu,
  openPermissionMenu,
  openRewindMenu,
  openRewindModeMenu,
  openSessionMenu,
  openSettingsMenu,
  openSkillMenu,
  openTasksMenu,
  openThemeMenu,
  openVariantsMenu,
  pushHelpText,
  pushModelsStatus,
  pushSkillShow,
  resolveSessionCandidates,
  runMcpSub,
  scheduleCmdPanelAutoClose,
  taskDetailLines,
} from './commands-menus.js';

// 菜单/浮层逻辑抽出到 commands-menus.ts：保持对外导出路径 './commands.js' 不变
export {
  applyContextLimitChoice,
  closeMenu,
  confirmMenu,
  handleMenuKey,
  mcpServerDetailLines,
  openContextMenu,
  openLanguageMenu,
  openMcpMenu,
  openModelMenu,
  openPermissionMenu,
  openRewindMenu,
  openRewindModeMenu,
  openSessionMenu,
  openSettingsMenu,
  openSkillMenu,
  openTasksMenu,
  openThemeMenu,
  openVariantsMenu,
  PERMISSION_OPTIONS,
  pushHelpText,
  pushModelsStatus,
  pushSkillShow,
  scheduleCmdPanelAutoClose,
  taskDetailLines,
} from './commands-menus.js';

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
  /** 完整配置对象（/status /context /doctor 用；interactive 从 runOpts.cfg 传入） */
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
   * /new 新建会话回调（interactive 组装）：收尾旧会话文件 → 建新会话文件并切换 →
   * 清空对话/统计/撤销栈/hook 状态 → 回到 hero 初始态。返回错误信息或 null（成功）。
   */
  onNewSession?: () => Promise<string | null>;
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
   * 轨迹事件记录器（/compact 事件用；interactive 从 runOpts.events 传入）。
   * 事件源 = events.events（内存全量事件，含恢复的历史）。
   */
  events?: EventRecorder;
  /** Hooks 运行器（/clear 后 resetSessionStart；interactive 从 runOpts.hooks 传入） */
  hooks?: import('../hooks/index.js').HookRunner;
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
  /** 联想面板分组 id（缺省归 system；render 按 COMMAND_GROUP_ORDER 排序展示） */
  group?: CommandGroupId;
  /**
   * 执行型命令：run() 完成后面板短暂停留确认后**自动收起**（无需按 Esc）——
   * 适用于「做了某事 + 一句确认」的命令（/undo /init /rename 等）；
   * 需要阅读输出的列表型命令（/status /context /diff /review 等）不设此标记，面板保持打开。
   */
  autoClose?: boolean;
  run(ctx: TuiCommandContext): TuiCommandResult | Promise<TuiCommandResult>;
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
    pushCmdLine(ctx.state, { kind: 'warn', text: `未知命令 /${name}（/settings help 查看可用命令）` });
    // 纯提示（单行、无事发生）：短暂停留后自动收起，无需 Esc
    scheduleCmdPanelAutoClose(ctx.state, ctx.session);
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
    description: '切换安全权限（只读 / 请求批准 / 帮我批准 / 完全访问）',
    descriptionEn: 'Switch security level (read / safe / ask / full)',
    run: (ctx) => {
      // 未信任目录：强制只读，禁止提升档位（read 是工作区信任的硬约束，/permission 不能绕过）
      if (ctx.runOpts?.trusted === false) {
        pushCmdLine(ctx.state, {
          kind: 'warn',
          text: '当前目录未受信任——权限锁定为只读（read），无法提升。信任目录：首次进入时批准信任，或在已信任目录运行。',
        });
        // 纯提示（单行、无菜单）：短暂停留后自动收起，无需 Esc
        scheduleCmdPanelAutoClose(ctx.state, ctx.session);
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
    name: 'new',
    description: '新建会话并回到初始状态（旧会话保留，可 /session找回）',
    descriptionEn: 'Start a new session (old one kept, find it via /session)',
    autoClose: true, // 纯提示（单行确认）：执行完自动收起，无需 Esc
    run: async (ctx) => {
      if (!ctx.onNewSession) {
        pushCmdLine(ctx.state, { kind: 'warn', text: '当前环境不支持新建会话' });
        return;
      }
      const err = await ctx.onNewSession().catch((e) => String((e as Error)?.message ?? e));
      if (err) pushCmdLine(ctx.state, { kind: 'warn', text: err });
      else {
        pushCmdLine(ctx.state, { kind: 'meta', text: '已新建会话，回到初始状态（旧会话保留，可用 /session 找回）' });
        ctx.out.pushToast('✓ 已新建会话', 'success');
      }
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
    description: '技能管理：面板选择查看 / find <词> 网络检索 / add <repo> [--skill <名>] [--global] 安装 / show <名> / create <名> [描述] 新建 / delete <名> 删除',
    descriptionEn: 'Skill manager: panel select / find <query> / add <repo> [--skill <name>] [--global] / show <name> / create <name> [desc] / delete <name>',
    run: async (ctx) => {
      const args = (ctx.args ?? '').trim();
      if (!args) {
        await openSkillMenu(ctx.state);
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
        await pushSkillShow(ctx.state, showM[1]);
        return;
      }
      const createM = args.match(/^create\s+(\S+)(?:\s+([\s\S]+))?$/);
      if (createM) {
        const r = createSkill(createM[1], (createM[2] ?? '').trim());
        pushCmdLine(ctx.state, {
          kind: r.ok ? 'meta' : 'warn',
          text: r.ok ? `${r.message}（${r.path}，编辑 SKILL.md 后模型可用 skill 工具加载）` : r.message,
        });
        if (r.ok) scheduleCmdPanelAutoClose(ctx.state, ctx.session);
        return;
      }
      const deleteM = args.match(/^delete\s+(\S+)$/);
      if (deleteM) {
        const r = await removeSkill(deleteM[1]);
        pushCmdLine(ctx.state, { kind: r.ok ? 'meta' : 'warn', text: r.message });
        if (r.ok) scheduleCmdPanelAutoClose(ctx.state, ctx.session);
        return;
      }
      pushCmdLine(ctx.state, {
        kind: 'warn',
        text: '用法：/skill（面板选择查看）· /skill find <关键词>（网络检索）· /skill add <owner/repo> [--skill <名称>] [--global]（安装，本会话即时生效）· /skill show <名称>（查看内容）· /skill create <名称> [描述]（新建）· /skill delete <名称>（删除）',
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
        text: '说明：模型可用 delegate 工具把独立子任务委托给子代理（隔离上下文，可嵌套）；子代理共用安全闸门，权限与主代理一致（定义子代理可配独立权限）。/orchestrate 并行编排、/goal 目标机制见 /settings help。',
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
        // 纯提示（单行、 definitive 答案）：短暂停留后自动收起，无需 Esc
        scheduleCmdPanelAutoClose(ctx.state, ctx.session);
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
    name: 'btw',
    description: '旁问（/btw [--keep] <问题>）：不打断任务的侧问，只读工具查证，答案不进对话历史',
    descriptionEn: 'Side question (/btw [--keep] <q>): read-only lookup, answer kept out of history',
    run: async (ctx) => {
      // /btw：旁问——独立轻量请求 + 只读工具循环，转录不 push 回 messages；
      // --keep 时把 Q/A 作为 system 消息留在上下文（下次落盘随会话保存）。
      const { parseBtwArgs, askBtw, formatBtwNote } = await import('../agent/btw.js');
      const { keep, question } = parseBtwArgs(ctx.args ?? '');
      if (!question) {
        pushCmdLine(ctx.state, {
          kind: 'warn',
          text: '用法：/btw [--keep] <问题> —— 不打断任务的旁问（只读工具查证，答案不进对话历史；--keep 留在上下文）',
        });
        scheduleCmdPanelAutoClose(ctx.state, ctx.session);
        return;
      }
      const { client, model } = ctx;
      if (!client || !model) {
        pushCmdLine(ctx.state, { kind: 'warn', text: '/btw 需要 LLM 客户端（当前环境不可用）' });
        return;
      }
      pushCmdLine(ctx.state, { kind: 'meta', text: '旁问中（只读工具）…' });
      await ctx.session.paint().catch(() => {});
      const r = await askBtw(client, model, ctx.messages, question, {
        onTool: (name) => pushCmdLine(ctx.state, { kind: 'meta', text: `  · ${name}` }),
      });
      if (!r.ok) {
        pushCmdLine(ctx.state, { kind: 'warn', text: `旁问失败：${r.error ?? '未知错误'}` });
        return;
      }
      pushCmdLine(ctx.state, { kind: 'answer', text: r.answer || '（没有回答）' });
      pushCmdLine(ctx.state, {
        kind: 'meta',
        text: `旁问结束（${r.toolCalls} 次只读工具调用，未进入对话历史${keep ? '' : '；--keep 可留在上下文'}）`,
      });
      if (keep) {
        ctx.messages.push({ role: 'system', content: formatBtwNote(question, r.answer) });
        pushCmdLine(ctx.state, { kind: 'meta', text: '已留在对话上下文（--keep）' });
      }
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
    description: '设置（/settings language 界面语言；/settings theme 主题；/settings tokens 当次 token 统计；/settings doctor 环境诊断；/settings help 帮助；/settings models 模型能力快照）',
    descriptionEn: 'Settings (/settings language · /settings theme · /settings tokens · /settings doctor · /settings help · /settings models)',
    run: async (ctx) => {
      // /settings：列出可用设置项（面板选择后打开对应设置编辑器）；
      // /settings language：直接打开语言面板；/settings theme：直接打开主题面板；
      // /settings tokens：切换当次 token 统计显示（静默，同原 /tokens）；
      // /settings doctor：执行环境诊断（输出到命令面板，同原 /doctor）；
      // /settings help：输出帮助（原顶层 /help 已移入）；
      // /settings models [refresh]：模型能力快照状态/在线更新（原顶层 /models 已移入；
      // refresh 直接在 run 内执行——run 有完整 ctx（含 paint），无需意图模式）。
      const args = (ctx.args ?? '').trim();
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
      if (/^help(?:\s|$)/.test(args)) {
        pushHelpText(ctx.state);
        return;
      }
      if (/^models(?:\s|$)/.test(args)) {
        const sub = args.slice('models'.length).trim();
        if (!sub) {
          pushModelsStatus(ctx.state);
          return;
        }
        if (sub === 'refresh') {
          pushCmdLine(ctx.state, { kind: 'meta', text: '正在拉取 models.dev 并重建快照…（无需 API Key）' });
          const res = await refreshModelContextSnapshot();
          if (res.ok) {
            pushCmdLine(ctx.state, { kind: 'meta', text: `✓ 快照已更新：${res.info.count} 模型 · 生成于 ${res.info.generatedAt.slice(0, 10)} · 当前会话立即生效` });
            pushCmdLine(ctx.state, { kind: 'meta', text: `已写入 ${res.info.userFile}（下次启动自动覆盖内置；删除该文件恢复内置快照）` });
          } else {
            pushCmdLine(ctx.state, { kind: 'warn', text: `✗ 快照更新失败：${res.error}（保留旧快照，可稍后重试）` });
          }
          return;
        }
        pushCmdLine(ctx.state, { kind: 'warn', text: `未知子命令「${sub}」——可用：/settings models（状态）· /settings models refresh（在线更新）` });
        return;
      }
      if (!args) {
        openSettingsMenu(ctx.state);
        return;
      }
      pushCmdLine(ctx.state, { kind: 'warn', text: `未知设置「${args}」（可用：language 界面语言 · theme 主题 · tokens 当次 token 统计 · doctor 环境诊断 · help 帮助 · models 模型能力快照）` });
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
    description: '查看当前会话状态（含上下文用量：模型/权限/token/会话/窗口/压缩预算）',
    descriptionEn: 'View session status (model/permission/tokens/session/window/budget)',
    run: (ctx) => {
      const model = ctx.model ?? ctx.state.model;
      const curEp = (ctx.runOpts?.models ?? []).find((m) => m.name === model);
      const contextWindow = describeModelContextWindow(
        resolveContextLimit(ctx.cfg?.contextLimit, curEp?.limit?.context),
        model,
        curEp?.apiModel
      );
      for (const line of fullStatusReport({
        model,
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
        contextWindow,
        intelligence: describeModelIntelligence(model) ?? describeModelIntelligence(curEp?.apiModel),
      }, {
        messages: ctx.messages,
        summarizeAt: ctx.cfg?.summarizeAt ?? 40,
        compressRatio: ctx.cfg?.contextCompressRatio,
      })) pushCmdLine(ctx.state, { kind: 'meta', text: line });
    },
  },
  {
    name: 'usage',
    description: '会话 token 用量与成本估算',
    descriptionEn: 'Session token usage and cost estimate',
    run: (ctx) => {
      const model = ctx.model ?? ctx.state.model;
      const curEp = (ctx.runOpts?.models ?? []).find((m) => m.name === model);
      for (const line of usageReport(ctx.messages, model, {
        endpointPrice: curEp?.price,
        apiModel: curEp?.apiModel,
      })) pushCmdLine(ctx.state, { kind: 'meta', text: line });
    },
  },
  {
    name: 'context',
    description: '调整上下文窗口（面板选择，或 /context 256|400|512|750|1000 手动覆盖，单位 K；/context 默认 跟随模型自动）',
    descriptionEn: 'Set context window (panel select, or /context 256|400|512|750|1000 override in K; /context default for auto)',
    run: (ctx) => {
      const raw = (ctx.args ?? '').trim();
      const model = ctx.model ?? ctx.state.model;
      if (!raw) {
        const curEp = (ctx.runOpts?.models ?? []).find((m) => m.name === model);
        openContextMenu(ctx.state, ctx.cfg?.contextLimit, curEp?.limit?.context);
        return;
      }
      const parsed = parseContextSetArg(raw);
      if (parsed.kind === 'error') {
        pushCmdLine(ctx.state, { kind: 'warn', text: parsed.message });
        return;
      }
      if (parsed.kind === 'clear') {
        applyContextLimitChoice(ctx.state, ctx.cfg, ctx.runOpts, model, 'clear');
        // 纯提示（1~2 行确认）：短暂停留后自动收起，无需 Esc
        scheduleCmdPanelAutoClose(ctx.state, ctx.session);
        return;
      }
      if (parsed.kind === 'set') {
        applyContextLimitChoice(ctx.state, ctx.cfg, ctx.runOpts, model, parsed.tokens);
        // 纯提示（1~2 行确认）：短暂停留后自动收起，无需 Esc
        scheduleCmdPanelAutoClose(ctx.state, ctx.session);
        return;
      }
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
    name: 'mcp',
    description: '管理 MCP 服务器（面板选择查看详情 · resources / prompts / read / get / add / remove / login / reconnect）',
    descriptionEn: 'Manage MCP servers (panel select · resources/prompts/read/get/add/remove/login/reconnect)',
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
      if (sub) {
        pushCmdLine(ctx.state, { kind: 'warn', text: `未知子命令 /mcp ${sub}（可用：resources / prompts / read / get / add / remove / login / reconnect）` });
        return;
      }
      // 无参：打开选择面板（服务器列表 + 重连全部），选中查看详情
      openMcpMenu(ctx.state, servers, handles);
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
      const d = await collectDiff({ stat, full, includeUntracked: true });
      if (!d.ok) {
        pushCmdLine(ctx.state, { kind: 'warn', text: `无法获取 git diff：${d.output.slice(0, 200)}` });
        return;
      }
      if (d.output === '（无改动）') {
        pushCmdLine(ctx.state, { kind: 'meta', text: '工作区没有未提交的改动' });
        // 纯提示（单行、definitive 答案）：短暂停留后自动收起，无需 Esc
        scheduleCmdPanelAutoClose(ctx.state, ctx.session);
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
    description: '会话检查点三模式：/rewind 面板选择 · /rewind <N> 预览 · /rewind <N> --code|--chat|--both 执行',
    descriptionEn: 'Session checkpoints: /rewind panel · /rewind <N> preview · /rewind <N> --code|--chat|--both',
    run: async (ctx) => {
      // /rewind 三模式（P0）：无参开检查点面板；<N> 显示恢复前预览；<N> --mode 直接执行。
      const arg = (ctx.args ?? '').trim();
      if (!arg) {
        await openRewindMenu(ctx.state, ctx.sessionPath);
        return;
      }
      const cps = await loadCheckpoints(ctx.sessionPath);
      const parsed = parseRewindArgs(arg);
      if (!parsed.ok) {
        pushCmdLine(ctx.state, { kind: 'warn', text: parsed.error?.startsWith('未知参数') ? parsed.error : `/rewind <序号>：序号须为已有检查点（${cps.map((c) => c.index).join('、') || '无'}）` });
        return;
      }
      if (!cps.some((c) => c.index === parsed.index)) {
        pushCmdLine(ctx.state, { kind: 'warn', text: `/rewind <序号>：序号须为已有检查点（${cps.map((c) => c.index).join('、') || '无'}）` });
        return;
      }
      const target = await loadCheckpoint(ctx.sessionPath, parsed.index);
      if (!target) return;
      if ((parsed.mode === 'chat' || parsed.mode === 'both') && typeof target.msgCount !== 'number') {
        pushCmdLine(ctx.state, { kind: 'warn', text: `检查点 #${parsed.index} 无对话快照（旧版打点），仅支持 --code 回滚文件` });
        return;
      }
      // 带 --yes 或明确 --mode：直接执行；否则只做预览（恢复前 diff 面板），引导用户选模式
      const hasModeFlag = /\s(--code|--chat|--both|code|chat|both|conversation)\b/i.test(` ${arg} `);
      if (!parsed.yes && !hasModeFlag) {
        const { persistableMessages } = await import('../agent/session.js');
        const diff = await checkpointDiffStats(target).catch(() => ({ add: 0, rem: 0, files: [] as string[] }));
        for (const l of buildRewindPreview(target, diff, persistableMessages(ctx.messages).length, parsed.mode)) {
          pushCmdLine(ctx.state, { kind: 'meta', text: l });
        }
        pushCmdLine(ctx.state, { kind: 'meta', text: `执行：/rewind ${parsed.index} --code|--chat|--both（或面板选择模式）` });
        // 同步打开模式菜单供鼠标/键盘选择
        ctx.state.rewindPending = parsed.index;
        openRewindModeMenu(ctx.state, parsed.index);
        return;
      }
      const { fileResults, dropped } = await executeRewind(ctx.sessionPath, ctx.messages, target, parsed.mode).catch(() => ({ fileResults: ['恢复失败'] as string[], dropped: 0 }));
      pushCmdLine(ctx.state, { kind: 'meta', text: `已回滚到检查点 #${parsed.index}（${rewindModeLabel(parsed.mode)}）：` });
      if (parsed.mode === 'code' || parsed.mode === 'both') for (const r of fileResults) pushCmdLine(ctx.state, { kind: 'meta', text: `· ${r}` });
      if (parsed.mode === 'chat' || parsed.mode === 'both') pushCmdLine(ctx.state, { kind: 'meta', text: `· 对话截断 ${dropped} 条` });
      ctx.messages.push({ role: 'system', content: `[已执行 /rewind] 已回滚到检查点 #${parsed.index}（${rewindModeLabel(parsed.mode)}；用户消息「${target.userMessage.slice(0, 80)}」提交时的状态）。请勿再基于回滚前的文件内容操作。` });
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
    name: 'cd',
    description: '切换工作目录：/cd [路径]（无参显示当前；~ 展开）',
    descriptionEn: 'Change working directory: /cd [path] (no arg = show current)',
    group: 'system',
    autoClose: true, // 纯提示（单行确认）：执行完自动收起，无需 Esc
    run: (ctx) => {
      const resolved = resolveCdArg((ctx.args ?? '').trim(), process.cwd());
      if (resolved.kind === 'error') {
        pushCmdLine(ctx.state, { kind: 'warn', text: resolved.error });
      } else if (resolved.kind === 'show') {
        pushCmdLine(ctx.state, { kind: 'meta', text: `当前工作目录：${resolved.dir}` });
        ctx.out.pushToast(`当前工作目录：${resolved.dir}`, 'info');
      } else {
        try {
          process.chdir(resolved.dir);
          ctx.state.cwd = resolved.dir;
          pushCmdLine(ctx.state, { kind: 'meta', text: `工作目录已切换：${resolved.dir}` });
          ctx.out.pushToast('✓ 工作目录已切换', 'success');
        } catch (err) {
          pushCmdLine(ctx.state, { kind: 'warn', text: `切换失败：${err instanceof Error ? err.message : String(err)}` });
        }
      }
      ctx.state.schedulePaint?.();
    },
  },
  {
    name: 'pin',
    description: '置顶/取消置顶会话（无参 = 当前会话）：/pin [会话id]',
    descriptionEn: 'Pin/unpin a session (no arg = current)',
    group: 'session',
    run: async (ctx) => {
      const target = await resolveSessionTarget((ctx.args ?? '').trim(), ctx.sessionPath);
      if (!target.ok) {
        pushCmdLine(ctx.state, { kind: 'warn', text: target.error });
        for (const c of target.candidates ?? []) pushCmdLine(ctx.state, { kind: 'meta', text: `· ${c.id} — ${c.title || '（无标题）'}` });
      } else {
        const loaded = await loadSession(target.file);
        const next = !(loaded?.meta.pinned ?? false);
        await updateSessionMeta(target.file, { pinned: next });
        const msg = `${next ? '已置顶' : '已取消置顶'}会话 ${loaded?.meta.id ?? ''}`;
        pushCmdLine(ctx.state, { kind: 'meta', text: msg });
        ctx.out.pushToast(`✓ ${msg}`, 'success');
        // 纯提示（单行确认；歧义候选列表需阅读则驻留）：成功时短暂停留后自动收起，无需 Esc
        scheduleCmdPanelAutoClose(ctx.state, ctx.session);
      }
      ctx.state.schedulePaint?.();
    },
  },
  {
    name: 'archive',
    description: '归档会话（默认从列表隐藏，/session archived 查看）：/archive [会话id]',
    descriptionEn: 'Archive a session (hidden from lists): /archive [id]',
    group: 'session',
    run: async (ctx) => {
      const target = await resolveSessionTarget((ctx.args ?? '').trim(), ctx.sessionPath);
      if (!target.ok) {
        pushCmdLine(ctx.state, { kind: 'warn', text: target.error });
        for (const c of target.candidates ?? []) pushCmdLine(ctx.state, { kind: 'meta', text: `· ${c.id} — ${c.title || '（无标题）'}` });
      } else {
        const loaded = await loadSession(target.file);
        await updateSessionMeta(target.file, { archived: true });
        const msg = `已归档会话 ${loaded?.meta.id ?? ''}（/unarchive 取消归档）`;
        pushCmdLine(ctx.state, { kind: 'meta', text: msg });
        ctx.out.pushToast(`✓ ${msg}`, 'success');
        // 纯提示（单行确认；歧义候选列表需阅读则驻留）：成功时短暂停留后自动收起，无需 Esc
        scheduleCmdPanelAutoClose(ctx.state, ctx.session);
      }
      ctx.state.schedulePaint?.();
    },
  },
  {
    name: 'unarchive',
    description: '取消归档会话：/unarchive [会话id]',
    descriptionEn: 'Unarchive a session: /unarchive [id]',
    group: 'session',
    run: async (ctx) => {
      const target = await resolveSessionTarget((ctx.args ?? '').trim(), ctx.sessionPath);
      if (!target.ok) {
        pushCmdLine(ctx.state, { kind: 'warn', text: target.error });
        for (const c of target.candidates ?? []) pushCmdLine(ctx.state, { kind: 'meta', text: `· ${c.id} — ${c.title || '（无标题）'}` });
      } else {
        const loaded = await loadSession(target.file);
        await updateSessionMeta(target.file, { archived: false });
        const msg = `已取消归档会话 ${loaded?.meta.id ?? ''}`;
        pushCmdLine(ctx.state, { kind: 'meta', text: msg });
        ctx.out.pushToast(`✓ ${msg}`, 'success');
        // 纯提示（单行确认；歧义候选列表需阅读则驻留）：成功时短暂停留后自动收起，无需 Esc
        scheduleCmdPanelAutoClose(ctx.state, ctx.session);
      }
      ctx.state.schedulePaint?.();
    },
  },
  {
    name: 'auto',
    description: 'AI 自动审批开关：/auto [on|off]（需要审批的操作先经模型审阅，不改变权限/沙箱边界）',
    descriptionEn: 'AI auto-approval toggle: /auto [on|off]',
    group: 'system',
    autoClose: true, // 纯提示（2 行确认）：执行完自动收起，无需 Esc
    run: (ctx) => {
      const cfg = ctx.runOpts?.cfg;
      const arg = (ctx.args ?? '').trim().toLowerCase();
      const next = arg === 'on' ? true : arg === 'off' ? false : !(cfg?.autoReview === true);
      if (cfg) cfg.autoReview = next;
      const res = persistGlobalBoolToConfig('autoReview', next, '自动审批开关');
      pushCmdLine(ctx.state, { kind: 'meta', text: res.message });
      const msg = `AI 自动审批：${next ? '已开启（审阅失败自动回退人工审批）' : '已关闭'}`;
      pushCmdLine(ctx.state, { kind: 'meta', text: msg });
      ctx.out.pushToast(`✓ ${msg}`, 'success');
      ctx.state.schedulePaint?.();
    },
  },
  {
    name: 'vim',
    description: 'Vim 键位开关（输入框）：/vim [on|off]（Esc 进 normal / i 回 insert）',
    descriptionEn: 'Vim keybindings toggle: /vim [on|off]',
    group: 'system',
    autoClose: true, // 纯提示（2 行确认）：执行完自动收起，无需 Esc
    run: (ctx) => {
      const cfg = ctx.runOpts?.cfg;
      const arg = (ctx.args ?? '').trim().toLowerCase();
      const next = arg === 'on' ? true : arg === 'off' ? false : !(cfg?.vimMode === true);
      if (cfg) cfg.vimMode = next;
      ctx.state.vimMode = next;
      ctx.state.vimPending = '';
      if (!next) ctx.state.vimInsert = true;
      const res = persistGlobalBoolToConfig('vimMode', next, 'Vim 键位开关');
      pushCmdLine(ctx.state, { kind: 'meta', text: res.message });
      const msg = `Vim 键位：${next ? '已开启（Esc 进 normal 模式；再次 /vim off 关闭）' : '已关闭'}`;
      pushCmdLine(ctx.state, { kind: 'meta', text: msg });
      ctx.out.pushToast(`✓ ${msg}`, 'success');
      ctx.state.schedulePaint?.();
    },
  },
  {
    name: 'tasks',
    description: '子代理任务中心（Agent View）：/tasks [show <id> | resume <id> <追问> | stop <id|seq>]',
    descriptionEn: 'Subagent task center: /tasks [show <id> | resume <id> <msg> | stop <id|seq>]',
    group: 'agent',
    run: async (ctx) => {
      await hydrateRegistryFromSession(ctx.runOpts);
      const records = ctx.runOpts?.subagentRegistry?.records() ?? [];
      const arg = (ctx.args ?? '').trim();
      const [sub, idArg, ...rest] = arg ? arg.split(/\s+/) : [];
      const resolve = (key: string) =>
        records.find((r) => r.id === key) ?? records.filter((r) => r.id.startsWith(key));
      if (!arg) {
        if (records.length === 0) {
          pushCmdLine(ctx.state, {
            kind: 'meta',
            text: '本次会话还没有子代理（delegate / /orchestrate 之后这里可钻取/追问/停止）',
          });
          // 纯通告（单行、无事发生）：短暂停留后自动收起，无需 Esc
          scheduleCmdPanelAutoClose(ctx.state, ctx.session);
          return;
        }
        openTasksMenu(ctx.state, records);
        return;
      }
      if (sub === 'show' || sub === 'detail') {
        const hit = idArg ? resolve(idArg) : undefined;
        if (!hit || Array.isArray(hit)) {
          pushCmdLine(ctx.state, { kind: 'warn', text: '用法：/tasks show <id>（id 见 /tasks 列表）' });
          return;
        }
        openCmdPanel(ctx.state, `子代理 ${hit.id}`);
        for (const l of taskDetailLines(hit)) pushCmdLine(ctx.state, { kind: 'meta', text: l });
        ctx.state.schedulePaint?.();
        return;
      }
      if (sub === 'resume' || sub === 'ask') {
        const followUp = rest.join(' ').trim();
        const hit = idArg ? resolve(idArg) : undefined;
        if (!hit || Array.isArray(hit) || !followUp) {
          pushCmdLine(ctx.state, { kind: 'warn', text: '用法：/tasks resume <id> <追问内容>（对已完成的子代理带原上下文继续）' });
          return;
        }
        openCmdPanel(ctx.state, `子代理 ${hit.id} · 续跑`);
        pushCmdLine(ctx.state, { kind: 'meta', text: `续跑子代理 ${hit.id}（${hit.name}）…` });
        ctx.state.schedulePaint?.();
        const answer = await ctx.runOpts!.subagentRegistry!.resume(hit.id, followUp).catch((e) => `续跑失败：${e instanceof Error ? e.message : String(e)}`);
        pushCmdLine(ctx.state, {
          kind: answer == null ? 'warn' : 'answer',
          text: answer ?? '该子代理不支持续跑（记录缺少运行上下文）',
        });
        ctx.state.schedulePaint?.();
        return;
      }
      if (sub === 'stop') {
        let target = idArg ? resolve(idArg) : undefined;
        if (!target && idArg && /^\d+$/.test(idArg)) {
          const seq = Number(idArg);
          target = records.find((r) => r.seq === seq && r.status === 'running');
        }
        if (!target || Array.isArray(target)) {
          pushCmdLine(ctx.state, { kind: 'warn', text: '用法：/tasks stop <id|seq>（id/seq 见 /tasks 列表）' });
          return;
        }
        const ok = ctx.runOpts?.subagentRegistry?.stop(target.id) ?? false;
        const msg = ok ? `已请求停止子代理 ${target.id}` : `子代理 ${target.id} 不在运行中`;
        pushCmdLine(ctx.state, { kind: 'meta', text: msg });
        ctx.out.pushToast(ok ? `✓ ${msg}` : msg, ok ? 'success' : 'info');
        // 纯提示（单行确认）：短暂停留后自动收起，无需 Esc
        scheduleCmdPanelAutoClose(ctx.state, ctx.session);
        ctx.state.schedulePaint?.();
        return;
      }
      pushCmdLine(ctx.state, {
        kind: 'warn',
        text: `未知子命令「${sub}」——/tasks [show <id> | resume <id> <追问> | stop <id|seq>]`,
      });
      ctx.state.schedulePaint?.();
    },
  },
  {
    name: 'plugin',
    description: '插件管理：/plugin [list] · install <路径|git URL> --yes · remove <名> --yes · enable|disable <名>',
    descriptionEn: 'Plugins: /plugin [list] · install <path|git URL> --yes · remove/enable/disable <name>',
    group: 'system',
    run: async (ctx) => {
      const args = (ctx.args ?? '').trim();
      const [sub = '', ...rest] = args ? args.split(/\s+/) : [];
      const { listInstalledPlugins, enabledPluginNames, describePlugin, installPlugin, removePlugin, setEnabledPlugins } = await import('../agent/plugins.js');
      const { persistPluginListToGlobal } = await import('../config/write.js');
      const flagYes = rest.includes('--yes');
      const flagForce = rest.includes('--force');
      const positional = rest.filter((a) => !a.startsWith('--'));
      if (!sub || sub === 'list' || sub === 'ls') {
        const installed = listInstalledPlugins();
        if (installed.length === 0) {
          pushCmdLine(ctx.state, { kind: 'meta', text: '没有已安装插件。安装：/plugin install <路径|git URL> --yes（或 omni plugin install …）' });
          return;
        }
        const enabled = new Set(enabledPluginNames());
        pushCmdLine(ctx.state, { kind: 'meta', text: `已安装 ${installed.length} 个插件（★ = 已启用）：` });
        for (const p of installed) pushCmdLine(ctx.state, { kind: 'meta', text: `${enabled.has(p.manifest.name) ? '★' : '·'} ${describePlugin(p)}` });
        return;
      }
      if (sub === 'install') {
        const src = positional[0] ?? '';
        if (!src) {
          pushCmdLine(ctx.state, { kind: 'warn', text: '用法：/plugin install <本地路径|git URL> [--force] --yes' });
          return;
        }
        if (!flagYes) {
          pushCmdLine(ctx.state, { kind: 'warn', text: `将安装「${src}」并启用（hooks/MCP 会执行命令，请确认来源可信）。确认请加 --yes 重试。` });
          return;
        }
        const r = installPlugin(src, { force: flagForce });
        pushCmdLine(ctx.state, { kind: r.ok ? 'meta' : 'warn', text: r.message });
        if (r.ok && r.name) {
          const names = enabledPluginNames();
          if (!names.includes(r.name)) names.push(r.name);
          const pr = persistPluginListToGlobal(names);
          setEnabledPlugins(names);
          pushCmdLine(ctx.state, { kind: 'meta', text: pr.message });
          ctx.out.pushToast(`✓ ${r.message}`, 'success');
          // 纯提示（动作已完成）：短暂停留后自动收起，无需 Esc（失败时驻留供阅读）
          scheduleCmdPanelAutoClose(ctx.state, ctx.session);
          ctx.state.schedulePaint?.();
        }
        return;
      }
      if (sub === 'remove' || sub === 'rm') {
        const name = positional[0] ?? '';
        if (!name) { pushCmdLine(ctx.state, { kind: 'warn', text: '用法：/plugin remove <名称> --yes' }); return; }
        if (!flagYes) { pushCmdLine(ctx.state, { kind: 'warn', text: `将删除插件「${name}」。确认请加 --yes 重试。` }); return; }
        const r = removePlugin(name);
        pushCmdLine(ctx.state, { kind: r.ok ? 'meta' : 'warn', text: r.message });
        if (r.ok) {
          const names = enabledPluginNames().filter((n) => n !== name);
          const pr = persistPluginListToGlobal(names);
          setEnabledPlugins(names);
          pushCmdLine(ctx.state, { kind: 'meta', text: pr.message });
          ctx.out.pushToast(`✓ ${r.message}`, 'success');
          // 纯提示（动作已完成）：短暂停留后自动收起，无需 Esc（失败时驻留供阅读）
          scheduleCmdPanelAutoClose(ctx.state, ctx.session);
        }
        return;
      }
      if (sub === 'enable' || sub === 'disable') {
        const name = positional[0] ?? '';
        if (!name) { pushCmdLine(ctx.state, { kind: 'warn', text: `用法：/plugin ${sub} <名称>` }); return; }
        const installed = listInstalledPlugins();
        if (!installed.some((p) => p.manifest.name === name)) {
          pushCmdLine(ctx.state, { kind: 'warn', text: `插件未安装：${name}（/plugin list 查看）` });
          return;
        }
        const names = enabledPluginNames();
        const next = sub === 'enable' ? [...new Set([...names, name])] : names.filter((n) => n !== name);
        const pr = persistPluginListToGlobal(next);
        setEnabledPlugins(next);
        pushCmdLine(ctx.state, { kind: 'meta', text: pr.message });
        ctx.out.pushToast(`✓ ${pr.message}`, 'success');
        // 纯提示（单行确认）：短暂停留后自动收起，无需 Esc
        scheduleCmdPanelAutoClose(ctx.state, ctx.session);
        return;
      }
      pushCmdLine(ctx.state, { kind: 'warn', text: `未知子命令：plugin ${sub}（list/install/remove/enable/disable）` });
    },
  },
  {
    name: 'team',
    description: 'Team 任务看板：共享任务列表 + 未投递消息 + 子代理树（/orchestrate 动态工作流）',
    descriptionEn: 'Team task board: shared tasks + pending messages + subagent tree',
    group: 'agent',
    run: (ctx) => {
      const board = ctx.runOpts?.team;
      if (!board || board.tasks.length === 0) {
        pushCmdLine(ctx.state, { kind: 'meta', text: '任务看板为空（多代理协作时由主代理建任务；/orchestrate <任务> 走动态工作流）。' });
        // 纯通告（单行、无事发生）：短暂停留后自动收起，无需 Esc（有任务时驻留供阅读）
        scheduleCmdPanelAutoClose(ctx.state, ctx.session);
      } else {
        const done = board.tasks.filter((x) => x.status === 'completed').length;
        pushCmdLine(ctx.state, { kind: 'meta', text: `任务看板（${done}/${board.tasks.length} 完成）：` });
        for (const line of board.summaryLines()) pushCmdLine(ctx.state, { kind: 'meta', text: `· ${line}` });
      }
      const pending = board?.pendingCount('main') ?? 0;
      if (pending > 0) pushCmdLine(ctx.state, { kind: 'meta', text: `未投递消息：${pending} 条（主循环下一步注入）` });
      const runs = ctx.state.delegateRuns.filter((r) => !r.ended && !r.stopped);
      if (runs.length > 0) {
        pushCmdLine(ctx.state, { kind: 'meta', text: `子代理树（${runs.length} 运行中）：` });
        for (const r of runs) pushCmdLine(ctx.state, { kind: 'meta', text: `  └ ${r.name} · ${r.status}` });
      }
      ctx.state.schedulePaint?.();
    },
  },
  {
    name: 'session',
    description: '会话管理：列出/继续当前目录的历史会话（/session all 全部 · /session <id> 直接继续）',
    descriptionEn: 'Session manager: list/continue sessions in cwd (/session all · <id>)',
    run: async (ctx) => {
      const arg = (ctx.args ?? '').trim();
      // /session archived：查看已归档会话（/unarchive <id> 取消归档）
      if (arg === 'archived') {
        const currentId = ctx.sessionPath ? sessionIdFromPath(ctx.sessionPath) : '';
        const all = (await listSessions(undefined, { includeArchived: true })).filter((s) => s.archived && s.id !== currentId);
        if (all.length === 0) {
          pushCmdLine(ctx.state, { kind: 'warn', text: '没有已归档的会话（/archive 归档）' });
          return;
        }
        pushCmdLine(ctx.state, { kind: 'meta', text: `已归档 ${all.length} 个会话（/unarchive <id> 取消归档）：` });
        for (const s of all.slice(0, 15)) {
          pushCmdLine(ctx.state, { kind: 'meta', text: `· ${s.id} — ${s.title || '（无标题）'}（${s.messages} 条消息 · ${s.model}）` });
        }
        if (all.length > 15) pushCmdLine(ctx.state, { kind: 'meta', text: `… 还有 ${all.length - 15} 个` });
        return;
      }
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
      // /session all|list：列出全部历史会话（跨目录；默认隐藏归档）
      if (arg === 'all' || arg === 'list') {
        const all = (await listSessions(undefined, { includeArchived: false }));
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
          pushCmdLine(ctx.state, { kind: 'meta', text: `· ${s.pinned ? '★ ' : ''}${s.id} — ${s.title || '（无标题）'}（${s.messages} 条消息 · ${s.model}）` });
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
];

/** 按名称（含别名）查找命令，未找到返回 undefined */
export function findCommand(name: string): TuiCommand | undefined {
  const n = name.toLowerCase();
  return TUI_COMMANDS.find((c) => c.name === n || c.aliases?.includes(n));
}

/** / 联想面板分组（顺序即展示顺序；命令未显式分组归 system） */
export type CommandGroupId = 'session' | 'model' | 'agent' | 'system';
export const COMMAND_GROUP_ORDER: CommandGroupId[] = ['session', 'model', 'agent', 'system'];
const COMMAND_GROUPS: Record<string, CommandGroupId> = {
  session: 'session', resume: 'session', fork: 'session', send: 'session', clear: 'session',
  compact: 'session', rename: 'session', export: 'session', status: 'session', usage: 'session', context: 'session',
  rewind: 'session', undo: 'session', redo: 'session', diff: 'session',
  model: 'model', variants: 'model',
  agents: 'agent', orchestrate: 'agent', goal: 'agent', skill: 'agent',
  plan: 'agent', thinking: 'agent', review: 'agent', btw: 'agent', spec: 'agent',
};
/** 命令所属分组（条目 group 字段优先，未设查表，缺省 system） */
export function commandGroup(cmd: TuiCommand): CommandGroupId {
  return cmd.group ?? COMMAND_GROUPS[cmd.name] ?? 'system';
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
  const list = !q
    ? [...TUI_COMMANDS]
    : TUI_COMMANDS.filter(
      (c) => c.name.startsWith(q) || c.aliases?.some((a) => a.startsWith(q))
    );
  // 联想面板按分组展示：组顺序固定，组内保持注册表顺序（稳定排序）
  const rank = (c: TuiCommand): number => COMMAND_GROUP_ORDER.indexOf(commandGroup(c));
  return list
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .map(({ c }) => c);
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
    // 智能指数（OpenRouter artificial_analysis）：有才拼段，无则省略
    const intel = describeModelIntelligence(n) ?? describeModelIntelligence(ep?.apiModel);
    if (intel !== undefined) bits.push(`智能指数 ${intel}`);
    if (ep?.disabled) bits.push('已禁用');
    return { label: bits.length > 0 ? `${n} · ${bits.join(' · ')}` : n, value: n };
  });
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


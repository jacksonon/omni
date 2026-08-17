/**
 * Commands（/ 命令）框架：斜杠命令注册表 + 命令面板交互。
 *
 * 交互模式输入 `/xxx` 提交时，interactive.ts 调 runCommand 按命令名分发。
 * 带面板的命令（如 /permission、/settings 二级菜单）会打开一个圆角方框选项面板（state.menu）：
 * ↑/↓ 或数字键选择、Enter 确认、Esc 取消；面板打开时键盘事件由
 * handleMenuKey 消费（interactive.ts 在全局 keypress 里先于输入框拦截）。
 */
import type { TextareaRenderable } from '@opentui/core';
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
  discoverSkills,
  loadSkillContent,
  parseSkillFindResults,
  runSkillsCli,
} from '../agent/skill.js';
import { summarizeContext } from '../agent/context.js';
import { collectDiff, detectCheckCommand, reviewCode, captureCommand } from '../agent/review.js';
import {
  configReport,
  contextReport,
  detectScaffolds,
  doctorReport,
  exportSession,
  statusReport,
} from '../agent/report.js';
import {
  findSessionCandidates,
  listSessions,
  loadSession,
  sessionIdFromPath,
  updateSessionTitle,
  type SessionInfo,
} from '../agent/session.js';
import type { McpServerConfig } from '../tools/mcp.js';
import { closeMcpClients, discoverMcpTools } from '../tools/mcp.js';
import type { OmniConfig } from '../config/index.js';
import { parseModelAddArgs, persistModelToConfig, persistStatuslineToConfig } from '../config/write.js';
import { STATUSLINE_DEFAULT, STATUSLINE_SEGMENTS, type StatuslineSegment } from './layout.js';
import type { ModelEndpoint } from '../client.js';
import { EventRecorder } from '../agent/events.js';
import { refreshTrace } from './trace.js';
import { setTerminalTitle } from '../ui.js';
import { openCmdPanel, pushCmdLine, type StatuslinePanel, type TuiState, type TuiThemeMode } from './state.js';
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
  /** /undo 撤销栈（attachRuntime 创建，写入工具已包装快照；interactive 从 runOpts 传入） */
  undoStack?: UndoStack;
  /** 会话文件路径（/status 显示；interactive 从 runOpts.sessionPath 传入） */
  sessionPath?: string;
  /** 完整配置对象（/status /context /doctor /config 用；interactive 从 runOpts.cfg 传入） */
  cfg?: OmniConfig;
  /** MCP 服务器配置（/mcp 列出/重连；interactive 从 runOpts.mcpServers 传入） */
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * /mcp 重连回调（interactive 组装）：closeMcpClients + 重新 discover + 重建 runOpts.tools
   * （命令只调它，具体装配在 interactive——它有 runOpts）。
   */
  onReconnectMcp?: () => Promise<void>;
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
    run: (ctx) => openPermissionMenu(ctx.state),
  },
  {
    name: 'plan',
    description: '切换计划模式（只读调研，不修改文件）',
    descriptionEn: 'Toggle plan mode (read-only research)',
    run: (ctx) => {
      // 会话级开关：只对模型暴露只读工具（read_file/list_directory/search_code）+ 系统提示
      // 追加只读说明（loop 读 runOpts.planMode；interactive 每轮从 state 同步）。
      // footer 模型行显示「模型 X · 计划模式」作为常驻指示；不推 meta 提示文字。
      ctx.state.planMode = !ctx.state.planMode;
    },
  },
  {
    name: 'thinking',
    description: '展开 / 折叠全部思考过程',
    descriptionEn: 'Expand / collapse all thinking',
    run: (ctx) => {
      // 全局开关：buildBody 渲染时读取——展开=每个思考段落显示 `- thinking` 头行
      // （含思考时间）+ 内容（默认）；折叠=每个段落压成一行 `+ thinking`。
      // 会话级，/clear 不清除；切换时清空两个单独反例集合（避免残留用户点击的
      // 单条展开/收起覆盖全局态）。不推 meta 提示文字（用户要求：已折叠/已展开
      // 这类提示不要出现在对话流）。
      ctx.state.thinkingExpanded = !ctx.state.thinkingExpanded;
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
      const root = findProjectRoot(process.cwd());
      pushCmdLine(ctx.state, { kind: 'meta', text: `正在扫描项目并生成 AGENTS.md（项目根：${root}）…` });
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
      pushCmdLine(ctx.state, { kind: 'meta', text: `已生成 ${res.path}（下次会话自动加载为项目记忆）` });
    },
  },
  {
    name: 'skill',
    description: '技能管理：列出已发现 / find <词> 网络检索 / add <repo> [--skill <名>] 安装',
    descriptionEn: 'Skill manager: list / find <query> / add <repo> [--skill <name>]',
    run: async (ctx) => {
      // /skill：列出已发现的技能（.opencode/.claude/.agents/skills 下的 SKILL.md）；
      // /skill find <query>：走 npx skills find 网络检索 skills.sh（安装提示随结果输出）；
      // /skill add <owner/repo> [--skill <name>]：走 npx skills add 安装到 .agents/skills
      // （opencode 兼容目录，下次会话自动发现；本会话 skill 工具按 name 加载）。
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
        pushCmdLine(ctx.state, {
          kind: 'meta',
          text: `已发现 ${skills.length} 个技能（模型可用 skill 工具按 name 加载；/skill find 网络检索更多）：`,
        });
        for (const s of skills) {
          pushCmdLine(ctx.state, { kind: 'meta', text: `· ${s.name} — ${s.description}${s.global ? '（全局）' : ''}` });
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
      const addM = args.match(/^add\s+(\S+)(?:\s+--skill\s+(.+))?$/);
      if (addM) {
        const source = addM[1];
        const skillName = addM[2]?.trim();
        pushCmdLine(ctx.state, {
          kind: 'meta',
          text: `正在安装 ${source}${skillName ? ` 的 ${skillName}` : '（仓库全部技能）'}…（npx skills add，可能需要下载）`,
        });
        await ctx.session.paint().catch(() => {});
        const cliArgs = ['add', source, ...(skillName ? ['--skill', skillName] : []), '-y'];
        const { ok, output } = await runSkillsCli(cliArgs, 180_000);
        pushCmdLine(ctx.state, {
          kind: ok ? 'meta' : 'warn',
          text: ok
            ? '安装完成（已装入 .agents/skills 等目录，下次会话自动发现；本会话可用 /skill 查看已发现列表）'
            : `安装失败：${output.slice(0, 300) || 'npx skills 不可用'}`,
        });
        if (!ok && output) {
          for (const line of output.split('\n').slice(0, 10)) {
            if (line.trim()) pushCmdLine(ctx.state, { kind: 'meta', text: `· ${line}` });
          }
        }
        // 动作：安装完成确认短暂停留后自动收起（列表型子命令不设，见命令级无 autoClose）
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
        if (content) pushCmdLine(ctx.state, { kind: 'answer', text: content });
        return;
      }
      pushCmdLine(ctx.state, {
        kind: 'warn',
        text: '用法：/skill（列出已发现）· /skill find <关键词>（网络检索）· /skill add <owner/repo> [--skill <名称>]（安装）· /skill show <名称>（查看内容）',
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
    description: '查看子代理配置（模型 / 步骤上限 / 可用工具）',
    descriptionEn: 'View subagent config (model / max steps / tools)',
    run: (ctx) => {
      // /agents：展示当前子代理（delegate）配置——是否启用、模型、步骤上限、
      // 子代理可用工具。只读查看，不改变任何配置。
      const tools = ctx.tools ?? [];
      const hasDelegate = tools.some((t) => t.name === 'delegate');
      const subTools = tools.filter((t) => t.name !== 'delegate');
      pushCmdLine(ctx.state, { kind: 'meta', text: `子代理配置（delegate）：${hasDelegate ? '已启用' : '未启用（allowSubagents=false）'}` });
      pushCmdLine(ctx.state, { kind: 'meta', text: `· 模型：${ctx.model ?? '（未知）'}` });
      pushCmdLine(ctx.state, { kind: 'meta', text: `· 最大循环步数：${ctx.maxSubagentSteps ?? '（默认 10）'}` });
      pushCmdLine(ctx.state, { kind: 'meta', text: `· 子代理可用工具（${subTools.length}）：${subTools.map((t) => t.name).join('、')}` });
      pushCmdLine(ctx.state, {
        kind: 'meta',
        text: '说明：模型在任务中可用 delegate 工具把独立子任务委托给子代理（隔离上下文）；子代理共用安全闸门，权限与主代理一致。',
      });
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
    run: (ctx) => openVariantsMenu(ctx.state),
  },
  {
    name: 'settings',
    description: '设置（/settings statusline 配置底部状态行：空格勾选 · ←/→ 排序 · Enter 保存生效；/settings language 切换界面语言；/settings theme 切换主题；/settings tokens 显示 / 隐藏当次 token 统计；/settings doctor 环境诊断）',
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
      // /model：打开切换面板（↑↓/数字 + Enter）
      // /model <名称>：直接切换（交互模式已注册端点）
      // /model add <名称> [--base-url] [--api-key] [--user-agent]：
      //   解析 → 运行时注册（缺省字段回退顶层配置）→ 切换 → 持久化到配置文件
      const args = (ctx.args ?? '').trim();
      if (!args) {
        openModelMenu(ctx.state, ctx.models ?? []);
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
      // 字段——用户要求切换后下次启动默认就是新模型）
      const err = ctx.onSwitchModel?.(args);
      if (err) pushCmdLine(ctx.state, { kind: 'warn', text: err });
      else {
        ctx.state.modelSave = args;
        pushCmdLine(ctx.state, { kind: 'meta', text: `已切换模型 → ${args}` });
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
      })) pushCmdLine(ctx.state, { kind: 'meta', text: line });
    },
  },
  {
    name: 'context',
    description: '查看上下文用量（消息数/token 估算/已加载脚手架）',
    descriptionEn: 'View context usage (messages/token estimate/scaffolds)',
    run: (ctx) => {
      const summarizeAt = ctx.cfg?.summarizeAt ?? 40;
      for (const line of contextReport(ctx.messages, summarizeAt)) pushCmdLine(ctx.state, { kind: 'meta', text: line });
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
    description: '管理 MCP 服务器（列出已发现工具 / reconnect 重连）',
    descriptionEn: 'Manage MCP servers (list tools / reconnect)',
    run: async (ctx) => {
      const servers = ctx.mcpServers ?? {};
      const names = Object.keys(servers);
      if (names.length === 0) {
        pushCmdLine(ctx.state, {
          kind: 'warn',
          text: '未配置 MCP 服务器（配置文件 mcpServers 字段，如 { "demo": { "command": "node", "args": ["..."] } }）',
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
      if (/(?:^|\s)reconnect(?=\s|$)/.test(ctx.args ?? '')) {
        pushCmdLine(ctx.state, { kind: 'meta', text: '正在重连 MCP 服务器…' });
        await ctx.session.paint().catch(() => {});
        if (ctx.onReconnectMcp) {
          await ctx.onReconnectMcp();
          pushCmdLine(ctx.state, { kind: 'meta', text: '已重连（工具链已更新，新工具对模型可见）' });
          // 动作：重连完成确认短暂停留后自动收起
          scheduleCmdPanelAutoClose(ctx.state, ctx.session);
        }
      } else {
        pushCmdLine(ctx.state, { kind: 'meta', text: '用 /mcp reconnect 重连（改完配置文件后生效）' });
      }
    },
  },
  {
    name: 'diff',
    description: '查看最近修改（git diff 未提交改动）',
    descriptionEn: 'View uncommitted changes (git diff)',
    run: async (ctx) => {
      pushCmdLine(ctx.state, { kind: 'meta', text: '正在收集 git diff…' });
      await ctx.session.paint().catch(() => {});
      const d = await collectDiff();
      if (!d.ok) {
        pushCmdLine(ctx.state, { kind: 'warn', text: `无法获取 git diff：${d.output.slice(0, 200)}` });
        return;
      }
      if (d.output === '（无改动）') {
        pushCmdLine(ctx.state, { kind: 'meta', text: '工作区没有未提交的改动' });
        return;
      }
      const lines = d.output.split('\n');
      pushCmdLine(ctx.state, { kind: 'meta', text: `git diff（${lines.length} 行，前 60 行）：` });
      for (const l of lines.slice(0, 60)) pushCmdLine(ctx.state, { kind: 'answer', text: l });
      if (lines.length > 60) pushCmdLine(ctx.state, { kind: 'meta', text: `… 还有 ${lines.length - 60} 行（git diff 查看全部）` });
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
  };
  state.status = t(state.language, 'menu.theme.status');
}

/**
 * 处理面板键盘输入（interactive.ts 在全局 keypress 里调用；返回是否消费了按键）。
 * ↑/↓/数字：移动选择；Enter：确认；Esc：取消。
 */
export function handleMenuKey(key: TuiKey, state: TuiState): boolean {
  const menu = state.menu;
  if (!menu) return false;
  switch (key.name) {
    case 'up':
      menu.selectedIndex = (menu.selectedIndex - 1 + menu.options.length) % menu.options.length;
      return true;
    case 'down':
      menu.selectedIndex = (menu.selectedIndex + 1) % menu.options.length;
      return true;
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
      // 数字键 1..9 直接选中
      const n = Number(key.name);
      if (Number.isInteger(n) && n >= 1 && n <= menu.options.length) {
        menu.selectedIndex = n - 1;
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
  };
  state.status = t(state.language, 'menu.permission.status');
}

/**
 * 打开会话面板（/session）：列出**当前目录**（同目录 = 创建会话时的 cwd 与当前一致）的
 * 历史会话供选择继续，高亮当前正在继续的会话（若在列表内）；↑/↓/数字 + Enter/Esc 操作。
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
  // 面板高度有限（menuPanelRows 逐行渲染），最多列 9 条——其余用 /session <id> 或 /session all；
  // 排除当前正在进行的会话（它的历史就是当前对话，继续它是无意义的）
  const currentId = sessionPath ? sessionIdFromPath(sessionPath) : '';
  const shown = list.filter((s) => s.id !== currentId).slice(0, 9);
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
      label: `${s.title || s.id.slice(0, 16)} · ${s.messages} 条 · ${s.model}`,
      value: s.id,
    })),
    selectedIndex: 0,
    currentValue: '',
  };
  state.status = t(state.language, 'menu.session.status');
}

/** 打开模型切换面板（/model）：列出可用模型，高亮当前；↑/↓/数字 + Enter/Esc 操作 */
export function openModelMenu(state: TuiState, models: string[] = state.models): void {
  const options = (models.length > 0 ? models : [state.model || 'gpt-4o-mini']).map((m) => ({
    label: m,
    value: m,
  }));
  const current = state.model;
  const idx = Math.max(0, options.findIndex((o) => o.value === current));
  state.menu = {
    id: 'model',
    title: t(state.language, 'menu.model.title'),
    options,
    selectedIndex: idx,
    currentValue: current,
  };
  state.status = t(state.language, 'menu.model.status');
}

/** 打开思考级别面板（/variants）：高亮当前级别，供 ↑/↓/数字 + Enter/Esc 操作 */
export function openVariantsMenu(state: TuiState): void {
  const options = (state.reasoningEffortOptions ?? ['low', 'medium', 'high']).map((v) => ({
    label: v,
    value: v,
  }));
  const current = state.reasoningEffort || '';
  const idx = Math.max(0, options.findIndex((o) => o.value === current));
  state.menu = {
    id: 'variants',
    title: t(state.language, 'menu.variants.title'),
    options,
    selectedIndex: idx,
    currentValue: current,
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
  };
  state.status = t(state.language, 'menu.language.status');
}

/**
 * 打开状态行编辑器面板（/settings statusline）：
 * 列出全部段（按当前显示顺序），勾选态来自 state.statusline；
 * 空格 勾选/取消 · ←/→ 排序 · Enter 保存生效 · Esc 取消（见 handleSettingsPanelKey）。
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
  };
  state.status = en
    ? 'Status line: Space toggle · ←/→ reorder · Enter save · Esc cancel'
    : '状态行：空格 勾选/取消 · ←/→ 排序 · Enter 保存生效 · Esc 取消';
}

/** 交换数组中两个下标（状态行排序用） */
function swapItems<T>(arr: T[], a: number, b: number): void {
  const tmp = arr[a];
  arr[a] = arr[b]!;
  arr[b] = tmp!;
}

/**
 * 处理状态行面板键盘输入（interactive.ts 在全局 keypress 里调用；返回是否消费了按键）。
 * ↑/↓：移动高亮 · 空格：勾选/取消 · ←/→：排序（移动选中项）· Enter：保存生效 · Esc：取消。
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
 * 立即按新配置重绘——让配置生效），并记录待持久化意图（interactive 每轮写入配置文件）。
 * 提示进命令面板（执行型：稍后自动收起）。
 */
export function saveStatusline(state: TuiState): void {
  const panel = state.settingsPanel;
  if (!panel) return;
  state.statusline = panel.items.filter((it) => it.enabled).map((it) => it.id);
  state.statuslineSave = [...state.statusline]; // 待落盘意图（interactive 消费）
  state.settingsPanel = null;
  state.status = '';
  const en = state.language === 'en';
  if (state.statusline.length === 0) {
    pushCmdLine(state, { kind: 'meta', text: en ? 'Status line saved (all segments off → hidden)' : '已保存状态行（全部段已取消 → 底部不显示统计信息）' }, '/settings statusline');
  } else {
    const labels = state.statusline
      .map((id) => STATUSLINE_SEGMENTS.find((sg) => sg.id === id))
      .filter((sg): sg is StatuslineSegment => !!sg)
      .map((sg) => (en ? sg.labelEn : sg.label))
      .join(' · ');
    pushCmdLine(state, { kind: 'meta', text: en ? `Status line saved (${state.statusline.length} items): ${labels}` : `已保存状态行（${state.statusline.length} 项）：${labels}` }, '/settings statusline');
  }
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
  const label = opt.label;
  const lang = state.language;
  if (menu.id === 'theme') {
    state.themeMode = opt.value as TuiThemeMode;
    pushCmdLine(state, { kind: 'meta', text: tf(lang, 'confirm.theme', { label }) }, '/settings theme');
  } else if (menu.id === 'permission') {
    // 切换权限档位：interactive 每轮把 state.permission 同步进 runOpts.permission
    // 并 setTier 到共用闸门（子代理同步）；meta 提示当前档位语义
    state.permission = opt.value as PermissionTier;
    pushCmdLine(state, { kind: 'meta', text: tf(lang, 'confirm.permission', { label }) }, '/permission');
  } else if (menu.id === 'variants') {
    // 切换思考级别：interactive 每轮把 state.reasoningEffort 同步进 runOpts.reasoningEffort
    // （loop 请求带 reasoning_effort 参数；网关不认自动回退不带）。
    // 持久化：记录待落盘意图（interactive 每轮写入配置文件 reasoningEffort 字段——
    // 用户要求切换后下次启动仍是新思考级别）
    state.reasoningEffort = opt.value;
    state.variantsSave = opt.value;
    pushCmdLine(state, { kind: 'meta', text: tf(lang, 'confirm.variants', { label }) }, '/variants');
  } else if (menu.id === 'model') {
    // 切换模型：交给 interactive 的 switchModel 回调（重建 client + 更新 modelRuntime）。
    // confirmMenu 是纯 state 操作拿不到回调——这里只记录意图，interactive 每轮
    // 对比 state.model 与运行时模型，变了才真正切换（见 interactive.ts syncModel）。
    // 持久化：记录待落盘意图（interactive 每轮写入配置文件顶层 model 字段——
    // 用户要求切换后下次启动默认就是新模型）
    state.model = opt.value;
    state.modelSave = opt.value;
    pushCmdLine(state, { kind: 'meta', text: tf(lang, 'confirm.model', { label }) }, '/model');
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
    // 记录待持久化意图（interactive 每轮写入配置文件 language 字段）
    const next = opt.value === 'zh' || opt.value === 'en' ? opt.value : 'zh';
    state.language = next;
    state.languageSave = next;
    pushCmdLine(state, { kind: 'meta', text: tf(lang, 'confirm.language', { label }) }, '/settings language');
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

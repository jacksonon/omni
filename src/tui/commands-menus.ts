/**
 * TUI 命令菜单 / 浮层（从 commands.ts 抽出）：
 * 命令面板选项面板的开合、键盘处理与确认分支（theme / permission / session / rewind /
 * skill / tasks / mcp / context / model / variants / settings / language）。
 *
 * 这些函数基本是**纯 state 操作**（只写 state.menu，或记录待消费意图 state.xxxPick），
 * 异步项（会话/检查点/技能）先加载再开面板，真正执行由 interactive.ts 每轮消费。
 * 由 commands.ts re-export，保持对外引用路径 './commands.js' 不变。
 */
import type { TuiKey } from './render.js';
import type { PermissionTier } from '../safety/policy.js';
import { truncateToWidth } from '../output/format.js';
import { listSessions, sessionIdFromPath, findSessionCandidates, type SessionInfo } from '../agent/session.js';
import { checkpointDiffStats, checkpointSummaryLine, loadCheckpoints } from '../agent/rewind.js';
import { discoverSkills, loadSkillContent, parseSkillFrontmatter } from '../agent/skill.js';
import { formatSubagentLine, subagentStatusLabel, type SubagentRecord } from '../agent/subagent-registry.js';
import type { McpServerConfig, McpServerHandle } from '../tools/mcp.js';
import type { OmniConfig } from '../config/index.js';
import { persistContextLimitToConfig, parseMcpAddArgs, persistMcpServerToConfig, removeMcpServerFromConfig } from '../config/write.js';
import { CONTEXT_K_TIERS, formatTokenCount, snapshotInfo } from '../config/model-context.js';
import { pushCmdLine, type TuiState, type TuiThemeMode } from './state.js';
import { t, tf, TUI_LANG_LABELS, TUI_LANGS } from './i18n.js';
import type { TuiCommandContext } from './commands.js';

/** 帮助文本输出到命令面板（/settings help 与菜单 help 项共用；顶层 /help 已移入 settings） */
export function pushHelpText(state: TuiState): void {
  const lang = state.language;
  pushCmdLine(state, { kind: 'meta', text: t(lang, 'help.intro') }, '/settings help');
  pushCmdLine(state, { kind: 'meta', text: t(lang, 'help.shortcuts') }, '/settings help');
  pushCmdLine(state, { kind: 'meta', text: t(lang, 'help.commands') }, '/settings help');
  pushCmdLine(state, { kind: 'meta', text: t(lang, 'help.scroll') }, '/settings help');
  pushCmdLine(state, { kind: 'meta', text: t(lang, 'help.more') }, '/settings help');
}

/** 模型能力快照状态输出到命令面板（/settings models 共用；顶层 /models 已移入 settings） */
export function pushModelsStatus(state: TuiState): void {
  const info = snapshotInfo();
  pushCmdLine(state, { kind: 'meta', text: `模型能力快照：${info.source === 'user' ? '用户更新' : '内置快照'} · ${info.count} 模型 · 生成于 ${info.generatedAt.slice(0, 10)}（${info.ageDays} 天前）` });
  pushCmdLine(state, { kind: 'meta', text: '/settings models refresh 在线更新（models.dev → 用户配置目录，当前会话立即生效；默认不自动更新）' });
}
/** 主题选项（/settings theme 面板） */
const THEME_OPTIONS: { label: string; value: TuiThemeMode }[] = [
  { label: '跟随系统', value: 'system' },
  { label: '亮色', value: 'light' },
  { label: '深色', value: 'dark' },
];

/** 权限选项（/permission 面板，放行程度升序，与 Web 输入区面板一致）：read 只读 / ask 请求批准（全部询问）/ safe 帮我批准（危险命令询问，默认）/ full 完全访问（直通） */
export const PERMISSION_OPTIONS: { label: string; value: PermissionTier }[] = [
  { label: '只读', value: 'read' },
  { label: '请求批准', value: 'ask' },
  { label: '帮我批准', value: 'safe' },
  { label: '完全访问', value: 'full' },
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
  const list = await listSessions(process.cwd(), { includeArchived: false });
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
      // 标题居左、条数右对齐（menuPanelRows 按 right 撑满整行）—— 不显示模型名：
      // 对选择会话信息量低，且模型名超长会撑破面板（用户反馈「模型过长超出显示范围」；
      // cardContentLine 另有兜底截断）。标题按显示列截断（CJK 全角 2 列）+ 省略号；
      // 无标题回退 id 前 16 字符。
      label: `${s.pinned ? '★ ' : ''}${truncateToWidth(s.title || s.id.slice(0, 16), 24)}`,
      right: `${s.messages} 条`,
      value: s.id,
    })),
    selectedIndex: 0,
    currentValue: '',
    scrollTop: 0,
  };
}

/**
 * 检查点选择面板：列出全部检查点（含与当前工作区的差异统计），选中后开模式菜单
 * （state.rewindPending = 序号，openRewindModeMenu 接管），interactive 每轮异步回滚。
 * 异步：先加载检查点 + 逐个算差异再开面板（仿 openSessionMenu）。
 */
export async function openRewindMenu(state: TuiState, sessionPath?: string | null): Promise<void> {
  const cps = await loadCheckpoints(sessionPath ?? undefined);
  if (cps.length === 0) {
    pushCmdLine(state, {
      kind: 'warn',
      text: '暂无检查点——对话轮次会自动打点（每轮用户消息提交时快照工作区修改文件）',
    });
    return;
  }
  const options: { label: string; value: string }[] = [];
  for (const c of cps) {
    const stats = await checkpointDiffStats(c).catch(() => ({ add: 0, rem: 0, files: [] as string[] }));
    const delta = stats.add === 0 && stats.rem === 0 ? '· 与当前一致' : `· Δ +${stats.add} −${stats.rem} 行`;
    const oldMark = typeof c.msgCount === 'number' ? '' : '（旧，仅代码）';
    options.push({
      label: truncateToWidth(`${checkpointSummaryLine(c)} ${delta}${oldMark}`, 60),
      value: String(c.index),
    });
  }
  state.menu = {
    id: 'rewind',
    title: t(state.language, 'menu.rewind.title'),
    options,
    selectedIndex: 0,
    currentValue: '',
    scrollTop: 0,
  };
}

/**
 * 恢复模式菜单：检查点选中后第二步（三模式 + 预览确认）。
 * 纯 state 操作：确认经 confirmMenu 写 rewindPick + rewindMode，interactive 异步执行。
 */
export function openRewindModeMenu(state: TuiState, index: number): void {
  state.rewindPending = index;
  state.menu = {
    id: 'rewind-mode',
    title: `检查点 #${index} → 选择恢复模式`,
    options: [
      { label: '仅代码（回滚文件，对话保留）', value: 'code' },
      { label: '仅对话（截断对话，文件不动）', value: 'chat' },
      { label: '代码+对话（双向回滚）', value: 'both' },
    ],
    selectedIndex: 0,
    currentValue: '',
    scrollTop: 0,
  };
}

/** 输出一个技能的完整内容到命令面板（/skill show 与面板确认共用） */
export async function pushSkillShow(state: TuiState, name: string): Promise<void> {
  const content = await loadSkillContent(name);
  pushCmdLine(state, {
    kind: content ? 'meta' : 'warn',
    text: content ? `技能「${name}」内容：` : `未找到技能「${name}」（/skill 查看已发现列表）`,
  });
  if (content) {
    // 解析 frontmatter 展示扩展字段
    const fm = parseSkillFrontmatter(content);
    const ext = [];
    if (fm['disable-model-invocation']) ext.push('仅手动触发');
    if (fm['user-invocable']) ext.push('用户可手动触发');
    if (fm.context === 'fork') ext.push(`子代理执行${fm.agent ? `（agent=${fm.agent}）` : ''}${fm.background ? '·后台' : ''}`);
    if (ext.length > 0) pushCmdLine(state, { kind: 'meta', text: `属性：${ext.join(' · ')}` });
    pushCmdLine(state, { kind: 'answer', text: content });
  }
}

/**
 * 技能选择面板：列出已发现技能（含来源/行为标签），选中后 confirmMenu 只记录
 * 意图（state.skillPick），interactive 每轮加载完整内容（与 /session 同模式）。
 */
export async function openSkillMenu(state: TuiState, cwd = process.cwd()): Promise<void> {
  const skills = await discoverSkills(cwd);
  if (skills.length === 0) {
    pushCmdLine(state, {
      kind: 'warn',
      text: '未发现技能（.opencode/.claude/.agents/skills 下无 SKILL.md）。用 /skill find <关键词> 网络检索，或 /skill add <owner/repo> --skill <名称> 安装，或 /skill create <名称> [描述] 新建。',
    });
    return;
  }
  state.menu = {
    id: 'skill',
    title: t(state.language, 'menu.skill.title'),
    options: skills.map((s) => {
      const tags: string[] = [];
      if (s.global) tags.push('全局');
      if (s.disableModelInvocation) tags.push('仅手动');
      if (s.context === 'fork') tags.push('子代理');
      const tag = tags.length > 0 ? `（${tags.join(' · ')}）` : '';
      return {
        label: truncateToWidth(`${s.name} — ${s.description}${tag}`, 60),
        value: s.name,
      };
    }),
    selectedIndex: 0,
    currentValue: '',
    scrollTop: 0,
  };
}

/**
 * 子代理任务中心面板（Agent View，1.0 完整版）：列出本次会话全部子代理
 * （运行中 + 已完成；含编排 worker）。选中后 confirmMenu 只记录意图
 * （state.tasksPick = 子代理 id），interactive 每轮渲染 transcript 明细，
 * 并对已完成的子代理把 `/tasks resume <id> ` 预填输入框（带原上下文续跑）。
 */
export function openTasksMenu(state: TuiState, records: SubagentRecord[]): void {
  state.menu = {
    id: 'tasks',
    title: state.language === 'en' ? 'Subagents' : '子代理任务中心',
    options: records.map((r) => ({
      label: truncateToWidth(formatSubagentLine(r), 72),
      value: r.id,
    })),
    selectedIndex: 0,
    currentValue: '',
    scrollTop: 0,
  };
}

/** 子代理 transcript 明细行（钻取视图：状态头 + 任务 + 思考/工具明细 + 结果） */
export function taskDetailLines(rec: SubagentRecord): string[] {
  const lines: string[] = [];
  const model = rec.model ? ` · ${rec.model}` : '';
  const effort = rec.effort && rec.effort !== 'none' && rec.effort !== 'auto' ? ` · ${rec.effort}` : '';
  lines.push(
    `${rec.id} · ${rec.name}${model}${effort} · ${subagentStatusLabel(rec.status)} · ${rec.steps}/${rec.maxSteps} 步`
  );
  if (rec.cwd) lines.push(`工作树：${rec.cwd}`);
  if (rec.task) lines.push(`任务：${truncateToWidth(rec.task, 160)}`);
  if (rec.dropped > 0) lines.push(`… 更早 ${rec.dropped} 条明细已省略`);
  for (const it of rec.items) {
    const mark = it.kind === 'think' ? '💭' : it.kind === 'tool' ? (it.ok === false ? '✗' : '→') : '≡';
    lines.push(`${mark} ${it.name ? `${it.name}: ` : ''}${it.text}`);
  }
  if (rec.result) {
    lines.push('', `结果：${rec.result}`);
  }
  if (rec.status !== 'running' && rec.status !== undefined) {
    lines.push('', `（/tasks resume ${rec.id} <追问> 可带原上下文续跑）`);
  }
  return lines;
}

/** MCP 服务器详情行（面板确认与 /mcp list 共用同一文本格式） */export function mcpServerDetailLines(
  name: string,
  servers: Record<string, McpServerConfig>,
  handles: McpServerHandle[]
): string[] {
  const lines: string[] = [];
  const cfg = servers[name];
  if (!cfg) {
    lines.push(`未配置 MCP 服务器「${name}」`);
    return lines;
  }
  const h = handles.find((x) => x.name === name);
  const endpoint = cfg.url ?? [cfg.command].concat(cfg.args ?? []).filter(Boolean).join(' ');
  lines.push(`MCP 服务器「${name}」（${cfg.url ? '远端 HTTP' : '本地命令'} · ${h ? '已连接' : '未连接'}）：`);
  if (endpoint) lines.push(`  端点：${endpoint}`);
  if (!h) {
    lines.push('  （连接失败或未提供工具——/mcp reconnect 重连）');
    return lines;
  }
  if (h.tools.length > 0) lines.push(`  工具（${h.tools.length}）：${h.tools.map((t) => t.name).join('、')}`);
  if (h.resources.length > 0) lines.push(`  资源（${h.resources.length}）：${h.resources.map((r) => r.uri).join('、')}`);
  if (h.prompts.length > 0) lines.push(`  提示词模板（${h.prompts.length}）：${h.prompts.map((p) => p.name).join('、')}`);
  if (h.instructions) lines.push('  instructions ✓');
  return lines;
}

/**
 * MCP 选择面板：每服务器一行（名 · 工具数/未连接）+ `⟳ 重连全部`。选中服务器只
 * 记录意图（state.mcpPick = srv:<name>），interactive 每轮输出详情；重连走异步
 * 重建（与 /session 同模式）。
 */
export function openMcpMenu(
  state: TuiState,
  servers: Record<string, McpServerConfig>,
  handles: McpServerHandle[]
): void {
  const names = Object.keys(servers);
  if (names.length === 0) {
    pushCmdLine(state, {
      kind: 'warn',
      text: '未配置 MCP 服务器（配置文件 mcpServers 字段；/mcp add <名称> <command> 或 --url <url> 添加）',
    });
    return;
  }
  const byName = new Map(handles.map((h) => [h.name, h]));
  state.menu = {
    id: 'mcp',
    title: t(state.language, 'menu.mcp.title'),
    options: [
      ...names.map((n) => {
        const h = byName.get(n);
        return {
          label: truncateToWidth(h ? `${n} · ${h.tools.length} 工具` : `${n} · 未连接`, 60),
          value: `srv:${n}`,
        };
      }),
      { label: '⟳ 重连全部', value: '__reconnect__' },
    ],
    selectedIndex: 0,
    currentValue: '',
    scrollTop: 0,
  };
}

/** 打开上下文窗口面板：默认（跟随模型）+ 256K/400K/512K/750K/1000K 档位，当前生效项高亮 */
export function openContextMenu(
  state: TuiState,
  overrideTokens: number | undefined,
  autoTokens: number | undefined
): void {
  const cur = typeof overrideTokens === 'number' && overrideTokens > 0 ? String(overrideTokens) : 'clear';
  const autoLabel = autoTokens ? `（当前模型 ${formatTokenCount(autoTokens)}）` : '';
  state.menu = {
    id: 'context',
    title: t(state.language, 'menu.context.title'),
    options: [
      { label: `默认 · 跟随模型自动${autoLabel}`, value: 'clear' },
      ...CONTEXT_K_TIERS.map((k) => ({
        label: `${k}K（${formatTokenCount(k * 1000)} tokens）`,
        value: String(k * 1000),
      })),
    ],
    selectedIndex: 0,
    currentValue: cur,
    scrollTop: 0,
  };
  const idx = state.menu.options.findIndex((o) => o.value === cur);
  state.menu.selectedIndex = Math.max(0, idx);
}

/**
 * /context 设置落盘 + 运行时应用（run() 直接键入与面板意图消费共用同一语义）。
 * choice = tokens 数字（覆盖）/ 'clear'（清除回自动）。
 */
export function applyContextLimitChoice(
  state: TuiState,
  cfg: OmniConfig | undefined | null,
  runOpts: { context?: { contextLimit?: number }; models?: { name: string; limit?: { context?: number } }[] } | undefined,
  modelName: string,
  choice: number | 'clear'
): void {
  const curEp = runOpts?.models?.find((m) => m.name === modelName);
  if (choice === 'clear') {
    if (cfg) delete cfg.contextLimit;
    if (runOpts?.context) runOpts.context.contextLimit = curEp?.limit?.context;
    state.contextLimit = curEp?.limit?.context ?? 0;
    pushCmdLine(state, { kind: 'meta', text: '已清除手动覆盖（跟随模型自动识别）' });
  } else {
    if (cfg) cfg.contextLimit = choice;
    if (runOpts?.context) runOpts.context.contextLimit = choice;
    state.contextLimit = choice;
    pushCmdLine(state, { kind: 'meta', text: `已覆盖上下文窗口 → ${formatTokenCount(choice)}（${choice} tokens；压缩预算与用量分母即时生效）` });
  }
  if (cfg) {
    const res = persistContextLimitToConfig(choice === 'clear' ? null : choice, cfg);
    pushCmdLine(state, { kind: res.ok ? 'meta' : 'warn', text: res.message });
  }
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
}
/** 打开设置菜单（/settings）：列出可用设置项，选择后打开对应编辑器 */
export function openSettingsMenu(state: TuiState): void {
  state.menu = {
    id: 'settings',
    title: t(state.language, 'menu.settings.title'),
    options: [
      { label: t(state.language, 'settings.language'), value: 'language' },
      { label: t(state.language, 'settings.theme'), value: 'theme' },
      { label: t(state.language, 'settings.tokens'), value: 'tokens' },
      { label: t(state.language, 'settings.doctor'), value: 'doctor' },
      { label: t(state.language, 'settings.help'), value: 'help' },
      { label: t(state.language, 'settings.models'), value: 'models' },
    ],
    selectedIndex: 0,
    currentValue: '',
    scrollTop: 0,
  };
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
  } else if (menu.id === 'rewind') {
    // 检查点面板：只记录待选序号并打开模式菜单（第二步选 code/chat/both），
    // 模式确认后才真正回滚（见 rewind-mode 分支 + interactive 消费）。
    const n = Number(opt.value);
    if (Number.isInteger(n)) {
      openRewindModeMenu(state, n);
      pushCmdLine(state, { kind: 'meta', text: `已选择检查点 #${n}，请选择恢复模式` }, '/rewind');
      return;
    }
  } else if (menu.id === 'rewind-mode') {
    // 模式菜单：记录回滚意图（序号 + 模式），interactive 每轮异步执行三模式回滚。
    const mode = opt.value === 'chat' || opt.value === 'both' ? opt.value : 'code';
    if (state.rewindPending != null) {
      state.rewindPick = state.rewindPending;
      state.rewindMode = mode;
      state.rewindPending = null;
      pushCmdLine(state, { kind: 'meta', text: tf(lang, 'confirm.rewind', { index: state.rewindPick }) }, '/rewind');
    }
  } else if (menu.id === 'mcp') {
    // MCP 面板：服务器只记录意图（state.mcpPick），interactive 每轮输出详情；
    // 重连走异步重建（与 /session 同模式）。
    state.mcpPick = opt.value;
  } else if (menu.id === 'skill') {
    // 技能面板：只记录意图（state.skillPick），interactive 每轮加载完整内容。
    state.skillPick = opt.value;
  } else if (menu.id === 'tasks') {
    // 子代理任务中心：只记录选中的子代理 id（state.tasksPick），interactive 每轮
    // 渲染 transcript 明细（已完成的顺带预填 /tasks resume，带原上下文续跑）。
    state.tasksPick = opt.value;
  } else if (menu.id === 'context') {
    // 上下文窗口面板：只记录意图（state.contextLimitSave），interactive 每轮落盘+应用。
    state.contextLimitSave = opt.value;
  } else if (menu.id === 'settings') {
    // 设置菜单：选择后打开对应设置编辑器。
    // language → menu 直接转换为语言面板（新面板接管，不关闭——否则语言面板闪现即关，
    // 用户反馈「单独点击语言没反应」的根因）
    if (opt.value === 'language') {
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
    } else if (opt.value === 'help') {
      // 帮助：纯 state 输出帮助文本到命令面板（原顶层 /help 已移入）
      pushHelpText(state);
      state.menu = null;
      state.status = '';
    } else if (opt.value === 'models') {
      // 模型能力快照状态：纯 state 输出（原顶层 /models 已移入；refresh 需打字执行）
      pushModelsStatus(state);
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
  state.status = '';
}

/** 取消面板：原样关闭（导出供测试/其它调用方复用） */
export function closeMenu(state: TuiState): void {
  state.menu = null;
  state.status = '';
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
export async function runMcpSub(
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
    ctx.out.pushToast(`✓ 已添加 MCP 服务器「${parsed.name}」`, 'success');
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
    ctx.out.pushToast(`✓ 已移除 MCP 服务器「${serverName}」`, 'success');
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
 * 按 id（支持前缀）解析会话候选：唯一命中返回 SessionInfo；
 * 无命中 / 多个命中（歧义）时把提示与候选列表推入对话流并返回 null——
 * 不静默选一个，避免短前缀继续到错误的会话。
 */
export async function resolveSessionCandidates(
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

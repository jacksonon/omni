/**
 * TUI 渲染层（命令式，不依赖 solid 响应式）。
 *
 * 背景：OpenTUI 的 solid 集成在此环境存在 JSX 转换时序问题（入口文件在
 * preload 注册插件前就被转换），信号变更无法触发重绘。因此这里直接用
 * @opentui/core 的 renderable 构建渲染树，状态变更后显式调用 loop() 重绘。
 *
 * 布局（交互模式，纵向 flex，无边框/标题）：
 *   ▍你好（白字灰底）                      ← 内容行（用户消息带蓝细线+灰底）
 *   💭 思考…
 *   ...（内容不足时此处留空）
 *   等待输入…                              ← 状态栏（灰色块上方）
 *   ┌───────────────灰色块───────────────┐  ← 灰色块（marginTop:auto 钉在底部）
 *   │▍ 输入消息，Enter 发送…             │  │ 蓝细线竖跨两行 + 多行输入框
 *   │▍ 模型 grok-4.5                     │  │ 模型名
 *   └────────────────────────────────────┘
 *   ~/work/omni                ⚡ 1.2k tok  ← 路径/token 行（灰色块下方，无灰底）
 *
 * 灰色块（输入框 + 模型行，淡灰色背景）与对话流区分，蓝色细线（▍≈3px）竖跨
 * 输入 field 与模型行；路径/token 行在灰色块下方（不在灰色背景里）。
 * 通过 marginTop:auto 吸收剩余空间，始终固定在视口最底部。单次任务模式
 * （无输入框）时仅状态栏，无灰色块与路径行。
 *
 * 命令联想列表（输入 / 时）是**独立浮层**（suggestBox）：绝对定位 + 面板底色，
 * 悬停在输入框（灰色块）上方，不占内容流、不挤动对话（用户要求独立界面）；
 * 非模态，可继续输入；↑/↓ 高亮、Tab/Enter/鼠标点击填入。
 */
import { BoxRenderable, StyledText, TextAttributes, TextRenderable, TextareaRenderable, createCliRenderer, createTextAttributes, parseColor } from '@opentui/core';
import type { RenderContext } from '@opentui/core';
import { toolCardLines } from '../output/format.js';
import { commandSuggestions, findCommand } from './commands.js';
import { logCrash } from './crashlog.js';
import { CODE_FG, INLINE_CODE_FG, markdownToRows, QUOTE_FG, type MdChunk } from './markdown.js';
import type { CmdSuggestion, TuiLineKind, TuiMenu, TuiState } from './state.js';
import { cardBottomLine, cardContentLine, cardInnerWidth, cardTitleLine, type ToolCardRole } from '../output/format.js';
import { charWidth, visualWidth } from './width.js';

export interface TuiSession {
  /** 立即重绘一帧（状态变更后调用） */
  paint(): Promise<void>;
  /** 退出全屏（恢复终端） */
  stop(): Promise<void>;
  /** 交互模式的输入框（多行 Textarea；单次任务模式为 null） */
  input: TextareaRenderable | null;
  /**
   * 订阅每次按键（返回取消订阅函数）。
   * 全局监听先于输入框（renderable）执行，回调可调用 preventDefault() 阻止输入框处理该键。
   */
  onKeyPress(cb: (key: TuiKey) => void): () => void;
}

/** 按键事件（KeyEvent 的结构化子集，含阻止派发能力） */
export interface TuiKey {
  name: string;
  sequence: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  super?: boolean;
  /** 阻止后续 renderable（输入框）处理该按键 */
  preventDefault(): void;
  stopPropagation(): void;
}

/** 行样式（对应 createTextAttributes 的字段） */
export interface RowStyle {
  dim?: boolean;
  bold?: boolean;
  fg?: string;
  bg?: string;
}

/** 每种内容行的展示样式：思考浅色、警告黄、用户蓝加粗、任务青加粗、meta 浅色 */
export function rowStyle(kind: TuiLineKind): RowStyle {
  switch (kind) {
    case 'thinking':
      return { dim: true };
    case 'warn':
      return { fg: 'yellow' };
    case 'user':
      return { fg: 'blue', bold: true };
    case 'task':
      return { fg: 'cyan', bold: true };
    case 'meta':
      return { dim: true };
    default:
      return {};
  }
}

export interface Row {
  text: string;
  style: RowStyle;
  /** 行内样式片段（answer 行走 Markdown 渲染时存在；否则用整行 style） */
  chunks?: MdChunk[];
  /** 所属工具卡片的 id（用于点击命中判定；非卡片行为 undefined） */
  cardId?: number;
  /** 所属思考行的下标（折叠态下可点击单独展开/收起；非思考行为 undefined） */
  thinkingIdx?: number;
}

/** 内容区可用宽度 = 视口宽 - paddingX(2)（无根边框） */
const CONTENT_PAD = 2;

/** 蓝色细线字符：3/8 块（≈3px，替代整列色块——用户反馈 2 列色块太宽） */
const ACCENT_BAR = '▍';

/**
 * 主题色板：深色/亮色两套。深色基本维持原样（仅内容默认色从纯白微调为
 * `#e2e8f0`，与用户消息文字一致）；亮色模式下灰色块与用户消息改淡灰底 +
 * 深色文字，**内容区文字（AI 回答/思考/meta/工具卡片）也换深色**——此前内容行
 * 默认 fg 硬编码白色，浅色终端上白字看不见（用户报告）。OpenTUI 按终端背景亮度
 * 自动检测（OSC 10/11 查询），存于 state.themeMode，默认深色。
 */
interface TuiTheme {
  /** footer 灰色块 / 用户消息底色 */
  footerBg: string;
  /** 用户消息文字色 */
  userText: string;
  /** 蓝色细线 / 强调色 */
  accentBlue: string;
  /** footer 模型行文字色 */
  footerText: string;
  /** footer 路径/token 行文字色 */
  footerDim: string;
  /** 输入框文字色 */
  inputText: string;
  /** 输入框占位符色 */
  placeholder: string;
  /** 内容区默认文字色（AI 回答/meta/工具卡片正文等） */
  contentText: string;
  /** 内容区浅色文字（思考/meta/提示行：dark 走 dim 属性，light 显式深灰） */
  contentDim: string;
  /** 命令联想浮层底色（独立下拉面板，与 footer 灰块区分） */
  suggestBg: string;
  /** 命令联想浮层普通项文字色（选中项用 accentBlue） */
  suggestText: string;
  /** 工具卡片边框色：暗色下普通白色、亮色下灰色（用户要求无彩色边框） */
  cardBorder: string;
}

const DARK_THEME: TuiTheme = {
  footerBg: '#3f3f46',
  userText: '#e2e8f0',
  accentBlue: '#3b82f6',
  footerText: '#d4d4d8',
  footerDim: '#9ca3af',
  inputText: '#e2e8f0',
  placeholder: '#6b7280',
  contentText: '#e2e8f0',
  contentDim: '#9ca3af',
  suggestBg: '#27272a', // 比 footer 深一档（zinc-800），浮层从灰块中浮出
  suggestText: '#e2e8f0',
  cardBorder: '#e2e8f0', // 普通白色边框
};

const LIGHT_THEME: TuiTheme = {
  footerBg: '#e4e4e7', // 淡灰（zinc-200）
  userText: '#27272a', // 深灰近黑（zinc-800）
  accentBlue: '#2563eb', // 稍深蓝，保证浅底对比度
  footerText: '#3f3f46', // zinc-700
  footerDim: '#71717a', // zinc-500
  inputText: '#27272a',
  placeholder: '#9ca3af', // zinc-400
  contentText: '#27272a', // 内容区文字改深色（修复浅底白字）
  contentDim: '#52525b', // zinc-600：思考/meta/提示在浅底上仍清晰
  suggestBg: '#ffffff', // 亮色下浮层用白底，与淡灰 footer 区分
  suggestText: '#27272a',
  cardBorder: '#71717a', // 亮色下灰色边框
};

/** 判断主题是否为亮色（用于 dim 行显式取深色文字等分支） */
function isLightTheme(theme: TuiTheme): boolean {
  return theme === LIGHT_THEME;
}

/**
 * 主题化颜色：亮色模式下把「浅底上不可读」的颜色映射为深色变体。
 * 深色模式原样返回（维持既有外观）。markdown 颜色常量直接引用
 * markdown.ts 的导出（CODE_FG/INLINE_CODE_FG/QUOTE_FG），常量变更时映射自动同步。
 */
const LIGHT_COLOR_MAP: Record<string, string> = {
  white: LIGHT_THEME.contentText, // 内容默认白 → 深灰
  cyan: '#0e7490', // 亮青在浅底看不清 → 深青
  yellow: '#a16207', // 亮黄 → 深琥珀
  [INLINE_CODE_FG]: '#a16207', // markdown 行内代码（琥珀）→ 深琥珀
  [CODE_FG]: '#475569', // markdown 代码块（浅蓝灰）→ 深蓝灰
  [QUOTE_FG]: '#52525b', // markdown 引用（浅灰）→ 深灰
};

function themeColor(color: string, theme: TuiTheme): string;
function themeColor(color: string | undefined, theme: TuiTheme): string | undefined;
function themeColor(color: string | undefined, theme: TuiTheme): string | undefined {
  if (!color) return color;
  if (isLightTheme(theme)) return LIGHT_COLOR_MAP[color] ?? color;
  return color;
}

/** 解析生效主题：system 跟随终端实测，light/dark 手动强制 */
function themeFor(state: TuiState): TuiTheme {
  const mode = state.themeMode === 'system' ? state.detectedTheme : state.themeMode;
  return mode === 'light' ? LIGHT_THEME : DARK_THEME;
}

/** token 用量展示：`⚡ 12.3k tok`（<1000 显示原数） */
function formatTokens(n: number): string {
  const num = n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  return `⚡ ${num} tok`;
}

/** 文本中段截断（保留头尾，省略号指示省略）：长路径只显示首段与末段 */
function truncateMiddle(text: string, max: number): string {
  if (max < 8 || visualWidth(text) <= max) return text;
  const tailMax = Math.max(4, Math.floor(max / 3));
  let tail = '';
  for (let i = text.length - 1; i >= 0; i--) {
    const c = text[i];
    if (visualWidth(c + tail) > tailMax) break;
    tail = c + tail;
  }
  const headMax = max - 1 - visualWidth(tail); // 留 1 列给 '…'
  let head = '';
  for (const c of text) {
    if (visualWidth(head + c) > headMax) break;
    head += c;
  }
  return `${head}…${tail}`;
}

/**
 * 估算输入框的可见行数：逻辑行数（\n 拆段）+ 长行折行后的行数。
 *
 * Textarea 的 lineCount 是逻辑行数（不含折行），而自动增高模式下长行会在框内
 * 折成多行——只按 lineCount 同步预算会低估输入框实际高度，内容区溢出重叠
 * （场景 2 修过的 bug 会在粘贴长行时复发）。按文本宽度估算折行数（宁可多估，
 * 多估只是内容区少几行，不会重叠）。
 */
function estimateInputLines(text: string, innerWidth: number): number {
  if (innerWidth < 2) return 1;
  let lines = 0;
  for (const seg of text.split('\n')) {
    lines += Math.max(1, Math.ceil(visualWidth(seg) / innerWidth));
  }
  return lines;
}

/**
 * 计算 text 在 budget 列内最多能容纳的字符数（UTF-16 码元）。
 * 断点不会落在代理对中间（emoji 等 astral 字符整对保留或整对舍弃）。
 */
function fitCount(text: string, budget: number): number {
  if (budget <= 0) return 0;
  let cols = 0;
  let i = 0;
  for (; i < text.length; i++) {
    const w = charWidth(text[i]);
    if (cols + w > budget) break;
    cols += w;
  }
  // 断点落在代理对后半（emoji 等 astral 字符）时回退到前半之前，避免切出半个乱码
  while (i > 0 && i < text.length) {
    const code = text.charCodeAt(i);
    if (code >= 0xdc00 && code <= 0xdfff) i--;
    else break;
  }
  return i;
}

/** 可断行标点：断在这些字符之后（标点留在行尾）。中文为主——CJK 散文无空格，
 * 标点是天然断点；英文逗号句号也可断（长 URL 通常含 '.' 可借此断行）。 */
const BREAK_AFTER = '，。、；：！？）》」』】…·,.;:!?)]}';

/** prefix 内最后一个可断行标点的位置（无则 -1） */
function lastBreakPunctIndex(prefix: string): number {
  let pi = -1;
  for (const ch of BREAK_AFTER) {
    const idx = prefix.lastIndexOf(ch);
    if (idx > pi) pi = idx;
  }
  return pi;
}

/**
 * 把一行（样式片段）按显示列数折成多行（自动换行，替代原来的截断）。
 *
 * 规则：CJK 全角算 2 列；优先在空格处断行（词边界，空格丢弃），其次在标点后断行
 * （标点留行尾，中文散文友好），否则按列硬断；不切断代理对。折行后每行恰好占
 * 1 个终端行，因此行数预算（computeRows 的 cap）精确成立，状态栏/输入框不会被
 * 挤出视口——这正是原来交给 TextBuffer word 换行会撑破预算、只能退而截断的问题。
 */
function wrapChunks(chunks: MdChunk[], width: number): MdChunk[][] {
  if (width < 2) return [chunks]; // 极端窄视口：放弃折行，交给终端处理
  if (chunks.length === 0) return [chunks]; // 空行（保留占位）
  const rows: MdChunk[][] = [];
  let cur: MdChunk[] = [];
  let used = 0;
  const flush = (): void => {
    if (cur.length) {
      rows.push(cur.filter((c) => c.text.length > 0));
      cur = [];
    }
    used = 0;
  };
  for (const c of chunks) {
    let text = c.text;
    while (text.length > 0) {
      const remain = width - used;
      if (remain >= visualWidth(text)) {
        cur.push({ ...c, text });
        used += visualWidth(text); // 整段可放下：累积列数（后续 chunk 继续接在同一行）
        break;
      }
      const fit = fitCount(text, remain);
      if (fit <= 0) {
        // 行首放不下（如只剩 1 列又遇到全角字符）→ 换到下一行重试
        flush();
        continue;
      }
      const prefix = text.slice(0, fit);
      const sp = prefix.lastIndexOf(' ');
      const pi = lastBreakPunctIndex(prefix);
      // 断点优先级：空格（断在空格处）> 最近标点之后（标点留行尾）> 硬断
      let cut: number;
      if (sp > 0 && sp >= pi) cut = sp;
      else if (pi > 0) cut = pi + 1;
      else cut = fit;
      cur.push({ ...c, text: text.slice(0, cut) });
      text = text.slice(cut);
      if (sp > 0 && sp >= pi) text = text.slice(1); // 空格断行：空格随断点丢弃
      else if (text.startsWith(' ')) text = text.slice(1); // 标点/硬断后：跳过续行前导空格
      flush();
    }
  }
  flush();
  return rows.length ? rows : [[]];
}

/** 把一行按内容宽度折成多行（chunks 行保留行内样式，普通行整行套样式）。
 * 附带字段（cardId/thinkingIdx）跨折行保留：点击命中需要知道每一折行属于哪个卡片/思考行 */
function wrapRow(row: Row, width: number): Row[] {
  const extra = {
    ...(row.cardId !== undefined ? { cardId: row.cardId } : {}),
    ...(row.thinkingIdx !== undefined ? { thinkingIdx: row.thinkingIdx } : {}),
  };
  if (!row.chunks) {
    return wrapChunks([{ text: row.text }], width).map((chunks) => ({
      text: chunks.map((c) => c.text).join(''),
      style: row.style,
      ...extra,
    }));
  }
  return wrapChunks(row.chunks, width).map((chunks) => ({
    text: chunks.map((c) => c.text).join(''),
    style: row.style,
    chunks,
    ...extra,
  }));
}

/** 用户消息行：左侧蓝色细线（▍ 3/8 块 ≈3px），文字 + 底色按主题（深色：白字深灰底；
 * 亮色：深字淡灰底）；折行后每行都保留竖线与底——整段消息被框住，对标 opencode 用户气泡 */
function wrapUserLine(text: string, width: number, theme: TuiTheme): Row[] {
  const inner = Math.max(1, width - 1); // 竖线占 1 列
  const chunks: MdChunk[] = [{ text, fg: theme.userText, bg: theme.footerBg }];
  return wrapChunks(chunks, inner).map((rowChunks) => ({
    text: `${ACCENT_BAR}${rowChunks.map((c) => c.text).join('')}`,
    style: { fg: theme.userText, bg: theme.footerBg },
    chunks: [{ text: ACCENT_BAR, fg: theme.accentBlue, bg: theme.footerBg }, ...rowChunks],
  }));
}

/** 工具卡片的行样式：首行（标题）青色、末行与纯分隔行浅色、提示行浅色，其余默认 */
function toolRowStyle(role: ToolCardRole, theme: TuiTheme): RowStyle {
  switch (role) {
    case 'top':
    case 'bottom':
      // 顶/底边框：普通边框色（暗色白 / 亮色灰），无特殊颜色
      return { fg: theme.cardBorder };
    case 'cmd':
      // 第一行命令：加粗，与执行/结果缩略（dim）区分（用户要求文字要有区分）
      return { bold: true };
    case 'exec':
    case 'result':
    case 'sep':
    case 'out':
    case 'hint':
      return { dim: true };
    default:
      return {};
  }
}

/**
 * 工具卡片行：左右边框 `│` 用普通边框色（暗色白/亮色灰，与内容区分），
 * 中间内容按角色着色（命令加粗、执行/结果/输出浅色）。
 * 用户要求：不要特殊彩色边框，就普通白色（暗）/灰色（亮）。
 */
function toolCardRow(text: string, role: ToolCardRole, theme: TuiTheme): Row {
  const border = theme.cardBorder;
  if (role === 'top' || role === 'bottom') {
    return { text, style: { fg: border } };
  }
  // 内容行：│ 内容 │ → 拆成 [边框, 内容, 边框] 三段着色
  const inner = text.slice(1, -1);
  const contentStyle = toolRowStyle(role, theme);
  const chunks: MdChunk[] = [
    { text: '│', fg: border },
    { text: inner, ...contentStyle },
    { text: '│', fg: border },
  ];
  return { text, style: {}, chunks };
}

/** 生成中的光标标记（半块字符，追加在最后一行输出末尾） */
const STREAM_CURSOR = '▌';

/**
 * 命令面板的行（圆角方框，复用工具卡片边框）：
 *
 *   ╭─ 主题 ────────────╮
 *   │ › 跟随系统 ✓      │   ← 当前值 ✓，高亮项 ›
 *   │   亮色            │
 *   │   深色            │
 *   │ ↑/↓ 选择 · Enter 确认 · Esc 取消 │
 *   ╰───────────────────╯
 */
function menuPanelRows(menu: TuiMenu, contentWidth: number): Row[] {
  const inner = cardInnerWidth(contentWidth);
  const rows: Row[] = [{ text: cardTitleLine(menu.title, '', inner), style: { fg: 'cyan' } }];
  menu.options.forEach((opt, i) => {
    const cursor = i === menu.selectedIndex ? '› ' : '  ';
    const check = opt.value === menu.currentValue ? ' ✓' : '';
    rows.push({
      text: cardContentLine(`${cursor}${opt.label}${check}`, inner),
      style: i === menu.selectedIndex ? { fg: 'cyan', bold: true } : {},
    });
  });
  rows.push({ text: cardContentLine('↑/↓ 或数字选择 · Enter 确认 · Esc 取消', inner), style: { dim: true } });
  rows.push({ text: cardBottomLine(inner), style: { dim: true } });
  return rows;
}

/** 状态 → 全部内容行（未裁剪窗口），每行已按内容宽度折行（不截断） */
function buildBody(state: TuiState, width: number): Row[] {
  const theme = themeFor(state);
  const body: Row[] = [];
  // 会话标题不显示在信息流里——首轮对话后由模型自动生成，改设为终端窗口/标签页标题
  // （setTerminalTitle，见 interactive.ts），保持对话流纯净。
  for (let li = 0; li < state.lines.length; li++) {
    const line = state.lines[li];
    if (line.kind === 'answer') {
      // 最终回答走行式 Markdown 渲染（加粗/行内代码/代码块/标题/引用/表格/列表/任务清单等）。
      // 传内容宽度：表格按此收缩列宽（超宽截断），每行不折行、对齐不被打断。
      // 亮色模式下把 markdown 的浅色常量（代码块/行内代码/引用/标题 cyan）映射为深色变体，
      // 否则浅底上看不清（用户报告：亮色下 AI 输出白字）。
      for (const md of markdownToRows(line.text, width)) {
        const chunks = md.chunks.map((c) => (c.fg ? { ...c, fg: themeColor(c.fg, theme) } : c));
        body.push(
          ...wrapRow(
            { text: chunks.map((c) => c.text).join(''), style: rowStyle(line.kind), chunks },
            width
          )
        );
      }
      continue;
    }
    if (line.kind === 'tool' && line.card) {
      // 工具调用卡片：无标题圆角方框（命令/执行缩略/结果缩略），
      // 收起/展开由 card.expanded 决定（点击切换）；边框用普通色（暗白/亮灰）
      const lines = toolCardLines(line.card, width);
      for (const l of lines) {
        body.push({ ...toolCardRow(l.text, l.role, theme), cardId: line.card.id });
      }
      continue;
    }
    if (line.kind === 'user') {
      // 用户消息：每行左侧带蓝色竖粗线（折行后连续，整段消息被竖线框住）
      for (const seg of line.text.split('\n')) {
        body.push(...wrapUserLine(seg, width, theme));
      }
      // 用户消息与后续内容（思考/回答/工具卡片）之间留 1 行间距，
      // 避免用户输入与 AI 思考紧贴（用户反馈距离太近）
      body.push({ text: '', style: {} });
      continue;
    }
    if (line.kind === 'thinking' && !state.thinkingExpanded) {
      // /thinking 折叠态：每个思考段落压成一行 `+ thinking`（+ 表示可点击展开）；
      // 在 expandedThinking 集合里的行**单独展开**：`- thinking` 头行 + 完整文本
      // （- 表示可点击收起）。全部带 thinkingIdx，点击即切换。
      if (state.expandedThinking.has(li)) {
        // 单独展开的这条：`- thinking` 头行 + 完整文本，每行都带 thinkingIdx（点击可收起）
        body.push({ text: '- thinking', style: { dim: true }, thinkingIdx: li });
        for (const seg of line.text.split('\n')) {
          body.push(...wrapRow({ text: seg, style: rowStyle(line.kind), thinkingIdx: li }, width));
        }
      } else {
        body.push({
          text: '+ thinking',
          style: { dim: true },
          thinkingIdx: li,
        });
      }
      continue;
    }
    for (const seg of line.text.split('\n')) {
      body.push(...wrapRow({ text: seg, style: rowStyle(line.kind) }, width));
    }
  }
  // 命令面板（/theme 等）是绝对定位浮层（menuOverlay），不占用内容流——
  // 会话内容与菜单互不干扰（用户要求 alert 形式，见 mountTree/repaintTree）。
  // 正在流式生成时，在最后一行输出末尾追加光标（代替状态栏“生成中…”文案）
  if (state.generating && body.length > 0) {
    const last = body[body.length - 1];
    if (last.cardId === undefined) {
      if (last.chunks && last.chunks.length > 0) {
        // 行式 Markdown：追到最后一个片段的文本（StyledText 渲染用 chunks 而非 text）
        last.chunks[last.chunks.length - 1].text += STREAM_CURSOR;
        last.text += STREAM_CURSOR;
      } else {
        last.text += STREAM_CURSOR;
      }
    }
  }
  return body;
}

/**
 * 状态 → 可见内容行（尾部窗口 + 滚动）。状态栏、灰色块与路径/token 行是独立的
 * renderable，不在这里。
 *
 * 行数预算：根 Box paddingY(2) = 2 行固定（无边框）；
 * 交互模式再占 状态栏(1) + 灰色块（paddingY 2 + 输入框 inputLines + 间距 1 + 模型 1）
 * + 路径/token 行(1)，即内容区 = 高度 - 8 - inputLines（inputLines=1 时即高度 - 9）；
 * 单次任务模式内容区 = 高度 - 3。
 *
 * 多行输入框自动增高（Enter 发送 / Shift+Enter 换行），inputLines 由 repaintTree
 * 每次从输入框 lineCount 实时同步（蓝色细线同步增高）——输入框变高时内容区预算
 * 同步收缩，灰色块与路径/token 行永远不会被挤出视口。
 *
 * 滚动：scrollTop = null 跟随最新；上滚时显示「内容窗 + 底部提示行」。
 * scrollIntent（按键发出的一次性指令）在此消费，滚动数学集中在这一处。
 */
export function computeRows(
  state: TuiState,
  size: { height: number; width: number },
  opts?: { withInput?: boolean }
): Row[] {
  const { height, width } = size;
  const body = buildBody(state, Math.max(1, (width ?? 80) - CONTENT_PAD));
  // footer 高度预算：输入内容行数(1-5) + 间距 1 + 模型行 1 + 路径/token 行 1 + paddingY 2；
  // 极小高度时不强塞内容行（避免把灰色块挤出视口）
  const inputLines = opts?.withInput ? Math.min(5, Math.max(1, state.inputLines ?? 1)) : 0;
  // 命令联想列表是**独立浮层**（absolute 定位，见 repaintTree）——不占内容流，
  // 内容区预算不再减它的行数（对话不因联想出现而跳动）
  // 根 Box paddingY(2) 固定；交互模式再占 状态栏(1) + 灰色块(inputLines+4) + 路径/token 行(1)
  const cap = Math.max(0, (height ?? 24) - 2 - (opts?.withInput ? 1 + inputLines + 5 : 1));
  const total = body.length;

  // 消费滚动意图（按键/滚轮 → 一次性指令 → 这里换算成 scrollTop）
  if (state.scrollIntent) {
    const { action, lines = 1 } = state.scrollIntent;
    state.scrollIntent = null;
    if (total > cap && cap >= 2) {
      const contentCap = cap - 1; // 上滚模式预留 1 行给提示条
      const maxTop = Math.max(0, total - contentCap);
      const cur = state.scrollTop ?? maxTop;
      const page = Math.max(1, contentCap);
      switch (action) {
        case 'line-up':
          state.scrollTop = Math.max(0, cur - lines);
          break;
        case 'line-down':
          state.scrollTop = cur + lines >= maxTop ? null : cur + lines;
          break;
        case 'page-up':
          state.scrollTop = Math.max(0, cur - page);
          break;
        case 'page-down':
          state.scrollTop = cur + page >= maxTop ? null : cur + page;
          break;
        case 'top':
          state.scrollTop = 0;
          break;
        case 'bottom':
          state.scrollTop = null;
          break;
      }
    }
  }

  if (total <= cap) {
    state.scrollTop = null;
    return body;
  }
  if (state.scrollTop == null) {
    // 跟随最新 + 溢出：窗口顶部加一行提示（否则用户不知道上面还有内容可上滚）
    const contentCap = Math.max(1, cap - 1);
    const visible = body.slice(total - contentCap);
    visible.unshift({
      text: `↑ 上方还有 ${total - contentCap} 行 · 滚轮/PgUp 上滚`,
      style: { dim: true },
    });
    return visible;
  }

  // 上滚模式：内容窗 cap-1 行 + 底部滚动提示行
  const contentCap = Math.max(1, cap - 1);
  const top = Math.min(state.scrollTop, Math.max(0, total - contentCap));
  state.scrollTop = top;
  if (top + contentCap >= total) {
    // 已滚到内容最底（内容收缩等边界情况）→ 回到跟随模式
    state.scrollTop = null;
    return body.slice(total - cap);
  }
  const visible = body.slice(top, top + contentCap);
  visible.push({
    text: `↑ 已上滚 ${total - top - contentCap} 行 · 共 ${total} 行 · End 回到最新`,
    style: { dim: true },
  });
  return visible;
}

/**
 * 卡片屏幕区域（0-based 鼠标事件坐标）。
 *
 * 坐标语义（运行时实测）：OpenTUI 的 MouseEvent.y 是 0-based（SGR \x1b[<0;x;yM
 * 上报的 y 会减 1）。无边框布局下内容行 i 位于 1-based 屏幕行 1 + i
 * （paddingY 1），即事件坐标 y = (1 + i) - 1 = i。
 */
export interface CardRect {
  top: number;
  bottom: number;
}

/**
 * 点击命中判定（纯函数，供 startTui 的鼠标 handler 与快照单测共用）：
 * 命中某张卡片的 y 区间 → 切换该卡片的展开/收起，返回是否命中。
 * y 为 0-based 鼠标事件坐标（内容行 i 位于 y = i，无边框布局）。
 */
export function hitTestCard(state: TuiState, cardRects: Map<number, CardRect>, y: number): boolean {
  for (const [id, rect] of cardRects) {
    if (y >= rect.top && y <= rect.bottom) {
      for (const line of state.lines) {
        if (line.kind === 'tool' && line.card?.id === id) {
          line.card.expanded = !line.card.expanded;
          return true;
        }
      }
      return true; // 命中区间但找不到对应行（状态已清）——仍视为消费这次点击
    }
  }
  return false;
}

/**
 * 思考折叠态点击命中（纯函数，供 startTui 的鼠标 handler 与快照单测共用）：
 * 命中某条思考行的屏幕 y → 切换该条单独展开/收起（state.expandedThinking），返回是否命中。
 * y 为 0-based 鼠标事件坐标（内容行 i 位于 y = i，与卡片同一坐标系）。
 * 仅折叠态（thinkingExpanded=false）才有 thinkingRects 条目；全局展开态 rects 为空。
 */
export function hitTestThinking(state: TuiState, thinkingRects: Map<number, number>, y: number): boolean {
  const li = thinkingRects.get(y);
  if (li === undefined) return false;
  if (state.expandedThinking.has(li)) state.expandedThinking.delete(li);
  else state.expandedThinking.add(li);
  return true;
}

/** 渲染树：根 Box + 内容文本节点 + 灰色块（输入框/模型）+ 路径/token 行 + 状态栏 */
export interface TuiTree {
  root: BoxRenderable;
  cells: TextRenderable[];
  status: TextRenderable;
  /** 灰色块（输入行 + 模型行，交互模式非 null；单次任务模式为 null） */
  footerBox: BoxRenderable | null;
  input: TextareaRenderable | null;
  /** 左侧蓝色细线（▍，竖跨输入行 + 模型行，行数随 inputLines 增高） */
  blueBar: TextRenderable | null;
  /** 模型行 / 路径行 / token 行（repaintTree 每次刷新内容） */
  footerModel: TextRenderable | null;
  footerPath: TextRenderable | null;
  footerTokens: TextRenderable | null;
  /** 每次重绘刷新：卡片 id → 本次可见的屏幕 y 范围（点击命中用） */
  cardRects: Map<number, CardRect>;
  /** 每次重绘刷新：思考折叠摘要/单独展开行的屏幕 y → state.lines 下标（点击单独展开/收起） */
  thinkingRects: Map<number, number>;
  /** 命令联想列表（独立浮层：绝对定位悬停在输入框上方，不占内容流；非模态） */
  suggestBox: BoxRenderable | null;
  suggestCells: TextRenderable[];
  /** 联想浮层本次可见的屏幕 y 区间（0-based 事件坐标；鼠标点击命中/穿透判定用） */
  suggestRect: { top: number; bottom: number } | null;
  /** 命令面板浮层（/theme alert：绝对定位居中，不占用内容流） */
  menuOverlay: BoxRenderable | null;
  menuCells: TextRenderable[];
}

/** 建树（首帧）：根 Box（无边框）+ 输入框 + 状态栏挂到 root 下，内容行由 repaintTree 维护 */
export function mountTree(ctx: RenderContext, state: TuiState, opts?: { withInput?: boolean }): TuiTree {
  const root = new BoxRenderable(ctx, {
    flexGrow: 1, // 撑满视口高度，让输入框的 marginTop:auto 能把剩余空间吸收到内容区下方
    flexDirection: 'column',
    paddingX: 1,
    paddingY: 1,
  });
  (ctx as unknown as { root: BoxRenderable }).root.add(root);

  const theme = themeFor(state);
  let footerBox: BoxRenderable | null = null;
  let input: TextareaRenderable | null = null;
  let blueBar: TextRenderable | null = null;
  let footerModel: TextRenderable | null = null;
  let footerPath: TextRenderable | null = null;
  let footerTokens: TextRenderable | null = null;
  if (opts?.withInput) {
    // 灰色块：淡灰背景（按主题），整块行布局——蓝色细线贴左缘竖跨整块，
    // 右侧内容列（输入框 + 模型行）。auto 上边距吸收内容区剩余空间：
    // 无论内容多少，灰色块都钉在视口底部。
    footerBox = new BoxRenderable(ctx, {
      flexDirection: 'row',
      alignItems: 'stretch',
      marginTop: 'auto',
      backgroundColor: theme.footerBg,
    });

    // 蓝色细线（▍，≈3px）：footerBox 无 paddingX → 细线**紧贴灰色块左缘**；
    // 高度 = 灰色块整高（contentCol paddingY 2 + 输入 inputLines + 间距 1 + 模型 1），
    // 由 repaintTree 每帧按 inputLines 同步 ▍ 行数（竖跨整块含上下边距）。
    blueBar = new TextRenderable(ctx, { content: ACCENT_BAR, wrapMode: 'none', bg: theme.footerBg });
    blueBar.fg = parseColor(theme.accentBlue);
    footerBox.add(blueBar);
    // 右侧内容列：paddingX 1 让输入框/模型行从细线右侧让出 1 列（与输入文字对齐），
    // paddingY 1 撑出灰块上下边距（细线 ▍ 跨过这些行）；gap:1 在输入框与模型行
    // 之间留 1 行间距（细线连续穿过间距）
    const contentCol = new BoxRenderable(ctx, {
      flexDirection: 'column',
      flexGrow: 1,
      gap: 1,
      paddingX: 1,
      paddingY: 1,
    });

    // 多行输入框（对标 opencode）：Enter 发送、Shift+Enter 换行、内容自动增高。
    // 不设固定 height，只给 minHeight/maxHeight → yoga 按内容行数自动增高（1-5 行），
    // 超过 5 行后内部滚动（光标始终可见）；多行粘贴保留换行。
    // 自定义 keyBindings 与默认绑定合并：return/kpenter/linefeed → submit（覆盖默认
    // 的 newline），shift+return 等 → newline；其余编辑键（↑↓/Home/End/Ctrl+U 等）不变。
    input = new TextareaRenderable(ctx, {
      // 占位符必须单行内放得下：多行输入框高度预算按 inputLines（内容行数）计算，
      // 占位符若折行会让输入框实际高度超预算、把内容区挤出（见 computeRows 注释）。
      placeholder: '输入消息，Enter 发送；Shift+Enter 换行',
      minHeight: 1,
      maxHeight: 5,
      flexGrow: 1,
      textColor: theme.inputText,
      placeholderColor: theme.placeholder,
      backgroundColor: theme.footerBg, // 与灰色块同色：输入区与灰色整块融为一体
      keyBindings: [
        { name: 'return', action: 'submit' },
        { name: 'kpenter', action: 'submit' },
        { name: 'linefeed', action: 'submit' },
        { name: 'return', shift: true, action: 'newline' },
        { name: 'kpenter', shift: true, action: 'newline' },
        { name: 'linefeed', shift: true, action: 'newline' },
        // meta+return 保持默认 submit（Cmd/Ctrl+Enter 仍发送）
      ],
    });
    contentCol.add(input);

    // 模型行（输入框下方，灰色块内）
    footerModel = new TextRenderable(ctx, { content: '', wrapMode: 'none' });
    footerModel.fg = parseColor(theme.footerText);
    contentCol.add(footerModel);

    footerBox.add(contentCol);
  }

  // 子节点顺序：内容行（动态）→ 状态栏 → 灰色块（marginTop:auto 钉底）→ 路径/token 行
  const status = new TextRenderable(ctx, {
    content: '',
    attributes: createTextAttributes({ dim: true }),
    wrapMode: 'none',
  });
  root.add(status);

  // 命令联想列表（输入以 / 开头时显示）：**独立浮层**——绝对定位 + 面板底色，
  // 悬停在输入框（灰色块）上方，不占内容流、不挤动对话（用户要求独立界面，
  // 非当前对话流）。非模态：不拦截输入，用户可继续打字（列表按最新文本过滤，
  // 无匹配自动隐藏）；↑/↓ 高亮、Tab/Enter 填入、鼠标点击某项填入。
  // 位置（top/left）由 repaintTree 每帧按灰色块位置重算（与菜单浮层同理）。
  const suggestBox = new BoxRenderable(ctx, {
    position: 'absolute',
    zIndex: 9, // 低于 /theme 面板浮层（10），高于内容流
    flexDirection: 'column',
    visible: false,
    backgroundColor: theme.suggestBg,
    paddingX: 1,
  });
  root.add(suggestBox);
  const suggestCells: TextRenderable[] = [];
  for (let i = 0; i < 12; i++) {
    const c = new TextRenderable(ctx, { content: '', wrapMode: 'none' });
    suggestBox.add(c);
    suggestCells.push(c);
  }

  // 命令面板浮层（/theme alert）：绝对定位居中（top/left 每帧重算），zIndex 高于内容；
  // 独立于会话流——菜单不占内容行、不参与滚动（用户要求「额外显示一个 alert」）。
  const menuOverlay = new BoxRenderable(ctx, { position: 'absolute', zIndex: 10, visible: false });
  root.add(menuOverlay);
  const menuCells: TextRenderable[] = [];
  for (let i = 0; i < 8; i++) {
    const c = new TextRenderable(ctx, { content: '', wrapMode: 'none' });
    menuOverlay.add(c);
    menuCells.push(c);
  }
  if (footerBox) root.add(footerBox);
  // 路径/token 行：在灰色块下方（不在灰色背景里）——左对齐当前目录，右对齐 token 用量
  const infoRow = new BoxRenderable(ctx, { flexDirection: 'row', justifyContent: 'space-between' });
  footerPath = new TextRenderable(ctx, {
    content: '',
    wrapMode: 'none',
    attributes: createTextAttributes({ dim: true }),
  });
  footerPath.fg = parseColor(theme.footerDim);
  footerTokens = new TextRenderable(ctx, {
    content: '',
    wrapMode: 'none',
    attributes: createTextAttributes({ dim: true }),
  });
  footerTokens.fg = parseColor(theme.footerDim);
  infoRow.add(footerPath);
  infoRow.add(footerTokens);
  if (opts?.withInput) root.add(infoRow);

  const tree: TuiTree = {
    root,
    cells: [],
    status,
    footerBox,
    input,
    blueBar,
    footerModel,
    footerPath,
    footerTokens,
    cardRects: new Map(),
    thinkingRects: new Map(),
    suggestBox,
    suggestCells,
    suggestRect: null,
    menuOverlay,
    menuCells,
  };
  repaintTree(ctx, tree, state, opts);
  return tree;
}

/** 最近一条 applyRowToCell 错误（去重：连续相同错误只记一次，避免长会话刷爆崩溃日志） */
let lastRowError = '';

/**
 * 把一行内容原位应用到复用单元格（chunks 行 → StyledText；普通行 → 文本 + 样式）。
 *
 * 样式必须**无条件**复位：细胞跨帧复用，上一帧可能是蓝色 user 行、下一帧是
 * 无色 answer 行——`fg`/`attributes` 不重置会残留旧颜色（chunk 行复位为主题默认色，
 * 普通行无 fg 时同样回退主题默认色）。
 *
 * 颜色按主题取：亮色模式下内容默认色为深灰（浅底白字不可读），dim 行（思考/meta/
 * 提示行）显式设深灰文字（dim 白字在浅底上同样看不见）；深色模式维持 dim 属性白字。
 */
function applyRowToCell(cell: TextRenderable, row: Row, theme: TuiTheme): void {
  const isLight = isLightTheme(theme);
  if (row.chunks) {
    // 行式 Markdown：按片段构建 StyledText（每片段独立颜色/属性）
    cell.content = new StyledText(
      row.chunks.map((c) => {
        // 亮色模式：dim 且未指定颜色的片段显式设深灰并去掉 dim 属性——
        // dim 属性在浅色终端上按半亮渲染，叠加深灰会发灰发浅（可读性差）；
        // 直接给中深灰纯色更清晰。其余片段照常（带 fg 的按主题映射）。
        const dimNoFg = isLight && c.dim && !c.fg;
        return {
          __isChunk: true as const,
          text: c.text,
          ...(c.fg ? { fg: parseColor(themeColor(c.fg, theme)) } : {}),
          ...(dimNoFg ? { fg: parseColor(theme.contentDim) } : {}),
          ...(c.bg ? { bg: parseColor(c.bg) } : {}),
          attributes:
            (c.bold ? TextAttributes.BOLD : 0) |
            (c.italic ? TextAttributes.ITALIC : 0) |
            (c.dim && !dimNoFg ? TextAttributes.DIM : 0) |
            (c.underline ? TextAttributes.UNDERLINE : 0) |
            (c.strike ? TextAttributes.STRIKETHROUGH : 0),
        };
      })
    );
    (cell as { attributes?: number }).attributes = 0;
    (cell as { fg?: unknown }).fg = parseColor(theme.contentText);
  } else {
    cell.content = row.text;
    // 亮色模式：dim 行（思考/meta/提示）去掉 dim 属性，改显式深灰纯色（理由同上）；
    // 深色模式维持 dim 属性（浅灰效果不变）。
    const style = isLight && row.style.dim && !row.style.fg ? { ...row.style, dim: false } : row.style;
    (cell as { attributes?: number }).attributes = createTextAttributes(style);
    let fg: string | undefined = row.style.fg ? themeColor(row.style.fg, theme) : undefined;
    if (!fg && row.style.dim && isLight) fg = theme.contentDim;
    (cell as { fg?: unknown }).fg = fg ? parseColor(fg) : parseColor(theme.contentText);
  }
}

/**
 * 重绘：更新状态栏，内容行走**细胞池复用**，并画一帧。
 *
 * 关键修复（用户报告「超过 1 屏内容全被清空」的根因）：早期实现每帧
 * remove 全部旧 cells + new TextRenderable——每个 TextRenderable 持有一个
 * 原生 TextBuffer，流式逐字/滚轮/按键触发的反复重建会耗尽原生对象池
 * （实测约 1365 次重绘后 createTextBuffer 抛「Failed to create native
 * renderable」）。异常发生在「旧 cells 已移除、新的还没建完」之间，内容区
 * 就永久清空且每次重试都失败——崩溃日志里 6295 行该错误的实锤。
 *
 * 改为池只增不减：行数增加才新建（一次性原生分配），行数减少只隐藏
 * （visible=false，不销毁、无原生抖动）；行内容原位更新 content/attributes/fg
 * （setter 均为运行时可用，实测 5000 次原位更新零失败）。单行应用失败时
 * 保留旧内容并记崩溃日志，不让整帧挂掉——内容永远不会再被「清空」。
 */
export function repaintTree(ctx: RenderContext, tree: TuiTree, state: TuiState, opts?: { withInput?: boolean }): void {
  const height = (ctx as { height?: number }).height ?? 24;
  const width = (ctx as { width?: number }).width ?? 80;
  // 主题色按最新 themeMode/detectedTheme 重刷：终端主题检测是异步的（OSC 查询可能晚于首帧），
  // 检测完成后 detectedTheme 更新 → 下一帧自动换色（用户消息底色在 buildBody 里同步取主题）
  const theme = themeFor(state);
  if (tree.footerBox) tree.footerBox.backgroundColor = theme.footerBg;
  if (tree.input) {
    tree.input.textColor = theme.inputText;
    tree.input.placeholderColor = theme.placeholder;
    tree.input.backgroundColor = theme.footerBg;
  }
  if (tree.blueBar) {
    tree.blueBar.bg = parseColor(theme.footerBg);
    tree.blueBar.fg = parseColor(theme.accentBlue);
  }
  if (tree.footerModel) tree.footerModel.fg = parseColor(theme.footerText);
  if (tree.footerPath) tree.footerPath.fg = parseColor(theme.footerDim);
  if (tree.footerTokens) tree.footerTokens.fg = parseColor(theme.footerDim);
  // 状态栏：dark 保持 dim 白字（原样）；light 去掉 dim 属性 + 显式深灰文字
  //（浅底上 dim 白字看不见，dim+深灰又会半亮发浅）
  (tree.status as { attributes?: number }).attributes = createTextAttributes(isLightTheme(theme) ? {} : { dim: true });
  tree.status.fg = parseColor(isLightTheme(theme) ? theme.contentDim : '#ffffff');
  // 实时同步输入框高度预算：多行输入框随内容自动增高（1-5 行），每次重绘
  // 按「逻辑行数 + 长行折行」估算当前可见行数（lineCount 不含折行，见
  // estimateInputLines 注释），computeRows 据此收缩内容区——灰色块永远完整可见。
  // 输入框实际宽度 = 视口 - 根内边距(2) - 蓝色细线(1) - 内容列左右 padding(2)
  if (tree.input) {
    const inner = Math.max(1, (width ?? 80) - CONTENT_PAD - 3);
    state.inputLines = Math.min(5, Math.max(1, estimateInputLines(tree.input.plainText, inner)));
  }
  // 命令联想列表（非模态）：paint 时按输入框**最新**文本刷新——联想不拦截输入，
  // 用户可继续打字（列表按新前缀过滤，无匹配自动隐藏）；↑/↓ 高亮、Tab 填入、
  // Enter 直接执行高亮命令、Esc 关闭、鼠标点击某项填入（见 interactive.ts 与
  // startTui 的鼠标 handler）。必须在下方联想浮层渲染块之前刷新（它读 state.cmdSuggest；
  // 联想是独立浮层，不参与内容区预算）。
  if (tree.input && opts?.withInput) {
    state.inputText = tree.input.plainText;
    if (!state.menu && state.inputText.startsWith('/')) {
      // 用户按 Esc 关闭过联想且文本未变 → 保持隐藏（否则 repaintTree 每次
      // 按 inputText 重新生成列表，Esc 就失效了——review 抓到的 bug）
      if (state.cmdSuggestDismissedText === state.inputText) {
        state.cmdSuggest = null;
      } else {
        if (state.cmdSuggestDismissedText !== null) state.cmdSuggestDismissedText = null; // 文本已变 → 恢复联想
        const query = state.inputText.slice(1);
        const names = commandSuggestions(query).map((c) => c.name);
        const cur = state.cmdSuggest;
        let next: CmdSuggestion | null;
        // 命中集合未变（如 /t → /th 都只剩 theme）→ 保留高亮；变了才重置到 0
        if (cur && cur.items.length === names.length && cur.items.every((n, i) => n === names[i])) {
          cur.query = query;
          next = cur;
        } else {
          next = { query, items: names, selected: 0 };
        }
        if (next.items.length === 0) next = null; // 无匹配自动隐藏（互不影响输入）
        state.cmdSuggest = next;
      }
    } else {
      state.cmdSuggest = null;
    }
  }
  // 蓝色细线竖跨**整个灰色块**（贴左缘）：行数 = inputLines + 4 =
  // contentCol paddingY 2 + 输入 inputLines + 间距 1 + 模型 1——每行一个 ▍，
  // 与灰块等高（含上下边距，用户要求高度与灰色背景等高）
  if (tree.blueBar) {
    tree.blueBar.content = Array(state.inputLines + 4).fill(ACCENT_BAR).join('\n');
  }
  // 模型行（输入框下方，灰色块内）+ 路径/token 行（灰色块下方，左右分列）
  if (tree.footerModel) tree.footerModel.content = `模型 ${state.model}`;
  if (tree.footerPath && tree.footerTokens) {
    const inner = Math.max(1, (width ?? 80) - CONTENT_PAD - 2); // 路径/token 行内容宽
    const tokensText = formatTokens(state.tokens.total);
    tree.footerTokens.content = tokensText;
    tree.footerPath.content = truncateMiddle(state.cwd, Math.max(8, inner - visualWidth(tokensText) - 2));
  }
  // 视口过小时隐藏状态栏，优先保证底部完整可见
  //（交互模式需 9 行：灰色块 5（paddingY 2 + 输入 1 + 间距 1 + 模型 1）+ 路径/token 行 1 + 状态栏 1 + 内边距 2；单任务模式仅需 3 行）
  tree.status.visible = opts?.withInput ? height >= 9 : height >= 3;
  tree.status.content = state.status;

  // 命令联想列表内容：› /theme 描述（选中行青色加粗）；行数 = items.length。
  // 独立浮层：每帧按输入框（灰色块）上方重算 top/left（不占内容流）；
  // 底色/文字色按主题（亮色白底深字、深色深底浅字），选中项强调蓝加粗。
  const sug = state.cmdSuggest;
  if (tree.suggestBox) {
    tree.suggestBox.backgroundColor = theme.suggestBg; // 主题可能切换（/theme 或检测晚到）
    const visible = !!sug && sug.items.length > 0;
    tree.suggestBox.visible = visible;
    if (visible && sug) {
      const rows = sug.items.length;
      // 灰色块顶部（0-based 屏幕行）= 视口 - 根底内边距(1) - 路径/token 行(1) - 灰色块(inputLines+4)
      const footerTop = (height ?? 24) - 2 - (state.inputLines + 4);
      // 浮层底部悬停在灰色块上方 1 行；左对齐输入框文字列（left 2 + paddingX 1 = 输入文字 x=3）
      tree.suggestBox.top = Math.max(1, footerTop - rows - 1);
      tree.suggestBox.left = 2;
      tree.suggestRect = { top: tree.suggestBox.top, bottom: tree.suggestBox.top + rows - 1 };
    } else {
      tree.suggestRect = null;
    }
  }
  for (let i = 0; i < tree.suggestCells.length; i++) {
    const cell = tree.suggestCells[i];
    if (!sug || i >= sug.items.length) {
      cell.visible = false;
      continue;
    }
    cell.visible = true;
    const name = sug.items[i];
    const cmd = findCommand(name);
    const selected = i === sug.selected;
    const body = `/${name}  ${cmd?.description ?? ''}`;
    const cut = fitCount(body, (width ?? 80) - CONTENT_PAD);
    const text = `${selected ? '› ' : '  '}${cut >= body.length ? body : `${body.slice(0, cut)}…`}`;
    try {
      cell.content = new StyledText([
        {
          __isChunk: true as const,
          text,
          fg: parseColor(selected ? theme.accentBlue : theme.suggestText),
          attributes: selected ? TextAttributes.BOLD : 0,
        },
      ]);
    } catch (e) {
      logCrash('suggest-row', e);
    }
  }

  // 命令面板浮层（/theme alert）：绝对定位、水平垂直居中、zIndex 高于内容；
  // 每帧按视口重算位置，行内容原地更新（细胞池复用，不重建 TextRenderable）
  if (tree.menuOverlay) {
    const menu = state.menu;
    if (!menu) {
      tree.menuOverlay.visible = false;
    } else {
      const panelW = Math.min(Math.max(20, (width ?? 80) - CONTENT_PAD), 44);
      const panelRows = menuPanelRows(menu, panelW);
      tree.menuOverlay.visible = true;
      tree.menuOverlay.top = Math.max(1, Math.floor(((height ?? 24) - panelRows.length) / 2));
      tree.menuOverlay.left = Math.max(1, Math.floor(((width ?? 80) - panelW) / 2));
      for (let i = 0; i < tree.menuCells.length; i++) {
        const cell = tree.menuCells[i];
        if (i >= panelRows.length) {
          cell.visible = false;
          continue;
        }
        cell.visible = true;
        try {
          applyRowToCell(cell, panelRows[i], theme);
        } catch (e) {
          logCrash('menu-row', e);
        }
      }
    }
  }

  const rows = computeRows(state, { height, width }, opts);
  const anchor = tree.status; // 内容行始终插在状态栏之前（联想列表是独立浮层，不在内容流里）
  while (tree.cells.length < rows.length) {
    // 池增长：新建细胞插到状态栏前（一次原生分配；此后原位更新不再分配）
    const cell = new TextRenderable(ctx, { content: '', wrapMode: 'none' });
    tree.cells.push(cell);
    tree.root.insertBefore(cell, anchor);
  }
  // 刷新卡片/思考命中区域：内容行 i 的鼠标事件坐标 y = i（0-based；无边框，屏幕行 1+i 减 1）。
  // 供点击 handler 把点击坐标映射回卡片/思考行（见 startTui、CardRect、hitTestThinking 注释）。
  tree.cardRects.clear();
  tree.thinkingRects.clear();
  for (let i = 0; i < tree.cells.length; i++) {
    const cell = tree.cells[i];
    if (i >= rows.length) {
      cell.visible = false; // 行数减少：隐藏多余细胞，不销毁
      continue;
    }
    cell.visible = true;
    try {
      applyRowToCell(cell, rows[i], theme);
    } catch (e) {
      // 单行失败保留旧内容，不让整帧挂掉；连续相同错误只记一次（防刷爆日志）
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== lastRowError) {
        lastRowError = msg;
        logCrash('repaint-row', e);
      }
    }
    const cardId = rows[i].cardId;
    if (cardId !== undefined) {
      const y = i;
      const rect = tree.cardRects.get(cardId);
      if (rect) rect.bottom = y;
      else tree.cardRects.set(cardId, { top: y, bottom: y });
    }
    const thinkingIdx = rows[i].thinkingIdx;
    if (thinkingIdx !== undefined) tree.thinkingRects.set(i, thinkingIdx);
  }
}

/** OpenTUI 鼠标事件的结构化子集（滚轮滚动 + 点击展开卡片用） */
interface MouseEventLike {
  type?: string;
  scroll?: { direction?: string; delta?: number };
  /** 坐标：0-based 事件坐标（无边框布局；内容行 i 位于 y = i） */
  x?: number;
  y?: number;
  /** 按钮：0 = 左键（MouseButton.LEFT） */
  button?: number;
}

/** 创建 TUI 会话：建树 + 首帧，返回 paint/stop/input/onKeyPress */
export async function startTui(state: TuiState, opts?: { withInput?: boolean }): Promise<TuiSession> {
  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  const ctx = renderer as unknown as RenderContext; // CliRenderer 实现了 RenderContext
  // 主题检测：OpenTUI 通过 OSC 10/11 查询终端背景色并按亮度推断亮/暗。
  // 结果存 detectedTheme（themeMode=system 时取色用）；超时/不支持保持默认深色。
  try {
    const mode = await renderer.waitForThemeMode(400);
    if (mode === 'light' || mode === 'dark') state.detectedTheme = mode;
  } catch {
    // 主题查询失败 → detectedTheme 保持默认深色
  }
  const tree = mountTree(ctx, state, opts);

  // 重绘串行化 + 尾沿合并：OpenTUI 渲染器不允许并发 loop()（原生侧非线程安全，
  // 并发调用是闪退高危候选），而流式节流/按键/滚轮/flush 的 paint 可能重叠。
  // 策略：一帧执行期间到达的新调用只置 paintQueued，当前帧结束后补跑一帧——
  // 保证「先写 scrollIntent 再 paint」的意图一定被补帧消费（否则意图滞留、
  // 滚轮/连按会被静默丢弃）；flush 等待批次排空，避免与 stop 竞争。
  // 单次失败写崩溃日志后继续，不让整个 TUI 拖崩。
  let paintRunning = false;
  let paintQueued = false;
  let paintSettled: Promise<void> = Promise.resolve();
  const paint = async (): Promise<void> => {
    if (paintRunning) {
      paintQueued = true; // 有帧在跑：请求补一帧（消费最新 state），并等当前批次结束
      await paintSettled;
      return;
    }
    paintRunning = true;
    const run = (async () => {
      try {
        do {
          paintQueued = false;
          try {
            repaintTree(ctx, tree, state, opts);
            // 显式画一帧（与测试渲染器 renderOnce 内部一致；CLI 渲染器同样可用）
            await (renderer as unknown as { loop(): Promise<void> }).loop();
          } catch (e) {
            logCrash('paint', e);
          }
        } while (paintQueued); // 执行期间又有请求 → 补一帧，直到无人请求
      } finally {
        paintRunning = false;
      }
    })();
    paintSettled = run.catch(() => {});
    await paintSettled;
  };

  // 鼠标滚轮滚动：OpenTUI 上报 SGR 滚轮事件（\e[<64/65;x;yM）并沿渲染树冒泡到根 Box。
  // 在根 Box 上挂处理器（实例属性遮蔽原型 onMouseEvent 方法，属刻意为之）：
  // 滚轮上/下 → 滚动意图（每格约 3 行），与键盘滚动同一套机制；只在 scroll 类型事件时
  // 消费，点击/移动保持默认行为（不干扰输入框聚焦）。同方向连续滚轮累加步长——
  // 帧执行期间到达的多格并入同一意图，由尾沿补帧一次性消费，快速连滚不丢格。
  (tree.root as unknown as { onMouseEvent?: (e: MouseEventLike) => void }).onMouseEvent = (e) => {
    // 命令面板浮层打开时忽略鼠标（滚动/点击都不穿透到下层内容，避免误点工具卡片）
    if (state.menu) return;
    // 滚轮：滚动意图（见上）
    if (e.type === 'scroll' && e.scroll) {
      const dir = e.scroll.direction;
      if (dir !== 'up' && dir !== 'down') return;
      const action = dir === 'up' ? 'line-up' : 'line-down';
      const lines = Math.min(6, Math.max(1, Math.round(e.scroll.delta ?? 1) * 3));
      const prev = state.scrollIntent;
      state.scrollIntent =
        prev && prev.action === action ? { action, lines: (prev.lines ?? 1) + lines } : { action, lines };
      void paint();
      return;
    }
    // 左键点击：
    // ① 命令联想浮层：点击某项 → 填入该命令（等同 Tab，可继续编辑后 Enter 执行）；
    //    浮层区域内的点击不穿透到下层内容（避免误触被遮挡的工具卡片）；
    // ② 思考折叠态：点击某条折叠摘要 → 单独展开该条思考（再次点击收起）；
    // ③ 命中工具卡片 → 切换展开/收起。
    // 坐标语义：MouseEvent.y 为 0-based（实测 SGR y 减 1）；repaintTree 已把
    // 每个可见卡片/思考行按事件坐标登记（内容行 i → y = i）。
    if (e.type === 'down' && e.button === 0 && typeof e.y === 'number') {
      if (state.cmdSuggest && tree.suggestRect && tree.input) {
        const { top, bottom } = tree.suggestRect;
        if (e.y >= top && e.y <= bottom) {
          const idx = e.y - top;
          const sel = state.cmdSuggest.items[idx];
          if (sel) {
            tree.input.setText(`/${sel} `); // 尾空格让联想自动隐藏（与 Tab 同语义）
            state.cmdSuggest = null;
          }
          void paint();
          return;
        }
      }
      if (hitTestThinking(state, tree.thinkingRects, e.y)) void paint();
      else if (hitTestCard(state, tree.cardRects, e.y)) void paint();
    }
  };

  await paint();
  // 跟踪 onKeyPress 订阅：stop() 时统一清理，避免订阅泄漏
  const keyUnsubs = new Set<() => void>();
  // 主题检测可能晚于首帧完成（OSC 查询异步返回）：收到 theme_mode 事件时
  // 更新 detectedTheme 并重绘（repaintTree 每帧按最新主题取色；system 模式自动跟随）
  const onThemeMode = (mode: unknown): void => {
    if (mode === 'light' || mode === 'dark') {
      state.detectedTheme = mode;
      void paint();
    }
  };
  renderer.on('theme_mode', onThemeMode as () => void);
  const unsubTheme = () => {
    renderer.off('theme_mode', onThemeMode as () => void);
  };
  keyUnsubs.add(unsubTheme);
  return {
    paint,
    stop: async () => {
      for (const unsub of keyUnsubs) unsub();
      keyUnsubs.clear();
      renderer.stop();
    },
    input: tree.input,
    onKeyPress: (cb) => {
      const handler = (key: TuiKey) => {
        cb(key);
      };
      renderer.keyInput.on('keypress', handler);
      const unsub = () => {
        renderer.keyInput.off('keypress', handler);
      };
      keyUnsubs.add(unsub);
      return () => {
        keyUnsubs.delete(unsub);
        unsub();
      };
    },
  };
}

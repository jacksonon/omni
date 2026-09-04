/**
 * TUI 内容行构建：状态 → 全部内容行（buildBody）→ 可见窗口（computeRows）。
 *
 * 从 render.ts 拆出（业务划分）：纯函数行构建与滚动数学独立成层（不依赖
 * OpenTUI renderable），render.ts 只做挂载/重绘/事件编排。行式渲染的核心
 * 折行数学在 layout.ts，主题取色在 theme.ts。
 */
import { statSync } from 'node:fs';
import path from 'node:path';
import {
  cardBottomLine,
  cardContentLine,
  cardInnerWidth,
  cardTitleLine,
  toolCardLines,
  truncateToWidth,
  wrapText,
  type DiffHalfKind,
  type ToolCardLine,
  type ToolCardRole,
} from '../output/format.js';
import { INLINE_CODE_FG, markdownToRows, type MdChunk } from './markdown.js';
import { t, tf, type TuiLang } from './i18n.js';
import { CONTENT_PAD, STREAM_CURSOR, colToChar, formatCompact, formatToolDur, userPadRow, wrapChunks, wrapRow, wrapUserLine } from './layout.js';
import { visualWidth } from './width.js';
import { isLightTheme, themeColor, themeFor, type TuiTheme } from './theme.js';
import { TRACE_W } from './trace.js';
import { SPINNER_FRAMES, type CmdPanel, type TuiLineKind, type TuiMenu, type TuiState, type ToolStatus } from './state.js';

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
    case 'tokens':
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
  /** 所属 token 统计模块的行下标（tokens 行点击展开/收起；非 tokens 行为 undefined） */
  tokensIdx?: number;
  /** 审批卡片的 id（state.approval；点击「批准/拒绝」区域用） */
  approvalId?: number;
  /** 本行内的可点击本地文件链接（行内代码里的真实文件路径）：{ 行内起始列, 显示宽度, 绝对路径 } */
  fileLinks?: { col: number; width: number; path: string }[];
  /** 菜单面板行的选项下标（menuPanelRows 窗口内选项行；标题/提示/底边行 = undefined，点击忽略） */
  menuIdx?: number;
}

/**
 * 拖选选区（字符级）：{anchor/focus} 以行下标 + 列（显示列）表示。
 * anchor = 按下起点、focus = 当前焦点；渲染/提取时归一化成 [start..end]。
 */
export interface TuiSelection {
  /** 起点的内容行下标（rows 数组索引） */
  aRow: number;
  /** 起点的显示列（0-based，相对行首） */
  aCol: number;
  /** 焦点的内容行下标 */
  fRow: number;
  /** 焦点的显示列 */
  fCol: number;
}

/**
 * 判断一个选区是否跨了多余一行（用于鼠标 up 时判断「是否发生了拖动」：
 * 起点与焦点同行同列 = 纯点击，不复制）。
 */
export function selectionMoved(sel: TuiSelection): boolean {
  return sel.aRow !== sel.fRow || sel.aCol !== sel.fCol;
}

/** 归一化选区：返回 [start, end] 两个 {row, col}（按行优先排序） */
function normRange(sel: TuiSelection): { s: { row: number; col: number }; e: { row: number; col: number } } {
  const a = { row: sel.aRow, col: sel.aCol };
  const f = { row: sel.fRow, col: sel.fCol };
  if (a.row < f.row || (a.row === f.row && a.col <= f.col)) return { s: a, e: f };
  return { s: f, e: a };
}

/**
 * 横向取一行内某个字符区间（半开 [startCharInc, endCharExc)）在显示列上的范围。
 * 拖选列坐标直接用显示列（字符宽度经 colToChar 换算），无需在这里折行。
 */
export function rowSelChars(row: Row, aCol: number, bCol: number): { start: number; end: number } {
  // layout 只 type-import Row，无值级循环依赖，直接导入即可
  // 拖到行尾之外 → 取到行尾（colToChar 递进式会漏最后一个字符：如行宽 11、拖到列 12
  // → 只含前 7 字符漏末字。这里先把超宽列对准行尾，再交给 colToChar 换算）
  const w = visualWidth(row.text);
  const a = aCol >= w ? row.text.length : colToChar(row.text, aCol);
  const b = bCol >= w ? row.text.length : colToChar(row.text, bCol);
  return { start: a, end: b };
}

/**
 * 对一行应用选区高亮：把 [aCol, bCol) 的显示列范围标成 selBg/selFg。
 * 返回克隆后的 Row（chunks 重建；不修改原行）。woodrow 与原 chunks 同结构。
 */
export function markRowSelected(row: Row, aCol: number, bCol: number, theme: TuiTheme): Row {
  if (aCol >= bCol) return row;
  const { start, end } = rowSelChars(row, aCol, bCol);
  if (start >= end) return row;
  const text = row.text;
  const base: MdChunk[] = row.chunks ?? [{ text, ...row.style }];
  const out: MdChunk[] = [];
  let charIdx = 0;
  for (const c of base) {
    const cEnd = charIdx + c.text.length;
    // 片段落在选中区间之外：原样
    if (start >= cEnd || end <= charIdx) {
      out.push(c);
      charIdx = cEnd;
      continue;
    }
    // 片段前半（未选中）
    if (charIdx < start && start < cEnd) {
      out.push({ ...c, text: c.text.slice(0, start - charIdx) });
    }
    // 选中部分
    const selStart = Math.max(start, charIdx);
    const selEnd = Math.min(end, cEnd);
    out.push({
      ...c,
      text: c.text.slice(selStart - charIdx, selEnd - charIdx),
      fg: theme.selFg,
      bg: theme.selBg,
      bold: false,
      dim: false,
      italic: false,
      underline: false,
      strike: false,
    });
    // 片段后半（未选中）
    if (cEnd > end) {
      out.push({ ...c, text: c.text.slice(selEnd - charIdx) });
    }
    charIdx = cEnd;
  }
  return { ...row, chunks: out.filter((c) => c.text.length > 0) };
}

/** 从 rows 提取选区文本（跨多行用 \n 连接）；字符级精选取（列坐标按行 text 换算） */
export function selectionText(rows: Row[], sel: TuiSelection): string {
  const { s, e } = normRange(sel);
  const lines: string[] = [];
  for (let r = s.row; r <= e.row; r++) {
    const row = rows[r];
    if (!row) continue;
    const aCol = r === s.row ? s.col : 0;
    const bCol = r === e.row ? e.col : row.text.length * 2; // 中间行取到底
    const { start, end } = rowSelChars(row, aCol, bCol);
    if (start < end) lines.push(row.text.slice(start, end));
  }
  return lines.join('\n');
}

/**
 * 工具卡片块底色 + 文字色：按执行状态取色——成功 → 淡绿底深字、
 * 失败 → 淡红底深红字、执行中 → 超淡黄底深棕字（用户要求「执行成功淡绿色背景，
 * 执行异常淡红色背景」；两主题统一）。
 */
function toolCardColors(status: ToolStatus, theme: TuiTheme): { bg: string; dim: string } {
  if (status === 'ok') return { bg: theme.cardOkBg, dim: theme.cardOkDim };
  if (status === 'err') return { bg: theme.cardErrBg, dim: theme.cardErrDim };
  return { bg: theme.cardBg, dim: theme.cardDim };
}

/** 工具卡片的行样式：命令加粗深色、执行/结果/分隔/输出/提示深色；顶/底为空白留白行 */
function toolRowStyle(role: ToolCardRole, status: ToolStatus, theme: TuiTheme): RowStyle {
  const { dim } = toolCardColors(status, theme);
  switch (role) {
    case 'top':
    case 'bottom':
      // 顶/底留白行：只有底色（块式卡片的垂直边距），无文字样式
      return {};
    case 'cmd':
      // 第一行命令：加粗 + 状态色深字（淡底上默认白字/黑字都不可读，统一深色）
      return { bold: true, fg: dim };
    case 'exec':
    case 'result':
    case 'sep':
    case 'out':
    case 'hint':
      // 状态色深字：与底色（淡绿/淡红/淡黄）协调
      return { fg: dim };
    case 'diff':
      // diff 行颜色按半列/整行在 toolCardRow 里逐 chunk 指定（红=删除、绿=新增）
      return {};
    default:
      return {};
  }
}

/**
 * 工具卡片行（块式）：不再用 ╭─╮│╰╯ 边框——整行以状态底色（成功淡绿/失败淡红/
 * 执行中超淡黄）填充成色块（用户要求「代码执行使用有颜色背景区域的块，而不是用
 * 一个边框」），文字按角色着色（命令加粗、执行/结果/输出状态色深字）。每行已由
 * toolCardLines 补齐到内容宽度，背景色填满整行，多行拼成完整色块。
 *
 * **完整长方形**（用户要求「不要缺角」）：顶/底留白行也整行状态底色填满——
 * 不再是左右角透明的圆角块，四角直角、无缺口。
 *
 * diff 行（write_file 左右对比）：按 ToolCardLine.diff 的左右两半**逐 chunk 着色**
 * ——删除半列红、新增半列绿、未改动半列状态深字，中间 `│` 分隔；整行色（新增
 * 文件全文，diffRole='add'）整行绿色。
 */
function toolCardRow(line: ToolCardLine, status: ToolStatus, theme: TuiTheme, toolName?: string): Row {
  if (line.diffRole) {
    // 整行 diff 色（统一 diff 行：新增绿/删除红/上下文灰）——行级背景色 + 文字色
    const fg = line.diffRole === 'add' ? theme.diffAdd : line.diffRole === 'rem' ? theme.diffRem : theme.cardDim;
    const lineBg = line.diffRole === 'add' ? theme.diffAddBg : line.diffRole === 'rem' ? theme.diffRemBg : theme.diffCtxBg;
    const chunks: MdChunk[] = [{ text: line.text, fg, bg: lineBg }];
    return { text: line.text, style: {}, chunks };
  }

  const isNoBg =
    status === 'running' ||
    toolName === 'read_file' ||
    toolName === 'search_code' ||
    toolName === 'list_directory' ||
    toolName === 'run_command' ||
    toolName === 'web_fetch' ||
    toolName === 'web_search' ||
    toolName === 'write_file' ||
    toolName === 'edit_file';
  if (isNoBg) {
    if (line.role === 'top' || line.role === 'bottom') {
      return { text: '', style: {} };
    }
    const contentStyle = toolRowStyle(line.role, status, theme);
    if (line.text.includes('● Bash') || line.text.startsWith('$ ') || line.text.trim().startsWith('$')) {
      const match = line.text.match(/^(\s*)(\$|●\s*Bash)(\s*)(.*)$/);
      if (match) {
        const [, sp1, prompt, sp2, cmd] = match;
        const chunks: MdChunk[] = [
          { text: sp1 },
          { text: prompt, fg: theme.modeBuild, bold: true },
          { text: sp2 },
          { text: cmd, fg: theme.cardDim, bold: true },
        ];
        return { text: line.text, style: {}, chunks };
      }
    }
    return { text: line.text, style: contentStyle, chunks: [{ text: line.text, ...contentStyle }] };
  }

  const { bg } = toolCardColors(status, theme);
  if (line.role === 'top' || line.role === 'bottom') {
    // 完整长方形：整行状态底色填满（text 为全空格，长度 == 列数），无透明角
    const w = Math.max(3, line.text.length);
    const chunks: MdChunk[] = [{ text: ' '.repeat(w), bg }];
    return { text: line.text, style: {}, chunks };
  }
  if (line.diff) {
    // 左右对比：左半（删除红/未改动深色）+ `│` 分隔 + 右半（新增绿/未改动深色）
    const { left, lk, right, rk } = line.diff;
    const halfStyle = (k: DiffHalfKind): RowStyle =>
      k === 'rem' ? { fg: theme.diffRem } : k === 'add' ? { fg: theme.diffAdd } : { fg: theme.cardDim };
    const lc = halfStyle(lk);
    const rc = halfStyle(rk);
    const chunks: MdChunk[] = [
      { text: ` ${left}`, ...lc, bg },
      { text: '│', fg: theme.cardDim, bg },
      { text: right, ...rc, bg },
    ];
    return { text: line.text, style: {}, chunks };
  }
  if (line.diffRole) {
    // 整行 diff 色（统一 diff 行：新增绿/删除红/上下文灰）——行级背景色 + 文字色，
    // Claude Code Edit 风格：新增行淡绿底深绿字、删除行淡红底深红字、上下文行淡灰底深字
    const fg = line.diffRole === 'add' ? theme.diffAdd : line.diffRole === 'rem' ? theme.diffRem : theme.cardDim;
    const lineBg = line.diffRole === 'add' ? theme.diffAddBg : line.diffRole === 'rem' ? theme.diffRemBg : theme.diffCtxBg;
    const chunks: MdChunk[] = [{ text: line.text, fg, bg: lineBg }];
    return { text: line.text, style: {}, chunks };
  }
  const contentStyle = toolRowStyle(line.role, status, theme);
  const chunks: MdChunk[] = [{ text: line.text, ...contentStyle, bg }];
  return { text: line.text, style: {}, chunks };
}

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
/**
 * 扁平面板行（菜单/命令输出面板，同联想下拉风格——无圆角边框）：
 * 行首 1 空格 + 文本截断兜底 + 补空格铺满整行（总宽恒 = width）。
 */
function flatPanelLine(text: string, width: number): string {
  const t = truncateToWidth(text, width - 1);
  return ` ${t}${' '.repeat(Math.max(0, width - 1 - visualWidth(t)))}`;
}

/**
 * 菜单面板行（/theme /permission /variants /model /session 等）：扁平面板 + 选项列表。
 * 选项超面板高度时**窗口滚动**（同联想浮层 suggestBox 模式）：`menu.scrollTop` 记录
 * 窗口首项下标，渲染时收敛到合法区间且**选中项恒在窗口内**（交互层 ↑/↓ 移动
 * selectedIndex，这里兜底跟随滚动——连续按键逐帧重绘即连续滚动）；窗口外上下各一条
 * 「↑/↓ 还有 N 个（↑/↓ 滚动）」提示行。maxVisible 缺省 = 全部（无滚动，旧行为）。
 */
export function menuPanelRows(
  menu: TuiMenu,
  contentWidth: number,
  lang: TuiLang = 'zh',
  maxVisible?: number
): Row[] {
  // 窗口大小：全部放得下就不滚；否则按预算收缩（至少 1 行，且不超过选项总数）
  const win = maxVisible === undefined ? menu.options.length : Math.max(1, Math.min(maxVisible, menu.options.length));
  // 滚动位置收敛：选中项必须保持在窗口内（交互层已维护，这里兜底外部状态变更）
  const maxTop = Math.max(0, menu.options.length - win);
  let top = Math.min(menu.scrollTop ?? 0, maxTop);
  if (menu.selectedIndex < top) top = menu.selectedIndex;
  else if (menu.selectedIndex >= top + win) top = Math.max(0, Math.min(maxTop, menu.selectedIndex - win + 1));
  menu.scrollTop = top;
  const above = top; // 窗口上方还有的项数
  const below = Math.max(0, menu.options.length - (top + win)); // 窗口下方还有的项数
  // 顶部留白行（空格，空文本高度 0 不能用）：标题不贴面板顶边（用户要求）
  const rows: Row[] = [
    { text: ' ', style: {} },
    { text: flatPanelLine(menu.title, contentWidth), style: { fg: 'cyan', bold: true } },
  ];
  if (above > 0) {
    rows.push({
      text: flatPanelLine(tf(lang, 'suggest.hint', { arrow: '↑', n: above }), contentWidth),
      style: { dim: true },
    });
  }
  for (let k = top; k < top + win; k++) {
    const opt = menu.options[k]!;
    if (opt.group) {
      // 分组头行：dim、不可选中（不渲染光标/✓，不登记 menuIdx——点击忽略）
      rows.push({
        text: flatPanelLine(opt.label, contentWidth),
        style: { dim: true },
      });
      continue;
    }
    const cursor = k === menu.selectedIndex ? '› ' : '  ';
    const check = opt.value === menu.currentValue ? ' ✓' : '';
    rows.push({
      text: flatPanelLine(`${cursor}${opt.label}${check}`, contentWidth),
      style: k === menu.selectedIndex ? { fg: 'cyan', bold: true } : {},
      menuIdx: k,
    });
  }
  if (below > 0) {
    rows.push({
      text: flatPanelLine(tf(lang, 'suggest.hint', { arrow: '↓', n: below }), contentWidth),
      style: { dim: true },
    });
  }
  rows.push({ text: flatPanelLine(t(lang, 'menu.hint'), contentWidth), style: { dim: true } });
  return rows;
}

/**
 * 命令输出面板行（所有 / 命令的独立窗口）：扁平面板 + 标题 + 输出行 + 滚动提示。
 * 内容行按面板宽折行（每行恰好 1 个终端行），超高时垂直滚动
 * （panel.scroll 由交互层 ↑/↓ 调整，这里 clamp 到合法区间并回写）。
 */
export function cmdPanelRows(panel: CmdPanel, contentWidth: number, footerTop: number, lang: TuiLang = 'zh'): Row[] {
  // 可见主体行数：面板总高（留白 1 + 标题 1 + 主体 + 提示 1）≤ footerTop - 1（顶 ≥1、底贴灰块）
  const maxVisible = Math.max(2, footerTop - 4);
  // 长行折行成多行（内容完整可滚动查看，不截断）；源行之间不插空行（保持紧凑）
  const body: string[] = [];
  for (const raw of panel.lines) {
    for (const seg of wrapText(raw, contentWidth - 1)) body.push(seg);
  }
  const total = body.length;
  const scroll = Math.min(Math.max(0, panel.scroll), Math.max(0, total - maxVisible));
  panel.scroll = scroll;
  const visible = body.slice(scroll, scroll + maxVisible);
  const rows: Row[] = [{ text: flatPanelLine(panel.title, contentWidth), style: { fg: 'cyan', bold: true } }];
  if (visible.length === 0) rows.push({ text: flatPanelLine(t(lang, 'cmdpanel.none'), contentWidth), style: { dim: true } });
  for (const t of visible) rows.push({ text: flatPanelLine(t, contentWidth), style: {} });
  const remain = total - (scroll + maxVisible);
  rows.push({
    text: flatPanelLine(remain > 0 ? tf(lang, 'cmdpanel.hint', { n: remain }) : t(lang, 'cmdpanel.close'), contentWidth),
    style: { dim: true },
  });
  return rows;
}

/**
 * 工具调用审批卡片（安全护栏）：`state.approval` 非空时渲染。
 * 与工具卡片同款圆角方框：标题行 `╭─ 需要审批 ─╮` + 工具/原因 + 批准/拒绝按钮行。
 * 点击左侧区域批准、右侧区域拒绝（approvalId 标记整卡，startTui 按点击 x 列判定）；
 * 键盘：y/Enter 批准、n/Esc 拒绝（interactive.ts 在 state.approval 时拦截）。
 */
export function approvalPanelRows(
  approval: { tool: string; summary: string; reason: string },
  contentWidth: number,
  lang: TuiLang = 'zh'
): Row[] {
  const inner = cardInnerWidth(contentWidth);
  const rows: Row[] = [{ text: `╭${'─'.repeat(inner)}╮`, style: { fg: 'yellow' } }];
  rows.push({ text: cardContentLine(`需要审批：${approval.tool}`, inner), style: { bold: true } });
  rows.push({ text: cardContentLine(approval.summary, inner), style: { dim: true } });
  rows.push({ text: cardContentLine(`原因：${approval.reason}`, inner), style: { dim: true } });
  rows.push({
    text: cardContentLine(t(lang, 'approval.hint'), inner),
    style: { bold: true },
  });
  rows.push({ text: cardBottomLine(inner), style: { fg: 'yellow' } });
  return rows;
}

/**
 * 把行内代码文本解析为磁盘上真实存在的本地文件（绝对路径或相对 cwd）。
 * 只认**文件**（目录不算可点击链接）；去掉结尾常见标点（散文里 `` `path` `` 后
 * 常跟逗号/句号/括号等——`src/foo.ts,` 应命中 `src/foo.ts`）；不存在/含换行返回 null。
 * 每次实时 stat（不缓存）：会话中 agent 可能刚 write_file 创建了该文件，缓存会让
 * 渲染过的路径永远不可点（负缓存更糟——写文件后仍不可点）。
 */
export function resolveLocalFile(text: string, cwd: string): string | null {
  let p = text.trim();
  p = p.replace(/[,.;:!?)\]}>，。；：！？）》」』、]+$/, '');
  if (!p || p.includes('\n')) return null;
  const abs = p.startsWith('/') ? p : path.resolve(cwd, p);
  try {
    return statSync(abs).isFile() ? abs : null;
  } catch {
    return null;
  }
}

/**
 * 收集一行（已折行）chunks 内的可点击文件链接：遍历 chunks 累计显示列偏移，
 * 带 `link` 的 chunk（行内代码且磁盘真实存在）记一个 { col, width, path } 跨度。
 * 路径若被折行拆成多段，每段各自带 link——每行各得一个部分宽度跨度，点任一段都打开。
 */
export function collectFileLinks(chunks: MdChunk[] | undefined): { col: number; width: number; path: string }[] | undefined {
  if (!chunks) return undefined;
  let links: { col: number; width: number; path: string }[] | undefined;
  let col = 0;
  for (const c of chunks) {
    const w = visualWidth(c.text);
    if (c.link) (links ??= []).push({ col, width: w, path: c.link });
    col += w;
  }
  return links;
}

/** 状态 → 全部内容行（未裁剪窗口），每行已按内容宽度折行（不截断） */
export function buildBody(state: TuiState, width: number): Row[] {
  const theme = themeFor(state);
  const body: Row[] = [];
  // 会话标题不显示在信息流里——首轮对话后由模型自动生成，改设为终端窗口/标签页标题
  // （setTerminalTitle，见 interactive.ts），保持对话流纯净。
  // 内容组间距：thinking / tool（工具卡片）/ other 三类内容组之间留空行。
  //（用户反馈「工具区域附近的思考或回答不要紧贴」）：工具卡片上方/下方与思考、回答
  // 之间都插空行；连续 thinking 段落之间不加；**每次工具执行之间也留 1 行间距**（用户
  // 反馈「每一次工具执行彼此不要合在一起」——同一轮并行调用各自成卡、不同轮多次调用
  // 的卡片不再紧贴，见下方 tool 分支的 cardId 判定）；已有空行不重复插（如 user 消息
  // 自带尾随空行）；**卡片顶/底留白行是卡片的一部分**（cardId 非空，带底色），不视为
  // 分隔空行——切出工具区域时仍要插真正的空行。
  // **所有组间切换统一留 1 行**（含 thinking ↔ 工具卡片——用户反馈「命令执行的块区域和
  // 下面的文字距离太远了」：此前 thinking↔tool 双向 2 行 + 卡片顶/底留白，卡片与下方
  // 思考/回答之间视觉间隔过大，统一收为 1 行）。
  // token 统计模块是独立组（tokens）：回答文本 → 统计模块之间插 1 行间距（用户反馈
  //「token 统计显示位置需要和回答中文本有一点间距，目前贴到一起了」）。
  let prevGroup: 'thinking' | 'tool' | 'tokens' | 'other' | null = null;
  const isRealBlank = (r: Row): boolean => r.text === '' && r.cardId === undefined;
  const pushGap = (rows: number): void => {
    for (let i = 0; i < rows; i++) body.push({ text: '', style: {} });
  };
  for (let li = 0; li < state.lines.length; li++) {
    const line = state.lines[li];
    const group: 'thinking' | 'tool' | 'tokens' | 'other' =
      line.kind === 'thinking' ? 'thinking' : line.kind === 'tool' ? 'tool' : line.kind === 'tokens' ? 'tokens' : 'other';
    if (group !== prevGroup && body.length > 0 && !isRealBlank(body[body.length - 1])) {
      pushGap(1);
    }
    prevGroup = group;
    if (line.kind === 'answer') {
      // 最终回答走行式 Markdown 渲染（加粗/行内代码/代码块/标题/引用/表格/列表/任务清单等）。
      // 传内容宽度：表格按此收缩列宽（超宽截断），每行不折行、对齐不被打断。
      // 亮色模式下把 markdown 的浅色常量（代码块/行内代码/引用/标题 cyan）映射为深色变体，
      // 否则浅底上看不清（用户报告：亮色下 AI 输出白字）。
      // **本地文件链接**（用户要求）：行内代码 `` `path` `` 且磁盘上真实存在的文件 →
      // 标记 link + 下划线（可点击提示），点击在外部 $EDITOR 打开（见 render.ts）。
      // 检测在主题映射之前：INLINE_CODE_FG 是行内代码的原始色（themeColor 会改写）。
      for (const md of markdownToRows(line.text, width)) {
        const chunks = md.chunks.map((c) => {
          const themed = c.fg ? { ...c, fg: themeColor(c.fg, theme) } : c;
          if (c.fg === INLINE_CODE_FG) {
            const abs = resolveLocalFile(c.text, state.cwd);
            if (abs) return { ...themed, link: abs, underline: true };
          }
          return themed;
        });
        for (const w of wrapRow(
          { text: chunks.map((c) => c.text).join(''), style: rowStyle(line.kind), chunks },
          width
        )) {
          const links = collectFileLinks(w.chunks);
          body.push(links && links.length > 0 ? { ...w, fileLinks: links } : w);
        }
      }
      continue;
    }
    if (line.kind === 'tool' && line.card) {
      // 每次工具执行之间留 1 行间距：连续工具卡片（同一轮并行调用各自成卡、不同轮多次
      // 调用）彼此不再紧贴——用户要求「每一次工具执行彼此不要合在一起」。判定锚点是
      // 上一行是否属于另一张卡片（工具卡片的顶/底留白行也带 cardId，天然可判）：
      // cardId 非空且与当前卡不同才插空行——并行多读合并成的同一张卡不重复插，
      // 卡片与思考/回答/用户消息之间的间距已由上方组间距逻辑处理，这里不掺和。
      const lastRow = body[body.length - 1];
      if (lastRow && lastRow.cardId !== undefined && lastRow.cardId !== line.card.id) {
        pushGap(1);
      }
      // 工具调用卡片：颜色背景块（命令/执行缩略/结果缩略），收起/展开由
      // card.expanded 决定（点击切换）。执行中（status=running）时把当前 spinner
      // 帧传进卡片——执行中行只显示动画 loading、**无「执行中…」文字**（用户要求）；
      // 帧由 TuiOutput 的 200ms 定时器推进，无动画（spinnerIndex=-1）时缺省 ⏳。
      const spinner =
        state.spinnerIndex >= 0 ? SPINNER_FRAMES[state.spinnerIndex % SPINNER_FRAMES.length] : undefined;
      const lines = toolCardLines({ ...line.card, spinner }, width);
      for (const l of lines) {
        const row = toolCardRow(l, line.card.status, theme, line.card.name);
        if (row.text || (row.chunks && row.chunks.length > 0)) {
          body.push({ ...row, cardId: line.card.id });
        }
      }
      continue;
    }
    if (line.kind === 'user') {
      // 用户消息：整块灰色背景气泡（对标 opencode 用户气泡）——顶部留白 + 文本行
      // （每行左侧蓝色竖粗线，折行后连续，整段消息被竖线框住）+ 底部留白。上下留白
      // 让气泡高度略高于文本（用户要求「灰色背景区域高度稍微高一点，不要和文本等高」）。
      body.push(userPadRow(width, theme));
      for (const seg of line.text.split('\n')) {
        body.push(...wrapUserLine(seg, width, theme));
      }
      body.push(userPadRow(width, theme));
      // 用户消息与后续内容（思考/回答/工具卡片）之间留 1 行间距，
      // 避免用户输入与 AI 思考紧贴（用户反馈距离太近）
      body.push({ text: '', style: {} });
      continue;
    }
    if (line.kind === 'tokens' && line.tokens) {
      // 当次 token 使用与耗时统计模块（对标 Web GUI 风格，可点击展开/收起）：
      //   头行 = `Build · <model> · <dur> · <rate> tok/s`
      //   汇总行 = `- Tokens: <N> steps · <new> new · <cached> cached · <total> total`
      //   展开态 = Step 表格明细（Step / New / Cached / Total）
      if (!state.showTokens) continue; // /tokens 关闭：该行不渲染（数据保留在 state.lines）
      const usages = line.tokens.usages;
      const sum = usages.reduce(
        (a, u) => ({
          prompt: a.prompt + u.prompt,
          completion: a.completion + u.completion,
          cached: a.cached + (u.cached ?? 0),
        }),
        { prompt: 0, completion: 0, cached: 0 }
      );
      const fmt = (n: number): string => formatCompact(n);

      const durStr = line.tokens.durMs ? formatToolDur(line.tokens.durMs) : '';
      const model = line.tokens.model || state.model || 'Omni';
      const compSum = usages.reduce((acc, u) => acc + u.completion, 0);
      const genMs = line.tokens.genMs ?? line.tokens.durMs ?? 0;
      const rate = genMs > 0 ? Math.round(compSum / (genMs / 1000)) : 0;
      const ftAvg = line.tokens.firstTokenAvg;
      const ftStr = ftAvg != null && ftAvg > 0 ? ` · 首 token ${(ftAvg / 1000).toFixed(1)}s` : '';
      const rateStr = rate > 0 ? ` · ${rate} tok/s` : '';
      const buildText = `Build · ${model}${durStr ? ` · ${durStr}` : ''}${ftStr}${rateStr}`;

      // 第一行：Build 元信息
      body.push({
        text: buildText,
        style: {},
        chunks: [
          { text: 'Build', fg: theme.accentBlue, bold: true },
          { text: ` · ${model}${durStr ? ` · ${durStr}` : ''}${ftStr}${rateStr}`, dim: true },
        ],
        tokensIdx: li,
      });

      // Build 与 Tokens 之间留空行间距（用户要求：build / tokens 要有点间距）
      body.push({
        text: '',
        style: {},
        chunks: [],
        tokensIdx: li,
      });

      // 第二行：Tokens 汇总（展开时 -，收起时 +）
      const prefix = line.tokens.expanded ? '- ' : '+ ';
      const stepCount = Math.max(1, usages.length);
      const sumNew = Math.max(0, sum.prompt - sum.cached);
      const sumTot = sum.prompt + sum.completion;
      const tokensText = `${prefix}Tokens: ${stepCount} step${stepCount > 1 ? 's' : ''} · ${fmt(sumNew)} new · ${fmt(sum.cached)} cached · ${fmt(sumTot)} total`;
      body.push({
        text: tokensText,
        style: {},
        chunks: [
          { text: prefix, dim: true },
          { text: 'Tokens: ', dim: true, bold: true },
          { text: `${stepCount} step${stepCount > 1 ? 's' : ''} · ${fmt(sumNew)} new · ${fmt(sum.cached)} cached · ${fmt(sumTot)} total`, dim: true },
        ],
        tokensIdx: li,
      });

      if (line.tokens.expanded) {
        // 展开态：Step 表格严格对齐（固定列宽 + 表头/数据右对齐）
        const colStep = 14;
        const colNew = 10;
        const colCached = 10;
        const colTotal = 10;

        const hStep = 'Step'.padEnd(colStep);
        const hNew = 'New'.padStart(colNew);
        const hCached = 'Cached'.padStart(colCached);
        const hTotal = 'Total'.padStart(colTotal);
        const headerText = `  ${hStep}${hNew}${hCached}${hTotal}`;

        body.push({
          text: headerText,
          style: { dim: true },
          chunks: [{ text: headerText, dim: true }],
          tokensIdx: li,
        });

        for (let i = 0; i < usages.length; i++) {
          const u = usages[i]!;
          const stepName = i === usages.length - 1 ? 'stop' : 'tool-call';
          const uCached = u.cached ?? 0;
          const uNew = Math.max(0, u.prompt - uCached);
          const uTot = u.prompt + u.completion;

          const dStep = stepName.padEnd(colStep);
          const dNew = fmt(uNew).padStart(colNew);
          const dCached = fmt(uCached).padStart(colCached);
          const dTotal = fmt(uTot).padStart(colTotal);
          const rowText = `  ${dStep}${dNew}${dCached}${dTotal}`;

          body.push({
            text: rowText,
            style: { dim: true },
            chunks: [{ text: rowText, dim: true }],
            tokensIdx: li,
          });
        }
      }
      continue;
    }
    if (line.kind === 'thinking') {
      // /thinking 关闭（state.thinkingShow=false）：完全不展示思考流
      if (!state.thinkingShow) continue;
      const expanded = state.thinkingExpanded
        ? !state.collapsedThinking.has(li)
        : state.expandedThinking.has(li);
      if (expanded) {
        // 展开态头行（向右缩进 2 格，不与正文顶格）：`  - Thought: · 2.8s` / `  ⠹ Thought: · 2.8s`
        const time = line.thinkingMs != null ? ` · ${formatToolDur(line.thinkingMs)}` : '';
        // 思考中恒显示 loading 动画（用户要求不显示沙漏 ⏳）：spinnerIndex 空闲时（流式
        // reasoning 阶段 onStreamStart 已停 spinner）回退会话级 loading 帧（200ms 定时器照转）
        const prefix = line.thinkingRunning
          ? state.spinnerIndex >= 0
            ? SPINNER_FRAMES[state.spinnerIndex % SPINNER_FRAMES.length]
            : SPINNER_FRAMES[Math.max(0, state.loadingIndex) % SPINNER_FRAMES.length]
          : '-';
        body.push({
          text: `  ${prefix} Thought:${time}`,
          style: { fg: 'yellow' },
          chunks: [
            { text: `  ${prefix} `, dim: true },
            { text: 'Thought:', fg: 'yellow', bold: true },
            ...(time ? [{ text: time, dim: true }] : []),
          ],
          thinkingIdx: li,
        });
        // 思考正文：整体缩进 4 格并使用 dim 暗色展示（对标 Web GUI，弱化非主要回答）
        if (line.text) {
          // 头行与思考正文之间留 1 行空行间距（用户要求：thought 和 具体的thinking 内容也需要间距）
          body.push({ text: '', style: {}, chunks: [], thinkingIdx: li });
          // 缩进前缀不能只加在逻辑行首——wrapRow 按宽度折行后续行不带前缀（顶格），
          // 长句续行会与 Thought 正文错位（用户要求续行也与正文同缩进）。
          // 因此按 width-4 折行，再给每个视觉行（含续行）统一加 4 格前缀。
          const innerW = Math.max(1, width - 4);
          for (const seg of line.text.split('\n')) {
            if (!seg) {
              body.push({ text: '', style: {}, chunks: [], thinkingIdx: li });
              continue;
            }
            for (const r of wrapRow({ text: seg, style: rowStyle(line.kind), thinkingIdx: li }, innerW)) {
              body.push({ ...r, text: `    ${r.text}` });
            }
          }
        }
      } else {
        // 收起态头行（向右缩进 2 格）：`  + Thought:` / `  ⠹ Thought:`（思考中恒 loading
        // 动画——不显示沙漏 ⏳，spinnerIndex 空闲时回退会话级 loading 帧）
        const prefix = line.thinkingRunning
          ? state.spinnerIndex >= 0
            ? SPINNER_FRAMES[state.spinnerIndex % SPINNER_FRAMES.length]
            : SPINNER_FRAMES[Math.max(0, state.loadingIndex) % SPINNER_FRAMES.length]
          : '+';
        body.push({
          text: `  ${prefix} Thought:`,
          style: { fg: 'yellow' },
          chunks: [
            { text: `  ${prefix} `, dim: true },
            { text: 'Thought:', fg: 'yellow', bold: true },
          ],
          thinkingIdx: li,
        });
      }
      continue;
    }
    for (const seg of line.text.split('\n')) {
      body.push(...wrapRow({ text: seg, style: rowStyle(line.kind) }, width));
    }
  }
  // 工具调用审批卡片（安全护栏）：state.approval 非空时追加在内容流末尾（独立卡片）
  if (state.approval) {
    for (const r of approvalPanelRows(state.approval, width, state.language)) {
      body.push({ ...r, approvalId: 1 });
    }
  }
  // 命令面板（/theme 等）是绝对定位浮层（menuOverlay），不占用内容流——
  // 会话内容与菜单互不干扰（用户要求 alert 形式，见 mountTree/repaintTree）。
  // 正在流式生成时，在最后一行输出末尾追加光标（代替状态栏“生成中…”文案）
  if (state.generating && body.length > 0) {
    const last = body[body.length - 1];
    if (last.cardId === undefined && last.approvalId === undefined) {
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
 * 交互模式再占 状态栏间距(1) + 状态栏(1) + 灰色块（输入框 inputLines + 间距 1 + 模型 1，paddingY 0，gap 1）
 * + 统计行间距(1) + 统计行(1)，即内容区 = 高度 - 10 - inputLines（inputLines=1 时即高度 - 11）；
 * 单次模式内容区 = 高度 - 4。
 *
 * 多行输入框自动增高（Enter 发送 / Shift+Enter 换行），inputLines 由 repaintTree
 * 每次从输入框 lineCount 实时同步（蓝色细线同步增高）——输入框变高时内容区预算
 * 同步收缩，灰色块与统计行永远不会被挤出视口。
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
  // 轨迹面板（/trace）展开时内容宽度收缩 TRACE_W + 2（面板占右缘 36 列 + 与内容的
  // 1 列间隔 + 根右内边距）——对话流右移、长行重新折行，面板不盖内容
  const contentW = Math.max(1, (width ?? 80) - CONTENT_PAD - (state.traceOpen ? TRACE_W + 2 : 0));
  const body = buildBody(state, contentW);
  // footer 高度预算：输入内容行数(1-5) + 间距 1 + 模型行 1 + 统计行 1（paddingY 0、gap 1，
  // 灰块低）+ 16px 圆角边框 2 行（rounded border 同色线）；极小高度时不强塞内容行（避免把灰色块挤出视口）
  const inputLines = opts?.withInput ? Math.min(5, Math.max(1, state.inputLines ?? 1)) : 0;
  // 命令联想列表是**独立浮层**（absolute 定位，见 repaintTree）——不占内容流，
  // 内容区预算不再减它的行数（对话不因联想出现而跳动）
  // 待发送消息区（输入框上方小视图）：每条一行「N queued · 文本」（最多 4 条）+
  // 超出时「还有 N 条」1 行（空列表 0 行）；预算同步收缩（灰色块永远完整可见）。
  const pendingCount = state.pending.length;
  const pendingRows =
    opts?.withInput && pendingCount > 0 ? Math.min(4, pendingCount) + (pendingCount > 4 ? 1 : 0) : 0;
  // 任务清单小视图（待发送区上方）：最多 4 条 + 超出时「还有 N 项」1 行（空清单 0 行）。
  const todoCount = opts?.withInput ? state.todoList.length : 0;
  const todoRows = todoCount > 0 ? Math.min(4, todoCount) + (todoCount > 4 ? 1 : 0) : 0;
  // ask_user 提问面板（输入区上方）：留白 1 + ? 问题行 1 + 每选项 1 行 + 自定义行 1 +
  // 确认行 1 + 提示行 1（空间不足时提示行被截，确认行恒保留）；预算同步收缩（同 pendingRows 语义）。
  const askRows = opts?.withInput && state.ask ? state.ask.options.length + 5 : 0;
  // 根 Box paddingY(2) 固定；交互模式再占 状态栏间距(1) + 状态栏(1) + 灰色块(inputLines+4，含圆角边框与输入/模型间距 1) + 灰块外底行间距(1) + 灰块外底行(1) + 任务清单(todoRows) + 待发送区(pendingRows) + ask 面板(askRows)
  const cap = Math.max(0, (height ?? 24) - 2 - (opts?.withInput ? 2 + inputLines + 6 + pendingRows + todoRows + askRows : 2));
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
      text: tf(state.language, 'scroll.topHint', { n: total - contentCap }),
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
    text: tf(state.language, 'scroll.backHint', { n: total - top - contentCap, total }),
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
 * 思考模块点击命中（纯函数，供 startTui 的鼠标 handler 与快照单测共用）：
 * 命中某条思考行的屏幕 y → 切换该段的展开/收起，返回是否命中。
 * y 为 0-based 鼠标事件坐标（内容行 i 位于 y = i，与卡片同一坐标系）。
 * 思考展开态（头行 + 内容）与折叠态（+ thinking）的行都带 thinkingIdx（thinkingRects
 * 恒有条目）——点击任意思考行即切换：全局展开态 → 收起（collapsedThinking）；
 * 全局折叠态 → 展开（expandedThinking）。两个集合互补，/thinking 切换时清空。
 */
export function hitTestThinking(state: TuiState, thinkingRects: Map<number, number>, y: number): boolean {
  const li = thinkingRects.get(y);
  if (li === undefined) return false;
  if (state.thinkingExpanded) {
    if (state.collapsedThinking.has(li)) state.collapsedThinking.delete(li);
    else state.collapsedThinking.add(li);
  } else {
    if (state.expandedThinking.has(li)) state.expandedThinking.delete(li);
    else state.expandedThinking.add(li);
  }
  return true;
}

/**
 * token 统计模块点击命中（纯函数，供 startTui 的鼠标 handler 与快照单测共用）：
 * 命中某条 tokens 行的屏幕 y → 切换该模块展开/收起（expanded 反置），返回是否命中。
 * y 为 0-based 鼠标事件坐标（与卡片/思考同一坐标系）。收起=汇总，展开=逐次明细。
 */
export function hitTestTokens(state: TuiState, tokensRects: Map<number, number>, y: number): boolean {
  const li = tokensRects.get(y);
  if (li === undefined) return false;
  const line = state.lines[li];
  if (line && line.kind === 'tokens' && line.tokens) line.tokens.expanded = !line.tokens.expanded;
  return true;
}

/**
 * 审批卡片点击命中（纯函数，供 startTui 的鼠标 handler 与快照单测共用）：
 * 命中审批卡片区域返回 true（调用方再按点击 x 列判定 批准/拒绝——左半批准右半拒绝）。
 * y 为 0-based 鼠标事件坐标（与卡片同一坐标系）。
 */
export function hitTestApproval(
  state: TuiState,
  approvalRect: { top: number; bottom: number } | null,
  y: number
): boolean {
  if (!state.approval || !approvalRect) return false;
  return y >= approvalRect.top && y <= approvalRect.bottom;
}

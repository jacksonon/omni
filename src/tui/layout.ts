/**
 * TUI 布局与文本工具：常量（内容区宽/蓝色细线/生成光标）+ 按显示列数的
 * 折行/截断/行数估算。从 render.ts 拆出（业务划分）——行式渲染的核心数学
 * 集中在这里，rows.ts（buildBody/computeRows）与 render.ts（mount/repaint）共用。
 */
import type { MdChunk } from './markdown.js';
import type { TuiTheme } from './theme.js';
import { charWidth, visualWidth } from './width.js';
import type { Row } from './rows.js';
import type { SessionStats, TuiState } from './state.js';
import type { TokenUsage } from '../output/types.js';

/** 内容区可用宽度 = 视口宽 - paddingX(2)（无根边框） */
export const CONTENT_PAD = 2;

/** 蓝色细线字符：3/8 块（≈3px，替代整列色块——用户反馈 2 列色块太宽） */
export const ACCENT_BAR = '▍';

/** 生成中的光标标记（半块字符，追加在最后一行输出末尾） */
export const STREAM_CURSOR = '▌';

/** 时长格式化：`10m58s` / `7s`（毫秒输入；LLM/工具耗时用） */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s >= 60) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${s}s`;
}

/** 紧凑数值：`3M` / `44.2K` / `123`（token 统计用；整千/整百万去掉小数点后 .0） */
export function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(Math.round(n));
}

/** 工具调用/思考时长：<60s 显示一位小数秒（8.6s），≥60s 用分秒（1m05s）——与用户示例一致 */
export function formatToolDur(ms: number): string {
  return ms >= 60_000 ? formatDuration(ms) : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 状态行段（footer 统计行的可配置单元）：id 是配置/持久化键（/settings statusline
 * 按 id 勾选与排序），label/labelEn 是面板显示名（中/英），build/buildEn 生成该段
 * 文本（不含 `| ` 分隔；按界面语言 state.language 选择——/settings 语言切换即时生效）。
 * x = 上下文信息：lastPrompt = 最近一次 LLM 请求的 prompt token（来自流末 chunk 的
 * usage ——「LLM 消息内」拿到的当前上下文大小）；contextLimit = 当前模型 context 上限
 * （config limit.context；未知为 0）。
 */
export interface StatuslineSegment {
  id: string;
  label: string;
  labelEn: string;
  build(s: SessionStats, t: TokenUsage, x: { lastPrompt: number; contextLimit: number }): string;
  buildEn(s: SessionStats, t: TokenUsage, x: { lastPrompt: number; contextLimit: number }): string;
}

/** 全部可用状态行段（顺序 = 默认显示顺序） */
export const STATUSLINE_SEGMENTS: StatuslineSegment[] = [
  {
    id: 'speed',
    label: '首token/速率',
    labelEn: 'First token/Rate',
    build: (s, t) => {
      const firstAvg = s.firstTokenCount > 0 ? s.firstTokenSum / s.firstTokenCount / 1000 : 0;
      // 生成耗时优先用 genMs（首内容 → 末内容）；单 chunk 响应 genMs=0 时回退
      // llmMs - firstTokenSum（首 token → 流结束，仍 >0），1ms 下限防除零
      const gen = s.genMs > 0 ? s.genMs : Math.max(1, s.llmMs - s.firstTokenSum);
      const rate = gen > 0 ? Math.round(t.completion / (gen / 1000)) : 0;
      return `首 token 平均 ${firstAvg.toFixed(1)}s · ${rate} tok/s`;
    },
    buildEn: (s, t) => {
      const firstAvg = s.firstTokenCount > 0 ? s.firstTokenSum / s.firstTokenCount / 1000 : 0;
      const gen = s.genMs > 0 ? s.genMs : Math.max(1, s.llmMs - s.firstTokenSum);
      const rate = gen > 0 ? Math.round(t.completion / (gen / 1000)) : 0;
      return `First token avg ${firstAvg.toFixed(1)}s · ${rate} tok/s`;
    },
  },
  {
    id: 'cache',
    label: '缓存命中',
    labelEn: 'Cache hit',
    build: (s, t) => `缓存命中 ${t.prompt > 0 ? Math.min(100, Math.round((s.cached / t.prompt) * 100)) : 0}%`,
    buildEn: (s, t) => `Cache hit ${t.prompt > 0 ? Math.min(100, Math.round((s.cached / t.prompt) * 100)) : 0}%`,
  },
  {
    id: 'tokens',
    label: '输入/输出',
    labelEn: 'In/Out',
    build: (_s, t) => `输入 ${formatCompact(t.prompt)} tok · 输出 ${formatCompact(t.completion)} tok`,
    buildEn: (_s, t) => `In ${formatCompact(t.prompt)} tok · Out ${formatCompact(t.completion)} tok`,
  },
  {
    id: 'context',
    label: '上下文',
    labelEn: 'Context',
    // 当前上下文大小 = 最近一次 LLM 请求的 prompt token（usage.prompt，来自 LLM 响应）；
    // 模型配置了 context 上限（limit.context）时附 `/{上限}`（如 45K/128K）
    build: (_s, _t, x) =>
      `上下文 ${formatCompact(x.lastPrompt || 0)}${x.contextLimit > 0 ? `/${formatCompact(x.contextLimit)}` : ''}`,
    buildEn: (_s, _t, x) =>
      `Context ${formatCompact(x.lastPrompt || 0)}${x.contextLimit > 0 ? `/${formatCompact(x.contextLimit)}` : ''}`,
  },
];

/** 默认状态行段顺序（未配置 / 非法时回退） */
export const STATUSLINE_DEFAULT: string[] = STATUSLINE_SEGMENTS.map((sg) => sg.id);

/**
 * 构建 footer 统计行（用户要求的格式，各段以 `| ` 分隔）：
 *   `7 轮 · 41 步| LLM 10m58s · 工具调用 7s| 首 token 平均 6.5s · 112 tok/s| 缓存命中 97%| 输入 3M tok · 输出 44.2K tok`
 * 数据来自 state.stats（TuiOutput 按事件累计）+ state.tokens（onUsage 累计）。
 * 段的选择与顺序由 state.statusline 决定（/settings statusline 配置：空格勾选、←/→ 排序、
 * Enter 保存并立即生效）；未知 id 丢弃；空数组（用户全部取消）→ 返回空串（不显示状态行）。
 */
export function buildFooterStats(state: TuiState): string {
  const order = state.statusline ?? STATUSLINE_DEFAULT;
  const en = state.language === 'en';
  // 上下文信息传给 context 段：最近一次 LLM 请求的 prompt（当前上下文）+ 模型 context 上限
  const x = { lastPrompt: state.lastPromptTokens, contextLimit: state.contextLimit };
  const segs = order
    .map((id) => STATUSLINE_SEGMENTS.find((x) => x.id === id))
    .filter((x): x is StatuslineSegment => !!x)
    .map((sg) => (en ? sg.buildEn(state.stats, state.tokens, x) : sg.build(state.stats, state.tokens, x)));
  return segs.join('| ');
}

/** 统计行按可用宽度段级截断：优先保留左侧（首 token/缓存段），超宽丢弃右侧段并加 … */
export function fitFooterStats(text: string, width: number): string {
  if (width < 4 || visualWidth(text) <= width) return text;
  const segs = text.split('| ');
  let out = '';
  for (const seg of segs) {
    const cand = out ? `${out}| ${seg}` : seg;
    if (visualWidth(cand) > width) break;
    out = cand;
  }
  if (!out) return truncateMiddle(text, width);
  return out === text ? text : `${out}…`;
}

/**
 * 把显示列偏移（0-based，相对行首）换算成字符下标（UTF-16 码元）。
 * 拖选（字符级精选取中）用：鼠标事件 x = 内容列 + 1（根 paddingX:1），
 * 行内列 c → 字符下标。CJK/emoji 全角按 charWidth 累计，断点不会落在
 * 代理对中间（emoji 整对保留或整对舍弃）。col 超出行的显示宽度 → 行尾。
 */
export function colToChar(text: string, col: number): number {
  if (col <= 0) return 0;
  let cols = 0;
  let i = 0;
  for (; i < text.length; i++) {
    const w = charWidth(text[i]);
    if (cols + w > col) break;
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

/** 文本中段截断（保留头尾，省略号指示省略）：长路径只显示首段与末段 */
export function truncateMiddle(text: string, max: number): string {
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
export function estimateInputLines(text: string, innerWidth: number): number {
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
export function fitCount(text: string, budget: number): number {
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
export function wrapChunks(chunks: MdChunk[], width: number): MdChunk[][] {
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
export function wrapRow(row: Row, width: number): Row[] {
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

/** 用户消息行：左侧蓝色细线（▍ 3/8 块 ≈3px）+ **整行灰色背景**（不只文字底下——
 * 文字 + 竖线 + 行尾剩余字符全部填充灰色背景，整行对齐，类比工具卡片/用户气泡）
 * 按主题（深色：白字深灰底；亮色：深字淡灰底）；折行后每行都保留竖线 + 整行底。 */
export function wrapUserLine(text: string, width: number, theme: TuiTheme): Row[] {
  const inner = Math.max(1, width - 1); // 竖线占 1 列
  const chunks: MdChunk[] = [{ text, fg: theme.userText, bg: theme.footerBg }];
  return wrapChunks(chunks, inner).map((rowChunks) => {
    const used = 1 + rowChunks.reduce((a, c) => a + visualWidth(c.text), 0); // 竖线 + 文字列数
    const fill = Math.max(0, width - used); // 行尾剩余列：填充灰色背景，整行铺满
    return {
      text: `${ACCENT_BAR}${rowChunks.map((c) => c.text).join('')}`,
      style: { fg: theme.userText, bg: theme.footerBg },
      chunks: [
        { text: ACCENT_BAR, fg: theme.accentBlue, bg: theme.footerBg },
        ...rowChunks,
        ...(fill > 0 ? [{ text: ' '.repeat(fill), bg: theme.footerBg }] : []),
      ],
    };
  });
}

/** 用户消息气泡的上下留白行：整行灰色背景（竖线 + 行尾填充），让气泡高度略高于文本——
 * 用户要求「灰色背景区域高度稍微高一点，不要和文本等高」。留白行与文本行同构（▍ 蓝线
 * 连续 + 灰底铺满），气泡看起来是上下带 padding 的色块（对标 opencode 用户气泡）。 */
export function userPadRow(width: number, theme: TuiTheme): Row {
  const fill = Math.max(0, width - 1);
  return {
    text: `${ACCENT_BAR}${' '.repeat(fill)}`,
    style: { fg: theme.userText, bg: theme.footerBg },
    chunks: [
      { text: ACCENT_BAR, fg: theme.accentBlue, bg: theme.footerBg },
      { text: ' '.repeat(fill), bg: theme.footerBg },
    ],
  };
}

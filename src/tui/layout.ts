/**
 * TUI 布局与文本工具：常量（内容区宽/蓝色细线/生成光标）+ 按显示列数的
 * 折行/截断/行数估算。从 render.ts 拆出（业务划分）——行式渲染的核心数学
 * 集中在这里，rows.ts（buildBody/computeRows）与 render.ts（mount/repaint）共用。
 */
import type { MdChunk } from './markdown.js';
import type { TuiTheme } from './theme.js';
import { charWidth, visualWidth } from './width.js';
import type { Row } from './rows.js';

/** 内容区可用宽度 = 视口宽 - paddingX(2)（无根边框） */
export const CONTENT_PAD = 2;

/** 蓝色细线字符：3/8 块（≈3px，替代整列色块——用户反馈 2 列色块太宽） */
export const ACCENT_BAR = '▍';

/** 生成中的光标标记（半块字符，追加在最后一行输出末尾） */
export const STREAM_CURSOR = '▌';

/** token 用量展示：`⚡ 12.3k tok`（<1000 显示原数） */
export function formatTokens(n: number): string {
  const num = n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  return `⚡ ${num} tok`;
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

/** 用户消息行：左侧蓝色细线（▍ 3/8 块 ≈3px），文字 + 底色按主题（深色：白字深灰底；
 * 亮色：深字淡灰底）；折行后每行都保留竖线与底——整段消息被框住，对标 opencode 用户气泡 */
export function wrapUserLine(text: string, width: number, theme: TuiTheme): Row[] {
  const inner = Math.max(1, width - 1); // 竖线占 1 列
  const chunks: MdChunk[] = [{ text, fg: theme.userText, bg: theme.footerBg }];
  return wrapChunks(chunks, inner).map((rowChunks) => ({
    text: `${ACCENT_BAR}${rowChunks.map((c) => c.text).join('')}`,
    style: { fg: theme.userText, bg: theme.footerBg },
    chunks: [{ text: ACCENT_BAR, fg: theme.accentBlue, bg: theme.footerBg }, ...rowChunks],
  }));
}

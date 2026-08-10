/**
 * 行式 Markdown 渲染：把模型回答的 Markdown 文本解析成带样式的行（chunks）。
 *
 * 支持：加粗 ** / __、行内代码 `、斜体 * / _、标题 #、引用 >、水平线 ---、
 * 围栏代码块 ``` / ~~~（围栏行隐藏，代码行统一着色）。
 *
 * 流式友好：每次重绘都对已累积的完整文本重新解析，未闭合的语法标记
 * 按普通文本渲染（下一个 chunk 到达后自动重新解析成正确样式）。
 *
 * 选择行式方案而非 MarkdownRenderable：现有布局是「尾部窗口 + 行式渲染」，
 * MarkdownRenderable 是多行动态高度块，多轮对话下无法简单参与尾部裁剪。
 * 行式方案保持每行高度固定（1），布局逻辑零改动，覆盖加粗/代码等核心需求。
 */
/** 单个样式片段：text + 可选颜色/属性 */
export interface MdChunk {
  text: string;
  fg?: string; // 颜色名或 hex，如 'cyan' / '#e6b450'
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
  underline?: boolean;
}

/** 一行带样式的文本 */
export interface MdRow {
  chunks: MdChunk[];
}

// 行内代码（琥珀色，避免与青色工具步骤混淆）
export const INLINE_CODE_FG = '#e6b450';
// 代码块行（蓝灰色）
export const CODE_FG = '#8fa3bf';

/**
 * 行内 token：加粗 ** / __、行内代码 `、斜体 *（词边界守卫）、链接（只取显示文本）。
 *
 * 刻意不做 `_斜体_`：编程回答里裸 `snake_case` 标识符太常见，`_x_` 会误伤成斜体；
 * `*斜体*` 也加了 `(?<!\w)` / `(?!\w)` 边界守卫（CJK 不算 \w，`中文*强调*中文` 仍可匹配）。
 */
const INLINE_TOKEN =
  /\*\*([^*]+)\*\*|(?<!\w)__([^_]+)__(?!\w)|`([^`]+)`|(?<!\w)\*([^*\n]+)\*(?!\w)|\[([^\]]+)\]\([^)]*\)/g;

/** 扫描一行内的 Markdown 标记，产出样式片段 */
function scanInline(text: string): MdChunk[] {
  const out: MdChunk[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_TOKEN)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    const [, b1, b2, code, i1, link] = m;
    if (b1 || b2) out.push({ text: b1 ?? b2, bold: true });
    else if (code) out.push({ text: code, fg: INLINE_CODE_FG });
    else if (i1) out.push({ text: i1, italic: true });
    else if (link) out.push({ text: link });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/**
 * 把一段文本解析成渲染行（answer 类型专用）。
 * 未匹配任何结构的行按普通行返回（可后续叠加行级样式）。
 */
// 简单 memo：appendLine 只追加文本，未变动的旧回答直接命中缓存，避免每次重绘重解析
const mdCache = new Map<string, MdRow[]>();
const MD_CACHE_MAX = 200;

export function markdownToRows(text: string): MdRow[] {
  const hit = mdCache.get(text);
  if (hit) return hit;

  const rows: MdRow[] = [];
  let inCode = false;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd();
    const trimmed = line.trimStart();

    // 围栏代码块：``` / ~~~ 开闭围栏行隐藏（代码行单独着色）
    if (/^```|^~~~/.test(trimmed)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      rows.push({ chunks: [{ text: line, fg: CODE_FG }] });
      continue;
    }

    // 标题：# ~ ######（加粗 + 青色）
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      rows.push({ chunks: [{ text: heading[2], bold: true, fg: 'cyan' }] });
      continue;
    }
    // 引用：> 文本（浅色）
    const quote = /^>\s?(.*)$/.exec(trimmed);
    if (quote) {
      rows.push({ chunks: [{ text: quote[1], dim: true, fg: '#9aa4b2' }] });
      continue;
    }
    // 水平线：--- / *** / ___（浅色虚线）
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(trimmed)) {
      rows.push({ chunks: [{ text: '──────', dim: true }] });
      continue;
    }

    rows.push({ chunks: scanInline(line) });
  }

  if (mdCache.size >= MD_CACHE_MAX) mdCache.clear();
  mdCache.set(text, rows);
  return rows;
}

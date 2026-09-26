/**
 * markdown-ansi：mini 纯终端模式的 Markdown 渲染层。
 *
 * 解析复用 `tui/markdown.ts` 同一套规则（scanInline/codeLine/单行块/表格），
 * 这里只做两件事：
 * 1. `MdChunk[] → ANSI 字符串`（chunksToAnsi，颜色经 useColor 门控）；
 * 2. `MiniMarkdownRenderer` 行级状态机：流式逐行提交，但围栏/表格需要跨行
 *    上下文——围栏按行跟踪开关（标记行隐藏，TUI 同款），表格把表头暂存一行、
 *    成表后整表一次渲染（列宽依赖全表内容，必须等表结束）。
 *
 * 折行复用 TUI 的 `wrapChunks`（样式片段级折行，不断代理对），输出的每个
 * 可见行都不超过传入的 avail 列数；表格行由 renderTable 按 contentWidth 收缩，
 * 不再二次折行（不断边框）。
 */
import { wrapChunks } from '../tui/layout.js';
import {
  FENCE_RE,
  codeLineChunks,
  isTableSepLine,
  parseMarkdownLine,
  renderTable,
  scanInlineChunks,
  splitTableRow,
  type MdChunk,
} from '../tui/markdown.js';
import { visualWidth } from '../tui/width.js';
import { useColor } from '../ui.js';

const NAMED_FG: Record<string, number> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
};

/** 颜色 → SGR 参数（命名色直接映射，#hex 走 24 位真彩；未知名回退 cyan） */
function colorParam(fg: string, bg: boolean): string {
  if (fg.startsWith('#')) {
    const m = /^#([0-9a-fA-F]{6})$/.exec(fg);
    if (m) {
      const r = parseInt(m[1]!.slice(0, 2), 16);
      const g = parseInt(m[1]!.slice(2, 4), 16);
      const b = parseInt(m[1]!.slice(4, 6), 16);
      return `${bg ? 48 : 38};2;${r};${g};${b}`;
    }
    return bg ? '49' : '39';
  }
  const code = NAMED_FG[fg] ?? NAMED_FG['cyan']!;
  return String(bg ? code + 10 : code);
}

/**
 * 样式片段 → ANSI 字符串（纯函数，color 显式开关便于单测；默认跟随终端）。
 * 无颜色时直接拼原文（管道可 grep）；有颜色时每个 chunk 独立开关/reset，
 * 互不串色，截断/折行后也不会漏 reset。
 */
export function chunksToAnsi(chunks: MdChunk[], color: boolean = useColor): string {
  if (!color) return chunks.map((c) => c.text).join('');
  return chunks
    .map((c) => {
      const params: string[] = [];
      if (c.bold) params.push('1');
      if (c.dim) params.push('2');
      if (c.italic) params.push('3');
      if (c.underline) params.push('4');
      if (c.strike) params.push('9');
      if (c.fg) params.push(colorParam(c.fg, false));
      if (c.bg) params.push(colorParam(c.bg, true));
      if (params.length === 0) return c.text;
      return `\x1b[${params.join(';')}m${c.text}\x1b[0m`;
    })
    .join('');
}

/** 取文本尾部不超过 width 列的片段（live 预览单行截断用，与 mini 的 tailToWidth 同规则） */
function tailStr(text: string, width: number): string {
  if (visualWidth(text) <= width) return text;
  let out = '';
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i]!;
    if (visualWidth(ch + out) > width - 1) break;
    out = ch + out;
  }
  return `…${out}`;
}

/**
 * mini 正文单元格的行级 Markdown 渲染器（每个正文单元格一个实例，跨工具/
 * 跨轮不复用——与 StreamingCell 生命周期对齐）。
 *
 * 约定：返回的每一项都是一个可见行（'' = 裸空行，调用方不加前缀）；
 * 返回 [] 表示该行被缓冲/隐藏（围栏标记行、表格收集中），调用方什么都不打印、
 * 且不推进“首行 bullet”状态。
 */
export class MiniMarkdownRenderer {
  private inFence = false;
  private fenceLang = '';
  /** 表头候选（含 | 的行暂存一行：下一行是分隔行则成表，否则按普通行回吐） */
  private pendingHeader: string | null = null;
  /** 收集中表格：表头 + 分隔 + 数据行（结束时整表渲染） */
  private table: { header: string[]; sep: string[]; rows: string[][] } | null = null;

  constructor(private color: boolean = useColor) {}

  /** 推入一个逻辑行，返回 0+ 个可见行（已折到 avail 列宽、已上色） */
  pushLine(line: string, avail: number): string[] {
    // 表格收集中：数据行继续攒；空行/无 | 行/围栏行则结表，先渲染整表再重处理当前行
    if (this.table) {
      const t = line.trimStart();
      if (line.trim() !== '' && line.includes('|') && !FENCE_RE.test(t)) {
        this.table.rows.push(splitTableRow(line));
        return [];
      }
      const out = this.renderTable(avail);
      this.table = null;
      return [...out, ...this.pushLine(line, avail)];
    }
    // 表头候选中：看这一行是不是分隔行
    if (this.pendingHeader !== null) {
      const header = this.pendingHeader;
      this.pendingHeader = null;
      if (line.trim() !== '' && isTableSepLine(line)) {
        this.table = { header: splitTableRow(header), sep: splitTableRow(line), rows: [] };
        return [];
      }
      return [...this.normalLine(header, avail), ...this.pushLine(line, avail)];
    }

    const trimmed = line.trimStart();
    const fence = FENCE_RE.exec(trimmed);
    if (fence) {
      if (!this.inFence) {
        this.inFence = true;
        this.fenceLang = (fence[2] ?? '').toLowerCase();
      } else {
        this.inFence = false;
        this.fenceLang = '';
      }
      return []; // 围栏标记行隐藏（TUI 同款）
    }
    if (this.inFence) return this.wrap(codeLineChunks(line, this.fenceLang), avail);
    if (line.trim() === '') return [''];
    // 表格候选：标题/引用优先（与 markdownToRows 同条件），其余含 | 行暂存一行
    if (!/^[#>]/.test(trimmed) && trimmed.includes('|')) {
      this.pendingHeader = line;
      return [];
    }
    return this.normalLine(line, avail);
  }

  /** 收尾：吐出暂存的表头/整表（调用方在单元格 end 时调一次） */
  flush(avail: number): string[] {
    if (this.table) {
      const out = this.renderTable(avail);
      this.table = null;
      return out;
    }
    if (this.pendingHeader !== null) {
      const header = this.pendingHeader;
      this.pendingHeader = null;
      return this.normalLine(header, avail);
    }
    return [];
  }

  /** live 预览：未完成行只有行内样式（无换行即无块结构；围栏内按代码色） */
  partial(text: string, room: number): string {
    const plain = tailStr(text, room);
    if (this.inFence) return chunksToAnsi(codeLineChunks(plain, this.fenceLang), this.color);
    return chunksToAnsi(scanInlineChunks(plain), this.color);
  }

  private normalLine(line: string, avail: number): string[] {
    return this.wrap(parseMarkdownLine(line), avail);
  }

  private renderTable(avail: number): string[] {
    const t = this.table!;
    return renderTable(t.header, t.sep, t.rows, avail).map((r) => chunksToAnsi(r.chunks, this.color));
  }

  private wrap(chunks: MdChunk[], avail: number): string[] {
    return wrapChunks(chunks, Math.max(8, avail)).map((row) => chunksToAnsi(row, this.color));
  }
}

/** Ctrl+T 的工具展开视图：复用对话单元格，临时屏幕退出后原历史与草稿原样恢复。 */
import { stripVTControlCharacters } from 'node:util';
import { visualWidth } from '../tui/width.js';
import { dim } from '../ui.js';
import { truncateToWidth } from '../output/format.js';
import type { MiniInputKey } from './mini-input.js';

/** 保留 SGR 样式的物理折行；其它终端控制序列不得进入历史重绘。 */
export function miniExpandedRows(text: string, width: number, first = '', rest = first): string[] {
  const rows: string[] = [];
  let initial = true;
  for (const line of text.replace(/\t/g, '    ').split('\n')) {
    const safe = line.replace(/\x1b\].*?(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*([@-~])/g, (seq, end) => end === 'm' ? seq : '');
    let prefix = initial ? first : rest;
    initial = false;
    let row = prefix, columns = visualWidth(stripVTControlCharacters(prefix)), style = '';
    for (const token of safe.match(/\x1b\[[0-9;:]*m|[^\x00-\x1f\x7f]/gu) ?? []) {
      if (token.startsWith('\x1b[')) {
        style = token === '\x1b[0m' ? '' : style + token;
        row += token;
        continue;
      }
      const size = visualWidth(token);
      if (columns + size > Math.max(2, width) && columns > visualWidth(stripVTControlCharacters(prefix))) {
        rows.push(row + '\x1b[0m');
        prefix = rest; row = rest + style; columns = visualWidth(stripVTControlCharacters(rest));
      }
      row += token; columns += size;
    }
    rows.push(row + '\x1b[0m');
  }
  return rows;
}

export type MiniHistoryCell = (width: number) => string[];

/** 仅缓存展示单元格，不读取截断的事件账本。 */
export class MiniHistory {
  private cells: MiniHistoryCell[] = [];
  line(text: string): void {
    const plain = stripVTControlCharacters(text);
    const indent = /^[•›] /.test(plain) ? '  ' : plain.match(/^\s+/)?.[0] ?? '';
    this.cells.push(width => miniExpandedRows(text, width, '', indent));
  }
  cell(render: MiniHistoryCell): void { this.cells.push(render); }
  clear(): void { this.cells = []; }
  rows(width: number): string[] { return this.cells.flatMap(render => render(width)); }
}

interface ExpansionOptions {
  rows(width: number): string[];
  footer(width: number): string[];
  onClose(): void;
}

/** 后台继续画原屏幕的字节暂存，收起后回放；不把展开内容写进终端 scrollback。 */
export function openMiniExpansion(options: ExpansionOptions): () => void {
  const out = process.stdout, input = process.stdin;
  const originalWrite = out.write;
  const write = originalWrite.bind(out);
  const saved = input.listeners('keypress').filter(fn => !(fn as { miniKeyNormalizer?: boolean }).miniKeyNormalizer);
  const buffered: Buffer[] = [];
  let bufferedBytes = 0, closed = false, timer: NodeJS.Timeout | undefined;
  let top: number | null = null;
  const paint = () => {
    timer = undefined;
    if (closed) return;
    const width = Math.max(4, (out.columns || 80) - 1), height = Math.max(2, out.rows || 24);
    const footer = options.footer(width).slice(-(height - 1));
    const content = options.rows(width);
    const room = Math.max(1, height - footer.length - 1);
    const last = Math.max(0, content.length - room);
    if (top !== null) top = Math.max(0, Math.min(top, last));
    const offset = top ?? last;
    const rows = content.slice(offset, offset + room);
    while (rows.length < room) rows.push('');
    rows.push(dim(truncateToWidth(`  ctrl+t collapse · ↑↓ scroll · PgUp/PgDn · Esc return  ${offset + 1}/${Math.max(1, content.length)}`, width)), ...footer);
    write('\x1b[?2026h\x1b[?25l\x1b[H\x1b[2J' + rows.map((row, i) => `\x1b[${i + 1};1H${row}\x1b[0m\x1b[K`).join('') + '\x1b[?2026l');
  };
  const schedule = () => { if (!timer && !closed) timer = setTimeout(paint, 32); };
  const close = () => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    out.write = originalWrite;
    input.off('keypress', onKey);
    input.off('end', close);
    out.off('resize', schedule);
    process.off('exit', close);
    for (const listener of saved) input.on('keypress', listener as (...args: any[]) => void);
    out.cork();
    try {
      write('\x1b[?2026h\x1b[?25l\x1b[?1049l');
      for (const chunk of buffered) write(chunk);
      buffered.length = 0;
      options.onClose();
    } finally {
      write('\x1b[?25h\x1b[?2026l');
      out.uncork();
    }
  };
  const onKey = (text: string, key?: MiniInputKey) => {
    if (key?.miniBuffered) return;
    const name = key?.name;
    if ((key?.ctrl && name === 't') || name === 'escape') { close(); return; }
    const page = Math.max(1, (out.rows || 24) - 8);
    if (['up', 'down', 'pageup', 'pagedown', 'home', 'end'].includes(name ?? '') && !key?.ctrl) {
      const room = Math.max(1, (out.rows || 24) - options.footer(Math.max(4, (out.columns || 80) - 1)).length - 1);
      const last = Math.max(0, options.rows(Math.max(4, (out.columns || 80) - 1)).length - room);
      const current = top ?? last;
      top = name === 'home' ? 0 : name === 'end' ? null : Math.max(0, Math.min(last, current + (name === 'up' ? -1 : name === 'down' ? 1 : name === 'pageup' ? -page : page)));
      paint(); return;
    }
    // 输入或取消任务前先收起，原样交回 readline；不吞掉用户的下一次操作。
    close();
    for (const listener of saved) listener.call(input, text, key);
  };
  for (const listener of saved) input.off('keypress', listener as (...args: any[]) => void);
  input.on('keypress', onKey);
  input.once('end', close);
  out.on('resize', schedule);
  process.once('exit', close);
  write('\x1b[?1049h');
  out.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    const data = typeof chunk === 'string' ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined) : Buffer.from(chunk);
    buffered.push(data); bufferedBytes += data.length;
    const done = typeof encoding === 'function' ? encoding : callback;
    if (done) queueMicrotask(() => done());
    if (bufferedBytes > 16 * 1024 * 1024) close();
    else schedule();
    return true;
  }) as typeof out.write;
  paint();
  return close;
}

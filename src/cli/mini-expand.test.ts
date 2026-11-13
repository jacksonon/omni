import test from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { MiniHistory, miniExpandedRows, openMiniExpansion } from './mini-expand.js';
import { visualWidth } from '../tui/width.js';

test('mini 展开：长行保留全文与缩进，ANSI 不占宽，不执行内容中的控制序列', () => {
  const text = '\x1b[32m中文 alpha beta gamma 😀 tail\x1b[0m\x1b[2J';
  const rows = miniExpandedRows(text, 18, '\x1b[1m• Ran \x1b[0m', '  ');
  assert.ok(rows.length > 1);
  for (const row of rows) assert.ok(visualWidth(stripVTControlCharacters(row)) <= 18, row);
  assert.equal(rows.map(stripVTControlCharacters).map((line, i) => line.slice(i ? 2 : 6)).join(''), '中文 alpha beta gamma 😀 tail');
  assert.ok(!rows.join('').includes('\x1b[2J'));
  assert.ok(rows.slice(1).every(row => row.startsWith('  ')));
});

test('mini 展开：对话与工具单元格保持顺序，可读到迟到的完整结果，清理不串会话', () => {
  const history = new MiniHistory();
  let output = 'running';
  history.line('› user');
  history.cell(width => miniExpandedRows(output, width, '  └ ', '    '));
  history.line('• answer');
  output = 'first\nhidden final';
  const lines = history.rows(40).map(stripVTControlCharacters);
  assert.deepEqual(lines, ['› user', '  └ first', '    hidden final', '• answer']);
  history.clear();
  assert.deepEqual(history.rows(40), []);
});

test('openMiniExpansion：带 \\x1b[K 结尾的灰底页脚行不再追加 \\x1b[0m\\x1b[K 抹除背景', () => {
  const frames: string[] = [];
  const origWrite = process.stdout.write;
  const origCols = (process.stdout as { columns?: number }).columns;
  const origRows = (process.stdout as { rows?: number }).rows;
  let close: (() => void) | null = null;
  Object.defineProperty(process.stdout, 'columns', { value: 60, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 12, configurable: true });
  (process.stdout as { write: unknown }).write = ((chunk: string | Uint8Array) => {
    frames.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  try {
    close = openMiniExpansion({
      rows: () => ['line-a'],
      footer: () => ['\x1b[48;2;52;52;58m› draft\x1b[K', 'plain row'],
      onClose: () => {},
    });
  } finally {
    close?.();
    process.stdout.write = origWrite;
    Object.defineProperty(process.stdout, 'columns', { value: origCols, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: origRows, configurable: true });
  }
  const all = frames.join('');
  assert.ok(all.includes('\x1b[48;2;52;52;58m› draft\x1b[K\x1b[0m'), '保留 \\x1b[K 填充灰底，仅追加 \\x1b[0m');
  assert.ok(!all.includes('› draft\x1b[K\x1b[0m\x1b[K'), '禁止在 \\x1b[K 后再次用默认背景 \\x1b[K 覆盖');
  assert.ok(all.includes('plain row\x1b[0m\x1b[K'), '未自清行的普通文本仍补 \\x1b[0m\\x1b[K');
});

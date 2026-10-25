import test from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { MiniHistory, miniExpandedRows } from './mini-expand.js';
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

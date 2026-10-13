/**
 * 工具层公共小函数的单元测试（node:test + node:assert/strict）。
 * 覆盖 num / resolvePath / truncate / truncateUtf8ByBytes 的边界行为。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_OUTPUT_LIMIT, num, resolvePath, truncate, truncateUtf8ByBytes } from './util.js';

test('num：合法数字原样返回', () => {
  assert.equal(num(42, 0), 42);
  assert.equal(num('12', 0), 12);
  assert.equal(num('3.5', 0), 3.5);
  assert.equal(num(-7, 0), -7);
});

test('num：非法输入回退默认值', () => {
  assert.equal(num(undefined, 5), 5);
  assert.equal(num('abc', 5), 5);
  assert.equal(num(NaN, 5), 5);
  assert.equal(num(Infinity, 5), 5);
  assert.equal(num({}, 5), 5);
});

test('num：null / 空串被 Number 转成 0（真实行为，非回退）', () => {
  // 这是当前实现的实际语义：Number(null)/Number('') === 0，属有限数故不回退。
  assert.equal(num(null, 5), 0);
  assert.equal(num('', 5), 0);
});

test('resolvePath：默认基于进程 cwd 解析为绝对路径', () => {
  const abs = resolvePath('some/relative/file.ts');
  assert.ok(abs.startsWith('/') || /^[A-Za-z]:\\/.test(abs), '应为绝对路径');
  assert.ok(abs.endsWith('some/relative/file.ts'));
});

test('resolvePath：显式 cwd 覆盖进程工作目录', () => {
  assert.equal(resolvePath('x.ts', '/tmp/base'), '/tmp/base/x.ts');
  assert.equal(resolvePath('/already/abs.ts', '/tmp/base'), '/already/abs.ts');
  assert.equal(resolvePath('..', '/tmp/base/sub'), '/tmp/base');
});

test('truncate：未超限原样返回', () => {
  assert.equal(truncate('hello'), 'hello');
  assert.equal(truncate(''), '');
  const exact = 'a'.repeat(TOOL_OUTPUT_LIMIT);
  assert.equal(truncate(exact), exact);
});

test('truncate：超限时截断到上限并附提示', () => {
  const long = 'a'.repeat(TOOL_OUTPUT_LIMIT + 100);
  const out = truncate(long);
  assert.ok(out.startsWith('a'.repeat(TOOL_OUTPUT_LIMIT)));
  assert.ok(out.includes('已截断'));
  assert.ok(out.includes(String(long.length)));
  assert.ok(out.length > TOOL_OUTPUT_LIMIT);
});

test('truncateUtf8ByBytes：ASCII 按字节截断', () => {
  assert.equal(truncateUtf8ByBytes('abcdef', 100), 'abcdef');
  assert.equal(truncateUtf8ByBytes('abcdef', 3), 'abc');
  assert.equal(truncateUtf8ByBytes('abcdef', 0), '');
});

test('truncateUtf8ByBytes：不切多字节字符中间', () => {
  const s = '你好世界'; // 每个汉字 3 字节，共 12
  assert.equal(truncateUtf8ByBytes(s, 12), s);
  assert.equal(truncateUtf8ByBytes(s, 7), '你好'); // 6 字节可容，9 字节超限
  assert.equal(truncateUtf8ByBytes(s, 6), '你好');
  assert.equal(truncateUtf8ByBytes(s, 5), '你');
  assert.equal(truncateUtf8ByBytes(s, 3), '你');
  assert.equal(truncateUtf8ByBytes(s, 2), '');
});
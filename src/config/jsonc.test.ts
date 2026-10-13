/**
 * JSONC 解析单元测试：注释剥离、尾逗号容忍、URL 不误伤、非法输入抛错。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonc } from './jsonc.js';

test('parseJsonc：普通 JSON 原样解析', () => {
  assert.deepEqual(parseJsonc('{"a":1,"b":[1,2]}'), { a: 1, b: [1, 2] });
});

test('parseJsonc：剥离行注释', () => {
  const text = `{
  // 头部注释
  "a": 1, // 行尾注释
  "b": 2
}`;
  assert.deepEqual(parseJsonc(text), { a: 1, b: 2 });
});

test('parseJsonc：剥离块注释', () => {
  const text = `{
  /* 一段
     多行块注释 */
  "a": /* 行内 */ 1
}`;
  assert.deepEqual(parseJsonc(text), { a: 1 });
});

test('parseJsonc：容忍对象与数组尾逗号', () => {
  assert.deepEqual(parseJsonc('{"a":1,"b":2,}'), { a: 1, b: 2 });
  assert.deepEqual(parseJsonc('{"list":[1,2,3,],}'), { list: [1, 2, 3] });
});

test('parseJsonc：不误伤字符串里的 https:// URL', () => {
  const text = '{"url":"https://example.com/a/b"}';
  assert.deepEqual(parseJsonc(text), { url: 'https://example.com/a/b' });
});

test('parseJsonc：解析标量顶层值', () => {
  assert.equal(parseJsonc('123'), 123);
  assert.equal(parseJsonc('"str"'), 'str');
  assert.equal(parseJsonc('true'), true);
});

test('parseJsonc：非法 JSON 抛 SyntaxError', () => {
  assert.throws(() => parseJsonc('{'), SyntaxError);
  assert.throws(() => parseJsonc('{"a": }'), SyntaxError);
});
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamingRate, tokenRate, sumGeneration } from './token-rate.js';

test('流式估算不受网络 chunk 划分影响', () => {
  const text = 'hello streaming tokenizer 中文测试 😀';
  const whole = new StreamingRate().add(text, 0).tokens;
  const split = new StreamingRate();
  let result = 0;
  for (const char of text) result = split.add(char, 0).tokens;
  assert.equal(result, whole);
});
test('时间窗口计速忽略同一时刻突发，不制造峰值', () => {
  const rate = new StreamingRate();
  assert.equal(rate.add('abcd', 0).tps, 0);
  assert.equal(rate.add('efgh', 0).tps, 0);
  assert.equal(rate.add('ijkl', 1000).tps, 1);
});
test('短流隐藏，高速有效样本不人为封顶，非法数据隐藏', () => {
  assert.equal(tokenRate(1000, 0), 0);
  assert.equal(tokenRate(1000, 10), 0);
  assert.equal(tokenRate(3200, 2000), 1600);
  assert.equal(tokenRate(NaN, 1000), 0);
});
test('聚合只使用配对样本，短突发不污染其它请求均值', () => {
  const result = sumGeneration([
    { generation: { tokens: 100, ms: 1000 } },
    { generation: { tokens: 10000, ms: 0 } },
  ], 10100, 1000);
  assert.equal(tokenRate(result.tokens, result.ms), 100);
});

test('慢请求即使四舍五入为 0 tok/s，其耗时仍参与总体均值', () => {
  const sample = sumGeneration([{ generation: { tokens: 1, ms: 10000 } }, { generation: { tokens: 99, ms: 1000 } }], 100, 11000);
  assert.equal(sample.ms, 11000);
  assert.equal(tokenRate(sample.tokens, sample.ms), 9);
});

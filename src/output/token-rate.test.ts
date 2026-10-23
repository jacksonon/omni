import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamingRate, tokenRate, sumGeneration, requestGeneration } from './token-rate.js';

test('流式估算不受网络 chunk 划分影响', () => {
  const text = 'hello streaming tokenizer 中文测试 😀';
  const whole = new StreamingRate().add(text, 0).tokens;
  const split = new StreamingRate();
  let result = 0;
  for (const char of text) result = split.add(char, 0).tokens;
  assert.equal(result, whole);
});
test('流中请求吞吐包含首 token 等待，分块不改变累计分子', () => {
  const rate = new StreamingRate(0);
  assert.equal(rate.add('abcd', 0).tps, 0);
  assert.equal(rate.add('efgh', 0).tps, 0);
  assert.equal(rate.add('ijkl', 1000).tps, 3);
});
test('零耗时隐藏，有效请求速率不人为封顶，非法数据隐藏', () => {
  assert.equal(tokenRate(1000, 0), 0);
  assert.equal(tokenRate(1000, 10), 100000);
  assert.equal(tokenRate(3200, 2000), 1600);
  assert.equal(tokenRate(NaN, 1000), 0);
});
test('聚合只使用配对样本，短突发不污染其它请求均值', () => {
  const result = sumGeneration([
    { generation: { basis: 'request', tokens: 100, ms: 1000 } },
    { generation: { basis: 'request', tokens: 10000, ms: 0 } },
  ], 10100, 1000);
  assert.equal(tokenRate(result.tokens, result.ms), 100);
});

test('慢请求的耗时仍参与总体均值', () => {
  const sample = sumGeneration([{ generation: { basis: 'request', tokens: 1, ms: 10000 } }, { generation: { basis: 'request', tokens: 99, ms: 1000 } }], 100, 11000);
  assert.equal(sample.ms, 11000);
  assert.equal(tokenRate(sample.tokens, sample.ms), 9.1);
});

test('与 OpenCode 实际记录复算一致，包含首 token 等待', () => {
  assert.equal(tokenRate(531, 9577), 55.4);
  assert.equal(tokenRate(1069, 12477), 85.7);
  const sample = new StreamingRate(0).add('abcd', 1000);
  assert.equal(sample.tps, 1);
});
test('旧历史重建使用完整请求耗时，不能复用旧的纯生成分母', () => {
  const usage = { completion: 100, generation: { tokens: 100, ms: 200 } };
  assert.deepEqual(requestGeneration(usage, 1000), { tokens: 100, ms: 1000, basis: 'request' });
});

test('mini 与 TUI 对同一记录都按请求时间计算，而非纯生成时间', async () => {
  const { turnTokenRate } = await import('./mini.js');
  const { sessionAvgRate } = await import('../tui/layout.js');
  assert.equal(turnTokenRate({ toolCalls: 2, toolMs: 3500, llmCalls: 3, llmMs: 9577, genMs: 3262, completion: 531 }), 55.4);
  assert.equal(sessionAvgRate(
    { turns: 1, steps: 3, llmMs: 9577, toolsMs: 3500, firstTokenSum: 6315, firstTokenCount: 3, genMs: 3262, cached: 0 },
    { prompt: 1000, completion: 531, total: 1531 },
  ), 55.4);
});

/**
 * 模型能力查表单元测试（纯同步、离线内置快照）。
 * 断言依赖 src/config/model-context-snapshot.ts 中稳定的已知模型条目。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_FALLBACK_CONTEXT,
  DEFAULT_FALLBACK_EFFORT_OPTIONS,
  SLIDER_EFFORT_POOL,
  autoFillLimit,
  deriveReasoningLevels,
  describeModelContextWindow,
  formatTokenCount,
  lookupModelContext,
  lookupModelContextWindow,
  parseContextSetArg,
  resolveContextLimit,
  resolveModelCapabilities,
  resolveReasoningEffortOptions,
  snapshotInfo,
} from './model-context.js';

test('lookupModelContext：精确命中（小写 + 去空白）', () => {
  const hit = lookupModelContext('openai/gpt-4o');
  assert.ok(hit);
  assert.equal(hit.matchType, 'exact');
  assert.equal(hit.key, 'openai/gpt-4o');
  assert.equal(hit.entry.c, 128000);

  const cased = lookupModelContext('  OpenAI/GPT-4O  ');
  assert.ok(cased);
  assert.equal(cased.matchType, 'exact');
});

test('lookupModelContext：裸 id 命中（剥掉网关前缀）', () => {
  const hit = lookupModelContext('my-gateway/gpt-4o');
  assert.ok(hit);
  assert.equal(hit.matchType, 'bare');
  assert.equal(hit.key, 'gpt-4o');
  assert.equal(hit.entry.c, 128000);
});

test('lookupModelContext：后缀命中（输入末段 == 表内 model 段）', () => {
  const hit = lookupModelContext('dracarys-llama-3.1-70b-instruct');
  assert.ok(hit);
  assert.equal(hit.matchType, 'suffix');
  assert.equal(hit.key, 'abacusai/dracarys-llama-3.1-70b-instruct');
  assert.equal(hit.entry.c, 128000);
});

test('lookupModelContext：未命中 / 空输入返回 null', () => {
  assert.equal(lookupModelContext('totally-unknown-model-zzz'), null);
  assert.equal(lookupModelContext(''), null);
  assert.equal(lookupModelContext(undefined), null);
  assert.equal(lookupModelContext(null), null);
});

test('lookupModelContextWindow：命中返回窗口，未命中 undefined', () => {
  assert.equal(lookupModelContextWindow('openai/gpt-4o'), 128000);
  assert.equal(lookupModelContextWindow('unknown-zzz'), undefined);
});

test('deriveReasoningLevels：effort 型映射到滑条池子集（含开关档）', () => {
  // zai/glm-5.2：effort = high/max
  assert.deepEqual(deriveReasoningLevels('zai/glm-5.2'), ['none', 'auto', 'high', 'max']);
  // claude-fable-5（裸键）：effort 覆盖全部五档
  assert.deepEqual(deriveReasoningLevels('claude-fable-5'), [...SLIDER_EFFORT_POOL]);
});

test('deriveReasoningLevels：toggle / 无 ro 只给开关档', () => {
  assert.deepEqual(deriveReasoningLevels('zai/glm-4.5'), ['none', 'auto']);
  assert.deepEqual(deriveReasoningLevels('openai/gpt-4o'), ['none', 'auto']);
});

test('deriveReasoningLevels：未命中返回 undefined', () => {
  assert.equal(deriveReasoningLevels('unknown-zzz'), undefined);
});

test('resolveReasoningEffortOptions：显式配置永远优先（含空数组=明确关闭）', () => {
  assert.deepEqual(resolveReasoningEffortOptions(['low'], 'zai/glm-5.2'), ['low']);
  assert.deepEqual(resolveReasoningEffortOptions([], 'zai/glm-5.2'), []);
});

test('resolveReasoningEffortOptions：未配置时查表，多名称依次尝试', () => {
  assert.deepEqual(resolveReasoningEffortOptions(undefined, 'zai/glm-5.2'), ['none', 'auto', 'high', 'max']);
  // 第一个名称未命中 → 回退第二个
  assert.deepEqual(resolveReasoningEffortOptions(undefined, 'nope-zzz', 'zai/glm-4.5'), ['none', 'auto']);
  // 全部未命中 → 默认档位
  assert.deepEqual(resolveReasoningEffortOptions(undefined, 'nope-zzz'), [...DEFAULT_FALLBACK_EFFORT_OPTIONS]);
});

test('parseContextSetArg：查看 / 清除 / 设置 / 非法四态', () => {
  assert.deepEqual(parseContextSetArg(''), { kind: 'show' });
  assert.deepEqual(parseContextSetArg('   '), { kind: 'show' });
  assert.deepEqual(parseContextSetArg('默认'), { kind: 'clear' });
  assert.deepEqual(parseContextSetArg('default'), { kind: 'clear' });
  assert.deepEqual(parseContextSetArg('AUTO'), { kind: 'clear' });
  assert.deepEqual(parseContextSetArg('256'), { kind: 'set', k: 256, tokens: 256000 });
  assert.deepEqual(parseContextSetArg('1000'), { kind: 'set', k: 1000, tokens: 1_000_000 });
  assert.equal(parseContextSetArg('300').kind, 'error');
  assert.equal(parseContextSetArg('abc').kind, 'error');
  assert.equal(parseContextSetArg('2.5').kind, 'error');
});

test('formatTokenCount：人性化显示（真实取整语义）', () => {
  assert.equal(formatTokenCount(999), '999');
  assert.equal(formatTokenCount(1000), '1k');
  assert.equal(formatTokenCount(8192), '8k');
  assert.equal(formatTokenCount(128000), '128k');
  assert.equal(formatTokenCount(1_000_000), '1M');
  assert.equal(formatTokenCount(1_500_000), '1.5M');
});

test('resolveContextLimit：手动覆盖优先于模型查表值', () => {
  assert.equal(resolveContextLimit(undefined, 128000), 128000);
  assert.equal(resolveContextLimit(512000, 128000), 512000);
  assert.equal(resolveContextLimit(0, 128000), 128000); // 非正数不算覆盖
  assert.equal(resolveContextLimit(undefined, undefined), undefined);
  assert.equal(resolveContextLimit(262144.9, undefined), 262144);
});

test('autoFillLimit：只补缺 context，不猜 output', () => {
  const existing = { context: 1000, output: 50 };
  assert.deepEqual(autoFillLimit(existing, 'openai/gpt-4o'), existing);
  assert.deepEqual(autoFillLimit(undefined, 'openai/gpt-4o'), { context: 128000 });
  assert.deepEqual(autoFillLimit({ output: 50 }, 'openai/gpt-4o'), { output: 50, context: 128000 });
  assert.deepEqual(autoFillLimit({ output: 50 }, 'unknown-zzz'), { output: 50 });
  assert.equal(autoFillLimit(undefined, 'unknown-zzz'), undefined);
});

test('describeModelContextWindow：手动 / 自动 / 兜底三来源', () => {
  const manual = describeModelContextWindow(512000, 'openai/gpt-4o');
  assert.deepEqual({ value: manual.value, source: manual.source }, { value: 512000, source: 'manual' });

  const auto = describeModelContextWindow(undefined, 'openai/gpt-4o');
  assert.equal(auto.source, 'auto');
  assert.equal(auto.value, 128000);
  assert.equal(auto.matchedKey, 'openai/gpt-4o');
  assert.ok(!auto.label.includes('（')); // exact 不附加匹配类型说明

  const bare = describeModelContextWindow(undefined, 'my-gateway/gpt-4o');
  assert.equal(bare.source, 'auto');
  assert.ok(bare.label.includes('bare'));

  const fallback = describeModelContextWindow(undefined, 'unknown-zzz');
  assert.equal(fallback.source, 'fallback');
  assert.equal(fallback.value, DEFAULT_FALLBACK_CONTEXT);
});

test('resolveModelCapabilities：命中/未命中两种返回', () => {
  const hit = resolveModelCapabilities('openai/gpt-4o');
  assert.deepEqual(hit, { found: true, context: 128000, effortOptions: ['none', 'auto'] });
  const miss = resolveModelCapabilities('unknown-zzz');
  assert.equal(miss.found, false);
  assert.equal(miss.context, undefined);
  assert.deepEqual(miss.effortOptions, [...DEFAULT_FALLBACK_EFFORT_OPTIONS]);
});

test('snapshotInfo：返回非空快照元信息', () => {
  const info = snapshotInfo();
  assert.ok(info.count > 0);
  assert.ok(typeof info.generatedAt === 'string' && info.generatedAt.length > 0);
  assert.ok(info.ageDays >= 0);
  assert.equal(typeof info.sourceUrl, 'string');
});
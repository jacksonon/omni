/**
 * 上下文压缩切分边界测试：切点绝不能切开 assistant(tool_calls) ↔ tool 结果的配对，
 * 否则压缩后的下一轮请求会被网关 400。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { findSummarizeSplit } from './context.js';

type Msg = ChatCompletionMessageParam;

const system = (text = 'sys'): Msg => ({ role: 'system', content: text });
const user = (text = 'hi'): Msg => ({ role: 'user', content: text });
const assistantText = (text = 'done'): Msg => ({ role: 'assistant', content: text });
const assistantCall = (...ids: string[]): Msg =>
  ({
    role: 'assistant',
    content: null,
    tool_calls: ids.map((id) => ({
      id,
      type: 'function' as const,
      function: { name: 'run_command', arguments: '{}' },
    })),
  }) as Msg;
const toolMsg = (id: string): Msg => ({ role: 'tool', tool_call_id: id, content: 'ok' });

/** head 最后一条不能是悬空 tool_calls；tail 第一条不能是孤儿 tool */
function assertPairingSafe(messages: Msg[], split: number): void {
  assert.notEqual(messages[split]?.role, 'tool', `split=${split} 让 tail 以孤儿 tool 开头`);
  const prev = messages[split - 1];
  const dangling =
    prev?.role === 'assistant' &&
    Array.isArray((prev as { tool_calls?: unknown }).tool_calls) &&
    ((prev as { tool_calls: unknown[] }).tool_calls.length > 0);
  assert.equal(dangling, false, `split=${split} 让 head 以悬空 tool_calls 结尾`);
}

test('findSummarizeSplit：切点落在并行工具组中间 → 回退到该组 assistant 起点', () => {
  const messages = [
    system(),
    user(),
    assistantCall('c1', 'c2'),
    toolMsg('c1'),
    toolMsg('c2'),
    user(),
    assistantText(),
    user(),
    assistantText(),
  ];
  // length=9, keepTail=5 → 原始切点 4（第二条 tool 结果）
  const split = findSummarizeSplit(messages, 5);
  assert.equal(split, 2);
  assert.equal(messages[split].role, 'assistant');
  assertPairingSafe(messages, split);
});

test('findSummarizeSplit：任意 keepTail 都不会切开配对', () => {
  const messages = [
    system(),
    user(),
    assistantCall('c1', 'c2'),
    toolMsg('c1'),
    toolMsg('c2'),
    user(),
    assistantText(),
    user(),
    assistantCall('c3'),
    toolMsg('c3'),
    user(),
    assistantText(),
  ];
  for (let keepTail = 1; keepTail < messages.length; keepTail++) {
    const split = findSummarizeSplit(messages, keepTail);
    if (split < 0) continue;
    assert.ok(split >= 2);
    assertPairingSafe(messages, split);
  }
});

test('findSummarizeSplit：无工具的普通回合保持原有切分（不误回退）', () => {
  const messages = [system(), user(), assistantText(), user(), assistantText()];
  assert.equal(findSummarizeSplit(messages, 2), 3);
});
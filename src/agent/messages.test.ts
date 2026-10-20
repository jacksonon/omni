/**
 * 工具配对修复单元测试：assistant(tool_calls) 与 tool 消息的配对完整性。
 * 背景：工具执行期取消/打断/旧会话脏历史会留下悬空 tool_calls，网关按 OpenAI 协议
 * 直接 400（"An assistant message with 'tool_calls' must be followed by tool messages..."）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import {
  appendInterruptedToolResults,
  repairToolPairing,
  TOOL_INTERRUPTED_RESULT,
} from './messages.js';

type Msg = ChatCompletionMessageParam;

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
const user = (text = 'hi'): Msg => ({ role: 'user', content: text });
const system = (text = 'sys'): Msg => ({ role: 'system', content: text });
const assistantText = (text = 'done'): Msg => ({ role: 'assistant', content: text });

test('repairToolPairing：悬空 tool_calls 后紧跟 user → 先补合成 tool 结果', () => {
  const input = [user(), assistantCall('a'), user('next')];
  const out = repairToolPairing(input);
  assert.equal(out.length, 4);
  assert.equal(out[1].role, 'assistant');
  assert.equal(out[2].role, 'tool');
  assert.equal((out[2] as { tool_call_id?: string }).tool_call_id, 'a');
  assert.equal((out[2] as { content?: string }).content, TOOL_INTERRUPTED_RESULT);
  assert.equal(out[3].role, 'user');
  // 非破坏性：原数组不被修改
  assert.equal(input.length, 3);
});

test('repairToolPairing：尾部悬空 tool_calls → 补占位（不能以未回应的调用收尾）', () => {
  const out = repairToolPairing([user(), assistantCall('tail')]);
  assert.equal(out.length, 3);
  assert.equal(out[2].role, 'tool');
  assert.equal((out[2] as { tool_call_id?: string }).tool_call_id, 'tail');
});

test('repairToolPairing：孤儿 tool 消息（无主）丢弃', () => {
  const out = repairToolPairing([toolMsg('ghost'), user()]);
  assert.deepEqual(out.map((m) => m.role), ['user']);
});

test('repairToolPairing：合法的并行乱序结果原样返回（同引用）', () => {
  const input = [user(), assistantCall('a', 'b'), toolMsg('b'), toolMsg('a')];
  assert.equal(repairToolPairing(input), input);
});

test('repairToolPairing：重复回应同一 id → 丢弃重复项', () => {
  const out = repairToolPairing([user(), assistantCall('a'), toolMsg('a'), toolMsg('a')]);
  assert.equal(out.length, 3);
  assert.equal((out[2] as { tool_call_id?: string }).tool_call_id, 'a');
});

test('repairToolPairing：并行组缺一条结果 → 补占位，先到的结果保留', () => {
  const out = repairToolPairing([user(), assistantCall('a', 'b'), toolMsg('a')]);
  assert.equal(out.length, 4);
  assert.equal((out[2] as { content?: string }).content, 'ok');
  assert.equal((out[3] as { tool_call_id?: string }).tool_call_id, 'b');
});

test('repairToolPairing：空 tool_calls 数组 → 去掉字段（保持消息数）', () => {
  const empty = { role: 'assistant', content: 'x', tool_calls: [] } as unknown as Msg;
  const out = repairToolPairing([user(), empty]);
  assert.equal(out.length, 2);
  assert.equal('tool_calls' in (out[1] as unknown as Record<string, unknown>), false);
});

test('repairToolPairing：缺失 call id → 生成 id 并保持可配对', () => {
  const broken = {
    role: 'assistant',
    content: null,
    tool_calls: [{ type: 'function', function: { name: 'x', arguments: '{}' } }],
  } as unknown as Msg;
  const out = repairToolPairing([user(), broken]);
  const calls = (out[1] as { tool_calls?: Array<{ id?: string }> }).tool_calls!;
  assert.ok(calls[0].id);
  assert.equal((out[2] as { tool_call_id?: string }).tool_call_id, calls[0].id);
});

test('appendInterruptedToolResults：按调用顺序补占位', () => {
  const messages: Msg[] = [user(), assistantCall('a', 'b')];
  appendInterruptedToolResults(messages, [
    { id: 'a' },
    { id: 'b' },
  ]);
  assert.equal(messages.length, 4);
  assert.deepEqual(
    messages.slice(2).map((m) => (m as { tool_call_id?: string }).tool_call_id),
    ['a', 'b']
  );
});

test('appendInterruptedToolResults 后历史即通过配对校验（repair 原样返回）', () => {
  const messages: Msg[] = [user(), assistantCall('a', 'b')];
  appendInterruptedToolResults(messages, [{ id: 'a' }, { id: 'b' }]);
  assert.equal(repairToolPairing(messages), messages);
});
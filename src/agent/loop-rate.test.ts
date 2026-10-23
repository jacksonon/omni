import { test } from 'node:test';
import assert from 'node:assert/strict';
import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { ExecOutput } from '../exec.js';
import type { StreamProgress, TokenUsage } from '../output/types.js';
import { runAgent } from './loop.js';

class Capture extends ExecOutput {
  usages: TokenUsage[] = [];
  progress: StreamProgress[] = [];
  constructor() { super(true, false); }
  override onUsage(usage: TokenUsage): void { this.usages.push(usage); }
  onStreamProgress(progress: StreamProgress): void { this.progress.push(progress); }
}
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
for (const protocol of ['chat', 'responses'] as const) {
  test(`${protocol}: usage 延迟不算生成时间，隐藏思考不除以正文耗时`, async () => {
    const create = async () => (async function* () {
      if (protocol === 'chat') yield { choices: [{ delta: { role: 'assistant' } }] };
      else yield { type: 'response.created' };
      await wait(30);
      if (protocol === 'chat') yield { choices: [{ delta: { content: 'abcd' } }] };
      else yield { type: 'response.output_text.delta', delta: 'abcd' };
      await wait(350);
      if (protocol === 'chat') yield { choices: [{ delta: { content: 'efgh' } }] };
      else yield { type: 'response.output_text.delta', delta: 'efgh' };
      await wait(400);
      if (protocol === 'chat') yield { choices: [], usage: { prompt_tokens: 20, completion_tokens: 100, total_tokens: 120, completion_tokens_details: { reasoning_tokens: 70 } } };
      else yield { type: 'response.completed', response: { usage: { input_tokens: 20, output_tokens: 100, total_tokens: 120, output_tokens_details: { reasoning_tokens: 70 } } } };
    })();
    const client = { chat: { completions: { create } }, responses: { create } } as unknown as OpenAI;
    const out = new Capture();
    const messages: ChatCompletionMessageParam[] = [{ role: 'user', content: 'test' }];
    await runAgent(client, protocol === 'responses' ? 'muse-spark' : 'mock-model', messages, { tools: [], maxSteps: 1 }, out);
    assert.equal(out.progress.length, 2, 'role-only 和 usage-only 不能生成速率样本');
    assert.equal(out.progress[1]!.streamTokens, 2);
    assert.equal(out.usages[0]!.completion, 100, '计费用量完整保留');
    assert.equal(out.usages[0]!.generation!.tokens, 30);
    const ms = out.usages[0]!.generation!.ms;
    assert.ok(ms >= 300 && ms < 650, `ms=${ms} 必须只含两个正文块之间的时间`);
    const saved = messages[messages.length - 1] as unknown as { usage: TokenUsage };
    assert.deepEqual(saved.usage.generation, out.usages[0]!.generation);
  });
}

test('Responses 工具完成快照不重复统计已收到的参数', async () => {
  const { ResponsesAccumulator } = await import('./responses.js');
  const accum = new ResponsesAccumulator();
  assert.equal(accum.consume({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', name: 'read_file', call_id: 'call-1' } }).tokenText, 'read_file');
  assert.equal(accum.consume({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path":"a"}' }).tokenText, '{"path":"a"}');
  assert.equal(accum.consume({ type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"path":"a"}' }).tokenText, '');
  assert.equal(accum.consume({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', name: 'read_file', arguments: '{"path":"a"}' } }).tokenText, '');
});

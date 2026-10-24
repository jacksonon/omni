import test from 'node:test';
import assert from 'node:assert/strict';
import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { ExecOutput } from '../exec.js';
import { runAgent } from './loop.js';
import type { ToolContext } from '../tools/types.js';
import type { RunOptions } from './types.js';

for (const steer of [false, true]) {
  test(`工具${steer ? 'steer' : '取消'}后迟到的输出/结果不再改写当前 UI`, async () => {
    let finishTool!: (result: string) => void;
    let toolStarted!: () => void;
    const started = new Promise<void>(resolve => { toolStarted = resolve; });
    const completion = new Promise<string>(resolve => { finishTool = resolve; });
    let toolContext: ToolContext | undefined;
    const seen: string[] = [];
    class Capture extends ExecOutput {
      constructor() { super(true, false); }
      onCommandOutput(): void { seen.push('output'); }
      override onToolResult(): void { seen.push('result'); }
    }
    let request = 0;
    const client = { chat: { completions: { create: async () => (async function* () {
      if (request++ === 0) yield { choices: [{ delta: { tool_calls: [
        { index: 0, id: 'slow', type: 'function', function: { name: 'run_command', arguments: '{"command":"slow"}' } },
      ] }, finish_reason: 'tool_calls' }] };
      else yield { choices: [{ delta: { content: 'steered answer' }, finish_reason: 'stop' }] };
    })() } } } as unknown as OpenAI;
    let controller = new AbortController();
    let interrupt: string | null = steer ? 'steer now' : null;
    const options: RunOptions = {
      maxSteps: 3, permission: 'full', abortSignal: controller.signal,
      tools: [{ name: 'run_command', description: 'slow test tool', parameters: { type: 'object', properties: {} },
        execute: async (_args, ctx) => { toolContext = ctx; toolStarted(); return completion; } }],
      takeInterrupt: () => { const text = interrupt; interrupt = null; return text; },
      rearmAbort: () => { controller = new AbortController(); options.abortSignal = controller.signal; },
    };
    const messages: ChatCompletionMessageParam[] = [{ role: 'user', content: 'start' }];
    const run = runAgent(client, 'mock-model', messages, options, new Capture());
    await started;
    controller.abort();
    await run;
    toolContext?.onCommandOutput?.('late output', false);
    finishTool('late result');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(seen, []);
    if (steer) assert.ok(messages.some(message => message.role === 'user' && message.content === 'steer now'));
    assert.ok(messages.some(message => message.role === 'tool'), '中断工具仍有配对占位，下一次请求不会 400');
  });
}

/**
 * E2E 探针：思考耗时持久化 + TUI 恢复回放全链路
 * mock server（MOCK_STREAM 单轮：reasoning → content）→ runAgent 组装 assistant 消息，
 * 检查 messages 里 assistant 带 reasoning + reasoningMs（>0）；再用这些消息模拟恢复回放
 * （tui-entry/interactive 的 restoreSession 循环）→ TuiOutput 对话流出现思考块含耗时头行。
 * 运行：先起 mock（npm run mock），再 bun run 本文件。
 */
import OpenAI from 'openai';
import { runAgent } from '../../src/agent/loop.js';
import { TuiOutput } from '../../src/tui/output.js';
import { createTuiState } from '../../src/tui/state.js';

let failed = 0;
function check(name: string, cond: boolean, extra = '') {
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failed += 1;
}

const client = new OpenAI({
  apiKey: 'sk-test',
  baseURL: 'http://127.0.0.1:8787/v1',
  timeout: 30000,
});

const state = createTuiState();
const session = { paint: async () => {} } as never;
const out = new TuiOutput(state, { showThinking: true }, session as never);

const messages: import('openai/resources/chat/completions').ChatCompletionMessageParam[] = [
  { role: 'user', content: '你好，请简单回答' },
];
const tools = [
  {
    name: 'run_command',
    description: '执行 shell 命令',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
    async execute(args: { command: string }) {
      return `退出码: 0\n${args.command}`;
    },
  },
];
await runAgent(client, 'mock', messages, {
  tools,
  maxSteps: 5,
  permission: 'full',
  requestApproval: () => Promise.resolve(true),
  auditLog: false,
}, out);

console.log('[diag] messages roles:', messages.map((m) => m.role).join(',') || '(empty)');

// ---- 消息持久化侧 ----
const assistantMsgs = messages.filter((m) => m.role === 'assistant');
const last = assistantMsgs[assistantMsgs.length - 1] as unknown as {
  reasoning?: string; reasoningMs?: number;
};
check('assistant 消息存在', !!last);
check('assistant 消息带 reasoning（思考内容落盘）', typeof last.reasoning === 'string' && last.reasoning.length > 0, `len=${(last.reasoning || '').length}`);
check('assistant 消息带 reasoningMs（思考耗时落盘）', typeof last.reasoningMs === 'number' && last.reasoningMs > 0, `ms=${last.reasoningMs}`);

// ---- 恢复回放侧（模拟 tui-entry restore 循环）----
// 断言：恢复后产生的 thinking 块数量 = 消息里带 reasoning 的 assistant 数量，且逐条匹配内容+耗时
const restoreState = createTuiState();
const restoreOut = new TuiOutput(restoreState, { showThinking: true }, session as never);
for (const m of messages) {
  if (m.role === 'user' && typeof m.content === 'string' && m.content) {
    restoreOut.onUserMessage(m.content);
  } else if (m.role === 'assistant') {
    const ext = m as unknown as { reasoning?: string; reasoningMs?: number };
    if (ext.reasoning) restoreOut.onThinkingRestored?.(ext.reasoning, ext.reasoningMs);
    if (typeof m.content === 'string' && m.content) { restoreOut.onAnswer(m.content); restoreOut.onAnswerEnd(); }
  }
}
const restored = restoreState.lines.filter((l) => l.kind === 'thinking');
const reasonings = messages.filter((m) => m.role === 'assistant' && (m as unknown as { reasoning?: string }).reasoning) as unknown as {
  reasoning?: string; reasoningMs?: number;
}[];
check('恢复回放产生 thinking 块数 = 带 reasoning 的消息数', restored.length === reasonings.length, `restored=${restored.length} / src=${reasonings.length}`);
let allMatch = true;
for (const rt of restored) {
  if (rt.thinkingRunning === true) allMatch = false;
}
reasonings.forEach((src, i) => {
  const rt = restored[i];
  if (!rt) { allMatch = false; return; }
  if (rt.text !== src.reasoning) allMatch = false;
  if (rt.thinkingMs !== src.reasoningMs) allMatch = false;
});
check('恢复的 thinking 内容/耗时逐条匹配原始 reasoning/reasoningMs', allMatch, `n=${restored.length}`);
check('思考块展开态（非 running）', restored.length > 0 && restored.every((r) => r.thinkingRunning !== true));

console.log(failed === 0 ? '\nE2E 探针全部通过 ✓（reasoningMs 落盘 + 恢复回放保留耗时）' : `\n${failed} 项失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
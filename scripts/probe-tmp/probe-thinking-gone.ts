/**
 * 探针：thinking 内容消失复现——真实 runAgent + mock server（MOCK_STREAM 逐字流式）
 * 两轮：reasoning + run_command → reasoning + answer。检查 state.lines 中 thinking 行。
 */
import OpenAI from 'openai';
import { runAgent } from '../../src/agent/loop.js';
import { TuiOutput } from '../../src/tui/output.js';
import { createTuiState } from '../../src/tui/state.js';

const client = new OpenAI({
  apiKey: 'sk-test',
  baseURL: 'http://127.0.0.1:8787/v1',
  timeout: 30000,
});

const state = createTuiState();
state.model = 'mock';
const session = { paint: async () => {} } as never;
const out = new TuiOutput(state, { showThinking: true }, session as never);

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

await runAgent(client, 'mock', [{ role: 'user', content: '帮我执行 echo mock-ok' }], {
  tools,
  maxSteps: 5,
  permission: 'full',
  requestApproval: () => Promise.resolve(true),
  auditLog: false,
}, out);

// 输出 lines 全貌
console.log('===== state.lines =====');
state.lines.forEach((l, i) => {
  const kind = l.kind;
  const text = l.text?.length ? JSON.stringify(l.text.slice(0, 60)) : '(空)';
  const running = (l as { thinkingRunning?: boolean }).thinkingRunning ?? '';
  const ms = (l as { thinkingMs?: number }).thinkingMs ?? '';
  console.log(`[${i}] ${kind} ${text} running=${running} ms=${ms}`);
});

const thinkingLines = state.lines.filter((l) => l.kind === 'thinking');
console.log(`\nthinking 行数: ${thinkingLines.length}`);
const hasReason1 = state.lines.some((l) => l.text.includes('我需要分析这个任务'));
const hasReason2 = state.lines.some((l) => l.text.includes('工具执行成功了'));
console.log(`思考1(我需要分析这个任务): ${hasReason1}`);
console.log(`思考2(工具执行成功了): ${hasReason2}`);

if (thinkingLines.length === 2 && hasReason1 && hasReason2) {
  console.log('✓ 正常路径：两轮思考内容完整');
  process.exit(0);
}
console.log('✗ 异常：thinking 内容缺失');
process.exit(1);

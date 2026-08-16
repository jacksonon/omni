/**
 * probe-thinking-e2e：真实 runAgent 全链路 + TuiOutput + mock server 多轮复现。
 * 每轮提交用户消息 → runAgent → onTurnEnd，渲染帧检查 thinking 头行与内容。
 */
import { createTestRenderer } from '@opentui/core/testing';
import { mountTree } from '../../src/tui/render.js';
import { createTuiState } from '../../src/tui/state.js';
import { TuiOutput } from '../../src/tui/output.js';
import OpenAI from 'openai';

async function main(): Promise<void> {
  const client = new OpenAI({ baseURL: 'http://127.0.0.1:8787/v1', apiKey: 'sk-mock' });
  const state = createTuiState();
  state.model = 'mock-model';
  const session = { paint: async () => {} };
  const out = new TuiOutput(state, { showThinking: true }, session as never);
  const messages: any[] = [];
  const tools = await (await import('../../src/tools/index.js')).tools;
  let fails = 0;
  const ROUNDS = 6;
  for (let r = 1; r <= ROUNDS; r++) {
    messages.push({ role: 'user', content: `第 ${r} 轮问题` });
    out.onUserMessage(`第 ${r} 轮问题`);
    const { runAgent } = await import('../../src/agent/loop.js');
    await runAgent(client, 'mock-model', messages, { tools, stream: true, maxSteps: 10, showThinking: true }, out);
    out.onTurnEnd();
    // 逐轮渲染检查
    const t = await createTestRenderer({ width: 80, height: 24 });
    const tree = mountTree(t.renderer, state, { withInput: true });
    const { repaintTree } = await import('../../src/tui/render.js');
    await repaintTree(t.renderer, tree, state, { withInput: true });
    await t.renderOnce();
    const frame = t.captureCharFrame();
    const thinkLines = state.lines.filter((l) => l.kind === 'thinking');
    const runningLeft = thinkLines.filter((l) => l.thinkingRunning).length;
    const head = frame.includes('- thinking');
    console.log(`轮 ${r}: thinking 行=${thinkLines.length} running残留=${runningLeft} 帧头行=${head}`);
    if (runningLeft > 0) {
      console.error(`✗ 轮 ${r} thinkingRunning 残留 ${runningLeft} 行`);
      fails++;
    }
    if (!head) {
      console.error(`✗ 轮 ${r} 帧无 thinking 头行`);
      fails++;
    }
    // 检查每行内容完整
    thinkLines.forEach((l, i) => {
      if (!l.text.trim()) {
        console.error(`✗ thinking[${i}] 内容为空`);
        fails++;
      }
      if (l.text.includes('undefined')) {
        console.error(`✗ thinking[${i}] 含 undefined: ${JSON.stringify(l.text)}`);
        fails++;
      }
    });
  }
  console.log(`\n最终: lines=${state.lines.length} thinking 行=${state.lines.filter((l) => l.kind === 'thinking').length}`);
  state.lines.forEach((l, i) => {
    if (l.kind === 'thinking') console.log(`  lines[${i}] running=${l.thinkingRunning} ms=${l.thinkingMs} text=${JSON.stringify(l.text.slice(0, 25))}`);
  });
  console.log(fails === 0 ? '\n✓ 多轮 e2e thinking 不丢' : `\n✗ ${fails} 处失败`);
  process.exit(fails === 0 ? 0 : 1);
}
void main();

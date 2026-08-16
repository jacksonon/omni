/**
 * probe-ask-e2e：真实链路验证 ask_user——mock 第一轮发 ask_user 调用，
 * TUI 面板出现 → 模拟按键选择选项（A）→ 工具结果回传 → 模型继续完成回答。
 */
import { createTestRenderer } from '@opentui/core/testing';
import { mountTree, onAskKeyPress } from '../../src/tui/render.js';
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
  messages.push({ role: 'user', content: '帮我看看怎么做' });
  out.onUserMessage('帮我看看怎么做');
  const { tools } = await import('../../src/tools/index.js');
  const { createAskUserTool } = await import('../../src/tools/ask.js');
  const runOpts: any = {
    tools: [...tools, createAskUserTool(out.askUser.bind(out))],
    stream: true,
    maxSteps: 10,
    showThinking: true,
  };
  const { runAgent } = await import('../../src/agent/loop.js');
  const runPromise = runAgent(client, 'mock-model', messages, runOpts, out);
  // 等 ask 面板出现（工具执行挂起）
  let waited = 0;
  while (!state.ask && waited < 5000) {
    await new Promise((r) => setTimeout(r, 50));
    waited += 50;
  }
  if (!state.ask) {
    console.error('✗ ask 面板未出现（工具未挂起等待）');
    process.exit(1);
  }
  console.log(`面板出现: question=${state.ask.question} options=${JSON.stringify(state.ask.options)}`);
  // 渲染帧检查
  const t = await createTestRenderer({ width: 80, height: 24 });
  const tree = mountTree(t.renderer, state, { withInput: true });
  await t.renderOnce();
  const frame = t.captureCharFrame();
  if (!frame.includes('接下来怎么做') || !frame.includes('A) 继续执行')) {
    console.error('✗ 渲染帧缺 ask 面板内容');
    console.log(frame);
    process.exit(1);
  }
  console.log('✓ 渲染帧含面板');
  // 模拟按键 A 选择「继续执行」
  onAskKeyPress({ name: 'a', preventDefault: () => {} } as never, state, tree as never, () => {});
  const result = await runPromise;
  if (result !== undefined) void result;
  if (state.ask !== null) {
    console.error('✗ 选择后面板未关闭');
    process.exit(1);
  }
  console.log('✓ 按键 A 选择后面板关闭');
  // 模型继续完成回答（mock 第二轮返回固定回答）——验证工具结果正确回传
  const toolMsg = messages.find((m) => m.role === 'tool');
  const toolContent = typeof toolMsg?.content === 'string' ? toolMsg.content : '';
  console.log(`工具结果回传: ${JSON.stringify(toolContent)}`);
  if (!toolContent.includes('用户选择了选项：继续执行')) {
    console.error('✗ 工具结果未回传（模型看不到用户选择）');
    process.exit(1);
  }
  console.log('\n✓ ask_user e2e 全链路通过');
  process.exit(0);
}
void main();

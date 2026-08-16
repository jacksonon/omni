import { createTestRenderer, KeyCodes } from '@opentui/core/testing';
import { mountTree, onAskKeyPress } from '/Users/os/Downloads/omni/src/tui/render.js';
import { createTuiState } from '/Users/os/Downloads/omni/src/tui/state.js';
import { TuiOutput } from '/Users/os/Downloads/omni/src/tui/output.js';
import OpenAI from 'openai';
async function main() {
  const client = new OpenAI({ baseURL: 'http://127.0.0.1:8787/v1', apiKey: 'sk-mock' });
  const state = createTuiState();
  state.model = 'mock-model';
  const session = { paint: async () => {} };
  const out = new TuiOutput(state, { showThinking: true }, session as never);
  const messages: any[] = [{ role: 'user', content: 'hi' }];
  const { tools } = await import('/Users/os/Downloads/omni/src/tools/index.js');
  const { createAskUserTool } = await import('/Users/os/Downloads/omni/src/tools/ask.js');
  const runOpts: any = { tools: [...tools, createAskUserTool(out.askUser.bind(out))], stream: true, maxSteps: 10, showThinking: true };
  const { runAgent } = await import('/Users/os/Downloads/omni/src/agent/loop.js');
  const t = await createTestRenderer({ width: 80, height: 24 });
  const tree = mountTree(t.renderer, state, { withInput: true });
  const input: any = tree.input;
  input.focus();
  const handler = (key: any) => onAskKeyPress(key, state, tree, () => {});
  (t.renderer as any).keyInput.on('keypress', handler);
  input.onSubmit = () => {
    const text = input.plainText.trim();
    if (state.ask) {
      if (text) { state.askResolve?.({ choice: text, custom: true, choices: [text] }); input.setText(''); }
      return;
    }
  };
  const runPromise = runAgent(client, 'mock-model', messages, runOpts, out);
  let waited = 0;
  while (!state.ask && waited < 5000) { await new Promise((r) => setTimeout(r, 50)); waited += 50; }
  if (!state.ask) { console.log('✗ 面板未出现'); process.exit(1); }
  console.log('面板出现:', state.ask.question, '多选:', state.ask.multiple);
  // 真实按键：↓ 移到选项二 → 空格勾选 → Enter 提交
  await t.mockInput.pressKey(KeyCodes.ARROW_DOWN);
  await t.mockInput.pressKey(' ');
  await t.mockInput.pressKey(KeyCodes.RETURN);
  await runPromise;
  console.log('提交后面板关闭:', state.ask === null);
  const toolMsg = messages.find((m) => m.role === 'tool');
  console.log('工具结果:', JSON.stringify(toolMsg?.content));
  if (!String(toolMsg?.content).includes('用户选择了选项：先总结')) {
    console.log('✗ 工具结果错误（应选「先总结」）');
    process.exit(1);
  }
  console.log('✓ 完整链路（竖向勾选 + Enter 提交）通过');
  process.exit(0);
}
void main();

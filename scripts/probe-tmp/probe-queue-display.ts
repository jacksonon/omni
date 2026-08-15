/**
 * 探针：验证「运行中 Enter 提交的消息 → 待发送列表」时，待发送小视图（灰块正上方）
 * 真实渲染出来（标题「⏳ 待发送（N…）」+ 消息行 + steer ⚡ 徽标）——用户反馈
 * 「排队消息显示的区域没有显示排队中了」。
 * 驱动真实 runTuiInteractive（假 session/假 Textarea + mock MOCK_STREAM=1），
 * paint 走真实 mountTree/repaintTree → 每次 paint 后抓帧断言。
 */
import OpenAI from 'openai';
import { spawn } from 'node:child_process';
import { createTestRenderer } from '@opentui/core/testing';
import { createTuiState } from '../../src/tui/state.js';
import { TuiOutput } from '../../src/tui/output.js';
import { runTuiInteractive } from '../../src/tui/interactive.js';
import { mountTree, repaintTree } from '../../src/tui/render.js';
import { createTestRenderer } from '@opentui/core/testing';
import type { RunOptions } from '../../src/agent/types.js';
import type { TuiSession, TuiKey } from '../../src/tui/render.js';

const PORT = 8801;

function startMock(): Promise<void> {
  return new Promise((resolve) => {
    const p = spawn('bun', ['run', 'scripts/mock-server.mjs'], {
      env: { ...process.env, PORT: String(PORT), MOCK_STREAM: '1' },
      stdio: 'ignore',
    });
    setTimeout(resolve, 800);
    (p as unknown as { _keep?: boolean })._keep = true;
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(desc: string, cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${desc}`);
    await wait(10);
  }
}

const stubTool = {
  name: 'run_command',
  description: 'x',
  parameters: {},
  execute: async () => 'mock-ok',
};

function makeFakeInput(): {
  text: string;
  onSubmit: (() => void) | undefined;
  focus: () => void;
  setText: (t: string) => void;
} {
  const input: {
    text: string;
    onSubmit: (() => void) | undefined;
    focus: () => void;
    setText: (t: string) => void;
    plainText: string;
  } = {
    text: '',
    onSubmit: undefined,
    focus: () => {},
    setText: (t: string) => {
      input.text = t;
    },
    get plainText() {
      return input.text;
    },
  };
  return input;
}

async function main(): Promise<void> {
  const T = (m: string) => process.stderr.write(`[trace] ${m}\n`);
  T('startMock');
  await startMock();
  T('mock ok, createClient');
  const client = new OpenAI({ apiKey: 'sk-mock', baseURL: `http://127.0.0.1:${PORT}/v1` });
  const state = createTuiState();
  const fakeInput = makeFakeInput();
  T('createTestRenderer');
  const t = await createTestRenderer({ width: 64, height: 24 });
  T('mountTree');
  const tree = mountTree(t.renderer, state, { withInput: true });
  T('renderOnce');
  await t.renderOnce();
  T('renderOnce ok');
  const session: TuiSession = {
    paint: async () => {
      repaintTree(t.renderer, tree, state, { withInput: true });
      await t.renderOnce();
    },
    input: fakeInput as never,
    onKeyPress: (_cb: (key: TuiKey) => void) => () => {},
  };
  T('runTuiInteractive');
  const runOpts: RunOptions = {
    tools: [stubTool],
    permission: 'full',
    context: { autoMemory: false },
  } as RunOptions;
  const messages = [];
  const out = new TuiOutput(state, { showThinking: true }, session);
  const interactiveP = runTuiInteractive(client, 'mock', messages, runOpts, out, session, state);
  interactiveP.catch((e) => {
    console.error('交互循环异常:', e);
    process.exit(1);
  });

  const grabFrame = (): string => t.captureCharFrame();

  // 阶段 1：第一轮提交 → 回合运行中（此时无待发送 → 帧内不应有「待发送」标题）
  await waitFor('输入框就绪', () => fakeInput.onSubmit !== undefined);
  fakeInput.text = '第一条';
  fakeInput.onSubmit!();
  await waitFor('第一回合运行中', () => state.running === true);
  await wait(200);
  let frame = grabFrame();
  if (frame.includes('待发送')) {
    throw new Error('运行中且无待发送消息时不应出现待发送区');
  }
  console.log('[1] ✓ 回合运行中、无待发送时：帧内无待发送区');

  // 阶段 2：运行中 Enter 提交普通消息 → 待发送列表 +1，灰块正上方渲染小视图
  fakeInput.text = '排队消息';
  fakeInput.onSubmit!();
  await waitFor('入待发送列表', () => state.pending.length === 1);
  await wait(200);
  frame = grabFrame();
  if (state.pending[0].mode !== 'queue') throw new Error('应为 queue 模式');
  if (!frame.includes('⏳ 待发送（1') || !frame.includes('排队消息')) {
    console.error('--- 帧内容（待发送区缺失）---');
    console.error(frame);
    throw new Error(`待发送小视图未渲染: pending=${JSON.stringify(state.pending)}`);
  }
  console.log('[2] ✓ 运行中排队 1 条：帧内出现「⏳ 待发送（1）」+ 消息行「· 排队消息」');

  // 阶段 3：运行中再排队一条 steer（Cmd/Ctrl+Enter）→ 插最前，标题显示 ⚡ 打断
  fakeInput.text = '打断消息';
  state.submitMode = 'steer';
  fakeInput.onSubmit!();
  await waitFor('steer 入待发送列表', () => state.pending.length === 2);
  await wait(200);
  frame = grabFrame();
  if (state.pending[0].text !== '打断消息' || state.pending[0].mode !== 'steer') {
    throw new Error(`steer 未插最前: ${JSON.stringify(state.pending)}`);
  }
  if (!frame.includes('⚡ 1 打断') || !frame.includes('⚡ 打断消息')) {
    console.error('--- 帧内容（steer 徽标缺失）---');
    console.error(frame);
    throw new Error('steer 徽标或计数未渲染');
  }
  // 打断消息被消费后（新回合发出）→ 待发送区恢复只显示剩余 queue 消息
  console.log('[3] ✓ 运行中 steer 排队：标题含「⚡ 1 打断」+ 徽标「⚡ 打断消息」');

  // 阶段 4：回合自然结束 → 待发送按序消费（steer 优先发出），随后 /exit 退出
  await waitFor('回合全部结束', () => state.running === false && state.pending.length === 0);
  console.log('[4] ✓ 回合结束后待发送列表按序消费（打断消息优先发出）');

  await waitFor('输入框就绪', () => fakeInput.onSubmit !== undefined);
  fakeInput.text = '/exit';
  fakeInput.onSubmit!();
  await Promise.race([
    interactiveP,
    wait(8000).then(() => {
      throw new Error('交互循环未在 /exit 后退出');
    }),
  ]);
  console.log('[5] ✓ /exit 正常退出');
  console.log('\n== 全部通过：运行中排队 → 待发送小视图真实渲染（标题/消息/steer 徽标/按序消费）==');
  process.exit(0);
}

void main();
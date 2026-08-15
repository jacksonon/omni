/**
 * 探针：运行中输入 / 命令立即分发（不进待发送列表）——
 *  · Agent 回合进行中：Enter 提交普通消息 → 进待发送列表（排队）
 *  · 同一回合中 Enter 提交 /theme → **立即**打开主题菜单（runCommand 分发），
 *    不进入待发送列表（修复前 /theme 被当普通消息排队，要等回合 + 排队消息全部
 *    结束才执行——用户报告）
 *  · 回合结束后待发送列表按序消费；随后 /exit 正常退出
 * 用假 session/假 Textarea 驱动真实 runTuiInteractive 主循环（mock MOCK_STREAM=1）。
 */
import OpenAI from 'openai';
import { spawn } from 'node:child_process';
import { createTuiState } from '../../src/tui/state.js';
import { TuiOutput } from '../../src/tui/output.js';
import { runTuiInteractive } from '../../src/tui/interactive.js';
import type { RunOptions } from '../../src/agent/types.js';
import type { TuiSession, TuiKey } from '../../src/tui/render.js';

const PORT = 8800;

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

/** 假的 run_command 工具（立即返回，不真执行）：让 mock 走流式分支而非计划模式 */
const stubTool = {
  name: 'run_command',
  description: 'x',
  parameters: {},
  execute: async () => 'mock-ok',
};

/** 假的 Textarea：只暴露 interactive.ts 用到的成员（plainText/setText/focus/onSubmit） */
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
  await startMock();
  const client = new OpenAI({ apiKey: 'sk-mock', baseURL: `http://127.0.0.1:${PORT}/v1` });
  const state = createTuiState();
  const fakeInput = makeFakeInput();
  const session: TuiSession = {
    paint: async () => {},
    input: fakeInput as never,
    onKeyPress: (_cb: (key: TuiKey) => void) => () => {},
  };
  const runOpts: RunOptions = {
    tools: [stubTool],
    permission: 'full',
    context: { autoMemory: false }, // 退出时跳过全局记忆写入（避免写真实 ~/.config）
  } as RunOptions;
  const messages = [];
  const out = new TuiOutput(state, { showThinking: true }, session);
  const interactiveP = runTuiInteractive(client, 'mock', messages, runOpts, out, session, state);
  interactiveP.catch((e) => {
    console.error('交互循环异常:', e);
    process.exit(1);
  });

  // 阶段 1：第一轮提交普通消息 → Agent 开始运行（回合进行中）
  await waitFor('输入框就绪（waitForSubmit）', () => fakeInput.onSubmit !== undefined);
  fakeInput.text = '第一条';
  fakeInput.onSubmit!();
  await waitFor('第一回合开始（running=true）', () => state.running === true);
  console.log('[1] 第一回合运行中（onSubmit 已是运行中分流 handler）');

  // 阶段 2：运行中输入普通消息 → 应进待发送列表
  fakeInput.text = '排队消息';
  fakeInput.onSubmit!();
  await waitFor('普通消息入待发送列表', () => state.pending.length === 1);
  if (state.pending[0].text !== '排队消息' || state.pending[0].mode !== 'queue') {
    throw new Error(`排队消息内容错误: ${JSON.stringify(state.pending)}`);
  }
  console.log(`[2] 运行中提交普通消息 → 进待发送列表: ${JSON.stringify(state.pending.map((p) => p.text))}`);

  // 阶段 3：运行中输入 /theme → 应立即打开主题菜单（修复点），不进待发送列表
  const runningAtDispatch = state.running;
  fakeInput.text = '/theme';
  fakeInput.onSubmit!();
  await waitFor('主题菜单立即打开（运行中）', () => state.menu !== null);
  if (!runningAtDispatch) throw new Error('/theme 分发时回合已不在运行（探针时序问题）');
  if (state.menu?.id !== 'theme') throw new Error(`菜单不是主题面板: ${state.menu?.id}`);
  const themeInPending = state.pending.some((p) => p.text === '/theme');
  if (themeInPending) throw new Error('/theme 不应进入待发送列表（应立即分发）');
  if (state.pending.length !== 1 || state.pending[0].text !== '排队消息') {
    throw new Error(`待发送列表被 /theme 污染: ${JSON.stringify(state.pending.map((p) => p.text))}`);
  }
  console.log('[3] ✓ 运行中提交 /theme → 立即打开主题菜单（未进待发送列表）');

  // 阶段 4：回合自然结束 → 待发送列表按序消费（'排队消息' 作为新回合发送并跑完）。
  // 注意：等待「running=false 且 pending 空」而非单纯 running=false——turn 1 结束后
  // 循环立即消费 pending 起 turn 2，running=false 的瞬时窗口可能被跳过（回合流式耗时秒级，
  // 探针 10ms 轮询不会错过，但语义上「pending 空」才证明排队消息确实被消费）。
  await waitFor(
    '回合全部结束（排队消息已被消费并作为新回合发出）',
    () => state.running === false && state.pending.length === 0
  );
  console.log('[4] ✓ 回合结束后待发送列表按序消费（排队消息已发出并完成）');

  // 阶段 5：等待输入框 → 提交 /exit 正常退出
  await waitFor('输入框就绪（waitForSubmit）', () => fakeInput.onSubmit !== undefined);
  fakeInput.text = '/exit';
  fakeInput.onSubmit!();
  await Promise.race([
    interactiveP,
    wait(8000).then(() => {
      throw new Error('交互循环未在 /exit 后退出');
    }),
  ]);
  console.log('[5] ✓ /exit 正常退出交互循环');

  console.log('\n== 全部通过：运行中 / 命令立即分发（不进待发送列表）+ 排队消息按序消费 ==');
  process.exit(0);
}

void main();

/**
 * 探针：真实 runAgent 循环 + mock MOCK_MULTIREAD（第一轮并行 3 个 read_file）+ TuiOutput
 * 端到端——验证 loop 的 onToolStep(parsed.args) → TuiOutput 合并成一张卡（→ Read 3 files）
 * → onToolResult 填卡 → 帧内渲染。同一渲染路径（mountTree/repaintTree）。
 */
import OpenAI from 'openai';
import { spawn } from 'node:child_process';
import { createTestRenderer } from '@opentui/core/testing';
import { createTuiState } from '../../src/tui/state.js';
import { TuiOutput } from '../../src/tui/output.js';
import { runAgent } from '../../src/agent/loop.js';
import { mountTree, repaintTree } from '../../src/tui/render.js';
import type { RunOptions } from '../../src/agent/types.js';
import type { TuiSession } from '../../src/tui/render.js';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

const PORT = 8805;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(desc: string, cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${desc}`);
    await wait(10);
  }
}

function startMock(): Promise<void> {
  return new Promise((resolve) => {
    const p = spawn('bun', ['run', 'scripts/mock-server.mjs'], {
      env: { ...process.env, PORT: String(PORT), MOCK_MULTIREAD: '1', MOCK_STREAM: '1' },
      stdio: 'ignore',
    });
    setTimeout(resolve, 800);
    (p as unknown as { _keep?: boolean })._keep = true;
  });
}

async function main(): Promise<void> {
  await startMock();
  const client = new OpenAI({ apiKey: 'sk-mock', baseURL: `http://127.0.0.1:${PORT}/v1` });
  const state = createTuiState();
  const t = await createTestRenderer({ width: 64, height: 24 });
  const tree = mountTree(t.renderer, state, { withInput: true });
  await t.renderOnce();
  const session: TuiSession = {
    paint: async () => {
      repaintTree(t.renderer, tree, state, { withInput: true });
      await t.renderOnce();
    },
    input: undefined as never,
    onKeyPress: () => () => {},
  };
  const out = new TuiOutput(state, { showThinking: true }, session);
  const tools = [
    // 需含 run_command——mock 以「请求 tools 里无 run_command」识别 /plan 计划模式，
    // 只给 read_file 会误入 planMode 分支（不返回工具调用）
    { name: 'run_command', description: 'x', parameters: { type: 'object' as const, properties: {} }, execute: async () => '' },
    { name: 'read_file', description: 'x', parameters: { type: 'object' as const, properties: {} }, execute: async () => 'mock-read-content' },
  ];
  const runOpts: RunOptions = { tools, permission: 'full', context: { autoMemory: false } } as RunOptions;
  const messages: ChatCompletionMessageParam[] = [{ role: 'user', content: '读取几个文件' }];
  await runAgent(client, 'mock', messages, runOpts, out);

  // 3 个并行 read_file 应合并为 1 张卡片
  const cards = state.lines.filter((l) => l.kind === 'tool' && l.card);
  if (cards.length !== 1) throw new Error(`并行 3 读应合并为 1 张卡，实际 ${cards.length} 张`);
  const card = cards[0].card!;
  if (card.summary !== '→ Read 3 files') throw new Error(`合并卡标题错误: ${card.summary}`);
  if (!card.paths || card.paths.length !== 3) throw new Error(`paths 未收集: ${JSON.stringify(card.paths)}`);
  if (card.status !== 'ok') throw new Error(`合并卡未完成: ${card.status}`);
  // 步数统计按每次调用计（footer 3 步），但只 1 张卡
  if (state.stats.steps !== 3) throw new Error(`steps 应为 3（每次 read 计 1），实际 ${state.stats.steps}`);
  await wait(60);
  const frame = t.captureCharFrame();
  if (!frame.includes('→ Read 3 files') || frame.includes('📄')) {
    console.error('--- 帧内容 ---');
    console.error(frame);
    throw new Error('帧内无合并卡或残留旧格式');
  }
  console.log('[1] ✓ 真实循环 + mock 多读：3 个并行 read_file 合并为 1 张「→ Read 3 files」卡，steps=3');
  console.log('[2] ✓ 帧内渲染合并卡（无 📄 旧格式）');
  console.log('\n== 全部通过：loop → TuiOutput 多读合并端到端 ==');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

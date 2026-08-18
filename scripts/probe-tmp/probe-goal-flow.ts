/**
 * 探针：/goal 执行过程进对话流（第一百四十三次用户确认「完整过程进对话流」）。
 *
 *   A   e2e：TUI runCommand('/goal 完成部署') 分发 → 过程行（目标/推导/迭代/判定/达成）
 *        出现在 state.lines **对话流**（不再是命令面板）
 *   B   cmdPanel 自动收起（runCommand 开空面板 → 无输出 → 清空，不弹面板）
 *   C   最终收尾行（✅ 目标达成 + [目标达成：第 2 轮]）在对话流
 *   D   子代理事件照常走 onSubagentEvent（对话流 worker 卡片路径不被破坏）
 *   E   CLI console 端 /goal 直接打印过程（dim 行，终端流即对话流）
 *
 * 用法：npx tsx scripts/probe-tmp/probe-goal-flow.ts
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRun, attachRuntime, type RunContext } from '../../src/main.js';
import { ExecOutput } from '../../src/exec.js';
import { runCommand } from '../../src/tui/commands.js';
import { createTuiState, type TuiLine } from '../../src/tui/state.js';

const PORT = 8814;
const XDG = mkdtempSync(join(tmpdir(), 'omni-goal-flow-'));
process.env.XDG_CONFIG_HOME = XDG;
const ENV = {
  ...process.env,
  PORT: String(PORT),
  OMNI_BASE_URL: `http://127.0.0.1:${PORT}/v1`,
  OMNI_API_KEY: 'sk-mock',
  OMNI_MODEL: 'mock-model',
};
Object.assign(process.env, ENV);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function ok(cond: boolean, desc: string): void {
  console.log(`${cond ? '✅' : '❌'} ${desc}`);
  if (!cond) failed++;
}

let mockProc: ReturnType<typeof spawn> | null = null;
async function startMock(extra: Record<string, string> = {}): Promise<void> {
  mockProc?.kill();
  const env = { ...ENV, ...extra };
  mockProc = spawn('node', ['scripts/mock-server.mjs'], { env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const sock = connect(PORT, '127.0.0.1', () => { sock.destroy(); resolve(); });
        sock.on('error', reject);
      });
      return;
    } catch { /* mock 未起 */ }
    await wait(100);
  }
  throw new Error('mock server 启动超时');
}

async function makeCtx(): Promise<RunContext> {
  await startMock({ MOCK_GOAL_CHECKS: '0' });
  const ctx = prepareRun({});
  await attachRuntime(ctx, new ExecOutput(false));
  return ctx;
}

async function main(): Promise<void> {
  console.log(`XDG_CONFIG_HOME=${XDG}  PORT=${PORT}`);

  // ── A/C/D. TUI runCommand('/goal 完成部署')：过程进对话流 ─────────────
  {
    const ctx = await makeCtx();
    const state = createTuiState();
    let subagentEvts = 0;
    const cmdCtx = {
      state,
      out: { onSubagentEvent: () => { subagentEvts++; } },
      session: { paint: async () => {} },
      input: {},
      messages: [],
      client: ctx.client,
      model: ctx.cfg.model,
      runOpts: ctx.runOpts,
      subagents: ctx.runOpts.subagentDefs,
    };
    await runCommand(cmdCtx as never, '/goal 完成部署');

    const texts = state.lines.map((l: TuiLine) => l.text);
    const find = (frag: string): boolean => texts.some((t) => t.includes(frag));
    ok(find('🎯 目标：完成部署'), `A1 目标行在对话流（${JSON.stringify(texts.find((t) => t.includes('目标：')) ?? '无')}）`);
    ok(find('🧠 推导验收标准'), 'A2 推导验收标准行在对话流');
    ok(find('📋 验收标准：1) 功能完整可运行'), 'A3 验收标准条款行在对话流（流式累积）');
    ok(find('🔁 第 1/5 轮') && find('🔁 第 2/5 轮'), 'A4 迭代进度行在对话流');
    ok(find('🧪 验收判定（第 1 轮）：不满足：结果尚未完整'), 'A5 判定反馈行在对话流（流式累积）');
    ok(subagentEvts > 0, `D 子代理事件走 onSubagentEvent（${subagentEvts} 个，对话流卡片路径保留）`);
    ok(find('✅ 目标达成（第 2 轮）'), 'C1 达成收尾行在对话流');
    ok(find('[目标达成：第 2 轮]'), `C2 达成标记在对话流（${texts.find((t) => t.includes('目标达成')) ?? '无'}）`);

    // B. 面板自动收起：无面板 / 空面板（过程不进面板）
    const panel = state.cmdPanel;
    ok(panel === null || panel.lines.length === 0, `B cmdPanel 自动收起（panel=${JSON.stringify(panel?.lines)}）`);

    // C3. 负向：过程行不得残留「对话流污染」判断——panel 内零过程文本
    ok(!(panel && panel.lines.some((t) => t.includes('第 1/5 轮'))), 'B2 过程文本零泄漏进面板');
  }

  console.log(failed === 0 ? '\n🎉 全部通过' : `\n❌ ${failed} 项失败`);
  mockProc?.kill();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  mockProc?.kill();
  process.exit(1);
});
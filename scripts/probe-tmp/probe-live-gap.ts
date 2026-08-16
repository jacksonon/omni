/**
 * 探针：模拟真实 TuiOutput 事件流——工具执行后紧接着「思考中」（新一轮思考）与
 * 「执行中」（下一张 running 工具卡），检查与工具执行区域的间距。
 * 事件顺序：user → onRound(思考) → thinking 流 → onToolStep(卡1 running)
 * → onToolResult(卡1 ok) → onRound(思考中) → thinking 流 → onToolStep(卡2 running)
 */
import { createTestRenderer } from '@opentui/core/testing';
import { createTuiState } from '../../src/tui/state.js';
import { mountTree, repaintTree } from '../../src/tui/render.js';
import { TuiOutput } from '../../src/tui/output.js';

async function main(): Promise<void> {
  const t = await createTestRenderer({ width: 64, height: 30 });
  const s = createTuiState();
  const tree = mountTree(t.renderer, s, { withInput: true });
  const fakeSession = {
    paint: async () => {
      repaintTree(t.renderer, tree, s, { withInput: true });
      await t.renderOnce();
    },
    stop: async () => {},
    input: null,
    onKeyPress: () => () => {},
  };
  const out = new TuiOutput(s, { showThinking: true }, fakeSession as never);
  out.banner({ model: 'mock' } as never);
  out.onUserMessage('跑一下');
  out.onRound(0, 50);
  s.lines.push({ kind: 'thinking', text: '先分析任务，然后规划执行步骤。' });
  out.onToolStep(1, 50, 'run_command', '$ echo mock-ok', { command: 'echo mock-ok' });
  out.onToolResult(true, 8, ['mock-ok']);
  out.onRound(1, 50);
  s.lines.push({ kind: 'thinking', text: '命令执行成功，现在继续下一步。' });
  out.onToolStep(2, 50, 'run_command', '$ sleep 1', { command: 'sleep 1' });
  await out.flush();
  t.captureCharFrame().split('\n').forEach((l, i) => console.log(`${String(i).padStart(2)}: [${l}]`));
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

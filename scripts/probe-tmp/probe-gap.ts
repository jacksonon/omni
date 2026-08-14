import { createTestRenderer } from '@opentui/core/testing';
import { createTuiState, pushLine } from '../../src/tui/state.js';
import { mountTree, repaintTree } from '../../src/tui/render.js';

async function main(): Promise<void> {
  const t = await createTestRenderer({ width: 64, height: 30 });
  const s = createTuiState();
  pushLine(s, { kind: 'user', text: '你好' });
  pushLine(s, { kind: 'thinking', text: '我需要先分析任务，然后规划执行步骤。' });
  pushLine(s, {
    kind: 'tool',
    card: { id: 1, name: 'run_command', summary: '$ echo mock-ok', status: 'ok', output: [], expanded: false },
  });
  pushLine(s, { kind: 'thinking', text: '命令执行成功，现在总结结果。' });
  pushLine(s, { kind: 'answer', text: '任务完成。' });
  const tree = mountTree(t.renderer, s, { withInput: true });
  repaintTree(t.renderer, tree, s, { withInput: true });
  await t.renderOnce();
  t.captureCharFrame().split('\n').forEach((l, i) => console.log(`${String(i).padStart(2)}: [${l}]`));
  process.exit(0);
}
main();

/** 探针：单任务模式（无输入框）——工具卡片后状态栏「执行中…」与卡片之间的间距 */
import { createTestRenderer } from '@opentui/core/testing';
import { createTuiState, pushLine } from '../../src/tui/state.js';
import { mountTree, repaintTree } from '../../src/tui/render.js';

async function main(): Promise<void> {
  const t = await createTestRenderer({ width: 64, height: 20 });
  const s = createTuiState();
  s.status = '⠋ 执行中…';
  pushLine(s, {
    kind: 'tool',
    card: { id: 1, name: 'run_command', summary: '$ sleep 1', status: 'running', output: [], expanded: false },
  });
  const tree = mountTree(t.renderer, s, { withInput: false });
  repaintTree(t.renderer, tree, s, { withInput: false });
  await t.renderOnce();
  t.captureCharFrame().split('\n').forEach((l, i) => console.log(`${String(i).padStart(2)}: [${l}]`));
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

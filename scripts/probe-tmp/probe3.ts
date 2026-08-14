import { createTestRenderer } from '@opentui/core/testing';
import { mountTree, repaintTree } from '../../src/tui/render.js';
import { createTuiState, pushLine } from '../../src/tui/state.js';

async function main(): Promise<void> {
  const s = createTuiState();
  s.version = '0.1.0';
  s.model = 'mock';
  pushLine(s, { kind: 'user', text: '你好' });
  const t = await createTestRenderer({ width: 64, height: 20 });
  const tree = mountTree(t.renderer, s, { withInput: true });
  await t.renderOnce();
  console.log('--- 当前（inputLines+2）---');
  console.log(t.captureCharFrame());

  // 方案：content = inputLines+4，marginTop:-1，marginBottom:-1
  (tree.blueLine as unknown as { content: string }).content = '▍\n▍\n▍\n▍\n▍';
  (tree.blueLine as unknown as { marginTop: number }).marginTop = -1;
  (tree.blueLine as unknown as { marginBottom: number }).marginBottom = -1;
  await t.renderOnce();
  console.log('--- 负 margin 全高（inputLines+4=5）---');
  console.log(t.captureCharFrame());

  // 增高输入 → 7 行
  tree.input?.setText('第一行\n第二行\n第三行');
  (tree.blueLine as unknown as { content: string }).content = '▍\n▍\n▍\n▍\n▍\n▍\n▍';
  await t.renderOnce();
  console.log('--- 增高后（7 行）---');
  console.log(t.captureCharFrame());
}

void main();
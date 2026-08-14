/**
 * 探针：查看灰色块（输入区域）帧级渲染，确认蓝色细线当前高度是否撑满灰色背景。
 */
import { createTestRenderer } from '@opentui/core/testing';
import { createTuiState } from '../../src/tui/state.js';
import { mountTree, repaintTree } from '../../src/tui/render.js';

async function main() {
  const t = await createTestRenderer({ width: 60, height: 24 });
  const s = createTuiState();
  s.model = 'grok-4.5';
  s.reasoningEffort = 'medium';
  const tree = mountTree(t.renderer, s, { withInput: true });
  await t.renderOnce();
  const frame = t.captureCharFrame();
  const lines = frame.split('\n');
  console.log('=== 当前帧（inputLines=1）===');
  lines.forEach((l, i) => console.log(`${String(i).padStart(2)}: ${l}`));

  const greyStart = lines.findIndex((l) => l.includes('╮'));
  const greyEnd = lines.findIndex((l) => l.includes('╰'));
  console.log(`\n灰色块顶行=${greyStart} 底行=${greyEnd} 总高=${greyEnd - greyStart + 1}`);
  const barRows = lines.slice(greyStart, greyEnd + 1).filter((l) => l.trimStart().startsWith('▍'));
  console.log(`蓝线覆盖行数=${barRows.length}（应 = 灰块总高）`);

  tree.input?.setText('第一行\n第二行\n第三行');
  repaintTree(t.renderer, tree, s, { withInput: true });
  await t.renderOnce();
  const frame2 = t.captureCharFrame();
  const lines2 = frame2.split('\n');
  console.log('\n=== 增高帧（inputLines=3）===');
  lines2.forEach((l, i) => console.log(`${String(i).padStart(2)}: ${l}`));
  const gs2 = lines2.findIndex((l) => l.includes('╮'));
  const ge2 = lines2.findIndex((l) => l.includes('╰'));
  const bar2 = lines2.slice(gs2, ge2 + 1).filter((l) => l.trimStart().startsWith('▍')).length;
  console.log(`灰块总高=${ge2 - gs2 + 1} 蓝线覆盖行数=${bar2}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

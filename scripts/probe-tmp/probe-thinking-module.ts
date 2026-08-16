/** 探针：思考模块展开态——`- thinking · 思考时间` 头行 + 内容；点击收起/展开双向切换 */
import { createTestRenderer } from '@opentui/core/testing';
import { createTuiState } from '../../src/tui/state.js';
import { mountTree, repaintTree } from '../../src/tui/render.js';
import { TuiOutput } from '../../src/tui/output.js';
import { computeRows, hitTestThinking } from '../../src/tui/rows.js';

async function main(): Promise<void> {
  const t = await createTestRenderer({ width: 64, height: 24 });
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
  out.onUserMessage('你好');
  out.onRound(0, 50); // 真实循环每轮调用：启动 spinner 定时器（头行 loading 随帧动画）
  await new Promise((r) => setTimeout(r, 600));
  await out.flush();
  console.log('=== 收到消息 onRound 后（未收流式 chunk）：应立即显示 thinking 头行 ===');
  t.captureCharFrame().split('\n').slice(0, 7).forEach((l, i) => console.log(`${i}: [${l}]`));
  out.thinking.write('先分析任务');
  await new Promise((r) => setTimeout(r, 1200));
  out.thinking.write('，再规划步骤');
  await out.flush();
  console.log('=== 思考中（头行应为 ⠋ thinking · 实时耗时；状态栏应空）===');
  t.captureCharFrame().split('\n').slice(0, 7).forEach((l, i) => console.log(`${i}: [${l}]`));
  out.thinking.finish();
  await out.flush();
  console.log('=== 思考完（头行应为 - thinking · 耗时）===');
  t.captureCharFrame().split('\n').slice(0, 7).forEach((l, i) => console.log(`${i}: [${l}]`));
  const rows = computeRows(s, { height: 24, width: 64 }, { withInput: true });
  const rects = new Map<number, number>();
  rows.forEach((r, i) => {
    if (r.thinkingIdx !== undefined) rects.set(i, r.thinkingIdx);
  });
  const headerRow = rows.findIndex((r) => r.text.includes('- thinking'));
  const li = rows[headerRow]!.thinkingIdx!;
  console.log(`头行: ${JSON.stringify(rows[headerRow]!.text)} (li=${li})`);
  // 点击头行 → 收起
  hitTestThinking(s, rects, headerRow);
  const rows2 = computeRows(s, { height: 24, width: 64 }, { withInput: true });
  console.log(`点击后: ${JSON.stringify(rows2.filter((r) => r.thinkingIdx !== undefined).map((r) => r.text))}`);
  if (!rows2.some((r) => r.text.trim() === '+ thinking')) throw new Error('展开态点击未收起为 + thinking');
  // 再点击 + thinking → 展开
  const sumRow = rows2.findIndex((r) => r.text.trim() === '+ thinking');
  hitTestThinking(s, rects, sumRow);
  const rows3 = computeRows(s, { height: 24, width: 64 }, { withInput: true });
  console.log(`再点击后: ${JSON.stringify(rows3.filter((r) => r.thinkingIdx !== undefined).map((r) => r.text))}`);
  if (!rows3.some((r) => r.text.includes('- thinking'))) throw new Error('+ thinking 点击未重新展开');
  console.log('\n✓ 全部通过');
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

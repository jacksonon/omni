/** 探针：通过 OpenTUI 真实鼠标派发管线（mockMouse → stdin SGR → 命中 → 冒泡到根 Box）
 * 验证 thinking 点击收起 → 再点击展开。
 *
 * 与 startTui 相同的方式挂 handler：实例属性遮蔽原型 onMouseEvent；
 * mockMouse.click(x, y) 走完整管线，y 为 0-based 事件坐标（= thinkingRects 的键）。
 */
import { createTestRenderer } from '@opentui/core/testing';
import { createTuiState } from '../../src/tui/state.js';
import { mountTree, repaintTree, type TuiSession } from '../../src/tui/render.js';
import { TuiOutput } from '../../src/tui/output.js';

async function main(): Promise<void> {
  const t = await createTestRenderer({ width: 64, height: 24 });
  const s = createTuiState();
  const tree = mountTree(t.renderer, s, { withInput: true });
  const fakeSession: TuiSession = {
    paint: async () => {
      repaintTree(t.renderer, tree, s, { withInput: true });
      await t.renderOnce();
    },
    stop: async () => {},
    input: null,
    onKeyPress: () => () => {},
  };
  const out = new TuiOutput(s, { showThinking: true }, fakeSession);
  out.banner({ model: 'mock' } as never);
  out.onUserMessage('你好');
  out.onRound(0, 50);
  out.thinking.write('先分析任务，再规划步骤');
  out.thinking.finish();
  await out.flush();

  // 与 startTui 相同：实例属性遮蔽原型 onMouseEvent（render.ts:1002 的同一逻辑）
  const { hitTestApproval, hitTestCard, hitTestThinking } = await import('../../src/tui/render.js');
  (tree.root as unknown as { onMouseEvent?: (e: unknown) => void }).onMouseEvent = (e: unknown) => {
    const ev = e as { type?: string; button?: number; x?: number; y?: number };
    if (ev.type === 'down' && ev.button === 0 && typeof ev.y === 'number') {
      if (hitTestApproval(s, tree.approvalRect, ev.y)) {
        void fakeSession.paint();
        return;
      }
      const picker = s.cmdSuggest ?? s.mention;
      if (picker && tree.suggestRect && tree.input) {
        void fakeSession.paint();
        return;
      }
      if (s.pending.length > 0 && tree.pendingRects.get(ev.y) !== undefined) {
        void fakeSession.paint();
        return;
      }
      if (hitTestThinking(s, tree.thinkingRects, ev.y)) void fakeSession.paint();
      else if (hitTestCard(s, tree.cardRects, ev.y)) void fakeSession.paint();
    }
  };

  const dump = (label: string): void => {
    console.log(`=== ${label} ===`);
    t.captureCharFrame()
      .split('\n')
      .slice(0, 6)
      .forEach((l, i) => console.log(`${i}: [${l}]`));
    console.log('thinkingRects:', JSON.stringify([...tree.thinkingRects]));
  };

  dump('思考完（展开态）');

  // 真实点击：mockMouse 走完整 stdin SGR 管线。y = 0-based 事件坐标（= thinkingRects 键）
  // 场景一 a：点击**内容行**（非头行）收起——展开态内容行也带 thinkingIdx，同样可点击
  const contentY = [...tree.thinkingRects.keys()][1];
  console.log(`\n点击内容行 y=${contentY}（收起）`);
  await t.mockMouse.click(10, contentY);
  await fakeSession.paint();
  dump('点击内容行后（应为 + thinking）');
  console.log('collapsedThinking:', JSON.stringify([...s.collapsedThinking]));
  if (s.collapsedThinking.size === 0) {
    console.error('✗ 点击内容行未收起');
    process.exit(1);
  }

  // 再点击 + thinking 行（展开）
  const collapsedY = [...tree.thinkingRects.keys()][0];
  console.log(`\n点击 + thinking y=${collapsedY}（展开）`);
  await t.mockMouse.click(10, collapsedY);
  await fakeSession.paint();
  dump('再点击后（应恢复 - thinking + 内容）');
  console.log('collapsedThinking:', JSON.stringify([...s.collapsedThinking]));
  if (s.collapsedThinking.size !== 0) {
    console.error('✗ 点击 + thinking 后未重新展开（collapsedThinking 仍非空）');
    process.exit(1);
  }
  console.log('\n✓ 场景一通过：OpenTUI 真实鼠标管线派发下收起后可再展开');

  // --- 场景二：流式中途收起（thinkingRunning），finish 后点击展开 ---
  const s2 = createTuiState();
  const t2 = await createTestRenderer({ width: 64, height: 24 });
  const tree2 = mountTree(t2.renderer, s2, { withInput: true });
  const sess2: TuiSession = {
    paint: async () => {
      repaintTree(t2.renderer, tree2, s2, { withInput: true });
      await t2.renderOnce();
    },
    stop: async () => {},
    input: null,
    onKeyPress: () => () => {},
  };
  const out2 = new TuiOutput(s2, { showThinking: true }, sess2);
  out2.onUserMessage('你好');
  out2.onRound(0, 50);
  out2.thinking.write('开始');
  await out2.flush();
  (tree2.root as unknown as { onMouseEvent?: (e: unknown) => void }).onMouseEvent = (e: unknown) => {
    const ev = e as { type?: string; button?: number; x?: number; y?: number };
    if (ev.type === 'down' && ev.button === 0 && typeof ev.y === 'number') {
      if (hitTestApproval(s2, tree2.approvalRect, ev.y)) {
        void sess2.paint();
        return;
      }
      const picker = s2.cmdSuggest ?? s2.mention;
      if (picker && tree2.suggestRect && tree2.input) {
        void sess2.paint();
        return;
      }
      if (s2.pending.length > 0 && tree2.pendingRects.get(ev.y) !== undefined) {
        void sess2.paint();
        return;
      }
      if (hitTestThinking(s2, tree2.thinkingRects, ev.y)) void sess2.paint();
      else if (hitTestCard(s2, tree2.cardRects, ev.y)) void sess2.paint();
    }
  };
  // 流式中点击头行收起
  const hdrY2 = [...tree2.thinkingRects.keys()][0];
  console.log(`\n场景二：流式中点击头行 y=${hdrY2} 收起`);
  await t2.mockMouse.click(10, hdrY2);
  await sess2.paint();
  console.log('收起后 collapsedThinking:', JSON.stringify([...s2.collapsedThinking]));
  // 更多 chunk 到达（thinkingRunning 仍 true，appendLine 继续）
  out2.thinking.write('，再规划步骤');
  await out2.flush();
  console.log('chunk 后 collapsedThinking:', JSON.stringify([...s2.collapsedThinking]));
  console.log('chunk 后 thinkingRects:', JSON.stringify([...tree2.thinkingRects]));
  // 未 finish 即点击 + thinking 展开（真实用户可能在思考未结束时就想展开）
  const cY2 = [...tree2.thinkingRects.keys()][0];
  console.log(`未 finish 点击 + thinking y=${cY2}（展开）`);
  await t2.mockMouse.click(10, cY2);
  await sess2.paint();
  console.log('再点击后 collapsedThinking:', JSON.stringify([...s2.collapsedThinking]));
  const frame2 = t2.captureCharFrame().split('\n').slice(0, 6);
  frame2.forEach((l, i) => console.log(`${i}: [${l}]`));
  if (s2.collapsedThinking.size !== 0) {
    console.error('✗ 流式中途收起后无法再展开');
    process.exit(1);
  }
  // finish 后状态保持展开
  out2.thinking.finish();
  await out2.flush();
  console.log('finish 后 collapsedThinking:', JSON.stringify([...s2.collapsedThinking]));
  const frame3 = t2.captureCharFrame().split('\n').slice(0, 6);
  frame3.forEach((l, i) => console.log(`${i}: [${l}]`));
  console.log('\n✓ 场景二通过：流式中途收起→chunk 继续→未 finish 点击展开→finish 保持展开');
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

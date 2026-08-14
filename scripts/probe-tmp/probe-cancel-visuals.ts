/**
 * 探针：ESC //stop 取消链路——cancelVisuals() 立即停右侧 loading + 状态栏
 * spinner/文案（不等 runAgent 返回）；onTurnEnd 兜底清理（思考中阶段被取消时
 * 状态栏「⠋ 思考中」残留问题）。
 */
import { createTestRenderer } from '@opentui/core/testing';
import { SPINNER_FRAMES, createTuiState } from '../../src/tui/state.js';
import { mountTree, repaintTree } from '../../src/tui/render.js';
import { TuiOutput } from '../../src/tui/output.js';

async function main(): Promise<void> {
  const t = await createTestRenderer({ width: 60, height: 24 });
  const s = createTuiState();
  const tree = mountTree(t.renderer, s, { withInput: true });
  const out = new TuiOutput(s, { showThinking: true }, {
    paint: async () => { repaintTree(t.renderer, tree, s, { withInput: true }); await t.renderOnce(); },
  } as never);

  // 模拟「思考中阶段被取消」：onRound 设了状态栏 ⠋ 思考中 + spinner，loading 在转
  out.startLoading();
  s.spinnerIndex = 0;
  s.status = `${SPINNER_FRAMES[0]} 思考中`;
  out.startLoading();
  await out.flush();
  const frame1 = t.captureCharFrame();
  if (!frame1.includes(SPINNER_FRAMES[0]) || !frame1.includes('思考中')) {
    throw new Error('前置失败：状态栏应显示 ⠋ 思考中');
  }
  console.log('✓ 前置：思考中阶段（状态栏 ⠋ 思考中 + 右侧 loading）');

  // ESC → cancelVisuals()：loading/状态栏立即清空（不等 runAgent 返回）
  out.cancelVisuals();
  await out.flush();
  const frame2 = t.captureCharFrame();
  if (s.loading || s.loadingIndex !== -1) throw new Error('cancelVisuals: loading 未停');
  if (s.status !== '' || s.spinnerIndex !== -1) throw new Error(`cancelVisuals: 状态栏未清空 status=${JSON.stringify(s.status)}`);
  if (frame2.includes('思考中') || frame2.includes('esc')) {
    console.error('cancelVisuals: 帧内仍含 思考中/esc');
    console.log(frame2);
    process.exit(1);
  }
  console.log('✓ cancelVisuals：loading + 状态栏「思考中」立即消失（不等 runAgent 返回）');

  // onTurnEnd 兜底：模拟再次思考中后直接 onTurnEnd（无 onStreamStart 清空）
  out.startLoading();
  s.spinnerIndex = 0;
  s.status = `${SPINNER_FRAMES[0]} 思考中`;
  out.onTurnEnd();
  await out.flush();
  if (s.status !== '' || s.spinnerIndex !== -1 || s.loading) {
    throw new Error(`onTurnEnd 兜底清理失败 status=${JSON.stringify(s.status)} loading=${s.loading}`);
  }
  console.log('✓ onTurnEnd 兜底：思考中阶段结束后状态栏/loading 清空（残留 bug 修复）');

  console.log('\n== 全部通过：Esc //stop 取消立即停 loading + 状态栏，onTurnEnd 兜底 ==');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });

/**
 * 探针：验证输入区域**外部** loading——灰色块下方统计行（statusLine 同一行）最左侧；
 * 会话进行中（state.loading=true）显示旋转帧（loadingIndex 推进换帧），
 * Esc/会话结束（state.loading=false）消失；输入增高（inputLines 变化）时灰块增高不受影响。
 * 运行：bun run scripts/probe-tmp/probe-loading.ts
 */
import { createTestRenderer } from '@opentui/core/testing';
import { mountTree, repaintTree } from '../../src/tui/render.js';
import { createTuiState, pushLine, SPINNER_FRAMES, type TuiState } from '../../src/tui/state.js';

async function main(): Promise<void> {
  const t = await createTestRenderer({ width: 60, height: 24 });
  const s = createTuiState();
  s.model = 'grok-4.5';
  s.reasoningEffort = 'medium';
  pushLine(s, { kind: 'user', text: '你好' }); // 有会话内容 → 非 hero 模式（hero 隐藏统计行）
  const tree = mountTree(t.renderer, s, { withInput: true });

  // 帧辅助：定位模型行 / 统计行 / loading 字符行
  const inspect = async (label: string): Promise<{ modelY: number; statsY: number; loadY: number; loadChar: string }> => {
    repaintTree(t.renderer, tree, s, { withInput: true });
    await t.renderOnce();
    const frame = t.captureCharFrame().split('\n');
    let modelY = -1;
    let statsY = -1;
    let loadY = -1;
    let loadChar = '';
    frame.forEach((l, i) => {
      if (l.includes('grok-4.5')) modelY = i;
      if (l.includes('首 token')) statsY = i;
      for (const f of SPINNER_FRAMES) {
        if (l.includes(f)) {
          loadY = i;
          loadChar = f;
        }
      }
    });
    console.log(`[${label}] 模型行 y=${modelY} · 统计行 y=${statsY} · loading 行 y=${loadY} char=${loadChar || '（无）'}`);
    return { modelY, statsY, loadY, loadChar };
  };

  // a) 初始：未运行 → 无 loading
  let r = await inspect('未运行');
  if (r.loadY >= 0) throw new Error('a: 未运行不应显示 loading');
  if (r.modelY < 0) throw new Error('a: 未找到模型行');
  console.log('✓ a：未运行无 loading');

  // b) 会话进行中：loading 出现在**统计行**（输入区域外部、与 statusLine 同一行）
  s.loading = true;
  s.loadingIndex = 0;
  r = await inspect('运行中 帧0');
  if (r.loadY !== r.statsY || r.statsY <= r.modelY) throw new Error(`b: loading 应在统计行（输入区域外部；model=${r.modelY} stats=${r.statsY} load=${r.loadY}）`);
  if (r.loadChar !== SPINNER_FRAMES[0]) throw new Error(`b: 帧 0 应为 ${SPINNER_FRAMES[0]}`);
  console.log(`✓ b：运行中 loading 位于统计行最左侧（y=${r.statsY}，灰色块下方）`);

  // c) 帧推进：loadingIndex=3 → 显示对应帧（动画旋转）
  s.loadingIndex = 3;
  r = await inspect('运行中 帧3');
  if (r.loadChar !== SPINNER_FRAMES[3]) throw new Error(`c: 帧 3 应为 ${SPINNER_FRAMES[3]}，实际 ${r.loadChar}`);
  console.log(`✓ c：帧推进换帧（${SPINNER_FRAMES[3]}）`);

  // d) Esc/会话结束：loading=false → 消失
  s.loading = false;
  s.loadingIndex = -1;
  r = await inspect('结束后');
  if (r.loadY >= 0) throw new Error('d: 结束后 loading 应消失');
  console.log('✓ d：Esc/会话结束 loading 消失');

  // e) 输入增高 3 行：灰块增高下移，loading 仍在统计行（跟随底部，但不在灰块内）
  tree.input?.setText('第一行\n第二行\n第三行');
  s.loading = true;
  s.loadingIndex = 1;
  r = await inspect('增高后');
  if (r.loadY !== r.statsY) throw new Error(`e: 增高后 loading 仍应在统计行（model=${r.modelY} stats=${r.statsY} load=${r.loadY}）`);
  console.log(`✓ e：输入增高 3 行后 loading 仍在统计行（y=${r.statsY}）`);

  // f) loading 位置应在统计行最左侧（统计文本之前）
  repaintTree(t.renderer, tree, s, { withInput: true });
  await t.renderOnce();
  const fframe = t.captureCharFrame().split('\n');
  const statsLine = fframe[r.statsY]!;
  const statsIdx = statsLine.indexOf('首 token');
  const loadIdx = statsLine.indexOf(SPINNER_FRAMES[1]);
  console.log(`[f] 统计文本 x=${statsIdx} · loading x=${loadIdx}`);
  if (loadIdx < 0 || loadIdx >= statsIdx) throw new Error('f: loading 应在统计行最左侧（统计文本之前）');
  console.log('✓ f：loading 位于统计行最左侧（输入区域外部、左下侧）');

  // g) loading 右侧「esc」取消提示：运行中显示、结束后消失（跟随 loading）
  const escText = (t: unknown): string => {
    const c = (t as { content?: unknown }).content;
    const chunks = (c as { chunks?: { text: string }[] })?.chunks;
    return (chunks ?? []).map((ch) => ch.text).join('');
  };
  if (!tree.footerEsc) throw new Error('g: footerEsc 节点未创建');
  // 当前 loading=true（e 段留下）→ esc 应显示
  repaintTree(t.renderer, tree, s, { withInput: true });
  await t.renderOnce();
  const frameG = t.captureCharFrame().split('\n');
  const loadLineG = frameG.find((l) => l.includes(SPINNER_FRAMES[1]));
  if (escText(tree.footerEsc) !== 'esc') throw new Error(`g: footerEsc 内容应为 esc: ${JSON.stringify(escText(tree.footerEsc))}`);
  if (!loadLineG || !loadLineG.includes('esc')) throw new Error(`g: loading 行应含 esc 提示: ${JSON.stringify(loadLineG)}`);
  if (loadLineG.indexOf(SPINNER_FRAMES[1]) > loadLineG.indexOf('esc')) throw new Error('g: esc 应在 loading 右侧');
  console.log(`✓ g：loading 右侧显示 esc 提示（${JSON.stringify(loadLineG.trim().slice(-14))}）`);
  s.loading = false;
  s.loadingIndex = -1;
  repaintTree(t.renderer, tree, s, { withInput: true });
  await t.renderOnce();
  if (escText(tree.footerEsc) !== '') throw new Error('g2: 结束后 esc 提示应消失');
  console.log('✓ g2：esc 提示跟随 loading 消失');

  console.log('\n== 全部通过：loading+esc 在输入区域外部、统计行最左侧（与 statusLine 一行），运行中转圈、结束消失 ==');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
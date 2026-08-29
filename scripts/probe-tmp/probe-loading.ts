/**
 * 探针：验证 loading/esc 显示在**模型行内、思考级别右侧**（用户要求「loading esc
 * 放到输入区域模型思考级别右侧」）；会话进行中（state.loading=true）显示旋转帧 +
 * esc，Esc/会话结束（state.loading=false）消失；输入增高（inputLines 变化）时
 * loading 仍跟随模型行、灰块增高不受影响。
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

  // b) 会话进行中：loading 出现在**模型行**（思考级别右侧、灰色块内）
  s.loading = true;
  s.loadingIndex = 0;
  r = await inspect('运行中 帧0');
  if (r.loadY !== r.modelY) throw new Error(`b: loading 应在模型行（思考级别右侧；model=${r.modelY} stats=${r.statsY} load=${r.loadY}）`);
  if (r.loadChar !== SPINNER_FRAMES[0]) throw new Error(`b: 帧 0 应为 ${SPINNER_FRAMES[0]}`);
  console.log(`✓ b：运行中 loading 位于模型行内（y=${r.modelY}）`);

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

  // e) 输入增高 3 行：灰块增高下移，loading 仍在模型行（跟随底部）
  tree.input?.setText('第一行\n第二行\n第三行');
  s.loading = true;
  s.loadingIndex = 1;
  r = await inspect('增高后');
  if (r.loadY !== r.modelY) throw new Error(`e: 增高后 loading 仍应在模型行（model=${r.modelY} load=${r.loadY}）`);
  console.log(`✓ e：输入增高 3 行后 loading 仍在模型行（y=${r.modelY}）`);

  // f) loading 位于模型行内、且在模型文本/思考级别**之后**
  repaintTree(t.renderer, tree, s, { withInput: true });
  await t.renderOnce();
  const fframe = t.captureCharFrame().split('\n');
  const modelLine = fframe[r.modelY]!;
  const modelIdx = modelLine.indexOf('grok-4.5');
  const loadIdx = modelLine.indexOf(SPINNER_FRAMES[1]);
  console.log(`[f] 模型文本 x=${modelIdx} · loading x=${loadIdx}`);
  if (loadIdx < 0 || loadIdx <= modelIdx) throw new Error('f: loading 应在模型行、模型文本之后');
  console.log('✓ f：loading 位于模型行、模型文本右侧（思考级别位置）');

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
  if (escText(tree.footerEsc) !== 'esc interrupt') throw new Error(`g: footerEsc 内容应为 esc interrupt: ${JSON.stringify(escText(tree.footerEsc))}`);
  if (!loadLineG || !loadLineG.includes('esc interrupt')) throw new Error(`g: loading 行应含 esc interrupt 提示: ${JSON.stringify(loadLineG)}`);
  if (loadLineG.indexOf(SPINNER_FRAMES[1]) > loadLineG.indexOf('esc interrupt')) throw new Error('g: esc interrupt 应在 loading 右侧');
  // loading 与思考级别之间的「·」分隔符：只在 loading 显示时出现（· ⠹ esc interrupt 顺序）
  const sepIdxG = loadLineG.indexOf('·');
  const spinIdxG = loadLineG.indexOf(SPINNER_FRAMES[1]);
  const escIdxG = loadLineG.indexOf('esc interrupt');
  if (sepIdxG < 0 || !(sepIdxG < spinIdxG && spinIdxG < escIdxG)) throw new Error(`g: 「· ⠹ esc interrupt」顺序异常: ${JSON.stringify(loadLineG)}`);
  console.log(`✓ g：loading 右侧显示 esc interrupt 提示（${JSON.stringify(loadLineG.trim().slice(-18))}）`);
  s.loading = false;
  s.loadingIndex = -1;
  repaintTree(t.renderer, tree, s, { withInput: true });
  await t.renderOnce();
  if (escText(tree.footerEsc) !== '') throw new Error('g2: 结束后 esc 提示应消失');
  console.log('✓ g2：esc 提示跟随 loading 消失');

  console.log('\n== 全部通过：loading+esc 在模型行、思考级别右侧，运行中转圈、结束消失 ==');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
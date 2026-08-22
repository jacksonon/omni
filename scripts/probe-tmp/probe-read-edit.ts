/**
 * 探针：验证 read_file 并行多读合并（TuiOutput.onToolStep 事件级）+ write_file diff 数据链路。
 * 驱动真实 TuiOutput → state → mountTree/repaintTree（同一渲染路径），帧级断言：
 * ① 3 条并行 read_file 只产生 1 张卡片（→ Read 3 files，paths 逐条）；
 * ② 收起态 read 卡片只一行（无执行/结果缩略行）；
 * ③ 展开合并卡显示 ⤷ 路径逐条；
 * ④ write_file onToolResult 带 detail.diff → 卡片 diff 落位，收起态显示改动摘要；
 * ⑤ 展开后 diff 行渲染（│ 分隔 + 左红右绿 chunk）。
 */
import { createTestRenderer } from '@opentui/core/testing';
import { createTuiState } from '../../src/tui/state.js';
import { TuiOutput } from '../../src/tui/output.js';
import { mountTree, repaintTree } from '../../src/tui/render.js';
import { hitTestCard } from '../../src/tui/render.js';
import type { TuiSession } from '../../src/tui/render.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const state = createTuiState();
  const t = await createTestRenderer({ width: 64, height: 24 });
  const tree = mountTree(t.renderer, state, { withInput: true });
  await t.renderOnce();
  const session: TuiSession = {
    paint: async () => {
      repaintTree(t.renderer, tree, state, { withInput: true });
      await t.renderOnce();
    },
    input: undefined as never,
    onKeyPress: () => () => {},
  };
  const out = new TuiOutput(state, { showThinking: true }, session);
  const grab = () => t.captureCharFrame();

  // ① 3 条并行 read_file → 合并成 1 张卡片（不新建）
  out.onToolStep(1, 10, 'read_file', '→ Read a.ts', { path: 'a.ts' });
  out.onToolStep(2, 10, 'read_file', '→ Read b.ts', { path: 'b.ts' });
  out.onToolStep(3, 10, 'read_file', '→ Read c.ts', { path: 'c.ts' });
  await wait(60);
  const toolLines = state.lines.filter((l) => l.kind === 'tool');
  if (toolLines.length !== 1) {
    throw new Error(`并行 3 读应合并为 1 张卡片，实际 ${toolLines.length} 张`);
  }
  const merged = toolLines[0].card!;
  if (merged.summary !== '→ Read 3 files') {
    throw new Error(`合并卡标题错误: ${merged.summary}`);
  }
  if (!merged.paths || merged.paths.join(',') !== 'a.ts,b.ts,c.ts') {
    throw new Error(`paths 未逐条收集: ${JSON.stringify(merged.paths)}`);
  }
  let frame = grab();
  if (!frame.includes('→ Read 3 files') || frame.includes('📄')) {
    console.error('--- 帧内容 ---');
    console.error(frame);
    throw new Error('帧内无「→ Read 3 files」或残留 📄 旧格式');
  }
  // 收起态 read：只有 top/cmd/bottom 三行（无「执行成功」缩略行）
  if (frame.includes('执行成功')) {
    throw new Error('read 收起态不应有执行缩略行');
  }
  console.log('[1] ✓ 并行 3 读合并为 1 张卡片：帧内「→ Read 3 files」、无 📄 旧格式、无执行缩略行');

  // ② 结果到达：首个 onToolResult 填入合并卡（后续自然跳过），状态 ok
  out.onToolResult(true, 5, ['a 内容']);
  out.onToolResult(true, 5, ['b 内容']);
  out.onToolResult(true, 5, ['c 内容']);
  await wait(60);
  if (merged.status !== 'ok' || merged.chars !== 5) {
    throw new Error(`合并卡结果未填入: status=${merged.status} chars=${merged.chars}`);
  }
  console.log('[2] ✓ 多读结果：首个 onToolResult 填卡，其余跳过，无多余卡片');

  // ③ 点击展开合并卡 → ⤷ 路径逐条 + 预览（点击后需 paint——真实流程由 mouse handler 触发）
  const rectM = tree.cardRects.get(merged.id);
  if (!rectM) throw new Error('合并卡 rect 缺失');
  hitTestCard(state, tree.cardRects, rectM.top);
  await session.paint();
  await wait(60);
  frame = grab();
  if (!frame.includes('⤷ a.ts') || !frame.includes('⤷ b.ts') || !frame.includes('⤷ c.ts')) {
    console.error('--- 帧内容（⤷ 缺失）---');
    console.error(frame);
    throw new Error('展开态缺 ⤷ 路径逐条');
  }
  console.log('[3] ✓ 点击展开合并卡：⤷ a.ts / ⤷ b.ts / ⤷ c.ts 逐条渲染');

  // ④ write_file + diff：新卡（不合并——非 read_file），结果带 detail.diff
  out.onToolStep(4, 10, 'write_file', '✏️ old.txt', { path: 'old.txt', content: 'a\nx\nc\nd' });
  out.onToolResult(true, 8, ['写入成功'], {
    diff: { path: 'old.txt', original: 'a\nb\nc', content: 'a\nx\nc\nd' },
  });
  await wait(60);
  const writeCard = state.lines.filter((l) => l.kind === 'tool').at(-1)!.card!;
  if (!writeCard.diff || writeCard.diff.original !== 'a\nb\nc') {
    throw new Error(`write_file 卡片未落位 diff: ${JSON.stringify(writeCard.diff)}`);
  }
  frame = grab();
  // 收起态（opencode 风格）：命令 + 变更统计（+A −D 行），无执行缩略
  if (!frame.includes('✏️ old.txt') || !frame.includes('修改 · +2 −1 行') || frame.includes('执行成功')) {
    console.error('--- 帧内容（收起态应显示命令+变更统计）---');
    console.error(frame);
    throw new Error('write 收起态应显示命令 + 变更统计（+A −D 行）');
  }
  console.log('[4] ✓ write_file 卡片带 diff：收起态命令 + 变更统计（+A −D 行）');

  // ⑤ 展开 write 卡 → diff 行（│ 分隔 + 行宽）渲染
  const rectW = tree.cardRects.get(writeCard.id);
  if (!rectW) throw new Error('write 卡 rect 缺失');
  hitTestCard(state, tree.cardRects, rectW.top);
  await session.paint();
  await wait(60);
  frame = grab();
  if (!frame.includes('│') || !frame.includes('修改对比')) {
    console.error('--- 帧内容（diff 行缺失）---');
    console.error(frame);
    throw new Error('展开态缺 diff 行/│ 分隔');
  }
  console.log('[5] ✓ 展开 write 卡：修改对比行 + │ 分隔 diff 行渲染');

  // ⑥ 新建文件 write → 全文逐行绿（diffRole=add），收起态「新增文件 · 全文 N 行」
  out.onToolStep(5, 10, 'write_file', '✏️ new.txt', { path: 'new.txt', content: 'l1\nl2\nl3' });
  out.onToolResult(true, 6, ['写入成功'], { diff: { path: 'new.txt', original: null, content: 'l1\nl2\nl3' } });
  await wait(60);
  frame = grab();
  // 收起态（opencode 风格）：命令 + 变更统计（新增文件·全文 N 行）
  if (!frame.includes('✏️ new.txt') || !frame.includes('新增文件 · 全文 3 行')) {
    console.error('--- 帧内容（新建收起态应显示命令+变更统计）---');
    console.error(frame);
    throw new Error('新建文件收起态应显示命令 + 变更统计（新增文件·全文 N 行）');
  }
  const newCard = state.lines.filter((l) => l.kind === 'tool').at(-1)!.card!;
  const rectN = tree.cardRects.get(newCard.id);
  if (!rectN) throw new Error('new 卡 rect 缺失');
  hitTestCard(state, tree.cardRects, rectN.top);
  await session.paint();
  await wait(60);
  frame = grab();
  if (!frame.includes('l1') || !frame.includes('l2') || !frame.includes('l3')) {
    console.error('--- 帧内容（新建全文缺失）---');
    console.error(frame);
    throw new Error('新建文件展开态缺全文');
  }
  console.log('[6] ✓ 新建文件：收起态「新增文件 · 全文 3 行」→ 展开显示全文');

  console.log('\n== 全部通过：并行多读合并 / write diff 展示（摘要 + 左右对比 + 新建全文）==');
  process.exit(0);
}

void main();

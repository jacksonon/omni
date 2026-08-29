/**
 * 拖选复制探针（字符级精选取中）：鼠标 down+drag+up → 选区高亮渲染 + 提取文本。
 * 覆盖：colToChar 列→字符换算（CJK/emoji、超宽截断）、markRowSelected 高亮克隆
 *（chunks 重建、选中列换 selBg/selFg）、selectionText 单行/多行提取、selectionMoved
 * 判定、handleTuiMouseEvent down/drag/up 状态机（纯点击不复制、拖动复制）、
 * 渲染层 seiRow 高亮（重绘后行 chunks 命中选中的 bg）。
 */
import { createTestRenderer } from '@opentui/core/testing';
import { mountTree, repaintTree } from '/Users/os/Downloads/private/omni/src/tui/render.js';
import { computeRows, markRowSelected, selectionMoved, selectionText } from '/Users/os/Downloads/private/omni/src/tui/rows.js';
import { colToChar } from '/Users/os/Downloads/private/omni/src/tui/layout.js';
import { createTuiState, pushLine } from '/Users/os/Downloads/private/omni/src/tui/state.js';
import { themeFor } from '/Users/os/Downloads/private/omni/src/tui/theme.js';

let ok = true;
const check = (cond: boolean, msg: string): void => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) ok = false;
};

async function main() {
  // —— 1. colToChar 列 → 字符换算（返回「包含该列」字符的 UTF-16 下标，供 slice 用）——
  check(colToChar('hello world', 0) === 0, 'colToChar 列 0 → 字符 0');
  check(colToChar('hello world', 3) === 3, 'colToChar 列 3 → 字符 3（纯 ASCII 等宽）');
  check(colToChar('中文测试', 2) === 1, 'colToChar 列 2 → 字符 1（中文全角 2 列，2 列落在第 1 个汉字的右半）');
  check(colToChar('中文测试', 4) === 2, 'colToChar 列 4 → 字符 2');
  check(colToChar('a中b', 3) === 2, 'colToChar 混合 a中b 列 3 → 字符 2（a1 + 中2，3 列在中右半）');
  check(colToChar('📁folder', 2) === 2, 'colToChar emoji=代理对 2 列 → 列 2 → 字符 2（f 前）');
  check(colToChar('📁folder', 3) === 3, 'colToChar emoji 列 3 → 字符 3（o 前）');
  check(colToChar('abc', 999) === 3, 'colToChar 列超宽 → 行尾字符数');

  const theme = themeFor({ themeMode: 'dark', detectedTheme: 'dark', language: 'zh' } as never);
  // —— 2. markRowSelected 高亮（chunks 重建，中文列偏移）——
  const plain = { text: '中文测试abc', style: {} };
  const marked = markRowSelected(plain, 2, 6, theme);
  check(marked.text === '中文测试abc', 'markRowSelected 保留原 text');
  check(!!marked.chunks, 'markRowSelected 把普通行转成 chunks');
  check(marked.chunks!.length === 3, `markRowSelected 拆成 3 段（前/中/后），实际 ${marked.chunks!.length}`);
  check(marked.chunks![1]!.bg === theme.selBg && marked.chunks![1]!.fg === theme.selFg, '选中段带 selBg/selFg');
  const selPart = marked.chunks!.map((c) => c.text).join('');
  check(selPart === '中文测试abc', 'chunks 拼接回原文本（不丢字符）');

  const noSel = markRowSelected(plain, 4, 2, theme);
  check(noSel.text === '中文测试abc', '空/反向列区间 → 原样返回');

  // —— 3. selectionText 提取 ——
  const rows = [
    { text: '中文测试abc', style: {} },
    { text: '第二行内容XYZ', style: {} },
  ];
  const t1 = selectionText(rows, { aRow: 0, aCol: 2, fRow: 0, fCol: 6 });
  check(t1 === '文测', `单行选 [2-6)→「文测」（中两列落在文右半开始）, 实际「${t1}」`);
  const t2 = selectionText(rows, { aRow: 0, aCol: 4, fRow: 0, fCol: 9 });
  check(t2 === '测试a', `单行跨中文到 a [4-9)→「测试a」, 实际「${t2}」`);
  // 第 1 行从列 2 到行尾；第 2 行「第二行内容XYZ」宽 13，拖到列 12 = Z 起列 → 含「第二行内容XY」
  const t3 = selectionText(rows, { aRow: 0, aCol: 2, fRow: 1, fCol: 12 });
  check(t3 === '文测试abc\n第二行内容XY', `多行提取（第 1 行从列 2 到行尾、第 2 行拖到 Z 前）, 实际「${t3.replace(/\n/g, '\\n')}」`);
  // 拖到行尾之外（列远大于行宽）→ 第 2 行全行
  const t4 = selectionText(rows, { aRow: 0, aCol: 2, fRow: 1, fCol: 999 });
  check(t4 === '文测试abc\n第二行内容XYZ', `多行拖到行尾外 → 第 2 行全行, 实际「${t4.replace(/\n/g, '\\n')}」`);

  // —— 4. selectionMoved ——
  check(selectionMoved({ aRow: 0, aCol: 2, fRow: 0, fCol: 2 }) === false, '同行同列 = 未拖动（纯点击）');
  check(selectionMoved({ aRow: 0, aCol: 2, fRow: 0, fCol: 5 }) === true, '同行不同列 = 已拖动');
  check(selectionMoved({ aRow: 0, aCol: 2, fRow: 1, fCol: 0 }) === true, '不同行 = 已拖动');

  // —— 5. computeRows + repaintTree：选区高亮渲染 + handleTuiMouseEvent down/drag/up ——
  const state = createTuiState();
  state.cwd = '/tmp';
  pushLine(state, { kind: 'answer', text: '中文测试abc 这是一行内容' });
  pushLine(state, { kind: 'answer', text: '第二行内容XYZ 还有更多' });
  const t = await createTestRenderer({ width: 64, height: 24 });
  const tree = mountTree(t.renderer, state, { withInput: true });
  repaintTree(t.renderer, tree, state, { withInput: true });
  await t.renderOnce();
  check(tree.lastRows.length >= 2, `repaintTree 存 lastRows（≥2 行），实际 ${tree.lastRows.length}`);

  // down + drag + up：直接调 handleTuiMouseEvent（状态机在同一函数）
  const { handleTuiMouseEvent } = await import('/Users/os/Downloads/private/omni/src/tui/render.js');
  handleTuiMouseEvent({ type: 'down', button: 0, x: 2, y: 1 }, tree, state, 64, async () => {});
  check(!!tree.sel, 'down 落下内容行 → 建立选区起点');
  handleTuiMouseEvent({ type: 'drag', button: 0, x: 6, y: 1 }, tree, state, 64, async () => {});
  check(!!tree.sel && tree.sel!.fCol === 5 && tree.sel!.fRow === 0, 'drag 更新焦点（列 5、行 0）');
  // repaint 后该行应有选中高亮 chunk
  repaintTree(t.renderer, tree, state, { withInput: true });
  await t.renderOnce();
  // 渲染高亮：树细胞 content 是 StyledText，chunks 的 bg 经 applyRowToCell 的 parseColor 处理。
  // 因此比较解析后的颜色值（parseColor(theme.selBg)）而非原 hex。
  const { parseColor } = await import('@opentui/core');
  const cell0 = tree.cells[0]!;
  const styled: unknown = cell0.content;
  const chunks = (styled as { chunks?: { text: string; bg?: string }[] }).chunks ?? [];
  const selParsed = parseColor(theme.selBg);
  const hasSelChunk = chunks.some((c) => c.bg != null && JSON.stringify(c.bg) === JSON.stringify(selParsed));
  check(hasSelChunk, `渲染层对该行画了 selBg 高亮块（${chunks.length} 个 chunk）`);
  const selText = chunks.filter((c) => c.bg != null && JSON.stringify(c.bg) === JSON.stringify(selParsed)).map((c) => c.text).join('');
  check(selText.length > 0, `高亮块含选中字符（${selText}）`);

  // up（已拖动）→ 清空选区（剪贴板写入走 OSC52/stdout，探针不校验内容）
  handleTuiMouseEvent({ type: 'up', button: 0, x: 6, y: 1 }, tree, state, 64, async () => {});
  check(tree.sel === null, 'up 后清除选区');

  // 纯点击（无拖动）：down + up 同行同列 → 不残留选区
  handleTuiMouseEvent({ type: 'down', button: 0, x: 3, y: 2 }, tree, state, 64, async () => {});
  check(!!tree.sel, '第二个 down 建立选区');
  handleTuiMouseEvent({ type: 'up', button: 0, x: 3, y: 2 }, tree, state, 64, async () => {});
  check(tree.sel === null, '纯点击 up → 清空且不复制');

  // 点击落在内容区外（y=0 或 y > lastRows）：不建立选区
  handleTuiMouseEvent({ type: 'down', button: 0, x: 3, y: 0 }, tree, state, 64, async () => {});
  check(tree.sel === null, 'y=0（内容区外上沿）不建立选区');
  handleTuiMouseEvent({ type: 'down', button: 0, x: 3, y: 999 }, tree, state, 64, async () => {});
  check(tree.sel === null, 'y 极大（内容区外）不建立选区');

  console.log(ok ? '\n全部通过' : '\n存在失败断言');
  process.exit(ok ? 0 : 1);
}

main();
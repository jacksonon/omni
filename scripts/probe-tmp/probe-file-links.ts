/**
 * 对话流本地文件链接探针：行内代码路径 → 可点击 → 点击回调（外部编辑器打开）。
 * 覆盖：resolveLocalFile 检测（存在/不存在/目录/标点后缀/相对绝对）、collectFileLinks
 * 列偏移、buildBody 标记 link+underline、repaintTree fileRects 登记、handleTuiMouseEvent
 * 点击命中（x = 1 + 行内列）+ mockMouse 真实事件链路。
 */
import { createTestRenderer } from '@opentui/core/testing';
import { mountTree, repaintTree, handleTuiMouseEvent } from '../../src/tui/render.js';
import { buildBody, collectFileLinks, resolveLocalFile } from '../../src/tui/rows.js';
import { createTuiState } from '../../src/tui/state.js';
import { pushLine } from '../../src/tui/state.js';

const ROOT = path.resolve(import.meta.dirname ?? ".", "../../");
let ok = true;
const check = (cond: boolean, msg: string): void => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) ok = false;
};

async function main() {
  // —— 1. resolveLocalFile 检测 ——
  check(resolveLocalFile('src/version.ts', ROOT) === `${ROOT}/src/version.ts`, '相对路径存在 → 解析为绝对路径');
  check(resolveLocalFile('../../package.json', ROOT) === '../../package.json', '绝对路径存在 → 原样返回');
  check(resolveLocalFile('src/no-such-file.ts', ROOT) === null, '不存在的路径 → null');
  check(resolveLocalFile('src/tui', ROOT) === null, '目录 → null（只认文件）');
  check(resolveLocalFile('src/version.ts,', ROOT) === `${ROOT}/src/version.ts`, '结尾标点逗号 → 剥离后命中');
  check(resolveLocalFile('src/version.ts)。', ROOT) === `${ROOT}/src/version.ts`, '结尾中文标点 → 剥离后命中');
  check(resolveLocalFile('随便文本', ROOT) === null, '非路径文本 → null');
  check(resolveLocalFile('', ROOT) === null, '空文本 → null');

  // —— 2. collectFileLinks 列偏移 ——
  const links = collectFileLinks([
    { text: '看 ' },
    { text: 'src/version.ts', fg: '#e6b450', link: `${ROOT}/src/version.ts` },
    { text: ' 和 ' },
    { text: 'README.md', fg: '#e6b450', link: `${ROOT}/README.md` },
  ]);
  check(links?.length === 2, 'collectFileLinks 收集 2 个链接');
  check(links![0]!.col === 3 && links![0]!.width === 14, '第一个链接列偏移 3（"看 " = 看 2 + 空格 1）、宽度 14（src/version.ts 14 字符）');
  check(links![1]!.col === 21 && links![1]!.width === 9, '第二个链接列偏移 3+14+4=21（" 和 " = 空格1+和2+空格1）、宽度 9（README.md）');

  // —— 3. buildBody：answer 行的行内代码路径被标记 link + underline ——
  const state = createTuiState();
  state.cwd = ROOT;
  pushLine(state, { kind: 'answer', text: '看 `src/version.ts` 与 `src/README-none.md` 的区别' });
  const body = buildBody(state, 60);
  const answerRow = body.find((r) => r.fileLinks !== undefined);
  check(!!answerRow, 'buildBody 产出带 fileLinks 的行');
  check(answerRow!.fileLinks![0]!.path === `${ROOT}/src/version.ts`, 'fileLinks 里的路径是绝对路径');
  check(answerRow!.chunks?.some((c) => c.link !== undefined && c.underline === true), '行内代码 chunk 带 link + underline（可点击提示）');
  const nonLinkChunks = answerRow!.chunks!.filter((c) => c.text.includes('README-none'));
  check(nonLinkChunks.length === 1 && nonLinkChunks[0]!.link === undefined, '不存在的路径不标记 link');

  // —— 4. repaintTree fileRects 登记 + handleTuiMouseEvent 点击命中 ——
  const t = await createTestRenderer({ width: 64, height: 24 });
  const tree = mountTree(t.renderer, state, { withInput: true });
  repaintTree(t.renderer, tree, state, { withInput: true });
  await t.renderOnce();
  // 找 fileRects：内容行 i → y = i + 1
  const rectY = [...tree.fileRects.keys()][0];
  check(rectY !== undefined, 'repaintTree 登记了 fileRects（有链接的行）');
  const span = tree.fileRects.get(rectY!)![0]!;
  check(span.path === `${ROOT}/src/version.ts`, 'fileRects 里的路径正确');
  // 点击（x = 1 + col 起点，命中 span 内）：onOpenFile 被调用
  let opened: string | null = null;
  handleTuiMouseEvent(
    { type: 'down', button: 0, x: 1 + span.col, y: rectY },
    tree, state, 64, async () => {}, null, 1500,
    (p) => { opened = p; }
  );
  check(opened === `${ROOT}/src/version.ts`, `点击 span 起点命中并打开（x=${1 + span.col}）`);
  opened = null;
  handleTuiMouseEvent(
    { type: 'down', button: 0, x: 1 + span.col + span.width - 1, y: rectY },
    tree, state, 64, async () => {}, null, 1500,
    (p) => { opened = p; }
  );
  check(opened === `${ROOT}/src/version.ts`, '点击 span 终点命中');
  opened = null;
  handleTuiMouseEvent(
    { type: 'down', button: 0, x: 1 + span.col + span.width, y: rectY },
    tree, state, 64, async () => {}, null, 1500,
    (p) => { opened = p; }
  );
  check(opened === null, '点击 span 右侧 1 列不命中（不误触）');
  handleTuiMouseEvent(
    { type: 'down', button: 0, x: 1 + span.col, y: rectY - 1 },
    tree, state, 64, async () => {}, null, 1500,
    (p) => { opened = p; }
  );
  check(opened === null, '点击上一行不命中');

  // —— 5. mockMouse 真实事件链路（冒泡到 root.onMouseEvent）——
  opened = null;
  (tree.root as unknown as { onMouseEvent?: (e: unknown) => void }).onMouseEvent = (e: unknown) => {
    handleTuiMouseEvent(e as never, tree, state, 64, async () => {}, null, 1500, (p) => { opened = p; });
  };
  await t.mockMouse.click(1 + span.col, rectY);
  check(opened === `${ROOT}/src/version.ts`, 'mockMouse 真实事件链路点击命中并打开');

  if (!ok) {
    console.log('✗ 存在失败断言');
    process.exit(1);
  }
  console.log('✓ 对话流本地文件链接探针全部通过');
  process.exit(0);
}
void main();

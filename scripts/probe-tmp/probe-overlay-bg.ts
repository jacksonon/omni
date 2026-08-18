/**
 * 探针：浮层面板背景色（menuOverlay / cmdPanelOverlay 透明 → 对话流文字重合看不清的修复）。
 * 帧级断言：打开 /theme 菜单（menuOverlay）与命令输出面板（cmdPanelOverlay）后，渲染帧内
 * 面板区域的每个单元格都带主题面板底色（suggestBg）——对话流文字被盖住不再透出；
 * 主题切换（/theme light）后 repaintTree 跟随刷新底色。
 * 运行：npx tsx scripts/probe-tmp/probe-overlay-bg.ts
 */
import { createTestRenderer } from '@opentui/core/testing';
import { createTuiState, pushLine } from '../../src/tui/state.js';
import { mountTree, repaintTree } from '../../src/tui/render.js';
import { themeFor } from '../../src/tui/theme.js';

function toHex(v: unknown): string | null {
  const c = v as { toInts?: () => [number, number, number, number] };
  const ints = c?.toInts?.();
  if (!ints) return null;
  return `#${ints.slice(0, 3).map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function probe(themeMode: 'dark' | 'light'): Promise<void> {
  const t = await createTestRenderer({ width: 80, height: 24 });
  const s = createTuiState();
  s.themeMode = themeMode;
  // 对话流先铺满若干行（面板浮层覆盖其上）
  pushLine(s, { kind: 'answer', text: '第一行对话流文字，用于验证面板不会透出' });
  pushLine(s, { kind: 'answer', text: '第二行对话流文字，用于验证面板不会透出' });
  pushLine(s, { kind: 'answer', text: '第三行对话流文字，用于验证面板不会透出' });
  const tree = mountTree(t.renderer, s, { withInput: true });

  // —— 1) /theme 菜单浮层（menuOverlay，含设置面板同源）——
  s.menu = {
    id: 'theme',
    title: '主题',
    options: [
      { value: 'system', label: '跟随系统' },
      { value: 'light', label: '亮色' },
      { value: 'dark', label: '深色' },
    ],
    selectedIndex: 0,
    currentValue: 'system',
  };
  repaintTree(t.renderer, tree, s, { withInput: true });
  await t.renderOnce();
  const frameMenu = t.captureSpans();
  const theme = themeFor(s);
  let menuCovered = 0;
  for (const line of frameMenu.lines) {
    for (const sp of (line as unknown as { spans: { bg?: unknown; text: string }[] }).spans) {
      if (toHex(sp.bg) === theme.suggestBg) menuCovered++;
    }
  }
  if (menuCovered === 0) fail(`${themeMode}: 菜单浮层帧内无面板底色单元格`);
  console.log(`✓ ${themeMode}: 菜单浮层 ${menuCovered} 个单元格带面板底色 ${theme.suggestBg}`);
  s.menu = null;

  // —— 2) 命令输出面板（cmdPanelOverlay：/status 等所有 / 命令）——
  s.cmdPanel = { title: '/status', lines: ['模型: mock', '权限: safe', '会话文件: /tmp/x.jsonl'], scroll: 0 };
  repaintTree(t.renderer, tree, s, { withInput: true });
  await t.renderOnce();
  const frameCmd = t.captureSpans();
  let cmdCovered = 0;
  for (const line of frameCmd.lines) {
    for (const sp of (line as unknown as { spans: { bg?: unknown; text: string }[] }).spans) {
      if (toHex(sp.bg) === theme.suggestBg) cmdCovered++;
    }
  }
  if (cmdCovered === 0) fail(`${themeMode}: 命令面板帧内无面板底色单元格`);
  console.log(`✓ ${themeMode}: 命令输出面板 ${cmdCovered} 个单元格带面板底色 ${theme.suggestBg}`);
  s.cmdPanel = null;

  // —— 3) 主题切换后底色跟随刷新（亮色 ↔ 深色）——
  const other: 'dark' | 'light' = themeMode === 'dark' ? 'light' : 'dark';
  s.menu = { id: 'theme', title: '主题', options: [{ value: 'system', label: '跟随系统' }], selectedIndex: 0, currentValue: 'system' };
  s.themeMode = other;
  repaintTree(t.renderer, tree, s, { withInput: true });
  await t.renderOnce();
  const frameOther = t.captureSpans();
  const otherTheme = themeFor(s);
  let otherCovered = 0;
  for (const line of frameOther.lines) {
    for (const sp of (line as unknown as { spans: { bg?: unknown; text: string }[] }).spans) {
      if (toHex(sp.bg) === otherTheme.suggestBg) otherCovered++;
    }
  }
  if (otherCovered === 0) fail(`${themeMode}→${other}: 切换主题后菜单底色未跟随（期望 ${otherTheme.suggestBg}）`);
  console.log(`✓ ${themeMode}→${other}: 主题切换后菜单底色跟随刷新为 ${otherTheme.suggestBg}`);
}

await probe('dark');
await probe('light');
console.log('✓ 探针通过：浮层面板背景色已设置、帧级覆盖对话流、随主题刷新');

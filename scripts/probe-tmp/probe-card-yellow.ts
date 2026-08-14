/**
 * 探针：验证工具卡片块——超淡黄背景（#fefce8）+ 完整长方形（每行整行填满、
 * 顶/底行与四角无透明缺口）+ 深棕文字（#713f12）。两种主题各测一遍。
 */
import { createTestRenderer } from '@opentui/core/testing';
import { createTuiState, pushLine } from '../../src/tui/state.js';
import { mountTree, repaintTree } from '../../src/tui/render.js';
import { themeFor } from '../../src/tui/theme.js';

async function probe(themeMode: 'dark' | 'light'): Promise<void> {
  const t = await createTestRenderer({ width: 60, height: 24 });
  const s = createTuiState();
  s.themeMode = themeMode;
  const tree = mountTree(t.renderer, s, { withInput: true });
  // 工具卡片：收起态 = 命令 + 执行缩略 + 结果缩略，前后顶/底留白行
  pushLine(s, {
    kind: 'tool',
    card: { id: 1, name: 'run_command', summary: '$ echo mock-ok', status: 'ok', output: [], expanded: false },
  });
  pushLine(s, { kind: 'answer', text: '回答' });
  repaintTree(t.renderer, tree, s, { withInput: true });
  await t.renderOnce();
  const frame = t.captureSpans();

  const theme = themeFor(s.themeMode);
  const yellow = theme.cardBg; // #fefce8
  const brown = theme.cardDim; // #713f12
  // toInts 返回 [r,g,b,a]，比较时忽略 alpha
  const toHex = (v: unknown): string | null => {
    const c = v as { toInts?: () => [number, number, number, number] };
    const ints = c?.toInts?.();
    if (!ints) return null;
    return `#${ints.slice(0, 3).map((x) => x.toString(16).padStart(2, '0')).join('')}`;
  };

  // 找到卡片块：从第一个含「$ echo」的行向上/下扫整块
  let cmdRow = -1;
  for (let y = 0; y < frame.lines.length; y++) {
    const text = frame.lines[y]!.spans.map((sp) => sp.text).join('');
    if (text.includes('$ echo')) {
      cmdRow = y;
      break;
    }
  }
  if (cmdRow < 0) throw new Error(`${themeMode}: 未找到命令行`);
  // 块 = 顶留白 1 + cmd + exec + result + 底留白 1（收起态 5 行）
  const startY = cmdRow - 1;
  const endY = cmdRow + 3;
  let gaps = 0;
  let wrongBg = 0;
  let wrongFg = 0;
  for (let y = startY; y <= endY; y++) {
    const line = frame.lines[y];
    if (!line) throw new Error(`${themeMode}: 行 ${y} 缺失`);
    // 内容列 = 视口宽 - 左右 padding(2) = 58；卡片块必须整行填满该区间，
    // 中间不得有透明缺口（左右边缘 1 列是视口 padding，天然透明、不算缺角）
    let col = 0;
    let yellowWidth = 0;
    for (const sp of line.spans) {
      const bg = toHex(sp.bg);
      const fg = toHex(sp.fg);
      const segStart = col;
      const segEnd = col + sp.width - 1;
      col += sp.width;
      if (segStart >= 1 && segEnd <= 58) {
        // 内容列内的 span：必须淡黄底（含顶/底行与左右角——完整长方形无缺角）
        if (bg !== yellow) {
          wrongBg++;
          console.log(`[${themeMode}] 行 ${y} 内容列 span bg=${bg}（应 ${yellow}）text=${JSON.stringify(sp.text)}`);
        }
        if (sp.text.trim() && fg !== brown) {
          wrongFg++;
          console.log(`[${themeMode}] 行 ${y} 内容列 span fg=${fg}（应 ${brown}）text=${JSON.stringify(sp.text)}`);
        }
      }
      if (bg === yellow) yellowWidth += sp.width;
    }
    if (yellowWidth !== 58) {
      gaps++;
      console.log(`[${themeMode}] 行 ${y} 黄底覆盖 ${yellowWidth} 列（应 58）`);
    }
  }
  console.log(`[${themeMode}] 卡片块 5 行：底色缺口=${wrongBg} 文字色异常=${wrongFg} 黄底行宽不足=${gaps}`);
  if (wrongBg > 0 || wrongFg > 0 || gaps > 0) throw new Error(`${themeMode}: 卡片块不完整或颜色不对`);
  console.log(`✓ ${themeMode}：工具卡片块 = 超淡黄 #fefce8 完整长方形（5 行整行填满、四角无缺口）+ 深棕文字 #713f12`);
}

async function main(): Promise<void> {
  await probe('dark');
  await probe('light');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

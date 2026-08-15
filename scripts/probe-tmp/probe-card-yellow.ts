/**
 * 探针：验证工具卡片块按执行状态取色——执行成功淡绿（#dcfce7 底 + #14532d 字）、
 * 执行失败淡红（#fee2e2 底 + #7f1d1d 字）、执行中超淡黄（#fefce8 底 + #713f12 字）；
 * 每种状态都是完整长方形（每行整行填满、顶/底行与四角无透明缺口）。两种主题各测一遍。
 */
import { createTestRenderer } from '@opentui/core/testing';
import { createTuiState, pushLine } from '../../src/tui/state.js';
import { mountTree, repaintTree } from '../../src/tui/render.js';
import { themeFor } from '../../src/tui/theme.js';

interface StatusSpec {
  status: 'ok' | 'err' | 'running';
  marker: string;
  bg: string;
  fg: string;
}

async function probe(themeMode: 'dark' | 'light'): Promise<void> {
  const t = await createTestRenderer({ width: 60, height: 24 });
  const s = createTuiState();
  s.themeMode = themeMode;
  const tree = mountTree(t.renderer, s, { withInput: true });
  // 三种状态的工具卡片：成功 / 失败 / 执行中
  pushLine(s, {
    kind: 'tool',
    card: { id: 1, name: 'run_command', summary: '$ echo mock-ok', status: 'ok', output: ['mock-ok'], expanded: false },
  });
  pushLine(s, {
    kind: 'tool',
    card: { id: 2, name: 'run_command', summary: '$ git push origin main', status: 'err', output: ['退出码: 128', 'error: 无法推送'], expanded: false },
  });
  pushLine(s, {
    kind: 'tool',
    card: { id: 3, name: 'run_command', summary: '$ sleep 1', status: 'running', output: [], expanded: false },
  });
  pushLine(s, { kind: 'answer', text: '回答' });
  repaintTree(t.renderer, tree, s, { withInput: true });
  await t.renderOnce();
  const frame = t.captureSpans();

  const theme = themeFor(s.themeMode);
  const specs: StatusSpec[] = [
    { status: 'ok', marker: '$ echo mock-ok', bg: theme.cardOkBg, fg: theme.cardOkDim },
    { status: 'err', marker: '$ git push origin main', bg: theme.cardErrBg, fg: theme.cardErrDim },
    { status: 'running', marker: '$ sleep 1', bg: theme.cardBg, fg: theme.cardDim },
  ];
  // toInts 返回 [r,g,b,a]，比较时忽略 alpha
  const toHex = (v: unknown): string | null => {
    const c = v as { toInts?: () => [number, number, number, number] };
    const ints = c?.toInts?.();
    if (!ints) return null;
    return `#${ints.slice(0, 3).map((x) => x.toString(16).padStart(2, '0')).join('')}`;
  };

  for (const spec of specs) {
    // 找到该卡片的命令行
    let cmdRow = -1;
    for (let y = 0; y < frame.lines.length; y++) {
      const text = frame.lines[y]!.spans.map((sp) => sp.text).join('');
      if (text.includes(spec.marker)) {
        cmdRow = y;
        break;
      }
    }
    if (cmdRow < 0) throw new Error(`${themeMode}: 未找到命令行 ${spec.marker}`);
    // 块 = 从顶留白行（cmdRow-1）开始向下扫到下一个非本状态底色行
    const rows: { text: string; spans: { bg?: unknown; fg?: unknown }[] }[] = [];
    for (let y = cmdRow - 1; y < frame.lines.length; y++) {
      const line = frame.lines[y]!;
      const spans = line.spans as { text: string; bg?: unknown; fg?: unknown }[];
      if (!spans.some((sp) => toHex(sp.bg) === spec.bg)) break;
      rows.push({ text: spans.map((sp) => sp.text).join(''), spans });
    }
    if (rows.length < 3) {
      throw new Error(`${themeMode}: ${spec.status} 卡片块行数异常（应 ≥3，实际 ${rows.length}）`);
    }
    for (const row of rows) {
      // 每行整行填满状态底色（完整长方形，四角无缺口——顶/底行也整行填满）
      const bgCols = row.spans.filter((sp) => toHex(sp.bg) === spec.bg).reduce((n, sp) => n + sp.text.length, 0);
      if (bgCols < 58) {
        throw new Error(`${themeMode}: ${spec.status} 行底色未铺满: bgCols=${bgCols} row=${JSON.stringify(row.text)}`);
      }
    }
    // 文字统一状态色深字（非空白内容行的 fg 应为该状态深色）
    for (const row of rows) {
      const text = row.text.trim();
      if (!text) continue;
      for (const sp of row.spans) {
        if (sp.text.trim() && toHex(sp.fg) !== spec.fg) {
          throw new Error(`${themeMode}: ${spec.status} 文字色错误: ${JSON.stringify(sp.fg)} 行=${JSON.stringify(row.text)}`);
        }
      }
    }
    console.log(`✓ ${themeMode}/${spec.status}: 状态底色 ${spec.bg} 完整长方形 + 深色文字 ${spec.fg}`);
  }
}

await probe('dark');
await probe('light');
console.log('✓ 探针通过：三种状态卡片底色（淡绿/淡红/淡黄）+ 完整长方形 + 状态深色文字，双主题一致');

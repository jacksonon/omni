/**
 * 轨迹面板（右侧栏，/trace 展开）：纯展示层——把 agent/trace.ts 的 TraceRow 投影
 * 截断成面板行（TracePanelRow），不持有状态（数据源 state.traceRows 由 interactive
 * 每轮对话后调 refreshTrace 刷新）。与渲染层协作：render.ts 挂 traceBox 绝对定位
 * 浮层（右缘，宽 TRACE_W），行级命中（点击轨迹行展开/收起详情）走 traceRowMap。
 *
 * 面板结构：标题行 + 内容窗口（底部对齐，traceScroll = 从底部上滚行数）+ 顶/底
 * 「还有 N 行」提示行。traceSelected = 选中行绝对下标（-1 = 无）；选中行高亮
 * `›` 前缀并内嵌展开详情行（副信息 + 完整文本）。
 */
import { foldTrace } from '../agent/trace.js';
import type { TraceRow } from '../agent/trace.js';
import type { TrajEvent } from '../agent/events.js';
import { t, tf } from './i18n.js';
import type { TuiState } from './state.js';
import { visualWidth } from './width.js';

/** 轨迹面板行（与 Row 结构兼容：render 侧转 Row 应用样式；不 import rows.js 避免循环依赖） */
export interface TracePanelRow {
  text: string;
  style: { dim?: boolean; bold?: boolean; fg?: string; bg?: string };
}

/** 轨迹面板固定宽度（列） */
export const TRACE_W = 36;

/** 内容行文本列宽（边框 2 + 左右 padding 2） */
export const TRACE_TEXT_COLS = TRACE_W - 4;

/** 截断到指定列宽（CJK 全角 2 列；超出省略号） */
function fit(text: string, cols: number): string {
  if (visualWidth(text) <= cols) return text;
  let out = '';
  let w = 0;
  for (const ch of text) {
    const cw = visualWidth(ch);
    if (w + cw > cols - 1) return out + '…';
    out += ch;
    w += cw;
  }
  return out;
}

/** 单条 TraceRow → 面板行（选中高亮 `›` 前缀；副信息拼在右侧） */
function buildTraceLine(row: TraceRow, selected: boolean, cols: number): TracePanelRow {
  const mark =
    row.kind === 'user' ? '❯' : row.kind === 'tool' ? '⚙' : row.kind === 'turn' ? '' : '·';
  const prefix = mark ? `${mark} ` : '';
  const sel = selected ? '› ' : '  ';
  // 回合行附结束标记（✓/⚠/✗/⌛，与 console 账本 `轮 1 ✓` 同源）
  const done = row.kind === 'turn' && row.done ? ` ${row.done}` : '';
  const sub = row.sub ? '  ' + row.sub : '';
  const style: TracePanelRow['style'] = selected
    ? { fg: 'blue', bold: true }
    : row.kind === 'turn'
      ? { bold: true }
      : row.kind === 'tool'
        ? { fg: 'cyan' }
        : { dim: true };
  return { text: fit(sel + prefix + row.text + done + sub, cols), style };
}

/**
 * 面板行构建（render.ts repaintTree 每帧调用）：
 * 标题 + 内容窗口 + 提示行；rowMap[i] = 行 i 对应的 traceRows 绝对下标
 * （-1 = 标题/提示行，不可点击）。选中行内嵌详情行（也映射同一行下标——
 * 点击详情行同样可收起）。
 */
export function tracePanelLines(
  state: TuiState,
  footerTop: number,
  maxRows?: number
): { lines: TracePanelRow[]; rowMap: number[] } {
  const rows = state.traceRows;
  const out: TracePanelRow[] = [];
  const rowMap: number[] = [];
  // 面板可用高度：top = 1 起、底边 ≤ footerTop - 3（不遮输入区）；标题 1 + 底部提示 1
  const budget = Math.max(3, (maxRows ?? footerTop - 5) - 2);

  out.push({ text: tf(state.language, 'trace.title', { n: rows.length }), style: { bold: true } });
  rowMap.push(-1);

  if (rows.length === 0) {
    out.push({ text: t(state.language, 'trace.empty'), style: { dim: true } });
    rowMap.push(-1);
    out.push({ text: t(state.language, 'trace.hint'), style: { dim: true } });
    rowMap.push(-1);
    return { lines: out, rowMap };
  }

  // 窗口：traceScroll = 从底部上滚的行数（0 = 全部可见/底部对齐）
  const total = rows.length;
  // **窗口预算 = 总预算 − 标题 − 底部提示 − 选中行详情行数**：detail 行内嵌在选中行
  // 下（同一 rowMap 下标），若窗口行数不扣减，detail 行会超出面板高度预算被
  // panelRows 截断——尾部窗口行被挤出/详情不可见（用户反馈「点击展开详情不好使」）。
  // 末尾再留 1 行给滚动提示（scrollUp/scrollDown/hint 三选一恒有位置，否则 ↑ 提示
  // 出现时总行数 = budget+3 = maxRows+1，底部提示被截）。
  const selDetail =
    state.traceSelected >= 0 &&
    state.traceSelected < total &&
    state.traceRows[state.traceSelected]!.detail &&
    state.traceRows[state.traceSelected]!.detail!.length > 0
      ? state.traceRows[state.traceSelected]!.detail!.length
      : 0;
  const contentRows = Math.max(1, budget - selDetail - 1);
  const maxScroll = Math.max(0, total - contentRows);
  let scroll = Math.min(Math.max(0, state.traceScroll), maxScroll);
  // 选中行保持可见（交互层 ↑/↓ 只移动选中，滚动收敛在这里兜底——与联想浮层
  // top 收敛同模式）：可见窗口 = [end-C, end)，选中 s 可见 ⟺ scroll ∈
  // [max(0, T-C-s), min(maxScroll, T-1-s)]——向上/向下移动都被钳进窗口
  if (state.traceSelected >= 0 && state.traceSelected < total) {
    const sel = state.traceSelected;
    const lo = Math.max(0, total - contentRows - sel);
    const hi = Math.min(maxScroll, total - 1 - sel);
    if (scroll < lo) scroll = lo;
    if (scroll > hi) scroll = hi;
  }
  const end = total - scroll;
  const start = Math.max(0, end - contentRows);

  if (start > 0) {
    out.push({ text: tf(state.language, 'trace.scrollUp', { n: start }), style: { dim: true } });
    rowMap.push(-1);
  }
  for (let i = start; i < end; i++) {
    const row = rows[i];
    const selected = state.traceSelected === i;
    out.push(buildTraceLine(row, selected, TRACE_TEXT_COLS));
    rowMap.push(i);
    // 选中行：内嵌展开详情（turn 的 error detail），同为可点击行（再次点击收起）
    if (selected && row.detail) {
      for (const d of row.detail) {
        out.push({ text: fit(`  ${d}`, TRACE_TEXT_COLS), style: { dim: true } });
        rowMap.push(i);
      }
    }
  }
  const below = total - end;
  if (below > 0) {
    out.push({ text: tf(state.language, 'trace.scrollDown', { n: below }), style: { dim: true } });
    rowMap.push(-1);
  } else {
    out.push({ text: t(state.language, 'trace.hint'), style: { dim: true } });
    rowMap.push(-1);
  }
  return { lines: out, rowMap };
}

/**
 * 刷新轨迹行投影（interactive 每轮对话后调用）：重新折叠 + 收敛滚动/选中到合法区间。
 */
export function refreshTrace(state: TuiState, events: TrajEvent[]): void {
  state.traceRows = foldTrace(events);
  const maxScroll = Math.max(0, state.traceRows.length - 2);
  if (state.traceScroll > maxScroll) state.traceScroll = maxScroll;
  if (state.traceSelected >= state.traceRows.length) state.traceSelected = -1;
}
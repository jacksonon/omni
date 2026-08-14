/**
 * 待发送消息（queue/steer）的管理逻辑：输入框上方小视图的选中/排序/删除/编辑。
 *
 * 纯函数 + 按键分发（与 rows.ts 的 hitTestCard、commands.ts 的 handleMenuKey 同层）：
 * interactive.ts 在全局 keypress 里调用 handlePendingKey，render.ts 用
 * pendingSelectable/pendingMove 等同步状态。测试（快照）直接 import 本模块。
 */
import type { TuiKey } from './render.js';
import type { PendingMessage, TuiState } from './state.js';

/** 运行中提交：把消息加入待发送列表（queue 追加末尾；steer 打断插到最前）。 */
export function enqueuePending(state: TuiState, mode: 'queue' | 'steer', text: string): PendingMessage {
  const msg: PendingMessage = { id: ++state.pendingSeq, mode, text };
  if (mode === 'steer') state.pending.unshift(msg);
  else state.pending.push(msg);
  return msg;
}

/** 交换待发送列表中两条消息的位置（排序） */
export function movePending(state: TuiState, from: number, to: number): void {
  const p = state.pending;
  if (from < 0 || from >= p.length || to < 0 || to >= p.length || from === to) return;
  const tmp = p[from]!;
  p[from] = p[to]!;
  p[to] = tmp!;
}

/** 删除待发送列表中某条消息，返回是否成功 */
export function removePending(state: TuiState, idx: number): boolean {
  if (idx < 0 || idx >= state.pending.length) return false;
  state.pending.splice(idx, 1);
  // 选中下标收敛：删除后选中同一位置（下一条）；删到最后一条则回到上一条；空了置 -1
  if (state.pending.length === 0) state.pendingSelected = -1;
  else if (state.pendingSelected >= state.pending.length) state.pendingSelected = state.pending.length - 1;
  else if (state.pendingSelected > idx) state.pendingSelected -= 1;
  return true;
}

/** 编辑待发送消息：从列表移除并返回其文本（调用方 setText 进输入框，重新提交即再入列） */
export function editPending(state: TuiState, idx: number): string | null {
  if (idx < 0 || idx >= state.pending.length) return null;
  const msg = state.pending[idx]!;
  state.pending.splice(idx, 1);
  state.pendingSelected = -1;
  return msg.text;
}

/** 输入框为空且有待发送消息（↑ 进入待发送列表选择的入口条件） */
export function pendingSelectable(state: TuiState): boolean {
  return state.pending.length > 0 && state.pendingSelected === -1;
}

/** 选中最后一条待发送消息（输入框空 + ↑） */
export function selectLastPending(state: TuiState): void {
  if (state.pending.length > 0) state.pendingSelected = state.pending.length - 1;
}

/**
 * 处理待发送列表按键（pendingSelected >= 0 时由 interactive 调用）：
 *   · ↑/↓ 移动高亮（循环）
 *   · ←/→ 排序（移动选中项）
 *   · Enter 编辑（返回文本，调用方 setText 进输入框并移除该条）
 *   · Backspace/Delete 删除
 *   · Esc 取消选择（回到输入框）
 *   · 其余按键取消选择并放行给输入框（非模态——继续输入即返回）
 *
 * 返回：{ kind:'consumed' } = 按键被消费（调用方 preventDefault）；
 * { kind:'edit', text } = 编辑请求（调用方 setText 进输入框）；
 * { kind:'deselect' } = 取消选择、按键放行给输入框；null = 未处于选择态。
 */
export type PendingKeyResult =
  | { kind: 'consumed' }
  | { kind: 'edit'; text: string }
  | { kind: 'deselect' }
  | null;

export function handlePendingKey(key: TuiKey, state: TuiState): PendingKeyResult {
  if (state.pendingSelected < 0) return null;
  const sel = state.pendingSelected;
  const len = state.pending.length;
  switch (key.name) {
    case 'up':
      if (len > 0) state.pendingSelected = (sel - 1 + len) % len;
      return { kind: 'consumed' };
    case 'down':
      if (len > 0) state.pendingSelected = (sel + 1) % len;
      return { kind: 'consumed' };
    case 'left':
      if (sel > 0) {
        movePending(state, sel, sel - 1);
        state.pendingSelected = sel - 1;
      }
      return { kind: 'consumed' };
    case 'right':
      if (sel < len - 1) {
        movePending(state, sel, sel + 1);
        state.pendingSelected = sel + 1;
      }
      return { kind: 'consumed' };
    case 'return':
    case 'kpenter':
    case 'linefeed': {
      const text = editPending(state, sel);
      return text === null ? { kind: 'consumed' } : { kind: 'edit', text };
    }
    case 'backspace':
    case 'delete':
      removePending(state, sel);
      return { kind: 'consumed' };
    case 'escape':
    case 'esc':
      state.pendingSelected = -1;
      return { kind: 'consumed' };
    default:
      // 普通按键：取消选择，交给输入框（继续输入/发送即离开列表）
      state.pendingSelected = -1;
      return { kind: 'deselect' };
  }
}

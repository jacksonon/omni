/**
 * TUI 状态：Agent 运行过程的可变状态（纯对象，无响应式依赖）。
 *
 * 由 TuiOutput 写入，render 层在每次 paint 时读取并重建渲染树。
 * 模型：一列"段落"（TuiLine），paint 时按 \n 拆成多行。
 */
export type TuiLineKind =
  | 'thinking' // 💭 思考（浅色）
  | 'step' // → 工具调用（青色）
  | 'result-ok' // ✓ 工具成功（绿色）
  | 'result-err' // ✗ 工具失败（红色）
  | 'answer' // 最终回答（默认色）
  | 'user' // ❯ 用户消息（蓝色加粗）
  | 'meta' // 元信息（浅色）
  | 'warn' // 警告（黄色）
  | 'task'; // 任务标题（青色加粗）

export interface TuiLine {
  kind: TuiLineKind;
  text: string;
}

/** 内容区滚动意图（一次性，由 computeRows 在下次重绘时消费） */
export type ScrollAction = 'line-up' | 'line-down' | 'page-up' | 'page-down' | 'top' | 'bottom';

export interface TuiState {
  lines: TuiLine[];
  status: string;
  model: string;
  version: string;
  /** 内容区滚动位置：null = 跟随最新（自动）；数字 = 视口首行索引（上滚状态） */
  scrollTop: number | null;
  /** 待消费的滚动意图（按键 → computeRows 消费，避免滚动数学散落在按键层） */
  scrollIntent: { action: ScrollAction } | null;
}

export function createTuiState(): TuiState {
  return { lines: [], status: '', model: '', version: '', scrollTop: null, scrollIntent: null };
}

/** 追加一个段落 */
export function pushLine(state: TuiState, line: TuiLine): void {
  state.lines.push(line);
}

/** 若最后一段 kind 相同则追加文本，否则新起一段（用于流式内容累积） */
export function appendLine(state: TuiState, kind: TuiLineKind, text: string): void {
  const last = state.lines[state.lines.length - 1];
  if (last && last.kind === kind) {
    last.text += text;
  } else {
    state.lines.push({ kind, text });
  }
}

/** 清空全部内容行（/clear 命令） */
export function clearLines(state: TuiState): void {
  state.lines.length = 0;
  state.scrollTop = null;
  state.scrollIntent = null;
}

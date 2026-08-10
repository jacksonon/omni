/**
 * Agent 层共享类型。
 */
import type { Tool } from '../tools/index.js';

export interface RunOptions {
  tools: Tool[];
  /** 是否把模型的思考与工具调用过程实时打印到终端 */
  stream?: boolean;
  /** 最大循环步数，防止死循环 */
  maxSteps?: number;
  /** 是否在终端展示思考过程（默认 true；关闭后仍会捕获并落盘 .omni/last-thinking.md） */
  showThinking?: boolean;
}

/** 思考块展示（仅 TTY）。思考内容实时显示后保留在屏幕上，不再折叠。 */
export interface ThinkingDisplay {
  readonly shown: boolean;
  /** 追加一段思考内容（逐字符实时显示，遇到 \n 或超过终端宽度时换行） */
  write(piece: string): void;
  /** 结束思考区：若最后一行未换行则补一个换行，让后续正文/步骤日志从新行开始 */
  finish(): void;
}

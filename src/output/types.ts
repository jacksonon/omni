/**
 * Output：Agent 循环的输出目标抽象。
 *
 * 同一套 runAgent 循环可以对接不同渲染端：
 * - ConsoleOutput：现有命令行输出（彩色/流式/思考保留展示）
 * - TuiOutput：OpenTUI 全屏界面（滚动区 + 状态栏）
 *
 * 事件语义与循环一一对应，渲染端各自决定如何呈现。
 */
import type { ThinkingDisplay } from '../agent/types.js';
import type { OmniConfig } from '../config/index.js';
import type { ApprovalRequest } from '../safety/index.js';

/** 单次响应的 token 用量（OpenAI usage 字段；TUI footer 展示会话累计值） */
export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
  /** 缓存命中 token 数（prompt_tokens_details.cached_tokens / prompt_cache_hit_tokens；网关不支持时缺省） */
  cached?: number;
}

export interface Output {
  /**
   * 渲染端自行处理 Ctrl+C（如 TUI 渲染器的 exitOnCtrlC）时为 true，
   * main 不再注册自己的 SIGINT 处理（避免打断 TUI 退出清理流程）。
   */
  readonly exitOnCtrlC?: boolean;
  /** 启动 banner（console 打印横幅；TUI 写入头部信息）。toolNames 为运行时工具链（含动态工具） */
  banner(cfg: OmniConfig, toolNames?: string[]): void;
  /** 思考展示（流式 write + finish；思考内容保留在屏幕上） */
  thinking: ThinkingDisplay;
  /** 新一轮开始（console 启动 spinner；TUI 更新状态栏） */
  onRound(step: number, maxSteps: number): void;
  /** 第一个流式 chunk 到达（spinner 停止时机） */
  onStreamStart(): void;
  /** 流式正文增量 */
  onAnswer(text: string): void;
  /** 正文结束（console 补换行，让后续内容从新行开始） */
  onAnswerEnd(): void;
  /** 一轮流式响应结束时的 token 用量（TUI footer 右下角累计展示；console 忽略） */
  onUsage(usage: TokenUsage): void;
  /** 一次 Agent 回合开始（交互模式每轮用户提交 / 单次任务各 1 次；TUI footer 轮数统计用） */
  onTurnStart?(): void;
  /** 一次 LLM 流式请求完成（llmMs=请求墙钟毫秒；firstTokenMs=首个 chunk 延迟，失败/无正文为 null） */
  onLlmLap?(llmMs: number, firstTokenMs: number | null): void;
  /** 一轮的工具调用全部完成（toolsMs=该轮工具执行墙钟毫秒） */
  onToolsLap?(toolsMs: number): void;
  /** 模型请求失败 */
  onRequestFailed(err: unknown): void;
  /** 思考内容落盘完成 */
  onThinkingSaved(len: number, file: string | null): void;
  /** 一次工具调用开始（argsPreview 为 formatToolCall 的人类可读摘要，非裸 JSON） */
  onToolStep(step: number, maxSteps: number, name: string, argsPreview: string): void;
  /** 一次工具执行完成（ok=是否成功；preview 为输出前几行，可空） */
  onToolResult(ok: boolean, chars: number, preview?: string[]): void;
  /**
   * 工具调用审批（安全护栏，权限分级需要确认时调用）：返回 true = 允许执行。
   * 实现方负责 UI——console 用 readline 询问、TUI 用审批卡片（y/n 或鼠标左右半区）；
   * 非交互（管道）自动拒绝（fail-safe）。可选：缺省时 loop 直接拒绝。
   */
  requestApproval?(req: ApprovalRequest): Promise<boolean>;
  /** 达到最大步数 */
  onMaxSteps(max: number): void;
  /** 交互模式：回显用户输入的消息（TUI 白字灰底气泡；console 直接回显） */
  onUserMessage(text: string): void;
  /** 交互模式：一轮对话结束（TUI 插入分隔空行；console 补空行） */
  onTurnEnd(): void;
  /** 交互模式：正在等待用户输入（TUI 更新状态栏；console 无操作） */
  onWaitForInput(): void;
  /** 清空滚动区（/clear 命令；console 无法可靠清屏，无操作） */
  clearScrollback(): void;
  /** 内联显示帮助（/help 命令；TUI 写入滚动区，console 打印帮助文本） */
  showHelp(): void;
}

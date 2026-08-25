/**
 * WebOutput：把 Agent 循环的所有事件转发到 SSE 广播（web 客户端渲染）。
 *
 * 事件语义与 Output 接口一一对应（见 output/types.ts 的注释）。
 * 审批 / 提问走 PendingRegistry——服务端持有 pending 请求，Web UI 按钮
 * 经 REST 路由 resolved 后返回 websocket 侧的 promise。
 */
import type { ThinkingDisplay, SubagentEvent } from '../agent/types.js';
import type { OmniConfig } from '../config/index.js';
import type { HookEventName } from '../hooks/index.js';
import type { ApprovalRequest } from '../safety/index.js';
import type { AskResult } from '../tools/ask.js';
import type { Output, TokenUsage, ToolResultDetail } from '../output/types.js';
import type { WebBroadcast } from './events.js';

/** 服务端持有的 pending 注册表（approval / ask 的 resolve 槽） */
export interface PendingRegistry {
  /** 注册一个审批请求，返回「用户作出决定」的 promise（true = 允许执行） */
  addApproval(sessionId: string, req: ApprovalRequest): Promise<boolean>;
  /** 注册一个提问，返回用户选择（choices 文本数组；null = 取消） */
  addAsk(
    sessionId: string,
    question: string,
    options: string[],
    multiple: boolean
  ): Promise<AskResult | null>;
}

/** MessageChannel 式 resolve 槽 */
export interface PendingApproval {
  sessionId: string;
  resolve: (allow: boolean) => void;
}
export interface PendingAsk {
  sessionId: string;
  options: string[];
  multiple: boolean;
  resolve: (result: AskResult | null) => void;
}

/**
 * WebOutput：每个运行中的会话一次实例（由 server 的 currentOutput 路由指向）。
 * 所有事件带 sessionId 广播——多客户端/多标签页都能看到同一会话的实时过程。
 */
export class WebOutput implements Output {
  readonly thinking: ThinkingDisplay;
  /** 工具配对序号兜底计数器（loop 未传 toolSeq 时自增，保证 start/result 一致） */
  private _nextToolSeq = 0;

  constructor(
    readonly sessionId: string,
    private readonly broadcast: WebBroadcast,
    private readonly pending: PendingRegistry,
    /** /thinking 可见性门控：返回 false 时 start/write 不广播事件（不展示思考流） */
    private readonly isThinkingVisible: () => boolean = () => true,
    /** 当前模型名（错误事件附带，便于定位是哪个端点失败） */
    private readonly model?: string,
  ) {
    this.thinking = this.makeThinking();
  }

  private announce(type: Parameters<WebBroadcast>[0], data: Record<string, unknown> = {}): void {
    this.broadcast(type, { sessionId: this.sessionId, ...data });
  }

  /** 思考显示：start 预建块；write 缓冲；finish 标记完成（客户端聚合） */
  private makeThinking(): ThinkingDisplay {
    let shown = false;
    return {
      get shown() {
        return shown;
      },
      start: () => {
        if (!this.isThinkingVisible()) return; // /thinking 关闭：不建模块
        if (shown) return;
        shown = true;
        this.announce('thinking.start');
      },
      write: (piece: string) => {
        if (!this.isThinkingVisible()) return; // /thinking 关闭：不广播 chunk
        if (!shown) {
          shown = true;
          this.announce('thinking.start');
        }
        this.announce('thinking.chunk', { text: piece });
      },
      finish: () => {
        if (!shown) return;
        shown = false;
        this.announce('thinking.end');
      },
    };
  }

  banner(_cfg: OmniConfig, _toolNames?: string[]): void {
    // Web UI 自己渲染头部状态，banner 无操作
  }

  onRound(step: number, maxSteps: number): void {
    this.announce('turn.step', { step, maxSteps });
  }

  onStreamStart(): void {
    // Web 端用游标动画，无需额外事件
  }

  onAnswer(text: string): void {
    this.announce('answer.chunk', { text });
  }

  onAnswerEnd(): void {
    this.announce('answer.end');
  }

  onUsage(usage: TokenUsage): void {
    this.announce('usage', {
      prompt: usage.prompt,
      completion: usage.completion,
      total: usage.total,
      cached: usage.cached ?? 0,
    });
  }

  onThinkingSaved(_len: number, _file: string | null): void {
    // Web 端思考内容实时经 SSE 推送，无需磁盘落盘记录
  }

  onTurnStart?(): void {
    // 轮数统计由客户端按 run.end 计数（turn.step / tool.start 累计），无需额外事件
  }

  onLlmLap?(llmMs: number, firstTokenMs: number | null): void {
    this.announce('lap', { llmMs, firstTokenMs });
  }

  onToolsLap?(toolsMs: number): void {
    this.announce('toolsLap', { toolsMs });
  }

  onRequestFailed(err: unknown): void {
    this.announce('error', {
      message: err instanceof Error ? err.message : String(err),
      ...(this.model ? { model: this.model } : {}),
    });
  }

  /** fallback 回退成功（P0）：SSE 通知前端（meta 提示行） */
  onFallback(model: string): void {
    this.announce('meta.add', { text: `↩ 已回退到备用模型 ${model}` });
  }

  onToolStep(
    step: number,
    maxSteps: number,
    name: string,
    argsPreview: string,
    args?: Record<string, unknown>,
    toolSeq?: number
  ): void {
    this.announce('tool.start', {
      step,
      maxSteps,
      name,
      argsPreview,
      args: args ?? {},
      seq: toolSeq ?? this._nextToolSeq++,
    });
  }

  onToolResult(
    ok: boolean,
    chars: number,
    preview?: string[],
    detail?: ToolResultDetail,
    toolSeq?: number
  ): void {
    this.announce('tool.result', { ok, chars, preview: preview ?? [], detail, seq: toolSeq ?? this._nextToolSeq++ });
  }

  requestApproval(req: ApprovalRequest): Promise<boolean> {
    return this.pending.addApproval(this.sessionId, req);
  }

  askUser(question: string, options: string[], multiple = false): Promise<AskResult | null> {
    return this.pending.addAsk(this.sessionId, question, options, multiple);
  }

  onMaxSteps(max: number): void {
    this.announce('meta.add', { text: `⛔ 达到最大步数上限（${max}）` });
  }

  onUserMessage(text: string): void {
    this.announce('user.message', { text });
  }

  onTurnEnd(): void {
    // 服务端在 run.end 统一广播（含 reason）
  }

  onWaitForInput(): void {
    // Web 端由客户端状态驱动
  }

  clearScrollback(): void {
    this.announce('clear');
  }

  showHelp(): void {
    this.announce('meta.add', { text: '帮助：发送消息与 Agent 对话；运行中可取消；设置可切换模型/权限/思考级别。' });
  }

  onHookOutput?(event: HookEventName, lines: string[]): void {
    this.announce('hook.output', { event, lines: lines.slice(0, 5) });
  }

  onSubagentEvent?(ev: SubagentEvent): void {
    this.announce('subagent', { ev });
  }
}
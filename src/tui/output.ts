/**
 * TuiOutput：把 Agent 循环事件写入 TUI 状态，并调度一次重绘。
 *
 * 事件 → 状态写入 → schedulePaint（30ms 节流合并突发）→ paint() 重建渲染树。
 */
import type { ThinkingDisplay } from '../agent/types.js';
import type { OmniConfig } from '../config/index.js';
import type { Output, TokenUsage } from '../output/types.js';
import type { ApprovalRequest } from '../safety/index.js';
import { VERSION } from '../version.js';
import type { TuiSession } from './render.js';
import { appendLine, clearLines, pushLine, SPINNER_FRAMES, type TuiState } from './state.js';

const NOOP_THINKING: ThinkingDisplay = {
  get shown() {
    return false;
  },
  write() {},
  finish() {},
};

export class TuiOutput implements Output {
  readonly exitOnCtrlC = true; // TUI 渲染器自带 Ctrl+C 退出，main 不注册自己的 SIGINT
  readonly thinking: ThinkingDisplay;
  private paintTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private state: TuiState,
    private opts: { showThinking: boolean },
    private session: TuiSession
  ) {
    if (!opts.showThinking) {
      this.thinking = NOOP_THINKING;
      return;
    }
    let shown = false;
    const self = this; // thinking 对象方法里的 this 指向 thinking 本身，用闭包引用外层实例
    this.thinking = {
      get shown() {
        return shown;
      },
      write: (piece: string) => {
        if (!shown) {
          shown = true;
          pushLine(self.state, { kind: 'thinking', text: piece });
        } else {
          appendLine(self.state, 'thinking', piece);
        }
        self.schedulePaint();
      },
      finish: () => {
        shown = false;
        self.schedulePaint();
      },
    };
  }

  /** spinner 定时器（200ms 间隔循环动画帧） */
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;

  /** 30ms 节流：合并同一突发内的多次变更，避免逐 chunk 重绘 */
  private schedulePaint(): void {
    if (this.paintTimer) return;
    this.paintTimer = setTimeout(() => {
      this.paintTimer = null;
      // 渲染器可能已被 stop（Ctrl+C 退出），忽略此时的绘制错误
      void this.session.paint().catch(() => {});
    }, 30);
  }

  /**
   * 退出前调用：取消节流计时器并立即画最后一帧，
   * 确保 30ms 窗口内未渲染的最终状态（如“任务完成”）上屏。
   */
  private startSpinner(): void {
    this.stopSpinner();
    this.spinnerTimer = setInterval(() => {
      if (this.state.spinnerIndex >= 0) {
        this.state.spinnerIndex = (this.state.spinnerIndex + 1) % SPINNER_FRAMES.length;
        const f = SPINNER_FRAMES[this.state.spinnerIndex];
        this.state.status = `${f} 思考中`;
        this.schedulePaint();
      }
    }, 200);
  }

  private stopSpinner(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
  }

  async flush(): Promise<void> {
    this.stopSpinner();
    if (this.paintTimer) {
      clearTimeout(this.paintTimer);
      this.paintTimer = null;
    }
    await this.session.paint();
  }

  banner(cfg: OmniConfig, _toolNames?: string[]): void {
    this.state.version = VERSION;
    this.state.model = cfg.model;
    this.state.status = `模型 ${cfg.model} · 就绪`;
    this.schedulePaint();
  }

  private toolSeq = 0;

  onRound(step: number, maxSteps: number): void {
    this.state.spinnerIndex = 0;
    this.state.generating = false;
    const f = SPINNER_FRAMES[0];
    this.state.status = `${f} 思考中`;
    this.startSpinner();
    this.schedulePaint();
  }

  onStreamStart(): void {
    this.stopSpinner();
    this.state.spinnerIndex = -1;
    this.state.generating = true;
    this.state.status = '';
    this.schedulePaint();
  }

  onAnswer(text: string): void {
    appendLine(this.state, 'answer', text);
    this.schedulePaint();
  }

  onAnswerEnd(): void {
    this.state.generating = false;
    this.schedulePaint();
  }

  onUsage(usage: TokenUsage): void {
    // 会话累计 token 用量（footer 右下角展示；usage 来自流末 chunk，网关不支持时为 0）
    this.state.tokens.prompt += usage.prompt;
    this.state.tokens.completion += usage.completion;
    this.state.tokens.total += usage.total;
    this.schedulePaint();
  }

  onRequestFailed(err: unknown): void {
    this.stopSpinner();
    this.state.spinnerIndex = -1;
    this.state.status = '请求失败';
    pushLine(this.state, { kind: 'warn', text: `请求失败：${(err as Error)?.message ?? String(err)}` });
    this.schedulePaint();
  }

  onThinkingSaved(_len: number, _file: string | null): void {
    // TUI 中思考已完整展示，无需落盘提示
  }

  onToolStep(step: number, maxSteps: number, name: string, argsPreview: string): void {
    // 工具调用画成卡片（kind='tool'）：标题 + 摘要；完成后收起、点击展开
    pushLine(this.state, {
      kind: 'tool',
      text: argsPreview,
      card: { id: ++this.toolSeq, name, summary: argsPreview, status: 'running', output: [], expanded: false },
    });
    this.state.status = '执行中…';
    this.schedulePaint();
  }

  onToolResult(ok: boolean, chars: number, preview?: string[]): void {
    // 找到最近一个执行中的卡片，填入结果（默认收起，点击展开看输出）
    for (let i = this.state.lines.length - 1; i >= 0; i--) {
      const l = this.state.lines[i];
      if (l.kind === 'tool' && l.card?.status === 'running') {
        l.card.status = ok ? 'ok' : 'err';
        l.card.output = preview ?? [];
        l.card.chars = chars;
        break;
      }
    }
    this.schedulePaint();
  }

  onMaxSteps(max: number): void {
    pushLine(this.state, { kind: 'warn', text: `⚠️ 已达到最大步数（${max}），任务可能未完成` });
    this.state.status = '已中止';
    this.schedulePaint();
  }

  /**
   * 工具调用审批（安全护栏）：渲染审批卡片（内容流末尾，y 批准 / n 拒绝 /
   * 鼠标点击左右半区），resolve 后显示下一条（并行工具的多条审批串行展示）。
   * resolver 挂在 state.approvalResolve 上——startTui（鼠标）与 interactive（按键）
   * 无需反向依赖 TuiOutput 即可完成审批。
   */
  private approvalQueue: { req: ApprovalRequest; resolve: (b: boolean) => void }[] = [];
  requestApproval(req: ApprovalRequest): Promise<boolean> {
    return new Promise((resolve) => {
      this.approvalQueue.push({ req, resolve });
      this.showNextApproval();
    });
  }

  private showNextApproval(): void {
    if (this.state.approval || this.approvalQueue.length === 0) return; // 已有卡片在等 → 排队
    const next = this.approvalQueue.shift()!;
    this.state.approval = { tool: next.req.tool, summary: next.req.summary, reason: next.req.reason };
    this.state.approvalResolve = (allow: boolean) => {
      this.state.approval = null;
      this.state.approvalResolve = null;
      this.state.status = '';
      next.resolve(allow);
      this.schedulePaint();
      this.showNextApproval(); // 串行：处理队列里的下一条
    };
    this.state.status = `等待审批：${next.req.tool}`;
    this.schedulePaint();
  }

  onUserMessage(text: string): void {
    // 用户消息不带 ❯ 前缀（蓝细线 + 白字灰底气泡本身已标识用户输入）
    pushLine(this.state, { kind: 'user', text });
    this.schedulePaint();
  }

  onTurnEnd(): void {
    pushLine(this.state, { kind: 'meta', text: '' });
    this.schedulePaint();
  }

  onWaitForInput(): void {
    // 不显示等待文本（输入框已有占位符）；保留空白状态栏
    this.state.status = '';
    this.schedulePaint();
  }

  clearScrollback(): void {
    clearLines(this.state);
    this.schedulePaint();
  }

  showHelp(): void {
    pushLine(this.state, { kind: 'task', text: '帮助' });
    pushLine(this.state, { kind: 'meta', text: '直接输入消息开始对话，Enter 发送；Shift+Enter 换行（需终端支持修饰键；多行输入自动增高）。' });
    pushLine(this.state, { kind: 'meta', text: '/theme 主题（亮/暗/跟随系统） · /thinking 思考展开/折叠 · /exit 退出 · /clear 清空上下文 · /help 显示帮助' });
    pushLine(this.state, { kind: 'meta', text: '滚动：鼠标滚轮 / PgUp/PgDn 翻页 · Ctrl+U/Ctrl+D 翻页（输入框为空）· ↑/↓ 逐行（输入框为空）· End 回到底部' });
    pushLine(this.state, { kind: 'meta', text: '完整命令参考：omni --help（控制台）' });
    this.schedulePaint();
  }
}

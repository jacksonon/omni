/**
 * TuiOutput：把 Agent 循环事件写入 TUI 状态，并调度一次重绘。
 *
 * 事件 → 状态写入 → schedulePaint（30ms 节流合并突发）→ paint() 重建渲染树。
 */
import type { ThinkingDisplay } from '../agent/types.js';
import type { OmniConfig } from '../config/index.js';
import type { Output } from '../output/types.js';
import { VERSION } from '../version.js';
import type { TuiSession } from './render.js';
import { appendLine, clearLines, pushLine, type TuiState } from './state.js';

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
  async flush(): Promise<void> {
    if (this.paintTimer) {
      clearTimeout(this.paintTimer);
      this.paintTimer = null;
    }
    await this.session.paint();
  }

  banner(cfg: OmniConfig): void {
    this.state.version = VERSION;
    this.state.model = cfg.model;
    this.state.status = `模型 ${cfg.model} · 就绪`;
    this.schedulePaint();
  }

  onRound(step: number, maxSteps: number): void {
    this.state.status = `思考中（第 ${step + 1}/${maxSteps} 轮）`;
    this.schedulePaint();
  }

  onStreamStart(): void {
    this.state.status = '生成中…';
    this.schedulePaint();
  }

  onAnswer(text: string): void {
    appendLine(this.state, 'answer', text);
    this.schedulePaint();
  }

  onAnswerEnd(): void {
    // 段落天然换行，无需额外处理
  }

  onRequestFailed(err: unknown): void {
    this.state.status = '请求失败';
    pushLine(this.state, { kind: 'warn', text: `请求失败：${(err as Error)?.message ?? String(err)}` });
    this.schedulePaint();
  }

  onThinkingSaved(_len: number, _file: string | null): void {
    // TUI 中思考已完整展示，无需落盘提示
  }

  onToolStep(step: number, maxSteps: number, name: string, argsPreview: string): void {
    pushLine(this.state, { kind: 'step', text: `→ [${step + 1}/${maxSteps}] ${name}(${argsPreview})` });
    this.state.status = `执行中（第 ${step + 1}/${maxSteps} 轮）`;
    this.schedulePaint();
  }

  onToolResult(ok: boolean, chars: number): void {
    pushLine(this.state, { kind: ok ? 'result-ok' : 'result-err', text: ok ? `✓ 返回 ${chars} 字符` : `✗ 返回 ${chars} 字符` });
    this.schedulePaint();
  }

  onMaxSteps(max: number): void {
    pushLine(this.state, { kind: 'warn', text: `⚠️ 已达到最大步数（${max}），任务可能未完成` });
    this.state.status = '已中止';
    this.schedulePaint();
  }

  onUserMessage(text: string): void {
    pushLine(this.state, { kind: 'user', text: `❯ ${text}` });
    this.schedulePaint();
  }

  onTurnEnd(): void {
    pushLine(this.state, { kind: 'meta', text: '' });
    this.schedulePaint();
  }

  onWaitForInput(): void {
    this.state.status = '等待输入… Enter 发送 · Shift+Enter 换行 · /exit 退出';
    this.schedulePaint();
  }

  clearScrollback(): void {
    clearLines(this.state);
    this.schedulePaint();
  }

  showHelp(): void {
    pushLine(this.state, { kind: 'task', text: '帮助' });
    pushLine(this.state, { kind: 'meta', text: '直接输入消息开始对话，Enter 发送；Shift+Enter 换行（需终端支持修饰键；多行输入自动增高）。' });
    pushLine(this.state, { kind: 'meta', text: '/exit 退出 · /clear 清空上下文 · /help 显示帮助' });
    pushLine(this.state, { kind: 'meta', text: '滚动：鼠标滚轮 / PgUp/PgDn 翻页 · Ctrl+U/Ctrl+D 翻页（输入框为空）· ↑/↓ 逐行（输入框为空）· End 回到底部' });
    pushLine(this.state, { kind: 'meta', text: '完整命令参考：omni --help（控制台）' });
    this.schedulePaint();
  }
}

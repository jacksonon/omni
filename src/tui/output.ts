/**
 * TuiOutput：把 Agent 循环事件写入 TUI 状态，并调度一次重绘。
 *
 * 事件 → 状态写入 → schedulePaint（30ms 节流合并突发）→ paint() 重建渲染树。
 */
import type { ThinkingDisplay } from '../agent/types.js';
import type { OmniConfig } from '../config/index.js';
import type { Output, TokenUsage, ToolResultDetail } from '../output/types.js';
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
  /** 当前 spinner 状态栏文案后缀（思考中 / 执行中…；startSpinner 设置） */
  private spinnerLabel = '思考中';
  /** 统计行左侧 loading 定时器（200ms 一帧；独立于状态栏 spinner——流式期间
   * spinnerIndex 会被置 -1 但 loading 不受影响，会话进行中一直转） */
  private loadingTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * 会话进行中（interactive 每轮 runAgent 前 / 单任务模式）调用：统计行左侧
   * 显示 loading 并开始转圈；Esc 取消或会话结束 stopLoading 后消失。
   */
  startLoading(): void {
    this.state.loading = true;
    this.state.loadingIndex = 0;
    if (this.loadingTimer) return; // 已在转：幂等
    this.loadingTimer = setInterval(() => {
      this.state.loadingIndex = (this.state.loadingIndex + 1) % SPINNER_FRAMES.length;
      this.schedulePaint();
    }, 200);
  }

  /** 会话结束 / Esc 取消：隐藏 loading 并停掉动画定时器 */
  stopLoading(): void {
    this.state.loading = false;
    this.state.loadingIndex = -1;
    if (this.loadingTimer) {
      clearInterval(this.loadingTimer);
      this.loadingTimer = null;
    }
    this.schedulePaint();
  }

  /**
   * 取消当前回合的视觉反馈（右侧 loading + 状态栏 spinner/文案）——Esc //stop
   * 取消时**同步立即**调用（不等 runAgent 返回：逐 chunk abort 至多延迟一个 chunk
   * 间隔，期间 loading 不立即停、「思考中」残留会让用户以为取消没生效——用户反馈）。
   */
  cancelVisuals(): void {
    this.stopLoading();
    this.stopSpinner();
    this.state.spinnerIndex = -1;
    this.state.status = '';
    this.schedulePaint();
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
  /**
   * 启动 spinner 动画（200ms 一帧）：推进 spinnerIndex + 更新状态栏文案
   * （`${帧} ${label}`）。思考阶段 label=思考中；工具执行阶段 label=执行中…——
   * 两者共用同一套帧，卡片执行中行也从 spinnerIndex 取当前帧（动画 loading）。
   */
  private startSpinner(label = '思考中'): void {
    this.spinnerLabel = label;
    this.stopSpinner();
    this.spinnerTimer = setInterval(() => {
      if (this.state.spinnerIndex >= 0) {
        this.state.spinnerIndex = (this.state.spinnerIndex + 1) % SPINNER_FRAMES.length;
        const f = SPINNER_FRAMES[this.state.spinnerIndex];
        this.state.status = `${f} ${this.spinnerLabel}`;
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
    this.stopLoading(); // 退出前确保 loading 定时器不残留（setInterval 会拖住进程退出）
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
    this.startSpinner('思考中');
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
    // 会话累计 token 用量（footer 统计行展示；usage 来自流末 chunk，网关不支持时为 0）
    this.state.tokens.prompt += usage.prompt;
    this.state.tokens.completion += usage.completion;
    this.state.tokens.total += usage.total;
    this.state.stats.cached += usage.cached ?? 0;
    this.schedulePaint();
  }

  onTurnStart(): void {
    // 轮数：交互模式每轮用户提交 / 单次任务各 1 次（runAgent 开头触发）
    this.state.stats.turns += 1;
    this.schedulePaint();
  }

  onLlmLap(llmMs: number, firstTokenMs: number | null): void {
    // LLM 请求墙钟累计 + 首 token 延迟累计（平均 = sum/count）
    this.state.stats.llmMs += llmMs;
    if (firstTokenMs !== null) {
      this.state.stats.firstTokenSum += firstTokenMs;
      this.state.stats.firstTokenCount += 1;
    }
    this.schedulePaint();
  }

  onToolsLap(toolsMs: number): void {
    this.state.stats.toolsMs += toolsMs;
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

  onToolStep(step: number, maxSteps: number, name: string, argsPreview: string, args?: Record<string, unknown>): void {
    // 步数统计：每次工具调用 +1（footer 统计行）
    this.state.stats.steps += 1;
    // read_file 并行多读**合并成一张卡片**（对标 opencode 的 `→ Read N files`，点击
    // 展开逐条）：同一响应（onToolStep 连续触发、上一张卡片仍在执行中）的多读只更新
    // 已有卡片的路径列表与标题，不新建卡片——卡片行数不被并行读刷屏
    const path = args && typeof args.path === 'string' ? args.path : '';
    if (name === 'read_file' && path) {
      const last = this.state.lines[this.state.lines.length - 1];
      if (last?.kind === 'tool' && last.card?.status === 'running' && last.card.name === 'read_file') {
        const paths = last.card.paths ? [...last.card.paths] : [];
        if (!paths.includes(path)) paths.push(path);
        last.card.paths = paths;
        last.card.summary = `→ Read ${paths.length} files`;
        this.state.spinnerIndex = 0;
        this.state.status = `${SPINNER_FRAMES[0]} 执行中…`;
        this.startSpinner('执行中…');
        this.schedulePaint();
        return;
      }
    }
    // 工具调用画成卡片（kind='tool'）：标题 + 摘要；完成后收起、点击展开
    pushLine(this.state, {
      kind: 'tool',
      text: argsPreview,
      card: {
        id: ++this.toolSeq,
        name,
        summary: argsPreview,
        status: 'running',
        output: [],
        expanded: false,
        paths: name === 'read_file' && path ? [path] : undefined,
      },
    });
    // 工具执行中：启动 spinner 动画（卡片执行中行 + 状态栏都是动画 loading，
    // 而不是静态「⏳ 执行中…」——用户要求）；并行工具多次 onToolStep 幂等（startSpinner 重置定时器）
    this.state.spinnerIndex = 0;
    this.state.status = `${SPINNER_FRAMES[0]} 执行中…`;
    this.startSpinner('执行中…');
    this.schedulePaint();
  }

  onToolResult(ok: boolean, chars: number, preview?: string[], detail?: ToolResultDetail): void {
    // 找到最近一个执行中的卡片，填入结果（默认收起，点击展开看输出）；
    // 并行多读合并后只剩一张卡片：多次 onToolResult 中首个填结果，其余无执行中卡片自然跳过
    for (let i = this.state.lines.length - 1; i >= 0; i--) {
      const l = this.state.lines[i];
      if (l.kind === 'tool' && l.card?.status === 'running') {
        l.card.status = ok ? 'ok' : 'err';
        l.card.output = preview ?? [];
        l.card.chars = chars;
        if (detail) l.card.diff = detail.diff ?? null;
        break;
      }
    }
    // 并行工具：还有卡片在跑则保持 spinner；全部结束后停止动画（下一轮 onRound 重新启动）
    const stillRunning = this.state.lines.some((l) => l.kind === 'tool' && l.card?.status === 'running');
    if (!stillRunning) {
      this.stopSpinner();
      this.state.spinnerIndex = -1;
      this.state.status = '';
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
    // 兜底清理回合视觉（思考中/执行中阶段被取消时，onStreamStart/onToolResult 的清空
    // 不会执行——状态栏会残留「⠋ 思考中」+ spinner 定时器继续跑，用户反馈 ESC 后仍显示）
    this.stopSpinner();
    this.state.spinnerIndex = -1;
    this.state.status = '';
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
    pushLine(this.state, { kind: 'meta', text: '/theme 主题（亮/暗/跟随系统） · /permission 安全权限（低/中/高/全量） · /thinking 思考展开/折叠 · /plan 计划模式（只读调研） · /undo 撤销本次会话的文件修改 · /init [--global] 生成项目/全局记忆 · /exit 退出 · /clear 清空上下文 · /help 显示帮助' });
    pushLine(this.state, { kind: 'meta', text: '滚动：鼠标滚轮 / PgUp/PgDn 翻页 · Ctrl+U/Ctrl+D 翻页（输入框为空）· ↑/↓ 逐行（输入框为空）· End 回到底部' });
    pushLine(this.state, { kind: 'meta', text: '完整命令参考：omni --help（控制台）' });
    this.schedulePaint();
  }
}

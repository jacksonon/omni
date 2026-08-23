/**
 * TuiOutput：把 Agent 循环事件写入 TUI 状态，并调度一次重绘。
 *
 * 事件 → 状态写入 → schedulePaint（30ms 节流合并突发）→ paint() 重建渲染树。
 */
import type { ThinkingDisplay } from '../agent/types.js';
import type { OmniConfig } from '../config/index.js';
import type { HookEventName } from '../hooks/index.js';
import type { Output, TokenUsage, ToolResultDetail } from '../output/types.js';
import type { ApprovalRequest } from '../safety/index.js';
import type { AskResult } from '../tools/ask.js';
import { VERSION } from '../version.js';
import type { TuiSession } from './render.js';
import { appendLine, clearLines, openCmdPanel, pushCmdLine, pushLine, SPINNER_FRAMES, type TuiState, type ToolStatus } from './state.js';
import { t, tf } from './i18n.js';

export class TuiOutput implements Output {
  readonly exitOnCtrlC = true; // TUI 渲染器处理 Ctrl+C（有输入时清空输入框、空输入退出），main 不注册自己的 SIGINT
  readonly thinking: ThinkingDisplay;
  private paintTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 思考过程展示开关（/thinking 运行时切换；初始值来自配置 showThinking）。
   * false = start 不预建模块、write 不写 chunk（数据仍捕获落盘）；**已渲染的
   * 历史行由 buildBody 按 state.thinkingShow 过滤**——两层配合实现完整的显示/隐藏。
   */
  showThinking: boolean;

  constructor(
    private state: TuiState,
    opts: { showThinking: boolean },
    private session: TuiSession
  ) {
    this.showThinking = opts.showThinking !== false;
    const self = this; // thinking 对象方法里的 this 指向 thinking 本身，用闭包引用外层实例
    this.thinking = {
      get shown() {
        return self.thinkingShown;
      },
      start: () => {
        if (!self.showThinking) return; // /thinking 关闭：不建模块（重新开启后的轮次恢复）
        // 收到消息/新一轮思考开始：**立即创建 thinking 模块头行**（loading + thinking +
        // 实时耗时）——不等首个流式 chunk（用户要求「接收到消息开始 thinking 的时候就要
        // 显示 thinking，而不是收到流式返回才开始」）。内容为空只显示头行，chunk 到达后
        // appendLine 累积进同一行；若本轮无实际思考（finish 时仍为空）自动移除空模块。
        if (self.thinkingShown) return; // 防御：已在显示不重复建行
        self.thinkingShown = true;
        self.thinkingStart = Date.now();
        self.thinkingLineIdx = self.state.lines.length; // pushLine 追加到末尾
        pushLine(self.state, { kind: 'thinking', text: '', thinkingRunning: true, thinkingMs: 0 });
        self.schedulePaint();
      },
      write: (piece: string) => {
        if (!self.showThinking) return; // /thinking 关闭：不显示（reasoning 仍累积落盘）
        if (!self.thinkingShown) {
          // 兜底（onRound 未预建，如直接 write 的路径）：按旧逻辑首 chunk 建行
          self.thinkingShown = true;
          self.thinkingStart = Date.now();
          self.thinkingLineIdx = self.state.lines.length;
          pushLine(self.state, { kind: 'thinking', text: piece, thinkingRunning: true });
        } else {
          appendLine(self.state, 'thinking', piece);
        }
        self.refreshThinkingMs(); // 实时耗时
        self.schedulePaint();
      },
      finish: () => {
        // 思考区结束：写回最终耗时 + 清 running——头行从 `⠋ thinking · 实时耗时`
        // 变为 `- thinking · 耗时`（用户要求「思考完则显示为 - thinking + time」）。
        // 期间只有 appendLine 累积本段文本（无新行插入），下标保持有效。
        if (self.thinkingShown) {
          const li = self.state.lines[self.thinkingLineIdx];
          if (li && li.kind === 'thinking') {
            if (li.text === '') {
              // 本轮没有实际思考内容（模型直接回答/调工具）：移除预建的空模块，
              // 不残留 `- thinking · 0.0s` 空壳（此时该行必为最后一行，splice 安全）。
              // 同步清掉该下标的单独展开/收起标记——模块已移除，残留的旧下标会在
              // 后续思考模块占用同一下标时误伤（用户点击的收起态错位到新模块上）
              self.state.collapsedThinking.delete(self.thinkingLineIdx);
              self.state.expandedThinking.delete(self.thinkingLineIdx);
              self.state.lines.splice(self.thinkingLineIdx, 1);
            } else {
              li.thinkingMs = Date.now() - self.thinkingStart;
              li.thinkingRunning = false;
            }
          }
        }
        self.thinkingShown = false;
        self.thinkingStart = 0;
        self.thinkingLineIdx = -1;
        self.schedulePaint();
      },
    };
  }

  /** 思考区生命周期（thinking 模块）：正在流式思考 + 起始时间 + 行下标。onRound
   *  预建头行（用户要求收到消息即显示 thinking），spinner 定时器每 200ms 刷新头行
   *  实时耗时（含首 chunk 前的等待期）。 */
  private thinkingShown = false;
  private thinkingStart = 0;
  private thinkingLineIdx = -1;
  /** 当次对话轮（onTurnStart → onTurnEnd）内每次 LLM 请求的 token 用量（onUsage 按
   *  请求顺序收集；onTurnEnd 组装成 tokens 模块插入对话流——收起=汇总/展开=逐次明细） */
  private turnUsages: TokenUsage[] = [];

  /** 更新当前流式思考行的实时耗时（头行 `· N.Ns`；spinner 定时器每 200ms + write 时调用） */
  private refreshThinkingMs(): void {
    if (!this.thinkingShown || this.thinkingLineIdx < 0) return;
    const li = this.state.lines[this.thinkingLineIdx];
    if (li && li.kind === 'thinking') li.thinkingMs = Date.now() - this.thinkingStart;
  }

  /** spinner 定时器（200ms 间隔循环动画帧） */
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  /** 当前 spinner 状态栏文案后缀（现在恒为空——思考/执行阶段状态栏都不写文案，
   *  只靠 spinnerIndex 推进卡片/头行 loading 帧；startSpinner 设置） */
  private spinnerLabel = '';
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
   * 取消当前回合的视觉反馈（右侧 loading + 状态栏 spinner/文案）——Esc 取消
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
   * 启动 spinner 动画（200ms 一帧）：推进 spinnerIndex（思考头行/工具卡片取当前帧）。
   * 思考与工具执行阶段都传 label=''——**状态栏不再写「思考中/执行中」文案**（用户要求
   * 不再依赖这一类文本，状态由思考头行 ⠋ thinking · 耗时 与卡片 loading 直观表达）；
   * label 非空的分支保留（未来若有需要显示文案的 spinner 场景可直接用）。
   */
  private startSpinner(label = ''): void {
    this.spinnerLabel = label;
    this.stopSpinner();
    this.spinnerTimer = setInterval(() => {
      if (this.state.spinnerIndex >= 0) {
        this.state.spinnerIndex = (this.state.spinnerIndex + 1) % SPINNER_FRAMES.length;
        this.refreshThinkingMs(); // 思考头行实时耗时随帧刷新（含首 chunk 前的等待期）
        if (this.spinnerLabel) {
          const f = SPINNER_FRAMES[this.state.spinnerIndex];
          this.state.status = `${f} ${this.spinnerLabel}`;
        }
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
    this.state.status = tf(this.state.language, 'status.ready', { model: cfg.model });
    this.schedulePaint();
  }

  private toolSeq = 0;

  onRound(_step: number, _maxSteps: number): void {
    // 新一轮 LLM 请求（思考阶段）开始：启动 spinner 动画——**只推进 spinnerIndex 驱动
    // 思考模块头行的 loading 帧**，状态栏不再写「思考中」文案（用户要求「不再依赖思考中/
    // 执行中这一类文本」——思考状态由头行 ⠋ thinking · 耗时 直观表达）。
    this.state.spinnerIndex = 0;
    this.state.generating = false;
    this.state.status = ''; // 思考中不显示状态栏文案
    this.startSpinner('');
    // 收到消息开始思考：**立即显示 thinking 模块头行**（loading + thinking + 实时耗时），
    // 不等首个流式 chunk（用户要求「接收到消息开始 thinking 的时候就要显示 thinking」）
    this.thinking.start?.();
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
    // 当次统计：按请求顺序收集（一轮可能多次 LLM 请求——多步工具调用每步各一次）
    this.turnUsages.push(usage);
    this.schedulePaint();
  }

  onTurnStart(): void {
    // 轮数：交互模式每轮用户提交 / 单次任务各 1 次（runAgent 开头触发）
    this.state.stats.turns += 1;
    this.turnUsages = []; // 新一轮：重置当次 token 收集
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
    const lang = this.state.language;
    this.state.status = t(lang, 'status.requestFailed');
    pushLine(this.state, { kind: 'warn', text: `${t(lang, 'status.requestFailed')}：${(err as Error)?.message ?? String(err)}` });
    this.schedulePaint();
  }

  /** fallback 回退成功（P0）：meta 行提示（对话流可见，不打断流程） */
  onFallback(model: string): void {
    pushLine(this.state, { kind: 'meta', text: `↩ 已回退到备用模型 ${model}` });
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
        this.state.status = ''; // 执行中不显示状态栏文案（下方「执行中」不需要显示——用户要求）
        this.startSpinner('');
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
    // 工具执行中：启动 spinner 动画（**卡片执行中行**显示动画 loading——用户要求；状态栏
    // 不再显示「执行中…」——下方执行中不需要显示，用户要求）。并行工具多次 onToolStep
    // 幂等（startSpinner 重置定时器）；spinnerIndex 推进驱动卡片帧，status 留空
    this.state.spinnerIndex = 0;
    this.state.status = ''; // 执行中不显示状态栏文案
    this.startSpinner('');
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
    this.state.status = t(this.state.language, 'status.aborted');
    this.schedulePaint();
  }

  /** hooks 输出回显（生命周期自动化）：写入对话流 meta 行（dim，不打断流程） */
  onHookOutput(event: HookEventName, lines: string[]): void {
    for (const l of lines) pushLine(this.state, { kind: 'meta', text: `⚡ hook[${event}] ${l}` });
    this.schedulePaint();
  }

  /**
   * 子代理进度事件（第六节 P1 可视化）：更新**最近一个执行中的 delegate 卡片**——
   * 委托中可见 live 状态（`子代理 X · ⠋ search_code 3/10`——step 事件带当前动作），
   * 完成后把**结果摘要**存进 card.subagent（收起态显示命令行 + `✓ 5 步 · 结果首行`，
   * 不覆盖命令行）。嵌套子代理的事件沿同一回调链汇聚到同一张卡片（只显示最内层
   * 活跃子代理的进度——精确嵌套树在 /trace 面板，见 foldTrace 的 subagent 行）。
   * 并行多委托时各事件按到达顺序更新同一卡片，最终 onToolResult 填各自结果。
   */
  onSubagentEvent(ev: import('../agent/types.js').SubagentEvent): void {
    const card = this.findRunningDelegateCard();
    if (!card) return;
    if (ev.type === 'start') {
      // start：保存原命令行（onToolStep 的 argsPreview），运行中显示进度；
      // end 时还原命令行（end 事件不带 task，不能靠它重建）
      if (card._cmd === undefined) card._cmd = card.summary;
      card.summary = `子代理 ${ev.name} · 运行中${ev.depth > 0 ? `（深度 ${ev.depth}）` : ''}`;
    } else if (ev.type === 'step') {
      card.summary = `子代理 ${ev.name} · ⠋ ${ev.tool ?? '思考中'} ${ev.step}/${ev.maxSteps}`;
      card.status = 'running';
      this.state.spinnerIndex = 0; // 委托中保持卡片 loading 帧
    } else {
      // end：结果摘要存进 card.subagent + 还原命令行；收起态渲染
      // 命令行 + `✓ N 步 · 结果首行`（第二层预览：结果比命令重要，对标 write diff）
      card.subagent = {
        name: ev.name,
        ok: ev.status === 'ok',
        steps: ev.steps ?? 0,
        summary: (ev.summary ?? '').split('\n')[0] || undefined,
      };
      if (card._cmd !== undefined) card.summary = card._cmd;
    }
    this.schedulePaint();
  }

  /** 找最近一个执行中的 delegate 卡片（子代理进度事件的目标；无则返回 null） */
  private findRunningDelegateCard(): {
    name: string;
    summary: string;
    status: ToolStatus;
    _cmd?: string;
    subagent?: { name: string; ok: boolean; steps: number; summary?: string };
  } | null {
    for (let i = this.state.lines.length - 1; i >= 0; i--) {
      const l = this.state.lines[i];
      if (l.kind === 'tool' && l.card?.name === 'delegate' && l.card.status === 'running') return l.card;
    }
    return null;
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
    this.state.status = tf(this.state.language, 'status.approval', { tool: next.req.tool });
    this.schedulePaint();
  }

  /**
   * 向用户提问（ask_user 工具）：打开输入区上方的选项面板（问题 + A/B/C/D 选项 +
   * 自定义输入提示），resolver 挂在 state.askResolve 上——startTui（字母键/鼠标）与
   * interactive（Enter 自定义提交）无需反向依赖 TuiOutput 即可完成提问。
   * 并行多个提问串行展示（与审批卡片同队列模式）。
   */
  private askQueue: { question: string; options: string[]; multiple: boolean; resolve: (r: AskResult | null) => void }[] = [];
  askUser(question: string, options: string[], multiple: boolean): Promise<AskResult | null> {
    return new Promise((resolve) => {
      this.askQueue.push({ question, options, multiple, resolve });
      this.showNextAsk();
    });
  }

  private showNextAsk(): void {
    if (this.state.ask || this.askQueue.length === 0) return; // 已有面板在等 → 排队
    const next = this.askQueue.shift()!;
    this.state.ask = {
      question: next.question,
      options: next.options,
      multiple: next.multiple,
      selected: new Set(),
      custom: '',
      cursor: 0,
    };
    this.state.askResolve = (r: AskResult | null) => {
      this.state.ask = null;
      this.state.askResolve = null;
      this.state.status = '';
      next.resolve(r);
      this.schedulePaint();
      this.showNextAsk(); // 串行：处理队列里的下一条
    };
    this.state.status = t(this.state.language, 'status.ask');
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
    // 当次 token 使用统计（用户要求「每一次发送消息、返回消息结束后，增加当次 token
    // 使用统计。输入多少、输出、缓存」）：默认收起显示汇总，点击展开看每次 LLM 请求的
    // 明细（输入/输出/缓存，一行一条，加起来 = 汇总）。/tokens 关闭时不插入（数据
    // 仍从 onUsage 收集，重新打开后后续轮次恢复显示）
    if (this.state.showTokens && this.turnUsages.length > 0) {
      pushLine(this.state, {
        kind: 'tokens',
        text: '',
        tokens: { usages: [...this.turnUsages], expanded: false },
      });
    }
    this.turnUsages = [];
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
    // /clear 清空全部内容行：thinking 内部状态同步复位——否则行下标全部失效，
    // 残留的 thinkingShown/thinkingLineIdx 会让下一轮 start() 被挡或 finish 操作错行
    this.thinkingShown = false;
    this.thinkingStart = 0;
    this.thinkingLineIdx = -1;
    this.schedulePaint();
  }

  showHelp(): void {
    // 帮助文本输出到**命令面板**（独立窗口）——不混进对话流（用户要求所有命令输出
    // 弹窗展示；commands.ts 的 /help 命令同此实现，接口保留供 console/兼容调用）
    const lang = this.state.language;
    openCmdPanel(this.state, '/help');
    pushCmdLine(this.state, { kind: 'meta', text: t(lang, 'help.intro') }, '/help');
    pushCmdLine(this.state, { kind: 'meta', text: t(lang, 'help.commands') }, '/help');
    pushCmdLine(this.state, { kind: 'meta', text: t(lang, 'help.scroll') }, '/help');
    pushCmdLine(this.state, { kind: 'meta', text: t(lang, 'help.more') }, '/help');
    this.schedulePaint();
  }
}

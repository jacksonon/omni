/**
 * TuiOutput：把 Agent 循环事件写入 TUI 状态，并调度一次重绘。
 *
 * 事件 → 状态写入 → schedulePaint（30ms 节流合并突发）→ paint() 重建渲染树。
 */
import { execSync } from 'node:child_process';
import type { ThinkingDisplay } from '../agent/types.js';
import type { OmniConfig } from '../config/index.js';
import type { HookEventName } from '../hooks/index.js';import type { Output, StreamProgress, TokenUsage, ToolResultDetail } from '../output/types.js';
import type { ApprovalRequest } from '../safety/index.js';
import type { AskResult } from '../tools/ask.js';
import { VERSION } from '../version.js';
import type { TuiSession } from './render.js';
import { appendLine, clearLines, DELEGATE_ITEM_MAX, openCmdPanel, pushCmdLine, pushLine, pushToast, SPINNER_FRAMES, type DelegateRun, type TuiState, type ToolStatus, type TuiToastType } from './state.js';
import { t, tf } from './i18n.js';

export class TuiOutput implements Output {
  readonly exitOnCtrlC = true; // TUI 渲染器处理 Ctrl+C（有输入时清空输入框、空输入退出），main 不注册自己的 SIGINT
  readonly thinking: ThinkingDisplay;

  /** 弹出右上角 toast（Alert notification）：短暂显示后自动消失，不占对话流 */
  pushToast(text: string, type: TuiToastType = 'info'): void {
    pushToast(this.state, text, type);
    this.schedulePaint();
  }
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
    // toast 自动消失定时器需要触发重绘：把 schedulePaint 注入 state（pushToast 内部使用）
    state.schedulePaint = () => this.schedulePaint();
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
  /** 兼容兜底（模型把思考直接写进 content）：contentThoughtMode = 当前回答处在
   *  「以思考标记开头的模型思考文本」模式（onAnswer 折叠进思考模块）；
   *  contentThoughtIdx = 承载该内容的 thinking 行下标（onAnswerEnd 复位）。 */
  private contentThoughtMode = false;
  private contentThoughtIdx = -1;
  /** 当次对话轮（onTurnStart → onTurnEnd）内每次 LLM 请求的 token 用量（onUsage 按
   *  请求顺序收集；onTurnEnd 组装成 tokens 模块插入对话流——收起=汇总/展开=逐次明细） */
  private turnUsages: TokenUsage[] = [];
  private turnLlmMs = 0;
  private turnGenMs = 0;
  private turnFirstTokenSum = 0;
  private turnFirstTokenCount = 0;

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
  /** 模型行 loading（footerLoad）定时器（200ms 一帧；独立于状态栏 spinner——流式期间
   * spinnerIndex 会被置 -1 但 loading 不受影响，会话进行中一直转） */
  private loadingTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * 会话进行中（interactive 每轮 runAgent 前 / 单任务模式）调用：模型行显示
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
   * 取消当前回合的视觉反馈（模型行 loading + 状态栏 spinner/文案）——Esc 取消
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

  onStreamProgress(progress: StreamProgress): void {
    // 流式增量暂存（底部会话平均速率含这部分；onLlmLap 折入累计后清零，避免重复计数）
    this.state.liveTokens = progress.streamTokens;
    this.state.liveGenMs = progress.liveGenMs;
    this.schedulePaint();
  }

  onAnswer(text: string): void {
    // 兼容兜底：部分本地模型（ollama 等）不输出 reasoning 字段，把思考直接写进 content
    // 并以思考标记（thought/thinking/reasoning/<thinking>）开头——若按 answer 平铺会污染
    // 对话流（裸 "thought" 字面量 + 一大段思考正文）。识别后折叠进思考模块（头行
    // `- Thought:` + 可点击展开），与 reasoning 字段的展示路径对齐；正常模型（走
    // reasoning 字段 / content 不以思考标记开头）走下方原 answer 路径，完全不受影响。
    if (!this.contentThoughtMode && /^(?:thought|thinking|reasoning)[\s:：]|<thinking>/i.test(text)) {
      this.contentThoughtMode = true;
      this.contentThoughtIdx = this.state.lines.length;
      // 剥离模型自带的思考标记字面量（thought\n / thinking: / <thinking> 等）——仅展示层，
      // 落盘 content 保持原样（会话文件/上下文不回改）；空则留空行待后续 chunk 追加
      const stripped = text.replace(/^(?:thought|thinking|reasoning)[\s:：]*\n?|<thinking>\s*\n?/i, '');
      pushLine(this.state, { kind: 'thinking', text: stripped, thinkingRunning: false });
      this.schedulePaint();
      return;
    }
    if (this.contentThoughtMode) {
      // 后续 chunk 追加进同一思考模块（appendLine 找最后一个 thinking 行）
      appendLine(this.state, 'thinking', text);
      this.schedulePaint();
      return;
    }
    appendLine(this.state, 'answer', text);
    this.schedulePaint();
  }

  onAnswerEnd(): void {
    this.state.generating = false;
    this.state.liveTokens = 0;
    this.state.liveGenMs = 0;
    this.contentThoughtMode = false;
    this.contentThoughtIdx = -1;
    this.schedulePaint();
  }

  onUsage(usage: TokenUsage): void {
    // 会话累计 token 用量（footer 统计行展示；usage 来自流末 chunk，网关不支持时为 0）
    this.state.tokens.prompt += usage.prompt;
    this.state.tokens.completion += usage.completion;
    this.state.tokens.total += usage.total;
    this.state.stats.cached += usage.cached ?? 0;
    // 当前上下文大小 = 最近一次请求的 prompt token（每次覆盖——footer context 段用）
    this.state.lastPromptTokens = usage.prompt;
    // 当次统计：按请求顺序收集（一轮可能多次 LLM 请求——多步工具调用每步各一次）
    this.turnUsages.push(usage);
    this.schedulePaint();
  }

  onTurnStart(): void {
    // 轮数：交互模式每轮用户提交 / 单次任务各 1 次（runAgent 开头触发）
    this.state.stats.turns += 1;
    this.turnUsages = []; // 新一轮：重置当次 token 收集
    this.turnLlmMs = 0;
    this.turnGenMs = 0;
    this.turnFirstTokenSum = 0;
    this.turnFirstTokenCount = 0;
    this.refreshGitBranch(); // 左侧文件夹分支每轮刷新一次（分支切换即时跟上，又不至于每帧 spawn）
    this.schedulePaint();
  }

  onLlmLap(llmMs: number, firstTokenMs: number | null, genMs?: number): void {
    // LLM 请求墙钟累计 + 首 token 延迟累计（平均 = sum/count）+ 纯生成耗时（tok/s 用）
    this.state.stats.llmMs += llmMs;
    this.turnLlmMs += llmMs;
    if (firstTokenMs !== null) {
      this.state.stats.firstTokenSum += firstTokenMs;
      this.state.stats.firstTokenCount += 1;
      this.turnFirstTokenSum += firstTokenMs;
      this.turnFirstTokenCount += 1;
    }
    if (genMs !== undefined) {
      this.state.stats.genMs += genMs;
      this.turnGenMs += genMs;
    }
    // 本轮流式增量已折入累计：清零 live 暂存（后到的 usage 事件不再重复计入底部均值）
    this.state.liveTokens = 0;
    this.state.liveGenMs = 0;
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
    // 请求失败 → 右上角错误 toast（对话流 warn 行保留，双通道提示）
    this.pushToast(`${t(lang, 'status.requestFailed')}：${(err as Error)?.message ?? String(err)}`, 'error');
    this.schedulePaint();
  }

  /** fallback 回退成功（P0）：meta 行提示（对话流可见，不打断流程） */
  onFallback(model: string): void {
    pushLine(this.state, { kind: 'meta', text: tf(this.state.language, 'meta.fallbackModel', { model }) });
    this.schedulePaint();
  }

  onThinkingSaved(_len: number, _file: string | null): void {
    // TUI 中思考已完整展示，无需落盘提示
  }

  /**
   * 恢复历史会话：回放一个已完成的思考块（头行 `- thinking · 耗时` + 完整内容），
   * 与实时思考模块一致支持点击展开/收起（全部行带 thinkingIdx）。
   * ms 缺失（旧会话）→ 头行无耗时（rows.ts 按 thinkingMs != null 条件追加）。
   * /thinking 关闭（showThinking=false）时不回放思考块（与实时行为对齐）。
   */
  onThinkingRestored(text: string, ms?: number): void {
    if (!this.showThinking || !text) return;
    pushLine(this.state, { kind: 'thinking', text, thinkingRunning: false, thinkingMs: ms });
    this.schedulePaint();
  }

  onToolStep(step: number, maxSteps: number, name: string, argsPreview: string, args?: Record<string, unknown>, toolSeq?: number): void {
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
    // 工具调用画成卡片（kind='tool'）：标题 + 摘要；完成后收起、点击展开。
    // seq = loop 工具配对序号（子代理事件/停止用它精确配对；见 ToolCard.seq 注释）。
    // **delegate 例外**（输入区上方 command 面板模型）：运行中不入对话流（不 pushLine），
    // 而是 upsert 到 state.delegateRuns 面板行——完成后由 onToolResult 从面板移除、
    // 往对话流 push 一张结果卡（流内留最终结果，运行过程在输入区正上方实时可见）。
    if (name === 'delegate') {
      const seq = toolSeq;
      if (seq == null) {
        // 无配对序号（非 loop 直驱，如 /orchestrate worker）：仍画成普通流卡兜底
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
          },
        });
        return;
      }
      const existing = this.state.delegateRuns.find((r) => r.seq === seq);
      if (existing) {
        existing.title = argsPreview;
        existing.status = t(this.state.language, 'subagent.status.running');
      } else {
        this.state.delegateRuns.push({
          seq,
          title: argsPreview,
          name: 'delegate',
          status: t(this.state.language, 'subagent.status.running'),
          stopped: false,
          stopRequested: false,
          ended: false,
          failed: false,
          expanded: false,
          items: [],
          dropped: 0,
        });
      }
      this.state.spinnerIndex = 0;
      this.state.status = '';
      this.startSpinner('');
      this.schedulePaint();
      return;
    }
    pushLine(this.state, {
      kind: 'tool',
      text: argsPreview,
      card: {
        id: ++this.toolSeq,
        seq: toolSeq,
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

  onToolResult(ok: boolean, chars: number, preview?: string[], detail?: ToolResultDetail, toolSeq?: number): void {
    // delegate 子代理完成：面板行 → 流内结果卡（用配对 seq 精确路由，不依赖到达顺序）
    if (this.finishDelegateRun(toolSeq, ok, chars, preview)) return;
    // 找到最近一个执行中的卡片，填入结果（默认收起，点击展开看输出）；
    // 并行多读合并后只剩一张卡片：多次 onToolResult 中首个填结果，其余无执行中卡片自然跳过
    for (let i = this.state.lines.length - 1; i >= 0; i--) {
      const l = this.state.lines[i];
      if (l.kind === 'tool' && l.card?.status === 'running') {
        l.card.status = ok ? 'ok' : 'err';
        l.card.output = preview ?? [];
        l.card.chars = chars;
        if (l.card.name === 'list_directory' && preview && preview.length && !l.card.summary.includes('(')) {
          let count = 0;
          const first = preview[0] ?? '';
          const m = first.match(/(\d+)\s*个/);
          if (m) count = parseInt(m[1], 10);
          else count = preview.filter((line) => line.trim() && !line.startsWith('…')).length;
          if (count > 0) l.card.summary = `${l.card.summary} (${count} items)`;
        }
        if (l.card.name === 'search_code' && preview && preview.length && !l.card.summary.includes('(')) {
          let matches = 0;
          const first = preview[0] ?? '';
          const m = first.match(/(\d+)\s*处/);
          if (m) matches = parseInt(m[1], 10);
          else matches = preview.filter((line) => line.trim() && !line.startsWith('…') && !line.includes('匹配结果')).length;
          l.card.summary = `${l.card.summary} (${matches} match${matches > 1 ? 'es' : ''})`;
        }
        if (detail) l.card.diff = detail.diff ?? null;
        if (detail?.edit !== undefined) l.card.edit = detail.edit;
        // run_command 实时输出已并入 final output——清空 liveLines 避免重复渲染
        if (l.card.liveLines) l.card.liveLines = undefined;
        // 智能默认展开规则（用户拍板）：
        // · write_file / edit_file → 永远默认展开（写操作的 diff 必须第一时间可见，建立信任）
        // · run_command 失败 → 强制展开（错误是排错入口）
        // · read_file / search_code / list_directory → 始终默认收起（信息量大但通常不是当下决策点）
        // · run_command 成功 → 收起（成功只是确认，符合预期）
        if (!ok) {
          // 失败强制展开：所有工具失败都展开，让用户第一时间看到错误
          l.card.expanded = true;
        } else if (l.card.name === 'write_file' && l.card.diff) {
          // write_file 永远展开：新建/修改/全文重写，diff 是用户 review 的核心
          l.card.expanded = true;
        } else if (l.card.name === 'edit_file' && l.card.edit) {
          // edit_file 永远展开：精确替换的 before/after 必须看到
          l.card.expanded = true;
        }
        // run_command 成功、read_file、search_code、list_directory → 保持默认收起
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

  /**
   * run_command 实时输出：找到对应 seq 的执行中卡片，追加到 liveLines（ring 8 行），
   * 触发 schedulePaint —— TUI rows 会用 `tail` 风格显示（最近几行 + `…` 折叠提示）。
   * onToolResult 到达时清空 liveLines，由 final preview 接管。
   */
  onCommandOutput(chunk: string, _isError: boolean, toolSeq?: number): void {
    if (toolSeq == null) return;
    // 倒序找 seq 对应的卡片（toolSeq 是该次响应的配对序号）
    for (let i = this.state.lines.length - 1; i >= 0; i--) {
      const l = this.state.lines[i];
      if (l.kind === 'tool' && l.card?.status === 'running' && l.card.id === toolSeq) {
        if (!l.card.liveLines) l.card.liveLines = [];
        for (const line of chunk.split('\n')) {
          if (!line) continue;
          l.card.liveLines.push(line);
          if (l.card.liveLines.length > 8) l.card.liveLines.shift();
        }
        this.schedulePaint();
        return;
      }
    }
  }

  onMaxSteps(max: number): void {
    pushLine(this.state, { kind: 'warn', text: tf(this.state.language, 'meta.maxSteps', { max }) });
    this.state.status = t(this.state.language, 'status.aborted');
    this.schedulePaint();
  }

  /** hooks 输出回显（生命周期自动化）：写入对话流 meta 行（dim，不打断流程） */
  onHookOutput(event: HookEventName, lines: string[]): void {
    for (const l of lines) pushLine(this.state, { kind: 'meta', text: `hook[${event}] ${l}` });
    this.schedulePaint();
  }

  /**
   * 子代理进度事件（1.0 可视化扩展）：delegate 子代理生命周期 + 执行明细。
   *
   * 目标：state.delegateRuns 面板行（输入框正上方 command 样式面板）——优先按
   * **seq 精确配对**（loop toolSeq），并行多委托各自一行、事件归集互不覆盖；
   * 无 seq（/orchestrate 直驱、旧链路）回退「最近一个运行中的 delegate 面板行」。
   * end/stopped 到达时面板行保留（等待 onToolResult 收尾→移除+流内结果卡）。
   */
  onSubagentEvent(ev: import('../agent/types.js').SubagentEvent): void {
    const run = this.findDelegateRun(ev);
    if (!run) return;
    const lang = this.state.language;
    if (ev.type === 'start') {
      run.name = ev.name;
      run.task = ev.task;
      run.status = ev.depth > 0 ? tf(lang, 'subagent.status.runningDepth', { depth: ev.depth }) : t(lang, 'subagent.status.running');
    } else if (ev.type === 'step') {
      run.status = `${ev.tool ?? t(lang, 'subagent.status.thinking')} ${ev.step}/${ev.maxSteps}`;
      this.state.spinnerIndex = 0; // 委托中保持底部 loading 帧
    } else if (ev.type === 'think') {
      // 思考增量：追加明细（展开就地显示；截断防单条过长——run.items 上限兜底）
      const text = (ev.text ?? '').slice(0, 400);
      if (text) this.pushRunItem(run, { kind: 'think', text });
    } else if (ev.type === 'toolStart') {
      // 工具开始：追加工具条目（摘要行，展开后与主循环工具卡同构）
      this.pushRunItem(run, { kind: 'tool', text: ev.argsPreview || ev.text || t(lang, 'subagent.status.tool') });
      run.status = `⠋ ${ev.text ?? t(lang, 'subagent.status.tool')}…`;
    } else if (ev.type === 'toolEnd') {
      // 工具结束：结果条目（✓/✗ + 输出预览首行截断）
      this.pushRunItem(run, {
        kind: 'result',
        ok: ev.toolOk !== false,
        text: (ev.outputPreview ?? []).join('\n').slice(0, 300),
      });
    } else if (ev.type === 'stopped') {
      run.stopped = true;
      run.ended = true;
      run.status = t(lang, 'subagent.status.stopped');
    } else {
      // end：面板行状态收尾（onToolResult 到达后移除面板、流内留结果卡）
      run.ended = true;
      run.failed = ev.status !== 'ok';
      run.status = ev.status === 'ok' ? tf(lang, 'subagent.status.doneSteps', { steps: ev.steps ?? 0 }) : t(lang, 'subagent.status.failed');
      run.name = ev.name;
    }
    this.schedulePaint();
  }

  /** 找子代理事件的目标面板行：优先按 seq（loop 配对序号）精确配对；无 seq 回退最近运行中 */
  private findDelegateRun(ev: import('../agent/types.js').SubagentEvent): DelegateRun | null {
    if (ev.seq != null) {
      const r = this.state.delegateRuns.find((x) => x.seq === ev.seq);
      if (r) return r;
    }
    for (let i = this.state.delegateRuns.length - 1; i >= 0; i--) {
      const r = this.state.delegateRuns[i]!;
      if (!r.stopped && !r.stopRequested && !r.ended) return r;
    }
    return null;
  }

  /** 追加一条面板行明细（超限截断：丢最早、计数 dropped——防超长子代理把面板撑爆） */
  private pushRunItem(run: DelegateRun, item: DelegateRun['items'][number]): void {
    run.items.push(item);
    if (run.items.length > DELEGATE_ITEM_MAX) {
      run.items.shift();
      run.dropped += 1;
    }
  }

  /**
   * delegate 完成收尾（onToolResult 调用）：从输入区上方面板移除该行，往对话流
   * push 一张**结果卡**（流内留最终结果；卡片含 subagent 摘要与全过程明细——点击
   * 展开可回看思考/工具）。stopped 的 run 同样收尾（结果卡标注已停止）。
   * 返回是否处理了 delegate（调用方据此跳过普通工具卡收尾）。
   */
  private finishDelegateRun(seq: number | undefined, ok: boolean, chars: number, preview?: string[]): boolean {
    if (seq == null) return false;
    const idx = this.state.delegateRuns.findIndex((r) => r.seq === seq);
    if (idx < 0) return false;
    const [run] = this.state.delegateRuns.splice(idx, 1);
    const stopped = run.stopped || run.stopRequested;
    const doneOk = ok && !stopped;
    // 结果卡（收起态显示 `✓ N 步 · 结果首行`；展开看明细）——summary 还原为委托标题
    pushLine(this.state, {
      kind: 'tool',
      text: run.title,
      card: {
        id: ++this.toolSeq,
        seq: run.seq,
        name: 'delegate',
        summary: run.title,
        status: stopped ? 'err' : doneOk ? 'ok' : 'err',
        output: preview ?? [],
        chars,
        expanded: false,
        subagent: {
          name: run.name || 'delegate',
          ok: doneOk,
          steps: 0,
          summary: preview?.find((l) => l.trim())?.slice(0, 120) || (stopped ? t(this.state.language, 'subagent.status.stopped') : undefined),
        },
        subagentDetail: run.items.length > 0 || run.dropped > 0
          ? { status: run.status, stopped, items: run.items, dropped: run.dropped }
          : undefined,
      },
    });
    // 并行工具：还有面板行/卡片在跑则保持 spinner；全部结束停止动画
    const stillRunning =
      this.state.delegateRuns.length > 0 ||
      this.state.lines.some((l) => l.kind === 'tool' && l.card?.status === 'running');
    if (!stillRunning) {
      this.stopSpinner();
      this.state.spinnerIndex = -1;
      this.state.status = '';
    }
    this.schedulePaint();
    return true;
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

  /** 左侧文件夹后的 git 分支（非 git 目录为 null 则不显示；每轮刷新一次，TTL 兜底） */
  private gitBranchAt = 0;
  refreshGitBranch(): void {
    if (Date.now() - this.gitBranchAt < 5000) return;
    this.gitBranchAt = Date.now();
    try {
      const out = execSync('git rev-parse --abbrev-ref HEAD', { cwd: this.state.cwd, timeout: 1500, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      this.state.gitBranch = out && out !== 'HEAD' ? out : null;
    } catch {
      this.state.gitBranch = null;
    }
  }

  onTurnEnd(): void {
    // 兜底清理回合视觉（思考中/执行中阶段被取消时，onStreamStart/onToolResult 的清空
    // 不会执行——状态栏会残留「⠋ 思考中」+ spinner 定时器继续跑，用户反馈 ESC 后仍显示）
    this.stopSpinner();
    this.state.spinnerIndex = -1;
    this.state.status = '';
    // 回合结束兜底：清空 delegate 面板残留（正常路径 onToolResult 已逐个移除；
    // 取消/异常中断时可能有未收尾 run——delegate 子代理继续在后台跑，面板行不再显示）
    this.state.delegateRuns.length = 0;
    // 当次 token 使用统计（用户要求「每一次发送消息、返回消息结束后，增加当次 token
    // 使用统计。输入多少、输出、缓存」）：默认收起显示汇总，点击展开看每次 LLM 请求的
    // 明细（输入/输出/缓存，一行一条，加起来 = 汇总）。/tokens 关闭时不插入（数据
    // 仍从 onUsage 收集，重新打开后后续轮次恢复显示）
    if (this.state.showTokens && this.turnUsages.length > 0) {
      pushLine(this.state, {
        kind: 'tokens',
        text: '',
        tokens: {
          usages: [...this.turnUsages],
          expanded: false,
          model: this.state.model,
          durMs: this.turnLlmMs,
          genMs: this.turnGenMs,
          firstTokenAvg: this.turnFirstTokenCount > 0 ? this.turnFirstTokenSum / this.turnFirstTokenCount : null,
          plan: this.state.planMode, // 本轮模式快照（头行 Plan/Build + 模式色——与输入区模型行一致）
        },
      });
    }
    this.turnUsages = [];
    this.turnLlmMs = 0;
    this.turnGenMs = 0;
    this.turnFirstTokenSum = 0;
    this.turnFirstTokenCount = 0;
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
    // 运行中 delegate 面板行是会话级临时 UI（非对话记录）：/clear 一并清空
    this.state.delegateRuns.length = 0;
    // /clear 清空全部内容行：thinking 内部状态同步复位——否则行下标全部失效，
    // 残留的 thinkingShown/thinkingLineIdx 会让下一轮 start() 被挡或 finish 操作错行
    this.thinkingShown = false;
    this.thinkingStart = 0;
    this.thinkingLineIdx = -1;
    this.contentThoughtMode = false;
    this.contentThoughtIdx = -1;
    // /clear = 新一轮会话：会话级累计统计一并归零（与 restoreSession 重建前清零同一
    // 清单）——否则模型行的会话平均速率（tok/s）与灰块外底行的输入/输出/缓存/上下文
    // 仍显示上一段的累计值，与「整段对话已清空」不符
    this.state.stats = { turns: 0, steps: 0, llmMs: 0, toolsMs: 0, firstTokenSum: 0, firstTokenCount: 0, genMs: 0, cached: 0 };
    this.state.tokens = { prompt: 0, completion: 0, total: 0 };
    this.state.lastPromptTokens = 0;
    this.state.liveTokens = 0;
    this.state.liveGenMs = 0;
    this.turnUsages = [];
    this.turnLlmMs = 0;
    this.turnGenMs = 0;
    this.turnFirstTokenSum = 0;
    this.turnFirstTokenCount = 0;
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

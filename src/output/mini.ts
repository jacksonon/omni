/** 供轮内输入接管使用的宽松 stdin 视图（摘/装 readline 监听器需要按事件名透传） */
type StdinListener = (...args: unknown[]) => void;
interface LooseStdin {
  listeners(event: string): StdinListener[];
  on(event: string, listener: StdinListener): unknown;
  off(event: string, listener: StdinListener): unknown;
  removeAllListeners(event: string): unknown;
  setRawMode(mode: boolean): void;
  resume(): void;
}

/**
 * MiniOutput：`omni mini` 纯终端 CLI 模式的渲染层。
 *
 * 版面规则逐条对齐 codex-rs/tui 的源码（history_cell/*.rs、exec_cell/render.rs、
 * status_indicator_widget.rs、bottom_pane/footer.rs），不是"看着截图猜"：
 * - 会话信息框：内容自适应宽度（上限 56）+ `╭─╮` 细边框（history_cell/session.rs）；
 * - 正文/思考：`• ` 开头 + 续行 2 空格缩进（history_cell/messages.rs AgentMessageCell /
 *   ReasoningSummaryCell：思考为 dim + italic，正文正常色）；
 * - 用户消息：`› ` 前缀（bold dim）+ 前后空行（UserHistoryCell）；
 * - 工具调用：`• Ran <cmd>`，`•` 是状态色（成功绿/失败红/运行中动画），标题
 *   运行中为 `Running`、结束为 `Ran`（exec_cell/render.rs）；输出预览取前 3 行 +
 *   `+N lines (ctrl+t to view transcript)`（tool_output.rs，与快照逐字一致）；
 * - 运行中状态行：`• Working (12s • esc to interrupt)` 原地计时（status_indicator_widget.rs）；
 * - 回合分隔：`Worked for 12s · 16:41` dim 行，时长仅在 >60s 时出现（history_cell/separators.rs）；
 * - 全程普通滚动行，不用备用屏；非 TTY（管道）自动退化为"只出最终单元格"。
 */
import { homedir } from 'node:os';
import { stdin as input, stderr as errOut } from 'node:process';
import readline from 'node:readline/promises';
import type { ThinkingDisplay } from '../agent/types.js';
import type { OmniConfig } from '../config/index.js';
import { printHelp } from '../cli/args.js';
import type { HookEventName } from '../hooks/index.js';
import type { ApprovalRequest } from '../safety/index.js';
import type { AskResult } from '../tools/ask.js';
import { truncateMiddle } from '../tui/layout.js';
import { inlineMathToText } from '../tui/markdown.js';
import { visualWidth } from '../tui/width.js';
import { bold, cyan, dim, green, isTTY, italic, magenta, red, useColor, yellow } from '../ui.js';
import { VERSION } from '../version.js';
import { countDiffLines, isExitCodeZeroLine, truncateToWidth } from './format.js';
import type { Output, TokenUsage, ToolResultDetail } from './types.js';

export interface MiniOutputOptions {
  /** 是否展示思考过程（配置 showThinking；关闭后完全静默，仍落盘 last-thinking.md） */
  showThinking: boolean;
  /** 是否流式输出（管道/重定向为 false 时只保留最终结果） */
  stream: boolean;
}

/** 会话框内宽上限（codex: SESSION_HEADER_MAX_INNER_WIDTH = 56，注释就是 "Just an eyeballed value"） */
const BOX_MAX_INNER = 56;
/** 下方单元格左缩进（codex: LIVE_PREFIX_COLS = 2） */
const PREFIX = '  ';
/** 工具输出预览行数（codex: tool_output.rs PREVIEW_LINES = 3） */
const PREVIEW_LINES = 3;
/** 折叠提示（与 codex ui_consts::TRANSCRIPT_HINT 同字面量） */
export const TRANSCRIPT_HINT = 'ctrl+t to view transcript';
/** 空输出占位（codex exec cell 同款） */
const NO_OUTPUT = '(no output)';
const OMITTED_MARK = '…（输出过长，已省略剩余）';
/** 流式光标（codex 用 ▍/▌ 系列做 live 区前缀，这里用于未完成行尾） */
const CURSOR = '▌';
/** 运行中转轮帧（codex activity_indicator 的静态兜底是 dim `•`） */
const ACTIVITY_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** omni 权限档位 → 展示名（对标 codex 的 read-only / auto / full-access / YOLO mode） */
const PERM_LABEL: Record<string, { name: string; note?: string; yolo?: boolean }> = {
  full: { name: 'YOLO mode', yolo: true },
  safe: { name: 'Auto', note: '危险命令先询问' },
  ask: { name: 'Ask', note: '每个工具都询问' },
  read: { name: 'Read Only', note: '只读' },
};

/** 工具名 → 动词（codex：Ran / You ran / Read / Wrote / Edited / Called …） */
const VERBS: Record<string, string> = {
  run_command: 'Ran',
  read_file: 'Read',
  write_file: 'Wrote',
  edit_file: 'Edited',
  list_directory: 'Listed',
  search_code: 'Searched',
  web_fetch: 'Fetched',
  web_search: 'Searched the web',
  skill: 'Loaded skill',
  ask_user: 'Asked',
  todo_write: 'Updated plan',
  delegate: 'Delegated',
  diagnose: 'Diagnosed',
  memory_search: 'Searched memory',
  memory_read: 'Read memory',
  task_board: 'Updated board',
  send_message: 'Messaged',
  lsp: 'Inspected',
};

const TIPS = [
  '用 /model 切换模型、/variants 调整思考级别。',
  '用 /btw 旁问：只读工具查证，答案不进对话历史。',
  '用 /undo 撤销上一次文件写入，/rewind 回到会话检查点。',
  '用 /plan 进入只读调研模式，不会修改任何文件。',
  '用 /review 审查当前改动，/diff 查看改动明细。',
  '用 -c 或 /session 恢复历史会话。',
  'Ctrl+T 打印完整轨迹账本（工具输出默认只显示前 3 行）。',
  '/exit 退出，Ctrl+C 中断当前任务。',
];

/** 会话框内容（纯数据，便于探针断言渲染结果） */
export interface MiniBannerInfo {
  model: string;
  effort?: string;
  directory: string;
  permission: string;
  sandbox?: string;
}

/** 终端可见列数（未协商/管道为 0 时按 80 兜底） */
function cols(): number {
  const c = (process.stdout as { columns?: number }).columns ?? 0;
  return c > 0 ? c : 80;
}

function termWidth(): number {
  return Math.max(20, cols() - 6);
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim();
}

function homify(dir: string): string {
  const home = homedir();
  if (!home) return dir;
  if (dir === home) return '~';
  return dir.startsWith(home + '/') ? `~${dir.slice(home.length)}` : dir;
}

function clockNow(d = new Date()): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 耗时（codex separators.rs 格式：12s / 1m 05s / 1h 02m 03s） */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s`;
}

/**
 * 取文本尾部不超过 width 列的片段（前缀 `…`）。live 区原地重绘要求**每个逻辑行正好占
 * 一行**——超宽行会被终端折成多行，`\x1b[NA` 上移就会错位（实测长思考直接画花）。
 */
function tailToWidth(text: string, width: number): string {
  if (visualWidth(text) <= width) return text;
  let out = '';
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i]!;
    if (visualWidth(ch + out) > width - 1) break;
    out = ch + out;
  }
  return `…${out}`;
}

/** 框内一行：plain 用于算宽，styled 用于输出（ANSI 不参与宽度计算） */
interface BoxRow {
  plain: string;
  styled: string;
}

/**
 * 渲染会话信息框（纯函数）。
 * codex 版式：`>_ Omni (vX)` / 空行 / `model:` 行（模型 + 思考级别 + 3 空格 + `/model to change`）
 * / `directory:` 行 / `permissions:` 行（YOLO 或显式档位）；框宽 = 最宽内容行（上限 56）。
 */
export function renderMiniBanner(info: MiniBannerInfo, width: number): string[] {
  const inner = Math.max(10, Math.min(width - 4, BOX_MAX_INNER));
  const rows: BoxRow[] = [];

  const title = `>_ Omni (v${VERSION})`;
  rows.push({ plain: title, styled: `${dim('>_ ')}${bold('Omni')} ${dim(`(v${VERSION})`)}` });
  rows.push({ plain: '', styled: '' });

  // model 行：模型 + 思考级别，3 空格后接 `/model to change`（codex 不右对齐）
  const modelPlain = `${info.model}${info.effort ? ` ${info.effort}` : ''}`;
  const modelStyled = `${info.model}${info.effort ? ` ${dim(info.effort)}` : ''}`;
  rows.push({
    plain: `model: ${modelPlain}   /model to change`,
    styled: `${dim('model:')} ${modelStyled}${' '.repeat(3)}${cyan('/model')}${dim(' to change')}`,
  });

  rows.push({ plain: `directory: ${homify(info.directory)}`, styled: `${dim('directory:')} ${homify(info.directory)}` });
  const perm = PERM_LABEL[info.permission] ?? { name: info.permission };
  rows.push({
    plain: `permissions: ${perm.name}${perm.note ? ` · ${perm.note}` : ''}`,
    styled: `${dim('permissions:')} ${perm.yolo ? bold(magenta(perm.name)) : perm.name}${perm.note ? dim(` · ${perm.note}`) : ''}`,
  });
  if (info.sandbox) {
    rows.push({ plain: `sandbox: ${info.sandbox}`, styled: `${dim('sandbox:')} ${yellow(info.sandbox)}` });
  }

  // 框宽 = 最宽内容行（codex with_border：content_width = max_line_width）
  const contentW = Math.max(1, Math.min(inner, Math.max(...rows.map((r) => visualWidth(r.plain)))));
  const border = (edge: string): string => dim(`${edge}${'─'.repeat(contentW + 2)}${edge === '╭' ? '╮' : '╯'}`);
  const out = [border('╭')];
  for (const r of rows) {
    const plain = visualWidth(r.plain) > contentW ? truncateToWidth(r.plain, contentW) : r.plain;
    const styled = plain === r.plain ? r.styled : plain; // 超宽（窄终端）时退回纯文本，保证右侧边框对齐
    out.push(`${dim('│ ')}${styled}${' '.repeat(Math.max(0, contentW - visualWidth(plain)))}${dim(' │')}`);
  }
  out.push(border('╰'));
  return out;
}

/** 回合分隔行（codex separators.rs：耗时 >60s 才写 "Worked for Xs"，始终带本地时间；dim + 2 空格缩进） */
export function renderTurnSeparator(elapsedMs: number, date = new Date()): string {
  const parts: string[] = [];
  const secs = Math.round(elapsedMs / 1000);
  if (secs > 60) parts.push(`Worked for ${fmtElapsed(elapsedMs)}`);
  parts.push(clockNow(date));
  return dim(`${PREFIX}${parts.join(' · ')}`);
}

/** 运行中状态行（codex status_indicator_widget.rs：`• Working (12s • esc to interrupt)`） */
export function renderWorkingLine(secs: number, frame: string, hint = 'esc to interrupt'): string {
  return `${dim(frame)} ${bold('Working')} ${dim(`(${secs}s • ${hint})`)}`;
}

/** 工具名 → 动词 */
export function verbForTool(name: string): string {
  return VERBS[name] ?? 'Called';
}

/** 工具调用摘要（优先结构化参数，回退 formatToolCall 摘要并剥标记） */
export function toolDetail(name: string, args: Record<string, unknown> | undefined, fallback: string): string {
  const a = args ?? {};
  const str = (k: string): string => (typeof a[k] === 'string' ? (a[k] as string) : '');
  switch (name) {
    case 'run_command':
      return oneLine(str('command')) || stripMarkers(fallback);
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return oneLine(str('path')) || stripMarkers(fallback);
    case 'list_directory':
      return oneLine(str('path')) || '.';
    case 'search_code': {
      const pat = oneLine(str('pattern'));
      const p = oneLine(str('path'));
      return pat ? `for "${pat}"${p ? ` in ${p}` : ''}` : stripMarkers(fallback);
    }
    case 'web_fetch':
      return oneLine(str('url')) || stripMarkers(fallback);
    case 'web_search': {
      const q = oneLine(str('query'));
      return q ? `for "${q}"` : stripMarkers(fallback);
    }
    case 'skill':
      return oneLine(str('name')) || stripMarkers(fallback);
    case 'ask_user':
      return oneLine(str('question')) || stripMarkers(fallback);
    default:
      return stripMarkers(fallback);
  }
}

function stripMarkers(text: string): string {
  return oneLine(text)
    .replace(/^\s*[$*←?·]\s*/, '')
    .replace(/^(Read|Write|Edit|List|Grep|Fetch|Search|Skill|Bash|Called|Ran)\s+/i, '')
    .trim();
}

/** 写/改文件的紧凑 diff 统计（`└ +12 −3`）；无 diff 数据返回 null */
function diffStatLine(detail: ToolResultDetail | undefined): string | null {
  const counts = detail?.diff
    ? countDiffLines(detail.diff.original ?? '', detail.diff.content)
    : detail?.edit
      ? countDiffLines(detail.edit.oldLines.join('\n'), detail.edit.newLines.join('\n'))
      : null;
  if (!counts) return null;
  return `${PREFIX}${dim('└')} ${green(`+${counts.add}`)} ${red(`−${counts.rem}`)}`;
}

/**
 * 原地重绘的 live 区块（codex 的 live 区/状态行在 TUI 里是重绘的；行式终端用
 * "上移 N 行 + 逐行清空"模拟）。仅 TTY 生效——管道下退化为"只出最终单元格"。
 */
class LiveBlock {
  private lines: string[] = [];
  /** 最近一次主体行（setSuffix 重绘时复用） */
  private body: string[] = [];
  /** 追加在主体之后的固定行（如"已排队输入"提示行） */
  private suffix: string[] = [];
  constructor(private enabled: boolean, private out = process.stdout) {}

  get active(): boolean {
    return this.enabled;
  }

  /** 设置后缀行（内容变化时立即按当前主体重绘） */
  setSuffix(suffix: string[]): void {
    const same = suffix.length === this.suffix.length && suffix.every((l, i) => l === this.suffix[i]);
    if (same) return;
    this.suffix = suffix;
    if (this.body.length > 0) this.render([...this.body, ...suffix]);
  }

  /** 用新内容替换当前区块（光标停在区块下一行行首） */
  update(lines: string[]): void {
    this.body = lines;
    this.render([...lines, ...this.suffix]);
  }

  private render(lines: string[]): void {
    if (!this.enabled) return;
    const prev = this.lines.length;
    if (prev > 0) this.out.write(`\x1b[${prev}A`); // 回到区块首行
    const n = Math.max(prev, lines.length);
    for (let i = 0; i < n; i++) {
      this.out.write('\r\x1b[2K');
      if (i < lines.length) this.out.write(lines[i]!);
      if (i < n - 1) this.out.write('\n');
    }
    this.out.write('\n');
    this.lines = lines;
  }

  /** 清掉整个区块（连同下方内容，live 区下面不会有东西） */
  clear(): void {
    if (!this.enabled || this.lines.length === 0) return;
    this.out.write(`\x1b[${this.lines.length}A\r\x1b[0J`);
    this.lines = [];
    this.body = [];
  }

  /** 清掉区块后把最终内容写入滚动区（带换行、可回滚） */
  commit(lines: string[]): void {
    if (this.enabled && this.lines.length > 0) this.clear();
    for (const l of lines) console.log(l);
  }
}

/**
 * 流式单元格：`• ` 开头、续行 2 空格缩进（codex AgentMessageCell/ReasoningSummaryCell 同款），
 * 未完成的行用 `▌` 光标原地重绘。
 */
class StreamingCell {
  private buf = '';
  private started = false;

  constructor(
    private live: LiveBlock,
    private style: (line: string) => string,
    /** beforeFirst：首个单元格输出前的空行钩子（codex 相邻 HistoryCell 之间空一行）
     *  afterLine：每提交一行后回调（渲染层据此维护"当前是否已有空行"的状态） */
    private hooks: { beforeFirst?: () => void; afterLine?: () => void } = {},
    private first = `${dim('•')} `,
    private rest = PREFIX
  ) {}

  get began(): boolean {
    return this.started || this.buf.length > 0;
  }

  write(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      this.commit(line);
    }
    if (this.buf.length > 0) this.renderPartial();
  }

  /** 未完成行：原地重绘 + 光标（截到单行宽，尾部窗口——保证 live 区 1 行 = 屏幕 1 行） */
  private renderPartial(): void {
    if (!this.live.active) return;
    const room = Math.max(8, cols() - 6);
    this.live.update([`${this.prefix()}${this.style(tailToWidth(this.buf, room))}${dim(CURSOR)}`]);
  }

  private prefix(): string {
    return this.started ? this.rest : this.first;
  }

  private commit(line: string): void {
    this.live.clear();
    if (!this.started) this.hooks.beforeFirst?.();
    console.log(`${this.prefix()}${this.style(line)}`);
    this.started = true;
    this.hooks.afterLine?.();
  }

  /** 收尾：冲掉缓冲区（无换行结尾的最后一行 / 空消息补行） */
  end(): void {
    this.live.clear();
    if (this.buf.length > 0) {
      const line = this.buf;
      this.buf = '';
      if (!this.started) this.hooks.beforeFirst?.();
      console.log(`${this.prefix()}${this.style(line)}`);
      this.started = true;
      this.hooks.afterLine?.();
    }
    // 注意：本轮没有任何正文（例如只发起了工具调用）时**什么都不打印**——
    // 之前会打印一个孤零零的 `•`（实测肉眼可见的脏输出）
  }
}

export class MiniOutput implements Output {
  readonly thinking: ThinkingDisplay;
  private live: LiveBlock;
  private answer: StreamingCell;
  /** 思考流式单元格（dim + italic，首次出现时才建立——没思考就不该有 `• ` 空行） */
  private reasoning: StreamingCell | null = null;
  /** 运行中状态行（onRound → 首个 chunk / 工具调用 / 回合结束） */
  private working: { started: number; timer: NodeJS.Timeout } | null = null;
  /** 当前工具的 live 单元格状态（bullet 标题 + 已流出的输出行） */
  private tool: {
    id: number;
    name: string;
    verb: string;
    detail: string;
    running: boolean;
    out: string[];
  } | null = null;
  private toolSeq = 0;
  private turnStart: number | null = null;
  /** 当前光标下方是否已有一行空行（决定单元格间距——codex 相邻单元格之间恰好一行空行） */
  private gapOpen = true;
  /** 交互模式标记（cli/mini.ts 调用）：用于擦掉 readline 已回显的输入行 */
  private interactive = false;

  /**
   * 交互模式标记（cli/mini.ts 调用）：回显用户消息前擦掉 readline 自己回显的那一行
   * （否则输入会显示两遍），并打印输入区提示行（单次任务模式无提示符，不打印）。
   */
  // ── 轮内输入接管（raw mode） ────────────────────────────────────
  private rl: { pause(): void; resume(): void; write(data: string): void } | null = null;
  private queued = '';
  private capturing = false;
  private yieldedInput = false;
  /** 轮内是否按过 Enter：按了 → 轮末把整行发出；没按 → 只放回输入行等用户自己确认 */
  private queuedSubmit = false;
  /** 上一行是"停在输入行"的轮内输入：提交时 readline 会在回车处重渲染一次，需多擦一行 */
  private parkedLine = false;
  /** 轮内被临时摘下的 readline 监听器（轮末原样装回） */
  private savedListeners: { event: string; listener: StdinListener }[] | null = null;

  /**
   * 轮内 stdin 接管。必须接管的原因：一轮进行中 readline 不消费输入，但终端内核仍会回显，
   * 字符落在流式输出的光标处被"吃进"回答（用户实测反馈），而 readline 缓存的整行又会在
   * 下一轮发出。接管后自己收集 → 渲染成 codex 的 `↳ <排队内容>` 提示行 → 轮末回填 readline。
   */
  private onInput = (chunk: Buffer | string): void => {
    for (const ch of String(chunk)) {
      if (ch === '\r' || ch === '\n') {
        this.queuedSubmit = true;
        continue;
      }
      if (ch === '\x7f' || ch === '\b') this.queued = this.queued.slice(0, -1);
      else if (ch === '\x15') this.queued = '';
      else if (ch === '\x03') {
        this.endInputCapture(false); // 中断：丢弃轮内打的字，还原终端后按原行为抛 SIGINT
        process.kill(process.pid, 'SIGINT');
        return;
      } else if (ch >= ' ') this.queued += ch;
    }
    this.live.setSuffix(this.queued ? [`${PREFIX}${dim(this.queuedSubmit ? `↳ ${this.queued} ↵` : `↳ ${this.queued}`)}`] : []);
  };

  private beginInputCapture(): void {
    if (this.capturing || this.yieldedInput) return;
    if (!this.rl || !isTTY || typeof process.stdin.setRawMode !== 'function') return;
    this.capturing = true;
    this.queuedSubmit = false;
    // 关键：把 readline（含 keypress 解码器）的 stdin 监听器**整组摘下来**。
    // 只 rl.pause() 不行——随后为了让自己的 data 监听器收到字节而 stdin.resume()，
    // 会把 readline 的渲染一并唤醒，它就把键入字符画进流式回答里（实测踩过）。
    const stdin = process.stdin as unknown as LooseStdin;
    this.savedListeners = ['data', 'keypress'].flatMap((event) =>
      stdin.listeners(event).map((listener) => ({ event, listener }))
    );
    stdin.removeAllListeners('data');
    stdin.removeAllListeners('keypress');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', this.onInput as unknown as StdinListener);
  }

  /** 释放输入权，必要时把排队内容回填给 readline（成为下一轮用户消息） */
  private endInputCapture(flush = true): void {
    if (!this.capturing) return;
    this.capturing = false;
    const stdin = process.stdin as unknown as LooseStdin;
    stdin.off('data', this.onInput as unknown as StdinListener);
    stdin.setRawMode(false);
    // 原样装回 readline 的监听器（顺序保持），它继续正常收发/回显
    for (const { event, listener } of this.savedListeners ?? []) stdin.on(event, listener);
    this.savedListeners = null;
    this.live.setSuffix([]);
    const pending = this.queued;
    const submit = this.queuedSubmit;
    this.queued = '';
    this.queuedSubmit = false;
    if (flush && pending) {
      // 以"合成键入"的方式把文字还给 readline（等价于用户真的敲了这些键）：
      // · 没按过 Enter → 只补文字，readline 把它放进输入行并回显 → 停在提示符后等用户确认
      //   （用户实测要求：正在回答时打的字不该自动发出去）
      // · 按过 Enter → 补文字 + 换行 → readline 立即产出该行，循环把它当作下一轮用户消息
      // 注意不能用 rl.write()：它塞进行缓冲但不渲染（实测屏幕上什么也看不到）。
      // 推迟到下一个 tick：交互循环会在 onTurnEnd 之后立刻 safePrompt()，等提示符画好
      // 再注入，readline 就是在提示符后原地补字（否则提示符行与注入行会各画一次、出现两行）。
      if (!submit) this.parkedLine = true;
      setImmediate(() => {
        process.stdin.emit('data', Buffer.from(`${pending}${submit ? '\n' : ''}`, 'utf8'));
      });
    }
  }

  private yieldInput(): void {
    if (!this.capturing) return;
    this.yieldedInput = true;
    this.endInputCapture();
  }

  private resumeInput(): void {
    this.yieldedInput = false;
    if (this.turnStart != null) this.beginInputCapture();
  }

  /** readline 句柄注入（runInteractive 的 onRl 回调） */
  attachInput(rl: { pause(): void; resume(): void; write(data: string): void }): void {
    this.rl = rl;
  }

  markInteractive(): void {
    this.interactive = true;
    if (this.opts.stream) {
      console.log(`${PREFIX}${dim('⏎ 发送 · Ctrl+C 中断 · /exit 退出 · Ctrl+T 轨迹')}`);
      console.log('');
    }
  }

  /** 需要时补一个空行（单元格间距）；已有空行则不动 */
  private ensureGap(): void {
    if (this.gapOpen) return;
    console.log('');
    this.gapOpen = true;
  }

  /** 正文单元格（codex AgentMessageCell：`• ` + 续行 2 空格） */
  private newAnswerCell(): StreamingCell {
    return new StreamingCell(this.live, (l) => inlineMathToText(l), {
      beforeFirst: () => this.ensureGap(),
      afterLine: () => {
        this.gapOpen = false;
      },
    });
  }

  /** 思考单元格（codex ReasoningSummaryCell：同为 `• ` 单元格，但 dim + italic） */
  private newReasoningCell(): StreamingCell {
    return new StreamingCell(this.live, (l) => italic(dim(inlineMathToText(l))), {
      beforeFirst: () => this.ensureGap(),
      afterLine: () => {
        this.gapOpen = false;
      },
    });
  }

  /** 收尾并重置单元格（每轮/每个工具边界都是一段独立内容，不能续用上一条的前缀） */
  private resetCells(): void {
    this.answer.end();
    this.answer = this.newAnswerCell();
    this.reasoning?.end();
    this.reasoning = null;
  }

  constructor(private opts: MiniOutputOptions) {
    this.live = new LiveBlock(isTTY && opts.stream);
    this.answer = this.newAnswerCell();
    let reasoningShown = false;
    this.thinking = {
      get shown(): boolean {
        return reasoningShown;
      },
      write: (text: string) => {
        if (!this.opts.showThinking || !this.opts.stream) return;
        // 一个 reasoning 块 = 一个单元格：块结束后重新 `• ` 起头（codex 同款）
        if (!this.reasoning) {
          this.stopWorking();
          this.reasoning = this.newReasoningCell();
        }
        reasoningShown = true;
        this.reasoning.write(text);
      },
      finish: () => {
        if (!this.reasoning) return;
        this.reasoning.end();
        this.reasoning = null;
      },
    } as ThinkingDisplay;
  }

  /** 会话信息框 + Tip 行 + 输入区提示行 */
  banner(cfg: OmniConfig): void {
    const info: MiniBannerInfo = {
      model: cfg.model,
      effort: cfg.reasoningEffort,
      directory: process.cwd(),
      permission: cfg.permission ?? 'safe',
      sandbox: cfg.sandbox && cfg.sandbox !== 'off' ? cfg.sandbox : undefined,
    };
    for (const line of renderMiniBanner(info, cols())) console.log(line);
    const tip = TIPS[Math.floor(Math.random() * TIPS.length)] ?? TIPS[0]!;
    console.log('');
    console.log(`${PREFIX}${dim(`Tip: ${tip}`)}`);
    console.log('');
  }

  // ── 运行中状态行 ───────────────────────────────────────────────
  onRound(_step: number, _maxSteps: number): void {
    if (!this.opts.stream) return;
    this.resetCells(); // 每次 LLM 请求 = 一条独立消息/思考块
    this.startWorking();
  }

  private startWorking(hint = 'esc to interrupt'): void {
    if (!this.live.active || this.working) return;
    const started = Date.now();
    let i = 0;
    const tick = (): void => {
      const secs = Math.floor((Date.now() - started) / 1000);
      this.live.update([renderWorkingLine(secs, ACTIVITY_FRAMES[i++ % ACTIVITY_FRAMES.length]!, hint)]);
    };
    tick();
    this.working = { started, timer: setInterval(tick, 100) };
  }

  private stopWorking(): void {
    if (!this.working) return;
    clearInterval(this.working.timer);
    this.working = null;
    this.live.clear();
  }

  onStreamStart(): void {
    this.stopWorking();
  }

  // ── 正文 / 思考 ────────────────────────────────────────────────
  onAnswer(text: string): void {
    if (!this.opts.stream) return;
    this.stopWorking();
    this.answer.write(text);
  }

  onAnswerEnd(): void {
    if (!this.opts.stream) return;
    this.answer.end();
  }

  onUsage(_usage: TokenUsage): void {}

  onTurnStart(): void {
    this.turnStart = Date.now();
    this.beginInputCapture();
  }

  onRequestFailed(err: unknown): void {
    this.stopWorking();
    console.log(`${dim('•')} ${red('Request failed')} ${dim((err as Error)?.message ?? String(err))}`);
  }

  onFallback(model: string): void {
    console.log(`${dim('•')} ${dim(`fallback → ${model}`)}`);
  }

  onThinkingSaved(len: number, file: string | null): void {
    if (this.opts.showThinking && !isTTY && this.opts.stream) {
      console.log(dim(`thinking (${len} chars) → ${file ?? '.omni/last-thinking.md'}`));
    }
  }

  // ── 工具调用 ───────────────────────────────────────────────────
  onToolStep(
    _step: number,
    _maxSteps: number,
    name: string,
    argsPreview: string,
    args?: Record<string, unknown>,
    toolSeq?: number
  ): void {
    if (!this.opts.stream) return;
    this.stopWorking();
    this.resetCells();
    this.tool = {
      id: toolSeq ?? this.toolSeq++,
      name,
      verb: verbForTool(name),
      detail: toolDetail(name, args, argsPreview),
      running: true,
      out: [],
    };
    this.renderTool();
  }

  /** 运行中：`⠋ Running <cmd>`（codex exec cell 活动态）+ 已流出的输出尾部 */
  private renderTool(): void {
    const t = this.tool;
    if (!t) return;
    if (!this.live.active) return;
    const width = termWidth();
    const head = t.running
      ? `${dim(ACTIVITY_FRAMES[Math.floor(Date.now() / 100) % ACTIVITY_FRAMES.length]!)} ${bold('Running')} ${truncateToWidth(t.detail, width)}`
      : `${green(bold('•'))} ${bold(t.verb)} ${truncateToWidth(t.detail, width)}`;
    const lines = ['', head];
    for (const [i, l] of t.out.slice(-PREVIEW_LINES).entries()) {
      lines.push(`${i === 0 ? `${PREFIX}${dim('└ ')}` : '    '}${dim(truncateToWidth(oneLine(l), width))}`);
    }
    this.live.update(lines);
  }

  onToolResult(
    ok: boolean,
    _chars: number,
    preview?: string[],
    detail?: ToolResultDetail,
    toolSeq?: number,
    totalLines?: number
  ): void {
    if (!this.opts.stream) return;
    const t = this.tool;
    this.tool = null;
    this.reasoning?.end();
    this.reasoning = null;
    if (!t || (toolSeq != null && toolSeq !== t.id)) return;

    const width = termWidth();
    // bullet 是状态色：成功绿 / 失败红（codex exec_cell/render.rs），失败同时换 ✗ 起头
    const bullet = ok ? green(bold('•')) : red(bold('•'));
    const head = `${bullet} ${bold(t.verb)} ${truncateToWidth(t.detail, width)}`;
    const lines: string[] = [head];

    const diff = diffStatLine(detail);
    if (diff) {
      lines.push(diff.replace(new RegExp(`^${PREFIX}`), PREFIX));
    } else if (t.name !== 'read_file') {
      const raw = (preview ?? [])
        .filter((l) => !l.includes(OMITTED_MARK) && !isExitCodeZeroLine(l))
        .slice(0, PREVIEW_LINES);
      const shown = raw.filter((l) => l.trim() !== '');
      if (shown.length === 0) {
        lines.push(ok ? `${PREFIX}${dim(`└ ${NO_OUTPUT}`)}` : `${PREFIX}${dim(`└ ${NO_OUTPUT}`)}`);
      } else {
        shown.forEach((line, i) => {
          lines.push(`${i === 0 ? `${PREFIX}${dim('└ ')}` : '    '}${dim(truncateToWidth(oneLine(line), width))}`);
        });
      }
      const hidden = totalLines != null ? Math.max(0, totalLines - raw.length) : 0;
      if (hidden > 0) {
        lines.push(dim(`    +${hidden} ${hidden === 1 ? 'line' : 'lines'} (${TRANSCRIPT_HINT})`));
      }
    }
    this.live.commit(['', ...lines]); // 前置空行 = 与上一个单元格的间距
    this.gapOpen = false;
  }

  /** 命令实时输出：保留尾部 3 行原地重绘（codex 在单元格里滚最后几行） */
  onCommandOutput(chunk: string, _isError: boolean, _toolSeq?: number): void {
    if (!this.opts.stream || !this.live.active || !this.tool) return;
    for (const line of chunk.split('\n')) {
      if (!line) continue;
      this.tool.out.push(line);
    }
    this.renderTool();
  }

  // ── 用户消息 / 回合收尾 ────────────────────────────────────────
  /** 用户消息：`› ` 前缀（bold dim）+ 前后空行（codex UserHistoryCell） */
  onUserMessage(text: string): void {
    this.answer.end();
    // 交互模式：readline 已经回显过这条输入，这里擦掉它——让"输入 → 提交 → 落进对话流"
    // 只出现一次（codex 的 composer 提交后也是这个观感）。两种来源的回显位置不同：
    // ① 用户键入并回车 → 回显在**上一行**；② 我们轮末 rl.write 回填 → 回显在**当前行**。
    if (this.interactive && this.live.active) {
      // 停在输入行的那份，提交时 readline 会在回车处重渲染 → 屏幕上留两行同样内容，一起擦掉
      const up = this.parkedLine ? 2 : 1;
      this.parkedLine = false;
      process.stdout.write(`\x1b[${up}A\r\x1b[0J`);
    }
    const lines = text.split('\n');
    console.log('');
    lines.forEach((l, i) => console.log(`${i === 0 ? `${bold(dim('›'))} ` : PREFIX}${l}`));
    console.log('');
    this.gapOpen = true;
  }

  /** 回合结束：dim 的 `Worked for Xs · 16:41` 分隔行（codex separators.rs） */
  onTurnEnd(): void {
    this.stopWorking();
    const start = this.turnStart;
    this.turnStart = null;
    if (start != null) {
      this.ensureGap();
      console.log(renderTurnSeparator(Date.now() - start));
      this.gapOpen = false;
    }
    this.endInputCapture(); // 轮末：释放输入权 + 把排队内容回填给 readline
  }

  onWaitForInput(): void {}

  clearScrollback(): void {}

  onMaxSteps(max: number): void {
    console.log(`\n${yellow('⚠ 已达到最大步数')}（${max}），任务可能未完成。可增大 OMNI_MAX_STEPS 重试。`);
  }

  showHelp(): void {
    printHelp();
  }

  onHookOutput(event: HookEventName, lines: string[]): void {
    if (!this.opts.stream) return;
    for (const l of lines) console.log(`${PREFIX}${dim(`hook[${event}] ${l}`)}`);
  }

  onAutoReview(req: ApprovalRequest, verdict: { approve: boolean; reason: string }): void {
    if (!this.opts.stream) return;
    const mark = verdict.approve ? '✓ 自动批准' : '✗ 自动拒绝';
    console.log(`${PREFIX}${dim(`auto-review ${mark} ${req.tool}${verdict.reason ? ` · ${verdict.reason}` : ''}`)}`);
  }

  onBackgroundSubagentDone(r: { id: string; name: string; status: 'ok' | 'err'; result: string; durationMs: number }): void {
    if (!this.opts.stream) return;
    const ok = r.status === 'ok';
    console.log(
      `${PREFIX}${dim(`${ok ? '✓' : '✗'} 后台子代理「${r.name}」${ok ? '完成' : '失败'} · ${(r.durationMs / 1000).toFixed(1)}s（结果已注入对话）`)}`
    );
  }

  onSubagentEvent(ev: import('../agent/types.js').SubagentEvent): void {
    if (!this.opts.stream) return;
    const indent = PREFIX + PREFIX.repeat(ev.depth);
    if (ev.type === 'start') {
      console.log(`${indent}${dim(`↳ 子代理 ${ev.name} 开始：${(ev.task ?? '').split('\n')[0]}`)}`);
    } else if (ev.type === 'step') {
      console.log(`${indent}${dim(`↳ 子代理 ${ev.name} · ${ev.tool ?? '思考中'} ${ev.step}/${ev.maxSteps}`)}`);
    } else if (ev.type === 'stopped') {
      console.log(`${indent}${dim(`⏹ 子代理 ${ev.name} 已停止`)}`);
    } else if (ev.type === 'end') {
      console.log(
        `${indent}${dim(`${ev.status === 'ok' ? '✓' : '✗'} 子代理 ${ev.name} 完成 · ${ev.steps} 步 · ${((ev.durationMs ?? 0) / 1000).toFixed(1)}s`)}`
      );
    }
  }

  // ── 审批 / 提问（readline，写 stderr 不污染 stdout） ────────────
  private approvalTail: Promise<void> = Promise.resolve();
  requestApproval(req: ApprovalRequest): Promise<boolean> {
    let resolveMe!: (b: boolean) => void;
    const p = new Promise<boolean>((r) => (resolveMe = r));
    this.approvalTail = this.approvalTail.then(async () => {
      try {
        resolveMe(await this.promptApproval(req));
      } catch {
        resolveMe(false);
      }
    });
    return p;
  }

  private async promptApproval(req: ApprovalRequest): Promise<boolean> {
    if (!isTTY) return false;
    this.yieldInput();
    this.stopWorking();
    this.live.clear();
    const rl = readline.createInterface({ input, output: errOut });
    try {
      const ans = await rl.question(
        `\n${yellow('⚠')} ${bold(req.tool)}\n${PREFIX}${req.summary}\n${PREFIX}${dim(req.reason)}\n${PREFIX}批准执行？[y/N] `
      );
      return /^y/i.test(ans.trim());
    } finally {
      rl.close();
      this.resumeInput();
    }
  }

  private askTail: Promise<void> = Promise.resolve();
  askUser(question: string, options: string[], multiple: boolean): Promise<AskResult | null> {
    let resolveMe!: (r: AskResult | null) => void;
    const p = new Promise<AskResult | null>((r) => (resolveMe = r));
    this.askTail = this.askTail.then(async () => {
      try {
        resolveMe(await this.promptAskUser(question, options, multiple));
      } catch {
        resolveMe(null);
      }
    });
    return p;
  }

  private async promptAskUser(question: string, options: string[], multiple: boolean): Promise<AskResult | null> {
    if (!isTTY) return null;
    this.yieldInput();
    this.stopWorking();
    this.live.clear();
    const rl = readline.createInterface({ input, output: errOut });
    try {
      const lines = options.map((o, i) => `${PREFIX}${i + 1}. ${o}`);
      const ans = await rl.question(
        `${PREFIX}${dim('?')} ${question}（${multiple ? '多选' : '单选'}）\n${lines.join('\n')}\n${PREFIX}${dim('自定义：直接输入内容')}\n${PREFIX}输入选项序号${multiple ? '（逗号分隔可多选）' : ''}或自定义文本，回车确认；空输入取消：`
      );
      const t = ans.trim();
      if (!t) return null;
      if (/^[\d,\s]+$/.test(t)) {
        const idxs = [
          ...new Set(t.split(/[,，\s]+/).map((s) => parseInt(s, 10)).filter((n) => n >= 1 && n <= options.length)),
        ];
        if (idxs.length === 0) return { choice: t, custom: true, choices: [t] };
        const picked = idxs.map((i) => options[i - 1]!);
        return { choice: picked.join('、'), custom: false, choices: picked };
      }
      return { choice: t, custom: true, choices: [t] };
    } finally {
      rl.close();
      this.resumeInput();
    }
  }
}

/** 供探针/测试使用：是否启用颜色（与渲染层同源） */
export const miniUsesColor = useColor;

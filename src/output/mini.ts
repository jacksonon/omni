/**
 * MiniOutput：`omni mini` 纯终端 CLI 模式的渲染层。
 *
 * 版面规则逐条对齐 codex-rs/tui 的源码（history_cell/*.rs、exec_cell/render.rs、
 * status_indicator_widget.rs、bottom_pane/footer.rs），不是"看着截图猜"：
 * - 会话信息框：内容自适应宽度（上限 56）+ `╭─╮` 细边框（history_cell/session.rs）；
 * - 正文/思考：`• ` 开头 + 续行 2 空格缩进（history_cell/messages.rs AgentMessageCell /
 *   ReasoningSummaryCell：思考为 dim + italic 纯文本；正文走 MiniMarkdownRenderer ——
 *   复用 tui/markdown.ts 同一套解析（加粗/行内代码/标题/引用/列表/任务/围栏隐藏 +
 *   代码着色/GFM 表格框线）输出 ANSI，行级状态机见 markdown-ansi.ts）；
 * - 用户消息：`› ` 前缀（bold dim）+ 前后空行（UserHistoryCell）；
 * - 工具调用：`• Ran <cmd>`（用户 `!` 直跑为 `• You ran <cmd>`，codex is_user_shell_command），`•` 是状态色（成功绿/失败红/运行中动画），标题
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
import { composeInEditor, resolveEditorCommand } from '../cli/external-editor.js';
import { truncateMiddle } from '../tui/layout.js';
import { inlineMathToText } from '../tui/markdown.js';
import { visualWidth } from '../tui/width.js';
import { bold, cyan, dim, green, isTTY, italic, magenta, red, useColor, yellow } from '../ui.js';
import { VERSION } from '../version.js';
import { countDiffLines, editToUnifiedDiff, formatUnifiedDiffLine, isExitCodeZeroLine, truncateToWidth, unifiedDiff, prefixLines } from './format.js';
import type { UnifiedDiffLine } from './format.js';
import { MiniMarkdownRenderer } from './markdown-ansi.js';
import type { Output, TokenUsage, ToolResultDetail } from './types.js';

export interface MiniOutputOptions {
  /** 是否展示思考过程（配置 showThinking；关闭后完全静默，仍落盘 last-thinking.md） */
  showThinking: boolean;
  /** 是否流式输出（管道/重定向为 false 时只保留最终结果） */
  stream: boolean;
  /** 正文 Markdown 渲染（缺省跟随终端颜色：TTY 上色渲染，管道保持原文可 grep） */
  markdown?: boolean;
}

/** 下方单元格左缩进（codex: LIVE_PREFIX_COLS = 2） */
const PREFIX = '  ';
/** 工具输出预览行数（codex: tool_output.rs PREVIEW_LINES = 3） */
const PREVIEW_LINES = 3;
/** 折叠提示（与 codex ui_consts::TRANSCRIPT_HINT 同字面量） */
export const TRANSCRIPT_HINT = 'ctrl+t to view transcript';
/** onToolStep 展示参数中的用户 shell 标记（interactive `!` 直跑命令时置位 → 标题 `You ran`） */
export const USER_SHELL_FLAG = '__userShell';

/** 会话记住键：工具 + 精确摘要（codex "allow for this session" 的 mini 版——同工具同命令才自动放行） */
export function approvalSessionKey(tool: string, summary: string): string {
  return `${tool}::${summary.trim()}`;
}

/** 审批提示文案（纯函数：颜色跟随终端，管道下为纯文本）。
 * reason 可能多行（write_file diff 正文）：逐行挂前缀 + 独立上色，避免只有首行缩进。 */
export function formatApprovalPrompt(req: ApprovalRequest): string {
  const reason = prefixLines(req.reason, PREFIX)
    .split('\n')
    .map((l) => dim(l))
    .join('\n');
  return `\n${yellow('⚠')} ${bold(req.tool)}\n${PREFIX}${req.summary}\n${reason}\n${PREFIX}批准执行？[y]本次允许 / [a]本会话记住 / [N]拒绝 `;
}

/**
 * 提问回答解析（纯函数）：空=取消；纯数字/逗号=选项序号（越界整体回落自定义）；
 * 其余=自定义文本。单选多选同一套（多选用逗号分隔）。
 */
export function parseAskAnswer(ans: string, options: string[]): AskResult | null {
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
}

/** 审批回答解析：`a` 开头 = 本会话记住，`y` 开头 = 仅本次允许，其余 = 拒绝 */
export function parseApprovalAnswer(ans: string): 'once' | 'session' | 'deny' {
  const text = ans.trim();
  if (/^a/i.test(text)) return 'session';
  if (/^y/i.test(text)) return 'once';
  return 'deny';
}
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

/** 开场问候语（codex greetings.rs 全量复刻，PR #10248 起源；新会话 compact 头随机取一条，accent 上色） */
export const MINI_GREETINGS: readonly string[] = [
  "Whoa, fancy meeting you here!",
  "Look who’s at the keyboard.",
  "Hello, you. Got an idea?",
  "Nice to see you in these parts.",
  "Pull up a prompt.",
  "What brings you to this corner of the terminal?",
  "Hey there. Big plans or little fixes?",
  "What are we getting into today?",
  "Got something you want to try?",
  "What’s today’s little adventure?",
  "Anything interesting on the docket?",
  "Take your time. The cursor can wait.",
  "A half-formed idea will do.",
  "Come on in. There’s room for an idea.",
  "You, me, and a blinking cursor.",
  "It takes two to tango. What’s our first step?",
  "You bring the idea. I’ll bring the brackets.",
  "Your move, teammate.",
  "What are we cooking up?",
  "Shall we turn “what if” into something?",
  "What’s the first thing on our napkin sketch?",
  "Bring your unfinished thoughts.",
  "You set the direction. We’ll work out the steps.",
  "Ah, the terminal. A classic meeting spot.",
  "Nice place you’ve got here. Very monospace.",
  "Welcome to our little rectangle of possibility.",
  "A cursor blinks. The plot thickens.",
  "The prompt is yours.",
  "Fancy a little quality terminal time?",
  "How’s life between the brackets?",
  "Shall we give this cursor a purpose?",
  "A fresh prompt. An open question.",
  "Your keyboard has entered the chat.",
  "Hello, world. Hello, you.",
  "Welcome to the blinking edge of possibility.",
  "Any loose ends? Semicolons count.",
  "Shall we make this terminal earn its keep?",
  "Got an itch to fix a thing?",
  "Show me the bit that’s being weird.",
  "Greetings, fellow tinkerer.",
  "Well, well, well. An idea approaches.",
  "What’s today’s side quest?",
  "Is this a plan day or a poke-around day?",
  "Practical, peculiar, or a little of both?",
  "Rough sketches welcome.",
  "Shall we see where this goes?",
  "All right. What have you got?",
  "Back for another round?",
  "Same terminal, new possibilities.",
  "Welcome back. Familiar territory or a fresh adventure?",
  "Follow the white cursor.",
  "Welcome to the command line, Neo.",
  "A glitch in the Matrix, or just a missing semicolon?",
  "How deep does this codebase go?",
  "Speak, friend, and enter a prompt.",
  "One prompt to begin the journey.",
  "May the source be with you.",
  "These might be the bugs you’re looking for.",
  "A new prompt awakens.",
  "Forty-two is an answer. What’s the question?",
  "It’s dangerous to code alone. Take a prompt.",
  "The code must flow.",
  "You rang? Metaphorically. You typed.",
  "Hello again, carbon-based collaborator.",
  "This looks like the start of a perfectly reasonable rabbit hole.",
  "Shall we turn “huh?” into “aha!”?",
  "Well, this terminal just got interesting.",
  "The source is strong with this one.",
  "There’s a perfectly good prompt with your name on it.",
  "Here for a quick fix or the extended edition?",
  "What’s the latest from your side of the keyboard?",
  "Got a minute and a mildly unreasonable idea?",
  "A hunch is a perfectly respectable starting point.",
  "Hello again. What’s the plot this time?",
  "Shall we make a little something out of nothing?",
  "Welcome to the neighborhood. Lots of characters here.",
  "Nice terminal. Does it come in widescreen?",
  "Your cursor called. It wants a plot.",
  "Shall we put some verbs after that cursor?",
  "Welcome. There’s no dress code, just code.",
  "This terminal has excellent conversational potential.",
  "Got an idea that won’t stay on the napkin?",
  "What are we building in this episode?",
  "Bring a question. Bonus points if it’s a weird one.",
  "What are we poking with a metaphorical stick?",
  "Shall we make the thing that makes the other thing easier?",
  "Welcome to the part where the idea gets interesting.",
  "A long time ago, in a directory not so far away…"
];

/** 随机取一条开场问候语（codex Greeting::choose；会话内只取一次，由调用方保持稳定） */
export function pickMiniGreeting(): string {
  return MINI_GREETINGS[Math.floor(Math.random() * MINI_GREETINGS.length)] ?? MINI_GREETINGS[0]!;
}

const TIPS = [
  '用 /model 切换模型、/variants 调整思考级别。',
  '用 /btw 旁问：只读工具查证，答案不进对话历史。',
  '用 /undo 撤销上一次文件写入，/rewind 回到会话检查点。',
  '用 /plan 进入只读调研模式，不会修改任何文件。',
  '用 /review 审查当前改动，/diff 查看改动明细。',
  '用 -c 或 /session 恢复历史会话。',
  'Ctrl+T 打印完整轨迹账本（工具输出默认只显示前 3 行）。',
  '打 / 后按 Tab 看全部命令；/model 与 /variants 支持 ↑↓ 选择。',
  '行首 ! 直跑 shell（如 !git status），不经过模型（codex bash mode）。',
  '用 @ 提及文件：打字过滤，Tab 选择（单候选直插，多候选 ↑↓+Enter）。',
  '用 @图片.png 把截图直接发给模型看（vision 模型可用，无 vision 模型会明确报错）。',
  '用 /status 查看模型/上下文用量，/compact 手动压缩上下文。',
  '用 /copy 复制上一条模型回复，/export 导出整个会话。',
  '用 /fork 从当前会话分叉，/permission 切换权限档位。',
  '/exit 退出，/stop 或 Ctrl+C 中断当前任务。',
];

/**
 * 回合完成 tip 节奏（codex ca41ed3 的 mini 版：成功回合带最终回答、3 轮起、
 * 间隔 ≥3 轮、全会话 ≤2 条；同轮出过 working tip 则跳过 completion tip）。
 * 中断识别近似：以正文收尾（onAnswerEnd）为"带最终回答"信号。
 */

/** working 中 tip（codex ca41ed3：working 状态持续 30s 后在状态行下方随机一条；每轮最多一条） */
export const WORKING_TIP_AFTER_SECS = 30;
export function shouldShowWorkingTip(secs: number, shownThisTurn: boolean): boolean {
  return !shownThisTurn && secs >= WORKING_TIP_AFTER_SECS;
}

/** working tip 行（completion tip 同文案体例，`Tip: ` 前缀 + dim） */
export function renderWorkingTip(tip: string): string {
  return `${PREFIX}${dim(`Tip: ${tip}`)}`;
}

/** working live 块内容组装（状态行；出过 tip 则下方附一条，LiveBlock 按行数伸缩） */
export function workingLines(line: string, tip: string | null): string[] {
  return tip ? [line, renderWorkingTip(tip)] : [line];
}
export function shouldShowTurnTip(s: { turn: number; shown: number; lastShownTurn: number; hasAnswer: boolean }): boolean {
  if (!s.hasAnswer) return false;
  if (s.turn < 3) return false;
  if (s.shown >= 2) return false;
  if (s.shown > 0 && s.turn - s.lastShownTurn < 3) return false;
  return true;
}

/** 会话头内容（compact 头仅需目录 + 权限；模型行已随 codex 信息框一并移除） */
export interface MiniBannerInfo {
  directory: string;
  permission: string;
  /** OS 级沙箱档位（YOLO 行判定用；缺省当 off） */
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

/** 耗时（codex separators.rs 格式：12s / 1m 5s / 1h 2m 3s，不补零） */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
}

/** lap 耗时（codex format_duration_ms：≥1s 保留一位小数，否则毫秒整数） */
export function fmtLapDuration(ms: number): string {
  const v = Math.max(0, Math.round(ms));
  if (v >= 1000) return `${(v / 1000).toFixed(1)}s`;
  return `${v}ms`;
}

/** 本轮统计（codex RuntimeMetricsSummary 子集：工具调用 + 推理调用；0 次不展示） */
export interface TurnStats {
  toolCalls: number;
  toolMs: number;
  llmCalls: number;
  llmMs: number;
}

/** 分隔行统计段（codex runtime_metrics_label：`Local tools: 3 calls (1.2s)` 形态；零调用省略） */
export function turnStatSegments(stats: TurnStats): string[] {
  const parts: string[] = [];
  if (stats.toolCalls > 0) {
    parts.push(`Local tools: ${stats.toolCalls} ${stats.toolCalls === 1 ? 'call' : 'calls'} (${fmtLapDuration(stats.toolMs)})`);
  }
  if (stats.llmCalls > 0) {
    parts.push(`Inference: ${stats.llmCalls} ${stats.llmCalls === 1 ? 'call' : 'calls'} (${fmtLapDuration(stats.llmMs)})`);
  }
  return parts;
}

/** 分隔行统计后缀（· 连接；折行时按段拆，见 renderTurnSeparator） */
export function renderTurnStats(stats: TurnStats): string {
  return turnStatSegments(stats).join(' · ');
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

/**
 * 渲染会话头（纯函数；codex compact 版式，无框——空行 / `  >_ Omni (vX)` accent 标题 /
 * 5 空格目录（按 width-5 截断，home 简写 ~）/ YOLO 行（仅） / 空行 / accent 问候语）。
 * greeting 为 null 时省略问候行（调用方正常总是传一条：banner 内现取）。
 */
export function renderMiniBanner(info: MiniBannerInfo, width: number, greeting: string | null): string[] {
  const out: string[] = [''];
  out.push(`  ${cyan('>_ ')}${bold('Omni')} ${dim(`(v${VERSION})`)}`);
  const dirShown = truncateMiddle(homify(info.directory), Math.max(1, width - 5));
  out.push(`     ${dim(dirShown)}`);
  // YOLO 行（codex has_yolo_permissions：审批 Never + 沙箱近乎关闭才算；
  // full 配 read-only/workspace-write 沙箱时命令仍被 OS 层拦截，不配叫 YOLO）
  const sandboxOff = info.sandbox === undefined || info.sandbox === 'off' || info.sandbox === 'danger-full-access';
  const isYolo = ((PERM_LABEL[info.permission]?.yolo ?? false) || info.permission === 'full') && sandboxOff;
  if (isYolo) out.push(`  ${dim('permissions:')} ${bold(magenta('YOLO mode'))}`);
  out.push('');
  if (greeting != null) out.push(`  ${cyan(greeting)}`);
  return out;
}

/** 回合分隔行（codex separators.rs：耗时 >60s 才写 "Worked for Xs"，始终带本地时间，
 * 有统计时追加 `Local tools / Inference` 段；dim + 2 空格缩进）。
 * width 传入时超宽按 `· ` 边界折行（续行同缩进；上游 textwrap 对等）——统计段拉长后窄终端不溢出；
 * 缺省不折（旧调用与单测保持单行断言）。
 */
export function renderTurnSeparator(elapsedMs: number, date = new Date(), stats?: TurnStats, width?: number): string {
  const parts: string[] = [];
  const secs = Math.round(elapsedMs / 1000);
  if (secs > 60) parts.push(`Worked for ${fmtElapsed(elapsedMs)}`);
  parts.push(clockNow(date));
  if (stats) parts.push(...turnStatSegments(stats));
  if (width === undefined) return dim(`${PREFIX}${parts.join(' · ')}`);
  const lines: string[] = [];
  let cur = '';
  for (const p of parts) {
    const candidate = cur ? `${cur} · ${p}` : p;
    if (!cur || visualWidth(`${PREFIX}${candidate}`) <= width) {
      cur = candidate;
    } else {
      lines.push(cur);
      cur = p;
    }
  }
  if (cur) lines.push(cur);
  return lines.map((l) => dim(`${PREFIX}${l}`)).join('\n');
}

/**
 * 续行缩进：2 空格（与 `• ` / `› ` 同宽 2 列，对齐）。
 * 此前用过 SGR 8（conceal）隐藏版 bullet/chevron 做“同字形同宽”对齐，
 * 但多数终端直接忽略 SGR 8，续行仍显示出淡色 •/›（用户实测：思考每行左侧都有 ·）。
 * •（U+2022）按 1 列算，`• ` 与两空格同宽，沿用 codex 的空格缩进即可。
 */
const CONT_INDENT = '  ';

/**
 * 提交行按终端宽折行（CJK 感知，不断代理对）。
 * scrollback 没有布局引擎：超长行不折会被终端软换行甩到 0 列错位（实测抓到）。
 * avail 取 cols()-2（前缀占 2 列），与终端原生换行断点一致——用户回显与
 * 对话流用同一断点，擦回显时行数才对得上。
 */
export function foldRows(text: string): string[] {
  if (text === '') return [''];
  const avail = Math.max(8, cols() - 2);
  const out: string[] = [];
  let cur = '';
  let w = 0;
  for (const ch of text) {
    const cw = visualWidth(ch);
    if (w + cw > avail && cur !== '') {
      out.push(cur);
      cur = '';
      w = 0;
    }
    cur += ch;
    w += cw;
  }
  out.push(cur);
  return out;
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

/** diff 预览正文行数上限（codex patch 单元格 hunk 预览的 mini 版；统计行另计） */
const DIFF_PREVIEW_LINES = 10;
/** hunk 上下文行数：变更行前后各保留的行数，其余 ctx 折叠为 `…` */
const DIFF_PREVIEW_CTX = 2;

/**
 * 写/改文件的 hunk 预览（codex patch cell 对等）：变更行 + 上下各 2 行 ctx，
 * 其余折叠；add 绿 / rem 红 / ctx 浅色；超上限截断并注记。返回已上色成品行
 * （不含统计行；调用方在前另起 `└ +A −R` 行）。
 */
export function diffPreviewBody(detail: ToolResultDetail | undefined, width: number): { body: string[]; truncated: boolean } {
  const empty: { body: string[]; truncated: boolean } = { body: [], truncated: false };
  const ud = detail?.diff
    ? unifiedDiff(detail.diff.original ?? '', detail.diff.content)
    : detail?.edit
      ? editToUnifiedDiff(detail.edit.oldLines, detail.edit.newLines)
      : null;
  if (!ud || ud.lines.length === 0) return empty;
  // 尾部伪空行：内容末 `\n` 切出的空行不是真实变更，去掉（中间空行保留）
  const rawLines = ud.lines;
  const last = rawLines[rawLines.length - 1] as UnifiedDiffLine;
  const lines = last.text === '' ? rawLines.slice(0, -1) : rawLines;
  if (lines.length === 0) return empty;
  // hunk 过滤：保留变更行及前后 CTX 行，大段未改 ctx 折叠
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.kind === 'ctx') return;
    for (let k = Math.max(0, i - DIFF_PREVIEW_CTX); k <= Math.min(lines.length - 1, i + DIFF_PREVIEW_CTX); k++) keep[k] = true;
  });
  if (!keep.some(Boolean)) return empty;
  const maxNo = lines.reduce((m, l) => Math.max(m, l.oldNo ?? 0, l.newNo ?? 0), 0);
  const digits = Math.max(2, String(maxNo).length);
  const rows: string[] = [];
  let truncated = ud.truncated;
  let gap = false;
  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) {
      gap = true;
      continue;
    }
    if (gap) {
      if (rows.length > 0) rows.push(`${' '.repeat(4)}${dim('…')}`);
      gap = false;
    }
    if (rows.length >= DIFF_PREVIEW_LINES) {
      truncated = true;
      break;
    }
    const dl = lines[i] as UnifiedDiffLine;
    const avail = Math.max(8, width - 4 - digits - 4);
    const line = formatUnifiedDiffLine({ ...dl, text: truncateToWidth(dl.text, avail) }, digits);
    const row = `${' '.repeat(4)}${line}`;
    rows.push(dl.kind === 'add' ? green(row) : dl.kind === 'rem' ? red(row) : dim(row));
  }
  return { body: rows, truncated };
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
  /**
   * 输出协作钩子（MiniOutput 在轮内设置）。轮内 `› ` 输入行是原生 readline 行，
   * 全程可编辑——任何输出写之前 pre 先擦掉它、写完 post 原样重画，
   * 流式输出与输入行永不交错（替代之前"接管 stdin"的整套做法）。
   */
  pre: () => void = () => {};
  post: () => void = () => {};
  constructor(private enabled: boolean, private out = process.stdout) {}

  get active(): boolean {
    return this.enabled;
  }

  /** 用新内容替换当前区块（光标停在区块下一行行首） */
  update(lines: string[]): void {
    if (!this.enabled) return;
    this.pre();
    try {
      this.render(lines);
    } finally {
      this.post();
    }
  }

  private render(lines: string[]): void {
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
    this.pre();
    try {
      this.out.write(`\x1b[${this.lines.length}A\r\x1b[0J`);
      this.lines = [];
    } finally {
      this.post();
    }
  }

  /** 清掉区块后把最终内容写入滚动区（带换行、可回滚） */
  commit(lines: string[]): void {
    if (!this.enabled) {
      for (const l of lines) this.out.write(l + '\n');
      return;
    }
    this.pre();
    try {
      if (this.lines.length > 0) {
        this.out.write(`\x1b[${this.lines.length}A\r\x1b[0J`);
        this.lines = [];
      }
      for (const l of lines) this.out.write(l + '\n');
    } finally {
      this.post();
    }
  }
}

/**
 * 流式单元格：`• ` 开头、续行 2 空格缩进（codex AgentMessageCell/ReasoningSummaryCell 同款），
 * 未完成的行用 `▌` 光标原地重绘。
 */
class StreamingCell {
  private buf = '';
  private started = false;
  /** end() 后的写视为新单元格（重置 bullet/空行钩子；调用方误复用也不粘连） */
  private ended = false;

  constructor(
    private live: LiveBlock,
    private style: (line: string) => string,
    /** beforeFirst：首个单元格输出前的空行钩子（codex 相邻 HistoryCell 之间空一行）
     *  afterLine：每提交一行后回调（渲染层据此维护"当前是否已有空行"的状态） */
    private hooks: { beforeFirst?: () => void; afterLine?: () => void } = {},
    /** 行输出（MiniOutput.print：轮内带输入行擦写协作，不能直接 console.log） */
    private print: (line: string) => void = (line) => console.log(line),
    /** 首行行首：可见 bullet */
    private first = `${dim('•')} `,
    /** 续行行首：2 空格缩进（与 `• ` 同宽，见 CONT_INDENT） */
    private rest = CONT_INDENT,
    /** Markdown 行渲染（正文单元格）：逻辑行 → 可见行（已折行已上色）；缺省走旧 foldRows+style 路径 */
    private renderLine?: (line: string, avail: number) => string[],
    /** 单元格收尾时吐暂存（表格/表头候选）；缺省无 */
    private renderFlush?: (avail: number) => string[],
    /** live 预览行渲染；缺省 style + 尾部截断 */
    private renderPartialText?: (text: string, room: number) => string
  ) {}

  get began(): boolean {
    return this.started || this.buf.length > 0;
  }

  write(chunk: string): void {
    if (this.ended) {
      this.ended = false;
      this.started = false;
      this.buf = '';
    }
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
    const body = this.renderPartialText
      ? this.renderPartialText(this.buf, room)
      : this.style(tailToWidth(this.buf, room));
    this.live.update([`${this.prefix()}${body}${dim(CURSOR)}`]);
  }

  private prefix(): string {
    return this.started ? this.rest : this.first;
  }

  /** 可用列宽（前缀占 2 列，与 foldRows 断点一致） */
  private avail(): number {
    return Math.max(8, cols() - 2);
  }

  /** 一个逻辑行 → 已定样式的可见行（'' = 裸空行） */
  private toRows(line: string): string[] {
    if (this.renderLine) return this.renderLine(line, this.avail());
    return foldRows(line).map((row) => (row === '' ? '' : this.style(row)));
  }

  /** 提交可见行：仅单元格首行挂 •，其余 2 空格缩进；空数组（围栏标记/表格收集中）直接跳过 */
  private emitRows(rows: string[]): void {
    if (rows.length === 0) return;
    if (!this.started) this.hooks.beforeFirst?.();
    rows.forEach((row, idx) => {
      if (row === '') {
        this.print('');
        return;
      }
      // 仅整个单元格的首行挂 •，其余（含首个逻辑行折出来的续行）全部 2 空格缩进
      const prefix = !this.started && idx === 0 ? this.first : this.rest;
      this.print(`${prefix}${row}`);
    });
    this.started = true;
    this.hooks.afterLine?.();
  }

  private commit(line: string): void {
    this.live.clear();
    this.emitRows(this.toRows(line));
  }

  /** 收尾：冲掉缓冲区（无换行结尾的最后一行 / 空消息补行）+ 渲染器暂存（表格/表头候选） */
  end(): void {
    this.live.clear();
    const pending: string[] = [];
    if (this.buf.length > 0) {
      const line = this.buf;
      this.buf = '';
      pending.push(...this.toRows(line));
    }
    if (this.renderFlush) pending.push(...this.renderFlush(this.avail()));
    if (pending.length === 0) {
      this.ended = true;
      return;
    }
    this.emitRows(pending);
    this.ended = true;
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
  private working: { timer: NodeJS.Timeout } | null = null;
  /** 本轮是否已出过 working tip（出过则跳过同轮 completion tip，codex ca41ed3 同规则） */
  private workingTipShown = false;
  /** 当前工具的 live 单元格状态（bullet 标题 + 已流出的输出行） */
  private tool: {
    id: number;
    name: string;
    verb: string;
    detail: string;
    running: boolean;
    out: string[];
    /** 用户直跑 shell（codex is_user_shell_command）：标题用 `You ran` 而非 `Ran` */
    userShell: boolean;
  } | null = null;
  private toolSeq = 0;
  private turnStart: number | null = null;
  /** turn tip 节奏状态（onUserMessage 计轮，onAnswerEnd 记最终回答） */
  private turnCount = 0;
  private answerEnded = false;
  private turnTipsShown = 0;
  private lastTipTurn = 0;
  /** 当前光标下方是否已有一行空行（决定单元格间距——codex 相邻单元格之间恰好一行空行） */
  private gapOpen = true;
  /** 交互模式标记（cli/mini.ts 调用）：用于擦掉 readline 已回显的输入行 */
  private interactive = false;

  /**
   * 交互模式标记（cli/mini.ts 调用）：回显用户消息前擦掉 readline 自己回显的那一行
   * （否则输入会显示两遍），并打印输入区提示行（单次任务模式无提示符，不打印）。
   */
  // ── 轮内输出协作（输入侧零接管） ───────────────────────────────
  //
  // 用户要的效果：轮内打字就显示在原来那行 `› ` 输入框里（原生可编辑），
  // 不进 `↳` 那块；发送只由自己按 Enter。所以输入侧什么都不做——readline
  // 全程原生（退格/方向键/Ctrl+U/IME 全保留），轮内按 Enter 就是原生提交，
  // 由 for-await 在轮末自然产出（自己按的才发，没按的永远不发）。
  // 这里只解决输出侧：readline 的 `_refreshLine` 会把 `› ` 行画在当前光标处，
  // 与流式输出交错画花——于是每次输出前 preOut 先擦掉输入行、写完 postOut
  // 原样重画（`rl.prompt(true)`，光标保留）。JS 单线程下按键事件只会落在
  // 两次输出操作之间，不丢不错位。
  private rl: {
    pause(): void;
    resume(): void;
    write(data: string | null, key?: { ctrl?: boolean; name?: string }): void;
    line: string;
    /** preserveCursor=true 时不要把光标重置为 0（否则轮内打的字会被推到行首） */
    prompt(preserveCursor?: boolean): void;
  } | null = null;
  private capturing = false;
  private yieldedInput = false;
  /** 输出协作嵌套深度（成对调用里层直接过，避免重复擦写） */
  private outDepth = 0;

  /** 轮内输出前：擦掉当前 `› ` 输入行（光标停在行首，后续输出写在它上面） */
  private preOut(): void {
    if (!this.capturing || this.outDepth++ > 0) return;
    process.stdout.write('\r\x1b[2K');
  }

  /** 轮内输出后：在内容末尾把 `› ` + 当前行缓冲原样重画回来 */
  private postOut(): void {
    if (!this.capturing || --this.outDepth > 0) return;
    this.rl?.prompt(true);
  }

  /**
   * 行输出统一入口：轮内带输入行擦写协作，轮外/管道直通。
   * 本类里所有 console.log 一律走这里（直接 console.log 会与输入行交错）。
   */
  print = (line: string): void => {
    this.preOut();
    try {
      process.stdout.write(line + '\n');
    } finally {
      this.postOut();
    }
  };

  /**
   * Ctrl+T 账本落盘（codex 6a39914 mini 版）：先清 live 块再打印——
   * 轮内（Working/流式/双行 tip）按 Ctrl+T 时，不与 live 重绘抢同一区域；
   * 清掉后 live 下次 update 从光标新位置起画，旧状态行不残留不重影。
   * 调用方传已组装好的 header/lines（含缩进与着色），这里只管落盘顺序。
   */
  dumpLedger(header: string, lines: string[]): void {
    this.live.clear();
    this.print('');
    this.print('');
    this.print(header);
    for (const l of lines) this.print(l);
    this.print('');
  }

  private beginInputCapture(): void {
    if (this.capturing || this.yieldedInput) return;
    if (!this.rl || !this.live.active) return;
    this.capturing = true;
    // 输入侧零接管：首个输出到达时 preOut/postOut 会自然画出输入行。
    this.live.pre = () => this.preOut();
    this.live.post = () => this.postOut();
  }

  /** 轮末：解除输出协作（输入行留在原地，safePrompt 会重画一次） */
  private endInputCapture(): void {
    if (!this.capturing) return;
    this.capturing = false;
    this.live.pre = () => {};
    this.live.post = () => {};
  }

  /**
   * 输入行是否有字（interactive 的 safePrompt 据此决定是否 prompt(true)；
   * console 等非 mini 渲染层没有该方法，可选链回退 false，原行为不变）。
   * 新设计下文字本来就在 readline 行缓冲里，直接看长度即可——无回填无标记。
   */
  takeParked(): boolean {
    return (this.rl?.line.length ?? 0) > 0;
  }

  /** 审批/提问期间主 rl 失聪用的 keypress 暂存（轮内输出协作不动它） */
  private savedKeypress: ((...args: any[]) => void)[] | null = null;

  private yieldInput(): void {
    if (!this.capturing) return;
    this.yieldedInput = true;
    this.endInputCapture();
    // 审批/提问用的是另一个 readline：确认回车若同时进主 rl，会被 for-await
    // 缓冲成下一轮自动发送（实锤过的真 bug）。这里把主 rl 的 keypress 请走，
    // 审批结束后 resumeInput 原样装回（解码器靠自管理恢复，raw 不动）。
    this.savedKeypress = (process.stdin.listeners('keypress') as unknown as ((...args: any[]) => void)[]);
    process.stdin.removeAllListeners('keypress');
  }

  private resumeInput(): void {
    this.yieldedInput = false;
    for (const l of this.savedKeypress ?? []) process.stdin.on('keypress', l);
    this.savedKeypress = null;
    if (this.turnStart != null) this.beginInputCapture();
  }

  /** readline 句柄注入（runInteractive 的 onRl 回调） */
  attachInput(rl: {
    pause(): void;
    resume(): void;
    write(data: string | null, key?: { ctrl?: boolean; name?: string }): void;
    line: string;
    prompt(preserveCursor?: boolean): void;
  }): void {
    this.rl = rl;
  }

  /**
   * 外部编辑器组稿（codex Ctrl+G 对等）：空闲提示符下把当前行当种子
   * 丢进 `$VISUAL`/`$EDITOR`，存盘后回填行缓冲（回车才提交）。
   * 返回：'done' 已回填 / 'empty' 存空（行清空）/ 'no-editor' 未配置 /
   * 'failed' 失败（已打印原因）/ 'busy' 轮内或非交互（调用方忽略）。
   */
  openExternalEditor(): 'done' | 'empty' | 'no-editor' | 'failed' | 'busy' {
    // 空闲门控用 turnStart（轮内 true，含审批/提问；live.active 只是 live 渲染总开关，恒为 true，不能当空闲判据）
    if (!this.interactive || !this.rl || !process.stdin.isTTY || this.turnStart != null) return 'busy';
    const cmd = resolveEditorCommand();
    if (!cmd) return 'no-editor';
    const initial = this.rl.line;
    this.live.clear();
    this.print('');
    this.print(dim('正在打开外部编辑器组稿（存盘退出回填 `:wq`，放弃用 `:q!`）…'));
    const res = composeInEditor(initial, cmd);
    if (!res.ok) {
      this.print(dim(`外部编辑器：${res.error}`));
      this.rl.prompt();
      return 'failed';
    }
    // Ctrl+U 清行再回填（write(null, key) 走 readline 按键模拟，非显示层擦除）
    this.rl.write(null, { ctrl: true, name: 'u' });
    if (res.text) this.rl.write(res.text);
    this.rl.prompt();
    return res.text ? 'done' : 'empty';
  }

  /** 通知打印后把 `› ` 输入行重画回来（readline 下次按键也会自重画，这里立即恢复） */
  repaintInput(): void {
    this.rl?.prompt(true);
  }

  markInteractive(): void {
    this.interactive = true;
    if (this.opts.stream) {
      // 双行（上游 footer hint rows 对等）：单行超 80 列会被终端原生折行（续行顶格难看），按功能拆两行
      this.print(`${PREFIX}${dim('⏎ 发送 · \\ 续行 · /stop 停止 · Ctrl+C 中断 · /exit 退出')}`);
      this.print(`${PREFIX}${dim('Ctrl+T 轨迹 · Ctrl+G 编辑器 · 空行 Esc 取回 · ? 帮助')}`);
      this.print('');
    }
  }

  /** 需要时补一个空行（单元格间距）；已有空行则不动 */
  private ensureGap(): void {
    if (this.gapOpen) return;
    this.print('');
    this.gapOpen = true;
  }

  /** 正文单元格（codex AgentMessageCell：`• ` + 续行 2 空格；内容走 Markdown 渲染） */
  private newAnswerCell(): StreamingCell {
    const md = (this.opts.markdown ?? useColor) ? new MiniMarkdownRenderer() : null;
    return new StreamingCell(this.live, (l) => inlineMathToText(l), {
      beforeFirst: () => this.ensureGap(),
      afterLine: () => {
        this.gapOpen = false;
      },
    }, (line) => this.print(line),
    undefined, undefined,
    md ? (line, avail) => md.pushLine(line, avail) : undefined,
    md ? (avail) => md.flush(avail) : undefined,
    md ? (text, room) => md.partial(text, room) : undefined);
  }

  /** 思考单元格（codex ReasoningSummaryCell：同为 `• ` 单元格，但 dim + italic） */
  private newReasoningCell(): StreamingCell {
    return new StreamingCell(this.live, (l) => italic(dim(inlineMathToText(l))), {
      beforeFirst: () => this.ensureGap(),
      afterLine: () => {
        this.gapOpen = false;
      },
    }, (line) => this.print(line));
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

  /** 会话头 + 上手帮助 + Tip 行（codex compact 头 + new_session_info 首事件帮助块；问候语每次启动取一条） */
  banner(cfg: OmniConfig): void {
    const info: MiniBannerInfo = {
      directory: process.cwd(),
      permission: cfg.permission ?? 'safe',
      sandbox: cfg.sandbox,
    };
    for (const line of renderMiniBanner(info, cols(), pickMiniGreeting())) this.print(line);
    this.print('');
    this.print(`${PREFIX}${dim('To get started, describe a task or try one of these commands:')}`);
    this.print('');
    const helps: Array<[string, string]> = [
      ['/init', 'create an AGENTS.md file with instructions'],
      ['/status', 'show current session configuration'],
      ['/model', 'choose what model and reasoning effort to use'],
      ['/review', 'review any changes and find issues'],
    ];
    for (const [cmd, desc] of helps) this.print(`${PREFIX}${cmd} ${dim(`- ${desc}`)}`);
    this.print('');
    const tip = TIPS[Math.floor(Math.random() * TIPS.length)] ?? TIPS[0]!;
    this.print(`${PREFIX}${dim(`Tip: ${tip}`)}`);
    this.print('');
  }

  // ── 运行中状态行 ───────────────────────────────────────────────
  onRound(_step: number, _maxSteps: number): void {
    if (!this.opts.stream) return;
    this.resetCells(); // 每次 LLM 请求 = 一条独立消息/思考块
    this.startWorking();
  }

  private startWorking(hint = 'esc to interrupt'): void {
    if (!this.live.active || this.working) return;
    // turn 级计时（onTurnStart 置位；多 LLM round 共用同一 working 语义，30s 阈值按整轮算）
    const started = this.turnStart ?? Date.now();
    let i = 0;
    const tick = (): void => {
      const secs = Math.floor((Date.now() - started) / 1000);
      const line = renderWorkingLine(secs, ACTIVITY_FRAMES[i++ % ACTIVITY_FRAMES.length]!, hint);
      if (shouldShowWorkingTip(secs, this.workingTipShown)) this.workingTipShown = true;
      this.live.update(workingLines(line, this.workingTipShown ? this.workingTipText() : null));
    };
    tick();
    this.working = { timer: setInterval(tick, 100) };
  }

  /** 本轮 working tip 文案（首现时随机定稿，同轮后续 tick 沿用同一条，不闪变） */
  private workingTipMemo: string | null = null;
  private workingTipText(): string {
    if (!this.workingTipMemo) {
      this.workingTipMemo = TIPS[Math.floor(Math.random() * TIPS.length)] ?? TIPS[0]!;
    }
    return this.workingTipMemo;
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
    this.answerEnded = true;
  }

  onUsage(_usage: TokenUsage): void {}

  /** LLM 单轮耗时折入本轮统计（分隔行 Inference 段数据源；调用次数同步累加） */
  onLlmLap(llmMs: number): void {
    this.turnStats.llmCalls += 1;
    this.turnStats.llmMs += Math.max(0, llmMs);
  }

  /** 工具执行耗时折入本轮统计（分隔行 Local tools 段时长数据源；次数按结果计数） */
  onToolsLap(toolsMs: number): void {
    this.turnStats.toolMs += Math.max(0, toolsMs);
  }

  /** 本轮统计累积（separators.rs RuntimeMetricsSummary 子集；onTurnStart 清零） */
  private turnStats: TurnStats = { toolCalls: 0, toolMs: 0, llmCalls: 0, llmMs: 0 };

  onTurnStart(): void {
    this.turnStart = Date.now();
    this.turnStats = { toolCalls: 0, toolMs: 0, llmCalls: 0, llmMs: 0 };
    this.answerEnded = false; // `!` 直跑回合无正文：防沿用上一轮标记误发 tip
    this.beginInputCapture();
  }

  onRequestFailed(err: unknown): void {
    this.stopWorking();
    this.print(`${dim('•')} ${red('Request failed')} ${dim((err as Error)?.message ?? String(err))}`);
  }

  onFallback(model: string): void {
    this.print(`${dim('•')} ${dim(`fallback → ${model}`)}`);
  }

  onThinkingSaved(len: number, file: string | null): void {
    if (this.opts.showThinking && !isTTY && this.opts.stream) {
      this.print(dim(`thinking (${len} chars) → ${file ?? '.omni/last-thinking.md'}`));
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
      userShell: (args as Record<string, unknown> | undefined)?.[USER_SHELL_FLAG] === true,
    };
    this.renderTool();
  }

  /** 运行中：`⠋ Running <cmd>`（codex exec cell 活动态）+ 已流出的输出尾部 */
  private renderTool(): void {
    const t = this.tool;
    if (!t) return;
    if (!this.live.active) return;
    const width = termWidth();
    const title = t.userShell ? 'You ran' : t.verb;
    const head = t.running
      ? `${dim(ACTIVITY_FRAMES[Math.floor(Date.now() / 100) % ACTIVITY_FRAMES.length]!)} ${bold('Running')} ${truncateToWidth(t.detail, width)}`
      : `${green(bold('•'))} ${bold(title)} ${truncateToWidth(t.detail, width)}`;
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
    this.turnStats.toolCalls += 1;
    if (!this.opts.stream) return;
    const t = this.tool;
    this.tool = null;
    this.reasoning?.end();
    this.reasoning = null;
    if (!t || (toolSeq != null && toolSeq !== t.id)) return;

    const width = termWidth();
    // bullet 是状态色：成功绿 / 失败红（codex exec_cell/render.rs），失败同时换 ✗ 起头
    const bullet = ok ? green(bold('•')) : red(bold('•'));
    const head = `${bullet} ${bold(t.userShell ? 'You ran' : t.verb)} ${truncateToWidth(t.detail, width)}`;
    const lines: string[] = [head];

    const diff = diffStatLine(detail);
    if (diff) {
      lines.push(diff.replace(new RegExp(`^${PREFIX}`), PREFIX));
      const prev = diffPreviewBody(detail, width);
      lines.push(...prev.body);
      if (prev.truncated) lines.push(`${' '.repeat(4)}${dim('…（diff 较长，仅显示变更附近）')}`);
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
  /** 用户消息：首行 `› ` + 续行 2 空格缩进 + 前后空行 */
  onUserMessage(text: string): void {
    this.answer.end();
    this.turnCount += 1;
    this.answerEnded = false;
    // 折行后回显可能多行：先算出折后行数，一次擦掉 readline 回显的整块——
    // 让"输入 → 提交 → 落进对话流"只出现一次（回显与对话流用同一断点，行数一致）。
    const rows = text.split('\n').flatMap((l) => foldRows(l));
    if (this.interactive && this.live.active) {
      process.stdout.write(`\x1b[${rows.length}A\r\x1b[0J`);
    }
    this.print('');
    rows.forEach((l, i) => this.print(l === '' ? '' : `${i === 0 ? `${bold(dim('›'))} ` : CONT_INDENT}${l}`));
    this.print('');
    this.gapOpen = true;
  }

  /** 回合结束：dim 的 `Worked for Xs · 16:41` 分隔行（codex separators.rs） */
  onTurnEnd(): void {
    const skipCompletionTip = this.workingTipShown;
    this.workingTipShown = false;
    this.workingTipMemo = null;
    this.stopWorking();
    const start = this.turnStart;
    this.turnStart = null;
    if (start != null) {
      this.ensureGap();
      this.print(renderTurnSeparator(Date.now() - start, new Date(), { ...this.turnStats }, termWidth()));
      this.gapOpen = false;
    }
    if (
      this.opts.stream &&
      !skipCompletionTip &&
      shouldShowTurnTip({ turn: this.turnCount, shown: this.turnTipsShown, lastShownTurn: this.lastTipTurn, hasAnswer: this.answerEnded })
    ) {
      const tip = TIPS[Math.floor(Math.random() * TIPS.length)] ?? TIPS[0]!;
      this.ensureGap();
      this.print(`${PREFIX}${dim(`Tip: ${tip}`)}`);
      this.gapOpen = false;
      this.turnTipsShown += 1;
      this.lastTipTurn = this.turnCount;
    }
    this.endInputCapture(); // 轮末：释放输入权 + 把排队内容回填给 readline
  }

  onWaitForInput(): void {}

  clearScrollback(): void {}

  onMaxSteps(max: number): void {
    this.print(`\n${yellow('⚠ 已达到最大步数')}（${max}），任务可能未完成。可增大 OMNI_MAX_STEPS 重试。`);
  }

  showHelp(): void {
    printHelp();
  }

  onHookOutput(event: HookEventName, lines: string[]): void {
    if (!this.opts.stream) return;
    for (const l of lines) this.print(`${PREFIX}${dim(`hook[${event}] ${l}`)}`);
  }

  onAutoReview(req: ApprovalRequest, verdict: { approve: boolean; reason: string }): void {
    if (!this.opts.stream) return;
    const mark = verdict.approve ? '✓ 自动批准' : '✗ 自动拒绝';
    this.print(`${PREFIX}${dim(`auto-review ${mark} ${req.tool}${verdict.reason ? ` · ${verdict.reason}` : ''}`)}`);
  }

  onBackgroundSubagentDone(r: { id: string; name: string; status: 'ok' | 'err'; result: string; durationMs: number }): void {
    if (!this.opts.stream) return;
    const ok = r.status === 'ok';
    this.print(
      `${PREFIX}${dim(`${ok ? '✓' : '✗'} 后台子代理「${r.name}」${ok ? '完成' : '失败'} · ${(r.durationMs / 1000).toFixed(1)}s（结果已注入对话）`)}`
    );
  }

  onSubagentEvent(ev: import('../agent/types.js').SubagentEvent): void {
    if (!this.opts.stream) return;
    const indent = PREFIX + PREFIX.repeat(ev.depth);
    if (ev.type === 'start') {
      this.print(`${indent}${dim(`↳ 子代理 ${ev.name} 开始：${(ev.task ?? '').split('\n')[0]}`)}`);
    } else if (ev.type === 'step') {
      this.print(`${indent}${dim(`↳ 子代理 ${ev.name} · ${ev.tool ?? '思考中'} ${ev.step}/${ev.maxSteps}`)}`);
    } else if (ev.type === 'stopped') {
      this.print(`${indent}${dim(`⏹ 子代理 ${ev.name} 已停止`)}`);
    } else if (ev.type === 'end') {
      this.print(
        `${indent}${dim(`${ev.status === 'ok' ? '✓' : '✗'} 子代理 ${ev.name} 完成 · ${ev.steps} 步 · ${((ev.durationMs ?? 0) / 1000).toFixed(1)}s`)}`
      );
    }
  }

  // ── 审批 / 提问（readline，写 stderr 不污染 stdout） ────────────
  /**
   * 问答消费行吞没队列（双 readline 实锤两连 bug 之二：审批/提问的答案字节会同时进主 rl
   * 行缓冲，下一轮被当成用户消息误发给模型；其一是次 readline close() 会 pause 共享
   * stdin 致主循环饿死，见 input.resume() 处注释）。
   * 只记非空原文（trimmed，与主循环比对口径一致）；FIFO 队首命中；上限 10 防堆积。
   */
  private swallowedQa: string[] = [];
  private recordSwallowedQa(ans: string): void {
    const t = ans.trim();
    if (!t) return;
    this.swallowedQa.push(t);
    while (this.swallowedQa.length > 10) this.swallowedQa.shift();
  }

  /**
   * 主循环调用：行文本命中队首消费记录则返回 true（调用方跳过本行）。
   * 不命中不清理（乱序到达的消费行仍在队首等后面的轮次）。
   */
  swallowQaLine(line: string): boolean {
    if (this.swallowedQa.length > 0 && this.swallowedQa[0] === line.trim()) {
      this.swallowedQa.shift();
      return true;
    }
    return false;
  }

  private approvalTail: Promise<void> = Promise.resolve();
  /** 本会话记住的审批（codex "allow for session"）：键 = 工具 + 精确摘要，同命令才自动放行 */
  private sessionApprovals = new Set<string>();
  /** 预置会话记住（测试 / 外部面板用；与审批 UI 中按 `a` 等效） */
  rememberApproval(tool: string, summary: string): void {
    this.sessionApprovals.add(approvalSessionKey(tool, summary));
  }
  /** 清掉会话记住（`/new` 新会话文件时调用；codex 会话级 allow 随会话结束） */
  clearSessionApprovals(): void {
    this.sessionApprovals.clear();
  }
  requestApproval(req: ApprovalRequest): Promise<boolean> {
    let resolveMe!: (b: boolean) => void;
    const p = new Promise<boolean>((r) => (resolveMe = r));
    this.approvalTail = this.approvalTail.then(async () => {
      try {
        resolveMe(await this.decideApproval(req));
      } catch {
        resolveMe(false);
      }
    });
    return p;
  }

  private async decideApproval(req: ApprovalRequest): Promise<boolean> {
    const key = approvalSessionKey(req.tool, req.summary);
    if (this.sessionApprovals.has(key)) {
      if (this.opts.stream) this.print(`${PREFIX}${dim(`✓ 会话已记住 ${req.tool}（自动放行）`)}`);
      return true;
    }
    const ans = await this.promptApproval(req);
    if (ans === 'session') {
      this.sessionApprovals.add(key);
      if (this.opts.stream) this.print(`${PREFIX}${dim(`已记住：本会话内 ${req.tool} 同类操作自动放行`)}`);
      return true;
    }
    return ans === 'once';
  }

  private async promptApproval(req: ApprovalRequest): Promise<'once' | 'session' | 'deny'> {
    if (!isTTY) return 'deny';
    this.yieldInput();
    this.stopWorking();
    this.live.clear();
    const rl = readline.createInterface({ input, output: errOut });
    try {
      const ans = await rl.question(formatApprovalPrompt(req));
      // 答案字节同时进了主 rl 行缓冲：记下来给主循环吞掉，否则下一轮误发给模型
      this.recordSwallowedQa(ans);
      return parseApprovalAnswer(ans);
    } finally {
      rl.close();
      this.resumeInput();
      // 次 readline 的 close() 会 pause 共享 stdin，主循环自此饿死（PTY 实证：
      // 审批后一切输入无响应、退出码却是“干净”的假象）——显式恢复流动
      input.resume();
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
      this.recordSwallowedQa(ans);
      return parseAskAnswer(ans, options);
    } finally {
      rl.close();
      this.resumeInput();
      input.resume();
    }
  }
}

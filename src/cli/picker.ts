/**
 * mini/console 共用的上下箭头选择器（/model、/variants 无参 TTY 分支用）。
 * 调用方拼好 items（label 为已着色成品行，不含序号），picker 只负责导航渲染。
 */
import readline from 'node:readline';
import { bold, cyan, dim, magenta, red } from '../ui.js';
import { detectMention, listMentionCandidates } from '../tui/mention.js';

export interface PickerItem {
  /** 已着色成品行（不含序号；`✓` 当前标记由调用方拼入） */
  label: string;
  value: string;
}

export interface PickerOptions {
  /** 初始高亮下标 */
  selected: number;
  /** 底部提示行（缺省默认文案） */
  hint?: string;
}

const DEFAULT_HINT = '↑↓ 选择 · 数字直选 · Enter 确认 · Esc 取消';

/** mini/console 斜杠命令表（Tab 补全用；加新命令时同步这里，来源是 interactive.ts 的分支） */
export const MINI_SLASH_COMMANDS = [
  '/exit', '/clear', '/new', '/plan', '/permission', '/undo', '/spec', '/preset',
  '/skill', '/compact', '/agents', '/orchestrate', '/goal', '/loop', '/review',
  '/btw', '/variants', '/settings', '/model', '/status', '/context', '/export',
  '/mcp', '/diff', '/rewind', '/rename', '/memory-apply', '/fork', '/send',
  '/resume', '/cd', '/pin', '/archive', '/unarchive', '/auto', '/vim',
  '/team', '/session', '/redo', '/doctor', '/trace', '/init', '/import', '/recap',
  '/copy', '/pwd', '/quit', '/stop', '/delete', '/tasks', '/plugin', '/warnings',
  '/skills', '/plugins', '/hooks', '/rollout',
];

export interface CompleteContext {
  /** 可用模型名（runOpts.models 实时读） */
  modelNames: string[];
  /** 当前模型名（决定 variants 命名表） */
  modelName: string;
  /** 字符串思考级别选项 */
  effortOptions: string[];
  /** 当前模型的命名 variants id */
  variantIds: string[];
}

/**
 * /model 选择器行文案（codex 模型面板对等）：有多少字段拼多少——
 * 名称 · provider · 上下文k/输出k · 思考级别 · 当前✓（缺字段跳过，不断言）。
 */
export function formatModelPickLabel(
  m: {
    name: string;
    displayName?: string;
    provider?: string;
    limit?: { context?: number; output?: number };
    reasoningEffort?: string;
  },
  isCurrent: boolean
): string {
  const fmtK = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}K` : `${n}`);
  const segs = [m.displayName ?? m.name];
  if (m.provider) segs.push(m.provider);
  const k = [m.limit?.context ? fmtK(m.limit.context) : '', m.limit?.output ? fmtK(m.limit.output) : '']
    .filter(Boolean)
    .join('/');
  if (k) segs.push(k);
  if (m.reasoningEffort) segs.push(m.reasoningEffort);
  if (isCurrent) segs.push('✓');
  return segs.join(' · ');
}

/** completeMiniLine 可选扩展（data-driven 第二词补全；fs 只在调用方侧） */
export interface CompleteExtra {
  /** 按命令的第二词候选（如 /mcp→reconnect/resources/prompts） */
  secondWords?: Record<string, string[]>;
  /** /cd 目录候选（条目以 / 结尾，调用方同步 readdir 组装） */
  dirs?: string[];
}

/**
 * readline Tab 补全纯函数：`/mo`→命令名、`/model <片>`→模型名（含 add/fetch）、
 * `/variants <片>`→级别/命名 id。只读行缓冲不提交；返回 [候选项, 被替换的词尾]。
 */
export function completeMiniLine(line: string, ctx: CompleteContext, extra?: CompleteExtra): [string[], string] {
  const head = line.trimStart();
  if (!head.startsWith('/')) return [[], line];
  const parts = head.split(/\s+/);
  if (parts.length <= 1) {
    const word = parts[0]!;
    const hits = MINI_SLASH_COMMANDS.filter((c) => c.startsWith(word) && c !== word);
    if (hits.length > 0) return [hits, word];
    // 命令已打全：补一个空格方便继续输参数
    if (MINI_SLASH_COMMANDS.includes(word)) return [[`${word} `], word];
    // 无前缀命中 → 模糊兜底（与联想面板同算法）：唯一命中直接补全（含尾空格），
    // 多命中交 readline 双 Tab 列表（@ 提及单选直插同款节奏）
    const fuzzy = fuzzySlashMatch(word.slice(1));
    if (fuzzy.length === 1) return [[`${fuzzy[0]} `], word];
    return [fuzzy, word];
  }
  const [cmd, arg] = parts;
  if (arg === undefined || parts.length > 2) return [[], line];
  // /cd 特殊：读调用方组装的目录候选（条目以 / 结尾）
  if (cmd === '/cd' && extra?.dirs) {
    return [extra.dirs.filter((d) => d.startsWith(arg) && d !== arg), arg];
  }
  // 通用第二词补全（data-driven：调用方经 secondWords 透传各命令候选）
  const second = cmd !== undefined ? extra?.secondWords?.[cmd] : undefined;
  if (second) {
    return [second.filter((w) => w.startsWith(arg) && w !== arg), arg];
  }
  if (cmd === '/model') {
    const names = [...ctx.modelNames, 'add', 'fetch'];
    return [names.filter((n) => n.startsWith(arg) && n !== arg), arg];
  }
  if (cmd === '/variants') {
    const opts = [...ctx.effortOptions, ...ctx.variantIds];
    return [opts.filter((o) => o.startsWith(arg) && o !== arg), arg];
  }
  return [[], line];
}

/**
 * 候选清单最长公共前缀（readline 补全语义：多候选只补公共前缀，绝不弹原生哑巴列表——
 * 原生列表会把输入行重画到列表下方，联想面板的整块 DL 光标纪律随之错位，历史 bug 源）。
 */
export function commonPrefix(items: readonly string[]): string {
  if (items.length === 0) return '';
  let prefix = items[0]!;
  for (const it of items) {
    let i = 0;
    while (i < prefix.length && i < it.length && prefix[i] === it[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  return prefix;
}

/**
 * @ 提及匹配核心（纯函数）：非 / 文本 + detectMention 命中 → 候选列表。
 * cursor 缺省行末（readline completer 拿不到光标；按键拦截器传精确光标）。
 * / 命令文本返回 null（TUI 同款：/ 文本不显示提及）。
 */
export interface MentionMatch {
  atIndex: number;
  query: string;
  cands: string[];
}

export function matchMention(line: string, cwd: string, cursor: number = line.length): MentionMatch | null {
  if (line.trimStart().startsWith('/')) return null;
  const m = detectMention(line, cursor);
  if (!m) return null;
  return { atIndex: m.atIndex, query: m.query, cands: listMentionCandidates(cwd, m.query) };
}

/**
 * @ 提及 Tab 补全纯函数（readline completer 兜底用）：
 * 文件候选尾加空格（结束提及，TUI insertMention 同款），目录保留 /（继续深入）。
 * 返回 [候选, 被替换词] 供 readline：单候选行内补全，多候选双 Tab 列表。
 */
export function completeMention(line: string, cwd: string, cursor: number = line.length): [string[], string] | null {
  const m = matchMention(line, cwd, cursor);
  if (!m) return null;
  const word = `@${m.query}`;
  const hits = m.cands.map((c) => (c.endsWith('/') ? `@${c}` : `@${c} `));
  return [hits, word];
}

/**
 * `!` shell 判定（codex ChatComposer::is_bang_shell_command：trim_start 后首字为 `!`）。
 * mini readline 与 TUI 提及面板共用：`!git status` 直跑 shell，不进 LLM。
 */
export function isBangShellCommand(text: string): boolean {
  return text.trimStart().startsWith('!');
}

/**
 * 模式提示符（codex footer 模式指示的 mini 版：Plan 显示品红 `plan` 前缀，
 * bash mode 显示红 `!`；优先级 bang > plan > normal——shell 直跑不受 plan 约束）。
 * 管道下为纯文本，TTY 上色。
 */
export function formatModePrompt(mode: 'normal' | 'plan' | 'bang', base: string): string {
  if (mode === 'bang') return red(bold('! '));
  if (mode === 'plan') return `${magenta('plan')} ${base}`;
  return base;
}

/**
 * 续行判定：行尾单个 `\`（`\\` 转义不算；codex 多行 composer 的行式终端版）。
 * readline 无法可靠拦截 Ctrl+J（0x0A 照样提交且内部监听先行），改走 shell 式续行。
 */
export function hasLineContinuation(line: string): boolean {
  const m = /\\+$/.exec(line);
  return !!m && m[0].length % 2 === 1;
}

/** 去掉续行反斜杠（`abc\` → `abc`；调用方把后续行以 `\n` 拼进同一条消息） */
export function stripLineContinuation(line: string): string {
  return line.slice(0, -1);
}

/**
 * 续行块组装：forShell 时保留反斜杠（sh 自带 `\` 续行语义，剥掉反而会把换行当命令分隔）；
 * 其余去标记后换行拼接。parts[0..n-2] 恒带标记，末行按实际判定。
 */
export function joinContinued(parts: string[], forShell: boolean): string {
  if (forShell) return parts.join('\n');
  return parts.map((p) => (hasLineContinuation(p) ? stripLineContinuation(p) : p)).join('\n');
}

/** 续行提示符（积累中输入行的缩进指示，codex composer 续行同款省略号） */
export function contPrompt(): string {
  return dim('… ');
}

/**
 * 历史搜索条目（codex history-search Ctrl+R 的 mini 版）：去空去重保序、上限 50。
 * 输入为 rl.history（readline 最新在前）；value 保留原文（回填整行），label 去首尾空格。
 */
export function historySearchItems(history: readonly string[], limit = 50): PickerItem[] {
  const seen = new Set<string>();
  const out: PickerItem[] = [];
  for (const h of history) {
    const label = h.trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push({ label, value: h });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 单行 `?` 判定（codex `?` 快捷键覆盖层的行式版）：整行恰好一个问号才是帮助，
 * 问句（`xxx?`）照常发给模型。
 */
export function isShortcutsHelpRequest(text: string): boolean {
  return text.trim() === '?';
}

/** 快捷键帮助行（codex shortcut overlay 的 mini 版：只列本终端实际生效的键） */
export function formatShortcutsHelp(): string[] {
  return [
    'Enter 发送 · \\ 续行（行尾反斜杠拼多行）',
    '! 开头直跑 shell（bash mode，不进模型）',
    '@ 提及文件/图片（Tab 补全），/ 斜杠命令（Tab 补全）',
    'Tab 补全 · Ctrl+R 历史搜索（选中回填，不提交）',
    'Esc 或 /stop 中断当前任务 · Ctrl+C 中断/清行 · Ctrl+T 完整轨迹 · Ctrl+G 外部编辑器组稿 · 空行 Esc 取回上一条',
    'Ctrl+D 退出（与 /exit 同一收尾） · /quit 也是退出',
  ];
}

/**
 * 粘贴突发跟踪（codex 粘贴启发式的 mini 版；readline 层面拦不住按行提交，
 * 只能事后提示）。
 * 终端 bracketed-paste 把粘贴包在 paste-start/paste-end 按键里送达（readline 原生解码，
 * 无需本侧开启）；突发内每 1 个换行 = 多 1 次提交。takePending 取走待提示行数。
 */
export class PasteBurstTracker {
  private enters = -1;
  private pendingLines = 0;
  /** 喂一次按键名（调用方只传 key?.name） */
  key(name: string | undefined): void {
    if (name === 'paste-start') {
      this.enters = 0;
      return;
    }
    if (name === 'paste-end') {
      if (this.enters >= 1) this.pendingLines += this.enters + 1;
      this.enters = -1;
      return;
    }
    if (this.enters >= 0 && (name === 'enter' || name === 'return')) this.enters += 1;
  }
  /** 取走待提示行数并清零（safePrompt 处打印） */
  takePending(): number {
    const n = this.pendingLines;
    this.pendingLines = 0;
    return n;
  }
}

/** 剥掉 `!` 前缀取 shell 命令体（`!git status` → `git status`；裸 `!` → ''） */
export function stripBangPrefix(text: string): string {
  return text.trimStart().slice(1).trim();
}

/**
 * TTY 下渲染箭头选择器并等待按键，返回选中下标；Esc / Ctrl+C 取消返回 -1。
 * 非 TTY 直接返回 -1（调用方走原纯文本列表路径）。
 *
 * 按键协议：保存全部 keypress 监听 → 先挂自己的 → 逐个摘掉保存的
 * （计数恒≥1；只动 keypress，解码器的 data 不动；绝不用 removeAllListeners）
 * → 收尾摘掉自己的、按原序装回。raw mode 全程不动。
 */
export async function pickFromList(
  stdin: NodeJS.ReadStream,
  items: PickerItem[],
  opts: PickerOptions
): Promise<number> {
  if (!stdin.isTTY || items.length === 0) return -1;
  // 确保有 keypress 事件（重复调用加守卫，避免叠加 data 解码器）
  const flagged = stdin as NodeJS.ReadStream & { __omniKeypressOn?: boolean };
  if (!flagged.__omniKeypressOn) {
    readline.emitKeypressEvents(stdin);
    flagged.__omniKeypressOn = true;
  }

  const out = process.stdout;
  const hint = opts.hint ?? DEFAULT_HINT;
  let sel = Math.min(Math.max(opts.selected, 0), items.length - 1);
  const block = items.length + 1; // 菜单行 + 底部提示行

  /** 收尾清场（未经确认/取消都删掉菜单块，不在对话流里留残块——此前 done 直接 resolve，
   * 菜单永久留在 scrollback，每次 Tab 多选都多十几行杂物）。
   * 调用时光标在块下方：上移到块首 → DL 整块删除 → 回列首；
   * 调用方随后重画输入行/打印结果，无缝接回。 */
  const cleanup = (): void => {
    out.write(`\x1b[${block}A`);
    out.write(`\x1b[${block}M`);
    out.write('\r');
  };

  const renderRow = (i: number): string => {
    const prefix = i === sel ? bold(cyan('› ')) : '  ';
    const body = i === sel ? bold(cyan(items[i].label)) : items[i].label;
    return `${prefix}${body}`;
  };
  const paint = (): void => {
    for (let i = 0; i < items.length; i++) out.write(`\x1b[2K\r${renderRow(i)}\n`);
    out.write(`\x1b[2K\r${dim(hint)}\n`);
  };
  const repaint = (): void => {
    out.write(`\x1b[${block}A`);
    paint();
  };

  // 首屏打印全部行（选中行 › 前缀 + cyan bold；未选中行两空格前缀）+ 底部 dim 提示行
  paint();

  return new Promise<number>((resolve) => {
    // 先挂自己的，再逐个摘掉保存的（own 占位，计数恒≥1）
    const saved = [...stdin.listeners('keypress')] as ((...args: unknown[]) => void)[];
    const done = (n: number): void => {
      // 确认/取消都先删掉菜单块（scrollback 不留残块；调用方随后 redraw 重画输入行）
      try {
        cleanup();
      } catch {
        /* 清场失败不影响结果 */
      }
      stdin.removeListener('keypress', onKey);
      for (const fn of saved) stdin.on('keypress', fn as (...args: unknown[]) => void);
      resolve(n);
    };
    const onKey = (_ch: unknown, key?: { name?: string; ctrl?: boolean }): void => {
      const name = key?.name ?? '';
      if (key?.ctrl && name === 'c') {
        done(-1);
        return;
      }
      if (name === 'up') {
        sel = (sel - 1 + items.length) % items.length;
        repaint();
        return;
      }
      if (name === 'down') {
        sel = (sel + 1) % items.length;
        repaint();
        return;
      }
      // 回车确认见 isPickerConfirmKey（两键都接受）
      if (isPickerConfirmKey(name)) {
        done(sel);
        return;
      }
      if (name === 'escape') {
        done(-1);
        return;
      }
      // 数字 1-9 立即确认对应下标（超界忽略）
      if (/^[1-9]$/.test(name)) {
        const idx = Number(name) - 1;
        if (idx < items.length) done(idx);
        return;
      }
    };
    stdin.on('keypress', onKey as (...args: unknown[]) => void);
    for (const fn of saved) stdin.removeListener('keypress', fn as (...args: unknown[]) => void);
  });
}

/** picker 确认键：Enter（`return`，0x0D）与换行（`enter`，0x0A，如 Ctrl+J/粘贴）都确认，与 readline 一致 */
export function isPickerConfirmKey(name: string): boolean {
  return name === 'return' || name === 'enter';
}

/**
 * 斜杠命令模糊匹配（codex slash popup 对等：子序列即命中，如 /ac → /compact）。
 * 排序：前缀命中在前，其余子序列命中随后（各按命令表原序，保证稳定）。
 */
export function fuzzySlashMatch(frag: string, commands: readonly string[] = MINI_SLASH_COMMANDS): string[] {
  const q = frag.toLowerCase();
  if (!q) return [...commands];
  const isSubseq = (target: string): boolean => {
    let j = 0;
    for (let i = 0; i < target.length && j < q.length; i++) {
      if (target[i] === q[j]) j++;
    }
    return j === q.length;
  };
  const pre: string[] = [];
  const rest: string[] = [];
  for (const c of commands) {
    const body = c.slice(1).toLowerCase();
    if (body.startsWith(q)) pre.push(c);
    else if (isSubseq(body)) rest.push(c);
  }
  return [...pre, ...rest];
}

/** installSlashSuggest 配置（纯显示联想面板；按键只观察不消费） */
export interface SlashSuggestOptions {
  stdin: NodeJS.ReadStream;
  getLine: () => string;
  isActive: () => boolean;
  print: (s: string) => void;
  /** 重画输入行（面板打在输入行上方，结束必须把输入行画回面板下方，光标才有归处） */
  redraw: () => void;
}

/** 联想面板句柄基类（两面板共用） */
export interface SuggestHandleBase {
  dispose(): void;
}

/** installSlashSuggest 返回句柄 */
export interface SlashSuggestHandle extends SuggestHandleBase {
  /** 把当前匹配的完整命令清单落进 scrollback（Tab 触发；见 interactive 的 completer） */
  listAll(): void;
  /**
   * 主循环提交行回调（拿到**真实提交内容**，回车后键缓冲已清空、监听器看不到）：
   * 命令词 + 面板在场（H>0）→ 面板 H 行 + 命令回显 1 行整块回收（上移 H+1 → DL H+1）；
   * 其余（消息/无面板）只放弃跟踪。必须由主循环在处理之前调用——不能凭「面板在场」
   * 在 keypress 监听器里猜（Ctrl+R 历史选择 / Ctrl+G 编辑器会异步改行：猜错会把
   * 消息回显连同会话最后一行一起删掉）。
   */
  confirmSubmit(line: string): void;
}

/**
 * 打 / 实时联想面板（纯显示，绝不拦截按键）。
 * 常驻被动 keypress 监听（永不摘除，只观察不消费）；每次按键后读 getLine()
 * 做状态机：空闲提示符下行匹配 `^\/[a-z-]*$` 时列出前 8 个候选（超出加一行提示），
 * 行变化才重绘（旧块整块删除，不留空白残留）。
 *
 * 收尾策略（用户反馈「取消后输入框上移」的根治，与 bash 补全列表同款）：
 * - Enter 提交：面板 H 行 + 命令回显 1 行整块回收（readline 回车后已把光标移到
 *   回显下一行，故上移 H+1 → DL H+1），命令输出直接落在回显原位，不留块；
 * - 其余收尾（行清空/不再匹配/取消）：只放弃跟踪、绝不擦屏——面板留在 scrollback
 *   当普通输出行（历史参考），输入框原地不动。此前删块会把输入行拽回面板起点，
 *   即「取消后输入框上移」。
 * 轮内/Ctrl+C/Ctrl+T/Ctrl+L 只放弃不碰屏。光标纪律（闭环）：面板打在输入行上方，结束
 * 必须把输入行画回面板下方——否则 readline 后续重绘落错行（输入隐身、Tab 插入错位）。
 * 非 TTY 返回 null。行格式为两空格前缀 + 命令名（dim 包裹整行，不做序号/高亮）。
 */
export function installSlashSuggest(opts: SlashSuggestOptions): SlashSuggestHandle | null {
  const { stdin, getLine, isActive, print, redraw } = opts;
  if (!stdin.isTTY) return null;
  const flagged = stdin as NodeJS.ReadStream & { __omniKeypressOn?: boolean };
  if (!flagged.__omniKeypressOn) {
    readline.emitKeypressEvents(stdin);
    flagged.__omniKeypressOn = true;
  }
  const out = process.stdout;
  let H = 0; // 当前面板行数
  let lastRows: string[] = []; // 上次渲染内容（diff 用）
  let listedFor: string | null = null; // listAll 刚落盘的那一行（同一按键的紧接重估不再多打面板）
  // 删除面板块（整块 DL，不留空行——此前逐行 EL 清空，旧块内容虽被擦掉但行仍在，
  // 每次按键在下方重打新块，旧块变成 H 个空白残留；打几个字符就攒几十个空行）。
  // 调用时光标在输入行：上移到块首 → DL 整块删除 → 回列首；n 可覆盖（Enter 连回显一起回收）。
  const deleteBlock = (n = H): void => {
    if (n <= 0) return;
    out.write(`\x1b[${n}A`);
    out.write(`\x1b[${n}M`);
    out.write('\r');
  };
  // 忘记旧块（H=0，不碰屏幕——保留在 scrollback 当普通输出行；轮内/ledger 输出
  // 已把面板顶出视口时 H 已过期，任何擦除都会清掉别人的行，也只能忘记）
  const forget = (): void => {
    H = 0;
    lastRows = [];
    listedFor = null;
  };
  // 终端尺寸变化：面板/输入的折行全部失效（旧 H 已过期），只忘记不擦屏——
  // 下一次渲染按新布局另起，防用过期 H 擦错行
  const onResize = (): void => {
    forget();
  };
  process.stdout.on('resize', onResize);
  // 重画面板：删旧块 → 清输入行（免得留残影行）→ 打新块 → 重画输入行。
  // 结束时光标必在新鲜输入行上，这是 readline 后续重绘落点正确的唯一前提。
  const render = (rows: string[]): void => {
    if (H > 0) {
      deleteBlock();
      forget();
    }
    out.write('\r\x1b[2K');
    for (const r of rows) print(dim(`  ${r}`));
    H = rows.length;
    lastRows = rows;
    if (H > 0) redraw();
  };
  const onKey = (_ch: unknown, key?: { name?: string; ctrl?: boolean }): void => {
    try {
      // Ctrl+C / Ctrl+T / Ctrl+L：放弃旧块（不碰屏），不干扰 readline 默认行为；
      // Ctrl+T 会直接打印轨迹账本把面板顶出视口、Ctrl+L 清屏（readline 原生），
      // 此时 H 已过期，擦除会清掉别人的行
      if (key?.ctrl && (key?.name === 'c' || key?.name === 't' || key?.name === 'l')) {
        forget();
        return;
      }
      // 轮内一律不渲染不擦除（只放弃跟踪）
      if (!isActive()) {
        forget();
        return;
      }
      const line = getLine() ?? '';
      const isReturn = key?.name === 'return';
      // Enter：不在这里判定/擦除（行缓冲已被 readline 清空，键监听看不到提交内容；
      // 真实判定与整块回收由主循环 confirmSubmit 用提交行做，见句柄注释）
      if (isReturn) return;
      const matched = /^\/[a-z-]*$/.test(line);
      if (matched) {
        // 完整清单刚落盘（Tab）：同一行（同一按键）的紧接重估不再多打一份前 8 条面板
        if (listedFor !== null && listedFor === line) {
          listedFor = null;
          return;
        }
        const frag = line.slice(1);
        const filtered = fuzzySlashMatch(frag);
        const rows = filtered.slice(0, 8);
        if (filtered.length > 8) rows.push(`…还有 ${filtered.length - 8} 个（继续打字过滤，Tab 直接列出全部）`);
        const same = rows.length === lastRows.length && rows.every((r, i) => r === lastRows[i]);
        if (!same) render(rows);
        return;
      }
      // 其他不匹配（清空/取消/改成普通消息）：保留面板（bash 同款），只放弃跟踪——
      // 删块会把输入行拽回面板起点（用户反馈的「取消后输入框上移」）
      forget();
    } catch {
      /* 联想面板永不打断输入 */
    }
  };
  // 完整候选清单落进 scrollback（Tab 触发，面板只列前 8 条）：回收面板 → 清单从
  // 原面板位置开始打印（4-6 个一行按宽分包）→ 输入行重画到清单下方。
  // 清单之后不再跟踪（下次打 / 在输入行位置另起新块，输入不搬家）。
  const listAll = (): void => {
    try {
      if (!isActive()) return;
      const line = getLine() ?? '';
      if (!/^\/[a-z-]*$/.test(line)) return;
      const rows = fuzzySlashMatch(line.slice(1));
      if (rows.length === 0) return;
      if (H > 0) {
        deleteBlock();
        H = 0;
      } else {
        out.write('\r\x1b[2K');
      }
      lastRows = [];
      listedFor = line; // 同一行（同一按键）的紧接重估不再多打一份前 8 条面板
      const width = Math.max(20, (process.stdout.columns ?? 80) - 2);
      const maxLen = rows.reduce((m, r) => Math.max(m, r.length), 0);
      const colW = Math.min(24, Math.max(8, maxLen + 3));
      const perRow = Math.max(1, Math.floor(width / colW));
      for (let i = 0; i < rows.length; i += perRow) {
        const lineTxt = rows
          .slice(i, i + perRow)
          .map((r) => r.padEnd(colW))
          .join('')
          .trimEnd();
        print(dim(`  ${lineTxt}`));
      }
      redraw(); // 输入行画到清单下方（readline 以此为新的输入行位置）
    } catch {
      /* 联想面板永不打断输入 */
    }
  };
  // 主循环提交行回调（拿到真实提交内容）：命令词 + 面板在场 → 面板 + 回显整块回收
  // （readline 回车已把光标移到回显下一行，上移 H+1 落在块首；命令输出随即将落在
  // 回显原位）；消息/无面板只放弃跟踪（回显由 onUserMessage 统一擦写，别抢）。
  const confirmSubmit = (line: string): void => {
    try {
      if (!/^\/[a-z-]*$/.test(line.trimStart())) {
        forget();
        return;
      }
      if (H > 0) deleteBlock(H + 1);
      forget();
    } catch {
      /* 联想面板永不打断主循环 */
    }
  };
  stdin.on('keypress', onKey as (...args: unknown[]) => void);
  return {
    dispose: () => {
      stdin.removeListener('keypress', onKey as (...args: unknown[]) => void);
      process.stdout.removeListener('resize', onResize);
    },
    listAll,
    confirmSubmit,
  };
}

/** installMentionSuggest 配置（与 SlashSuggestOptions 同形 + 取 cwd/光标） */
export interface MentionSuggestOptions extends SlashSuggestOptions {
  /** 当前工作目录（候选检索根，随 /cd 变化，调用时实时读） */
  getCwd: () => string;
  /** 输入框光标位置（提及检测按光标取查询，TUI 同款精度） */
  getCursor: () => number;
}

/** @ 提及面板每屏候选上限（不足只打实际行，不垫空行占位） */
const MENTION_SLOTS = 8;

/** installMentionSuggest 返回句柄（比 SlashSuggest 多 refresh/close 供 Tab 流程收尾） */
export interface MentionSuggestHandle extends SuggestHandleBase {
  /** 按当前输入行重估（refresh；无变化不重绘） */
  refresh(): void;
  /** 收尾（选择确认/取消后调用）：只放弃跟踪、面板留在 scrollback（输入框不搬家） */
  close(): void;
}

/**
 * 把选中项拼进输入行（TUI insertMention 的纯函数版）：
 * 目录（以 / 结尾）不加空格——继续深入；文件尾加空格——结束提及。
 * 返回新文本与新光标（提及插入段末尾）。
 */
export function applyMentionInsert(
  line: string,
  atIndex: number,
  queryLength: number,
  item: string
): { text: string; cursor: number } {
  const sep = item.endsWith('/') ? '' : ' ';
  const before = line.slice(0, atIndex + 1); // 含 @
  // @ 后其余部分（保留；picker 确认时行内可能已有空格，不与尾空格叠加）
  let after = line.slice(atIndex + 1 + queryLength);
  if (sep && after.startsWith(' ')) after = after.slice(1);
  const inserted = `${before}${item}${sep}`;
  return { text: `${inserted}${after}`, cursor: inserted.length };
}

/**
 * @ 提及实时联想面板（纯显示，绝不拦截按键；与 installSlashSuggest 同一套光标纪律）。
 * 空闲提示符下、非 / 文本、detectMention 命中时列出前 8 个候选（`@rel`，目录带 /；
 * 无候选不打面板；候选不足只打实际行，不垫空行）；选择走 Tab；收尾（提交/取消/确认）
 * 只放弃跟踪、面板留在 scrollback——删块会把输入行拽回面板起点（同 slash 面板的
 * 「取消后输入框上移」根因）。轮内/Ctrl+C/Ctrl+T 只放弃不碰屏。
 */
export function installMentionSuggest(opts: MentionSuggestOptions): MentionSuggestHandle | null {
  const { stdin, getLine, getCursor, getCwd, isActive, print, redraw } = opts;
  if (!stdin.isTTY) return null;
  const flagged = stdin as NodeJS.ReadStream & { __omniKeypressOn?: boolean };
  if (!flagged.__omniKeypressOn) {
    readline.emitKeypressEvents(stdin);
    flagged.__omniKeypressOn = true;
  }
  const out = process.stdout;
  let H = 0; // 当前面板行数（实际候选行 + 1 状态行，不垫空行）
  let lastRows: string[] = []; // 上次渲染内容（diff 用）
  // 删除面板块（整块 DL，不留空行——逐行 EL 只清空内容不删行，打字过滤每
  // 按一键旧块就变出固定高度的空白残留，几次下来几十个空行）。光标 discipline
  // 同 slash 面板：调用时光标在输入行，上移→DL→回列首，随后重画输入行。
  const deleteBlock = (): void => {
    if (H <= 0) return;
    out.write(`\x1b[${H}A`);
    out.write(`\x1b[${H}M`);
    out.write('\r');
  };
  // 忘记旧块（H=0，不碰屏幕——面板留在 scrollback；轮内/ledger 输出已把面板
  // 顶出视口时 H 已过期，擦除会清掉别人的行，也只能忘记）
  const forget = (): void => {
    H = 0;
    lastRows = [];
  };
  // 终端尺寸变化：面板/输入的折行全部失效（旧 H 已过期），只忘记不擦屏
  const onResize = (): void => {
    forget();
  };
  process.stdout.on('resize', onResize);
  // 重画面板：删旧块 → 清输入行（免得留残影行）→ 打新块 → 重画输入行。
  // 结束时光标必在新鲜输入行上，这是 readline 后续重绘落点正确的唯一前提。
  // print 经 MiniOutput.print 带轮内输入行协作（preOut/postOut）——空闲时直通 stdout。
  const render = (rows: string[]): void => {
    if (H > 0) {
      deleteBlock();
      forget();
    }
    out.write('\r\x1b[2K');
    for (const r of rows) print(dim(`  ${r}`));
    H = rows.length;
    lastRows = rows;
    if (H > 0) redraw();
  };
  // 核心重估（按键/外部 refresh 共用）：候选不足 MENTION_SLOTS 时只打实际行
  //（不再拿空行垫固定高度——补位空行随提交在 scrollback 永久留白，打几次攒几屏）。
  const update = (isReturn: boolean): void => {
    const line = getLine() ?? '';
    const cursor = getCursor() ?? line.length;
    // TUI 同款：/ 命令文本不显示提及
    const m = !line.trimStart().startsWith('/') ? detectMention(line, cursor) : null;
    // Enter 提交：只放弃跟踪（回显由 onUserMessage 统一擦写；面板留作历史参考）
    if (isReturn && m) {
      forget();
      return;
    }
    if (m) {
      const cands = listMentionCandidates(getCwd(), m.query);
      if (cands.length === 0) {
        forget();
        return;
      }
      const rows = cands.slice(0, MENTION_SLOTS).map((c) => `@${c}`);
      rows.push(
        cands.length > MENTION_SLOTS
          ? `…还有 ${cands.length - MENTION_SLOTS} 个（继续打字过滤，Tab 选择）`
          : 'Tab 选择 · 继续打字过滤'
      );
      const same = rows.length === lastRows.length && rows.every((r, i) => r === lastRows[i]);
      if (!same) render(rows);
      return;
    }
    // 其他不匹配（清空/取消/结束提及）：保留面板（bash 同款），只放弃跟踪
    forget();
  };
  const onKey = (_ch: unknown, key?: { name?: string; ctrl?: boolean }): void => {
    try {
      // Ctrl+C / Ctrl+T / Ctrl+L：放弃旧块（不碰屏）——不干扰 readline 默认行为；
      // Ctrl+T 会直接打印轨迹账本把面板顶出视口、Ctrl+L 清屏（readline 原生），
      // 此时 H 已过期，擦除会清掉别人的行
      if (key?.ctrl && (key?.name === 'c' || key?.name === 't' || key?.name === 'l')) {
        forget();
        return;
      }
      // 轮内一律不渲染不擦除（只放弃跟踪）
      if (!isActive()) {
        forget();
        return;
      }
      update(key?.name === 'return');
    } catch {
      /* 联想面板永不打断输入 */
    }
  };
  stdin.on('keypress', onKey as (...args: unknown[]) => void);
  return {
    dispose: () => {
      stdin.removeListener('keypress', onKey as (...args: unknown[]) => void);
      process.stdout.removeListener('resize', onResize);
    },
    refresh: () => {
      try {
        if (isActive()) update(false);
      } catch {
        /* 联想面板永不打断输入 */
      }
    },
    close: () => {
      try {
        // Tab 插入/picker 确认后收尾：只放弃跟踪（面板留作历史参考，输入框不搬家）
        if (H > 0) {
          forget();
        }
      } catch {
        /* 联想面板永不打断输入 */
      }
    },
  };
}

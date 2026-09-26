/**
 * mini/console 共用的上下箭头选择器（/model、/variants 无参 TTY 分支用）。
 * 调用方拼好 items（label 为已着色成品行，不含序号），picker 只负责导航渲染。
 */
import readline from 'node:readline';
import { bold, cyan, dim } from '../ui.js';
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
  '/team', '/session', '/redo', '/doctor', '/trace', '/init',
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
    // 命令已打全：补一个空格方便继续输参数
    if (hits.length === 0 && MINI_SLASH_COMMANDS.includes(word)) return [[`${word} `], word];
    return [hits, word];
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
      if (name === 'return') {
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

/** installSlashSuggest 配置（纯显示联想面板；按键只观察不消费） */
export interface SlashSuggestOptions {
  stdin: NodeJS.ReadStream;
  getLine: () => string;
  isActive: () => boolean;
  print: (s: string) => void;
  /** 重画输入行（面板打在输入行下方，结束必须把它画回来，光标才有归处） */
  redraw: () => void;
}

/** installSlashSuggest 返回句柄 */
export interface SlashSuggestHandle {
  dispose(): void;
}

/**
 * 打 / 实时联想面板（纯显示，绝不拦截按键）。
 * 常驻被动 keypress 监听（永不摘除，只观察不消费）；每次按键后读 getLine()
 * 做状态机：空闲提示符下行匹配 `^\/[a-z-]*$` 时列出前 8 个候选（超出加一行提示），
 * 行变化才重绘；Enter 提交留块作参考、下次按键放弃；不匹配则擦除关闭；
 * 轮内/Ctrl+C 只放弃不擦除。光标纪律（闭环）：面板打在输入行下方，
 * 结束必须重画输入行——否则 readline 后续重绘落错行（输入隐身、Tab 插入错位）。
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
  let justSubmitted = false; // Enter 提交标记（下次按键先放弃再清标记）
  // 擦除旧块（逐行清；调用方保证 H>0）
  const eraseBlock = (): void => {
    out.write(`\x1b[${H}A`);
    for (let i = 0; i < H; i++) {
      out.write('\r\x1b[2K');
      out.write('\x1b[1B');
    }
    out.write('\r');
  };
  // 放弃旧块（H=0，不擦除，避免与他人输出错位）
  const abandon = (): void => {
    H = 0;
    lastRows = [];
  };
  // 重画面板：擦旧块 → 清输入行（免得留残影行）→ 打新块 → 重画输入行。
  // 结束时光标必在新鲜输入行上，这是 readline 后续重绘落点正确的唯一前提。
  const render = (rows: string[]): void => {
    if (H > 0) eraseBlock();
    out.write('\r\x1b[2K');
    for (const r of rows) print(dim(`  ${r}`));
    H = rows.length;
    lastRows = rows;
    if (H > 0) redraw();
  };
  const onKey = (_ch: unknown, key?: { name?: string; ctrl?: boolean }): void => {
    try {
      // Ctrl+C / Ctrl+T：放弃旧块（不擦除），不干扰 readline 默认行为；
      // Ctrl+T 会直接打印轨迹账本把面板顶出视口，此时 H 已过期，擦除会清掉别人的行
      if (key?.ctrl && (key?.name === 'c' || key?.name === 't')) {
        abandon();
        justSubmitted = false;
        return;
      }
      // 轮内一律不渲染不擦除（H>0 只放弃不擦除）
      if (!isActive()) {
        if (H > 0) abandon();
        return;
      }
      // 上次 Enter 提交后首次按键：先放弃旧块（不擦除）再清标记，然后正常处理
      if (justSubmitted) {
        abandon();
        justSubmitted = false;
      }
      const line = getLine() ?? '';
      const isReturn = key?.name === 'return';
      const matched = /^\/[a-z-]*$/.test(line);
      // Enter 且当前行匹配（提交动作）：本次跳过渲染（面板行留在 scrollback 当参考）
      if (isReturn && matched) {
        justSubmitted = true;
        return;
      }
      if (matched) {
        const frag = line.slice(1);
        const filtered = MINI_SLASH_COMMANDS.filter((c) => c.slice(1).startsWith(frag));
        const rows = filtered.slice(0, 8);
        if (filtered.length > 8) rows.push(`…还有 ${filtered.length - 8} 个（继续打字过滤，Tab 直接列出全部）`);
        if (!justSubmitted) {
          const same = rows.length === lastRows.length && rows.every((r, i) => r === lastRows[i]);
          if (!same) render(rows);
        }
        return;
      }
      // 其他不匹配：擦除旧块并关闭
      if (H > 0) {
        eraseBlock();
        abandon();
      }
      justSubmitted = false;
    } catch {
      /* 联想面板永不打断输入 */
    }
  };
  stdin.on('keypress', onKey as (...args: unknown[]) => void);
  return {
    dispose: () => {
      stdin.removeListener('keypress', onKey as (...args: unknown[]) => void);
    },
  };
}

/** installMentionSuggest 配置（与 SlashSuggestOptions 同形 + 取 cwd/光标） */
export interface MentionSuggestOptions extends SlashSuggestOptions {
  /** 当前工作目录（候选检索根，随 /cd 变化，调用时实时读） */
  getCwd: () => string;
  /** 输入框光标位置（提及检测按光标取查询，TUI 同款精度） */
  getCursor: () => number;
}

/** @ 提及面板固定高度：8 个候选槽位 + 1 行状态行（打字过滤时不抖动） */
const MENTION_SLOTS = 8;

/** installMentionSuggest 返回句柄（比 SlashSuggest 多 refresh/close 供 Tab 流程收尾） */
export interface MentionSuggestHandle extends SlashSuggestHandle {
  /** 按当前输入行重估（refresh；无变化不重绘） */
  refresh(): void;
  /** 擦除面板并关闭（选择确认/取消后收尾；无面板时 no-op） */
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
  const after = line.slice(atIndex + 1 + queryLength); // @ 后其余部分（保留）
  const inserted = `${before}${item}${sep}`;
  return { text: `${inserted}${after}`, cursor: inserted.length };
}

/**
 * @ 提及实时联想面板（纯显示，绝不拦截按键；与 installSlashSuggest 同一套光标纪律）。
 * 空闲提示符下、非 / 文本、detectMention 命中时列出前 8 个候选（`@rel`，目录带 /；
 * 无候选不打面板）；选择走 Tab（readline completer 的 completeMention 分支）。
 * 行变化才重绘；Enter 提交留块作参考、下次按键放弃；不匹配则擦除关闭；
 * 轮内/Ctrl+C 只放弃不擦除。
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
  let H = 0; // 当前面板行数（固定 MENTION_SLOTS + 1）
  let lastRows: string[] = []; // 上次渲染内容（diff 用）
  let justSubmitted = false; // Enter 提交标记（下次按键先放弃再清标记）
  // 擦除旧块（逐行清；调用方保证 H>0）
  const eraseBlock = (): void => {
    out.write(`\x1b[${H}A`);
    for (let i = 0; i < H; i++) {
      out.write('\r\x1b[2K');
      out.write('\x1b[1B');
    }
    out.write('\r');
  };
  // 放弃旧块（H=0，不擦除，避免与他人输出错位）
  const abandon = (): void => {
    H = 0;
    lastRows = [];
  };
  // 重画面板：擦旧块 → 清输入行（免得留残影行）→ 打新块 → 重画输入行。
  // 结束时光标必在新鲜输入行上，这是 readline 后续重绘落点正确的唯一前提。
  const render = (rows: string[]): void => {
    if (H > 0) eraseBlock();
    out.write('\r\x1b[2K');
    for (const r of rows) print(r === '' ? '' : dim(`  ${r}`));
    H = rows.length;
    lastRows = rows;
    if (H > 0) redraw();
  };
  // 核心重估（按键/外部 refresh 共用）：候选不足一屏时拿空行垫到固定高度
  const update = (isReturn: boolean): void => {
    const line = getLine() ?? '';
    const cursor = getCursor() ?? line.length;
    // TUI 同款：/ 命令文本不显示提及
    const m = !line.trimStart().startsWith('/') ? detectMention(line, cursor) : null;
    // Enter 且有提及（提交动作）：本次跳过渲染（面板行留在 scrollback 当参考）
    if (isReturn && m) {
      justSubmitted = true;
      return;
    }
    if (m) {
      const cands = listMentionCandidates(getCwd(), m.query);
      if (cands.length === 0) {
        if (H > 0) {
          eraseBlock();
          abandon();
        }
        justSubmitted = false;
        return;
      }
      const rows = cands.slice(0, MENTION_SLOTS).map((c) => `@${c}`);
      while (rows.length < MENTION_SLOTS) rows.push('');
      rows.push(
        cands.length > MENTION_SLOTS
          ? `…还有 ${cands.length - MENTION_SLOTS} 个（继续打字过滤，Tab 选择）`
          : 'Tab 选择 · 继续打字过滤'
      );
      if (!justSubmitted) {
        const same = rows.length === lastRows.length && rows.every((r, i) => r === lastRows[i]);
        if (!same) render(rows);
      }
      return;
    }
    // 其他不匹配：擦除旧块并关闭
    if (H > 0) {
      eraseBlock();
      abandon();
    }
    justSubmitted = false;
  };
  const onKey = (_ch: unknown, key?: { name?: string; ctrl?: boolean }): void => {
    try {
      // Ctrl+C / Ctrl+T：放弃旧块（不擦除）——不干扰 readline 默认行为；
      // Ctrl+T 会直接打印轨迹账本把面板顶出视口，此时 H 已过期，擦除会清掉别人的行
      if (key?.ctrl && (key?.name === 'c' || key?.name === 't')) {
        abandon();
        justSubmitted = false;
        return;
      }
      // 轮内一律不渲染不擦除（H>0 只放弃不擦除）
      if (!isActive()) {
        if (H > 0) abandon();
        return;
      }
      // 上次 Enter 提交后首次按键：先放弃旧块（不擦除）再清标记，然后正常处理
      if (justSubmitted) {
        abandon();
        justSubmitted = false;
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
        if (H > 0) {
          eraseBlock();
          abandon();
        }
        justSubmitted = false;
      } catch {
        /* 联想面板永不打断输入 */
      }
    },
  };
}

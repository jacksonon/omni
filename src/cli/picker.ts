import { dockMiniViewport, restoreMiniViewport } from './mini-viewport.js';
import { miniPanelBackground, miniSelection } from './mini-theme.js';
/**
 * mini/console 共用的上下箭头选择器（/model、/variants 无参 TTY 分支用）。
 * 调用方拼好 items（label 为已着色成品行，不含序号），picker 只负责导航渲染。
 */
import readline from 'node:readline';
import { stripVTControlCharacters } from 'node:util';
import { bold, cyan, dim, magenta, red, useColor } from '../ui.js';
import { truncateToWidth } from '../output/format.js';
import { visualWidth } from '../tui/width.js';
import { detectMention, listMentionCandidates } from '../tui/mention.js';

export interface PickerItem {
  /** 已着色成品行（不含序号；`✓` 当前标记由调用方拼入） */
  label: string;
  value: string;
  /** 与名称分列展示的能力或说明。 */
  description?: string;
}

export interface PickerOptions {
  /** inline 在当前输入区展开，screen 用临时备用屏。 */
  placement?: 'inline' | 'screen';
  /** 面板顶部标题 */
  title?: string;
  /** 初始高亮下标 */
  selected: number;
  /** 底部提示行（缺省默认文案） */
  hint?: string;
  /** 是否支持打字即时过滤（如 Ctrl+R 历史搜索） */
  filterable?: boolean;
  /** 多选面板：空格勾选，Enter 提交；索引对应原始 items。 */
  marked?: Set<number>;
}

/** 终端 Bracketed Paste 开启/关闭转义序列 */
export const ENABLE_BRACKETED_PASTE = '\x1b[?2004h';
export const DISABLE_BRACKETED_PASTE = '\x1b[?2004l';

const DEFAULT_HINT = '↑↓ 选择 · 数字直选 · Enter 确认 · Esc 取消';

/** mini/console 斜杠命令表（Tab 补全用；加新命令时同步这里，来源是 interactive.ts 的分支） */
export const MINI_SLASH_COMMANDS = [
  '/exit', '/clear', '/new', '/plan', '/permission', '/undo', '/spec', '/preset',
  '/skill', '/compact', '/agents', '/orchestrate', '/goal', '/loop', '/review',
  '/btw', '/variants', '/settings', '/model', '/status', '/usage', '/context', '/export',
  '/mcp', '/diff', '/rewind', '/rename', '/memory-apply', '/fork', '/send',
  '/resume', '/cd', '/pin', '/archive', '/unarchive', '/auto', '/vim',
  '/team', '/session', '/redo', '/doctor', '/trace', '/init', '/import', '/recap',
  '/copy', '/pwd', '/quit', '/stop', '/delete', '/tasks', '/plugin', '/warnings',
  '/skills', '/plugins', '/hooks', '/rollout',
];

/** mini 斜杠菜单说明（命令范围仍由 MINI_SLASH_COMMANDS 决定）。 */
export const MINI_SLASH_DESCRIPTIONS: Record<string, string> = {
  '/model': '选择模型与推理级别',
  '/variants': '切换推理级别或命名变体',
  '/permission': '选择 Omni 可以执行的操作',
  '/status': '查看当前会话配置',
  '/context': '查看或调整上下文窗口',
  '/plan': '切换只读计划模式',
  '/review': '审查当前代码改动',
  '/diff': '查看工作区差异',
  '/init': '生成项目 AGENTS.md',
  '/agents': '管理子代理定义',
  '/tasks': '查看后台任务',
  '/team': '查看团队任务看板',
  '/mcp': '管理 MCP 服务器与外部工具',
  '/skill': '查找、安装与管理技能',
  '/skills': '查看可用技能',
  '/plugin': '管理插件',
  '/plugins': '查看插件列表',
  '/settings': '查看帮助与模型能力设置',
  '/compact': '压缩当前会话上下文',
  '/clear': '清空对话并开始新会话',
  '/new': '开始新会话',
  '/resume': '恢复已有会话',
  '/session': '管理已保存的会话',
  '/fork': '分叉当前会话',
  '/rewind': '回到会话检查点',
  '/undo': '撤销上一次文件修改',
  '/redo': '重做上一次撤销',
  '/usage': '查看 token 与费用用量',
  '/export': '导出当前会话',
  '/import': '导入已有配置或会话',
  '/rename': '重命名当前会话',
  '/cd': '切换工作目录',
  '/pwd': '显示当前工作目录',
  '/copy': '复制最近的回答',
  '/recap': '回顾当前会话',
  '/trace': '查看完整执行轨迹',
  '/rollout': '查看会话轨迹',
  '/warnings': '查看会话警告',
  '/doctor': '检查环境与配置',
  '/hooks': '查看生命周期 hooks',
  '/pin': '置顶会话',
  '/archive': '归档会话',
  '/unarchive': '取消归档',
  '/delete': '删除会话',
  '/goal': '设置持续执行目标',
  '/loop': '配置循环任务',
  '/orchestrate': '编排多代理工作流',
  '/spec': '创建需求、设计与任务规格',
  '/preset': '应用能力预设',
  '/btw': '提出不打断当前任务的问题',
  '/send': '发送会话消息',
  '/memory-apply': '应用待确认的项目记忆',
  '/auto': '切换 AI 自动审批',
  '/vim': '查看 Vim 模式设置',
  '/stop': '停止当前任务',
  '/exit': '退出 Omni',
  '/quit': '退出 Omni',
};

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
 * 名称 · provider · 上下文k/输出k · 思考级别 · 智能指数 · 当前✓（缺字段跳过，不断言）。
 */
export function formatModelPickLabel(
  m: {
    name: string;
    displayName?: string;
    provider?: string;
    limit?: { context?: number; output?: number };
    reasoningEffort?: string;
    /** 智能指数（OpenRouter artificial_analysis；undefined 不显示） */
    intelligence?: number;
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
  if (m.intelligence !== undefined) segs.push(`智能指数 ${m.intelligence}`);
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
 * mini 在当前输入区顺序绘制临时面板；其它入口可用 alternate screen。
 * 两种布局都按窗口分页，确认/取消后清理自己的区域。
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
  const inline = opts.placement === 'inline';
  let inlineVisible = false;
  const isFilter = opts.filterable === true;
  let query = '';

  const getFiltered = (): { item: PickerItem; origIdx: number }[] => {
    if (!isFilter || !query) return items.map((item, origIdx) => ({ item, origIdx }));
    const q = query.toLowerCase();
    return items
      .map((item, origIdx) => ({ item, origIdx }))
      .filter(({ item }) => item.value.toLowerCase().includes(q) || item.label.toLowerCase().includes(q));
  };

  let curItems = getFiltered();
  let sel = Math.min(Math.max(opts.selected, 0), Math.max(0, curItems.length - 1));
  const hint = opts.hint ?? (isFilter ? '↑↓ 导航 · 输入过滤 · Enter 回填 · Esc 取消' : DEFAULT_HINT);

  const panelBg = miniPanelBackground;
  const renderRow = (i: number, width: number): string => {
    const it = curItems[i]!.item;
    const selected = i === sel;
    const check = opts.marked ? (opts.marked.has(curItems[i]!.origIdx) ? '[✓] ' : '[ ] ') : '';
    const prefix = `${selected ? '›' : ' '} ${i + 1}. ${check}`;
    const label = stripVTControlCharacters(it.label).replace(/[\r\n\t]/g, ' ');
    const labelWidth = Math.min(38, Math.max(12, Math.floor(width * 0.4)));
    let body = prefix + truncateToWidth(label, Math.max(1, width - prefix.length - 1));
    let muted = '';
    if (it.description && width >= 48) {
      const name = truncateToWidth(label, labelWidth);
      body = prefix + name + ' '.repeat(Math.max(0, labelWidth - visualWidth(name))) + '  ';
      muted = truncateToWidth(it.description.replace(/[\r\n\t]/g, ' '), Math.max(1, width - 1 - visualWidth(body)));
    }
    if (selected && useColor) return `${miniSelection()}${body}${muted}\x1b[K\x1b[0m`;
    return `${panelBg()}${body}${dim(muted)}${panelBg()}\x1b[K\x1b[0m`;
  };

  const paint = (): void => {
    const width = Math.max(3, out.columns || 80);
    const height = Math.max(1, (out.rows || 24) - (inline ? 1 : 0));
    const rows: string[] = [];
    const showFilter = isFilter && height >= 3;
    if (height >= 6) {
      rows.push(`${panelBg()}${bold(truncateToWidth(`  ${opts.title ?? '选择操作'}`, width - 1))}${panelBg()}\x1b[K\x1b[0m`);
      rows.push(`${panelBg()}\x1b[K\x1b[0m`);
    }
    if (showFilter) rows.push(dim(truncateToWidth(`  filter: ${query}▌`, width)));
    const maxVisible = Math.max(1, Math.min(12, height - rows.length - 1));
    const start = Math.max(0, Math.min(sel - Math.floor(maxVisible / 2), curItems.length - maxVisible));
    const slice = curItems.slice(start, start + maxVisible);
    if (slice.length === 0) rows.push(dim(truncateToWidth('  (无匹配项)', width)));
    else for (let i = 0; i < slice.length; i++) rows.push(renderRow(start + i, width));
    const position = curItems.length > maxVisible ? `${sel + 1}/${curItems.length} · ` : '';
    if (height >= 2) rows.push(`${panelBg()}${dim(truncateToWidth('  ' + position + hint, width - 1))}${panelBg()}\x1b[K\x1b[0m`);
    if (inline) {
      out.cork();
      out.write('\x1b[?2026h');
      if (inlineVisible) restoreMiniViewport(out);
      const top = dockMiniViewport(out, rows.length);
      inlineVisible = true;
      // 最后一行不输出换行，避免面板在页底绘制时额外滚屏。
      out.write(rows.map((row, i) => `\x1b[${top + i};1H${row}`).join(''));
      out.write(`\x1b[${top};1H\x1b[?2026l`);
      out.uncork();
    } else {
      out.write('\x1b[H\x1b[2J' + rows.map((row, i) => `\x1b[${i + 1};1H${row}`).join(''));
    }
  };

  out.write(inline ? '\x1b[?25l' : '\x1b[?1049h\x1b[?25l');
  paint();

  return new Promise<number>((resolve) => {
    // 先挂自己的，再逐个摘掉保存的（own 占位，计数恒≥1）
    const saved = [...stdin.listeners('keypress')] as ((...args: unknown[]) => void)[];
    let settled = false;
    const done = (n: number): void => {
      if (settled) return;
      settled = true;
      try {
        if (inline) {
          if (inlineVisible) restoreMiniViewport(out);
          out.write('\x1b[?25h');
        } else out.write('\x1b[?1049l\x1b[?25h');
      } catch {
        /* 清场失败不影响结果 */
      }
      stdin.removeListener('keypress', onKey);
      out.removeListener('resize', paint);
      stdin.removeListener('end', onEnd);
      for (const fn of saved) stdin.on('keypress', fn as (...args: unknown[]) => void);
      resolve(n);
    };
    const onKey = (ch: unknown, key?: { name?: string; ctrl?: boolean; meta?: boolean }): void => {
      const name = key?.name ?? '';
      if (key?.ctrl && (name === 'c' || name === 'd')) {
        done(-1);
        return;
      }
      const count = isFilter ? curItems.length : items.length;
      if (name === 'up') {
        if (count > 0) {
          sel = (sel - 1 + count) % count;
          paint();
        }
        return;
      }
      if (name === 'down') {
        if (count > 0) {
          sel = (sel + 1) % count;
          paint();
        }
        return;
      }
      if (opts.marked && name === 'space') {
        const idx = curItems[sel]?.origIdx;
        if (idx !== undefined) {
          if (opts.marked.has(idx)) opts.marked.delete(idx);
          else opts.marked.add(idx);
          paint();
        }
        return;
      }
      // 回车确认见 isPickerConfirmKey（两键都接受）
      if (isPickerConfirmKey(name)) {
        if (isFilter) done(curItems[sel]?.origIdx ?? -1);
        else done(sel);
        return;
      }
      if (name === 'escape') {
        done(-1);
        return;
      }
      if (isFilter) {
        if (name === 'backspace') {
          if (query.length > 0) {
            query = query.slice(0, -1);
            curItems = getFiltered();
            sel = 0;
            paint();
          }
          return;
        }
        if (typeof ch === 'string' && ch.length === 1 && !key?.ctrl && !key?.meta && ch.charCodeAt(0) >= 32) {
          query += ch;
          curItems = getFiltered();
          sel = 0;
          paint();
          return;
        }
      } else {
        // 数字 1-9 立即确认对应下标（超界忽略）
        if (/^[1-9]$/.test(name)) {
          const idx = Number(name) - 1;
          if (idx < items.length) done(idx);
          return;
        }
      }
    };
    const onEnd = (): void => done(-1);
    stdin.on('keypress', onKey as (...args: unknown[]) => void);
    stdin.once('end', onEnd);
    out.on('resize', paint);
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
  /** 重画 readline 输入行 */
  redraw: () => void;
  /** 当前光标与完整输入末尾相对输入首行的位置；用于折行/行内移动后归位 */
  getPosition: () => { rows: number; cols: number; endRows: number; endCols: number };
  /** 完整命令菜单确认后回填，不提交 */
  replaceLine: (line: string) => void;
}

/** 联想面板句柄基类（两面板共用） */
export interface SuggestHandleBase {
  dispose(): void;
}

/** installSlashSuggest 返回句柄 */
export interface SlashSuggestHandle extends SuggestHandleBase {
  /** 展开当前匹配的命令清单（Tab 触发；高度不超过当前窗口） */
  listAll(): void;
  /** 回车已把光标移到输入下一行；在主循环输出之前清除临时面板 */
  confirmSubmit(line: string): void;
  /** 取消/模态选择前清除面板，保持输入行与光标原位 */
  close(): void;
}

/**
 * 打 / 实时联想面板：常规终端占输入行下方的临时区域，Warp 用同行提示 + Tab 临时菜单。
 * 每次 readline 刷新会清掉光标下方，因此每次按键后重画（候选相同也要重画）。
 * 绘制后返回原输入光标；过滤/取消不删终端行，不把输入框拽回列表起点。
 * Enter 后直接清除下方区域，无须凭过期的面板高度向上擦除。
 */
export function installSlashSuggest(opts: SlashSuggestOptions): SlashSuggestHandle | null {
  const { stdin, getLine, isActive, print, redraw, getPosition, replaceLine } = opts;
  if (!stdin.isTTY) return null;
  const flagged = stdin as NodeJS.ReadStream & { __omniKeypressOn?: boolean };
  if (!flagged.__omniKeypressOn) {
    readline.emitKeypressEvents(stdin);
    flagged.__omniKeypressOn = true;
  }
  const out = process.stdout;
  // Warp 的普通输出按 Block 高度排版，增删下方多行会改变输入在窗口中的位置。
  // 同行提示不改变 Block 高度；完整清单交给独立的临时屏幕选择器。
  const inline = /warp/i.test(process.env.TERM_PROGRAM ?? '');
  let visible = false;
  let modal = false;
  let disposed = false;
  let expandedFor: string | null = null;
  let dismissedFor: string | null = null;
  const forget = (): void => {
    visible = false;
    expandedFor = null;
    dismissedFor = null;
  };
  const close = (): void => {
    const wasVisible = visible;
    forget();
    if (wasVisible) redraw();
  };
  const render = (): void => {
    if (modal || disposed) return;
    const line = getLine() ?? '';
    if (!isActive() || !/^\/[a-z-]*$/.test(line)) {
      close();
      return;
    }
    if (line === dismissedFor) return;
    const filtered = fuzzySlashMatch(line.slice(1));
    if (filtered.length === 0) {
      close();
      return;
    }
    const pos = getPosition();
    const width = Math.max(1, out.columns || 80);
    if (inline) {
      const available = width - pos.endCols;
      if (available < 4) {
        close();
        return;
      }
      const tailRows = pos.endRows - pos.rows;
      let paint = '\r';
      if (tailRows > 0) paint += `\x1b[${tailRows}B`;
      if (pos.endCols > 0) paint += `\x1b[${pos.endCols}C`;
      const hint = filtered.length === 1 ? `  ${filtered[0]}` : `  Tab 菜单 · ${filtered.join(' · ')}`;
      paint += `\x1b[0K${dim(truncateToWidth(hint, available))}`;
      if (tailRows > 0) paint += `\x1b[${tailRows}A`;
      paint += '\r';
      if (pos.cols > 0) paint += `\x1b[${pos.cols}C`;
      out.write(paint);
      visible = true;
      return;
    }
    // 留出输入本身和绘制后的空行，确保归位 CUU 不越过窗口顶端。
    const maxRows = Math.max(0, (out.rows || 24) - pos.endRows - 2);
    if (maxRows === 0) {
      close();
      return;
    }
    let rows: string[];
    if (expandedFor === line) {
      const colW = Math.max(...filtered.map((r) => r.length)) + 3;
      const perRow = Math.max(1, Math.floor(Math.max(1, width - 2) / colW));
      rows = [];
      for (let i = 0; i < filtered.length; i += perRow) {
        rows.push(filtered.slice(i, i + perRow).map((r) => r.padEnd(colW)).join('').trimEnd());
      }
    } else {
      rows = filtered.slice(0, Math.min(8, maxRows));
      if (filtered.length > rows.length && rows.length < maxRows) {
        rows.push(`…还有 ${filtered.length - rows.length} 个（继续打字过滤，Tab 展开）`);
      }
    }
    if (rows.length > maxRows) {
      rows = rows.slice(0, maxRows);
      rows[maxRows - 1] = '…继续打字过滤';
    }
    // 先到完整输入的末行，再换行进入面板；print 的最后一个换行后返回原光标。
    // 不用 DL（Delete Line）；列表变短只清除下面的旧内容，输入行位置不变。
    const tailRows = pos.endRows - pos.rows;
    out.write('\r');
    if (tailRows > 0) out.write(`\x1b[${tailRows}B`);
    out.write('\n\r\x1b[0J');
    for (const r of rows) print(dim(truncateToWidth(`  ${r}`, width)));
    out.write(`\x1b[${tailRows + rows.length + 1}A\r`);
    if (pos.cols > 0) out.write(`\x1b[${pos.cols}C`);
    visible = true;
  };
  // 先清面板再让其它快捷键打印输出/打开模态 UI，避免旧候选被账本顶入历史。
  const beforeKey = (_ch: unknown, key?: { name?: string; ctrl?: boolean }): void => {
    try {
      if (inline && isPickerConfirmKey(key?.name ?? '')) close(); // 同行提示不随命令回显进入历史
      if (key?.ctrl && ['c', 'd', 'g', 'l', 'o', 'r', 't'].includes(key.name ?? '')) close();
    } catch {
      /* 快捷键清场永不打断输入 */
    }
  };
  const onKey = (_ch: unknown, key?: { name?: string; ctrl?: boolean }): void => {
    try {
      if (key?.ctrl && ['c', 'd', 'g', 'l', 'o', 'r', 't'].includes(key.name ?? '')) return;
      // 回车收尾由主循环触发；键监听可能已看不到提交前的行缓冲。
      if (isPickerConfirmKey(key?.name ?? '')) return;
      if (modal) return;
      if (!isActive()) {
        forget();
        return;
      }
      if (key?.name === 'tab') {
        // promises readline 的补全在 await 后才改行；同一 keypress 中仍是旧文本。
        // 等它插入完成再重估，防 /mo→/model 后还显示 /mo 的四个候选。
        queueMicrotask(() => {
          try {
            if (disposed || expandedFor === getLine()) return;
            expandedFor = null;
            dismissedFor = null;
            render();
          } catch {
            /* 异步补全收尾永不打断输入 */
          }
        });
        return;
      }
      if (key?.name === 'escape') {
        close();
        dismissedFor = getLine();
        return;
      }
      if (dismissedFor !== getLine()) dismissedFor = null;
      if (expandedFor !== getLine()) expandedFor = null;
      render();
    } catch {
      /* 联想面板永不打断输入 */
    }
  };
  const onResize = (): void => {
    close(); // readline 按新宽度重画输入并清掉旧区域，不依赖旧高度
  };
  const listAll = (): void => {
    try {
      if (inline) {
        if (modal || disposed || !isActive()) return;
        const line = getLine();
        if (!/^\/[a-z-]*$/.test(line)) return;
        const commands = fuzzySlashMatch(line.slice(1));
        if (commands.length === 0) return;
        close();
        modal = true;
        void (async () => {
          try {
            const idx = await pickFromList(stdin, commands.map((c) => ({ label: c, value: c })), {
              selected: 0,
              hint: '↑↓ 选择 · Enter 回填 · Esc 取消',
            });
            if (disposed) return;
            if (idx >= 0) replaceLine(commands[idx]!);
            else dismissedFor = getLine();
          } finally {
            modal = false;
            if (!disposed) {
              redraw();
              render();
            }
          }
        })().catch(() => { /* 选择失败保留输入 */ });
        return;
      }
      expandedFor = getLine();
      dismissedFor = null;
      render();
    } catch {
      /* 联想面板永不打断补全 */
    }
  };
  const confirmSubmit = (_line: string): void => {
    if (visible && !inline) out.write('\r\x1b[0J');
    forget();
  };
  stdin.prependListener('keypress', beforeKey as (...args: unknown[]) => void);
  stdin.on('keypress', onKey as (...args: unknown[]) => void);
  out.on('resize', onResize);
  return {
    dispose: () => {
      disposed = true;
      stdin.removeListener('keypress', beforeKey as (...args: unknown[]) => void);
      stdin.removeListener('keypress', onKey as (...args: unknown[]) => void);
      out.removeListener('resize', onResize);
    },
    listAll,
    confirmSubmit,
    close,
  };
}

/** installMentionSuggest 配置（与 SlashSuggestOptions 同形 + 取 cwd/光标） */
export interface MentionSuggestOptions extends Omit<SlashSuggestOptions, 'getPosition' | 'replaceLine'> {
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
    out.write(`\x1b[${H}A\x1b[${H}M\x1b[0J\r`);
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

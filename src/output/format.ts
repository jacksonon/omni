/**
 * 工具调用的展示格式化（console / TUI 共用）。
 *
 * 替代直接把工具参数 JSON 原样倒出来的做法：按工具类型提取人类可读的
 * 关键信息——run_command 显示 `$ 命令`（shell 风格）、文件类显示路径、
 * 搜索显示关键词；工具输出只预览前几行；整体画成圆角方框卡片
 * （TUI 可点击展开/收起，console 静态展开）。
 */
import { charWidth, visualWidth } from '../tui/width.js';

/** 取参数里某字段的字符串表示（缺省返回空串） */
function argStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (v === undefined || v === null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** 工具摘要的最大显示列数（超长命令截断为一行摘要，避免卡片被整段脚本刷屏） */
const SUMMARY_MAX_COLS = 120;

/**
 * 工具调用摘要：一行人类可读描述。
 *
 * - run_command → `$ freebuff --continue ...`（shell 提示符风格；换行折叠为空格）
 * - read_file / write_file → `📄/✏️ 路径`
 * - list_directory → `📁 路径`
 * - search_code → `🔍 关键词`
 * - 未知工具 → `k=v` 列表兜底
 *
 * 返回恒为单行（多行命令的 \n 折叠为空格），并按显示列数截断——多行摘要或超长
 * 摘要留在卡片里会打破边框对齐（\n 让 │ 边框断行），这是用户报告的"运行指令乱码"
 * 根因（如 `python3 -c "import json,sys\n..."` 整段脚本进入摘要）。
 */
export function formatToolCall(name: string, args: Record<string, unknown>): string {
  let s: string;
  switch (name) {
    case 'run_command': {
      const cmd = argStr(args, 'command').trim().replace(/\s*\n\s*/g, ' ');
      s = cmd ? `$ ${cmd}` : '$ (空命令)';
      break;
    }
    case 'read_file':
      s = `📄 ${argStr(args, 'path')}`;
      break;
    case 'write_file':
      s = `✏️ ${argStr(args, 'path')}`;
      break;
    case 'list_directory':
      s = `📁 ${argStr(args, 'path') || '.'}`;
      break;
    case 'search_code':
      s = `🔍 ${argStr(args, 'pattern')}`;
      break;
    default:
      s = Object.entries(args)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join('  ');
  }
  // 统一按显示列数截断（命令/路径/模式超长时保底，卡内最多折 1-2 行）
  return truncateToWidth(s, SUMMARY_MAX_COLS);
}

/**
 * 工具输出的终端预览：取前几行、单行过长截断、总量封顶。
 * 返回空数组表示没有可展示的内容。
 */
export function previewOutput(text: string, maxLines = 5, maxChars = 400): string[] {
  const lines: string[] = [];
  let used = 0;
  for (const raw of text.split('\n')) {
    if (lines.length >= maxLines) {
      lines.push('…（输出过长，已省略剩余）');
      break;
    }
    // 按列数截断超长行；截断点落在代理对后半（emoji）时回退一位，避免切出半个乱码
    let line = raw;
    if (line.length > 90) {
      let cut = 90;
      const code = line.charCodeAt(cut);
      if (code >= 0xdc00 && code <= 0xdfff) cut--;
      line = `${line.slice(0, cut)}…`;
    }
    used += line.length;
    if (used > maxChars) {
      lines.push('…（输出过长，已省略剩余）');
      break;
    }
    lines.push(line);
  }
  return lines.filter((l) => l.trim() !== '');
}

/** 工具卡片的展示数据（TUI 的 ToolCard 与 console 端通用子集） */
export interface ToolCardView {
  name: string;
  summary: string;
  status: 'running' | 'ok' | 'err';
  output: string[];
  expanded: boolean;
  /** 工具返回的字符数（执行缩略行显示，如 `✓ 执行成功 · 14 字符`） */
  chars?: number;
}

/**
 * 把单行文本按显示列数折行（空格/标点/硬断，代理对安全）；内容宽度过窄时退化。
 * 供 console 端卡片复用（TUI 内 toolCardLines 直接调用）。
 *
 * 防御：输入可能含换行（多行命令摘要等）——先按 \n 拆段再逐段折行，否则 \n 留在
 * 折行结果里会打破卡片边框（│ 断行 → 乱码）。
 */
export function wrapText(text: string, width: number): string[] {
  if (width < 2) return [text];
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    if (raw.length === 0) {
      out.push('');
      continue;
    }
    if (visualWidth(raw) <= width) {
      out.push(raw);
      continue;
    }
    let rest = raw;
    while (rest.length > 0) {
      if (visualWidth(rest) <= width) {
        out.push(rest);
        break;
      }
      let cols = 0;
      let cut = 0;
      for (let i = 0; i < rest.length; i++) {
        const w = charWidth(rest[i]);
        if (cols + w > width) break;
        cols += w;
        cut = i + 1;
      }
      // 代理对回退：不切出半个 emoji
      while (cut > 0 && cut < rest.length) {
        const code = rest.charCodeAt(cut);
        if (code >= 0xdc00 && code <= 0xdfff) cut--;
        else break;
      }
      // 断点优先级：空格 > 标点后 > 硬断
      const prefix = rest.slice(0, cut);
      const sp = prefix.lastIndexOf(' ');
      let cut2 = cut;
      if (sp > 0) {
        cut2 = sp;
      } else {
        let pi = -1;
        for (const ch of '，。、；：！？）》」』】…·,.;:!?)]}') {
          const idx = prefix.lastIndexOf(ch);
          if (idx > pi) pi = idx;
        }
        if (pi > 0) cut2 = pi + 1;
      }
      out.push(rest.slice(0, cut2));
      rest = rest.slice(cut2);
      if (rest.startsWith(' ')) rest = rest.slice(1);
    }
  }
  return out;
}

/**
 * 工具卡片文本（圆角方框），**无标题行、无特殊颜色**（用户要求：不需要「执行命令」
 * 这类标题文字，也不需要彩色边框——普通白色边框，暗色下白 / 亮色下灰，由主题
 * `cardBorder` 决定）。每行带角色（role），TUI/console 按角色着色：
 *
 * 收起（默认）：╭───────────────╮
 *             │ $ echo mock-ok│  ← cmd 命令（加粗，与执行/结果区分）
 *             │ ✓ 执行成功    │  ← exec 执行缩略（dim）
 *             │ 退出码: 0     │  ← result 结果缩略（dim）
 *             ╰───────────────╯
 *
 * 展开：命令 + 分隔线 + 完整输出 + 「▾ 点击收起」；running 态：命令 + 「⏳ 执行中…」。
 * 每行恰好 1 个终端行（内容先折行再包边），TUI 行数预算精确成立。
 */
export type ToolCardRole = 'top' | 'cmd' | 'exec' | 'result' | 'sep' | 'out' | 'hint' | 'bottom';

export interface ToolCardLine {
  text: string;
  role: ToolCardRole;
}
/**
 * 卡片内容区宽度（两侧边框之间的总列数）。
 *
 * 约定：**卡片每一行（标题/内容/分隔/底边）总宽都恰为 contentWidth = inner + 2**。
 * 早期各行宽度不一致（标题 inner+1、内容 inner+3、底边 inner+2），内容行超宽 1 列，
 * TUI 折行时把右侧边框 `│` 挤到下一行——用户报告的「右侧没框住」根因。
 */
export function cardInnerWidth(contentWidth: number): number {
  return Math.max(2, contentWidth - 2);
}

/** 卡片标题行：`╭─ 标签 状态 ─…╮`（放不下时截断标题；总宽 = contentWidth） */
export function cardTitleLine(title: string, mark: string, inner: number): string {
  // mark 为空（如菜单面板）时不留双空格：`─ 主题 ─…╮`，工具卡片 `─ 执行命令 ✓ ─…╮`
  const mid = `${title}${mark ? ` ${mark}` : ''}`;
  let t = `─ ${mid} `;
  if (visualWidth(t) > inner) t = `─ ${truncateToWidth(mid, inner - 4)} …`;
  return `╭${t}${'─'.repeat(Math.max(0, inner - visualWidth(t)))}╮`;
}

/** 卡片内容行：`│ 内容 │`（文本区 = inner-1，总宽 = contentWidth） */
export function cardContentLine(text: string, inner: number): string {
  return `│ ${padInner(text, inner - 1)}│`;
}

/** 卡片分隔行：`│ ─…─ │`（总宽 = contentWidth） */
export function cardSepLine(inner: number): string {
  return `│ ${'─'.repeat(Math.max(0, inner - 1))}│`;
}

export function cardBottomLine(inner: number): string {
  return `╰${'─'.repeat(Math.max(1, inner))}╯`;
}

/** 把文本补齐到 width 列（超出原样返回） */
function padInner(text: string, width: number): string {
  return `${text}${' '.repeat(Math.max(0, width - visualWidth(text)))}`;
}

export function toolCardLines(card: ToolCardView, contentWidth: number): ToolCardLine[] {
  const inner = cardInnerWidth(contentWidth); // 两侧 │ 之间的宽度
  const lines: ToolCardLine[] = [];

  lines.push({ text: `╭${'─'.repeat(inner)}╮`, role: 'top' });

  // 第一行：调用了哪个命令（折行；内容文本区为 inner-1，行总宽保持 contentWidth）
  for (const seg of wrapText(card.summary, inner - 1)) {
    lines.push({ text: cardContentLine(seg, inner), role: 'cmd' });
  }

  if (card.status === 'running') {
    // 执行中：命令 + ⏳（结果未到，无结果缩略行）
    lines.push({ text: cardContentLine('⏳ 执行中…', inner), role: 'exec' });
  } else if (card.expanded) {
    // 展开态：分隔线 + 完整输出 + 收起提示
    lines.push({ text: cardSepLine(inner), role: 'sep' });
    const out = card.output.length ? card.output : ['（无输出）'];
    for (const raw of out) {
      for (const seg of wrapText(raw, inner - 1)) lines.push({ text: cardContentLine(seg, inner), role: 'out' });
    }
    lines.push({ text: cardContentLine('▾ 点击收起', inner), role: 'hint' });
  } else {
    // 收起态：第二行执行缩略、第三行结果缩略
    const execText =
      card.status === 'ok'
        ? `✓ 执行成功${card.chars != null ? ` · ${card.chars} 字符` : ''}`
        : '✗ 执行失败';
    lines.push({ text: cardContentLine(execText, inner), role: 'exec' });
    const first = card.output[0];
    lines.push({
      text: cardContentLine(first ? truncateToWidth(first, inner - 1) : '（无输出）', inner),
      role: 'result',
    });
  }

  lines.push({ text: cardBottomLine(inner), role: 'bottom' });
  return lines;
}

/** 按显示宽度截断（省略号结尾） */
function truncateToWidth(text: string, width: number): string {
  if (width < 2) return text.slice(0, Math.max(1, width));
  let cols = 0;
  let i = 0;
  for (; i < text.length; i++) {
    const w = charWidth(text[i]);
    if (cols + w > width - 1) break;
    cols += w;
  }
  while (i > 0 && i < text.length) {
    const code = text.charCodeAt(i);
    if (code >= 0xdc00 && code <= 0xdfff) i--;
    else break;
  }
  return `${text.slice(0, i)}…`;
}

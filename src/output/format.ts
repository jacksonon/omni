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
 * - read_file → `→ Read 路径`（对标 opencode；并行多读合并成 `→ Read N files` 在 TUI 层）
 * - write_file → `✏️ 路径`
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
      s = `→ Read ${argStr(args, 'path')}`;
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
  /**
   * 当前 spinner 动画帧（工具执行中由 TUI 传入，如 ⠋⠙⠹…；缺省回退 ⏳）。
   * 让执行中行显示动画 loading 而非静态文本（用户要求）。
   */
  spinner?: string;
  /**
   * read_file：并行多读合并的路径列表（>1 时标题显示 `→ Read N files`，
   * 展开后逐条列出；单读时为空/单元素——对标 opencode）。
   */
  paths?: string[];
  /** write_file 写入前后对比（新增=original null / 修改=左右对比；无对比数据为 null/undefined） */
  diff?: WriteDiff | null;
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
 * 工具卡片文本（**颜色背景块**，不再用 ╭─╮│╰╯ 边框——用户要求「代码执行使用
 * 有颜色背景区域的块，而不是用一个边框」）。每行带角色（role），TUI 按角色着色：
 *
 * 收起（默认）：┌─────────────────┐ ← 整块背景色填充（成功淡绿/失败淡红/执行中超淡黄）
 *             │ $ echo mock-ok  │    cmd 命令（加粗，与执行/结果区分）
 *             │ ✓ 执行成功      │    exec 执行缩略（dim）
 *             │ echo 输出内容   │    result 结果缩略（dim，首个非「退出码: 0」行）
 *             └─────────────────┘
 *
 * 展开：命令 + 分隔线 + 完整输出 + 「▾ 点击收起」；running 态：命令 + 「⏳ 执行中…」。
 * 每行恰好 1 个终端行（内容先折行再补齐宽度），整块被背景色填满，TUI 行数预算不变。
 * console 端仍用增量方框（cardContentLine/cardSepLine/cardBottomLine），不在此处。
 */
export type ToolCardRole = 'top' | 'cmd' | 'exec' | 'result' | 'sep' | 'out' | 'hint' | 'diff' | 'bottom';

export interface ToolCardLine {
  text: string;
  role: ToolCardRole;
  /**
   * 左右对比行：left/right 为已按列宽补齐的两半文本——渲染时两半分别着色
   * （删除=左红、新增=右绿、未改动=普通深色），中间 `│` 分隔。
   */
  diff?: DiffRow;
  /** 整行 diff 色（新增文件全文：逐行绿色） */
  diffRole?: DiffHalfKind;
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

/**
 * 「退出码: 0」行是否展示层过滤（用户要求「不显示退出码 0」）——执行成功已由
 * 淡绿色背景 + `✓ 执行成功` 传达，退出码行是噪音；只滤 0（失败时的 `退出码: N`
 * 是诊断信息保留）。完整结果仍回传模型，此处只影响终端展示。
 */
export function isExitCodeZeroLine(text: string): boolean {
  return /^退出码:\s*0\s*$/.test(text.trim());
}

/** write_file 的写入前后对比（TUI 工具卡片 diff 展示；original=null = 本次会话新建） */
export interface WriteDiff {
  path: string;
  /** 写入前文件内容（null = 文件此前不存在，本次新建） */
  original: string | null;
  /** 本次写入的内容 */
  content: string;
}

/** diff 半列类型：ctx=未改动 / rem=删除（左列）/ add=新增（右列） */
export type DiffHalfKind = 'ctx' | 'rem' | 'add';

/** 左右对比的一行（left/right 已按列宽补齐；左空=纯新增行，右空=纯删除行） */
export interface DiffRow {
  left: string;
  lk: DiffHalfKind;
  right: string;
  rk: DiffHalfKind;
}

/** diff 展示行数上限（超出按行截断，防大文件把卡片撑爆） */
const DIFF_MAX_ROWS = 300;

/** 行级 LCS：未改动/删除/新增的操作序列（sideBySideDiff 与 countDiffLines 共用） */
function lineOps(original: string, content: string): { t: '=' | 'd' | 'i'; line: string }[] {
  const a = original.split('\n');
  const b = content.split('\n');
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: { t: '=' | 'd' | 'i'; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: '=', line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: 'd', line: a[i] });
      i++;
    } else {
      ops.push({ t: 'i', line: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ t: 'd', line: a[i++] });
  while (j < m) ops.push({ t: 'i', line: b[j++] });
  return ops;
}

/**
 * 行级 LCS 增删统计（write_file 收起态摘要：`修改 · +A −D 行`）。
 * 替换 = 1 增 + 1 删；纯新增/删除逐行计入。
 */
export function countDiffLines(original: string, content: string): { add: number; rem: number } {
  let add = 0;
  let rem = 0;
  for (const op of lineOps(original, content)) {
    if (op.t === 'd') rem++;
    else if (op.t === 'i') add++;
  }
  return { add, rem };
}

/**
 * 左右对比 diff（write_file 修改展示）：LCS 行对齐——未改动行左右同列、
 * 删除行在左、新增行在右，**紧邻的删除+新增块按行配对成「替换」**
 * （同一行左红右绿，对齐观感好）。每半列按列宽截断（省略号），
 * 行数超 DIFF_MAX_ROWS 截断（truncated=true）。
 */
export function sideBySideDiff(
  original: string,
  content: string,
  widthL: number,
  widthR: number
): { rows: DiffRow[]; truncated: boolean } {
  const col = (text: string, w: number): string => {
    if (text === '') return ' '.repeat(Math.max(1, w));
    const t = truncateToWidth(text, w);
    return `${t}${' '.repeat(Math.max(0, w - visualWidth(t)))}`;
  };
  const rows: DiffRow[] = [];
  const ops = lineOps(original, content);
  let k = 0;
  while (k < ops.length) {
    if (ops[k].t === '=') {
      rows.push({ left: col(ops[k].line, widthL), lk: 'ctx', right: col(ops[k].line, widthR), rk: 'ctx' });
      k++;
      continue;
    }
    // 收集一段连续的删除+新增（直到未改动行/结尾）
    const dels: string[] = [];
    const adds: string[] = [];
    while (k < ops.length && ops[k].t !== '=') {
      (ops[k].t === 'd' ? dels : adds).push(ops[k].line);
      k++;
    }
    // 紧邻删除+新增 → 按行配对成替换（同一行左红右绿）；剩余各自独占一行
    const pairs = Math.min(dels.length, adds.length);
    for (let x = 0; x < pairs; x++) {
      rows.push({ left: col(dels[x], widthL), lk: 'rem', right: col(adds[x], widthR), rk: 'add' });
    }
    for (const l of dels.slice(pairs)) rows.push({ left: col(l, widthL), lk: 'rem', right: col('', widthR), rk: 'ctx' });
    for (const l of adds.slice(pairs)) rows.push({ left: col('', widthL), lk: 'ctx', right: col(l, widthR), rk: 'add' });
  }
  return { rows: rows.slice(0, DIFF_MAX_ROWS), truncated: rows.length > DIFF_MAX_ROWS };
}

export function toolCardLines(card: ToolCardView, contentWidth: number): ToolCardLine[] {
  const inner = cardInnerWidth(contentWidth); // 块内文本区宽度（内容折行宽度）
  const lines: ToolCardLine[] = [];
  // read_file 走 opencode 风格（一行式）；write_file 带 diff 走改动对比展示
  const isRead = card.name === 'read_file';
  const isWriteDiff = card.name === 'write_file' && card.diff != null;

  // 块式卡片（无边框字符）：顶/底为空白行（撑出垂直边距），内容行补齐到内容宽度
  // ——整块被背景色填满成「颜色背景区域块」（用户要求）。每行总宽恒为 contentWidth。
  lines.push({ text: ' '.repeat(Math.max(1, contentWidth)), role: 'top' });

  // 第一行：调用了哪个命令（折行；块内文本区为 inner-1，行总宽保持 contentWidth）。
  // 内容行统一加 1 列左侧留白（样式优化：文字不贴色块左缘，与圆角/用户消息气泡对齐）
  for (const seg of wrapText(card.summary, inner - 1)) {
    lines.push({ text: padInner(` ${seg}`, contentWidth), role: 'cmd' });
  }

  if (card.status === 'running') {
    // 执行中：命令 + 动画 loading（spinner 帧由 TUI 每 200ms 刷新；无帧时回退 ⏳），
    // 结果未到，无结果缩略行
    lines.push({ text: padInner(` ${card.spinner ?? '⏳'} 执行中…`, contentWidth), role: 'exec' });
  } else if (isRead) {
    // read_file（对标 opencode）：收起态**只有一行 `→ Read 路径`**（无执行/结果缩略行，
    // 保持一行式观感）；展开 = 分隔线 + 路径列表（并行多读合并时逐条 ⤷）+ 输出预览 + 收起提示
    if (card.expanded) {
      const paths = card.paths ?? [];
      lines.push({ text: padInner(` ${'─'.repeat(Math.max(1, inner - 2))}`, contentWidth), role: 'sep' });
      if (paths.length > 1) {
        for (const p of paths) {
          lines.push({ text: padInner(` ⤷ ${truncateToWidth(p, Math.max(1, inner - 4))}`, contentWidth), role: 'out' });
        }
        lines.push({ text: padInner(` ${'─'.repeat(Math.max(1, inner - 2))}`, contentWidth), role: 'sep' });
      }
      const out = card.output.filter((l) => !isExitCodeZeroLine(l));
      for (const raw of out.length ? out : ['（无输出）']) {
        for (const seg of wrapText(raw, inner - 1)) lines.push({ text: padInner(` ${seg}`, contentWidth), role: 'out' });
      }
      lines.push({ text: padInner(' ▾ 点击收起', contentWidth), role: 'hint' });
    }
  } else if (isWriteDiff) {
    // write_file 带 diff：收起态 = 命令 + 执行缩略 + 改动摘要（新增 N 行 / 修改 +A −D 行）；
    // 展开 = 新增文件全文（逐行绿）/ 修改左右对比（左原右新，删除红新增绿）
    const d = card.diff!;
    const isNew = d.original === null;
    if (card.expanded) {
      lines.push({ text: padInner(` ${'─'.repeat(Math.max(1, inner - 2))}`, contentWidth), role: 'sep' });
      if (isNew) {
        // 新增文件：全文展示（每行 diffRole=add 绿色——新增内容配色，对标编辑器 diff）
        const contentLines = d.content.split('\n');
        const shown = contentLines.slice(0, DIFF_MAX_ROWS);
        for (const raw of shown) {
          for (const seg of wrapText(raw, inner - 1)) {
            lines.push({ text: padInner(` ${seg}`, contentWidth), role: 'diff', diffRole: 'add' });
          }
        }
        if (contentLines.length > DIFF_MAX_ROWS) {
          lines.push({ text: padInner(` … 共 ${contentLines.length} 行，超出展示上限`, contentWidth), role: 'out' });
        }
      } else {
        // 修改：左右对比（左 原内容 / 右 新内容）——isNew=false 分支里 original 必非 null
        const orig = d.original!;
        const stats = countDiffLines(orig, d.content);
        lines.push({ text: padInner(` 修改对比 · +${stats.add} −${stats.rem} 行`, contentWidth), role: 'exec' });
        const L = Math.max(4, Math.floor(inner / 2));
        const R = Math.max(4, inner - L);
        const { rows, truncated } = sideBySideDiff(orig, d.content, L, R);
        for (const r of rows) {
          lines.push({
            text: ` ${r.left}│${r.right}`.padEnd(Math.max(1, contentWidth), ' '),
            role: 'diff',
            diff: r,
          });
        }
        if (truncated) {
          lines.push({ text: padInner(` … diff 超长，仅展示前 ${DIFF_MAX_ROWS} 行`, contentWidth), role: 'out' });
        }
      }
      lines.push({ text: padInner(' ▾ 点击收起', contentWidth), role: 'hint' });
    } else {
      // 收起态：第二行执行缩略、第三行改动摘要（LCS 统计：新增行数 / +A −D 行数）
      const execText =
        card.status === 'ok'
          ? `✓ 执行成功${card.chars != null ? ` · ${card.chars} 字符` : ''}`
          : '✗ 执行失败';
      lines.push({ text: padInner(` ${execText}`, contentWidth), role: 'exec' });
      const stats = isNew ? null : countDiffLines(d.original!, d.content);
      const summary = isNew
        ? `新增文件 · 全文 ${d.content.split('\n').length} 行`
        : `修改 · +${stats!.add} −${stats!.rem} 行`;
      lines.push({ text: padInner(` ${summary}`, contentWidth), role: 'result' });
    }
  } else if (card.expanded) {
    // 展开态（其余工具）：分隔线 + 完整输出 + 收起提示
    lines.push({ text: padInner(` ${'─'.repeat(Math.max(1, inner - 2))}`, contentWidth), role: 'sep' });
    const out = card.output.filter((l) => !isExitCodeZeroLine(l));
    const shown = out.length ? out : ['（无输出）'];
    for (const raw of shown) {
      for (const seg of wrapText(raw, inner - 1)) lines.push({ text: padInner(` ${seg}`, contentWidth), role: 'out' });
    }
    lines.push({ text: padInner(' ▾ 点击收起', contentWidth), role: 'hint' });
  } else {
    // 收起态（其余工具）：第二行执行缩略、第三行结果缩略（取首个非「退出码: 0」输出行，
    // 超长截断省略号——不展示过长输出，从执行/结果摘要一部分即可）
    const execText =
      card.status === 'ok'
        ? `✓ 执行成功${card.chars != null ? ` · ${card.chars} 字符` : ''}`
        : '✗ 执行失败';
    lines.push({ text: padInner(` ${execText}`, contentWidth), role: 'exec' });
    const first = card.output.find((l) => !isExitCodeZeroLine(l));
    lines.push({
      text: padInner(` ${first ? truncateToWidth(first, inner - 1) : '（无输出）'}`, contentWidth),
      role: 'result',
    });
  }

  lines.push({ text: ' '.repeat(Math.max(1, contentWidth)), role: 'bottom' });
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

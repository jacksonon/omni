/**
 * 行式 Markdown 渲染：把模型回答的 Markdown 文本解析成带样式的行（chunks）。
 *
 * 支持：加粗 ** / __、行内代码 `、斜体 * / _、删除线 ~~、标题 #、引用 >、
 * 水平线 ---、围栏代码块 ``` / ~~~、**GFM 表格**（box-drawing 边框 + CJK 列宽
 * + 对齐 + 超宽截断）、无序列表 - / * / +（•）、有序列表 1.、任务清单 - [x]/[ ]
 * （☑/☐）；标题与引用内部的行内样式（## **加粗**）也生效。
 *
 * 流式友好：每次重绘都对已累积的完整文本重新解析，未闭合的语法标记
 * 按普通文本渲染（下一个 chunk 到达后自动重新解析成正确样式）。
 *
 * 选择行式方案而非 MarkdownRenderable：现有布局是「尾部窗口 + 行式渲染」，
 * MarkdownRenderable 是多行动态高度块，多轮对话下无法简单参与尾部裁剪。
 * 行式方案保持每行高度固定（1），布局逻辑零改动，覆盖加粗/代码等核心需求。
 */
import { charWidth, visualWidth } from './width.js';

/** 单个样式片段：text + 可选颜色/属性 */
export interface MdChunk {
  text: string;
  fg?: string; // 颜色名或 hex，如 'cyan' / '#e6b450'
  bg?: string; // 背景色（用户消息左侧蓝色竖粗线用）
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
  underline?: boolean;
  strike?: boolean; // 删除线（~~text~~）
  /** 可点击的本地文件路径（行内代码 `` `path` `` 且磁盘上真实存在的文件；buildBody 标记） */
  link?: string;
}

/** 一行带样式的文本 */
export interface MdRow {
  chunks: MdChunk[];
}

// 行内代码（琥珀色，避免与青色工具步骤混淆）
export const INLINE_CODE_FG = '#e6b450';
// 代码块行（蓝灰色）
export const CODE_FG = '#8fa3bf';
// diff 围栏行（与深色主题 diffAdd/diffRem 同值；亮色经 themeColor 映射压深）
export const DIFF_ADD_FG = '#4ade80';
export const DIFF_REM_FG = '#f87171';
// 引用行（浅灰）
export const QUOTE_FG = '#9aa4b2';

/* ---------------- LaTeX 命令 → Unicode 数学符号 ----------------
 * 项目不内嵌 KaTeX 排版：`$\gg$`、`$\rightarrow$`、`$\neq$` 之类的行内数学
 * 原样显示为反斜杠命令文本（用户反馈无法正确渲染）。这里把常见 \command 转成
 * 等价 Unicode 符号（箭头/关系/运算/希腊字母等）、剥离 `$` 定界符。与 Web 端
 * `web/markdown-renderer.js` 的 LATEX_UNICODE 同表保持两端一致。只作用于正文
 * 与数学片段——行内代码/代码块保持原样（\command 是源码，token 顺序保证）。 */
const LATEX_UNICODE: Record<string, string> = {
  // 箭头
  rightarrow: '→', to: '→', leftarrow: '←', longrightarrow: '⟶', longleftarrow: '⟵',
  Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', longleftrightarrow: '⟷',
  uparrow: '↑', downarrow: '↓', updownarrow: '↕', Uparrow: '⇑', Downarrow: '⇓',
  mapsto: '↦', hookrightarrow: '↪', rightleftharpoons: '⇌', leadsto: '↝',
  nearrow: '↗', searrow: '↘', nwarrow: '↖', swarrow: '↙',
  // 关系
  gg: '≫', ll: '≪', leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠',
  equiv: '≡', approx: '≈', cong: '≅', sim: '∼', simeq: '≃', propto: '∝',
  lesssim: '≲', gtrsim: '≳', prec: '≺', succ: '≻', preceq: '≼', succeq: '≽',
  subset: '⊂', supset: '⊃', subseteq: '⊆', supseteq: '⊇', subsetneq: '⊊', supsetneq: '⊋',
  in: '∈', notin: '∉', ni: '∋', owns: '∋', parallel: '∥', nparallel: '∦',
  perp: '⊥', models: '⊨', vdash: '⊢', dashv: '⊣',
  // 运算 / 集合
  times: '×', cdot: '·', cdots: '⋯', ldots: '…', pm: '±', mp: '∓', div: '÷',
  ast: '∗', star: '⋆', circ: '∘', bullet: '•', oplus: '⊕', ominus: '⊖',
  otimes: '⊗', oslash: '⊘', odot: '⊙', cap: '∩', cup: '∪', sqcap: '⊓', sqcup: '⊔',
  vee: '∨', lor: '∨', wedge: '∧', land: '∧', setminus: '∖',
  sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭', oint: '∮',
  bigcup: '⋃', bigcap: '⋂', bigoplus: '⨁', mid: '∣', shortmid: '∣',
  // 其它数学符号
  infty: '∞', partial: '∂', nabla: '∇', exists: '∃', nexists: '∄', forall: '∀',
  emptyset: '∅', varnothing: '∅', aleph: 'ℵ', hbar: 'ℏ', ell: 'ℓ', wp: '℘',
  Re: 'ℜ', Im: 'ℑ', angle: '∠', measuredangle: '∡',
  prime: '′', top: '⊤', bot: '⊥', flat: '♭', natural: '♮', sharp: '♯',
  triangleq: '≜', asymp: '≍',
  // 希腊字母（小写 + 常用大写）
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', varkappa: 'ϰ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ',
  varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'φ',
  varphi: 'ϕ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  // 命名函数 / 算子：去掉反斜杠（可读）
  sin: 'sin', cos: 'cos', tan: 'tan', cot: 'cot', sec: 'sec', csc: 'csc',
  sinh: 'sinh', cosh: 'cosh', tanh: 'tanh', log: 'log', ln: 'ln', exp: 'exp',
  lim: 'lim', max: 'max', min: 'min', sup: 'sup', inf: 'inf', arg: 'arg',
  det: 'det', rank: 'rank', dim: 'dim', ker: 'ker', gcd: 'gcd',
  // 分隔符 / 尺寸命令 → 去除（\left( x \right) → ( x )）
  left: '', right: '', big: '', Big: '', bigg: '', Bigg: '',
  bigl: '', Bigl: '', biggl: '', Biggl: '', bigr: '', Bigr: '', biggr: '', Biggr: '',
};

/** 轻量 LaTeX → Unicode：先处理有参数的 \frac{}{} / \sqrt{}，再查命令表替换（未知 \command 原样保留） */
export function latexToUnicode(input: string): string {
  let s = String(input ?? '');
  s = s.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, (_, a, b) => `${a}/${b}`);
  s = s.replace(/\\sqrt\{([^{}]*)\}/g, (_, x) => (x.length === 1 ? `√${x}` : `√(${x})`));
  return s.replace(/\\([A-Za-z]+)/g, (m, name) => (name in LATEX_UNICODE ? LATEX_UNICODE[name]! : m));
}

/**
 * 行内数学 span 转纯文本（thinking 等非 markdown 行用）：只替换 `$…$` / `\(…\)` /
 * `\[…\]` 数学 span（同 scanInline 的判定：显式定界恒转，`$…$` 按 isMathContent 守卫
 * 防误伤价格），其余逐字保留——不碰加粗/行内代码等其它标记，零样式变化。
 * 注意：行内代码里的 `$…$` 也会被转（与 scanInline 的"代码优先"不同）——thinking
 * 行无代码着色可言，转换优先于字面保留。
 */
export function inlineMathToText(input: string): string {
  return String(input ?? '').replace(
    /\$([^$\n]+)\$|\\\(([^)\n]+)\\\)|\\\[([^[\]\n]+)\\\]/g,
    (m: string, m1: string | undefined, m2: string | undefined, m3: string | undefined) => {
      const raw = m1 ?? m2 ?? m3 ?? '';
      if (m2 !== undefined || m3 !== undefined || isMathContent(raw)) return latexToUnicode(raw);
      return m;
    }
  );
}

/**
 * 成对 `$…$` 内容是否按数学处理（防误伤价格文本）：
 * · 含 `\`（LaTeX 命令）→ 数学（`$\gg$`、`$\rightarrow$`）
 * · 无空格、≤40 字符且含字母 → 数学（`$x^2$`、`$a+b$`）
 * · 其余（含空格 / 纯数字如 `$5-$10`）→ 普通文本原样保留
 */
function isMathContent(c: string): boolean {
  if (c.includes('\\')) return true;
  if (/\s/.test(c) || c.length > 40) return false;
  return /[A-Za-z]/.test(c);
}

/**
 * 行内 token：加粗 ** / __、删除线 ~~、行内代码 `、斜体 *（词边界守卫）、
 * 链接（只取显示文本）、**行内/显示数学**（`$…$` / `\(…\)` / `\[…\]` —
 * LaTeX 命令转 Unicode 符号，见 latexToUnicode；行内代码先匹配所以
 * `` `$…$` `` 保持原样）。
 *
 * 刻意不做 `_斜体_`：编程回答里裸 `snake_case` 标识符太常见，`_x_` 会误伤成斜体；
 * `*斜体*` 也加了 `(?<!\w)` / `(?!\w)` 边界守卫（CJK 不算 \w，`中文*强调*中文` 仍可匹配）。
 */
const INLINE_TOKEN =
  /\*\*([^*]+)\*\*|(?<!\w)__([^_]+)__(?!\w)|~~([^~\n]+)~~|`([^`]+)`|(?<!\w)\*([^*\n]+)\*(?!\w)|\[([^\]]+)\]\([^)]*\)|\$([^$\n]+)\$|\\\(([^)\n]+)\\\)|\\\[([^[\]\n]+)\\\]/g;

/** 扫描一行内的 Markdown 标记，产出样式片段 */
function scanInline(text: string): MdChunk[] {
  const out: MdChunk[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_TOKEN)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    const [, b1, b2, s1, code, i1, link, m1, m2, m3] = m;
    if (b1 || b2) out.push({ text: b1 ?? b2, bold: true });
    else if (s1) out.push({ text: s1, strike: true });
    else if (code) out.push({ text: code, fg: INLINE_CODE_FG });
    else if (i1) out.push({ text: i1, italic: true });
    else if (link) out.push({ text: link });
    else if (m1 !== undefined || m2 !== undefined || m3 !== undefined) {
      // 数学：`$…$` 按内容守卫判定（防误伤价格）；`\(…\)` / `\[…\]` 显式定界恒为数学
      const raw = m1 ?? m2 ?? m3 ?? '';
      if (m2 !== undefined || m3 !== undefined || isMathContent(raw)) {
        out.push({ text: latexToUnicode(raw) });
      } else {
        out.push({ text: m[0] }); // 非数学（价格等）→ 原样（含 $）
      }
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/* ---------------------------------- 表格 ---------------------------------- */

/** 拆分 GFM 表格行：去掉首尾 |，按 | 拆列并 trim（`| a | b |` → ['a','b']） */
function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

/** 表格分隔行（| --- | :---: | ---: |）：每列都是破折号 + 可选冒号（对齐标记） */
function isTableSepLine(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));
}

/** 列对齐：从分隔行单元格推断（:--- 左 / ---: 右 / :---: 居中，默认左） */
function colAlign(sepCells: string[], colCount: number): string[] {
  const align: string[] = [];
  for (let i = 0; i < colCount; i++) {
    const s = sepCells[i] ?? '';
    align.push(s.startsWith(':') && s.endsWith(':') ? 'center' : s.endsWith(':') ? 'right' : 'left');
  }
  return align;
}

/** 按列宽截断单元格（留 1 列给省略号；不切代理对） */
function truncCell(text: string, width: number): string {
  if (width <= 0) return '';
  if (visualWidth(text) <= width) return text;
  let cols = 0;
  let cut = 0;
  for (let i = 0; i < text.length; i++) {
    const w = charWidth(text[i]);
    if (cols + w > width - 1) break;
    cols += w;
    cut = i + 1;
  }
  while (cut > 0 && cut < text.length) {
    const code = text.charCodeAt(cut);
    if (code >= 0xdc00 && code <= 0xdfff) cut--;
    else break;
  }
  return `${text.slice(0, cut)}…`;
}

/** 列宽预算：总宽（Σ列 + 边框 3n+1）超内容宽度时收缩最宽列（保窄列可读） */
function fitWidths(widths: number[], contentWidth: number | undefined): number[] {
  if (contentWidth === undefined) return widths;
  const border = 3 * widths.length + 1;
  const w = [...widths];
  let total = w.reduce((a, b) => a + b, 0);
  let guard = 0;
  while (total + border > contentWidth && guard < 1000) {
    let mi = 0;
    for (let i = 1; i < w.length; i++) if (w[i] > w[mi]) mi = i;
    if (w[mi] <= 1) break; // 已是最窄
    w[mi]--;
    total--;
    guard++;
  }
  return w;
}

/** 表格边框行（上下中三条）：┌──┬──┐ / ├──┼──┤ / └──┴──┘（每行总宽 = Σ列 + 3n + 1） */
function tableBorderLine(joins: string, ends: [string, string], widths: number[]): string {
  let s = ends[0];
  widths.forEach((w, i) => {
    s += '─'.repeat(w + 2);
    s += i < widths.length - 1 ? joins : ends[1];
  });
  return s;
}

/**
 * 表格内容行：│ 单元格 │ 单元格 │（表头加粗青色，边框浅色，支持对齐与行内样式）。
 * 单元格文本先按列宽截断、再 scanInline 出行内样式（表头给所有 chunk 叠加粗+青）。
 */
function tableContentRow(
  cells: string[],
  widths: number[],
  align: string[],
  isHeader: boolean
): MdRow {
  const chunks: MdChunk[] = [];
  for (let i = 0; i < cells.length; i++) {
    const cellText = truncCell(cells[i] ?? '', widths[i]);
    const cellChunks = scanInline(cellText);
    const rendered = isHeader ? cellChunks.map((c) => ({ ...c, bold: true, fg: 'cyan' })) : cellChunks;
    // 用「渲染后」宽度算补齐：scanInline 会剥掉 ~~ / ** / ` 等标记（渲染更窄），
    // 若按原始文本宽算 pad 会多出空列、整行对不齐边框（行宽不一致）
    const renderedW = rendered.reduce((a, c) => a + visualWidth(c.text), 0);
    const pad = Math.max(0, widths[i] - renderedW);
    const leftPad = align[i] === 'right' ? pad : align[i] === 'center' ? Math.floor(pad / 2) : 0;
    const rightPad = pad - leftPad;
    chunks.push({ text: i === 0 ? '│ ' : ' │ ', dim: true });
    if (leftPad > 0) chunks.push({ text: ' '.repeat(leftPad) });
    chunks.push(...rendered);
    if (rightPad > 0) chunks.push({ text: ' '.repeat(rightPad) });
  }
  // 右边缘 ` │`（空格 + 竖线，与左边缘 `│ ` 对称）：行总宽 = Σ列 + 3n + 1 = 边框行宽
  chunks.push({ text: ' │', dim: true });
  return { chunks };
}

/**
 * 把一组表格行（首行表头 + 分隔行 + 数据行）渲染成 box-drawing 表格：
 *
 *   ┌──────┬──────────┬─────┐
 *   │ 项目 │   状态    │ 说明 │
 *   ├──────┼──────────┼─────┤
 *   │ 工具 │   ✅     │ 成功 │
 *   └──────┴──────────┴─────┘
 *
 * 列宽按内容自然宽度（CJK 全角算 2 列），超内容宽度时收缩最宽列并截断单元格——
 * 保证每行总宽 ≤ contentWidth，折行不会打破对齐（与工具卡片同一宽度约定）。
 */
function renderTable(
  headerCells: string[],
  sepCells: string[],
  dataCells: string[][],
  contentWidth?: number
): MdRow[] {
  const colCount = Math.max(
    headerCells.length,
    sepCells.length,
    ...dataCells.map((r) => r.length)
  );
  const norm = (r: string[]): string[] => {
    const c = [...r];
    while (c.length < colCount) c.push('');
    return c;
  };
  const header = norm(headerCells);
  const data = dataCells.map(norm);
  const align = colAlign(sepCells, colCount);

  // 列宽 = 表头/数据行的最大显示宽度（min 2，避免 │x│ 挤成一团）
  const widths = header.map((_, ci) => {
    let w = 0;
    for (const row of [header, ...data]) {
      const cell = row[ci] ?? '';
      const wd = visualWidth(cell);
      if (wd > w) w = wd;
    }
    return Math.max(2, w);
  });
  const fitted = fitWidths(widths, contentWidth);
  const total = fitted.reduce((a, b) => a + b, 0) + 3 * colCount + 1;
  // 极窄视口：连最小宽度的边框都放不下（总宽 > 内容宽）→ 回退纯文本行（自然折行，保内容）
  if (contentWidth !== undefined && total > contentWidth) {
    const plain: MdRow[] = [];
    const allRows: [string[], boolean][] = [[header, true], ...data.map((d) => [d, false] as [string[], boolean])];
    for (const [cells, isHeader] of allRows) {
      plain.push({ chunks: scanInline(cells.join(' | ')).map((c) => (isHeader ? { ...c, bold: true } : c)) });
    }
    return plain;
  }

  const rows: MdRow[] = [
    { chunks: [{ text: tableBorderLine('┬', ['┌', '┐'], fitted), dim: true }] },
    tableContentRow(header, fitted, align, true),
    { chunks: [{ text: tableBorderLine('┼', ['├', '┤'], fitted), dim: true }] },
  ];
  for (const row of data) rows.push(tableContentRow(row, fitted, align, false));
  rows.push({ chunks: [{ text: tableBorderLine('┴', ['└', '┘'], fitted), dim: true }] });
  return rows;
}

/* -------------------------------------------------------------------------- */

/**
 * 把一段文本解析成渲染行（answer 类型专用）。
 * 未匹配任何结构的行按普通行返回（可后续叠加行级样式）。
 *
 * contentWidth：可选；传入时表格按此宽度收缩列（超宽截断，保证每行不折行）。
 * 流式重绘每次传同一宽度 → 命中缓存；终端 resize 后宽度变化 → 自动重新解析。
 */
// 简单 memo：appendLine 只追加文本，未变动的旧回答直接命中缓存，避免每次重绘重解析
const mdCache = new Map<string, MdRow[]>();
const MD_CACHE_MAX = 200;

export function markdownToRows(text: string, contentWidth?: number): MdRow[] {
  const key = contentWidth !== undefined ? `${contentWidth}:${text}` : text;
  const hit = mdCache.get(key);
  if (hit) return hit;

  const rows: MdRow[] = [];
  let inCode = false;
  let codeLang = ''; // 围栏语言（```diff 等；只用于 diff 围栏行级着色）
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trimEnd();
    const trimmed = line.trimStart();

    // 围栏代码块：``` / ~~~ 开闭围栏行隐藏（代码行单独着色；兼容 ```js extra 元信息行）
    const fence = /^(```+|~~~+)\s*(\S*)/.exec(trimmed);
    if (fence) {
      if (!inCode) codeLang = (fence[2] ?? '').toLowerCase();
      else codeLang = '';
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      // diff 围栏：+ 绿 / - 红 / @@ 青 / 其余代码色（对标 Web markstream 的 diff 渲染；
      // 模型常在回答里贴 ```diff，之前整块单色蓝灰，用户以为重载丢格式）
      if (codeLang === 'diff') {
        if (trimmed.startsWith('+')) {
          rows.push({ chunks: [{ text: line, fg: DIFF_ADD_FG }] });
          continue;
        }
        if (trimmed.startsWith('-')) {
          rows.push({ chunks: [{ text: line, fg: DIFF_REM_FG }] });
          continue;
        }
        if (trimmed.startsWith('@@')) {
          rows.push({ chunks: [{ text: line, fg: 'cyan' }] });
          continue;
        }
      }
      rows.push({ chunks: [{ text: line, fg: CODE_FG }] });
      continue;
    }

    // 表格：当前行含 | 且下一行是分隔行（| 项目 | 状态 | + | --- | :---: |）。
    // 标题/引用优先：`# 标题 | x` + `---` 是 ATX 标题而非表格（GFM 块级优先级）
    if (!/^[#>]/.test(trimmed) && trimmed.includes('|') && i + 1 < lines.length && isTableSepLine(lines[i + 1])) {
      const sepCells = splitTableRow(lines[i + 1]);
      const data: string[][] = [];
      let j = i + 2;
      while (
        j < lines.length &&
        lines[j].trim() !== '' &&
        !/^```|^~~~/.test(lines[j].trimStart()) &&
        lines[j].includes('|')
      ) {
        data.push(splitTableRow(lines[j]));
        j++;
      }
      rows.push(...renderTable(splitTableRow(line), sepCells, data, contentWidth));
      i = j - 1;
      continue;
    }

    // 标题：# ~ ######（加粗 + 青色，行内样式生效：## **加粗** 标题）
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      rows.push({ chunks: scanInline(heading[2]).map((c) => ({ ...c, bold: true, fg: 'cyan' })) });
      continue;
    }
    // 引用：> 文本（支持嵌套 >> 与行内样式，浅色）
    const quote = /^>+\s?(.*)$/.exec(trimmed);
    if (quote) {
      rows.push({ chunks: scanInline(quote[1]).map((c) => ({ ...c, dim: true, fg: QUOTE_FG })) });
      continue;
    }
    // 水平线：--- / *** / ___（浅色虚线）
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(trimmed)) {
      rows.push({ chunks: [{ text: '──────', dim: true }] });
      continue;
    }
    // 任务清单：- [x] / - [ ]（☑/☐）
    const task = /^[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(trimmed);
    if (task) {
      const done = task[1].toLowerCase() === 'x';
      rows.push({ chunks: [{ text: done ? '☑ ' : '☐ ', fg: 'cyan' }, ...scanInline(task[2])] });
      continue;
    }
    // 无序列表：- / * / +（•）
    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      rows.push({ chunks: [{ text: '• ', fg: 'cyan' }, ...scanInline(bullet[1])] });
      continue;
    }
    // 有序列表：1. 2. …（保留序号，行内样式生效）
    const ordered = /^(\d+\.)\s+(.*)$/.exec(trimmed);
    if (ordered) {
      rows.push({ chunks: [{ text: `${ordered[1]} ` }, ...scanInline(ordered[2])] });
      continue;
    }

    rows.push({ chunks: scanInline(line) });
  }

  if (mdCache.size >= MD_CACHE_MAX) mdCache.clear();
  mdCache.set(key, rows);
  return rows;
}

/**
 * markdown-renderer.js —— Web 端 Markdown 流式渲染模块（唯一渲染入口）。
 *
 * 职责：
 *   · 用 markstream（stream-markdown-parser）把流式/完整 Markdown 解析成 AST
 *   · 把 AST 渲染成 HTML 字符串（vanilla，由 app.js innerHTML 注入）
 *   · 识别 ```diff / 文件编辑围栏，渲染成 diff 视图
 *
 * 稳定接口（供 app.js 调用；换引擎只改本文件 + vendor-entry.mjs）：
 *   OmniMarkdown.render(text, { final }) → HTML 字符串
 *   OmniMarkdown.parse(text, { final })  → AST（调试/扩展用）
 *
 * 依赖 window.__markstream（web/vendor.js 提供）。vendor.js 未加载时
 * 本模块回退到旧的 mdToHtml 逻辑（由 app.js 判定），不阻塞页面。
 */
(function () {
  'use strict';

  const ms = window.__markstream;

  /* ---------------- 工具 ---------------- */
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /** 安全链接协议白名单（javascript:/data: 等降级为纯文本） */
  function safeUrl(u) {
    const s = String(u ?? '');
    return /^(https?:|mailto:|tel:)/i.test(s) ? s : '';
  }

  /* ---------------- AST → HTML ---------------- */
  /** 渲染子节点序列（inline / block 通用） */
  function childrenHtml(nodes) {
    if (!nodes || !nodes.length) return '';
    return nodes.map(nodeToHtml).join('');
  }

  /**
   * diff 围栏渲染（markstream 已解析好 ` ```diff ` 围栏，节点带 originalCode / updatedCode）：
   * 直接用 markstream 解析产出的「原文件 / 修改后文件」两份纯文本做左右并排对比——
   * 左侧删除行（红）、右侧新增行（绿）、公共行上下文（灰）。
   *
   * 视觉对标 Claude Code Edit：行号 gutter（old/new 双列）+ 行内容。
  /** 行级 LCS 算法 */
  function computeLineOps(a, b) {
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const ops = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { ops.push({ t: '=', l: a[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: '-', l: a[i] }); i++; }
      else { ops.push({ t: '+', l: b[j] }); j++; }
    }
    while (i < n) ops.push({ t: '-', l: a[i++] });
    while (j < m) ops.push({ t: '+', l: b[j++] });
    return ops;
  }

  /**
   * diff 围栏渲染（1:1 复刻 Claude Code Edit 单列统一 diff 视图，图 2 样式）：
   * 行号 gutter + " - " / " + " / "   " + 行内容。
   */
  function diffToHtml(node) {
    const orig = String(node.originalCode ?? '');
    const upd = String(node.updatedCode ?? '');
    let ops = [];

    if (orig || upd) {
      ops = computeLineOps(orig.split('\n'), upd.split('\n'));
    } else {
      const raw = String(node.raw ?? node.code ?? '');
      for (const line of raw.split('\n')) {
        if (/^\+/.test(line) && !/^\+\+\+/.test(line)) ops.push({ t: '+', l: line.slice(1) });
        else if (/^-/.test(line) && !/^---/.test(line)) ops.push({ t: '-', l: line.slice(1) });
        else ops.push({ t: '=', l: line.startsWith(' ') ? line.slice(1) : line });
      }
    }

    // 左右配对算法：将 ops 配对为 split diff 行
    const splitRows = [];
    let oldNo = 0, newNo = 0;
    let i = 0;
    while (i < ops.length) {
      const op = ops[i];
      if (op.t === '=') {
        oldNo++; newNo++;
        splitRows.push({
          left: { no: oldNo, text: op.l, kind: 'ctx' },
          right: { no: newNo, text: op.l, kind: 'ctx' },
        });
        i++;
      } else if (op.t === '-') {
        // 收集连续的删除与新增，配对成左右两半
        const dels = [];
        const adds = [];
        while (i < ops.length && (ops[i].t === '-' || ops[i].t === '+')) {
          if (ops[i].t === '-') { oldNo++; dels.push({ no: oldNo, text: ops[i].l, kind: 'del' }); }
          else { newNo++; adds.push({ no: newNo, text: ops[i].l, kind: 'add' }); }
          i++;
        }
        const maxLen = Math.max(dels.length, adds.length);
        for (let k = 0; k < maxLen; k++) {
          splitRows.push({
            left: dels[k] || { no: '', text: '', kind: 'empty' },
            right: adds[k] || { no: '', text: '', kind: 'empty' },
          });
        }
      } else if (op.t === '+') {
        const adds = [];
        while (i < ops.length && ops[i].t === '+') {
          newNo++; adds.push({ no: newNo, text: ops[i].l, kind: 'add' });
          i++;
        }
        for (const a of adds) {
          splitRows.push({
            left: { no: '', text: '', kind: 'empty' },
            right: a,
          });
        }
      }
    }

    const maxDigits = Math.max(3, String(Math.max(oldNo, newNo)).length);
    const out = [];
    for (const r of splitRows) {
      const lNo = r.left.no ? String(r.left.no).padStart(maxDigits, ' ') : ' '.repeat(maxDigits);
      const rNo = r.right.no ? String(r.right.no).padStart(maxDigits, ' ') : ' '.repeat(maxDigits);
      const lCls = r.left.kind === 'del' ? 'md-diff-del' : r.left.kind === 'ctx' ? 'md-diff-ctx' : 'md-diff-empty';
      const rCls = r.right.kind === 'add' ? 'md-diff-add' : r.right.kind === 'ctx' ? 'md-diff-ctx' : 'md-diff-empty';
      
      const leftCol = `<div class="md-diff-col ${lCls}"><span class="md-diff-gutter">${lNo}</span><span class="md-diff-line">${esc(r.left.text)}</span></div>`;
      const rightCol = `<div class="md-diff-col ${rCls}"><span class="md-diff-gutter">${rNo}</span><span class="md-diff-line">${esc(r.right.text)}</span></div>`;
      out.push(`<div class="md-diff-split-row">${leftCol}<div class="md-diff-divider">│</div>${rightCol}</div>`);
    }

    const head = node.language ? `<div class="md-diff-head">${esc(node.language)}</div>` : '';
    return `<div class="md-diff split">${head}<pre>${out.join('')}</pre></div>`;
  }

  /** 普通代码块（loading=流式中未闭合的围栏，保留尾部光标可落点） */
  function codeBlockToHtml(node) {
    const code = esc(node.code ?? '');
    return `<pre${node.loading ? ' class="md-pre-loading"' : ''}><code>${code}</code></pre>`;
  }

  /** 表格节点：node.header (TableRowNode) + node.rows (TableRowNode[]) */
  function tableToHtml(node) {
    const rowHtml = (row, header) => {
      const cells = (row?.cells || []).map((c) => {
        const align = c.align ? ` style="text-align:${c.align}"` : '';
        const tag = c.header || header ? 'th' : 'td';
        return `<${tag}${align}>${childrenHtml(c.children)}</${tag}>`;
      }).join('');
      return `<tr>${cells}</tr>`;
    };
    return `<table><thead>${rowHtml(node.header, true)}</thead><tbody>${(node.rows || []).map((r) => rowHtml(r, false)).join('')}</tbody></table>`;
  }

  /** 列表节点：node.ordered / node.start / node.items (ListItemNode[]) */
  function listToHtml(node) {
    const tag = node.ordered ? 'ol' : 'ul';
    const start = node.ordered && node.start ? ` start="${node.start}"` : '';
    const items = (node.items || []).map((it) => `<li>${childrenHtml(it.children)}</li>`).join('');
    return `<${tag}${start}>${items}</${tag}>`;
  }

  /** 定义列表：node.items (DefinitionItemNode[])：term + definition */
  function defListToHtml(node) {
    const items = (node.items || []).map((it) => {
      const term = (it.term || []).map(nodeToHtml).join('') || '&nbsp;';
      const def = (it.definition || []).map(nodeToHtml).join('');
      return `<dt>${term}</dt><dd>${def}</dd>`;
    }).join('');
    return `<dl>${items}</dl>`;
  }

  /** 自定义 HTML 容器（::: warning 等）：保留 kind 作 class */
  function containerToHtml(node) {
    return `<div class="md-container md-container-${esc(node.name || node.kind || 'box')}">${childrenHtml(node.children)}</div>`;
  }

  /** 节点 → HTML（覆盖 markstream AST 全部节点类型；未知类型回退纯文本） */
  function nodeToHtml(n) {
    if (!n || typeof n.type !== 'string') return '';
    switch (n.type) {
      case 'text': return esc(n.content ?? '');
      case 'paragraph': return `<p>${childrenHtml(n.children)}</p>`;
      case 'inline': return childrenHtml(n.children);
      case 'heading': {
        const lvl = Math.min(6, Math.max(1, n.level || 1));
        return `<h${lvl}>${childrenHtml(n.children)}</h${lvl}>`;
      }
      case 'list': return listToHtml(n);
      case 'list_item': return `<li>${childrenHtml(n.children)}</li>`;
      case 'code_block': return n.diff ? diffToHtml(n) : codeBlockToHtml(n);
      case 'inline_code': return `<code>${esc(n.code ?? '')}</code>`;
      case 'link': {
        const href = safeUrl(n.href);
        if (!href) return childrenHtml(n.children);
        const title = n.title ? ` title="${esc(n.title)}"` : '';
        return `<a href="${esc(href)}" target="_blank" rel="noopener"${title}>${childrenHtml(n.children)}</a>`;
      }
      case 'image': {
        const src = safeUrl(n.src);
        if (!src) return esc(n.alt ?? '');
        const title = n.title ? ` title="${esc(n.title)}"` : '';
        return `<img src="${esc(src)}" alt="${esc(n.alt ?? '')}" loading="lazy"${title}>`;
      }
      case 'thematic_break': return '<hr>';
      case 'blockquote': return `<blockquote>${childrenHtml(n.children)}</blockquote>`;
      case 'table': return tableToHtml(n);
      case 'table_row': return `<tr>${(n.cells || []).map((c) => `<td>${childrenHtml(c.children)}</td>`).join('')}</tr>`;
      case 'table_cell': {
        const tag = n.header ? 'th' : 'td';
        const align = n.align ? ` style="text-align:${n.align}"` : '';
        return `<${tag}${align}>${childrenHtml(n.children)}</${tag}>`;
      }
      case 'strong': return `<strong>${childrenHtml(n.children)}</strong>`;
      case 'emphasis': return `<em>${childrenHtml(n.children)}</em>`;
      case 'strikethrough': return `<del>${childrenHtml(n.children)}</del>`;
      case 'highlight': return `<mark>${childrenHtml(n.children)}</mark>`;
      case 'insert': return `<ins>${childrenHtml(n.children)}</ins>`;
      case 'subscript': return `<sub>${childrenHtml(n.children)}</sub>`;
      case 'superscript': return `<sup>${childrenHtml(n.children)}</sup>`;
      case 'checkbox': return n.checked ? '<span class="task-done">☑</span>' : '<span class="task-todo">☐</span>';
      case 'checkbox_input': return n.checked ? '<span class="task-done">☑</span>' : '<span class="task-todo">☐</span>';
      case 'emoji': return esc(n.markup ?? n.name ?? '');
      case 'hardbreak': return '<br>';
      case 'math_inline': return `<span class="md-math">${esc(n.content ?? '')}</span>`;
      case 'math_block': return `<pre class="md-math">${esc(n.content ?? '')}</pre>`;
      // 原始 HTML：作为纯文本转义输出（AI 输出不可信，避免 XSS 注入）
      case 'html_block':
      case 'html_inline': return esc(n.content ?? n.raw ?? '');
      case 'footnote': return `<div class="md-footnote">${childrenHtml(n.children)}</div>`;
      case 'footnote_reference': return `<sup class="md-footnote-ref">${esc(n.id ?? '')}</sup>`;
      case 'footnote_anchor': return `<sup class="md-footnote-anchor">${esc(n.id ?? '')}</sup>`;
      case 'definition_list': return defListToHtml(n);
      case 'definition_item': {
        const term = (n.term || []).map(nodeToHtml).join('') || '&nbsp;';
        const def = (n.definition || []).map(nodeToHtml).join('');
        return `<dt>${term}</dt><dd>${def}</dd>`;
      }
      case 'admonition': return containerToHtml(n);
      case 'vmr_container': return containerToHtml(n);
      case 'reference': return esc(n.id ?? '');
      case 'mermaid': return codeBlockToHtml(n);
      default: {
        // 自定义组件 / 未知节点：回退纯文本（用 raw/content，保留原始内容）
        return esc(n.raw ?? n.content ?? '');
      }
    }
  }

  /* ---------------- 对外接口 ---------------- */
  function parse(text, opts = {}) {
    if (!ms) return null;
    return ms.parseMarkdownToStructure(String(text ?? ''), ms.getMarkdown(), {
      final: !!opts.final,
      streamParse: opts.final ? false : 'auto',
    });
  }

  function render(text, opts = {}) {
    const nodes = parse(text, opts);
    if (!nodes) return '';
    return nodes.map(nodeToHtml).join('\n');
  }

  /* ---------------- write_file 前后对比 diff（统一走 markstream 渲染） ----------------
   *
   * 设计：放弃手写的 LCS / 双列并排 DOM——改用 markstream 解析 ` ```diff ` 围栏
   * 的能力（它内置了真正的行级 diff 解析，产出 `originalCode`/`updatedCode` 干净的
   * 「原始文件 / 修改后文件」两份文本，不再带 `+`/`-` 前缀）。
   *
   * 调用流程（**全部经过 markstream**）：
   *   1. 把 write_file 前后内容拼成标准 unified diff 文本（手算前缀 `+`/`-`/` `）
   *   2. 包裹在 ` ```diff ` 围栏里喂给 markstream.parseMarkdownToStructure
   *   3. 解析后走原 nodeToHtml → AST → HTML（自动应用 `md-diff` 样式与 token 着色）
   *   4. 头部插入 `✦ 路径` 行
   *
   * 收益：
   *   · 真正的代码高亮（围栏语言自动识别）
   *   · 行内语法（强调/链接/代码 span）走 markstream 解析，不再是裸 div
   *   · 流式增量友好（markstream 的 streaming parser 支持围栏未闭合态）
   *   · 一处渲染逻辑（diffToHtml），与正文 Markdown 渲染同源
   */

  const FILE_DIFF_MAX_ROWS = 300; // 超大文件防御：行数超过此值截断

  /**
   * 工具函数：把「原始 / 新」两份纯文本手算成标准 unified diff 文本
   * （每行加 `+`/`-`/空格前缀）。这个手算很轻量——只产出一段文本字符串，
   * 真正的"行级 LCS + 着色渲染"交给 markstream 处理。
   */
  function buildUnifiedDiffText(original, content) {
    const a = String(original ?? '').split('\n');
    const b = String(content ?? '').split('\n');
    const n = a.length;
    const m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { out.push(' ' + a[i]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push('-' + a[i]); i++; }
      else { out.push('+' + b[j]); j++; }
    }
    while (i < n) out.push('-' + a[i++]);
    while (j < m) out.push('+' + b[j++]);
    return out.join('\n');
  }

  /**
   * 把 unified diff 文本喂给 markstream 解析并渲染成 HTML。
   * language 缺省 = 纯文本（与 TUI `unifiedDiff` 不传 language 时的全 add/ctx 行为对齐）。
   */
  function renderUnifiedDiffAsMarkdown(diffText, language) {
    const lang = language ? ' ' + language : '';
    const md = '```diff' + lang + '\n' + diffText + '\n```';
    return render(md, { final: true });
  }

  /**
   * write_file 写入前后对比（路径 + unified diff，统一走 markstream 渲染）：
   * original=null = 新建文件（全文 `+` 行）；content=null = 删除文件（全文 `-` 行）。
   * 路径头部 `✦ path` 用普通文本加粗（不进围栏），与 markstream 围栏分开。
   */
  function renderFileDiff(original, content, path) {
    let diffText;
    const isNew = original == null;
    if (original == null && content != null) {
      diffText = String(content).split('\n').map((l) => '+' + l).join('\n');
    } else if (content == null && original != null) {
      diffText = String(original).split('\n').map((l) => '-' + l).join('\n');
    } else if (original == null && content == null) {
      return `<div class="md-diff"><div class="md-diff-meta">（空内容）</div></div>`;
    } else {
      diffText = buildUnifiedDiffText(original, content);
    }
    // 超大文件截断
    const lines = diffText.split('\n');
    let truncated = false;
    let rendered = diffText;
    if (lines.length > FILE_DIFF_MAX_ROWS) {
      rendered = lines.slice(0, FILE_DIFF_MAX_ROWS).join('\n') + `\n…（已截断，超 ${FILE_DIFF_MAX_ROWS} 行）`;
      truncated = true;
    }
    const headPrefix = isNew ? '← Write' : '← Edit';
    const head = path ? `<div class="md-diff-head-title">${headPrefix} ${esc(path)}</div>` : '';
    const inner = renderUnifiedDiffAsMarkdown(rendered, '');
    return `<div class="md-diff-wrap">${head}${inner}</div>`;
  }

  /**
   * edit_file 局部替换 diff（路径 + 局部 unified diff，走 markstream 渲染）：
   * 把 oldLines / newLines 拼成 unified diff 文本 → 喂给 markstream → 渲染。
   * 视觉与 write_file 完全一致（同源渲染逻辑，图 2 样式）。
   */
  function renderEditDiff(path, oldLines, newLines) {
    const o = Array.isArray(oldLines) ? oldLines : [];
    const n = Array.isArray(newLines) ? newLines : [];
    const max = Math.max(o.length, n.length);
    const lines = [];
    for (let i = 0; i < max; i++) {
      const oldLine = i < o.length ? o[i] : '';
      const newLine = i < n.length ? n[i] : '';
      if (oldLine && newLine) {
        lines.push('-' + oldLine);
        lines.push('+' + newLine);
      } else if (oldLine) {
        lines.push('-' + oldLine);
      } else if (newLine) {
        lines.push('+' + newLine);
      }
    }
    const diffText = lines.join('\n');
    const head = path ? `<div class="md-diff-head-title">← Edit ${esc(path)}</div>` : '';
    const inner = renderUnifiedDiffAsMarkdown(diffText, '');
    return `<div class="md-diff-wrap">${head}${inner}</div>`;
  }

  window.OmniMarkdown = { render, parse, renderFileDiff, renderEditDiff };
})();

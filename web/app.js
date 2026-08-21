/**
 * omni web 前端（vanilla JS，无框架）。
 *
 * 架构：与后端建立 SSE 连接（/api/events），服务器把所有运行事件
 * （thinking / tool / answer / approval / ask / usage …）按会话推送；
 * 前端把事件渲染成消息流。发送消息走 REST（POST /api/...）。
 *
 * 事件类型（与 src/web/output.ts 一一对应）：
 *   ready / status / session.created / user.message / thinking.start
 *   thinking.chunk / thinking.end / tool.start / tool.result
 *   answer.chunk / answer.end / usage / errors / run.end / meta.add
 *   approval.request / approval.resolved / ask.request / ask.resolved
 *   subagent / title / clear
 */
'use strict';

/* ---------------- 状态 ---------------- */
const state = {
  session: null,        // 当前会话 id
  sessions: [],         // 会话列表
  status: null,         // 服务器状态
  running: false,
  planMode: false,
  blocks: new Map(),    // blockId -> MessageBlock
  waiters: new Map(),   // interactionId -> { sessionId, type(approval|ask), el }
  inFlight: 0,          // 本轮未完成的请求计数（跑完才印统计行）
  turnTokens: { prompt: 0, completion: 0, cached: 0 },
  detailsOpen: false,
  sessionFilter: '',
  trace: [],
  view: 'chat',
  selectedTool: null,
  expandedGroups: new Set(), // 工作区分组展开记忆（'!项目' 前缀 = 强制收起的当前工作区组）
};

/* ---------------- 工具 ---------------- */
function $(sel, root = document) { return root.querySelector(sel); }
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function api(path, opts) {
  return fetch(path, opts).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  });
}
/** 事件总线（SSE 回调与 DOM 更新解耦） */
function EventEmitter() {
  const handlers = {};
  return {
    on(e, fn) { (handlers[e] = handlers[e] || []).push(fn); },
    emit(e, data) { (handlers[e] || []).forEach((fn) => fn(data)); },
  };
}
const bus = new EventEmitter();

function setEmptyState(empty) {
  $('#app').classList.toggle('empty-session', empty);
  $('#input').placeholder = empty ? '描述你想要构建的内容' : '给智能体发消息';
}

/* ---------------- Markdown 渲染 ---------------- */
function mdInline(src) {
  let s = esc(src);
  // 代码优先（避免代码里的标记被处理）
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
}

/** 逐块渲染 markdown（围栏代码块 / 表格保持原样，行内做 inline 处理） */
function mdToHtml(text) {
  const lines = text.split('\n');
  const out = [];
  let inCode = false, codeLang = '', codeBuf = [];
  let inTable = false, tableBuf = [];
  let listType = null; // 'ul' | 'ol'

  const flushCode = () => {
    if (codeBuf.length) {
      out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`);
      codeBuf = [];
    }
  };
  const flushTable = () => {
    if (tableBuf.length < 3) { tableBuf = []; inTable = false; return; }
    const rows = tableBuf.map((r) =>
      r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim())
    );
    const head = rows[0];
    const align = rows[1] || [];
    const aligns = align.map((a) =>
      /^:?-+:?$/.test(a) ? (a.startsWith(':') && a.endsWith(':') ? 'center' : a.endsWith(':') ? 'right' : 'left') : ''
    );
    const data = rows.slice(2);
    let h = '<table><thead><tr>';
    head.forEach((c, i) => { h += `<th style="text-align:${aligns[i] || 'left'}">${mdInline(c)}</th>`; });
    h += '</tr></thead><tbody>';
    data.forEach((r) => {
      h += '<tr>';
      r.forEach((c, i) => {
        const t = c.startsWith('[x]') ? '<span class="task-done">☑</span> ' + mdInline(c.slice(3))
          : c.startsWith('[ ]') ? '☐ ' + mdInline(c.slice(3)) : mdInline(c);
        h += `<td style="text-align:${aligns[i] || 'left'}">${t}</td>`;
      });
      h += '</tr>';
    });
    out.push(h + '</tbody></table>');
    tableBuf = [];
    inTable = false;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith('```')) {
      if (inCode) { flushCode(); inCode = false; codeLang = ''; }
      else { flushTable(); inCode = true; codeLang = line.slice(3).trim(); }
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }

    // 表格
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[lines.indexOf(raw) + 1] || '')) {
      flushCode(); listType = null;
      inTable = true; tableBuf.push(line); continue;
    }
    if (inTable) {
      if (/^\s*\|/.test(line)) { tableBuf.push(line); continue; }
      flushTable();
    }

    // 标题
    if (/^#{1,6}\s/.test(line)) {
      const level = line.match(/^#+/)[0].length;
      out.push(`<h${level}>${mdInline(line.replace(/^#+\s*/, ''))}</h${level}>`);
      listType = null; continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push('<hr>'); listType = null; continue; }
    if (/^>\s?/.test(line)) {
      const inner = line.replace(/^>\s?/, '');
      out.push(`<blockquote>${mdInline(inner)}</blockquote>`);
      listType = null; continue;
    }
    // 列表
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul) {
      flushCode();
      if (listType !== 'ul') { if (listType) out.push(`</${listType}>`); out.push('<ul>'); listType = 'ul'; }
      out.push(`<li>${mdInline(ul[1])}</li>`); continue;
    }
    if (ol) {
      flushCode();
      if (listType !== 'ol') { if (listType) out.push(`</${listType}>`); out.push('<ol>'); listType = 'ol'; }
      out.push(`<li>${mdInline(ol[1])}</li>`); continue;
    }
    if (listType) { out.push(`</${listType}>`); listType = null; }

    if (line.trim() === '') { out.push('<p></p>'); continue; }
    out.push(`<p>${mdInline(line)}</p>`);
  }
  flushCode(); flushTable();
  if (listType) out.push(`</${listType}>`);
  return out.join('\n');
}

/* ---------------- 消息流渲染 ---------------- */
const msgList = () => $('#messages');

function makeBlock(type, sessionId) {
  const id = `${sessionId}-${type}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
  const b = { id, type, sessionId };
  state.blocks.set(id, b);
  return b;
}

function scrollBottom(force) {
  const m = msgList();
  const dist = m.scrollHeight - m.scrollTop - m.clientHeight;
  if (force || dist < 160) m.scrollTop = m.scrollHeight;
}

/* 助手消息块（含流式光标） */
function assistantBlock(sessionId) {
  setEmptyState(false);
  const b = makeBlock('assistant', sessionId);
  const wrap = el('div', 'msg assistant');
  const body = el('div', 'md-body');
  body.classList.add('cursor-blink');
  wrap.appendChild(body);
  msgList().appendChild(wrap);
  b.stopCursor = () => body.classList.remove('cursor-blink');
  // 节流重渲染：chunk 高频时只更新文本 + 定时 paint
  b._text = '';
  b._body = body;
  b._dirty = false;
  b.paint = () => {
    body.innerHTML = mdToHtml(b._text);
    scrollBottom();
  };
  return b;
}

/* 用户消息块 */
function userBlock(sessionId, text) {
  setEmptyState(false);
  const b = makeBlock('user', sessionId);
  const wrap = el('div', 'msg user');
  wrap.appendChild(el('div', 'bubble', text));
  msgList().appendChild(wrap);
  scrollBottom(true);
  return b;
}

/* 思考块 */
function thinkingBlock(sessionId) {
  setEmptyState(false);
  const b = makeBlock('thinking', sessionId);
  const wrap = el('div', 'msg');
  const box = el('div', 'thinking running');
  const head = el('div', 'th-head', '思考中');
  const body = el('div', 'th-body');
  body.classList.add('hidden');
  head.addEventListener('click', () => {
    body.classList.toggle('hidden');
    head.textContent = body.classList.contains('hidden') ? `思考 · ${b._chars} 字符` : '思考';
    scrollBottom();
  });
  box.appendChild(head); box.appendChild(body);
  wrap.appendChild(box);
  msgList().appendChild(wrap);
  b._chars = 0;
  b._body = body;
  b._head = head;
  b.finish = () => {
    box.classList.remove('running');
    head.textContent = `思考 · ${b._chars} 字符`;
    if (!body.classList.contains('hidden')) scrollBottom();
  };
  return b;
}

/* 工具卡片 */
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinIdx = 0;
function toolBlock(sessionId, data) {
  setEmptyState(false);
  const b = makeBlock('tool', sessionId);
  const wrap = el('div', 'msg');
  const card = el('div', 'tool-card running');
  const head = el('div', 'tc-head');
  head.appendChild(el('span', 'tc-cmd', data.name || 'tool'));
  const st = el('span', 'tc-state');
  st.innerHTML = `<span class="spin">${SPIN[0]}</span>${esc(data.argsPreview || '执行中')}`;
  head.appendChild(st);
  const body = el('div', 'tc-body');
  body.classList.add('hidden');
  head.addEventListener('click', () => {
    document.querySelectorAll('.tool-card.selected').forEach((node) => node.classList.remove('selected'));
    card.classList.add('selected');
    state.selectedTool = b;
    state.detailsOpen = true;
    $('#app').classList.add('details-open');
    updateDetails();
    if (!card.classList.contains('running')) body.classList.toggle('hidden');
    scrollBottom();
  });
  card.appendChild(head); card.appendChild(body);
  wrap.appendChild(card);
  msgList().appendChild(wrap);
  b._card = card; b._head = head; b._st = st; b._body = body; b._data = data;
  b._input = data.args && Object.keys(data.args).length ? JSON.stringify(data.args, null, 2) : data.argsPreview || '';
  b._output = '运行中…';
  b._error = false;
  b.spin = () => {};
  b.result = (r) => {
    card.classList.remove('running');
    const ok = r.ok;
    st.textContent = ok ? `${r.chars} 字符` : '失败';
    // 只显示结果预览前几行（与 TUI 一致）；完整结果已回传模型
    const lines = (r.preview || []).slice(0, 12).join('\n');
    const out = (r.preview && r.preview.length ? lines : ok ? '（无输出）' : r.error || '（无输出）');
    b._output = out;
    b._error = !ok;
    body.innerHTML = '';
    body.appendChild(el('div', 'tc-output', out));
    body.classList.add('hidden');
    if (state.selectedTool === b) updateDetails();
  };
  return b;
}

/* meta 行（统计） */
function metaLine(sessionId, parts) {
  const b = makeBlock('meta', sessionId);
  const wrap = el('div', 'meta-line');
  parts.forEach((p) => wrap.appendChild(el('code', '', p)));
  msgList().appendChild(wrap);
  scrollBottom(true);
  return b;
}

/* 交互卡片（审批 / 提问），渲染在输入区上方 */
function interactionCard(ev) {
  const b = makeBlock(ev.type, ev.sessionId);
  b.sid = ev.sessionId; b.id = ev.id;
  const card = el('div', `interaction-card ${ev.type}`);
  const head = el('div', 'ic-head');
  head.textContent = ev.type === 'approval' ? '⚠ 需要审批' : '❓ 向用户提问';
  const body = el('div', 'ic-body');

  if (ev.type === 'approval') {
    body.appendChild(el('div', 'ic-question', ev.reason));
    const meta = el('div', 'ic-meta', ev.summary);
    meta.title = '该操作需要你的确认';
    body.appendChild(meta);
    const acts = el('div', 'ic-actions');
    const allow = el('button', 'primary', '允许执行');
    const deny = el('button', 'danger', '拒绝');
    allow.addEventListener('click', () => resolveInteraction(b.sid, 'approval', b.id, true));
    deny.addEventListener('click', () => resolveInteraction(b.sid, 'approval', b.id, false));
    acts.appendChild(deny); acts.appendChild(allow);
    body.appendChild(acts);
  } else {
    body.appendChild(el('div', 'ic-question', ev.question));
    b.selected = new Set();
    const opts = el('div', 'ask-options');
    ev.options.forEach((opt, i) => {
      const row = el('div', 'ask-option');
      row.innerHTML = `<span class="checkbox"></span><span class="opt-text">${esc(opt)}</span>`;
      row.addEventListener('click', () => {
        if (ev.multiple) {
          if (b.selected.has(i)) { b.selected.delete(i); row.classList.remove('selected'); }
          else { b.selected.add(i); row.classList.add('selected'); }
        } else {
          b.selected = new Set([i]);
          opts.querySelectorAll('.ask-option').forEach((r, j) => r.classList.toggle('selected', j === i));
        }
      });
      opts.appendChild(row);
    });
    body.appendChild(opts);
    const custom = el('div', 'ask-custom');
    const inp = el('input');
    inp.placeholder = '自定义输入（可选）';
    custom.appendChild(inp);
    const acts = el('div', 'ic-actions ask-actions');
    const cancel = el('button', '', '取消');
    const submit = el('button', 'primary', '确认');
    cancel.addEventListener('click', () => resolveInteraction(b.sid, 'ask', b.id, null));
    submit.addEventListener('click', () => {
      const choices = [];
      ev.options.forEach((o, i) => { if (b.selected.has(i)) choices.push(o); });
      if (inp.value.trim()) choices.push(inp.value.trim());
      if (!choices.length) return;
      resolveInteraction(b.sid, 'ask', b.id, choices);
    });
    acts.appendChild(cancel); acts.appendChild(submit);
    custom.appendChild(acts);
    body.appendChild(custom);
  }

  card.appendChild(head); card.appendChild(body);
  $('#interaction-stack').appendChild(card);
  b.el = card;
  state.waiters.set(`${ev.sessionId}:${ev.type}:${b.id}`, b);
  return b;
}
function removeInteractionCard(b) {
  b.el.remove();
  state.waiters.delete(`${b.sid}:${b.type}:${b.id}`);
}

function resolveInteraction(sid, type, id, value) {
  const url = type === 'approval'
    ? `/api/sessions/${sid}/approval`
    : `/api/sessions/${sid}/ask`;
  api(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(type === 'approval' ? { approvalId: id, allow: value } : { askId: id, choices: value }),
  }).catch((e) => console.error('resolve failed', e));
}

/* ---------------- 会话管理 ---------------- */
function renderSessionList() {
  const list = $('#session-list');
  list.innerHTML = '';
  const filter = state.sessionFilter.trim().toLowerCase();
  const all = filter ? state.sessions.filter((s) => (s.title || s.id).toLowerCase().includes(filter)) : state.sessions;
  $('#session-count').textContent = String(state.sessions.length);
  if (!all.length) {
    list.appendChild(el('div', 'empty', '暂无会话'));
    return;
  }

  // 按工作区分组（组=工作区，组内元素=会话）；当前工作区组排最前且默认展开
  const cwd = state.status?.cwd || '';
  const groups = new Map();
  for (const s of all) {
    const p = s.project || '(未知工作区)';
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p).push(s);
  }
  const projects = [...groups.keys()].sort((a, b) => {
    if (a === cwd) return -1;
    if (b === cwd) return 1;
    return (groups.get(b)[0].updated || 0) - (groups.get(a)[0].updated || 0);
  });

  for (const project of projects) {
    const items = groups.get(project).sort((a, b) => (b.updated || 0) - (a.updated || 0));
    const isCwd = project === cwd;
    const expanded = state.expandedGroups.has(project) || (isCwd && !state.expandedGroups.has(`!${project}`));
    // 组头：原工作区图标 + 名称 + 会话数 + ＋（在该工作区新建会话）；chevron 旋转表示展开
    const head = el('button', 'ws-group-head' + (isCwd ? ' current' : '') + (expanded ? ' expanded' : ''));
    head.type = 'button';
    head.title = project;
    const chev = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chev.setAttribute('class', 'ws-chev');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-chevron-down');
    chev.appendChild(use);
    head.appendChild(chev);
    const ficon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ficon.setAttribute('class', 'ws-gicon');
    const fuse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    fuse.setAttribute('href', '#i-folder');
    ficon.appendChild(fuse);
    head.appendChild(ficon);
    head.appendChild(el('span', 'ws-gname', projectName(project)));
    head.appendChild(el('span', 'ws-gcount', String(items.length)));
    const addBtn = el('span', 'ws-gadd', '＋');
    addBtn.title = `在 ${projectName(project)} 新建会话`;
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      switchWorkspace(project)
        .then(() => newSession())
        .catch((err) => alert(`切换工作目录失败：${err.message}`));
    });
    head.appendChild(addBtn);
    const moreBtn = el('span', 'ws-gadd', '⋯');
    moreBtn.title = '工作区操作';
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showWorkspaceActions(e, project, items.length);
    });
    head.appendChild(moreBtn);
    head.addEventListener('click', () => {
      // 展开记忆：展开集合语义 = 强制展开的组；点击当前工作区组时用「!前缀」记录强制收起
      if (expanded) state.expandedGroups.delete(project) || state.expandedGroups.add(`!${project}`);
      else state.expandedGroups.delete(`!${project}`) || state.expandedGroups.add(project);
      renderSessionList();
    });
    list.appendChild(head);

    if (!expanded) continue;
    for (const s of items) {
      const item = el('div', 'session-item' + (s.id === state.session ? ' active' : ''));
      const d = new Date(s.updated || s.created);
      const ts = `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      item.appendChild(el('span', 'session-icon', s.id === state.session ? '●' : '○'));
      const copy = el('div', 'session-copy');
      copy.appendChild(el('div', 'stitle', s.title || '新会话'));
      const meta = el('div', 'smeta');
      meta.appendChild(el('span', '', `${s.messages || 0} 条消息`));
      meta.appendChild(el('span', '', ts));
      copy.appendChild(meta);
      item.appendChild(copy);
      const more = el('span', 'session-more', '⋯');
      more.title = '会话操作';
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        showSessionActions(e, s);
      });
      item.appendChild(more);
      // 点击跨工作区的会话：先切到该工作区（工具/记忆/系统提示跟随），再加载对话
      item.addEventListener('click', () => {
        const target = s.project && s.project !== '(未知工作区)' ? s.project : null;
        const needSwitch = target && target !== (state.status?.cwd || '');
        const doSelect = () => selectSession(s.id).catch((e) => console.error(e));
        if (needSwitch) switchWorkspace(target).then(doSelect).catch((err) => alert(`打开会话失败：${err.message}`));
        else doSelect();
      });
      list.appendChild(item);
    }
  }
}

/** 工作区分组显示名：目录 basename（根目录显示 /） */
function projectName(p) {
  if (!p || p === '(未知工作区)') return p || '(未知工作区)';
  const parts = p.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '/';
}

/* ---------------- 会话操作（⋯ 菜单：重命名 / 删除） ---------------- */function closeSessionActions() {
  document.querySelectorAll('.ctx-menu').forEach((m) => m.remove());
  document.removeEventListener('click', closeSessionActions, true);
  document.removeEventListener('keydown', escSessionActions, true);
}
function escSessionActions(e) {
  if (e.key === 'Escape') closeSessionActions();
}

/** 工作区操作菜单（组头 ⋯）：移除工作区（清单去掉 + 删该区全部会话记录，目录本身不动） */
function showWorkspaceActions(e, project, count) {
  closeSessionActions();
  const menu = el('div', 'ctx-menu');
  const del = el('button', 'ctx-item danger', '移除工作区');
  del.type = 'button';
  del.addEventListener('click', () => {
    closeSessionActions();
    if (!confirm(`移除工作区「${projectName(project)}」？\n其下 ${count} 个会话将被一并删除（目录本身不受影响）。`)) return;
    api('/api/workspace/remove', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir: project }),
    })
      .then(() => refreshStatus())
      .then(() => api('/api/sessions'))
      .then((list) => {
        state.sessions = list;
        // 当前打开的会话若属于被移除的工作区，回草稿态
        if (state.session && !state.sessions.some((x) => x.id === state.session)) {
          state.session = null;
          clearMessages();
          renderWelcome();
          updateComposer();
          updateStatusText();
        }
        renderSessionList();
      })
      .catch((err) => alert(`移除失败：${err.message}`));
  });
  menu.append(del);
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(e.clientX, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(e.clientY, window.innerHeight - rect.height - 8)}px`;
  setTimeout(() => {
    document.addEventListener('click', closeSessionActions, true);
    document.addEventListener('keydown', escSessionActions, true);
  }, 0);
}

function showSessionActions(e, s) {
  closeSessionActions();
  const menu = el('div', 'ctx-menu');
  const ren = el('button', 'ctx-item', '重命名');
  ren.type = 'button';
  ren.addEventListener('click', () => {
    closeSessionActions();
    const t = prompt('会话标题', s.title || '');
    if (t === null) return;
    const title = t.trim();
    if (!title) return;
    api(`/api/sessions/${s.id}/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    })
      .then(() => {
        s.title = title;
        const live = state.sessions.find((x) => x.id === s.id);
        if (live) live.title = title;
        if (state.session === s.id) $('#chat-title').textContent = title;
        renderSessionList();
      })
      .catch((err) => alert(`重命名失败：${err.message}`));
  });
  const del = el('button', 'ctx-item danger', '删除会话');
  del.type = 'button';
  del.addEventListener('click', () => {
    closeSessionActions();
    if (!confirm(`删除会话「${s.title || s.id}」？此操作不可恢复。`)) return;
    api(`/api/sessions/${s.id}/delete`, { method: 'DELETE' })
      .then(() => {
        state.sessions = state.sessions.filter((x) => x.id !== s.id);
        if (state.session === s.id) {
          state.session = null;
          clearMessages();
          renderWelcome();
          updateComposer();
          updateStatusText();
        }
        renderSessionList();
      })
      .catch((err) => alert(`删除失败：${err.message}`));
  });
  menu.append(ren, del);
  document.body.appendChild(menu);
  // 定位到点击点附近并钳制在视口内
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(e.clientX, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(e.clientY, window.innerHeight - rect.height - 8)}px`;
  // 延迟注册：避免本次 click 冒泡立即关闭
  setTimeout(() => {
    document.addEventListener('click', closeSessionActions, true);
    document.addEventListener('keydown', escSessionActions, true);
  }, 0);
}

function clearMessages() {
  state.blocks.clear();
  $('#messages').innerHTML = '';
  $('#interaction-stack').innerHTML = '';
  state.waiters.clear();
  state.turnTokens = { prompt: 0, completion: 0, cached: 0 };
  state.inFlight = 0;
  state.trace = [];
  state.selectedTool = null;
  updateDetails();
}

function renderWelcome() {
  setEmptyState($('#messages').children.length === 0);
}

function updateDetails() {
  const st = state.status || {};
  // 模型名 + 思考级别（未设置级别只显示模型名）；写进 label span，保留 chevron svg
  const eff = st.reasoningEffort;
  $('#composer-model-label').textContent = st.model ? (eff ? `${st.model} · ${eff}` : st.model) : '—';
  $('#composer-mode').textContent = state.planMode ? '计划模式' : '标准模式';
  const selected = state.selectedTool;
  $('#details-title').textContent = selected?._data?.name || '详情';
  $('#details-empty').classList.toggle('hidden', !!selected);
  $('#details-input-section').classList.toggle('hidden', !selected);
  $('#details-output-section').classList.toggle('hidden', !selected);
  if (selected) {
    $('#details-input').textContent = selected._input || '（无输入）';
    $('#details-output').textContent = selected._output || '运行中…';
    $('#details-output').classList.toggle('error', !!selected._error);
  }
}

function renderTrajectory() {
  const view = $('#trajectory-view');
  view.innerHTML = '';
  if (!state.trace.length) {
    view.appendChild(el('div', 'empty', '当前会话还没有运行轨迹'));
    return;
  }
  state.trace.forEach((row) => {
    const line = el('div', 'trace-row');
    line.appendChild(el('span', 'trace-kind', row.kind));
    line.appendChild(el('span', 'trace-text', row.kind === 'tool' ? `${row.name || 'tool'}  ${row.args || ''}` : row.text || ''));
    view.appendChild(line);
  });
}

function setView(view) {
  state.view = view;
  document.querySelectorAll('.view-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.view === view));
  $('#messages').classList.toggle('hidden', view !== 'chat');
  $('#trajectory-view').classList.toggle('hidden', view !== 'trajectory');
  if (view === 'trajectory') renderTrajectory();
}

async function selectSession(id, silent) {
  state.session = id;
  clearMessages();
  renderSessionList();
  try {
    const data = await api(`/api/sessions/${id}/messages`);
    const s = state.sessions.find((x) => x.id === id);
    $('#chat-title').textContent = s?.title || (data.meta?.title) || '会话';
    data.messages.forEach((m) => {
      const txt = typeof m.content === 'string' ? m.content : '';
      if (m.role === 'user') userBlock(id, txt);
      else if (m.role === 'assistant' && txt) {
        const b = assistantBlock(id);
        b._text = txt; b.paint(); b.stopCursor();
      }
    });
    renderWelcome();
    scrollBottom(true);
    updateDetails();
    updateComposer();
    updateStatusText();
    if (state.view === 'trajectory') renderTrajectory();
    $('#app').classList.remove('sidebar-open');
  } catch (e) {
    console.error(e);
  }
}

/** 新会话：仅进入草稿态（不落盘）——首条消息发出时才真正创建会话文件，
 *  避免反复点「新会话」/ Cmd+K 在磁盘上积累大量空会话 */
async function newSession() {
  state.session = null;
  clearMessages();
  $('#chat-title').textContent = '新会话';
  renderSessionList();
  renderWelcome();
  updateComposer();
  updateStatusText();
  $('#app').classList.remove('sidebar-open');
}

/* ---------------- 服务器状态 / 设置 ---------------- */
let statusTimer = null;

function updateStatusText() {
  const dot = $('#status-dot');
  const txt = $('#status-text');
  const sidebarDot = $('#sidebar-status-dot');
  [dot, sidebarDot].forEach((n) => {
    n.classList.toggle('running', state.running);
    n.classList.toggle('ready', !state.running && !!state.status);
    n.classList.remove('error');
  });
  if (state.running) {
    txt.textContent = '运行中…';
  } else {
    txt.textContent = state.session ? '就绪' : '选择或新建会话';
  }
}

function refreshStatus() {
  return api('/api/status').then((s) => {
    state.status = s;
    state.running = s.running;
    state.planMode = !!s.planMode;
    $('#ver').textContent = `v${s.version}`;
    $('#cwd').textContent = s.cwd;
    $('#cwd').title = s.cwd;
    $('#about-cwd').textContent = s.cwd;
    $('#about-tools').textContent = s.tools.join(', ');
    $('#about-server').textContent = `http://${location.host}`;
    $('#plan-mode').checked = state.planMode;
    $('#set-permission').value = s.permission || 'safe';
    const workspaceName = s.cwd ? s.cwd.split('/').filter(Boolean).pop() || '当前工作区' : '当前工作区';
    $('#hero-workspace-name').textContent = workspaceName;
    updateDetails();
    updateComposer();
    updateStatusText();
  });
}

function updateComposer() {
  const send = $('#btn-send');
  const cancel = $('#btn-cancel');
  const note = $('#composer-note');
  send.disabled = state.running;
  send.title = state.running ? '运行中' : '发送消息';
  cancel.classList.toggle('hidden', !state.running);
  if (state.running) note.textContent = '任务运行中…';
  else if (!state.session) note.textContent = '输入消息开始新对话';
  else note.textContent = '';
}

/** 浏览新工作区：Electron 原生对话框；纯浏览器 → 页面内文件夹浏览器 */
function browseWorkspace() {
  if (window.omni && typeof window.omni.pickDirectory === 'function') {
    window.omni.pickDirectory()
      .then((dir) => {
        if (dir) switchWorkspace(dir).catch((err) => alert(`切换工作目录失败：${err.message}`));
      })
      .catch(() => {});
  } else {
    openDirPicker(state.status?.cwd || '/');
  }
}

/** 切换工作目录：POST /api/workspace（后端 chdir + 重建运行时 + 持久化），随后刷新状态与会话列表 */
async function switchWorkspace(dir) {
  await api('/api/workspace', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dir }),
  });
  await refreshStatus();
  state.sessions = await api('/api/sessions');
  renderSessionList();
}

function applySettings(patch) {
  return api('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  }).then(refreshStatus);
}

/* ---------------- SSE ---------------- */
function connectSSE() {
  const es = new EventSource('/api/events');
  const on = (name) => es.addEventListener(name, (m) => {
    try { bus.emit(name, JSON.parse(m.data)); } catch (e) { /* ignore malformed */ }
  });
  [
    'status', 'session.created', 'user.message', 'thinking.start', 'thinking.chunk',
    'thinking.end', 'tool.start', 'tool.result', 'answer.chunk', 'answer.end',
    'usage', 'error', 'run.end', 'approval.request', 'approval.resolved',
    'ask.request', 'ask.resolved', 'subagent', 'title', 'meta.add', 'clear',
    'workspace.changed',
  ].forEach(on);
  es.onerror = () => {
    $('#status-dot').classList.add('error');
    $('#sidebar-status-dot').classList.add('error');
    $('#status-text').textContent = '已断开，重连中…';
  };
  es.onopen = () => {
    refreshStatus().then(() => {
      if (!state.session && state.sessions.length) selectSession(state.sessions[0].id, true);
      updateStatusText();
    }).catch(() => {});
  };
}

/* ---------------- 事件处理 ---------------- */

bus.on('ready', () => {});
bus.on('status', (s) => {
  state.status = s;
  state.running = s.running;
  state.planMode = !!s.planMode;
  $('#plan-mode').checked = state.planMode;
  updateDetails();
  updateComposer();
  updateStatusText();
});

bus.on('session.created', (ev) => {
  if (!state.sessions.find((s) => s.id === ev.id)) {
    state.sessions.unshift({ id: ev.id, title: ev.title || '新会话', messages: 0, created: Date.now(), updated: Date.now() });
    renderSessionList();
  }
});

bus.on('title', (ev) => {
  if (ev.sessionId !== state.session) return;
  $('#chat-title').textContent = ev.title;
  const s = state.sessions.find((x) => x.id === ev.sessionId);
  if (s) { s.title = ev.title; renderSessionList(); updateDetails(); }
});

bus.on('user.message', (ev) => {
  if (ev.sessionId !== state.session) return;
  userBlock(ev.sessionId, ev.text);
  state.trace.push({ kind: 'user', text: ev.text });
  if (state.view === 'trajectory') renderTrajectory();
});

/* 一轮开始的 thinking 块：预建（等待真正的 reasoning chunk） */
let currentThinking = null;
bus.on('thinking.start', (ev) => {
  if (ev.sessionId !== state.session) return;
  if (currentThinking) { currentThinking.finish(); }
  currentThinking = thinkingBlock(ev.sessionId);
  state.trace.push({ kind: 'thinking' });
  if (state.view === 'trajectory') renderTrajectory();
});
bus.on('thinking.chunk', (ev) => {
  if (ev.sessionId !== state.session) return;
  if (!currentThinking) currentThinking = thinkingBlock(ev.sessionId);
  currentThinking._chars += ev.text.length;
  currentThinking._body.textContent += ev.text;
  const lastThinking = state.trace[state.trace.length - 1];
  if (lastThinking?.kind === 'thinking') lastThinking.text = (lastThinking.text || '') + ev.text;
  if (state.view === 'trajectory') renderTrajectory();
  scrollBottom();
});
bus.on('thinking.end', (ev) => {
  if (ev.sessionId !== state.session) return;
  if (currentThinking) { currentThinking.finish(); currentThinking = null; }
});

let currentAssistant = null;
bus.on('answer.chunk', (ev) => {
  if (ev.sessionId !== state.session) return;
  if (!currentAssistant) currentAssistant = assistantBlock(ev.sessionId);
  currentAssistant._text += ev.text;
  const lastAnswer = state.trace[state.trace.length - 1];
  if (lastAnswer?.kind === 'answer') lastAnswer.text += ev.text;
  else state.trace.push({ kind: 'answer', text: ev.text });
  if (state.view === 'trajectory') renderTrajectory();
  if (!currentAssistant._paintTimer) {
    currentAssistant._paintTimer = setTimeout(() => {
      currentAssistant.paint();
      currentAssistant._paintTimer = null;
    }, 60);
  }
});
bus.on('answer.end', (ev) => {
  if (ev.sessionId !== state.session) return;
  if (currentAssistant) {
    clearTimeout(currentAssistant._paintTimer);
    currentAssistant.paint();
    currentAssistant.stopCursor();
    currentAssistant = null;
  }
});

const currentTools = [];
bus.on('tool.start', (ev) => {
  if (ev.sessionId !== state.session) return;
  currentTools.push(toolBlock(ev.sessionId, ev));
  state.inFlight++;
  state.trace.push({ kind: 'tool', name: ev.name, args: ev.argsPreview });
  if (state.view === 'trajectory') renderTrajectory();
});
bus.on('tool.result', (ev) => {
  if (ev.sessionId !== state.session) return;
  const currentTool = currentTools.shift();
  if (currentTool) currentTool.result(ev);
  state.inFlight--;
});

bus.on('usage', (ev) => {
  if (ev.sessionId !== state.session) return;
  state.turnTokens.prompt += ev.prompt || 0;
  state.turnTokens.completion += ev.completion || 0;
  state.turnTokens.cached += ev.cached || 0;
});

bus.on('subagent', (ev) => {
  if (ev.sessionId !== state.session) return;
  if (ev.ev && ev.ev.type === 'start') {
    state.inFlight++;
  } else if (ev.ev && ev.ev.type === 'end') {
    state.inFlight--;
  }
});

bus.on('run.end', (ev) => {
  if (ev.sessionId !== state.session) return;
  state.running = false;
  if (currentThinking) { currentThinking.finish(); currentThinking = null; }
  if (currentAssistant) {
    currentAssistant.paint();
    currentAssistant.stopCursor();
    currentAssistant = null;
  }
  updateComposer();
  updateStatusText();
  // 本轮统计行
  const t = state.turnTokens;
  const fmt = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
  if (t.prompt + t.completion > 0 || state.inFlight > 0) {
    metaLine(ev.sessionId, [
      `⚡ 输入 ${fmt(t.prompt)} · 输出 ${fmt(t.completion)}` + (t.cached ? ` · 缓存 ${fmt(t.cached)}` : ''),
      `· ${ev.reason === 'completed' ? '完成' : ev.reason === 'aborted' ? '已取消' : ev.reason === 'error' ? '出错' : '触达步数上限'}`,
    ]);
  }
  state.turnTokens = { prompt: 0, completion: 0, cached: 0 };
  state.inFlight = 0;
  refreshSessions().then(updateDetails);
  if (state.view === 'trajectory') renderTrajectory();
});

bus.on('error', (ev) => {
  if (ev.sessionId !== state.session) return;
  metaLine(ev.sessionId, [`✗ ${ev.message}`]);
  $('#status-dot').classList.add('error');
  $('#sidebar-status-dot').classList.add('error');
  $('#status-text').textContent = '请求失败';
});

bus.on('approval.request', (ev) => {
  if (ev.sessionId !== state.session) return;
  interactionCard({ ...ev, type: 'approval', id: ev.approvalId });
  scrollBottom(true);
});
bus.on('approval.resolved', (ev) => {
  const key = `${ev.sessionId}:approval:${ev.approvalId}`;
  const w = state.waiters.get(key);
  if (w) removeInteractionCard(w);
  if (ev.sessionId === state.session) {
    metaLine(ev.sessionId, [ev.allow ? '✓ 已允许' : '✗ 已拒绝']);
  }
});
bus.on('ask.request', (ev) => {
  if (ev.sessionId !== state.session) return;
  interactionCard({ ...ev, type: 'ask', id: ev.askId });
  scrollBottom(true);
});
bus.on('ask.resolved', (ev) => {
  const key = `${ev.sessionId}:ask:${ev.askId}`;
  const w = state.waiters.get(key);
  if (w) removeInteractionCard(w);
  if (ev.sessionId === state.session) {
    userBlock(ev.sessionId, ev.choices && ev.choices.length ? `（用户选择：${ev.choices.join('、')}）` : '（用户取消）');
  }
});

bus.on('meta.add', (ev) => {
  if (ev.sessionId !== state.session) return;
  metaLine(ev.sessionId, [ev.text]);
});
bus.on('workspace.changed', () => {
  refreshStatus().catch(() => {});
  api('/api/sessions')
    .then((list) => {
      state.sessions = list;
      renderSessionList();
    })
    .catch(() => {});
});
bus.on('clear', (ev) => {
  if (ev.sessionId !== state.session) return;
  clearMessages();
});

/* ---------------- 会话列表刷新 ---------------- */
function refreshSessions() {
  return api('/api/sessions').then((list) => {
    state.sessions = list;
    renderSessionList();
    const s = state.sessions.find((x) => x.id === state.session);
    if (s) {
      $('#chat-title').textContent = s.title || '会话';
    }
    updateDetails();
  }).catch(() => {});
}

/* ---------------- 输入 / 发送 ---------------- */
const input = $('#input');
function autoResize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
}
input.addEventListener('input', autoResize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
document.addEventListener('keydown', (e) => {
  const isNew = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
  if (isNew) {
    e.preventDefault();
    if (!state.running) newSession().catch((err) => console.error(err));
  } else if (e.key === '/' && document.activeElement !== input && document.activeElement?.tagName !== 'INPUT') {
    e.preventDefault();
    $('#session-search').focus();
  } else if (e.key === 'Escape') {
    if (!$('#dirpicker-modal').classList.contains('hidden')) closeDirPicker();
    else if (!$('#model-pop').classList.contains('hidden')) closeModelPop();
    else if (!$('#settings-modal').classList.contains('hidden')) closeSettings();
    else if ($('#app').classList.contains('sidebar-open')) $('#app').classList.remove('sidebar-open');
    else if (state.detailsOpen) {
      state.detailsOpen = false;
      $('#app').classList.remove('details-open');
    }
  }
});

async function sendMessage() {
  const text = input.value.trim();
  if (!text || state.running) return;
  input.value = '';
  autoResize();
  state.running = true;
  setEmptyState(false);
  updateComposer();
  updateStatusText();
  try {
    // 懒创建：草稿态（未选会话）下首条消息才真正创建会话文件
    if (!state.session) {
      const data = await api('/api/sessions', { method: 'POST' });
      state.session = data.id;
      if (!state.sessions.some((s) => s.id === data.id)) {
        state.sessions.unshift({ id: data.id, title: '新会话', messages: 0, created: Date.now(), updated: Date.now() });
      }
      renderSessionList();
    }
    await api(`/api/sessions/${state.session}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch (e) {
    state.running = false;
    if (state.session) metaLine(state.session, [`✗ 发送失败：${e.message}`]);
    updateComposer();
    updateStatusText();
  }
}

$('#btn-send').addEventListener('click', sendMessage);
$('#btn-cancel').addEventListener('click', () => {
  if (state.session) {
    api(`/api/sessions/${state.session}/cancel`, { method: 'POST' }).catch(() => {});
  }
});
function openSettings() {
  refreshStatus();
  $('#settings-modal').classList.remove('hidden');
  document.body.classList.add('settings-open');
}
function closeSettings() {
  $('#settings-modal').classList.add('hidden');
  document.body.classList.remove('settings-open');
}

$('#btn-new').addEventListener('click', () => newSession().catch((e) => console.error(e)));
$('#btn-new-brand').addEventListener('click', () => newSession().catch((e) => console.error(e)));
$('#btn-session-add').addEventListener('click', () => browseWorkspace());
$('#btn-settings').addEventListener('click', () => openSettings());
$('#btn-composer-settings').addEventListener('click', () => openSettings());
$('#composer-model').addEventListener('click', (e) => {
  e.stopPropagation();
  const pop = $('#model-pop');
  if (pop.classList.contains('hidden')) openModelPop();
  else closeModelPop();
});

/* ---------------- 模型 / 思考级别 popover（composer 内联切换） ---------------- */
function openModelPop() {
  renderModelPop(state.status || {});
  $('#model-pop').classList.remove('hidden');
}

function closeModelPop() {
  $('#model-pop').classList.add('hidden');
}

function renderModelPop(s) {
  const pop = $('#model-pop');
  if (!pop) return;
  pop.innerHTML = '';

  // —— 模型（下拉选择）——
  pop.appendChild(el('div', 'pop-head', '模型'));
  const sel = document.createElement('select');
  sel.className = 'pop-select';
  const models = Array.isArray(s.models) ? s.models : [];
  for (const m of models) {
    const o = document.createElement('option');
    o.value = m.name;
    o.textContent = m.baseURL && !m.baseURL.includes('api.openai.com') ? `${m.name} · ${m.baseURL}` : m.name;
    if (m.name === s.model) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => {
    applySettings({ model: sel.value })
      .then(() => renderModelPop(state.status || {}))
      .catch((err) => alert(`切换失败：${err.message}`));
  });
  pop.appendChild(sel);

  // —— 思考级别（slider 滑杆，离散档位）——
  const efforts = Array.isArray(s.reasoningEffortOptions) ? s.reasoningEffortOptions.filter(Boolean) : [];
  if (efforts.length) {
    pop.appendChild(el('div', 'pop-sep'));
    const headRow = el('div', 'pop-head-row');
    headRow.appendChild(el('div', 'pop-head', '思考级别'));
    const val = el('span', 'pop-val', s.reasoningEffort || efforts[0]);
    headRow.appendChild(val);
    pop.appendChild(headRow);

    const idx = Math.max(0, efforts.indexOf(s.reasoningEffort));
    const range = document.createElement('input');
    range.type = 'range';
    range.className = 'pop-slider';
    range.min = '0';
    range.max = String(efforts.length - 1);
    range.step = '1';
    range.value = String(idx);
    let applied = idx;
    // input：拖动时仅更新数值标签；change：松手才落盘（失败回弹）
    range.addEventListener('input', () => {
      val.textContent = efforts[Number(range.value)] ?? '';
    });
    range.addEventListener('change', () => {
      const pos = Number(range.value);
      const v = efforts[pos];
      if (pos === applied || !v) return;
      applySettings({ reasoningEffort: v })
        .then(() => {
          applied = pos;
        })
        .catch((err) => {
          alert(`设置失败：${err.message}`);
          range.value = String(applied);
          val.textContent = efforts[applied];
        });
    });
    pop.appendChild(range);
    const ticks = el('div', 'pop-ticks');
    efforts.forEach((t) => ticks.appendChild(el('span', null, t)));
    pop.appendChild(ticks);
  }
}

/* 点击 popover 外关闭 */
document.addEventListener('click', (e) => {
  const pop = $('#model-pop');
  const face = $('#composer-model');
  if (!pop.classList.contains('hidden') && !pop.contains(e.target) && !face.contains(e.target)) closeModelPop();
});
$('#btn-close-settings').addEventListener('click', () => {
  closeSettings();
});
$('#settings-modal').addEventListener('click', (e) => {
  if (e.target === $('#settings-modal')) {
    closeSettings();
  }
});

$('#session-search').addEventListener('input', (e) => {
  state.sessionFilter = e.target.value;
  renderSessionList();
});
document.querySelectorAll('.view-tab').forEach((tab) => tab.addEventListener('click', () => setView(tab.dataset.view)));
$('#btn-details').addEventListener('click', () => {
  state.detailsOpen = !state.detailsOpen;
  $('#app').classList.toggle('details-open', state.detailsOpen);
  updateDetails();
});
$('#btn-close-details').addEventListener('click', () => {
  state.detailsOpen = false;
  $('#app').classList.remove('details-open');
});
$('#btn-sidebar-toggle').addEventListener('click', () => {
  $('#app').classList.toggle('sidebar-collapsed');
});
$('#btn-mobile-sidebar').addEventListener('click', () => $('#app').classList.toggle('sidebar-open'));

$('#set-permission').addEventListener('change', (e) => {
  applySettings({ permission: e.target.value }).catch((err) => alert(`设置失败：${err.message}`));
});
$('#btn-save-apikey').addEventListener('click', () => {
  const v = $('#set-apikey').value.trim();
  if (!v) return;
  applySettings({ apiKey: v }).then(() => {
    $('#set-apikey').value = '';
    $('#composer-note').textContent = 'API Key 已生效（本次运行）';
  }).catch((err) => alert(`保存失败：${err.message}`));
});
$('#plan-mode').addEventListener('change', (e) => {
  applySettings({ planMode: e.target.checked }).catch((err) => alert(`设置失败：${err.message}`));
});

/* ---------------- 文件夹浏览器（页面内，服务端列目录） ---------------- */
let dirPickerPath = null;

function openDirPicker(startPath) {
  dirPickerPath = startPath;
  $('#dirpicker-modal').classList.remove('hidden');
  navigateDirPicker(startPath);
}

function closeDirPicker() {
  $('#dirpicker-modal').classList.add('hidden');
}

async function navigateDirPicker(p) {
  const list = $('#dirpicker-list');
  list.innerHTML = '';
  list.appendChild(el('div', 'dir-empty', '加载中…'));
  try {
    const data = await api(`/api/fs/dirs?path=${encodeURIComponent(p)}`);
    dirPickerPath = data.current;
    $('#dirpicker-current').textContent = data.current;
    list.innerHTML = '';
    if (!data.dirs.length) {
      list.appendChild(el('div', 'dir-empty', '此目录下没有子目录'));
      return;
    }
    for (const name of data.dirs) {
      const item = el('button', 'dir-item');
      item.type = 'button';
      item.appendChild(el('span', null, '📁'));
      item.appendChild(el('span', 'dir-name', name));
      item.addEventListener('click', () => navigateDirPicker(`${data.current}/${name}`.replace(/\/+/g, '/')));
      list.appendChild(item);
    }
  } catch (e) {
    list.innerHTML = '';
    list.appendChild(el('div', 'dir-empty', `无法读取目录：${e.message}`));
  }
}

$('#btn-dir-up').addEventListener('click', () => {
  if (dirPickerPath && dirPickerPath !== '/') navigateDirPicker(dirPickerPath.replace(/\/[^/]+\/?$/, '') || '/');
});
$('#btn-dir-select').addEventListener('click', () => {
  if (!dirPickerPath) return;
  closeDirPicker();
  switchWorkspace(dirPickerPath).catch((err) => alert(`切换工作目录失败：${err.message}`));
});
$('#btn-dir-cancel').addEventListener('click', closeDirPicker);
$('#btn-close-dirpicker').addEventListener('click', closeDirPicker);
$('#dirpicker-modal').addEventListener('click', (e) => {
  if (e.target === $('#dirpicker-modal')) closeDirPicker();
});

/* 会话消息区点击空白时聚焦输入 */
$('#messages').addEventListener('click', (e) => {
  if (e.target === $('#messages')) input.focus();
});

/* ---------------- 启动 ---------------- */
(async function init() {
  connectSSE();
  try {
    await refreshStatus();
  } catch (e) {
    $('#status-text').textContent = '无法连接服务器';
  }
  try {
    state.sessions = await api('/api/sessions');
    renderSessionList();
    if (state.sessions.length) await selectSession(state.sessions[0].id, true);
    else renderWelcome();
  } catch (e) { renderWelcome(); }
})();

/* spinner 动画 */
setInterval(() => {
  spinIdx++;
  document.querySelectorAll('.tool-card.running .spin').forEach((n) => {
    n.textContent = SPIN[spinIdx % SPIN.length];
  });
}, 200);

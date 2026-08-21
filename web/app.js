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
  const sessions = filter ? state.sessions.filter((s) => (s.title || s.id).toLowerCase().includes(filter)) : state.sessions;
  $('#session-count').textContent = String(state.sessions.length);
  if (!sessions.length) {
    list.appendChild(el('div', 'empty', '暂无会话'));
    return;
  }
  sessions.forEach((s) => {
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
    item.appendChild(el('span', 'session-more', '⋯'));
    item.addEventListener('click', () => selectSession(s.id));
    list.appendChild(item);
  });
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
  $('#composer-model').textContent = st.model || '—';
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

async function newSession() {
  const data = await api('/api/sessions', { method: 'POST' });
  if (!state.sessions.some((s) => s.id === data.id)) {
    state.sessions.unshift({ id: data.id, title: '新会话', messages: 0, created: Date.now(), updated: Date.now() });
  }
  await selectSession(data.id);
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
    $('#header-model').textContent = s.model;
    $('#cwd').textContent = s.cwd;
    $('#cwd').title = s.cwd;
    $('#about-cwd').textContent = s.cwd;
    $('#about-tools').textContent = s.tools.join(', ');
    $('#about-server').textContent = `http://${location.host}`;
    $('#plan-mode').checked = state.planMode;
    fillModelSelect(s);
    fillEffortSelect(s);
    $('#set-permission').value = s.permission || 'safe';
    const workspaceName = s.cwd ? s.cwd.split('/').filter(Boolean).pop() || '当前工作区' : '当前工作区';
    $('#workspace-name').textContent = workspaceName;
    $('#hero-workspace-name').textContent = workspaceName;
    updateDetails();
    updateComposer();
    updateStatusText();
  });
}

function fillModelSelect(s) {
  const sel = $('#set-model');
  const prev = sel.value;
  sel.innerHTML = '';
  (s.models || [s.model]).forEach((m) => {
    const o = el('option', '', m.name);
    o.value = m.name;
    if (m.baseURL && !m.baseURL.includes('api.openai.com')) o.textContent = `${m.name} · ${m.baseURL}`;
    sel.appendChild(o);
  });
  if (prev) sel.value = prev;
  const cur = (s.models || []).find((m) => m.name === s.model);
  if (cur) sel.value = cur.name;
}

function fillEffortSelect(s) {
  const sel = $('#set-effort');
  sel.innerHTML = '';
  (s.reasoningEffortOptions || ['low', 'medium', 'high']).forEach((e) => {
    const o = el('option', '', e);
    o.value = e;
    sel.appendChild(o);
  });
  if (s.reasoningEffort) sel.value = s.reasoningEffort;
}

function updateComposer() {
  const send = $('#btn-send');
  const cancel = $('#btn-cancel');
  const note = $('#composer-note');
  send.disabled = state.running || !state.session;
  send.title = state.running ? '运行中' : '发送消息';
  cancel.classList.toggle('hidden', !state.running);
  if (state.running) note.textContent = '任务运行中…';
  else if (!state.session) note.textContent = '请先新建或选择会话';
  else note.textContent = '';
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
  fillModelSelect(s);
  fillEffortSelect(s);
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
    if (!$('#settings-modal').classList.contains('hidden')) closeSettings();
    else if ($('#app').classList.contains('sidebar-open')) $('#app').classList.remove('sidebar-open');
    else if (state.detailsOpen) {
      state.detailsOpen = false;
      $('#app').classList.remove('details-open');
    }
  }
});

function sendMessage() {
  const text = input.value.trim();
  if (!text || state.running || !state.session) return;
  input.value = '';
  autoResize();
  state.running = true;
  setEmptyState(false);
  updateComposer();
  updateStatusText();
  api(`/api/sessions/${state.session}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  }).catch((e) => {
    state.running = false;
    metaLine(state.session, [`✗ 发送失败：${e.message}`]);
    updateComposer();
    updateStatusText();
  });
}

$('#btn-send').addEventListener('click', sendMessage);
$('#btn-cancel').addEventListener('click', () => {
  if (state.session) {
    api(`/api/sessions/${state.session}/cancel`, { method: 'POST' }).catch(() => {});
  }
});
function openSettings(focusModel = false) {
  refreshStatus();
  $('#settings-modal').classList.remove('hidden');
  document.body.classList.add('settings-open');
  if (focusModel) setTimeout(() => $('#set-model').focus(), 0);
}
function closeSettings() {
  $('#settings-modal').classList.add('hidden');
  document.body.classList.remove('settings-open');
}

$('#btn-new').addEventListener('click', () => newSession().catch((e) => console.error(e)));
$('#btn-new-brand').addEventListener('click', () => newSession().catch((e) => console.error(e)));
$('#btn-session-add').addEventListener('click', () => newSession().catch((e) => console.error(e)));
$('#btn-settings').addEventListener('click', () => openSettings());
$('#btn-composer-settings').addEventListener('click', () => openSettings());
$('#btn-header-model').addEventListener('click', () => openSettings(true));
$('#composer-model').addEventListener('click', () => openSettings(true));
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

$('#set-model').addEventListener('change', (e) => {
  applySettings({ model: e.target.value }).catch((err) => alert(`切换失败：${err.message}`));
});
$('#set-permission').addEventListener('change', (e) => {
  applySettings({ permission: e.target.value }).catch((err) => alert(`设置失败：${err.message}`));
});
$('#set-effort').addEventListener('change', (e) => {
  applySettings({ reasoningEffort: e.target.value }).catch((err) => alert(`设置失败：${err.message}`));
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

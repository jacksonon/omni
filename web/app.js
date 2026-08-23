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
  planMode: false,
  language: 'zh',       // 界面语言（设置 → 通用 → 语言：zh / en）
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
  runningSessions: new Set(), // 运行中的会话 id 集合（唯一真相源）
  cfgModelName: null,       // 设置 → 模型配置 tab 当前编辑的模型名
  tasks: [],            // 后台任务收件箱（1.0 P1-8）
  messageQueue: [],     // 运行中 Enter 入队的消息（仅当前会话）
  steerText: null,      // 运行中 Cmd+Enter 打断消息（仅当前会话，优先于 queue）
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

/* ---------------- i18n（设置 → 通用 → 语言：中文 / English） ---------------- */
const I18N_ZH = {
  // 侧栏
  'sidebar.new': '新会话',
  'sidebar.section': '工作区',
  'sidebar.search': '搜索会话',
  'sidebar.addWorkspace': '添加工作区（浏览…）',
  'sidebar.inbox': '后台任务',
  'sidebar.settings': '设置',
  'sidebar.collapse': '收起侧栏',
  'sidebar.openNav': '打开导航',
  // header
  'header.sessionActions': '会话操作（分叉/导出/检查点…）',
  'header.details': '打开详情',
  'header.closeDetails': '关闭详情',
  'header.chatTab': '对话',
  'header.traceTab': '轨迹',
  // hero
  'hero.tagline': '探索未至之境',
  'hero.preview': '预览版',
  'hero.workspace': '当前工作区',
  // composer
  'composer.attach': '添加上下文',
  'composer.permission': '权限设置',
  'composer.plan': '计划',
  'composer.settings': '运行设置',
  'composer.model': '切换模型与思考级别',
  'composer.send': '发送消息',
  'composer.stop': '停止当前任务',
  'composer.input': '随心输入',
  'composer.project': '切换项目',
  'composer.location': '工作位置',
  'composer.branch': '切换分支',
  'composer.newChat': '输入消息开始新对话',
  'composer.running': '运行中 · Enter 排队 · ⌘/Ctrl+Enter 打断',
  'composer.runningQueued': '运行中 · ⏳ 排队 {n} 条 · Enter 排队 · ⌘/Ctrl+Enter 打断',
  'composer.queued': '⏳ 排队中（{n}）',
  'composer.chooseSession': '选择或新建会话',
  // 权限
  'perm.full': '完全访问',
  'perm.safe': '帮我批准',
  'perm.ask': '请求批准',
  'perm.read': '只读',
  'perm.head': '应如何批准操作？',
  'perm.more': '了解更多',
  'perm.askDesc': '编辑外部文件和使用互联网时始终询问',
  'perm.safeDesc': '仅对检测到的风险操作请求批准',
  'perm.fullDesc': '可不受限制地访问互联网和你电脑上的任何文件',
  'perm.fullTitle': '完全访问权限',
  // 状态
  'status.ready': '就绪',
  'status.running': '运行中…',
  'status.chooseSession': '选择或新建会话',
  'status.disconnected': '已断开，重连中…',
  'status.failed': '请求失败',
  'status.cantConnect': '无法连接服务器',
  // 审批 / 提问
  'approval.head': '⚠ 需要审批',
  'approval.allow': '允许执行',
  'approval.deny': '拒绝',
  'approval.allowed': '✓ 已允许',
  'approval.denied': '✗ 已拒绝',
  'approval.fromSession': '· 来自会话「{name}」',
  'ask.head': '❓ 向用户提问',
  'ask.cancel': '取消',
  'ask.confirm': '确认',
  'ask.customPlaceholder': '自定义输入（可选）',
  'ask.userChoice': '（用户选择：{choices}）',
  'ask.userCancelled': '（用户取消）',
  // 思考 / 工具
  'thinking.running': '思考中',
  'thinking.done': '思考 · {n} 字符',
  'tool.running': '执行中',
  'tool.failed': '失败',
  'tool.noOutput': '（无输出）',
  'tool.nchars': '{n} 字符',
  'task.pending': '排队中',
  'task.running': '执行中',
  'task.done': '已完成',
  'task.error': '失败',
  // 命令面板 / meta
  'cmd.title': '命令输出',
  'cmd.executed': '命令已执行。',
  'cmd.loading': '执行中…',
  'cmd.failed': '✗ 命令执行失败：{msg}',
  'cmd.none': '命令执行完成（无输出）',
  'send.failed': '✗ 发送失败：{msg}',
  'session.new': '新会话',
  'session.title': '会话',
  'empty.sessions': '暂无会话',
  // 设置面板（tab 与字段）
  'settings.general': '通用',
  'settings.theme': '主题',
  'settings.model': '模型',
  'settings.workspace': '工作区',
  'settings.apikey': '模型配置',
  'settings.about': '关于',
  'settings.generalSub': '会话运行的基础行为。',
  'settings.themeSub': '界面配色方案，选择后立即生效并保存。',
  'settings.modelSub': '切换对话使用的模型与思考深度。',
  'settings.workspaceSub': '智能体读写文件、执行命令所用的根目录。',
  'settings.apikeySub': '配置所选模型的端点、密钥、推理级别与上下文长度——与 omni.json 的 models 字段一致，保存后写入全局配置文件。',
  'settings.aboutSub': '',
  'settings.permission': '权限级别',
  'settings.permissionDesc': '控制执行命令前的确认策略：safe 在危险操作前询问，ask 全部询问，read 仅只读。',
  'settings.permSafe': 'safe · 危险操作询问',
  'settings.permFull': 'full · 全量直通',
  'settings.permAsk': 'ask · 全部询问',
  'settings.permRead': 'read · 只读',
  'settings.plan': '计划模式',
  'settings.planDesc': '只调研并输出实施计划，不直接修改文件。',
  'settings.lang': '语言',
  'settings.langDesc': '界面显示语言，保存后立即生效。',
  'settings.themeName': '界面主题',
  'settings.themeDesc': '亮色 / 暗色 / 跟随系统（跟随系统时随操作系统深浅色自动切换）。',
  'settings.themeLight': '亮色',
  'settings.themeDark': '暗色',
  'settings.themeSystem': '跟随系统',
  'settings.modelName': '模型',
  'settings.modelDesc': '切换对话使用的模型与思考深度。',
  'settings.cwd': '当前目录',
  'settings.browse': '切换…',
  'settings.cfgModel': '配置的模型',
  'settings.cfgModelDesc': '选择要编辑的模型，切换后下方字段同步为该模型的配置。',
  'settings.baseURL': '端点（baseURL）',
  'settings.baseURLDesc': 'OpenAI 兼容 API 地址，如 https://api.deepseek.com/v1。',
  'settings.apiKey': 'API Key',
  'settings.apiKeyDesc': '留空表示沿用配置文件中已保存的密钥。',
  'settings.save': '保存',
  'settings.saved': '✓ 已保存到配置文件',
  'settings.variants': '思考级别选项（variants）',
  'settings.variantsDesc': '逗号分隔，如 low,medium,high；模型只支持这些级别。',
  'settings.effortCurrent': '当前思考级别',
  'settings.effortCurrentDesc': '默认使用哪一个级别。',
  'settings.context': '上下文长度（context）',
  'settings.contextDesc': '模型的上下文窗口大小（token 数），如 128000。',
  'settings.version': '版本',
  'settings.server': '服务地址',
  'settings.tools': '可用工具',
  // 模态框
  'modal.rewindTitle': '会话检查点（/rewind）',
  'modal.inboxTitle': '后台任务收件箱',
  'modal.inboxPlaceholder': '长任务描述，空闲容量时自动在独立会话执行…',
  'modal.enqueue': '入队',
  'modal.dirTitle': '选择工作目录',
  'modal.up': '上级',
  'modal.cancel': '取消',
  'modal.select': '选择此目录',
  'modal.close': '关闭',
};
const I18N_EN = {
  'sidebar.new': 'New chat',
  'sidebar.section': 'Workspaces',
  'sidebar.search': 'Search sessions',
  'sidebar.addWorkspace': 'Add workspace',
  'sidebar.inbox': 'Tasks',
  'sidebar.settings': 'Settings',
  'sidebar.collapse': 'Collapse sidebar',
  'sidebar.openNav': 'Open navigation',
  'header.sessionActions': 'Session actions (fork/export/checkpoints…)',
  'header.details': 'Open details',
  'header.closeDetails': 'Close details',
  'header.chatTab': 'Chat',
  'header.traceTab': 'Trajectory',
  'hero.tagline': 'Explore the unknown',
  'hero.preview': 'Preview',
  'hero.workspace': 'Current workspace',
  'composer.attach': 'Add context',
  'composer.permission': 'Permissions',
  'composer.plan': 'Plan',
  'composer.settings': 'Run settings',
  'composer.model': 'Switch model & reasoning',
  'composer.send': 'Send message',
  'composer.stop': 'Stop current task',
  'composer.input': 'Type a message',
  'composer.project': 'Switch project',
  'composer.location': 'Working location',
  'composer.branch': 'Switch branch',
  'composer.newChat': 'Type a message to start a new chat',
  'composer.running': 'Running · Enter to queue · ⌘/Ctrl+Enter to steer',
  'composer.runningQueued': 'Running · ⏳ {n} queued · Enter to queue · ⌘/Ctrl+Enter to steer',
  'composer.queued': '⏳ Queued ({n})',
  'composer.chooseSession': 'Select or create a session',
  'perm.full': 'Full access',
  'perm.safe': 'Auto-approve',
  'perm.ask': 'Ask to approve',
  'perm.read': 'Read only',
  'perm.head': 'How should we approve actions?',
  'perm.more': 'Learn more',
  'perm.askDesc': 'Always ask when editing external files and using the internet',
  'perm.safeDesc': 'Ask only for detected risky actions',
  'perm.fullDesc': 'Unrestricted access to the internet and any file on your computer',
  'perm.fullTitle': 'Full access',
  'status.ready': 'Ready',
  'status.running': 'Running…',
  'status.chooseSession': 'Select or create a session',
  'status.disconnected': 'Disconnected, reconnecting…',
  'status.failed': 'Request failed',
  'status.cantConnect': 'Cannot connect to server',
  'approval.head': '⚠ Approval required',
  'approval.allow': 'Allow',
  'approval.deny': 'Deny',
  'approval.allowed': '✓ Allowed',
  'approval.denied': '✗ Denied',
  'approval.fromSession': '· from session "{name}"',
  'ask.head': '❓ Ask the user',
  'ask.cancel': 'Cancel',
  'ask.confirm': 'Confirm',
  'ask.customPlaceholder': 'Custom input (optional)',
  'ask.userChoice': '(User chose: {choices})',
  'ask.userCancelled': '(User cancelled)',
  'thinking.running': 'Thinking',
  'thinking.done': 'Thinking · {n} chars',
  'tool.running': 'Running',
  'tool.failed': 'Failed',
  'tool.noOutput': '(no output)',
  'tool.nchars': '{n} chars',
  'task.pending': 'Queued',
  'task.running': 'Running',
  'task.done': 'Done',
  'task.error': 'Failed',
  'cmd.title': 'Command output',
  'cmd.executed': 'Command executed.',
  'cmd.loading': 'Running…',
  'cmd.failed': '✗ Command failed: {msg}',
  'cmd.none': 'Command executed (no output)',
  'send.failed': '✗ Send failed: {msg}',
  'session.new': 'New chat',
  'session.title': 'Session',
  'empty.sessions': 'No sessions',
  'settings.general': 'General',
  'settings.theme': 'Theme',
  'settings.model': 'Model',
  'settings.workspace': 'Workspace',
  'settings.apikey': 'Model config',
  'settings.about': 'About',
  'settings.generalSub': 'Base behavior for session runs.',
  'settings.themeSub': 'Color scheme. Applies immediately and is saved.',
  'settings.modelSub': 'Switch the model and reasoning depth.',
  'settings.workspaceSub': 'Root directory the agent reads/writes files and runs commands in.',
  'settings.apikeySub': 'Configure endpoint, key, reasoning levels and context length for the selected model — same fields as models in omni.json, saved to the global config file.',
  'settings.permission': 'Permission level',
  'settings.permissionDesc': 'Confirmation policy before running commands: safe asks on risky ops, ask asks always, read is read-only.',
  'settings.permSafe': 'safe · ask on risky',
  'settings.permFull': 'full · allow all',
  'settings.permAsk': 'ask · ask always',
  'settings.permRead': 'read · read-only',
  'settings.plan': 'Plan mode',
  'settings.planDesc': 'Research and output a plan only, without modifying files.',
  'settings.lang': 'Language',
  'settings.langDesc': 'UI language. Applies immediately.',
  'settings.themeName': 'UI theme',
  'settings.themeDesc': 'Light / Dark / System (system follows the OS color scheme).',
  'settings.themeLight': 'Light',
  'settings.themeDark': 'Dark',
  'settings.themeSystem': 'System',
  'settings.modelName': 'Model',
  'settings.modelDesc': 'Switch the model and reasoning depth.',
  'settings.cwd': 'Current directory',
  'settings.browse': 'Browse…',
  'settings.cfgModel': 'Model to configure',
  'settings.cfgModelDesc': 'Select the model to edit; fields below follow its config.',
  'settings.baseURL': 'Endpoint (baseURL)',
  'settings.baseURLDesc': 'OpenAI-compatible API base URL, e.g. https://api.deepseek.com/v1.',
  'settings.apiKey': 'API Key',
  'settings.apiKeyDesc': 'Leave empty to keep the key already saved in the config file.',
  'settings.save': 'Save',
  'settings.saved': '✓ Saved to config file',
  'settings.variants': 'Reasoning levels (variants)',
  'settings.variantsDesc': 'Comma-separated, e.g. low,medium,high; the model only supports these.',
  'settings.effortCurrent': 'Current level',
  'settings.effortCurrentDesc': 'Which level to use by default.',
  'settings.context': 'Context length',
  'settings.contextDesc': 'Model context window size (tokens), e.g. 128000.',
  'settings.version': 'Version',
  'settings.server': 'Server',
  'settings.tools': 'Available tools',
  'modal.rewindTitle': 'Session checkpoints (/rewind)',
  'modal.inboxTitle': 'Background tasks',
  'modal.inboxPlaceholder': 'Describe a long task; it runs in a separate session when capacity is free…',
  'modal.enqueue': 'Enqueue',
  'modal.dirTitle': 'Choose workspace',
  'modal.up': 'Up',
  'modal.cancel': 'Cancel',
  'modal.select': 'Select this folder',
  'modal.close': 'Close',
};
function t(key, vars) {
  const lang = state.language === 'en' ? I18N_EN : I18N_ZH;
  let s = lang[key] || I18N_ZH[key] || key;
  if (vars) for (const k of Object.keys(vars)) s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(vars[k]));
  return s;
}
/** 应用语言：<html lang> + 静态 data-i18n 文案 + 动态文案重渲染（状态/composer/详情等） */
function applyLanguage(lang) {
  state.language = lang === 'en' ? 'en' : 'zh';
  document.documentElement.lang = state.language === 'en' ? 'en' : 'zh-CN';
  document.querySelectorAll('[data-i18n]').forEach((n) => { n.textContent = t(n.dataset.i18n); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((n) => { n.placeholder = t(n.dataset.i18nPlaceholder); });
  document.querySelectorAll('[data-i18n-title]').forEach((n) => { n.title = t(n.dataset.i18nTitle); });
  updateStatusText();
  updateComposer();
  updateDetails();
  renderPermissionPop();
  renderThemeOptions(state.status?.webTheme || getStoredTheme() || 'system');
  const lg = $('#set-language');
  if (lg) lg.value = state.language;
  return state.language;
}

function setEmptyState(empty) {
  $('#app').classList.toggle('empty-session', empty);
  $('#input').placeholder = t('composer.input');
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
  const head = el('div', 'th-head', t('thinking.running'));
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
    if (!b._chars) { wrap.remove(); return; } // 本轮无实际思考：移除预建空模块，不显示「思考 · 0 字符」
    head.textContent = t('thinking.done', { n: b._chars });
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
  st.innerHTML = `<span class="spin">${SPIN[0]}</span>${esc(data.argsPreview || t('tool.running'))}`;
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
    st.textContent = ok ? t('tool.nchars', { n: r.chars }) : t('tool.failed');
    // 只显示结果预览前几行（与 TUI 一致）；完整结果已回传模型
    const lines = (r.preview || []).slice(0, 12).join('\n');
    const out = (r.preview && r.preview.length ? lines : ok ? t('tool.noOutput') : r.error || t('tool.noOutput'));
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
function sessionLabel(sid) {
  const s = state.sessions.find((x) => x.id === sid);
  if (s?.title) return s.title;
  if (s?.project) return s.project.split('/').filter(Boolean).pop() || s.project;
  return String(sid || '').slice(0, 8) || '未知会话';
}
function interactionCard(ev) {
  const b = makeBlock(ev.type, ev.sessionId);
  b.sid = ev.sessionId; b.id = ev.id;
  const card = el('div', `interaction-card ${ev.type}`);
  const head = el('div', 'ic-head');
  const isOther = ev.sessionId && ev.sessionId !== state.session;
  head.textContent = ev.type === 'approval' ? t('approval.head') : t('ask.head');
  if (isOther) {
    head.appendChild(el('span', 'ic-session', t('approval.fromSession', { name: sessionLabel(ev.sessionId) })));
  }
  const body = el('div', 'ic-body');

  if (ev.type === 'approval') {
    body.appendChild(el('div', 'ic-question', ev.reason));
    const meta = el('div', 'ic-meta', ev.summary);
    meta.title = '该操作需要你的确认';
    body.appendChild(meta);
    const acts = el('div', 'ic-actions');
    const allow = el('button', 'primary', t('approval.allow'));
    const deny = el('button', 'danger', t('approval.deny'));
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
    inp.placeholder = t('ask.customPlaceholder');
    custom.appendChild(inp);
    const acts = el('div', 'ic-actions ask-actions');
    const cancel = el('button', '', t('ask.cancel'));
    const submit = el('button', 'primary', t('ask.confirm'));
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
    list.appendChild(el('div', 'empty', t('empty.sessions')));
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
      if (state.runningSessions.has(s.id)) item.appendChild(el('span', 'session-running-dot', ''));
      const d = new Date(s.updated || s.created);
      const ts = `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      item.appendChild(el('span', 'session-icon', s.id === state.session ? '●' : '○'));
      const copy = el('div', 'session-copy');
      copy.appendChild(el('div', 'stitle', s.title || t('session.new')));
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

/* —— 会话动作菜单（chat-title 点击 / ⋯ 共用）+ 分叉 / 检查点 / 收件箱 —— */
function showChatActions(e) {
  closeSessionActions();
  if (!state.session) return;
  const sid = state.session;
  const menu = el('div', 'ctx-menu');
  const mk = (label, fn) => {
    const b = el('button', 'ctx-item', label);
    b.type = 'button';
    b.addEventListener('click', () => { closeSessionActions(); fn(sid); });
    return b;
  };
  const ren = mk('重命名', async (id) => {
    const t = prompt('会话标题', $('#chat-title').textContent || '');
    if (!t || !t.trim()) return;
    await api(`/api/sessions/${id}/rename`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: t.trim() }) });
    $('#chat-title').textContent = t.trim();
    refreshSessions().catch(() => {});
  });
  const forkB = mk('分叉新会话（/fork）', (id) => openForkDialog({ id }));
  const exp = mk('导出 Markdown（/export）', (id) => window.open(`/api/sessions/${id}/export`, '_blank'));
  const rw = mk('会话检查点（/rewind）', (id) => openRewindModal(id));
  const del = mk('删除会话', async (id) => {
    if (!confirm('删除该会话？此操作不可恢复。')) return;
    await api(`/api/sessions/${id}/delete`, { method: 'DELETE' }).catch((err) => alert(`删除失败：${err.message}`));
  });
  menu.append(ren, forkB, exp, rw, del);
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(e.clientX, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(e.clientY, window.innerHeight - rect.height - 8)}px`;
  setTimeout(() => {
    document.addEventListener('click', closeSessionActions, true);
    document.addEventListener('keydown', escSessionActions, true);
  }, 0);
}

/** /fork 对话框：输入保留前 N 条消息 */
function openForkDialog(s) {
  api(`/api/sessions/${s.id}/messages`).then((data) => {
    const maxN = data.messages.length;
    const raw = prompt(`分叉新会话：保留前 N 条消息（1..${maxN}，原会话保留）`, String(Math.max(1, Math.min(maxN, 4))));
    if (raw === null) return;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > maxN) { alert(`N 须为 1..${maxN} 的整数`); return; }
    api(`/api/sessions/${s.id}/fork`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ n }),
    })
      .then(() => refreshSessions())
      .catch((err) => alert(`fork 失败：${err.message}`));
  }).catch(() => {});
}

/** /rewind 面板：列出检查点（附与当前工作区差异），一键回滚 */
async function openRewindModal(sessionId) {
  $('#rewind-modal').classList.remove('hidden');
  const list = $('#rewind-list');
  list.innerHTML = '<div class="dir-empty">加载检查点…</div>';
  try {
    const cps = await api(`/api/sessions/${sessionId}/checkpoints`);
    list.innerHTML = '';
    if (!cps.length) {
      list.innerHTML = '<div class="dir-empty">暂无检查点——对话轮次会自动打点（每轮用户消息提交时快照工作区修改文件）</div>';
      return;
    }
    [...cps].reverse().forEach((c) => {
      const row = el('div', 'rewind-row');
      const main = el('div', 'rewind-main');
      main.appendChild(el('div', 'rewind-msg', `#${c.index} · ${c.userMessage || '（无文本）'}`));
      const d = c.diff || { add: 0, rem: 0 };
      const diffTxt = d.add + d.rem > 0 ? `与当前差 Δ${d.add + d.rem} 行（+${d.add} −${d.rem}）` : '与当前一致';
      main.appendChild(el('div', 'rewind-meta', `${new Date(c.time).toLocaleString()} · ${c.files} 个文件 · ${diffTxt}`));
      row.appendChild(main);
      const btn = el('button', 'primary', '回滚到此处');
      btn.type = 'button';
      btn.addEventListener('click', async () => {
        if (!confirm(`回滚工作区文件到检查点 #${c.index}？（对话历史保留）`)) return;
        try {
          await api(`/api/sessions/${sessionId}/rewind`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ index: c.index }),
          });
          $('#rewind-modal').classList.add('hidden');
          metaLine(state.session, [`已回滚到检查点 #${c.index}（${c.files} 个文件处理）`]);
        } catch (err) { alert(`回滚失败：${err.message}`); }
      });
      row.appendChild(btn);
      list.appendChild(row);
    });
  } catch (err) {
    list.innerHTML = `<div class="dir-empty">加载失败：${esc(err.message)}</div>`;
  }
}
$('#btn-close-rewind').addEventListener('click', () => $('#rewind-modal').classList.add('hidden'));
$('#rewind-modal').addEventListener('click', (e) => { if (e.target === $('#rewind-modal')) $('#rewind-modal').classList.add('hidden'); });

/* ---------------- 后台任务收件箱 UI（1.0 P1-8）---------------- */
async function openInboxModal() {
  $('#inbox-modal').classList.remove('hidden');
  try { state.tasks = await api('/api/tasks'); } catch { /* ignore */ }
  updateInboxBadge();
  renderTaskList();
}
function renderTaskList() {
  const list = $('#task-list');
  list.innerHTML = '';
  if (!state.tasks.length) {
    list.appendChild(el('div', 'dir-empty', '暂无后台任务——长任务入队后在空闲容量时自动执行'));
    return;
  }
  for (const t of state.tasks) {
    const row = el('div', 'task-row');
    const main = el('div', 'task-main');
    main.appendChild(el('div', 'task-prompt', t.prompt));
    const metaBits = [new Date(t.created).toLocaleString()];
    if (t.error) metaBits.push(t.error);
    main.appendChild(el('div', 'task-meta', metaBits.join(' · ')));
    row.appendChild(main);
    row.appendChild(el('span', 'task-state ' + t.status, t.status === 'pending' ? t('task.pending') : t.status === 'running' ? t('task.running') : t.status === 'done' ? t('task.done') : t('task.error')));
    if (t.sessionId) {
      const open = el('button', '', '打开会话');
      open.type = 'button';
      open.addEventListener('click', () => {
        $('#inbox-modal').classList.add('hidden');
        selectSession(t.sessionId).catch(() => {});
      });
      row.appendChild(open);
    }
    if (t.status === 'pending') {
      const del = el('button', '', '移除');
      del.type = 'button';
      del.addEventListener('click', () => {
        api(`/api/tasks/${t.id}`, { method: 'DELETE' })
          .then(() => { state.tasks = state.tasks.filter((x) => x.id !== t.id); updateInboxBadge(); renderTaskList(); })
          .catch((err) => alert(err.message));
      });
      row.appendChild(del);
    }
    list.appendChild(row);
  }
}
$('#btn-inbox').addEventListener('click', () => openInboxModal().catch(() => {}));
$('#btn-close-inbox').addEventListener('click', () => $('#inbox-modal').classList.add('hidden'));
$('#inbox-modal').addEventListener('click', (e) => { if (e.target === $('#inbox-modal')) $('#inbox-modal').classList.add('hidden'); });
$('#btn-task-add').addEventListener('click', () => {
  const inp = $('#task-input');
  const v = inp.value.trim();
  if (!v) return;
  inp.value = '';
  api('/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: v }) })
    .then((t) => { upsertTask(t); })
    .catch((err) => alert(`入队失败：${err.message}`));
});

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
          clearPendingMessages();
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
          clearPendingMessages();
          clearMessages();
          renderWelcome();
          updateComposer();
          updateStatusText();
        }
        renderSessionList();
      })
      .catch((err) => alert(`删除失败：${err.message}`));
  });
  if (s.project === (state.status?.cwd || '')) {
    const forkB = el('button', 'ctx-item', '分叉新会话（/fork）');
    forkB.type = 'button';
    forkB.addEventListener('click', () => { closeSessionActions(); openForkDialog(s); });
    const exp = el('button', 'ctx-item', '导出 Markdown（/export）');
    exp.type = 'button';
    exp.addEventListener('click', () => { closeSessionActions(); window.open(`/api/sessions/${s.id}/export`, '_blank'); });
    const rw = el('button', 'ctx-item', '会话检查点（/rewind）');
    rw.type = 'button';
    rw.addEventListener('click', () => { closeSessionActions(); openRewindModal(s.id); });
    menu.append(forkB, exp, rw);
  }
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

/** 清空当前会话的待发送队列（切换会话 / 新建 / 删除时调用，避免消息错发到别的会话） */
function clearPendingMessages() {
  state.messageQueue = [];
  state.steerText = null;
  updateComposer();
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
  updateComposerContext();
}

function updateComposerContext() {
  const st = state.status || {};
  const cwd = st.cwd || '';
  const proj = cwd ? (cwd.split('/').filter(Boolean).pop() || cwd) : '—';
  const pj = $('#ctx-project-label');
  if (pj) pj.textContent = proj;
  const br = st.gitBranch || st.branch || '';
  const bl = $('#ctx-branch-label');
  if (bl) bl.textContent = br || '—';
  const perm = st.permission || 'safe';
  const map = { full: t('perm.full'), safe: t('perm.safe'), ask: t('perm.ask'), read: t('perm.read') };
  const pl = $('#perm-label');
  if (pl) pl.textContent = map[perm] || perm;
  const pill = $('#btn-permission');
  if (pill) pill.className = 'perm-pill' + (perm === 'full' ? ' full' : perm === 'ask' ? ' ask' : perm === 'read' ? ' ask' : '');
}

/* —— 权限 / 添加 / 上下文 pop 渲染 —— */
function closeAllComposerPops() {
  ['#permission-pop', '#add-menu', '#model-pop', '#project-pop', '#location-pop', '#branch-pop'].forEach((sel) => {
    const n = $(sel);
    if (n) n.classList.add('hidden');
  });
}
function togglePop(sel) {
  const n = $(sel);
  if (!n) return;
  const wasHidden = n.classList.contains('hidden');
  closeAllComposerPops();
  if (wasHidden) n.classList.remove('hidden');
}
function renderPermissionPop() {
  const st = state.status || {};
  const perm = st.permission || 'safe';
  const pop = $('#permission-pop');
  if (!pop) return;
  pop.innerHTML = '';
  const head = el('div', 'pp-head');
  head.appendChild(el('span', '', t('perm.head')));
  const more = el('a', '', t('perm.more'));
  more.href = 'javascript:void(0)';
  more.addEventListener('click', (e) => { e.preventDefault(); closeAllComposerPops(); openSettings(); });
  head.appendChild(more);
  pop.appendChild(head);
  const list = el('div', 'pp-list');
  const items = [
    { v: 'ask', title: t('perm.ask'), desc: t('perm.askDesc'), icon: 'i-shield' },
    { v: 'safe', title: t('perm.safe'), desc: t('perm.safeDesc'), icon: 'i-shield' },
    { v: 'full', title: t('perm.fullTitle'), desc: t('perm.fullDesc'), icon: 'i-shield' },
  ];
  items.forEach((it) => {
    const btn = el('button', 'pp-item' + (perm === it.v ? ' active' : ''));
    btn.type = 'button';
    const ic = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ic.setAttribute('class', 'pp-icon');
    const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    u.setAttribute('href', `#${it.icon}`);
    ic.appendChild(u);
    btn.appendChild(ic);
    const main = el('div', 'pp-main');
    main.appendChild(el('div', 'pp-title', it.title));
    main.appendChild(el('div', 'pp-desc', it.desc));
    btn.appendChild(main);
    if (perm === it.v) {
      const ck = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      ck.setAttribute('class', 'pp-check');
      const cu = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      cu.setAttribute('href', '#i-check');
      ck.appendChild(cu);
      btn.appendChild(ck);
    }
    btn.addEventListener('click', () => {
      applySettings({ permission: it.v }).catch((err) => alert(`设置失败：${err.message}`));
      closeAllComposerPops();
    });
    list.appendChild(btn);
  });
  pop.appendChild(list);
}
function renderAddMenu() {
  const pop = $('#add-menu');
  if (!pop) return;
  pop.innerHTML = '';
  const searchRow = el('div', 'am-search');
  const sIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const sUse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  sUse.setAttribute('href', '#i-search');
  sIcon.appendChild(sUse);
  searchRow.appendChild(sIcon);
  const inp = document.createElement('input');
  inp.placeholder = '搜索文件和文件夹…';
  inp.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAllComposerPops(); });
  inp.addEventListener('input', () => {
    const q = inp.value.trim().toLowerCase();
    pop.querySelectorAll('.am-item').forEach((row) => {
      const t = row.textContent?.toLowerCase() || '';
      row.style.display = !q || t.includes(q) ? '' : 'none';
    });
  });
  searchRow.appendChild(inp);
  const fIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const fUse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  fUse.setAttribute('href', '#i-folder');
  fIcon.appendChild(fUse);
  // placeholder icon before input? already sIcon is search; keep.
  pop.appendChild(searchRow);
  pop.appendChild(el('div', 'am-section', '添加'));
  const mkItem = (icon, title, desc, onClick, active) => {
    const b = el('button', 'am-item' + (active ? ' active' : ''));
    b.type = 'button';
    const ic = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    u.setAttribute('href', `#${icon}`);
    ic.appendChild(u);
    b.appendChild(ic);
    const main = el('div', 'am-main');
    main.appendChild(el('div', 'am-title', title));
    if (desc) main.appendChild(el('div', 'am-desc', desc));
    b.appendChild(main);
    if (active) {
      const ck = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      ck.setAttribute('class', 'am-check');
      const cu = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      cu.setAttribute('href', '#i-check');
      ck.appendChild(cu);
      b.appendChild(ck);
    }
    if (onClick) b.addEventListener('click', onClick);
    return b;
  };
  pop.appendChild(mkItem('i-folder', '在项目中使用 Work', '为新聊天选择项目', () => { closeAllComposerPops(); browseWorkspace(); }));
  pop.appendChild(mkItem('i-target', '目标', '自动推导验收标准并循环执行直至达标（/goal）', () => {
    closeAllComposerPops();
    const t = prompt('输入目标');
    if (t && t.trim()) runSlashCommand('/goal ' + t.trim());
  }));
  const planActive = !!state.planMode;
  pop.appendChild(mkItem('i-spark', '计划模式', planActive ? '已开启' : '开启计划模式', () => {
    applySettings({ planMode: !planActive }).then(() => renderAddMenu()).catch((e) => alert(e.message));
  }, planActive));
  pop.appendChild(mkItem('i-check', '录制技能', '', () => {
    closeAllComposerPops();
    const name = prompt('技能名（小写字母+连字符，如 my-skill）');
    if (!name || !name.trim()) return;
    const desc = prompt('技能描述（可选）') || '';
    api('/api/skills/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), description: desc.trim() }),
    })
      .then((data) => alert(`技能「${data.name}」已创建于 ${data.path}`))
      .catch((e) => alert(`创建技能失败：${e.message}`));
  }));
  const tip = el('div', 'am-section', '提示：输入 @ 提及文件');
  tip.style.textTransform = 'none';
  tip.style.fontWeight = '400';
  pop.appendChild(tip);
}
function renderProjectPop() {
  const pop = $('#project-pop');
  if (!pop) return;
  pop.innerHTML = '';
  const srow = el('div', 'pop-search');
  const ic = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  u.setAttribute('href', '#i-search');
  ic.appendChild(u);
  srow.appendChild(ic);
  const inp = document.createElement('input');
  inp.placeholder = '搜索项目';
  srow.appendChild(inp);
  pop.appendChild(srow);
  const list = el('div', 'pop-list');
  const cwd = state.status?.cwd || '';
  const workspaces = (state.status?.workspaces || []).length ? state.status.workspaces : [cwd].filter(Boolean);
  // 也加入最近会话的 project 去重
  const extra = [...new Set(state.sessions.map((s) => s.project).filter(Boolean))];
  const all = [...new Set([...workspaces, ...extra])];
  all.forEach((p) => {
    const active = p === cwd;
    const b = el('button', 'pop-item' + (active ? ' active' : ''));
    b.type = 'button';
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'pi-icon');
    const iu = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    iu.setAttribute('href', '#i-folder');
    icon.appendChild(iu);
    b.appendChild(icon);
    b.appendChild(el('span', 'pi-main', p.split('/').filter(Boolean).pop() || p));
    if (active) {
      const ck = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      ck.setAttribute('class', 'pi-check');
      const cu = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      cu.setAttribute('href', '#i-check');
      ck.appendChild(cu);
      b.appendChild(ck);
    }
    b.addEventListener('click', () => {
      closeAllComposerPops();
      if (!active) {
        switchWorkspace(p)
          .then(() => metaLine('', [`✓ 已切换到工作区「${projectName(p)}」`]))
          .catch((e) => alert(e.message));
      }
    });
    list.appendChild(b);
  });
  const more = el('button', 'pop-item');
  more.type = 'button';
  more.innerHTML = '<span class="pi-main">＋ 新建项目</span>';
  more.addEventListener('click', () => { closeAllComposerPops(); browseWorkspace(); });
  list.appendChild(more);
  const none = el('button', 'pop-item');
  none.type = 'button';
  none.innerHTML = '<span class="pi-main">× 不在项目中工作</span>';
  none.addEventListener('click', () => closeAllComposerPops());
  list.appendChild(none);
  pop.appendChild(list);
  inp.addEventListener('input', () => {
    const q = inp.value.trim().toLowerCase();
    list.querySelectorAll('.pop-item').forEach((row) => {
      const t = row.textContent?.toLowerCase() || '';
      row.style.display = !q || t.includes(q) ? '' : 'none';
    });
  });
}
function renderLocationPop() {
  const pop = $('#location-pop');
  if (!pop) return;
  pop.innerHTML = '';
  const head = el('div', 'pop-section', '工作位置');
  pop.appendChild(head);
  const list = el('div', 'pop-list');
  const mk = (icon, title, active, onClick, extra) => {
    const b = el('button', 'pop-item' + (active ? ' active' : ''));
    b.type = 'button';
    const ic = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ic.setAttribute('class', 'pi-icon');
    const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    u.setAttribute('href', `#${icon}`);
    ic.appendChild(u);
    b.appendChild(ic);
    b.appendChild(el('span', 'pi-main', title));
    if (extra) {
      const e = el('span', 'pi-sub', extra);
      e.style.marginLeft = 'auto';
      b.appendChild(e);
    }
    if (active) {
      const ck = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      ck.setAttribute('class', 'pi-check');
      const cu = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      cu.setAttribute('href', '#i-check');
      ck.appendChild(cu);
      b.appendChild(ck);
    }
    if (onClick) b.addEventListener('click', onClick);
    return b;
  };
  const cwdName = (state.status?.cwd || '').split('/').filter(Boolean).pop() || '/';
  list.appendChild(mk('i-laptop', '本地', true, () => closeAllComposerPops(), cwdName));
  list.appendChild(mk('i-branch', '新建本地工作树', false, () => {
    closeAllComposerPops();
    const branch = prompt('输入新分支名（将在父目录创建 worktree）');
    if (!branch || !branch.trim()) return;
    api('/api/git/worktree', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branch: branch.trim() }),
    })
      .then(() => {
        metaLine('', [`✓ 已创建 worktree「${branch.trim()}」并切换`]);
        refreshStatus().then(() => { state.sessions = []; renderSessionList(); }).catch(() => {});
      })
      .catch((e) => alert(`创建工作树失败：${e.message}`));
  }));
  pop.appendChild(list);
}
function renderBranchPop() {
  const pop = $('#branch-pop');
  if (!pop) return;
  pop.innerHTML = '';
  const st = state.status || {};
  const cur = st.gitBranch || st.branch || 'main';
  const dirty = st.gitDirty || 0;
  const head = el('div', 'pop-search');
  const ic = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  u.setAttribute('href', '#i-search');
  ic.appendChild(u);
  head.appendChild(ic);
  const inp = document.createElement('input');
  const cwdName = (st.cwd || '').split('/').filter(Boolean).pop() || '项目';
  inp.placeholder = `搜索 ${cwdName} 分支`;
  head.appendChild(inp);
  pop.appendChild(head);
  const sec = el('div', 'pop-section', '分支');
  pop.appendChild(sec);
  const list = el('div', 'pop-list');
  const branches = st.gitBranches && Array.isArray(st.gitBranches) && st.gitBranches.length ? st.gitBranches : [cur, 'master', 'develop'].filter(Boolean);
  const uniq = [...new Set(branches)];
  uniq.forEach((b) => {
    const active = b === cur;
    const row = el('button', 'pop-item' + (active ? ' active' : ''));
    row.type = 'button';
    const ic2 = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ic2.setAttribute('class', 'pi-icon');
    const u2 = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    u2.setAttribute('href', '#i-branch');
    ic2.appendChild(u2);
    row.appendChild(ic2);
    const main = el('div', 'pi-main');
    main.textContent = b;
    if (active && dirty) {
      const sub = el('span', 'pi-sub', `未提交：${dirty} 个文件`);
      sub.style.display = 'block';
      sub.style.fontSize = '11px';
      const wrap = el('div', '');
      wrap.appendChild(main);
      wrap.appendChild(sub);
      wrap.style.flex = '1';
      row.appendChild(wrap);
    } else {
      row.appendChild(main);
    }
    if (active) {
      const ck = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      ck.setAttribute('class', 'pi-check');
      const cu = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      cu.setAttribute('href', '#i-check');
      ck.appendChild(cu);
      row.appendChild(ck);
    }
    row.addEventListener('click', () => {
      closeAllComposerPops();
      if (!active) {
        api('/api/git/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ branch: b }) })
          .then(() => {
            metaLine('', [`✓ 已切换到分支「${b}」`]);
            refreshStatus().catch(()=>{});
          })
          .catch((e) => alert(`切换分支失败：${e.message}`));
      }
    });
    list.appendChild(row);
  });
  pop.appendChild(list);
  const foot = el('div', 'pop-divider');
  pop.appendChild(foot);
  const add = el('button', 'pop-item');
  add.type = 'button';
  add.innerHTML = '<span class="pi-main">＋ 创建并检出新分支…</span>';
  add.addEventListener('click', () => {
    const nb = prompt('新分支名');
    if (!nb) return;
    api('/api/git/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ branch: nb, create: true }) })
      .then(() => {
        closeAllComposerPops();
        metaLine('', [`✓ 已创建并切换到分支「${nb}」`]);
        refreshStatus().catch(()=>{});
      })
      .catch((e) => alert(`创建分支失败：${e.message}`));
  });
  pop.appendChild(add);
  inp.addEventListener('input', () => {
    const q = inp.value.trim().toLowerCase();
    list.querySelectorAll('.pop-item').forEach((r) => {
      const t = r.textContent?.toLowerCase() || '';
      r.style.display = !q || t.includes(q) ? '' : 'none';
    });
  });
}

const TRACE_ICONS = {
  user: '→', thinking: '💭', tool: '⚙', answer: '✓', turn: '◆', usage: '⚡',
  'thinking-end': '', lap: '⏱',
};
const TRACE_LABELS = {
  user: '用户', thinking: '思考', tool: '工具', answer: '回答', turn: '轮次', usage: '用量',
  'thinking-end': '', lap: '计时',
};
function renderTrajectory() {
  const view = $('#trajectory-view');
  view.innerHTML = '';
  if (!state.trace.length) {
    view.appendChild(el('div', 'empty', '当前会话还没有运行轨迹——发送消息后这里会记录每一步运行过程'));
    return;
  }
  state.trace.forEach((row) => {
    if (row.kind === 'thinking-end') return; // 分隔标记不显示
    const line = el('div', 'trace-row trace-' + row.kind);
    line.dataset.kind = row.kind;
    const icon = TRACE_ICONS[row.kind] || '·';
    const label = TRACE_LABELS[row.kind] || row.kind;
    let text = '';
    if (row.kind === 'tool') text = `${row.name || 'tool'}  ${row.args || ''}`;
    else if (row.kind === 'usage') text = `⚡ 输入 ${row.prompt || 0} · 输出 ${row.completion || 0}${row.cached ? ' · 缓存 ' + row.cached : ''}`;
    else text = (row.text || '').slice(0, 200);
    line.appendChild(el('span', 'trace-kind', `${icon} ${label}`));
    line.appendChild(el('span', 'trace-text', text));
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
  clearPendingMessages(); // 待发送消息属于上一个会话，切换后清空避免错发
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
  clearPendingMessages();
  clearMessages();
  $('#chat-title').textContent = t('session.new');
  renderSessionList();
  renderWelcome();
  updateComposer();
  updateStatusText();
  $('#app').classList.remove('sidebar-open');
}

/* ---------------- 服务器状态 / 设置 ---------------- */
let statusTimer = null;

function sessionRunning() {
  return !!(state.session && state.runningSessions.has(state.session));
}
function anyRunning() {
  return state.runningSessions.size > 0;
}
function updateStatusText() {
  const dot = $('#status-dot');
  const txt = $('#status-text');
  const sidebarDot = $('#sidebar-status-dot');
  const hasRunning = anyRunning();
  [dot, sidebarDot].forEach((n) => {
    n.classList.toggle('running', hasRunning);
    n.classList.toggle('ready', !hasRunning && !!state.status);
    n.classList.remove('error');
  });
  if (sessionRunning()) {
    txt.textContent = t('status.running');
  } else {
    txt.textContent = state.session ? t('status.ready') : t('status.chooseSession');
  }
}

/* ---------------- 主题（设置 → 主题 tab：亮色 / 暗色 / 跟随系统） ---------------- */
const THEME_KEY = 'omni-web-theme';
const THEME_OPTIONS = [
  { v: 'light', key: 'settings.themeLight' },
  { v: 'dark', key: 'settings.themeDark' },
  { v: 'system', key: 'settings.themeSystem' },
];
function getStoredTheme() {
  try { return localStorage.getItem(THEME_KEY); } catch { return null; }
}
function storeTheme(t) {
  try { localStorage.setItem(THEME_KEY, t); } catch { /* 隐私模式等场景忽略 */ }
}
function currentDark(theme) {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}
/** 应用主题：<html> 加 theme-light/theme-dark 类（无类 = 跟随系统，由 CSS 自动处理）；
 *  同步 theme-color meta（浏览器地址栏/标题栏）与设置面板选项高亮。 */
function applyTheme(theme) {
  const t = theme && THEME_OPTIONS.some((o) => o.v === theme) ? theme : (getStoredTheme() || 'system');
  const root = document.documentElement;
  root.classList.toggle('theme-light', t === 'light');
  root.classList.toggle('theme-dark', t === 'dark');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', currentDark(t) ? '#0f1115' : '#ffffff');
  renderThemeOptions(t);
  return t;
}
function renderThemeOptions(cur) {
  const box = $('#theme-options');
  if (!box) return;
  box.innerHTML = '';
  THEME_OPTIONS.forEach((o) => {
    const b = el('button', 'seg-btn' + (o.v === cur ? ' active' : ''), t(o.key));
    b.type = 'button';
    b.addEventListener('click', () => {
      if (o.v === cur) return;
      applyTheme(o.v);
      storeTheme(o.v);
      // 后端持久化（配置文件 webTheme 字段，重启 web 仍生效）+ 广播 status
      api('/api/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ webTheme: o.v }),
      }).catch(() => {});
    });
    box.appendChild(b);
  });
}
// 跟随系统时监听 OS 深浅色变化，刷新浏览器标题栏颜色
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  const t = getStoredTheme() || 'system';
  if (t === 'system') {
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', currentDark('system') ? '#0f1115' : '#ffffff');
  }
});

function refreshStatus() {
  return api('/api/status').then((s) => {
    state.status = s;
    syncRunningSessions(s);
    state.planMode = !!s.planMode;
    $('#ver').textContent = `v${s.version}`;
    $('#cwd').textContent = s.cwd;
    $('#cwd').title = s.cwd;
    $('#ws-cwd').textContent = s.cwd;
    $('#ws-cwd').title = s.cwd;
    $('#about-version').textContent = `v${s.version}`;
    $('#about-tools').textContent = s.tools.join(', ');
    $('#about-server').textContent = `http://${location.host}`;
    $('#plan-mode').checked = state.planMode;
    const sp = $('#set-plan');
    if (sp) sp.checked = state.planMode;
    $('#set-permission').value = s.permission || 'safe';
    renderSettingsModel(s);
    fillModelConfigForm(s);
    applyLanguage(s.language || 'zh');
    // 主题：后端配置优先（覆盖本地缓存），并同步本地缓存
    const theme = applyTheme(s.webTheme || 'system');
    storeTheme(theme);
    const workspaceName = s.cwd ? s.cwd.split('/').filter(Boolean).pop() || '当前工作区' : '当前工作区';
    $('#hero-workspace-name').textContent = workspaceName;
    updateDetails();
    updateComposer();
    updateStatusText();
  });
}

function updateComposer() {
  const send = $('#btn-send');
  const note = $('#composer-note');
  const curRun = sessionRunning();
  // 发送/停止合一：空闲 ↑ 发送；本会话运行中变停止按钮（点击取消当前任务）
  const use = send.querySelector('use');
  if (use) use.setAttribute('href', curRun ? '#i-square' : '#i-arrow-up');
  send.title = curRun ? t('composer.stop') : t('composer.send');
  send.classList.toggle('cancel', curRun);
  send.classList.remove('paused');
  send.disabled = false; // 运行中也保持可点（= 停止按钮）
  if (curRun) {
    note.textContent = state.messageQueue.length
      ? t('composer.runningQueued', { n: state.messageQueue.length })
      : t('composer.running');
  } else if (state.messageQueue.length) note.textContent = t('composer.queued', { n: state.messageQueue.length });
  else if (!state.session) note.textContent = t('composer.newChat');
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

/** 模型展示标签（1.0 元数据）：provider · 上下文 k · 输出 k */
function modelLabel(m) {
  if (!m) return '';
  const bits = [];
  if (m.provider) bits.push(m.provider);
  if (m.limit?.context) bits.push(`${Math.round(m.limit.context / 1000)}k`);
  if (m.limit?.output) bits.push(`出 ${Math.round(m.limit.output / 1000)}k`);
  const name = m.displayName || m.name;
  return bits.length ? `${name} · ${bits.join(' · ')}` : name;
}

/** 设置 → 模型面板：填充模型下拉与思考级别分段选择（签名去重，避免打断进行中的交互） */
function renderSettingsModel(s) {
  const sel = $('#set-model');
  if (!sel) return;
  const models = Array.isArray(s.models) ? s.models : [];
  const sig = JSON.stringify([s.model, models.map((m) => [m.name, m.baseURL])]);
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.innerHTML = '';
    for (const m of models) {
      const o = document.createElement('option');
      o.value = m.name;
      o.textContent = modelLabel(m);
      o.selected = m.name === s.model;
      sel.appendChild(o);
    }
  } else {
    sel.value = s.model || '';
  }
  const cur = models.find((m) => m.name === s.model);
  $('#set-model-desc').textContent = cur?.baseURL ? `端点 ${cur.baseURL}` : '端点沿用全局配置。';

  const box = $('#set-efforts');
  const efforts = Array.isArray(s.reasoningEffortOptions) ? s.reasoningEffortOptions.filter(Boolean) : [];
  const esig = JSON.stringify([efforts, s.reasoningEffort]);
  if (box.dataset.sig === esig) return;
  box.dataset.sig = esig;
  box.innerHTML = '';
  if (!efforts.length) {
    box.appendChild(el('span', 'seg-empty', '该模型未提供思考级别'));
    return;
  }
  efforts.forEach((t) => {
    const b = el('button', 'seg-btn' + (t === (s.reasoningEffort || efforts[0]) ? ' active' : ''), t);
    b.type = 'button';
    b.addEventListener('click', () => {
      applySettings({ reasoningEffort: t }).catch((err) => alert(`设置失败：${err.message}`));
    });
    box.appendChild(b);
  });
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
    'turn.step', 'lap', 'toolsLap', 'usage', 'subagent', 'hook.output',
    'error', 'run.end', 'approval.request', 'approval.resolved',
    'ask.request', 'ask.resolved', 'title', 'meta.add', 'clear',
    'workspace.changed', 'session.deleted', 'task.added', 'task.updated',
  ].forEach(on);
  es.onerror = () => {
    $('#status-dot').classList.add('error');
    $('#sidebar-status-dot').classList.add('error');
    $('#status-text').textContent = t('status.disconnected');
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
const syncRunningSessions = (st) => {
  const list = Array.isArray(st?.runningSessions) ? st.runningSessions : (st?.running && st.runningSession ? [st.runningSession] : []);
  state.runningSessions = new Set(list);
};
bus.on('status', (s) => {
  state.status = s;
  syncRunningSessions(s);
  state.planMode = !!s.planMode;
  $('#plan-mode').checked = state.planMode;
  const sp = $('#set-plan');
  if (sp) sp.checked = state.planMode;
  applyLanguage(s.language || 'zh');
  const theme = applyTheme(s.webTheme || 'system');
  storeTheme(theme);
  renderSessionList(); // 运行中绿点随 status 广播实时刷新
  updateDetails();
  updateComposer();
  updateStatusText();
});

bus.on('session.created', (ev) => {
  if (!state.sessions.find((s) => s.id === ev.id)) {
    state.sessions.unshift({ id: ev.id, title: ev.title || t('session.new'), messages: 0, created: Date.now(), updated: Date.now() });
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
  // steer 打断消息已进当前轮 → 消费「期望已插入」标记，run.end 不再重复发送
  if (ev.steer && state.steerText === ev.text) state.steerText = null;
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
  // 标记思考段结束（下一条 trace 不再追加到此条）
  state.trace.push({ kind: 'thinking-end' });
  if (state.view === 'trajectory') renderTrajectory();
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

const currentTools = new Map(); // seq -> toolBlock（并行工具结果乱序时按 seq 配对）
bus.on('tool.start', (ev) => {
  if (ev.sessionId !== state.session) return;
  const block = toolBlock(ev.sessionId, ev);
  currentTools.set(ev.seq ?? `f${currentTools.size}`, block);
  state.inFlight++;
  state.trace.push({ kind: 'tool', name: ev.name, args: ev.argsPreview });
  if (state.view === 'trajectory') renderTrajectory();
});
bus.on('tool.result', (ev) => {
  if (ev.sessionId !== state.session) return;
  const key = ev.seq;
  let currentTool = null;
  if (key !== undefined) {
    currentTool = currentTools.get(key) ?? null;
    if (currentTool) currentTools.delete(key);
  } else {
    // 兜底：无 seq 时按到达顺序配对（旧行为）
    const first = currentTools.entries().next().value;
    if (first) { currentTool = first[1]; currentTools.delete(first[0]); }
  }
  if (currentTool) currentTool.result(ev);
  state.inFlight--;
});

bus.on('usage', (ev) => {
  if (ev.sessionId !== state.session) return;
  state.turnTokens.prompt += ev.prompt || 0;
  state.turnTokens.completion += ev.completion || 0;
  state.turnTokens.cached += ev.cached || 0;
  // 记录 token 用量轨迹
  state.trace.push({ kind: 'usage', prompt: ev.prompt || 0, completion: ev.completion || 0, cached: ev.cached || 0 });
  if (state.view === 'trajectory') renderTrajectory();
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
  state.runningSessions.delete(ev.sessionId);
  if (ev.sessionId !== state.session) { refreshSessions(); return; }
  currentTools.clear(); // 取消/打断时部分工具可能无 result 到达，清理避免错配下一轮
  if (currentThinking) { currentThinking.finish(); currentThinking = null; }
  if (currentAssistant) {
    currentAssistant.paint();
    currentAssistant.stopCursor();
    currentAssistant = null;
  }
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

  // 消费 steer（优先）→ queue → 下一轮自动发送
  const next = state.steerText || (state.messageQueue.length ? state.messageQueue.shift() : null);
  if (next) {
    state.steerText = null;
    doSend(next);
  } else {
    updateComposer();
    updateStatusText();
  }
});

// turn.step：本轮第 N 步
bus.on('turn.step', (ev) => {
  if (ev.sessionId !== state.session) return;
  state.trace.push({ kind: 'turn', text: `第 ${ev.step} 步 / ${ev.maxSteps}` });
  if (state.view === 'trajectory') renderTrajectory();
});

// lap：LLM 请求墙钟 / 首 token
bus.on('lap', (ev) => {
  if (ev.sessionId !== state.session) return;
  if (ev.llmMs) {
    const ms = ev.llmMs;
    const fmt = ms < 10000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`;
    state.trace.push({ kind: 'lap', text: `LLM ${fmt} · 首 token ${ev.firstTokenMs || 0}ms` });
    if (state.view === 'trajectory') renderTrajectory();
  }
});

// toolsLap：工具执行墙钟
bus.on('toolsLap', (ev) => {
  if (ev.sessionId !== state.session) return;
  if (ev.toolsMs) {
    const ms = ev.toolsMs;
    const fmt = ms < 10000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`;
    state.trace.push({ kind: 'lap', text: `工具执行 ${fmt}` });
    if (state.view === 'trajectory') renderTrajectory();
  }
});

// hook.output：Hook 输出回显
bus.on('hook.output', (ev) => {
  if (!ev.lines || !ev.lines.length) return;
  if (ev.sessionId && ev.sessionId !== state.session) return;
  metaLine(ev.sessionId || state.session, [`📎 ${ev.event || 'hook'}: ${ev.lines[0]}`]);
});

bus.on('error', (ev) => {
  if (ev.sessionId !== state.session) return;
  metaLine(ev.sessionId, [`✗ ${ev.message}`]);
  $('#status-dot').classList.add('error');
  $('#sidebar-status-dot').classList.add('error');
  $('#status-text').textContent = t('status.failed');
});

bus.on('approval.request', (ev) => {
  interactionCard({ ...ev, type: 'approval', id: ev.approvalId });
  scrollBottom(true);
});
bus.on('approval.resolved', (ev) => {
  const key = `${ev.sessionId}:approval:${ev.approvalId}`;
  const w = state.waiters.get(key);
  if (w) removeInteractionCard(w);
  if (ev.sessionId === state.session) {
    metaLine(ev.sessionId, [ev.allow ? t('approval.allowed') : t('approval.denied')]);
  } else {
    metaLine(ev.sessionId, [ev.allow ? `${t('approval.allowed')}（${sessionLabel(ev.sessionId)}）` : `${t('approval.denied')}（${sessionLabel(ev.sessionId)}）`]);
  }
});
bus.on('ask.request', (ev) => {
  interactionCard({ ...ev, type: 'ask', id: ev.askId });
  scrollBottom(true);
});
bus.on('ask.resolved', (ev) => {
  const key = `${ev.sessionId}:ask:${ev.askId}`;
  const w = state.waiters.get(key);
  if (w) removeInteractionCard(w);
  if (ev.sessionId === state.session) {
    userBlock(ev.sessionId, ev.choices && ev.choices.length ? t('ask.userChoice', { choices: ev.choices.join('、') }) : t('ask.userCancelled'));
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
// 会话删除广播：列表移除；若为当前打开的会话回草稿态
bus.on('session.deleted', (ev) => {
  state.sessions = state.sessions.filter((x) => x.id !== ev.sessionId);
  renderSessionList();
  if (state.session === ev.sessionId) {
    state.session = null;
    clearPendingMessages();
    clearMessages();
    $('#chat-title').textContent = t('session.new');
    renderWelcome();
    updateComposer();
    updateStatusText();
  }
});
/* ---------------- 后台任务收件箱（事件同步）---------------- */
function updateInboxBadge() {
  const n = state.tasks.filter((t) => t.status === 'pending' || t.status === 'running').length;
  const b = $('#inbox-count');
  if (!b) return;
  b.textContent = String(n);
  b.classList.toggle('hidden', n === 0);
}
function upsertTask(t) {
  const i = state.tasks.findIndex((x) => x.id === t.id);
  if (i >= 0) state.tasks[i] = t;
  else state.tasks.unshift(t);
  updateInboxBadge();
  if (!$('#inbox-modal').classList.contains('hidden')) renderTaskList();
}
bus.on('task.added', (ev) => upsertTask(ev.task));
bus.on('task.updated', (ev) => upsertTask(ev.task));

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

/* ---------------- 斜杠命令 ---------------- */
const SLASH_COMMANDS = [
  { name: '/help', desc: '查看所有可用命令' },
  { name: '/status', desc: '会话状态汇总' },
  { name: '/context', desc: '上下文用量（消息/token 估算）' },
  { name: '/clear', desc: '清空当前会话上下文' },
  { name: '/plan', desc: '切换计划模式（只读调研）' },
  { name: '/permission', desc: '切换安全权限档位（低/中/高/全量）' },
  { name: '/model', desc: '查看/切换/添加模型（/model fetch 拉取网关模型清单）' },
  { name: '/variants', desc: '切换思考级别（low/medium/high）' },
  { name: '/undo', desc: '撤销最近的文件修改（all = 全部）' },
  { name: '/redo', desc: '重做上次撤销（all = 全部）' },
  { name: '/compact', desc: '手动压缩上下文为摘要' },
  { name: '/review', desc: '代码审查（typecheck + git diff）' },
  { name: '/diff', desc: '查看未提交改动（--stat 只看统计 · --full 不截断）' },
  { name: '/rewind', desc: '会话检查点：回滚工作区到历史回合（列表 / <N> 恢复）' },
  { name: '/trace', desc: '查看运行轨迹账本' },
  { name: '/agents', desc: '查看子代理配置与定义' },
  { name: '/orchestrate', desc: '并行编排（fan-out delegate → 汇总 → 审查）' },
  { name: '/goal', desc: '目标机制（自动推导验收标准并循环执行）' },
  { name: '/loop', desc: '/goal 别名' },
  { name: '/thinking', desc: '开/关思考过程展示（关闭后不再流式显示，仍落盘）' },
  { name: '/skill', desc: '技能管理（列出/find/add/show）' },
  { name: '/init', desc: '生成 AGENTS.md 项目记忆（--global 全局）' },
  { name: '/export', desc: '导出会话为 Markdown' },
  { name: '/config', desc: '查看配置文件路径' },
  { name: '/mcp', desc: 'MCP 管理：reconnect / resources / prompts（设置面板可 add/remove/install/login）' },
  { name: '/rename', desc: '修改会话标题' },
  { name: '/session', desc: '会话管理（列出/恢复/all 全部）' },
  { name: '/resume', desc: '恢复历史会话（列出/恢复）' },
  { name: '/doctor', desc: '环境诊断（Node/API/配置）' },
  { name: '/spec', desc: '规格三件套（/spec <特性>）：requirements(EARS)/design/tasks 落盘 .omni/specs/' },
  { name: '/preset', desc: '能力一键预设（/preset browser 安装浏览器自动化双雄 MCP）' },
  { name: '/settings', desc: '打开设置面板' },];

const cmdPalette = $('#cmd-palette');
const mentionPop = $('#mention-pop');
let cmdSelIdx = 0;
let cmdFiltered = [];
let mentionItems = [];
let mentionSelIdx = 0;
let mentionAtPos = -1; // @ 符在输入框中的位置

/* ---------------- @ 提及文件 ---------------- */
let mentionCache = {};
let mentionCacheTimer = null;
async function listMentionCandidates(query) {
  // 简单防抖：避免每次按键都请求服务器
  if (mentionCacheTimer) clearTimeout(mentionCacheTimer);
  const cacheKey = query;
  if (mentionCache[cacheKey]) return mentionCache[cacheKey];
  try {
    const results = await api('/api/files?q=' + encodeURIComponent(query));
    mentionCache[cacheKey] = results;
    // 缓存 2s 后过期
    mentionCacheTimer = setTimeout(() => { delete mentionCache[cacheKey]; }, 2000);
    return results;
  } catch {
    return [];
  }
}

let mentionRenderId = 0; // 防止异步竞态
async function renderMention(query) {
  const myId = ++mentionRenderId;
  const items = await listMentionCandidates(query);
  // 如果在等待期间用户又输入了新字符，丢弃这次结果
  if (myId !== mentionRenderId) return;
  mentionItems = items;
  mentionSelIdx = 0;
  if (!mentionItems.length) {
    mentionPop.classList.add('hidden');
    return;
  }
  mentionPop.innerHTML = '';
  mentionItems.forEach((item, i) => {
    const row = el('div', 'mention-item' + (i === 0 ? ' selected' : ''));
    const icon = item.isDir ? '📁' : '📄';
    const label = item.isDir ? item.name + '/' : item.name;
    row.innerHTML = '<span class="mention-icon">' + icon + '</span><span class="mention-label">' + esc(label) + '</span>';
    if (!item.isDir) {
      const sub = el('span', 'mention-path', item.path);
      row.appendChild(sub);
    }
    row.addEventListener('click', () => {
      insertMention(item);
    });
    mentionPop.appendChild(row);
  });
  mentionPop.classList.remove('hidden');
}

function moveMentionSel(delta) {
  if (!mentionItems.length) return;
  mentionSelIdx = (mentionSelIdx + delta + mentionItems.length) % mentionItems.length;
  const items = mentionPop.querySelectorAll('.mention-item');
  items.forEach((n, i) => n.classList.toggle('selected', i === mentionSelIdx));
}

function acceptMention() {
  if (mentionSelIdx < mentionItems.length) {
    insertMention(mentionItems[mentionSelIdx]);
  }
}

function insertMention(item) {
  // 从 mentionAtPos+1 到 selectionStart 替换为路径
  const before = input.value.slice(0, mentionAtPos + 1);
  const after = input.value.slice(input.selectionStart);
  const insert = item.path + (item.isDir ? '/' : ' ');
  input.value = before + insert + after;
  const newCursor = (before + insert).length;
  input.setSelectionRange(newCursor, newCursor);
  mentionPop.classList.add('hidden');
  mentionItems = [];
  autoResize();
  input.focus();
}

function renderCmdPalette(query) {
  const q = query.toLowerCase();
  cmdFiltered = SLASH_COMMANDS.filter((c) =>
    c.name.toLowerCase().startsWith(q) || c.desc.toLowerCase().includes(q)
  );
  cmdSelIdx = 0;
  if (!cmdFiltered.length) {
    cmdPalette.classList.add('hidden');
    return;
  }
  cmdPalette.innerHTML = '';
  cmdFiltered.slice(0, 10).forEach((c, i) => {
    const item = el('div', 'cmd-item' + (i === 0 ? ' selected' : ''));
    item.innerHTML = '<span class="cmd-name">' + esc(c.name) + '</span><span class="cmd-desc">' + esc(c.desc) + '</span>';
    item.addEventListener('click', () => {
      input.value = c.name + ' ';
      cmdPalette.classList.add('hidden');
      autoResize();
      input.focus();
    });
    cmdPalette.appendChild(item);
  });
  cmdPalette.classList.remove('hidden');
}

function moveCmdSel(delta) {
  const max = Math.min(cmdFiltered.length, 10);
  if (!max) return;
  cmdSelIdx = (cmdSelIdx + delta + max) % max;
  const items = cmdPalette.querySelectorAll('.cmd-item');
  items.forEach((n, i) => n.classList.toggle('selected', i === cmdSelIdx));
}

function acceptCmdSel() {
  const items = cmdPalette.querySelectorAll('.cmd-item');
  if (cmdSelIdx < items.length) {
    const name = cmdFiltered[cmdSelIdx].name;
    input.value = name + ' ';
    cmdPalette.classList.add('hidden');
    autoResize();
  }
}

function openCmdPanel(lines) {
  const body = $('#cmd-panel-body');
  body.innerHTML = '';
  if (lines.length === 0) {
    body.appendChild(el('div', 'cmd-empty', t('cmd.none')));
  } else {
    const pre = el('pre', 'cmd-output');
    pre.textContent = lines.join('\n');
    body.appendChild(pre);
  }
  $('#cmd-panel').classList.remove('hidden');
  document.body.classList.add('cmd-open');
  // 自动滚动到顶部
  body.scrollTop = 0;
}
function closeCmdPanel() {
  const panel = $('#cmd-panel');
  panel.style.animation = 'none';
  panel.style.opacity = '0';
  panel.style.transform = 'translate(-50%, -52%) scale(.96)';
  panel.style.transition = 'opacity .15s var(--ease), transform .15s var(--ease)';
  setTimeout(() => {
    panel.classList.add('hidden');
    panel.style.cssText = '';
    document.body.classList.remove('cmd-open');
  }, 150);
}
$('#btn-close-cmd').addEventListener('click', closeCmdPanel);
$('#cmd-panel').addEventListener('click', (e) => {
  if (e.target === $('#cmd-panel')) closeCmdPanel();
});

async function runSlashCommand(cmd) {
  // 某些命令在前端直接处理，避免不必要的往返
  if (cmd === '/settings') {
    openSettings();
    return;
  }
  // 显示加载状态
  openCmdPanel([]);
  $('#cmd-panel-body').innerHTML = '';
  const loader = el('div', 'cmd-empty');
  loader.innerHTML = '<span class="spin">' + SPIN[spinIdx % SPIN.length] + '</span> ' + t('cmd.loading');
  $('#cmd-panel-body').appendChild(loader);
  // 发送到后端执行
  try {
    const result = await api('/api/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: cmd, sessionId: state.session, background: true }),
    });
    if (result.lines && result.lines.length > 0) {
      openCmdPanel(result.lines);
    } else {
      openCmdPanel([t('cmd.executed')]);
    }
    // 某些命令改变了状态/会话列表，刷新
    const statusCmds = ['/plan', '/permission', '/variants', '/model', '/clear', '/thinking', '/mcp reconnect'];
    if (statusCmds.some((c) => cmd.startsWith(c))) {
      refreshStatus().catch(() => {});
    }
    const refreshCmds = ['/session', '/resume', '/rename', '/init', '/skill add', '/undo', '/redo', '/compact'];
    if (refreshCmds.some((c) => cmd.startsWith(c))) {
      refreshSessions().catch(() => {});
    }
    // /session <id> 或 /resume <id>：直接加载会话
    if (state.session && (cmd.startsWith('/session ') || cmd.startsWith('/resume ')) && !cmd.includes('all') && !cmd.includes('list')) {
      const arg = cmd.split(/\s+/)[1];
      if (arg) selectSession(arg).catch(() => {});
    }
  } catch (e) {
    openCmdPanel([t('cmd.failed', { msg: e.message })]);
  }
}

/* ---------------- 输入 / 发送 ---------------- */
const input = $('#input');
function autoResize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
}
input.addEventListener('input', () => {
  autoResize();
  const text = input.value;
  // 斜杠命令联想
  if (text.startsWith('/') && !text.includes('\n')) {
    renderCmdPalette(text);
    mentionPop.classList.add('hidden');
    return;
  }
  cmdPalette.classList.add('hidden');
  // @ 提及文件
  const atMatch = text.slice(0, input.selectionStart).match(/@([^\s@]*)$/);
  if (atMatch) {
    mentionAtPos = input.selectionStart - atMatch[0].length;
    renderMention(atMatch[1]);
  } else {
    mentionPop.classList.add('hidden');
    mentionItems = [];
  }
});
input.addEventListener('keydown', (e) => {
  // 斜杠命令 palette 导航
  if (!cmdPalette.classList.contains('hidden')) {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveCmdSel(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveCmdSel(-1); return; }
    if (e.key === 'Tab') { e.preventDefault(); acceptCmdSel(); return; }
    if (e.key === 'Escape') { e.preventDefault(); cmdPalette.classList.add('hidden'); return; }
  }
  // @ 提及导航
  if (!mentionPop.classList.contains('hidden')) {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveMentionSel(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveMentionSel(-1); return; }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); acceptMention(); return; }
    if (e.key === 'Escape') { e.preventDefault(); mentionPop.classList.add('hidden'); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    // 斜杠命令：直接执行（不发送给 Agent）
    if (text.startsWith('/')) {
      cmdPalette.classList.add('hidden');
      input.value = '';
      autoResize();
      runSlashCommand(text);
      return;
    }
    if (sessionRunning()) {
      if (e.metaKey || e.ctrlKey) steerMessage(text);
      else queueMessage(text);
    } else {
      sendMessage();
    }
  }
});
document.addEventListener('keydown', (e) => {
  const isNew = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
  if (isNew) {
    e.preventDefault();
    if (!sessionRunning()) newSession().catch((err) => console.error(err));
  } else if (e.key === '/' && document.activeElement !== input && document.activeElement?.tagName !== 'INPUT') {
    e.preventDefault();
    $('#session-search').focus();
  } else if (e.key === 'Escape') {
    const anyPopOpen = ['#permission-pop', '#add-menu', '#project-pop', '#location-pop', '#branch-pop', '#model-pop'].some((sel) => !$(sel).classList.contains('hidden'));
    if (anyPopOpen) { closeAllComposerPops(); return; }
    if (!$('#rewind-modal').classList.contains('hidden')) $('#rewind-modal').classList.add('hidden');
    else if (!$('#inbox-modal').classList.contains('hidden')) $('#inbox-modal').classList.add('hidden');
    if (!$('#dirpicker-modal').classList.contains('hidden')) closeDirPicker();
    else if (!$('#settings-modal').classList.contains('hidden')) closeSettings();
    else if (!$('#cmd-panel').classList.contains('hidden')) closeCmdPanel();
    else if (cmdPalette && !cmdPalette.classList.contains('hidden')) cmdPalette.classList.add('hidden');
    else if (mentionPop && !mentionPop.classList.contains('hidden')) mentionPop.classList.add('hidden');
    else if ($('#app').classList.contains('sidebar-open')) $('#app').classList.remove('sidebar-open');
    else if (state.detailsOpen) {
      state.detailsOpen = false;
      $('#app').classList.remove('details-open');
    }
  }
});

/* 纯发送（不检查 running 状态，由调用方保证） */
async function doSend(text) {
  input.value = '';
  autoResize();
  setEmptyState(false);
  try {
    if (!state.session) {
      const data = await api('/api/sessions', { method: 'POST' });
      state.session = data.id;
      if (!state.sessions.some((s) => s.id === data.id)) {
        state.sessions.unshift({ id: data.id, title: t('session.new'), messages: 0, created: Date.now(), updated: Date.now(), project: state.status?.cwd });
      }
      renderSessionList();
    }
    state.runningSessions.add(state.session);
    updateComposer();
    updateStatusText();
    await api(`/api/sessions/${state.session}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch (e) {
    state.runningSessions.delete(state.session);
    if (state.session) metaLine(state.session, [t('send.failed', { msg: e.message })]);
    updateComposer();
    updateStatusText();
  }
}

/* 空闲发送 */
function sendMessage() {
  const text = input.value.trim();
  if (!text) return;
  if (sessionRunning()) return; // 仅本会话运行中拦截（其它会话可并行）
  doSend(text);
}

/* 运行中 Enter → 入队 */
function queueMessage(text) {
  state.messageQueue.push(text);
  input.value = '';
  autoResize();
  updateComposer();
}

/* 运行中 Cmd/Ctrl+Enter → steer（打断，插入当前轮） */
function steerMessage(text) {
  input.value = '';
  autoResize();
  updateComposer();
  if (state.session) {
    // 「期望已插入」标记：steer 成功后服务端会广播 user.message(steer:true)（消息进当前轮），
    // 收到即消费；若本轮在消息被取走前自然结束（极窄竞态，消息丢失），
    // 标记保留 → run.end 时按普通消息补发，不丢消息。
    state.steerText = text;
    api(`/api/sessions/${state.session}/steer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    }).catch(() => {
      // steer 失败（如已停）则回退为取消 + 排队（run.end 消费）
      api(`/api/sessions/${state.session}/cancel`, { method: 'POST' }).catch(() => {});
    });
  }
}

/* 取消当前会话的运行（停止按钮 / Esc） */
function cancelCurrentRun() {
  if (state.session) {
    api(`/api/sessions/${state.session}/cancel`, { method: 'POST' }).catch(() => {});
    // 乐观清理：停止后不再自动消费待发送队列
    state.messageQueue = [];
    state.steerText = null;
    updateComposer();
    updateStatusText();
  }
}

$('#btn-send').addEventListener('click', () => {
  if (sessionRunning()) cancelCurrentRun();
  else sendMessage();
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
$('#chat-title').addEventListener('click', (e) => { e.stopPropagation(); if (state.session) showChatActions(e); });
// 修复死交互：空态工作区条点击 = 浏览切换工作目录（此前 chevron 无任何监听）
$('.hero-workspace')?.addEventListener('click', () => browseWorkspace());
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
$('#btn-attach').addEventListener('click', (e) => {
  e.stopPropagation();
  const pop = $('#add-menu');
  if (pop.classList.contains('hidden')) { renderAddMenu(); pop.classList.remove('hidden'); }
  else pop.classList.add('hidden');
  // 关闭其它
  $('#permission-pop').classList.add('hidden');
  $('#model-pop').classList.add('hidden');
});
$('#btn-permission').addEventListener('click', (e) => {
  e.stopPropagation();
  const pop = $('#permission-pop');
  if (pop.classList.contains('hidden')) { renderPermissionPop(); pop.classList.remove('hidden'); }
  else pop.classList.add('hidden');
  $('#add-menu').classList.add('hidden');
  $('#model-pop').classList.add('hidden');
});
$('#ctx-project').addEventListener('click', (e) => {
  e.stopPropagation();
  const pop = $('#project-pop');
  if (pop.classList.contains('hidden')) { renderProjectPop(); pop.classList.remove('hidden'); }
  else pop.classList.add('hidden');
  $('#location-pop').classList.add('hidden');
  $('#branch-pop').classList.add('hidden');
});
$('#ctx-location').addEventListener('click', (e) => {
  e.stopPropagation();
  const pop = $('#location-pop');
  if (pop.classList.contains('hidden')) { renderLocationPop(); pop.classList.remove('hidden'); }
  else pop.classList.add('hidden');
  $('#project-pop').classList.add('hidden');
  $('#branch-pop').classList.add('hidden');
});
$('#ctx-branch').addEventListener('click', (e) => {
  e.stopPropagation();
  const pop = $('#branch-pop');
  if (pop.classList.contains('hidden')) { renderBranchPop(); pop.classList.remove('hidden'); }
  else pop.classList.add('hidden');
  $('#project-pop').classList.add('hidden');
  $('#location-pop').classList.add('hidden');
});

/* ---------------- 模型 / 思考级别 popover（composer 内联切换） ---------------- */
function openModelPop() {
  renderModelPop(state.status || {});
  $('#model-pop').classList.remove('hidden');
  $('#permission-pop').classList.add('hidden');
  $('#add-menu').classList.add('hidden');
}

function closeModelPop() {
  $('#model-pop').classList.add('hidden');
}

function renderModelPop(s) {
  const pop = $('#model-pop');
  if (!pop) return;
  pop.innerHTML = '';
  const models = Array.isArray(s.models) ? s.models : [];
  const efforts = Array.isArray(s.reasoningEffortOptions) ? s.reasoningEffortOptions.filter(Boolean) : [];

  // 模型：下拉框（change 即切换）
  pop.appendChild(el('div', 'pop-head', '模型'));
  if (!models.length) {
    pop.appendChild(el('div', 'pop-empty', '当前无可用模型'));
  } else {
    const sel = document.createElement('select');
    sel.className = 'pop-select';
    for (const m of models) {
      const o = document.createElement('option');
      o.value = m.name;
      o.textContent = modelLabel(m);
      o.selected = m.name === s.model;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => {
      const v = sel.value;
      if (v === s.model) return;
      applySettings({ model: v }).then(() => closeModelPop()).catch((err) => alert(`切换失败：${err.message}`));
    });
    pop.appendChild(sel);
  }

  // 推理强度：slider（拖动实时预览，松手生效）
  pop.appendChild(el('div', 'pop-sep'));
  pop.appendChild(el('div', 'pop-head', '推理强度'));
  if (!efforts.length) {
    pop.appendChild(el('div', 'pop-empty', '该模型未提供思考级别'));
  } else {
    const curEff = s.reasoningEffort || efforts[0];
    const headRow = el('div', 'pop-head-row');
    headRow.appendChild(el('div', 'pop-head', ''));
    const val = el('span', 'pop-val', curEff);
    headRow.appendChild(val);
    pop.appendChild(headRow);
    const idx = Math.max(0, efforts.indexOf(curEff));
    const range = document.createElement('input');
    range.type = 'range';
    range.className = 'pop-slider';
    range.min = '0';
    range.max = String(efforts.length - 1);
    range.step = '1';
    range.value = String(idx);
    let applied = idx;
    range.addEventListener('input', () => { val.textContent = efforts[Number(range.value)] ?? ''; });
    range.addEventListener('change', () => {
      const pos = Number(range.value);
      const v = efforts[pos];
      if (pos === applied || !v) return;
      applySettings({ reasoningEffort: v })
        .then(() => { applied = pos; closeModelPop(); })
        .catch((err) => { alert(`设置失败：${err.message}`); range.value = String(applied); val.textContent = efforts[applied]; });
    });
    pop.appendChild(range);
    const ticks = el('div', 'pop-ticks');
    efforts.forEach((t) => ticks.appendChild(el('span', null, t)));
    pop.appendChild(ticks);
  }
}

/* 点击 popover 外关闭（统一处理所有 composer 相关 pop） */
document.addEventListener('click', (e) => {
  const target = e.target;
  const inside = (sel) => {
    const n = $(sel);
    return n && (n.contains(target) || (n.previousElementSibling && n.previousElementSibling.contains && n.previousElementSibling.contains(target)));
  };
  // 统一关闭逻辑：若点击不在任何 pop/触发器内则全关
  const pops = ['#model-pop', '#permission-pop', '#add-menu', '#project-pop', '#location-pop', '#branch-pop'];
  const triggers = ['#composer-model', '#btn-permission', '#btn-attach', '#ctx-project', '#ctx-location', '#ctx-branch'];
  const hitPop = pops.some((sel) => { const n = $(sel); return n && n.contains(target); });
  const hitTrig = triggers.some((sel) => { const n = $(sel); return n && n.contains(target); });
  if (!hitPop && !hitTrig) closeAllComposerPops();
});
$('#btn-close-settings').addEventListener('click', () => {
  closeSettings();
});
$('#settings-modal').addEventListener('click', (e) => {
  if (e.target === $('#settings-modal')) {
    closeSettings();
  }
});

/* 设置弹窗：左侧分类 → 右侧详情 */
document.querySelectorAll('.settings-nav-item').forEach((item) => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.settings-nav-item').forEach((n) => n.classList.toggle('active', n === item));
    const pane = item.dataset.pane;
    document.querySelectorAll('#settings-modal .settings-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === pane));
  });
});
$('#set-model').addEventListener('change', (e) => {
  applySettings({ model: e.target.value }).catch((err) => alert(`切换失败：${err.message}`));
});
$('#set-plan').addEventListener('change', (e) => {
  applySettings({ planMode: e.target.checked }).catch((err) => alert(`设置失败：${err.message}`));
});
$('#btn-browse-workspace').addEventListener('click', () => browseWorkspace());

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
$('#set-language').addEventListener('change', (e) => {
  applyLanguage(e.target.value);
  api('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ language: e.target.value }),
  }).catch((err) => alert(`语言设置失败：${err.message}`));
});
/* ---------------- 模型配置表单（设置 → 模型配置 tab） ---------------- */
function fillModelConfigForm(s) {
  const sel = $('#cfg-model');
  if (!sel) return;
  const models = Array.isArray(s.models) ? s.models : [];
  const cur = state.cfgModelName && models.some((m) => m.name === state.cfgModelName) ? state.cfgModelName : (s.model || '');
  const sig = JSON.stringify([models.map((m) => m.name), cur]);
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.innerHTML = '';
    for (const m of models) {
      const o = document.createElement('option');
      o.value = m.name; o.textContent = modelLabel(m);
      o.selected = m.name === cur;
      sel.appendChild(o);
    }
    sel.value = cur;
  }
  const m = models.find((x) => x.name === sel.value) || {};
  $('#cfg-baseurl').value = m.baseURL || '';
  const opts = (m.reasoningEffortOptions || s.reasoningEffortOptions || ['low', 'medium', 'high']).filter(Boolean);
  $('#cfg-efforts').value = opts.join(', ');
  const curEff = m.reasoningEffort || s.reasoningEffort || opts[0] || '';
  const effSel = $('#cfg-effort-current');
  const esig = JSON.stringify([opts, curEff]);
  if (effSel.dataset.sig !== esig) {
    effSel.dataset.sig = esig;
    effSel.innerHTML = '';
    for (const o of opts) {
      const op = document.createElement('option');
      op.value = o; op.textContent = o;
      op.selected = o === curEff;
      effSel.appendChild(op);
    }
    effSel.value = curEff;
  }
  $('#cfg-context').value = m.limit?.context || '';
}
// 模型下拉切换时刷新表单
document.addEventListener('change', (e) => {
  if (e.target.id === 'cfg-model') {
    state.cfgModelName = e.target.value;
    fillModelConfigForm(state.status || {});
  }
});
// 保存模型配置
$('#btn-save-model').addEventListener('click', () => {
  const sel = $('#cfg-model');
  const name = sel.value;
  if (!name) { alert('没有可保存的模型'); return; }
  const mc = {
    modelName: name,
    baseURL: $('#cfg-baseurl').value.trim() || undefined,
    apiKey: $('#set-apikey').value.trim() || undefined,
    reasoningEffortOptions: $('#cfg-efforts').value.split(',').map((s) => s.trim()).filter(Boolean) || undefined,
    reasoningEffort: $('#cfg-effort-current').value || undefined,
    contextLimit: Number($('#cfg-context').value) > 0 ? Number($('#cfg-context').value) : undefined,
  };
  api('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelConfig: mc }),
  }).then(() => {
    $('#set-apikey').value = '';
    const note = $('#model-save-note');
    note.classList.remove('hidden');
    setTimeout(() => note.classList.add('hidden'), 2500);
    refreshStatus().catch(() => {});
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
  // 立即应用主题（读 localStorage，避免首帧闪白 / 主题闪烁）
  applyTheme(getStoredTheme());
  connectSSE();
  try {
    await refreshStatus();
  } catch (e) {
    $('#status-text').textContent = t('status.cantConnect');
  }
  try { state.tasks = await api('/api/tasks'); updateInboxBadge(); } catch { /* ignore */ }
  try {
    state.sessions = await api('/api/sessions');
    renderSessionList();
    if (state.sessions.length) await selectSession(state.sessions[0].id, true);
    else renderWelcome();
  } catch (e) { renderWelcome(); }
})();

/* 退出时触发 autoMemory（用 sendBeacon 保证页面关闭时仍能发送） */
window.addEventListener('beforeunload', () => {
  if (navigator.sendBeacon) {
    navigator.sendBeacon('/api/finalize', new Blob([JSON.stringify({ sessionId: state.session })], { type: 'application/json' }));
  }
});

/* spinner 动画 */
setInterval(() => {
  spinIdx++;
  const frame = SPIN[spinIdx % SPIN.length];
  document.querySelectorAll('.tool-card.running .spin').forEach((n) => {
    n.textContent = frame;
  });
  // 命令面板加载中的 spinner 也实时转动
  const panelSpin = $('#cmd-panel .cmd-empty .spin');
  if (panelSpin) panelSpin.textContent = frame;
}, 200);

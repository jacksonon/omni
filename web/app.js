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
  thinkingCollapsed: false, // /thinking 全局折叠/展开思考模块
  _sending: false,          // 发送锁：防止 Enter/Cmd+Enter 重复触发
  _pendingUserText: null,   // 乐观回显去重：doSend 本地已显示用户消息，SSE 重复到达时跳过
  _restoredMidRun: false,   // 刷新/切回时选中的会话正在运行：run.end 后从历史重渲染补齐
  autoFollow: true,         // 消息流自动跟随底部（用户手动上滚后暂停，回底恢复）
  blocks: new Map(),    // blockId -> MessageBlock
  waiters: new Map(),   // interactionId -> { sessionId, type(approval|ask), el }
  inFlight: 0,          // 本轮未完成的请求计数（跑完才印统计行）
  turnTokens: { prompt: 0, completion: 0, cached: 0 },
  sessionFilter: '',
  expandedGroups: new Set(), // 工作区分组展开记忆（'!项目' 前缀 = 强制收起的当前工作区组）
  runningSessions: new Set(), // 运行中的会话 id 集合（唯一真相源）
  _localRunning: new Set(), // 本地刚启动的会话（doSend 设置，status 覆盖前保持；run.end 清除）
  cfgModelName: null,       // 设置 → 模型配置 tab 当前编辑的模型名
  statusline: ['speed', 'cache', 'tokens', 'context'], // 输入区下方状态行段（设置 → 状态栏；同 TUI footer stats）
  sessionStats: new Map(),  // sessionId -> { turns, steps, llmMs, toolsMs, firstTokenSum, firstTokenCount, cached }
  sessionUsage: new Map(),  // sessionId -> { prompt, completion, total, cached }
  messageQueue: [],     // 运行中 Enter 入队的消息（仅当前会话）
  steerText: null,      // 运行中 Cmd+Enter 打断消息（仅当前会话，优先于 queue）
  attachments: [],      // 输入区附件（+ 按钮/拖拽采集；{ id, kind: image|text|path, name, size, dataUrl?, content? }）
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
  'hero.tagline': 'omni',
  'hero.preview': '预览版',
  'hero.workspace': '当前工作区',
  // composer
  'composer.attach': '选择文件/图片',
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
  // 附件
  'attach.remove': '移除附件',
  'attach.imageTooLarge': '⚠ 图片超过 4MB 上限，已跳过：{name}',
  'attach.modelNoImage': '⚠ 当前模型不支持图片，已转为路径附件：{name}',
  'attach.truncated': '（已截断，可用 read_file 定向读取）',
  'attach.running': '⚠ 运行中无法附带附件，请等待当前回复完成',
  'attach.image': '图片',
  // 权限
  'perm.full': '完全访问',
  'perm.safe': '帮我批准',
  'perm.ask': '请求批准',
  'perm.read': '只读',
  'perm.readDesc': '仅允许读取文件和浏览目录，不能写入或执行命令',
  'perm.head': '应如何批准操作？',
  'perm.more': '了解更多',
  'perm.askDesc': '编辑外部文件和使用互联网时始终询问',
  'perm.safeDesc': '仅对检测到的风险操作请求批准',
  'perm.fullDesc': '可不受限制地访问互联网和你电脑上的任何文件',
  'perm.fullTitle': '完全访问权限',
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
  'thinking.running': 'thinking · {dur}',
  'thinking.done': 'thinking · {n} 字符 · {dur}',
  'thinking.collapsed': 'thinking · {dur}',
  'tool.running': '执行中',
  'tool.failed': '失败',
  'tool.noOutput': '（无输出）',
  'tool.nchars': '{n} 字符',
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
  'settings.apikeySub': '配置模型的端点、密钥、推理级别与上下文长度。支持 providers 分组（一个端点对应多个模型），与 omni.json 的 providers 字段一致，保存后写入全局配置文件。',
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
  'settings.concurrency': '并行会话上限',
  'settings.concurrencyDesc': '允许同时运行的会话数量（1-16），超过上限时新消息排队等待。',
  // providers（一个端点配置多个模型）
  'provider.ungrouped': '未分组',
  'provider.new': '+ 新建 provider',
  'provider.empty': '选择左侧 provider 或未分组模型编辑',
  'provider.baseURL': '端点（baseURL）',
  'provider.baseURLDesc': 'OpenAI 兼容 API 地址，如 https://api.deepseek.com/v1。',
  'provider.apiKey': 'API Key',
  'provider.apiKeyDesc': '密钥以掩码显示；点击右侧眼睛可查看明文。',
  'provider.eye': '显示/隐藏 API Key',
  'provider.fetch': '获取模型列表',
  'provider.save': '保存',
  'provider.delete': '删除',
  'provider.userAgent': 'User-Agent',
  'provider.userAgentDesc': '部分网关需要自定义 User-Agent 绕过 WAF。',
  'provider.models': '组内模型',
  'provider.modelsCount': '{n} 个模型',
  'provider.addModel': '添加',
  'provider.setDefault': '设为默认',
  'provider.edit': '编辑',
  'provider.removeModel': '删除模型',
  'provider.removeConfirm': '确定删除模型「{name}」？',
  'provider.removeProviderConfirm': '确定删除 provider「{name}」及其全部模型？',
  'provider.namePlaceholder': 'provider 名称（如 bigmodel）',
  'provider.inherit': '继承端点',
  'provider.override': '覆盖端点',
  'provider.migrate': '迁移到 provider',
  'provider.migrateHint': '该模型与 provider「{p}」端点相同，可合并到分组',
  'provider.migrateDone': '已迁移',
  'provider.fetched': '获取到 {n} 个模型，勾选后添加',
  'provider.addSelected': '添加选中',
  'provider.fetchFail': '获取失败',
  'provider.fetchEmpty': '未获取到模型——检查 baseURL / API Key 是否正确。',
  'provider.fetching': '获取中…',
  'provider.selectHint': '勾选要启用的模型',
  'provider.saved': '✓ 已保存',
  'provider.defaultSet': '已设为默认',
  'provider.needDefault': '请先设置其它默认模型',
  'provider.noBaseURL': '请先填写 baseURL',
  'provider.emptyModels': '该分组还没有模型——点「获取模型列表」或直接输入模型名添加',
  'provider.emptyModelsFetch': '该分组还没有模型——点「获取模型列表」勾选启用',
  'provider.newName': '新建 provider 名称',
  // 模型列表表单字段 + 错误提示（本地化）
  'provider.fldBaseURL': 'baseURL',
  'provider.fldApiKey': 'API Key',
  'provider.fldEfforts': '思考级别选项',
  'provider.fldEffort': '当前级别',
  'provider.fldContext': '上下文长度',
  'provider.fldApiModel': 'apiModel',
  'provider.fldDisplay': '显示名',
  'provider.defaultBadge': '默认',
  'provider.errSave': '保存失败：{msg}',
  'provider.errDelete': '删除失败：{msg}',
  'provider.errAdd': '添加失败：{msg}',
  'provider.errMigrate': '迁移失败：{msg}',
  'provider.errSetDefault': '设为默认失败：{msg}',
  'provider.errFetch': '获取失败：{msg}',
  'settings.themeName': '界面主题',
  'settings.themeDesc': '亮色 / 暗色 / 跟随系统（跟随系统时随操作系统深浅色自动切换）。',
  'settings.statusbar': '状态栏',
  'settings.statusbarSub': '选择显示在输入区域下方的统计字段（同 CLI/TUI 底部统计行）。',
  'statusbar.speed': '首 token / 速率',
  'statusbar.cache': '缓存命中',
  'statusbar.tokens': '输入 / 输出 token',
  'statusbar.context': '上下文',
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
  'settings.variantsDesc': '逗号分隔，如 low,medium,high,xhigh,max；模型只支持这些级别，留空继承全局。',
  'settings.effortCurrent': '当前思考级别',
  'settings.effortCurrentDesc': '默认使用哪一个级别。',
  'settings.context': '上下文长度（context）',
  'settings.contextDesc': '模型的上下文窗口大小（token 数），如 128000。',
  'settings.version': '版本',
  'settings.server': '服务地址',
  'settings.tools': '可用工具',
  // 快捷键
  'settings.shortcuts': '快捷键',
  'settings.shortcutsSub': '查看并自定义所有键盘快捷键：点击「录制」按下组合键绑定，Backspace 清除，Esc 取消；冲突自动检测。',
  'shortcut.groupSessions': '会话',
  'shortcut.groupView': '视图',
  'shortcut.groupClipboard': '剪贴板',
  'shortcut.groupModel': '模型',
  'shortcut.groupPermission': '权限',
  'shortcut.groupSystem': '系统',
  'shortcut.groupCommands': '命令',
  'shortcut.record': '录制',
  'shortcut.recording': '请按下组合键…',
  'shortcut.enabled': '启用',
  'shortcut.disabled': '已禁用',
  'shortcut.unbound': '未绑定',
  'shortcut.conflict': '冲突：{combo} 已绑定到「{label}」',
  'shortcut.restore': '恢复默认',
  'shortcut.restoreConfirm': '恢复全部默认快捷键？',
  'shortcut.cheatsheetTitle': '快捷键速查表',
  'shortcut.cheatsheetHint': '可在 设置 → 快捷键 重新绑定',
  'shortcut.switchTitle': '切换会话',
  'shortcut.switchPlaceholder': '搜索会话，无匹配时 Enter 新建…',
  'shortcut.switchEmpty': '无匹配会话 · Enter 新建',
  'shortcut.newSession': '新建会话',
  'shortcut.newSessionDesc': '创建新会话（运行中也可用，不打断当前任务）',
  'shortcut.sessionSwitch': '会话快速切换',
  'shortcut.sessionSwitchDesc': '弹出会话切换面板：输入过滤，无匹配时 Enter 新建',
  'shortcut.sessionActions': '会话操作菜单',
  'shortcut.sessionActionsDesc': '分叉 / 导出 / 检查点 / 重命名 / 删除',
  'shortcut.stopTask': '停止当前任务',
  'shortcut.stopTaskDesc': '中断正在运行的 agent 回合',
  'shortcut.toggleSidebar': '切换侧边栏',
  'shortcut.toggleSidebarDesc': '展开 / 收起左侧会话栏（桌面布局）',
  'shortcut.focusSearch': '聚焦会话搜索',
  'shortcut.focusSearchDesc': '聚焦侧栏会话搜索框（焦点不在输入框时）',
  'shortcut.cycleTheme': '切换明暗主题',
  'shortcut.cycleThemeDesc': '亮色 → 暗色 → 跟随系统 循环',
  'shortcut.fullscreen': '全屏切换',
  'shortcut.fullscreenDesc': '进入 / 退出浏览器全屏',
  'shortcut.scrollTop': '滚动到顶部',
  'shortcut.scrollTopDesc': '消息区滚动到顶部',
  'shortcut.scrollBottom': '滚动到底部',
  'shortcut.scrollBottomDesc': '消息区滚动到底部',
  'shortcut.copyLastReply': '复制最后回复',
  'shortcut.copyLastReplyDesc': '复制最后一条助手回复到剪贴板',
  'shortcut.copyTitle': '复制会话标题',
  'shortcut.copyTitleDesc': '复制当前会话标题到剪贴板',
  'shortcut.copyId': '复制会话 ID',
  'shortcut.copyIdDesc': '复制当前会话 ID 到剪贴板',
  'shortcut.openModelPanel': '打开模型面板',
  'shortcut.openModelPanelDesc': '切换模型与思考级别面板',
  'shortcut.cyclePermission': '循环切换权限',
  'shortcut.cyclePermissionDesc': '只读 → 危险询问 → 全询问 → 全量直通（静默）',
  'shortcut.openSettings': '打开设置',
  'shortcut.openSettingsDesc': '打开设置弹窗',
  'shortcut.cheatsheet': '快捷键速查表',
  'shortcut.cheatsheetDesc': '查看全部快捷键与当前绑定',
  'shortcut.planMode': '切换计划模式',
  'shortcut.planModeDesc': '只读调研模式开关',
  'shortcut.searchPlaceholder': '搜索功能或快捷键…（点击条目可到设置里重新绑定）',
  'shortcut.jumpToSettings': '点击在 设置 → 快捷键 中重新绑定',
  'shortcut.noMatch': '没有匹配「{q}」的快捷键——试试功能名、分组或键位（如 ⌘K）',
  // 模态框
  'modal.rewindTitle': '会话检查点（/rewind）',
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
  'composer.attach': 'Select files/images',
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
  // attachments
  'attach.remove': 'Remove attachment',
  'attach.imageTooLarge': '⚠ Image exceeds 4MB limit, skipped: {name}',
  'attach.modelNoImage': '⚠ Current model does not support images; converted to a path attachment: {name}',
  'attach.truncated': '(truncated; use read_file for the full file)',
  'attach.running': '⚠ Cannot attach files while running — wait for the current reply to finish',
  'attach.image': 'Image',
  'perm.full': 'Full access',
  'perm.safe': 'Auto-approve',
  'perm.ask': 'Ask to approve',
  'perm.read': 'Read only',
  'perm.readDesc': 'Only read files and browse directories; no writing or command execution',
  'perm.head': 'How should we approve actions?',
  'perm.more': 'Learn more',
  'perm.askDesc': 'Always ask when editing external files and using the internet',
  'perm.safeDesc': 'Ask only for detected risky actions',
  'perm.fullDesc': 'Unrestricted access to the internet and any file on your computer',
  'perm.fullTitle': 'Full access',
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
  'thinking.running': 'thinking · {dur}',
  'thinking.done': 'thinking · {n} chars · {dur}',
  'thinking.collapsed': 'thinking · {dur}',
  'tool.running': 'Running',
  'tool.failed': 'Failed',
  'tool.noOutput': '(no output)',
  'tool.nchars': '{n} chars',
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
  'settings.apikeySub': 'Configure endpoints, keys, reasoning levels and context length. Supports providers groups (one endpoint with multiple models) — same fields as providers in omni.json, saved to the global config file.',
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
  'settings.concurrency': 'Max concurrent sessions',
  'settings.concurrencyDesc': 'Number of sessions allowed to run simultaneously (1-16). New messages queue when at limit.',
  // providers
  'provider.ungrouped': 'Ungrouped',
  'provider.new': '+ New provider',
  'provider.empty': 'Select a provider on the left or an ungrouped model to edit',
  'provider.baseURL': 'Endpoint (baseURL)',
  'provider.baseURLDesc': 'OpenAI-compatible API address, e.g. <code>https://api.deepseek.com/v1</code>.',
  'provider.apiKey': 'API Key',
  'provider.apiKeyDesc': 'The key is masked; click the eye to reveal it.',
  'provider.eye': 'Show/Hide API key',
  'provider.fetch': 'Fetch models',
  'provider.save': 'Save',
  'provider.delete': 'Delete',
  'provider.userAgent': 'User-Agent',
  'provider.userAgentDesc': 'Some gateways require a custom User-Agent to bypass WAF.',
  'provider.models': 'Models in group',
  'provider.modelsCount': '{n} models',
  'provider.addModel': 'Add',
  'provider.setDefault': 'Set default',
  'provider.edit': 'Edit',
  'provider.removeModel': 'Delete model',
  'provider.removeConfirm': 'Delete model "{name}"?',
  'provider.removeProviderConfirm': 'Delete provider "{name}" and all its models?',
  'provider.namePlaceholder': 'Provider name (e.g. bigmodel)',
  'provider.inherit': 'Inherit endpoint',
  'provider.override': 'Override endpoint',
  'provider.migrate': 'Migrate to provider',
  'provider.migrateHint': 'Same endpoint as provider "{p}" — can be merged into the group',
  'provider.migrateDone': 'Migrated',
  'provider.fetched': 'Got {n} models; check the ones to enable',
  'provider.addSelected': 'Add selected',
  'provider.fetchFail': 'Fetch failed',
  'provider.fetchEmpty': 'No models returned — check baseURL / API key.',
  'provider.fetching': 'Fetching…',
  'provider.selectHint': 'Check models to enable',
  'provider.saved': '✓ Saved',
  'provider.defaultSet': 'Set as default',
  'provider.needDefault': 'Set another default model first',
  'provider.noBaseURL': 'Fill in baseURL first',
  'provider.emptyModels': 'No models yet — click "Fetch models" above or type a model name to add',
  'provider.emptyModelsFetch': 'No models yet — click "Fetch models" and check the ones to enable',
  'provider.newName': 'New provider name',
  // model list form fields + error messages (localization)
  'provider.fldBaseURL': 'baseURL',
  'provider.fldApiKey': 'API Key',
  'provider.fldEfforts': 'Reasoning efforts',
  'provider.fldEffort': 'Current effort',
  'provider.fldContext': 'Context length',
  'provider.fldApiModel': 'apiModel',
  'provider.fldDisplay': 'Display name',
  'provider.defaultBadge': 'Default',
  'provider.errSave': 'Save failed: {msg}',
  'provider.errDelete': 'Delete failed: {msg}',
  'provider.errAdd': 'Add failed: {msg}',
  'provider.errMigrate': 'Migrate failed: {msg}',
  'provider.errSetDefault': 'Set default failed: {msg}',
  'provider.errFetch': 'Fetch failed: {msg}',
  'settings.themeName': 'UI theme',
  'settings.themeDesc': 'Light / Dark / System (system follows the OS color scheme).',
  'settings.statusbar': 'Status bar',
  'settings.statusbarSub': 'Choose which stats appear below the input area (same as the CLI/TUI footer stats).',
  'statusbar.speed': 'First token / Rate',
  'statusbar.cache': 'Cache hit',
  'statusbar.tokens': 'In / Out tokens',
  'statusbar.context': 'Context',
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
  'settings.variantsDesc': 'Comma-separated, e.g. low,medium,high,xhigh,max; the model only supports these. Leave empty to inherit global.',
  'settings.effortCurrent': 'Current level',
  'settings.effortCurrentDesc': 'Which level to use by default.',
  'settings.context': 'Context length',
  'settings.contextDesc': 'Model context window size (tokens), e.g. 128000.',
  'settings.version': 'Version',
  'settings.server': 'Server',
  'settings.tools': 'Available tools',
  'modal.rewindTitle': 'Session checkpoints (/rewind)',
  'modal.dirTitle': 'Choose workspace',
  'modal.up': 'Up',
  'modal.cancel': 'Cancel',
  'modal.select': 'Select this folder',
  'modal.close': 'Close',
  // Shortcuts
  'settings.shortcuts': 'Shortcuts',
  'settings.shortcutsSub': 'View and customize keyboard shortcuts: click Record and press a combination to bind, Backspace to clear, Esc to cancel; conflicts are detected automatically.',
  'shortcut.groupSessions': 'Sessions',
  'shortcut.groupView': 'View',
  'shortcut.groupClipboard': 'Clipboard',
  'shortcut.groupModel': 'Model',
  'shortcut.groupPermission': 'Permission',
  'shortcut.groupSystem': 'System',
  'shortcut.groupCommands': 'Commands',
  'shortcut.record': 'Record',
  'shortcut.recording': 'Press keys…',
  'shortcut.enabled': 'Enabled',
  'shortcut.disabled': 'Disabled',
  'shortcut.unbound': 'Unbound',
  'shortcut.conflict': 'Conflict: {combo} is already bound to "{label}"',
  'shortcut.restore': 'Restore defaults',
  'shortcut.restoreConfirm': 'Restore all default shortcuts?',
  'shortcut.cheatsheetTitle': 'Keyboard shortcuts',
  'shortcut.cheatsheetHint': 'Rebind in Settings → Shortcuts',
  'shortcut.switchTitle': 'Switch session',
  'shortcut.switchPlaceholder': 'Search sessions; Enter creates a new one when no match…',
  'shortcut.switchEmpty': 'No matching session · Enter to create',
  'shortcut.newSession': 'New session',
  'shortcut.newSessionDesc': 'Create a new session (works while running)',
  'shortcut.sessionSwitch': 'Quick session switch',
  'shortcut.sessionSwitchDesc': 'Open the session switcher; filter to pick, Enter to create when no match',
  'shortcut.sessionActions': 'Session actions',
  'shortcut.sessionActionsDesc': 'Fork / export / checkpoints / rename / delete',
  'shortcut.stopTask': 'Stop current task',
  'shortcut.stopTaskDesc': 'Interrupt the running agent turn',
  'shortcut.toggleSidebar': 'Toggle sidebar',
  'shortcut.toggleSidebarDesc': 'Expand / collapse the session sidebar (desktop)',
  'shortcut.focusSearch': 'Focus session search',
  'shortcut.focusSearchDesc': 'Focus the sidebar session search (when not typing)',
  'shortcut.cycleTheme': 'Cycle theme',
  'shortcut.cycleThemeDesc': 'Light → dark → system',
  'shortcut.fullscreen': 'Toggle fullscreen',
  'shortcut.fullscreenDesc': 'Enter / exit browser fullscreen',
  'shortcut.scrollTop': 'Scroll to top',
  'shortcut.scrollTopDesc': 'Scroll message area to top',
  'shortcut.scrollBottom': 'Scroll to bottom',
  'shortcut.scrollBottomDesc': 'Scroll message area to bottom',
  'shortcut.copyLastReply': 'Copy last reply',
  'shortcut.copyLastReplyDesc': 'Copy the last assistant reply',
  'shortcut.copyTitle': 'Copy session title',
  'shortcut.copyTitleDesc': 'Copy the current session title',
  'shortcut.copyId': 'Copy session ID',
  'shortcut.copyIdDesc': 'Copy the current session ID',
  'shortcut.openModelPanel': 'Open model panel',
  'shortcut.openModelPanelDesc': 'Open the model & reasoning-level panel',
  'shortcut.cyclePermission': 'Cycle permission',
  'shortcut.cyclePermissionDesc': 'read → safe → ask → full (silent)',
  'shortcut.openSettings': 'Open settings',
  'shortcut.openSettingsDesc': 'Open the settings dialog',
  'shortcut.cheatsheet': 'Shortcut cheatsheet',
  'shortcut.cheatsheetDesc': 'View all shortcuts and current bindings',
  'shortcut.planMode': 'Toggle plan mode',
  'shortcut.planModeDesc': 'Read-only research mode',
  'shortcut.searchPlaceholder': 'Search feature or shortcut… (click an item to rebind in settings)',
  'shortcut.jumpToSettings': 'Click to rebind in Settings → Shortcuts',
  'shortcut.noMatch': 'No shortcut matches "{q}" — try a feature name, group, or key like ⌘K',
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
  renderStatusbarSettings();
  updateComposerStatus();
  renderThemeOptions(state.status?.webTheme || getStoredTheme() || 'system');
  renderShortcutsSettings();
  const lg = $('#set-language');
  if (lg) lg.value = state.language;
  return state.language;
}

function setEmptyState(empty) {
  $('#app').classList.toggle('empty-session', empty);
  updateInputPlaceholder();
}

/** 输入框 placeholder：运行中显示「运行中 · Enter 排队 · ⌘/Ctrl+Enter 打断」（含排队数），
 *  直到当前消息结束（run.end）恢复「随心输入」。 */
function updateInputPlaceholder() {
  const input = $('#input');
  if (!input) return;
  const queued = state.messageQueue.length + (state.steerText ? 1 : 0);
  if (sessionRunning()) {
    input.placeholder = queued
      ? t('composer.runningQueued', { n: queued })
      : t('composer.running');
  } else {
    input.placeholder = t('composer.input');
  }
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
/** 滚动容器：.scroll-body（#messages 是它的 flex 子元素，自身不滚动） */
const _scrollBody = () => document.querySelector('.scroll-body');

function makeBlock(type, sessionId) {
  const id = `${sessionId}-${type}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
  const b = { id, type, sessionId };
  state.blocks.set(id, b);
  return b;
}

// 滚动到底部：force = 无条件滚；否则只在 autoFollow 态滚（用户上滚后暂停跟随）
function scrollBottom(force) {
  const sb = _scrollBody();
  if (sb && (force || state.autoFollow)) {
    sb.scrollTop = sb.scrollHeight;
  }
}
// scroll 事件：检测用户手动上滚 / 回底——上滚即暂停自动跟随，回底恢复
function initScrollFollow() {
  const sb = _scrollBody();
  if (!sb) return;
  sb.addEventListener('scroll', () => {
    const dist = sb.scrollHeight - sb.scrollTop - sb.clientHeight;
    // 60px：轻微滚轮一格（约 100px）即视为用户主动上滑打断跟随，回底恢复
    if (dist > 60) state.autoFollow = false;
    else state.autoFollow = true;
  }, { passive: true });
}

/* 助手消息块（流式光标：打字机效果，注入 span 到最后一个文本块末尾，与字符同行） */
function assistantBlock(sessionId) {
  setEmptyState(false);
  const b = makeBlock('assistant', sessionId);
  const wrap = el('div', 'msg assistant');
  const body = el('div', 'md-body');
  wrap.appendChild(body);
  msgList().appendChild(wrap);
  b._streaming = true; // paint 时向最后一个文本块末尾注入 .stream-cursor span
  b.stopCursor = () => {
    if (!b._streaming) return;
    b._streaming = false;
    b.paint(); // 重绘：移除光标 span
  };
  b._text = '';
  b._body = body;
  b._dirty = false;
  b.paint = () => {
    body.innerHTML = mdToHtml(b._text);
    if (b._streaming) appendStreamCursor(body);
    scrollBottom();
  };
  return b;
}

/** 流式光标：在最后一个有内容的文本块末尾注入内联竖条 span（打字机效果，
 *  与最后一个字符同行、随流式移动）。光标是真实 span（不是 ::after 伪元素——
 *  ::after 位于 md-body 末尾 = 最后一个块级 </p> 之后，会落到下一行） */
function appendStreamCursor(body) {
  body.querySelectorAll('.stream-cursor').forEach((c) => c.remove());
  const blocks = [...body.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, blockquote, td, code, pre')];
  const cur = document.createElement('span');
  cur.className = 'stream-cursor';
  if (blocks.length > 0) blocks[blocks.length - 1].appendChild(cur);
  else body.appendChild(cur);
}

/* 用户消息块（可选附件：图片缩略图 / 文件标签，随后接正文文本） */
function userBlock(sessionId, text, attachments) {
  setEmptyState(false);
  const b = makeBlock('user', sessionId);
  const wrap = el('div', 'msg user');
  const bubble = el('div', 'bubble');
  if (attachments && attachments.length) {
    const row = el('div', 'bubble-attachments');
    attachments.forEach((a) => {
      if (a.kind === 'image') {
        const img = document.createElement('img');
        img.className = 'bubble-img';
        img.src = a.dataUrl;
        img.alt = a.name || t('attach.image');
        img.title = a.name || t('attach.image');
        row.appendChild(img);
      } else {
        row.appendChild(el('span', 'bubble-file', (a.kind === 'text' ? '📄 ' : '📎 ') + (a.name || '')));
      }
    });
    bubble.appendChild(row);
  }
  if (text) bubble.appendChild(document.createTextNode(text));
  wrap.appendChild(bubble);
  msgList().appendChild(wrap);
  state.autoFollow = true; // 用户发消息 → 恢复跟随
  scrollBottom(true);
  return b;
}

/* ---------------- 附件（+ 选择器 / 拖拽；图片压缩 / 文本截断 / 路径占位） ---------------- */
const TEXT_EXT = /\.(md|txt|json|js|mjs|cjs|ts|tsx|jsx|py|go|rs|rb|java|c|h|cpp|hpp|cs|sh|bash|zsh|yml|yaml|toml|ini|cfg|xml|html|css|scss|sql|csv|log|env|conf|gitignore|dockerfile)$/i;
const IMAGE_MAX_BYTES = 4 * 1024 * 1024; // 单图上限（D5）
const ATTACH_TEXT_MAX = 30 * 1024; // 文本附件注入上限（D6，同 preloadMaxBytes）
let _attachSeq = 0;
function attachId() { return 'a' + Date.now().toString(36) + (++_attachSeq); }
function formatFileSize(n) {
  if (!n) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
function isTextFile(file) {
  if (file.type && file.type.startsWith('text/')) return true;
  if (TEXT_EXT.test(file.name)) return true;
  return false;
}
/** 当前模型是否支持图片（D7）：models 表无 capabilities 时按支持处理 */
function modelSupportsImage() {
  const st = state.status || {};
  const m = (st.models || []).find((x) => x.name === st.model);
  if (!m || !m.capabilities) return true;
  const mods = m.capabilities.modalities || [];
  return mods.includes('image') || mods.includes('input_image');
}
/** 图片压缩：canvas 等比缩放长边 ≤1024（PNG 带透明保留 PNG，其余 JPEG 0.85） */
function compressImage(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const MAX = 1024;
      const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      const isPng = file.type === 'image/png';
      resolve(canvas.toDataURL(isPng ? 'image/png' : 'image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}
/** 处理选中的文件（+ 按钮 / 拖拽共用）：图片→压缩 dataUrl，文本→注入内容，其它→路径占位 */
async function handleAttachFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  for (const file of files) {
    if (file.type.startsWith('image/')) {
      if (!modelSupportsImage()) {
        state.attachments.push({ id: attachId(), kind: 'path', name: file.name, size: file.size });
        metaLine(state.session, [t('attach.modelNoImage', { name: file.name })]);
        continue;
      }
      if (file.size > IMAGE_MAX_BYTES) {
        metaLine(state.session, [t('attach.imageTooLarge', { name: file.name })]);
        continue;
      }
      const dataUrl = await compressImage(file);
      if (!dataUrl) { metaLine(state.session, [`⚠ 无法读取图片：${file.name}`]); continue; }
      state.attachments.push({ id: attachId(), kind: 'image', name: file.name, size: file.size, dataUrl });
    } else if (isTextFile(file)) {
      let content = '';
      try { content = await file.text(); } catch { content = ''; }
      if (!content) { state.attachments.push({ id: attachId(), kind: 'path', name: file.name, size: file.size }); continue; }
      if (content.length > ATTACH_TEXT_MAX) content = content.slice(0, ATTACH_TEXT_MAX) + '\n' + t('attach.truncated');
      state.attachments.push({ id: attachId(), kind: 'text', name: file.name, size: file.size, content });
    } else {
      state.attachments.push({ id: attachId(), kind: 'path', name: file.name, size: file.size });
    }
  }
  renderAttachList();
}
/** 附件条渲染（输入框上方）：图片缩略图 / 名称+大小，每条 × 移除 */
function renderAttachList() {
  const list = $('#attach-list');
  if (!list) return;
  const atts = state.attachments;
  if (!atts.length) { list.classList.add('hidden'); list.innerHTML = ''; return; }
  list.classList.remove('hidden');
  list.innerHTML = '';
  atts.forEach((a) => {
    const chip = el('div', 'attach-chip' + (a.kind === 'image' ? ' is-image' : ''));
    if (a.kind === 'image') {
      const img = document.createElement('img');
      img.src = a.dataUrl; img.alt = a.name;
      chip.appendChild(img);
    } else {
      chip.appendChild(el('span', 'attach-icon', a.kind === 'text' ? '📄' : '📎'));
    }
    const meta = el('div', 'attach-meta');
    meta.appendChild(el('span', 'attach-name', a.name));
    if (a.size) meta.appendChild(el('span', 'attach-size', formatFileSize(a.size)));
    chip.appendChild(meta);
    const rm = el('button', 'attach-remove', '×');
    rm.type = 'button';
    rm.title = t('attach.remove');
    rm.addEventListener('click', () => {
      state.attachments = state.attachments.filter((x) => x.id !== a.id);
      renderAttachList();
      updateComposer();
    });
    chip.appendChild(rm);
    list.appendChild(chip);
  });
}
/** 解析会话历史里的用户消息 content（字符串或数组）→ { text, attachments }（历史恢复最小渲染） */
function parseUserContent(content) {
  if (typeof content === 'string') return { text: content, attachments: [] };
  if (!Array.isArray(content)) return { text: '', attachments: [] };
  const attachments = [];
  let text = '';
  content.forEach((p) => {
    if (!p || typeof p !== 'object') return;
    if (p.type === 'image_url') {
      const url = (p.image_url && typeof p.image_url.url === 'string') ? p.image_url.url : '';
      attachments.push({ id: attachId(), kind: 'image', name: t('attach.image'), dataUrl: url.startsWith('data:image/') ? url : '' });
    } else if (p.type === 'text' && typeof p.text === 'string') {
      const m = p.text.match(/^【附件：(.+?)】\n([\s\S]*)$/);
      if (m) {
        attachments.push({ id: attachId(), kind: 'text', name: m[1], content: m[2] });
      } else if (p.text.startsWith('[附件：')) {
        const nm = p.text.replace(/^\[附件：(.+?)（[\s\S]*$/, '$1');
        attachments.push({ id: attachId(), kind: 'path', name: nm || '附件' });
      } else {
        text += p.text;
      }
    }
  });
  return { text, attachments };
}

/* 思考块 */
function thinkingBlock(sessionId) {
  setEmptyState(false);
  const b = makeBlock('thinking', sessionId);
  const wrap = el('div', 'msg');
  const box = el('div', 'thinking running');
  // 默认展开；head 用 `- thinking · 耗时` 风格（running 时 spinner 替代 `-`，耗时实时走）
  const head = el('div', 'th-head');
  const icon = el('span', 'th-icon');
  const label = el('span', 'th-label');
  head.appendChild(icon); head.appendChild(label);
  const body = el('div', 'th-body');
  head.addEventListener('click', () => {
    const collapsed = body.classList.toggle('hidden');
    head.classList.toggle('collapsed', collapsed);
    updateThinkingHead(b, head, box);
    scrollBottom();
  });
  box.appendChild(head); box.appendChild(body);
  wrap.appendChild(box);
  msgList().appendChild(wrap);
  b._chars = 0;
  b._body = body;
  b._head = head;
  b._box = box;
  b._claimed = false; // SSE 是否已认领（doSend 预建空块 false；收到 start/chunk 后 true）
  b._startTime = Date.now();
  b._durMs = 0;
  box.dataset.startTime = String(b._startTime);
  updateThinkingHead(b, head, box);
  b.finish = () => {
    box.classList.remove('running');
    b._durMs = Date.now() - b._startTime;
    box.dataset.durMs = String(b._durMs);
    if (!b._chars) { wrap.remove(); return; } // 本轮无实际思考：移除预建空模块
    updateThinkingHead(b, head, box);
    if (!body.classList.contains('hidden')) scrollBottom();
  };
  return b;
}

/* thinking head 文本：running = `⠋ thinking · 实时耗时`（spinner）/ 完成展开 = `- thinking · N字符 · 耗时` / 收起 = `+ thinking · 耗时` */
function formatDuration(ms) {
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + 's';
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return m + 'm' + rs + 's';
}
function updateThinkingHead(b, head, box) {
  const icon = head.querySelector('.th-icon');
  const label = head.querySelector('.th-label');
  if (!icon || !label) return;
  const collapsed = head.classList.contains('collapsed');
  // running 时实时耗时；完成用终值
  const dur = b._durMs || (box.classList.contains('running') ? Date.now() - (b._startTime || Date.now()) : 0);
  const durStr = formatDuration(dur);
  if (collapsed) {
    icon.textContent = '+';
    label.textContent = t('thinking.collapsed', { dur: durStr });
  } else if (box.classList.contains('running')) {
    icon.textContent = SPIN[spinIdx % SPIN.length];
    icon.classList.add('spinning');
    label.textContent = t('thinking.running', { dur: durStr });
  } else {
    icon.textContent = '-';
    icon.classList.remove('spinning');
    label.textContent = t('thinking.done', { n: b._chars, dur: durStr });
  }
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
  };
  return b;
}

/* 从历史消息渲染已完成的 thinking 块（刷新恢复用：reasoning 已随 assistant 消息持久化） */
function renderHistoryThinking(sessionId, reasoning) {
  const b = thinkingBlock(sessionId);
  b._chars = String(reasoning || '').length;
  b._body.textContent = reasoning || '';
  b.finish(); // 立即置为「已完成」态（- thinking · N 字符 · 耗时）
  return b;
}

/* 从历史消息渲染已完成的工具卡片（刷新恢复用） */
function renderHistoryTool(sessionId, name, argsJson, output) {
  setEmptyState(false);
  const b = makeBlock('tool', sessionId);
  const wrap = el('div', 'msg');
  const card = el('div', 'tool-card');
  const head = el('div', 'tc-head');
  head.appendChild(el('span', 'tc-cmd', name || 'tool'));
  const st = el('span', 'tc-state');
  // 显示格式化后的命令预览（$ echo mock-ok / 文件路径）——刷新恢复后仍能认出「执行了哪条命令」
  let preview = argsJson || '';
  try { const a = JSON.parse(argsJson || '{}'); preview = formatToolArgs(name, a); } catch {}
  const chars = output ? output.length : 0;
  const charsTxt = chars ? t('tool.nchars', { n: chars }) : t('tool.noOutput');
  st.textContent = preview ? `${preview} · ${charsTxt}` : charsTxt;
  head.appendChild(st);
  const body = el('div', 'tc-body');
  body.classList.add('hidden');
  head.addEventListener('click', () => {
    document.querySelectorAll('.tool-card.selected').forEach((n) => n.classList.remove('selected'));
    card.classList.add('selected');
    body.classList.toggle('hidden');
    scrollBottom();
  });
  // 输出预览（前几行）
  if (output) {
    const lines = output.split('\n').slice(0, 12).join('\n');
    body.appendChild(el('div', 'tc-output', lines));
  }
  card.appendChild(head); card.appendChild(body);
  wrap.appendChild(card);
  msgList().appendChild(wrap);
  b._card = card;
  return b;
}

/* 工具参数预览（与实时 formatToolCall 一致） */
function formatToolArgs(name, a) {
  if (name === 'run_command' && a.command) return '$ ' + a.command.slice(0, 120);
  if ((name === 'read_file' || name === 'write_file') && a.path) return a.path;
  if (name === 'list_directory' && a.path) return a.path;
  if (name === 'search_code' && a.pattern) return a.pattern;
  return JSON.stringify(a).slice(0, 120);
}

/* meta 行（统计） */
function metaLine(sessionId, parts) {
  const b = makeBlock('meta', sessionId);
  const wrap = el('div', 'meta-line');
  parts.forEach((p) => wrap.appendChild(el('code', '', p)));
  msgList().appendChild(wrap);
  scrollBottom();
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
    // 组头：sticky 吸顶（iOS insetGrouped 风格），独立于组容器
    const head = el('button', 'ws-section-head' + (isCwd ? ' current' : '') + (expanded ? ' expanded' : ''));
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
      switchWorkspace(project).then(() => newSession()).catch((err) => alert(`切换工作目录失败：${err.message}`));
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
      if (expanded) state.expandedGroups.delete(project) || state.expandedGroups.add(`!${project}`);
      else state.expandedGroups.delete(`!${project}`) || state.expandedGroups.add(project);
      renderSessionList();
    });
    list.appendChild(head);

    if (!expanded) continue;
    // 组内容圆角容器（iOS insetGrouped 分组背景）
    const body = el('div', 'ws-section-body');
    for (const s of items) {
      const item = el('div', 'session-item' + (s.id === state.session ? ' active' : ''));
      // 运行中：不加绿点——左侧竖条改为彩色呼吸（.running::before；当前会话仍以背景高亮区分）
      if (state.runningSessions.has(s.id) || state._localRunning.has(s.id)) item.classList.add('running');
      const d = new Date(s.updated || s.created);
      const ts = `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
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
      body.appendChild(item);
    }
    list.appendChild(body);
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

/* —— 快捷键弹窗：⌘K 会话切换 + ⌘/ 速查表 —— */
$('#btn-close-sw').addEventListener('click', closeSessionSwitch);
$('#session-switch-modal').addEventListener('click', (e) => { if (e.target === $('#session-switch-modal')) closeSessionSwitch(); });
$('#btn-close-sc').addEventListener('click', () => $('#shortcuts-modal').classList.add('hidden'));
$('#shortcuts-modal').addEventListener('click', (e) => { if (e.target === $('#shortcuts-modal')) $('#shortcuts-modal').classList.add('hidden'); });
// ⌘/ 速查表可搜索：输入即过滤（按功能名/描述/分组/绑定键），点击条目跳到 设置 → 快捷键 对应项
$('#sc-search').addEventListener('input', (e) => { scFilter = e.target.value; openCheatsheet(); });
$('#sw-search').addEventListener('input', (e) => { swFilter = e.target.value; swSelIdx = 0; renderSessionSwitch(); });
$('#sw-search').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); swSelIdx = Math.min(swSelIdx + 1, Math.max(swItems.length - 1, 0)); renderSessionSwitch(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); swSelIdx = Math.max(swSelIdx - 1, 0); renderSessionSwitch(); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    const s = swItems[swSelIdx];
    if (s) { pickSession(s); return; }
    // 无匹配 → 新建会话并发送输入文本（D5：Enter 直接新建）
    const text = swFilter.trim();
    closeSessionSwitch();
    if (text) newSession().then(() => doSend(text)).catch((err) => console.error(err));
  }
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
  updateDetails();
}

/** 清空当前会话的待发送队列（切换会话 / 新建 / 删除时调用，避免消息错发到别的会话） */
function clearPendingMessages() {
  state.messageQueue = [];
  state.steerText = null;
  const ql = $('#queue-list'); if (ql) { ql.classList.add('hidden'); ql.innerHTML = ''; }
  updateComposer();
}

function renderWelcome() {
  setEmptyState($('#messages').children.length === 0);
}

function updateDetails() {
  const st = state.status || {};
  const eff = st.reasoningEffort;
  $('#composer-model-label').textContent = st.model ? (eff ? `${st.model} · ${eff}` : st.model) : '—';
  $('#composer-mode').textContent = state.planMode ? '计划模式' : '标准模式';
  updatePermissionPill();
}

/* 权限 pill（composer 底栏左侧）：label 文本 + 配色类 */
function updatePermissionPill() {
  const st = state.status || {};
  const perm = st.permission || 'safe';
  const map = { full: t('perm.full'), safe: t('perm.safe'), ask: t('perm.ask'), read: t('perm.read') };
  const pl = $('#perm-label');
  if (pl) pl.textContent = map[perm] || perm;
  const pill = $('#btn-permission');
  if (pill) pill.className = 'perm-pill' + (perm === 'full' ? ' full' : perm === 'ask' ? ' ask' : perm === 'read' ? ' read' : '');
}

/* —— 权限 / 模型 pop 渲染 —— */
function closeAllComposerPops() {
  ['#permission-pop', '#model-pop'].forEach((sel) => {
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
    { v: 'read', title: t('perm.read'), desc: t('perm.readDesc'), icon: 'i-shield' },
    { v: 'safe', title: t('perm.safe'), desc: t('perm.safeDesc'), icon: 'i-shield' },
    { v: 'ask', title: t('perm.ask'), desc: t('perm.askDesc'), icon: 'i-shield' },
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
/** 从历史消息渲染会话内容（用户/思考/工具卡片/回答）——selectSession 与
 *  运行中刷新后的 run.end 回填共用；不清会话状态、不动待发送队列。 */
async function renderSessionHistory(id) {
  try {
    const data = await api(`/api/sessions/${id}/messages`);
    const s = state.sessions.find((x) => x.id === id);
    $('#chat-title').textContent = s?.title || (data.meta?.title) || '会话';
    data.messages.forEach((m) => {
      const txt = typeof m.content === 'string' ? m.content : '';
      if (m.role === 'user') {
        // 数组 content（图片/文本附件）：解析为附件 chips + 正文（历史恢复最小渲染）
        const parsed = parseUserContent(m.content);
        userBlock(id, parsed.text, parsed.attachments);
      } else if (m.role === 'assistant') {
        // 先恢复 thinking（reasoning 已持久化），再恢复工具卡片，最后正文——
        // 与实时 SSE 渲染顺序一致（user → thinking → tool → answer）
        if (m.reasoning) renderHistoryThinking(id, m.reasoning);
        if (m.tool_calls) {
          for (const tc of m.tool_calls) {
            // 找到对应的 tool result 消息
            const idx = data.messages.indexOf(m);
            const toolMsg = data.messages.slice(idx + 1).find(
              (mm) => mm.role === 'tool' && mm.tool_call_id === tc.id
            );
            const toolTxt = typeof toolMsg?.content === 'string' ? toolMsg.content : '';
            renderHistoryTool(id, tc.function?.name || 'tool', tc.function?.arguments || '', toolTxt);
          }
        }
        if (txt) {
          const b = assistantBlock(id);
          b._text = txt; b.paint(); b.stopCursor();
        }
      }
      // tool 消息已在 assistant 的 tool_calls 分支处理，跳过
    });
    renderWelcome();
    state.autoFollow = true; // 切换/恢复会话：回到底部跟随模式
    scrollBottom(true);
    // 切换到正在运行的会话：预建 thinking 块，后续 SSE 事件实时流入
    if (state.runningSessions.has(id)) {
      if (currentThinking) { currentThinking.finish(); currentThinking = null; }
      currentThinking = thinkingBlock(id);
      scrollBottom();
    }
  } catch (e) {
    console.error(e);
  }
}

async function selectSession(id, silent) {
  state.session = id;
  clearPendingMessages(); // 待发送消息属于上一个会话，切换后清空避免错发
  clearMessages();
  renderSessionList();
  // 若选中的会话正在运行（刷新/切回时）：记录「中途恢复」标记——run.end 后从
  // 完整历史重渲染，补齐刷新前已发出但尚未落盘的 thinking/tool 块
  state._restoredMidRun = state.runningSessions.has(id);
  await renderSessionHistory(id);
  updateDetails();
  updateComposer();
  updateStatusText();
  $('#app').classList.remove('sidebar-open');
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
  // 本地刚启动的会话（status 广播覆盖前）也算运行中——否则 doSend 后立刻收到
  // 空 runningSessions 的 status 事件会把圆环/取消态误切回空闲
  return !!(state.session && (state.runningSessions.has(state.session) || state._localRunning.has(state.session)));
}
function anyRunning() {
  return state.runningSessions.size > 0;
}
function updateStatusText() {
  // 对话页标题右侧状态提示已移除——连接状态统一由左侧栏版本号右侧的 top-status-dot 表达
  const topDot = $('#top-status-dot');
  if (topDot) {
    topDot.classList.toggle('ready', !!state.status);
    topDot.classList.remove('error');
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
    const topDot = $('#top-status-dot');
    if (topDot) topDot.title = s.cwd || '';
    $('#about-version').textContent = `v${s.version}`;
    $('#about-tools').textContent = s.tools.join(', ');
    $('#about-server').textContent = `http://${location.host}`;
    $('#plan-mode').checked = state.planMode;
    const sp = $('#set-plan');
    if (sp) sp.checked = state.planMode;
    $('#set-permission').value = s.permission || 'safe';
    const sc = $('#set-concurrency');
    if (sc) sc.value = String(s.concurrency || 3);
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
    state.statusline = Array.isArray(s.statusline) && s.statusline.length ? s.statusline : STATUS_DEFAULT;
    renderStatusbarSettings();
    updateComposerStatus();
  });
}

function updateComposer() {
  const send = $('#btn-send');
  const note = $('#composer-note');
  const curRun = sessionRunning();
  // 发送/停止合一：空闲 ↑ 发送；运行中 = 七彩圆环（转速随 token 速率，见 send-ring 逻辑）+ 红色可取消
  const use = send.querySelector('use');
  if (use) use.setAttribute('href', '#i-arrow-up');
  const ring = $('#send-ring');
  if (ring) {
    ring.classList.toggle('hidden', !curRun);
    if (curRun) startRunRing();
    else stopRunRing();
  }
  const sendSvg = send.querySelector('svg');
  if (sendSvg) sendSvg.classList.toggle('hidden', curRun); // 运行中隐藏箭头图标，露出圆环
  send.title = curRun ? t('composer.stop') : t('composer.send');
  send.classList.toggle('cancel', curRun);
  send.classList.remove('paused');
  send.disabled = false; // 运行中也保持可点（= 停止按钮）
  // 运行提示已移至输入框 placeholder（updateInputPlaceholder）；composer-note 只保留
  // 排队中/新会话/空态提示
  updateInputPlaceholder();
  if (curRun) {
    note.textContent = '';
  } else if (state.messageQueue.length + (state.steerText ? 1 : 0)) note.textContent = t('composer.queued', { n: state.messageQueue.length + (state.steerText ? 1 : 0) });
  else if (!state.session) note.textContent = t('composer.newChat');
  else note.textContent = '';
  // 渲染队列列表（steer + queue 合计 0 时隐藏）
  if (!state.messageQueue.length && !state.steerText) {
    const ql = $('#queue-list'); if (ql) ql.classList.add('hidden');
  } else renderQueueList();
  updateComposerStatus(); // 输入区下方状态行（会话切换/发送/结束即刷新）
}

/* ---- 运行中发送按钮：七彩圆环（首尾追逐）· 默认转速 + 随 token 速率加快 ----
 * 转速映射：每 400ms 统计窗口内收到的 thinking/answer chunk 字符数 →
 * 字符速率（chars/s）→ 单圈时长（越快的 token 速率 → 圈速越快，最快 RING_MIN_DUR）。
 * 无 token 流（思考停顿 / 工具执行）时自然衰减回默认速率。 */
const RING_DEFAULT_DUR = 1.4; // 秒/圈（默认速率）
const RING_MIN_DUR = 0.3;     // token 极快时的最快圈速
let _ringTimer = null;
let _ringChars = 0;
function _ringTick() {
  const ring = $('#send-ring');
  if (!ring || ring.classList.contains('hidden')) { _ringChars = 0; return; }
  const rate = _ringChars / 0.4; // chars/s（400ms 窗口）
  const dur = Math.max(RING_MIN_DUR, RING_DEFAULT_DUR / (1 + rate / 60));
  ring.style.animationDuration = `${dur.toFixed(2)}s`;
  _ringChars = 0; // 窗口重置
}
function startRunRing() {
  if (_ringTimer) return;
  _ringChars = 0;
  _ringTimer = setInterval(_ringTick, 400);
  _ringTick();
}
function stopRunRing() {
  if (_ringTimer) { clearInterval(_ringTimer); _ringTimer = null; }
  const ring = $('#send-ring');
  if (ring) ring.style.animationDuration = '';
}
/** 流式 chunk 到达时累计字符数（answer.chunk / thinking.chunk 事件调用） */
function noteTokenChunk(len) {
  _ringChars += len || 1;
}

/* ---- 输入区下方状态行（token 统计，同 CLI/TUI footer stats）----
 * 段位（rounds/llm/speed/cache/tokens）由设置 → 状态栏开关控制，顺序固定为
 * 定义顺序；每会话独立累计（sessionStats/sessionUsage Map，SSE 事件驱动）。 */
const STATUS_DEFAULT = ['speed', 'cache', 'tokens', 'context'];
const STATUS_SEGMENTS = [
  {
    id: 'speed', labelKey: 'statusbar.speed',
    build: (s, u) => {
      const firstAvg = s.firstTokenCount > 0 ? s.firstTokenSum / s.firstTokenCount / 1000 : 0;
      // 生成耗时优先 genMs；单 chunk 响应 genMs=0 → 回退 llmMs - firstTokenSum，1ms 下限防除零
      const gen = s.genMs > 0 ? s.genMs : Math.max(1, s.llmMs - s.firstTokenSum);
      const rate = gen > 0 ? Math.round(u.completion / (gen / 1000)) : 0;
      return `首 token 平均 ${firstAvg.toFixed(1)}s · ${rate} tok/s`;
    },
    buildEn: (s, u) => {
      const firstAvg = s.firstTokenCount > 0 ? s.firstTokenSum / s.firstTokenCount / 1000 : 0;
      const gen = s.genMs > 0 ? s.genMs : Math.max(1, s.llmMs - s.firstTokenSum);
      const rate = gen > 0 ? Math.round(u.completion / (gen / 1000)) : 0;
      return `First token avg ${firstAvg.toFixed(1)}s · ${rate} tok/s`;
    },
  },
  {
    id: 'cache', labelKey: 'statusbar.cache',
    build: (s, u) => `缓存命中 ${u.prompt > 0 ? Math.min(100, Math.round((s.cached / u.prompt) * 100)) : 0}%`,
    buildEn: (s, u) => `Cache hit ${u.prompt > 0 ? Math.min(100, Math.round((s.cached / u.prompt) * 100)) : 0}%`,
  },
  {
    id: 'tokens', labelKey: 'statusbar.tokens',
    build: (_s, u) => `输入 ${fmtCompact(u.prompt)} tok · 输出 ${fmtCompact(u.completion)} tok`,
    buildEn: (_s, u) => `In ${fmtCompact(u.prompt)} tok · Out ${fmtCompact(u.completion)} tok`,
  },
  {
    id: 'context', labelKey: 'statusbar.context',
    // 当前上下文 = 最近一次 LLM 请求的 prompt token（usage 事件覆盖）；模型配置 limit.context 时附 /上限
    build: (_s, u) => `上下文 ${fmtCompact(u.lastPrompt)}${contextLimit() ? `/${fmtCompact(contextLimit())}` : ''}`,
    buildEn: (_s, u) => `Context ${fmtCompact(u.lastPrompt)}${contextLimit() ? `/${fmtCompact(contextLimit())}` : ''}`,
  },
];
/** 当前模型 context 上限（config limit.context；未知返回 0）——footer context 段 `已用/上限` 用 */
function contextLimit() {
  const st = state.status;
  if (!st || !Array.isArray(st.models)) return 0;
  const cur = st.models.find((m) => m.name === st.model);
  return (cur && cur.limit && cur.limit.context) || 0;
}
function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  if (s >= 60) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${s}s`;
}
function fmtToolDur(ms) { return ms >= 60000 ? fmtDur(ms) : `${(ms / 1000).toFixed(1)}s`; }
function fmtCompact(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.round(n));
}
function statsOf(sid) {
  if (!state.sessionStats.has(sid)) {
    state.sessionStats.set(sid, { turns: 0, steps: 0, llmMs: 0, toolsMs: 0, firstTokenSum: 0, firstTokenCount: 0, genMs: 0, cached: 0 });
  }
  return state.sessionStats.get(sid);
}
function usageOf(sid) {
  if (!state.sessionUsage.has(sid)) {
    state.sessionUsage.set(sid, { prompt: 0, completion: 0, total: 0, cached: 0, lastPrompt: 0 });
  }
  return state.sessionUsage.get(sid);
}
/** 渲染输入区下方状态行：按 state.statusline（设置 → 状态栏）拼段，无数据/无段位时隐藏 */
function updateComposerStatus() {
  const el = $('#composer-status');
  if (!el) return;
  const order = Array.isArray(state.statusline) ? state.statusline : STATUS_DEFAULT;
  const s = state.session ? state.sessionStats.get(state.session) : null;
  const u = state.session ? state.sessionUsage.get(state.session) : null;
  if (!s || !u || !order.length) {
    el.textContent = '';
    el.classList.add('hidden');
    return;
  }
  const en = state.language === 'en';
  const segs = order
    .map((id) => STATUS_SEGMENTS.find((x) => x.id === id))
    .filter(Boolean)
    .map((sg) => (en ? sg.buildEn(s, u) : sg.build(s, u)));
  const text = segs.join('| ');
  el.textContent = text;
  el.classList.toggle('hidden', !text);
}
/** 设置 → 状态栏：每个段位一个 Switch（勾选即显示到输入区下方，持久化到配置 statusline） */
function renderStatusbarSettings() {
  const box = $('#statusbar-list');
  if (!box) return;
  box.innerHTML = '';
  const enabled = new Set(Array.isArray(state.statusline) ? state.statusline : STATUS_DEFAULT);
  STATUS_SEGMENTS.forEach((sg) => {
    const row = el('div', 'setting-row');
    const info = el('div', 'setting-info');
    info.appendChild(el('h4', null, t(sg.labelKey)));
    row.appendChild(info);
    const sw = document.createElement('input');
    sw.type = 'checkbox';
    sw.className = 'toggle-switch';
    sw.checked = enabled.has(sg.id);
    sw.addEventListener('change', () => {
      const set = new Set(Array.isArray(state.statusline) ? state.statusline : STATUS_DEFAULT);
      if (set.has(sg.id)) set.delete(sg.id);
      else set.add(sg.id);
      const next = STATUS_SEGMENTS.map((x) => x.id).filter((id) => set.has(id));
      state.statusline = next;
      applySettings({ statusline: next }).catch((err) => alert(`设置失败：${err.message}`));
      updateComposerStatus();
    });
    row.appendChild(sw);
    box.appendChild(row);
  });
}

/** 浏览新工作区：Electron 原生对话框；纯浏览器 → 页面内文件夹浏览器（服务端列目录，可导航到任意绝对路径）。
 *  浏览器 webkitdirectory 只能拿到所选文件夹的相对路径（File.path 只在 Electron 有），
 *  打开后还得再回退页面内浏览器，是多余的两步，因此纯浏览器直接走页面内目录浏览器。 */
function browseWorkspace() {
  if (window.omni && typeof window.omni.pickDirectory === 'function') {
    window.omni.pickDirectory()
      .then((dir) => {
        if (dir) switchWorkspace(dir).catch((err) => alert(`切换工作目录失败：${err.message}`));
      })
      // 原生对话框异常（IPC 崩溃 / 桥接失效）→ 回退页面内目录浏览器，而不是静默失败
      .catch(() => openDirPicker(state.status?.cwd || '/'));
    return;
  }
  openDirPicker(state.status?.cwd || '/');
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
    'workspace.changed', 'session.deleted',
  ].forEach(on);
  es.onerror = () => {
    const topDot = $('#top-status-dot');
    if (topDot) topDot.classList.add('error');
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
  state.statusline = Array.isArray(s.statusline) && s.statusline.length ? s.statusline : STATUS_DEFAULT;
  renderStatusbarSettings();
  updateComposerStatus();
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
  // steer 打断消息：loop 处理中断后经 onUserMessage 广播（无 steer 标记）。文本匹配
  // steerText 即消费「期望已插入」标记（run.end 不再补发），并渲染一次——消息只进当前轮
  // 一次（服务端 /steer 不再重复广播，修复「Cmd+Enter 一次发出两个」）
  if (state.steerText !== null && ev.text === state.steerText) {
    state.steerText = null;
    userBlock(ev.sessionId, ev.text);
    return;
  }
  // 乐观回显去重：doSend 已本地显示非 steer 用户消息，SSE 重复到达时跳过
  // 注意：纯附件消息 text 为空（''）时 _pendingUserText 仍非 null，用 !== null 而非 truthy 判定
  if (!ev.steer && state._pendingUserText !== null && ev.text === state._pendingUserText) {
    state._pendingUserText = null;
    return;
  }
  state._pendingUserText = null;
  userBlock(ev.sessionId, ev.text);
});

/* 一轮开始的 thinking 块：预建（等待真正的 reasoning chunk） */
let currentThinking = null;
bus.on('thinking.start', (ev) => {
  if (ev.sessionId !== state.session) return;
  if (currentThinking) {
    // doSend 预建的空块（尚未被 SSE 认领）→ 直接复用（位置已正确 user -> thinking，避免闪烁）；
    // 已是真实思考块（已认领/有内容）→ 新一轮 thinking 开始：收尾旧块、新建块——
    // 一次 LLM 回答可能含多个 thinking 段落（多步/交错/end 丢失），每个段落独立成块
    if (!currentThinking._claimed) { currentThinking._claimed = true; return; }
    currentThinking.finish();
    currentThinking = null;
  }
  currentThinking = thinkingBlock(ev.sessionId);
  currentThinking._claimed = true;
});
bus.on('thinking.chunk', (ev) => {
  if (ev.sessionId !== state.session) return;
  noteTokenChunk(ev.text.length);
  if (!currentThinking || !currentThinking._claimed) {
    if (currentThinking) currentThinking.finish(); // 预建空块（未认领）→ 移除，新建真实块
    currentThinking = thinkingBlock(ev.sessionId);
    currentThinking._claimed = true;
  }
  currentThinking._chars += ev.text.length;
  currentThinking._body.textContent += ev.text;
  scrollBottom();
});

/* spinner + 耗时驱动：thinking running 时每 100ms 刷新 head（spinner 帧 + 实时耗时） */
setInterval(() => {
  if (currentThinking && currentThinking._box?.classList.contains('running')) {
    spinIdx = (spinIdx + 1) % SPIN.length;
    updateThinkingHead(currentThinking, currentThinking._head, currentThinking._box);
  }
}, 100);
bus.on('thinking.end', (ev) => {
  if (ev.sessionId !== state.session) return;
  if (currentThinking) { currentThinking.finish(); currentThinking = null; }
});

let currentAssistant = null;
bus.on('answer.chunk', (ev) => {
  if (ev.sessionId !== state.session) return;
  noteTokenChunk(ev.text.length);
  if (!currentAssistant) currentAssistant = assistantBlock(ev.sessionId);
  currentAssistant._text += ev.text;
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
  statsOf(ev.sessionId).steps += 1;
  const block = toolBlock(ev.sessionId, ev);
  currentTools.set(ev.seq ?? `f${currentTools.size}`, block);
  state.inFlight++;
  updateComposerStatus();
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
  // 会话级累计（输入区下方状态行）
  const u = usageOf(ev.sessionId);
  u.prompt += ev.prompt || 0;
  u.completion += ev.completion || 0;
  u.total += ev.total || 0;
  u.cached += ev.cached || 0;
  u.lastPrompt = ev.prompt || 0; // 当前上下文 = 最近一次请求的 prompt token（footer context 段）
  updateComposerStatus();
});

bus.on('subagent', (ev) => {
  if (ev.sessionId !== state.session) return;
  if (ev.ev && ev.ev.type === 'start') {
    state.inFlight++;
  } else if (ev.ev && ev.ev.type === 'end') {
    state.inFlight--;
  }
});

bus.on('run.end', async (ev) => {
  state.runningSessions.delete(ev.sessionId);
  state._localRunning.delete(ev.sessionId);
  statsOf(ev.sessionId).turns += 1; // 状态行：轮次累计
  updateComposerStatus();
  if (ev.sessionId !== state.session) { refreshSessions(); return; }
  currentTools.clear(); // 取消/打断时部分工具可能无 result 到达，清理避免错配下一轮
  if (currentThinking) { currentThinking.finish(); currentThinking = null; }
  if (currentAssistant) {
    currentAssistant.paint();
    currentAssistant.stopCursor();
    currentAssistant = null;
  }
  // 刷新/切回期间恢复的会话（_restoredMidRun）：此时本轮已完整落盘——从历史重渲染，
  // 补齐刷新前已发出但未持久化的 thinking/tool 块（先于统计行，避免被覆盖）
  if (state._restoredMidRun) {
    state._restoredMidRun = false;
    await renderSessionHistory(ev.sessionId).catch(() => {});
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

  // 消费 steer（优先）→ queue → 下一轮自动发送；仅「成功完成」的轮次自动续发——
  // 出错/取消/超步数后不自动消费队列（避免同一 500 连环触发），留待用户手动重试
  const canAuto = ev.reason === 'completed';
  const next = canAuto ? (state.steerText || (state.messageQueue.length ? state.messageQueue.shift() : null)) : null;
  if (next) {
    state.steerText = null;
    renderQueueList();
    doSend(next);
  } else {
    if (canAuto && state.steerText) state.steerText = null; // 成功完成：steer 已插入本轮，清槽
    renderQueueList();
    updateComposer();
    updateStatusText();
  }
});

// turn.step：本轮第 N 步
bus.on('turn.step', (ev) => {
  if (ev.sessionId !== state.session) return;
});

// lap：LLM 请求墙钟 / 首 token / 生成耗时（tok/s 用 genMs——排除首 token 等待）
bus.on('lap', (ev) => {
  if (ev.sessionId !== state.session) return;
  const s = statsOf(ev.sessionId);
  s.llmMs += ev.llmMs || 0;
  if (ev.firstTokenMs != null) { s.firstTokenSum += ev.firstTokenMs; s.firstTokenCount++; }
  if (ev.genMs != null) s.genMs += ev.genMs;
  updateComposerStatus();
});

// toolsLap：工具执行墙钟
bus.on('toolsLap', (ev) => {
  if (ev.sessionId !== state.session) return;
  statsOf(ev.sessionId).toolsMs += ev.toolsMs || 0;
  updateComposerStatus();
});

// hook.output：Hook 输出回显
bus.on('hook.output', (ev) => {
  if (!ev.lines || !ev.lines.length) return;
  if (ev.sessionId && ev.sessionId !== state.session) return;
  metaLine(ev.sessionId || state.session, [`📎 ${ev.event || 'hook'}: ${ev.lines[0]}`]);
});

bus.on('error', (ev) => {
  if (ev.sessionId !== state.session) return;
  metaLine(ev.sessionId, [`✗ ${ev.model ? `[${ev.model}] ` : ''}${ev.message}`]);
  const topDot = $('#top-status-dot');
  if (topDot) topDot.classList.add('error');
  // 错误已知即停（不等 run.end）：立即收尾 thinking/回答块 + 复位发送按钮与 placeholder，
  // 避免「错误已显示但 spinner/圆环还在转」的中间态（慢持久化时 error 与 run.end 有间隙）
  state.runningSessions.delete(ev.sessionId);
  state._localRunning.delete(ev.sessionId);
  if (currentThinking) { currentThinking.finish(); currentThinking = null; }
  if (currentAssistant) { currentAssistant.stopCursor(); currentAssistant = null; }
  currentTools.clear();
  stopRunRing();
  updateComposer();
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
  { name: '/models', desc: '模型能力快照：/models refresh 在线更新（models.dev）' },
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
  { name: '/thinking', desc: '展开/收起全部思考过程' },
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
  if (cmd === '/thinking') {
    // 前端切换：展开/收起全部思考模块（不控制后端事件广播）
    state.thinkingCollapsed = !state.thinkingCollapsed;
    document.querySelectorAll('.thinking').forEach((box) => {
      const head = box.querySelector('.th-head');
      const body = box.querySelector('.th-body');
      if (!head || !body) return;
      body.classList.toggle('hidden', state.thinkingCollapsed);
      head.classList.toggle('collapsed', state.thinkingCollapsed);
      // 构造 block 对象用于 updateThinkingHead
      const b = { _chars: body.textContent?.length || 0, _startTime: 0, _durMs: 0 };
      // 从 DOM dataset 取 startTime
      const startTime = parseInt(box.dataset.startTime || '0');
      if (startTime) b._startTime = startTime;
      if (!box.classList.contains('running')) b._durMs = parseInt(box.dataset.durMs || '0');
      updateThinkingHead(b, head, box);
    });
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

/* ================= 快捷键系统（keyboard-shortcuts-spec.md） =================
 * 注册表驱动：⌘/ 速查表、设置-快捷键 pane、冲突检测、localStorage 持久化、
 * 全局分发全部由 SHORTCUT_FEATURES 派生——新增功能只需加一行。
 * 键位约定：跟随 DeepSeek Harness (dsh)——macOS ⌘ / 其它平台 Ctrl（平台中立 'Meta'）；
 * 组合键在输入框聚焦时也生效（D9），裸键（/、⇧Tab）仅焦点不在编辑区时触发。
 */

/* ==== shortcuts-pure-start ====（纯函数块，供探针单测，勿引用 DOM） */
const SHORTCUTS_STORAGE_KEY = 'omni-web-shortcuts-v1';
const GROUP_IDS = ['sessions', 'view', 'clipboard', 'model', 'permission', 'system', 'commands'];
const PERM_ORDER = ['read', 'safe', 'ask', 'full'];

/** 组合键解析：'Meta+Shift+M' → { mods:Set(['Meta','Shift']), key:'m' }；非法返回 null */
function parseCombo(str) {
  if (!str || typeof str !== 'string') return null;
  const parts = String(str).split('+');
  if (parts.length < 1) return null;
  const key = parts.pop().toLowerCase();
  if (!key) return null;
  return { mods: new Set(parts), key };
}
/** 标点键（长度 1 的非字母数字、非空格）：用于 ⇧ 上档布局归一化 */
function isPunctKey(key) {
  return key.length === 1 && !/[a-z0-9]/.test(key) && key !== ' ';
}
/** 事件 → 键名（布局无关：标点走 e.code 映射，字母小写化） */
function keyNameFromEvent(e) {
  if (e.key === ' ') return 'Space';
  if (e.key.length === 1 && e.code && e.code.startsWith('Key')) return e.key.toLowerCase();
  if (e.key.length === 1 && /^[0-9]$/.test(e.key)) return e.key;
  if (e.key.length === 1) {
    const codeMap = { Slash: '/', Period: '.', Comma: ',', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`' };
    if (e.code && codeMap[e.code]) return codeMap[e.code];
    return e.key.toLowerCase();
  }
  return e.key;
}
/** 事件 → 候选组合键列表（⌘ 与 Ctrl 平台中立为 'Meta'；标点键需 Shift 的布局去掉 Shift 再给一个变体） */
function comboVariants(e) {
  const mods = [];
  if (e.metaKey || e.ctrlKey) mods.push('Meta');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  const key = keyNameFromEvent(e);
  const primary = [...mods, key].join('+');
  const alt = mods.includes('Shift') && isPunctKey(key) ? mods.filter((m) => m !== 'Shift').concat(key).join('+') : null;
  return alt ? [primary, alt] : [primary];
}
function isModifierOnly(e) { return ['Meta', 'Control', 'Shift', 'Alt'].includes(e.key); }
function isEditableTarget(el) {
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}
/** 组合键结构相等（parseCombo 已小写化 key，'Meta+n' ≡ 'Meta+N'） */
function combosEqual(a, b) {
  if (a === b) return true;
  const pa = parseCombo(a);
  const pb = parseCombo(b);
  if (!pa || !pb) return false;
  if (pa.key !== pb.key || pa.mods.size !== pb.mods.size) return false;
  for (const m of pa.mods) if (!pb.mods.has(m)) return false;
  return true;
}
/** 组合键展示：macOS ⌘/⌥/⇧，其它平台 Ctrl/Alt/Shift */
function formatCombo(str) {
  if (!str) return '';
  const p = parseCombo(str);
  if (!p) return str;
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');
  const modLabels = { Meta: isMac ? '⌘' : 'Ctrl', Alt: isMac ? '⌥' : 'Alt', Shift: isMac ? '⇧' : 'Shift' };
  const keyLabel = p.key === ' ' ? 'Space'
    : p.key === 'arrowup' ? '↑' : p.key === 'arrowdown' ? '↓'
    : p.key === 'arrowleft' ? '←' : p.key === 'arrowright' ? '→'
    : p.key === 'tab' ? 'Tab' : p.key === 'enter' ? 'Enter' : p.key === 'escape' ? 'Esc'
    : p.key.length === 1 ? p.key.toUpperCase() : p.key;
  const parts = [...p.mods].map((m) => modLabels[m] || m).concat(keyLabel);
  return parts.join(isMac ? '' : '+');
}
/** localStorage 覆盖：{ [featureId]: combo | null }；缺省 = 用默认键；null = 禁用 */
function getShortcutOverrides(localStore) {
  try { return JSON.parse((localStore || localStorage).getItem(SHORTCUTS_STORAGE_KEY) || '{}') || {}; } catch { return {}; }
}
function setShortcutOverride(localStore, id, combo) {
  const o = getShortcutOverrides(localStore);
  if (combo === undefined) delete o[id];
  else o[id] = combo;
  try { (localStore || localStorage).setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(o)); } catch { /* 隐私模式等场景忽略 */ }
}
function getBinding(f, localStore) {
  const o = getShortcutOverrides(localStore);
  return Object.prototype.hasOwnProperty.call(o, f.id) ? o[f.id] : (f.defaultCombo || null);
}
/** 分发匹配：返回命中的 feature（含裸键编辑态过滤），无命中返回 null */
function matchShortcut(features, bindingOf, combo, editable) {
  for (const f of features) {
    const bind = bindingOf(f);
    if (!bind) continue;
    const hasMod = /(^|\+)Meta/.test(bind);
    if (!hasMod && editable) continue; // 裸键在输入框聚焦时不抢焦点（D9）
    if (combosEqual(combo, bind)) return f;
  }
  return null;
}
/** 冲突检测：其它已启用绑定里是否有同一组合键 */
function findShortcutClash(features, bindingOf, excludeId, combo) {
  for (const f of features) {
    if (f.id === excludeId) continue;
    if (combosEqual(bindingOf(f), combo)) return f;
  }
  return null;
}
/**
 * 速查表搜索匹配（纯函数）：功能 id / 分组 / 绑定键 + 调用方提供的可搜索文本
 * （featureLabel + featureDesc + 分组名，即 i18n 化的展示文案）任一处包含全部查询词。
 * 多词 AND（空格分隔）；空查询全部命中。
 */
function cheatsheetMatches(f, q, hayExtra) {
  if (!q) return true;
  const raw = getBinding(f) || '';
  // 原始绑定（Meta+K）+ 渲染键位（⌘K / Ctrl+K）都进搜索文本——两种输入习惯都能命中
  const hay = [f.id, f.group, raw, formatCombo(raw), hayExtra || ''].join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
}
/* ==== shortcuts-pure-end ==== */

const SHORTCUT_FEATURES = [
  { id: 'newSession', group: 'sessions', labelKey: 'shortcut.newSession', descKey: 'shortcut.newSessionDesc', defaultCombo: 'Meta+N', run: () => newSession().catch((e) => console.error(e)) },
  { id: 'sessionSwitch', group: 'sessions', labelKey: 'shortcut.sessionSwitch', descKey: 'shortcut.sessionSwitchDesc', defaultCombo: 'Meta+K', run: toggleSessionSwitch },
  { id: 'sessionActions', group: 'sessions', labelKey: 'shortcut.sessionActions', descKey: 'shortcut.sessionActionsDesc', defaultCombo: 'Meta+Shift+A', run: () => openSessionActionsMenu(state.session) },
  { id: 'stopTask', group: 'sessions', labelKey: 'shortcut.stopTask', descKey: 'shortcut.stopTaskDesc', defaultCombo: 'Meta+.', run: () => { if (sessionRunning()) cancelCurrentRun(); } },
  { id: 'toggleSidebar', group: 'view', labelKey: 'shortcut.toggleSidebar', descKey: 'shortcut.toggleSidebarDesc', defaultCombo: 'Meta+B', run: toggleSidebar },
  { id: 'focusSearch', group: 'view', labelKey: 'shortcut.focusSearch', descKey: 'shortcut.focusSearchDesc', defaultCombo: '/', run: focusSessionSearch },
  { id: 'cycleTheme', group: 'view', labelKey: 'shortcut.cycleTheme', descKey: 'shortcut.cycleThemeDesc', defaultCombo: 'Meta+Shift+L', run: cycleTheme },
  { id: 'fullscreen', group: 'view', labelKey: 'shortcut.fullscreen', descKey: 'shortcut.fullscreenDesc', defaultCombo: 'Meta+Shift+F', run: toggleFullscreen },
  { id: 'scrollTop', group: 'view', labelKey: 'shortcut.scrollTop', descKey: 'shortcut.scrollTopDesc', defaultCombo: 'Meta+ArrowUp', run: () => scrollMessages('top') },
  { id: 'scrollBottom', group: 'view', labelKey: 'shortcut.scrollBottom', descKey: 'shortcut.scrollBottomDesc', defaultCombo: 'Meta+ArrowDown', run: () => scrollMessages('bottom') },
  { id: 'copyLastReply', group: 'clipboard', labelKey: 'shortcut.copyLastReply', descKey: 'shortcut.copyLastReplyDesc', defaultCombo: 'Meta+Shift+M', run: copyLastReply },
  { id: 'copyTitle', group: 'clipboard', labelKey: 'shortcut.copyTitle', descKey: 'shortcut.copyTitleDesc', defaultCombo: 'Meta+Shift+Y', run: copySessionTitle },
  { id: 'copyId', group: 'clipboard', labelKey: 'shortcut.copyId', descKey: 'shortcut.copyIdDesc', defaultCombo: 'Meta+Shift+U', run: copySessionId },
  { id: 'openModelPanel', group: 'model', labelKey: 'shortcut.openModelPanel', descKey: 'shortcut.openModelPanelDesc', defaultCombo: 'Meta+M', run: () => togglePop('#model-pop') },
  { id: 'cyclePermission', group: 'permission', labelKey: 'shortcut.cyclePermission', descKey: 'shortcut.cyclePermissionDesc', defaultCombo: 'Shift+Tab', run: cyclePermission },
  { id: 'openSettings', group: 'system', labelKey: 'shortcut.openSettings', descKey: 'shortcut.openSettingsDesc', defaultCombo: 'Meta+,', run: openSettings },
  { id: 'cheatsheet', group: 'system', labelKey: 'shortcut.cheatsheet', descKey: 'shortcut.cheatsheetDesc', defaultCombo: 'Meta+/', run: toggleCheatsheet },
  { id: 'planMode', group: 'system', labelKey: 'shortcut.planMode', descKey: 'shortcut.planModeDesc', defaultCombo: 'Meta+Shift+P', run: togglePlanMode },
];
// 命令组：30+ 斜杠命令默认不绑键，可在 设置 → 快捷键 录制绑定（D16）
SLASH_COMMANDS.forEach((c) => {
  SHORTCUT_FEATURES.push({ id: 'cmd:' + c.name, group: 'commands', label: c.name, desc: c.desc, defaultCombo: null, run: () => runSlashCommand(c.name + ' ') });
});

function featureLabel(f) { return f.label || (f.labelKey ? t(f.labelKey) : f.id); }
function featureDesc(f) { return f.desc || (f.descKey ? t(f.descKey) : ''); }

/* —— run() 实现 —— */
function toggleSidebar() {
  if (window.innerWidth <= 760) return; // 移动端 overlay 侧栏不做（D15）
  $('#app').classList.toggle('sidebar-collapsed');
}
function focusSessionSearch() {
  // 收起态下搜索框不可见：先展开侧栏再聚焦（与点击搜索图标同语义）
  if ($('#app').classList.contains('sidebar-collapsed')) $('#app').classList.remove('sidebar-collapsed');
  $('#session-search').focus();
}
function cyclePermission() {
  const cur = state.status?.permission || 'safe';
  const next = PERM_ORDER[(PERM_ORDER.indexOf(cur) + 1) % PERM_ORDER.length] || 'read';
  applySettings({ permission: next }).catch((err) => alert(`设置失败：${err.message}`)); // 静默切换（D12），失败才提示
}
function cycleTheme() {
  const cur = getStoredTheme() || state.status?.webTheme || 'system';
  const order = ['light', 'dark', 'system'];
  const next = order[(order.indexOf(cur) + 1) % order.length] || 'light';
  applyTheme(next);
  storeTheme(next);
  api('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ webTheme: next }),
  }).catch(() => {});
}
function togglePlanMode() {
  const next = !state.planMode;
  state.planMode = next;
  $('#plan-mode').checked = next;
  const sp = $('#set-plan');
  if (sp) sp.checked = next;
  updateComposer();
  applySettings({ planMode: next }).catch((err) => alert(`设置失败：${err.message}`));
}
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen().catch(() => {});
}
function scrollMessages(dir) {
  const sb = document.querySelector('.scroll-body');
  if (!sb) return;
  sb.scrollTop = dir === 'top' ? 0 : sb.scrollHeight;
}
function copyText(text) {
  if (!text) return;
  if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(text).catch(() => {}); return; }
  const ta = el('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (e) { /* ignore */ }
  ta.remove();
}
function copyLastReply() {
  const blocks = document.querySelectorAll('#messages .msg.assistant');
  const last = blocks[blocks.length - 1];
  copyText(last ? last.textContent.trim() : '');
}
function copySessionTitle() { copyText($('#chat-title')?.textContent || ''); }
function copySessionId() { copyText(state.session || ''); }
function openSessionActionsMenu(session) {
  if (!session) return;
  const anchor = $('#chat-title') || document.body;
  const r = anchor.getBoundingClientRect();
  showSessionActions({ clientX: r.left + 24, clientY: r.bottom + 4 }, session);
}

/* —— ⌘K 会话快速切换面板（全部会话跨工作区；无匹配 Enter 新建） —— */
let swFilter = '';
let swSelIdx = 0;
let swItems = [];
function toggleSessionSwitch() {
  const m = $('#session-switch-modal');
  if (!m) return;
  if (m.classList.contains('hidden')) openSessionSwitch();
  else closeSessionSwitch();
}
function openSessionSwitch() {
  const inp = $('#sw-search');
  if (!inp) return;
  $('#session-switch-modal').classList.remove('hidden');
  inp.value = '';
  swFilter = '';
  swSelIdx = 0;
  renderSessionSwitch();
  inp.focus();
}
function closeSessionSwitch() { $('#session-switch-modal').classList.add('hidden'); }
function renderSessionSwitch() {
  const list = $('#sw-list');
  if (!list) return;
  const q = swFilter.trim().toLowerCase();
  swItems = q
    ? state.sessions.filter((s) => (s.title || s.id || '').toLowerCase().includes(q))
    : state.sessions.slice();
  list.innerHTML = '';
  if (!swItems.length) {
    list.appendChild(el('div', 'sw-empty', t('shortcut.switchEmpty')));
    return;
  }
  swItems.forEach((s, i) => {
    const row = el('div', 'sw-item' + (i === swSelIdx ? ' selected' : ''));
    row.appendChild(el('div', 'sw-title', s.title || t('session.new')));
    row.appendChild(el('div', 'sw-meta', `${projectName(s.project || '(未知工作区)')} · ${s.messages || 0} 条消息`));
    row.addEventListener('click', () => pickSession(s));
    list.appendChild(row);
  });
}
function pickSession(s) {
  closeSessionSwitch();
  const target = s.project && s.project !== '(未知工作区)' ? s.project : null;
  const needSwitch = target && target !== (state.status?.cwd || '');
  const doSelect = () => selectSession(s.id).catch((e) => console.error(e));
  if (needSwitch) switchWorkspace(target).then(doSelect).catch((err) => alert(`打开会话失败：${err.message}`));
  else doSelect();
}

/* —— ⌘/ 快捷键速查表（可搜索 + 点击跳转设置对应项） —— */
let scFilter = '';
function toggleCheatsheet() {
  const m = $('#shortcuts-modal');
  if (!m) return;
  if (m.classList.contains('hidden')) openCheatsheet();
  else m.classList.add('hidden');
}
function openCheatsheet() {
  const body = $('#shortcuts-body');
  if (!body) return;
  body.innerHTML = '';
  const q = scFilter.trim();
  for (const g of GROUP_IDS) {
    // 搜索匹配：id/分组/绑定键（纯函数）+ i18n 化的功能名/描述/分组标签
    const feats = SHORTCUT_FEATURES.filter((f) => f.group === g && cheatsheetMatches(f, q, `${featureLabel(f)} ${featureDesc(f)}`));
    if (!feats.length) continue;
    body.appendChild(el('div', 'scs-group-title', t('shortcut.group' + g[0].toUpperCase() + g.slice(1))));
    for (const f of feats) {
      const bind = getBinding(f);
      const row = el('div', 'scs-row');
      row.title = t('shortcut.jumpToSettings');
      const label = el('div', 'scs-label', featureLabel(f));
      label.title = featureDesc(f);
      row.appendChild(label);
      const chip = el('kbd', 'kbd-chip' + (bind === null ? ' disabled' : ''), bind === null ? t('shortcut.disabled') : (bind ? formatCombo(bind) : t('shortcut.unbound')));
      row.appendChild(chip);
      // 点击条目 → 关闭速查表，跳转 设置 → 快捷键 对应项（高亮 + 滚动到可见）
      row.addEventListener('click', () => jumpToShortcutSettings(f.id));
      body.appendChild(row);
    }
  }
  if (q && !body.children.length) {
    body.appendChild(el('div', 'scs-empty', t('shortcut.noMatch', { q })));
  }
  $('#shortcuts-modal').classList.remove('hidden');
  const search = $('#sc-search');
  if (search) { search.value = q; search.focus(); }
}
/** 速查表条目 → 设置-快捷键对应项：跳转并高亮该功能行（可立即录制新绑定） */
function jumpToShortcutSettings(id) {
  $('#shortcuts-modal').classList.add('hidden');
  openSettings();
  // 激活「快捷键」pane（与设置导航点击同逻辑）
  document.querySelectorAll('.settings-nav-item').forEach((n) => n.classList.toggle('active', n.dataset.pane === 'shortcuts'));
  document.querySelectorAll('#settings-modal .settings-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === 'shortcuts'));
  scHighlightId = id; // 先记目标：renderShortcutsSettings 重建行时重新应用（异步 refreshStatus 不会冲掉）
  renderShortcutsSettings();
  const row = document.querySelector(`.sc-row[data-feature="${id}"]`);
  if (row) row.scrollIntoView({ block: 'center' });
  setTimeout(() => { scHighlightId = null; }, 2400);
}

/* —— 设置 → 快捷键 pane（录制 / 清除 / 禁用 / 冲突检测 / 恢复默认） —— */
let recordingFeatureId = null;
// 速查表点击跳转的高亮目标：renderShortcutsSettings 重建行时重新应用——openSettings 里的
// refreshStatus() 是异步的，回来后可能再次 renderShortcutsSettings 把行整个重建（此前
// 实测高亮在 0.1s 内消失）；记录 id 让每次重绘都带上 sc-highlight，超时后清空
let scHighlightId = null;
function startRecording(id) {
  closeSessionActions();
  recordingFeatureId = id;
  renderShortcutsSettings();
}
function renderShortcutsSettings() {
  const box = $('#shortcuts-list');
  if (!box) return;
  box.innerHTML = '';
  for (const g of GROUP_IDS) {
    const feats = SHORTCUT_FEATURES.filter((f) => f.group === g);
    if (!feats.length) continue;
    box.appendChild(el('div', 'sc-group-title', t('shortcut.group' + g[0].toUpperCase() + g.slice(1))));
    for (const f of feats) {
      const bind = getBinding(f);
      const row = el('div', 'sc-row' + (recordingFeatureId === f.id ? ' recording' : '') + (scHighlightId === f.id ? ' sc-highlight' : ''));
      row.dataset.feature = f.id; // 速查表点击跳转定位用（jumpToShortcutSettings 滚动+高亮）
      const info = el('div', 'sc-info');
      info.appendChild(el('h4', null, featureLabel(f)));
      info.appendChild(el('p', null, featureDesc(f)));
      row.appendChild(info);
      const chip = el('kbd', 'kbd-chip' + (bind === null ? ' disabled' : ''), bind === null ? t('shortcut.disabled') : (bind ? formatCombo(bind) : t('shortcut.unbound')));
      chip.title = featureDesc(f);
      row.appendChild(chip);
      const rec = el('button', 'secondary-button sc-rec', recordingFeatureId === f.id ? t('shortcut.recording') : t('shortcut.record'));
      rec.type = 'button';
      rec.addEventListener('click', () => startRecording(f.id));
      row.appendChild(rec);
      // 启用/禁用开关：默认键为 null（斜杠命令）且未绑定时不显示
      if (f.defaultCombo !== null || bind !== null) {
        const en = document.createElement('input');
        en.type = 'checkbox';
        en.className = 'toggle-switch';
        en.checked = bind !== null;
        en.title = t('shortcut.enabled');
        en.addEventListener('change', () => {
          setShortcutOverride(undefined, en.checked ? (f.defaultCombo || null) : null);
          renderShortcutsSettings();
        });
        row.appendChild(en);
      }
      box.appendChild(row);
    }
  }
  const restore = el('button', 'primary-button sc-restore', t('shortcut.restore'));
  restore.type = 'button';
  restore.addEventListener('click', () => {
    if (confirm(t('shortcut.restoreConfirm'))) {
      try { localStorage.removeItem(SHORTCUTS_STORAGE_KEY); } catch { /* ignore */ }
      recordingFeatureId = null;
      renderShortcutsSettings();
    }
  });
  box.appendChild(restore);
}

/* —— 录制捕获（capture 阶段先于分发器执行，防止录制按键触发已绑定功能） —— */
function shortcutRecorder(e) {
  if (recordingFeatureId === null) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') { recordingFeatureId = null; renderShortcutsSettings(); return; }
  if (e.key === 'Backspace') {
    setShortcutOverride(undefined, recordingFeatureId, null);
    recordingFeatureId = null;
    renderShortcutsSettings();
    return;
  }
  if (isModifierOnly(e)) return; // 等待实际按键
  const combo = comboVariants(e)[0];
  const clash = findShortcutClash(SHORTCUT_FEATURES, (f) => getBinding(f), recordingFeatureId, combo);
  if (clash) {
    alert(t('shortcut.conflict', { combo: formatCombo(combo), label: featureLabel(clash) }));
    return;
  }
  setShortcutOverride(undefined, recordingFeatureId, combo);
  recordingFeatureId = null;
  renderShortcutsSettings();
}

/* —— 全局分发（bubble 阶段；录制捕获先拦截） —— */
function shortcutDispatcher(e) {
  if (e.repeat || isModifierOnly(e)) return;
  const editable = isEditableTarget(document.activeElement);
  for (const combo of comboVariants(e)) {
    const hit = matchShortcut(SHORTCUT_FEATURES, (f) => getBinding(f), combo, editable);
    if (hit) {
      e.preventDefault();
      e.stopPropagation();
      hit.run();
      return;
    }
  }
}
document.addEventListener('keydown', shortcutRecorder, true);
document.addEventListener('keydown', shortcutDispatcher);

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
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); acceptCmdSel(); return; }
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
    if (state._sending) return; // 发送锁：防止 Cmd+Enter 快速重复触发
    const text = input.value.trim();
    if (!text && !state.attachments.length) return;
    // 斜杠命令：直接执行（不发送给 Agent）
    if (text.startsWith('/')) {
      cmdPalette.classList.add('hidden');
      input.value = '';
      autoResize();
      runSlashCommand(text);
      return;
    }
    if (sessionRunning()) {
      if (state.attachments.length) { metaLine(state.session, [t('attach.running')]); return; } // 运行中不支持附件
      if (e.metaKey || e.ctrlKey) steerMessage(text);
      else queueMessage(text);
    } else {
      state._sending = true;
      sendMessage();
    }
  }
});
document.addEventListener('keydown', (e) => {
  // ⌘/Ctrl+K 新建会话、/ 聚焦搜索已移入快捷键注册表（keyboard-shortcuts-spec.md）：
  // ⌘N=新建、⌘K=会话快速切换、/ = 聚焦搜索（裸键，输入框聚焦时不触发）
  if (e.key === 'Escape') {
    const anyPopOpen = ['#permission-pop', '#model-pop'].some((sel) => !$(sel).classList.contains('hidden'));
    if (anyPopOpen) { closeAllComposerPops(); return; }
    let escConsumed = false;
    if (!$('#session-switch-modal').classList.contains('hidden')) { closeSessionSwitch(); escConsumed = true; }
    else if (!$('#shortcuts-modal').classList.contains('hidden')) { $('#shortcuts-modal').classList.add('hidden'); escConsumed = true; }
    if (!$('#rewind-modal').classList.contains('hidden')) { $('#rewind-modal').classList.add('hidden'); escConsumed = true; }
    if (!$('#dirpicker-modal').classList.contains('hidden')) { closeDirPicker(); escConsumed = true; }
    else if (!$('#settings-modal').classList.contains('hidden')) { closeSettings(); escConsumed = true; }
    else if (!$('#cmd-panel').classList.contains('hidden')) { closeCmdPanel(); escConsumed = true; }
    else if (cmdPalette && !cmdPalette.classList.contains('hidden')) { cmdPalette.classList.add('hidden'); escConsumed = true; }
    else if (mentionPop && !mentionPop.classList.contains('hidden')) { mentionPop.classList.add('hidden'); escConsumed = true; }
    else if ($('#app').classList.contains('sidebar-open')) { $('#app').classList.remove('sidebar-open'); escConsumed = true; }
    // 无任何浮层/面板打开且当前会话运行中 → Esc 停止回复（对标 TUI 的 Esc 取消）
    if (!escConsumed && sessionRunning()) {
      e.preventDefault();
      cancelCurrentRun();
    }
  }
});

/* 纯发送（不检查 running 状态，由调用方保证）；text 为空但带附件也可发送 */
async function doSend(text) {
  input.value = '';
  autoResize();
  const atts = state.attachments.slice();
  if (atts.length) { state.attachments = []; renderAttachList(); }
  setEmptyState(false);
  state._sending = false; // 释放发送锁（input 已清空 + runningSessions 即将 add）
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
    state._localRunning.add(state.session); // 本地运行标记：status 覆盖前保持圆环/取消态
    updateComposer();
    updateStatusText();
    // 乐观回显：先显示用户消息（含附件），再预建 thinking（保证顺序 user -> thinking，
    // 避免预建 thinking 跑到用户消息上方；SSE 的 user.message 重复到达时去重）
    userBlock(state.session, text, atts);
    if (currentThinking) { currentThinking.finish(); currentThinking = null; }
    currentThinking = thinkingBlock(state.session);
    state._pendingUserText = text;
    scrollBottom();
    await api(`/api/sessions/${state.session}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        attachments: atts.map((a) => (a.kind === 'image'
          ? { kind: 'image', name: a.name, dataUrl: a.dataUrl }
          : a.kind === 'text'
            ? { kind: 'text', name: a.name, content: a.content }
            : { kind: 'path', name: a.name })),
      }),
    });
  } catch (e) {
    state.runningSessions.delete(state.session);
    state._localRunning.delete(state.session);
    state._pendingUserText = null;
    // 发送失败：恢复附件，便于重试
    if (atts.length) { state.attachments = atts; renderAttachList(); }
    if (currentThinking) { currentThinking.finish(); currentThinking = null; }
    if (state.session) metaLine(state.session, [t('send.failed', { msg: e.message })]);
    updateComposer();
    updateStatusText();
  }
}

/* 空闲发送（text 或附件任一非空即可） */
function sendMessage() {
  const text = input.value.trim();
  if (!text && !state.attachments.length) return;
  if (sessionRunning()) return; // 仅本会话运行中拦截（其它会话可并行）
  doSend(text);
}

/* 运行中 Enter → 入队 */
function queueMessage(text) {
  state.messageQueue.push(text);
  input.value = '';
  autoResize();
  renderQueueList();
  updateComposer();
}

/* 队列项数据模型：{ text, steer } */
function queueItems() {
  const items = state.messageQueue.map((text) => ({ text, steer: false }));
  if (state.steerText) items.unshift({ text: state.steerText, steer: true });
  return items;
}

function renderQueueList() {
  const list = $('#queue-list');
  if (!list) return;
  const items = queueItems();
  if (!items.length) { list.classList.add('hidden'); list.innerHTML = ''; return; }
  list.classList.remove('hidden');
  list.innerHTML = '';
  items.forEach((item, i) => {
    const row = el('div', 'queue-item' + (item.steer ? ' steer' : ''));
    row.dataset.index = String(i);
    row.dataset.steer = String(item.steer);
    row.draggable = true;

    // 拖拽手柄
    const drag = el('span', 'qi-drag', '');
    drag.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>';
    row.appendChild(drag);

    // 徽标
    const badge = el('span', 'qi-badge ' + (item.steer ? 'steer' : 'queue'), item.steer ? '⚡' : 'Q');
    row.appendChild(badge);

    // 文本（双击编辑）
    const text = el('div', 'qi-text', item.text);
    text.addEventListener('dblclick', () => {
      text.setAttribute('contenteditable', 'true');
      text.focus();
      // 选中全部
      const range = document.createRange();
      range.selectNodeContents(text);
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(range);
    });
    text.addEventListener('blur', () => {
      const newText = text.textContent.trim();
      text.removeAttribute('contenteditable');
      if (!newText) { removeQueueItem(i); return; }
      // 写回
      if (item.steer) state.steerText = newText;
      else state.messageQueue[i - (state.steerText ? 1 : 0)] = newText;
      text.textContent = newText;
    });
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); text.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); text.textContent = item.text; text.removeAttribute('contenteditable'); text.blur(); }
    });
    row.appendChild(text);

    // 操作按钮
    const actions = el('div', 'qi-actions');

    // 转 steer / 转 queue 按钮
    const toggleBtn = el('button', 'qi-btn', '');
    if (!item.steer) {
      // Q → ⚡（转 steer）
      toggleBtn.title = '转为 steer 打断消息';
      toggleBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M13 2L4 14h7l-1 8 9-12h-7z" fill="currentColor" stroke="none"/></svg>';
      toggleBtn.addEventListener('click', (e) => { e.stopPropagation(); toSteer(i); });
    } else {
      // ⚡ → Q（转 queue）
      toggleBtn.title = '转为排队消息';
      toggleBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 12h14M12 5v14" stroke-width="2"/></svg>';
      toggleBtn.addEventListener('click', (e) => { e.stopPropagation(); toQueue(i); });
    }
    actions.appendChild(toggleBtn);

    // 删除按钮
    const delBtn = el('button', 'qi-btn', '');
    delBtn.title = '删除';
    delBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    delBtn.addEventListener('click', (e) => { e.stopPropagation(); removeQueueItem(i); });
    actions.appendChild(delBtn);

    row.appendChild(actions);

    // 拖拽事件
    row.addEventListener('dragstart', (e) => {
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(i));
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      list.querySelectorAll('.queue-item').forEach((n) => n.classList.remove('drag-over'));
    });
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drag-over');
      const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
      const toIdx = i;
      if (isNaN(fromIdx) || fromIdx === toIdx) return;
      reorderQueue(fromIdx, toIdx);
    });

    list.appendChild(row);
  });
}

/* 队列项操作 */
function removeQueueItem(idx) {
  const hasSteer = !!state.steerText;
  if (idx === 0 && hasSteer) { state.steerText = null; }
  else { state.messageQueue.splice(idx - (hasSteer ? 1 : 0), 1); }
  renderQueueList();
  updateComposer();
}

/* 排队消息 ↔ steer 消息互转 */
function toSteer(idx) {
  const hasSteer = !!state.steerText;
  if (idx === 0 && hasSteer) return; // 已是 steer
  const queueIdx = idx - (hasSteer ? 1 : 0);
  const text = state.messageQueue.splice(queueIdx, 1)[0];
  // 如果已有 steer，把旧 steer 降为排队消息
  if (hasSteer) { state.messageQueue.unshift(state.steerText); }
  state.steerText = text;
  // 重新发送 steer 请求
  if (state.session) {
    api(`/api/sessions/${state.session}/steer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    }).catch(() => {});
  }
  renderQueueList();
  updateComposer();
}

function toQueue(idx) {
  const hasSteer = !!state.steerText;
  if (!(idx === 0 && hasSteer)) return; // 不是 steer
  const text = state.steerText;
  state.steerText = null;
  state.messageQueue.unshift(text);
  // 取消 steer（取消当前运行）
  if (state.session) {
    api(`/api/sessions/${state.session}/cancel`, { method: 'POST' }).catch(() => {});
  }
  renderQueueList();
  updateComposer();
}

function reorderQueue(fromIdx, toIdx) {
  const hasSteer = !!state.steerText;
  // 提取所有项为数组
  const items = queueItems();
  const [moved] = items.splice(fromIdx, 1);
  items.splice(toIdx, 0, moved);
  // 重新写回 state
  const firstIsSteer = items[0]?.steer;
  if (firstIsSteer) {
    state.steerText = items[0].text;
    state.messageQueue = items.slice(1).filter((it) => !it.steer).map((it) => it.text);
  } else {
    state.steerText = null;
    state.messageQueue = items.map((it) => it.text);
  }
  renderQueueList();
  updateComposer();
}

/* 运行中 Cmd/Ctrl+Enter → steer（打断，插入当前轮） */
function steerMessage(text) {
  input.value = '';
  autoResize();
  renderQueueList();
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
    state.runningSessions.delete(state.session);
    state._localRunning.delete(state.session);
    // 立即停止当前 thinking/回答 的 spinner 与计时（不等 run.end——服务器 abort 处理有延迟，
    // 否则 interval 驱动的 spinner 继续转、实时耗时继续走）
    if (currentThinking) { currentThinking.finish(); currentThinking = null; }
    if (currentAssistant) { currentAssistant.paint(); currentAssistant.stopCursor(); currentAssistant = null; }
    currentTools.clear();
    stopRunRing();
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
  renderShortcutsSettings();
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
/* + 按钮 = 文件/图片选择器（D4：不再弹 popover）；与拖拽共用 handleAttachFiles */
$('#btn-attach').addEventListener('click', (e) => {
  e.stopPropagation();
  closeAllComposerPops();
  $('#attach-input').click();
});
$('#attach-input').addEventListener('change', (e) => {
  handleAttachFiles(e.target.files);
  e.target.value = ''; // 允许再次选择同一文件
});
// 粘贴（macOS ⌘V / Windows·Linux Ctrl+V，浏览器统一派发 paste 事件，无需判断平台键）：
//   剪贴板带文件（Finder/资源管理器复制的文件）或图片（截图 / 网页复制图片）→ 作为附件加入输入区；
//   纯文本/富文本 → 不拦截，走默认粘贴。与 + 按钮/拖拽共用 handleAttachFiles。
$('#input').addEventListener('paste', (e) => {
  const cd = e.clipboardData;
  if (!cd) return;
  const files = Array.from(cd.files || []);
  // 截图 / 从网页复制的图片：clipboardData.files 为空，图片在 items 里（getAsFile 转 File）
  if (!files.length) {
    for (const item of Array.from(cd.items || [])) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
  }
  if (!files.length) return; // 纯文本：保持默认粘贴行为
  e.preventDefault(); // 附加上传，不把文件路径文本粘进输入框
  handleAttachFiles(files);
});
// 拖拽（D8）：整个 composer 卡片可拖放，拖入高亮
{
  const card = $('#composer-card');
  let dragDepth = 0;
  card.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; card.classList.add('drag-over'); });
  card.addEventListener('dragover', (e) => { e.preventDefault(); });
  card.addEventListener('dragleave', () => { dragDepth--; if (dragDepth <= 0) { dragDepth = 0; card.classList.remove('drag-over'); } });
  card.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    card.classList.remove('drag-over');
    handleAttachFiles(e.dataTransfer && e.dataTransfer.files);
  });
}
$('#btn-permission').addEventListener('click', (e) => {
  e.stopPropagation();
  const pop = $('#permission-pop');
  if (pop.classList.contains('hidden')) { renderPermissionPop(); pop.classList.remove('hidden'); }
  else pop.classList.add('hidden');
  $('#model-pop').classList.add('hidden');
});

/* ---------------- 模型 / 思考级别 popover（composer 内联切换） ---------------- */
function openModelPop() {
  renderModelPop(state.status || {});
  $('#model-pop').classList.remove('hidden');
  $('#permission-pop').classList.add('hidden');
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

  // 推理强度：无级滑条（step any，拖动连续不跳格）+ 动效——拖动中轨道填充跟手预览最近档位，
  // 松手吸附最近档位并播放动效（thumb 脉冲 + 标签弹跳 + 刻度高亮弹跳），短暂停留后自动关闭
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
    range.step = 'any'; // 无级拖拽：拖动过程不跳格
    range.value = String(idx);
    let applied = idx;
    const setFill = (pos) => range.style.setProperty('--fill', `${(pos / Math.max(1, efforts.length - 1)) * 100}%`);
    const nearestIdx = () => Math.min(efforts.length - 1, Math.max(0, Math.round(Number(range.value))));
    // 刻度高亮；animate=true 时给刚激活的刻度一个缩放弹跳（重触发 .pop 动画）
    const setTicks = (pos, animate) => {
      ticks.querySelectorAll('span').forEach((sp, i) => {
        const on = i === pos;
        sp.classList.toggle('active', on);
        if (on && animate) { sp.classList.remove('pop'); void sp.offsetWidth; sp.classList.add('pop'); }
      });
    };
    // 重触发单次 CSS 动画（thumb 脉冲 / 标签弹跳）
    const replay = (node, cls) => { node.classList.remove(cls); void node.offsetWidth; node.classList.add(cls); };
    setFill(idx);
    // 拖动中：轨道填充跟手（dragging 时 CSS 无过渡）+ 预览吸附档位标签 + 刻度高亮（不弹跳）
    range.addEventListener('input', () => {
      range.classList.add('dragging');
      const pos = nearestIdx();
      val.textContent = efforts[pos] ?? '';
      setFill(pos);
      setTicks(pos, false);
    });
    // 松手：吸附最近档位并生效；播放动效（thumb 脉冲 + 标签弹跳 + 刻度弹跳），短暂停留后关闭
    range.addEventListener('change', () => {
      const pos = nearestIdx();
      const v = efforts[pos];
      range.value = String(pos); // 吸附
      range.classList.remove('dragging');
      setFill(pos);
      setTicks(pos, true);
      if (!v) return;
      replay(val, 'snap');
      replay(range, 'snap');
      if (pos === applied) return;
      applySettings({ reasoningEffort: v })
        .then(() => { applied = pos; setTimeout(closeModelPop, 300); }) // 留 300ms 让动效可见
        .catch((err) => { alert(`设置失败：${err.message}`); range.value = String(applied); val.textContent = efforts[applied]; });
    });
    pop.appendChild(range);
    const ticks = el('div', 'pop-ticks');
    efforts.forEach((t, i) => {
      const sp = el('span', null, t);
      if (i === idx) sp.classList.add('active'); // 初始高亮当前档位
      sp.addEventListener('click', () => { // 点刻度直达该档
        range.value = String(i);
        range.dispatchEvent(new Event('change'));
      });
      ticks.appendChild(sp);
    });
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
  const pops = ['#model-pop', '#permission-pop'];
  const triggers = ['#composer-model', '#btn-permission', '#btn-attach'];
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
$('#set-plan').addEventListener('change', (e) => {
  applySettings({ planMode: e.target.checked }).catch((err) => alert(`设置失败：${err.message}`));
});

$('#session-search').addEventListener('input', (e) => {
  state.sessionFilter = e.target.value;
  renderSessionList();
});
// 收起侧栏后搜索按钮（图标）点击无效的修复：搜索控件是 label 包 svg+input，
// 收起态 input 被 display:none，点击 label 无法聚焦隐藏输入框——改为点击时展开侧栏并聚焦
$('.session-search').addEventListener('click', (e) => {
  if ($('#app').classList.contains('sidebar-collapsed')) {
    e.preventDefault();
    $('#app').classList.remove('sidebar-collapsed');
    // 等展开过渡（max-width .18s）后再聚焦，避免聚焦到仍不可见的输入框
    setTimeout(() => $('#session-search').focus(), 80);
  }
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
$('#set-concurrency').addEventListener('change', (e) => {
  const val = Math.max(1, Math.min(16, parseInt(e.target.value) || 3));
  e.target.value = String(val);
  applySettings({ webConcurrency: val }).catch((err) => alert(`设置失败：${err.message}`));
});
/* ---------------- 模型配置（providers 分组：一个端点配置多个模型，设置面板「模型配置」tab） ---------------- */
let cfgProviderSel = null;   // 当前选中分组：null=未选、''=未分组、'name'=provider、'__new__'=新建
let cfgProviderNewName = '';
let cfgProviderApiKey = '';  // 当前编辑 provider 的已保存 apiKey（眼睛按钮 reveal 用）
let cfgModelSel = null;      // 当前选中组内模型名称（二级主从：模型列表 → 详情表单）

function providerModelsOf(g) { return Array.isArray(g && g.models) ? g.models : []; }

/**
 * 添加模型前解析目标 provider 名（手动添加与「获取模型列表」勾选两种方式共用）。
 * - 新建模式（__new__）：先落盘 provider 配置（baseURL/apiKey/userAgent），返回新分组名；
 * - 已选分组：直接返回分组名；未分组（''）/未选（null）返回 null（不可添加）。
 */
async function ensureProviderName() {
  if (cfgProviderSel === '__new__' || cfgProviderNewName) {
    const name = $('#p-name').value.trim();
    if (!name) { alert(t('provider.newName')); return null; }
    try {
      await api('/api/settings', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          providerConfig: {
            provider: name,
            baseURL: $('#p-baseurl').value.trim() || undefined,
            apiKey: $('#p-apikey').value.trim() || undefined,
            userAgent: $('#p-useragent').value.trim() || undefined,
          },
        }),
      });
    } catch (err) {
      alert(t('provider.errSave', { msg: err.message }));
      return null;
    }
    cfgProviderSel = name;
    cfgProviderNewName = '';
    $('#p-apikey').value = '';
    return name;
  }
  return cfgProviderSel || null; // ''（未分组）与 null（未选）都不可添加
}

/** 渲染左侧 provider 列表（未分组 + 各 provider 分组；点击走 #providers-list 委托监听） */
function renderProvidersNav(s) {
  const box = $('#providers-list');
  if (!box) return;
  const groups = Array.isArray(s.providers) ? s.providers : [];
  box.innerHTML = groups.map((g) => {
    const active = cfgProviderSel === g.name && !cfgProviderNewName;
    return `<button class="provider-nav-item${active ? ' active' : ''}" type="button" data-provider="${esc(g.name)}">
      <span class="pni-icon">${g.name ? '🔌' : '📁'}</span>
      <span class="pni-name">${esc(g.name || t('provider.ungrouped'))}</span>
      <span class="pni-count">${providerModelsOf(g).length}</span>
    </button>`;
  }).join('');
}
// 委托监听：点击分组切换（不用 per-item 闭包——renderProvidersNav 每次重建 DOM，
// 闭包捕获的旧 s 可能过期；委托读 state.status 恒为最新）
$('#providers-list')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.provider-nav-item');
  if (!btn) return;
  cfgProviderSel = btn.dataset.provider ?? '';
  cfgProviderNewName = '';
  cfgModelSel = null; // 切换分组：清空模型选中，详情回到空态
  const s = state.status || {};
  renderProvidersNav(s);
  renderProviderEdit(s);
});

/** 渲染右侧编辑区（provider 级字段 + 组内模型列表 / 未分组扁平模型） */
function renderProviderEdit(s) {
  const groups = Array.isArray(s.providers) ? s.providers : [];
  const empty = $('#provider-edit-empty');
  const edit = $('#provider-edit');
  const isNew = cfgProviderSel === '__new__' || cfgProviderNewName;
  const group = !isNew ? groups.find((g) => g.name === cfgProviderSel) || null : null;
  if (!group && !isNew) {
    if (empty) empty.classList.remove('hidden');
    if (edit) edit.classList.add('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');
  if (edit) edit.classList.remove('hidden');

  const pnameInput = $('#p-name');
  const pnameStatic = $('#p-name-static');
  if (isNew) {
    pnameInput.classList.remove('hidden');
    pnameStatic.textContent = '';
    pnameInput.value = cfgProviderNewName;
  } else {
    pnameInput.classList.add('hidden');
    pnameStatic.textContent = group.name;
  }

  const baseRow = $('#p-baseurl')?.closest('.setting-row');
  const keyRow = $('#p-apikey')?.closest('.setting-row');
  const uaRow = $('#p-useragent')?.closest('.setting-row');
  const fetchBtn = $('#btn-p-fetch');
  const saveBtn = $('#btn-save-provider');
  const delBtn = $('#btn-del-provider');
  const fetchResult = $('#p-fetch-result');
  const actionsBar = $('#provider-actions');

  if (baseRow) baseRow.classList.remove('hidden');
  if (keyRow) keyRow.classList.remove('hidden');
  if (uaRow) uaRow.classList.remove('hidden');
  if (actionsBar) actionsBar.classList.remove('hidden');
  $('#p-baseurl').value = group ? (group.baseURL || '') : '';
  cfgProviderApiKey = group ? (group.apiKey || '') : '';
  const apiKeyInput = $('#p-apikey');
  if (apiKeyInput) {
    // 预填已保存密钥（type=password 掩码显示）；新建 provider 无密钥则留空
    apiKeyInput.type = 'password';
    apiKeyInput.value = cfgProviderApiKey;
    const eyeBtn = $('#btn-p-key-eye');
    if (eyeBtn) {
      const setEyeIcon = (revealed) => eyeBtn.querySelector('use')?.setAttribute('href', revealed ? '#i-eye-off' : '#i-eye');
      setEyeIcon(false);
      eyeBtn.onclick = () => {
        if (!apiKeyInput.value) return; // 无内容可显示
        const revealed = apiKeyInput.type === 'text';
        apiKeyInput.type = revealed ? 'password' : 'text';
        setEyeIcon(!revealed);
      };
    }
  }
  $('#p-useragent').value = group ? (group.userAgent || '') : '';
  if (fetchResult) fetchResult.classList.add('hidden');

  // 删除 provider（新建模式无删除）
  if (delBtn) {
    delBtn.onclick = () => {
      if (!group || !confirm(t('provider.removeProviderConfirm', { name: group.name }))) return;
      api('/api/settings', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerRemove: { provider: group.name } }),
      }).then(() => { cfgProviderSel = null; refreshStatus().catch(() => {}); })
        .catch((err) => alert(t('provider.errDelete', { msg: err.message })));
    };
  }
  // 保存 provider（新建 = 创建 + 切到新分组；已有 = 更新）
  if (saveBtn) {
    saveBtn.onclick = () => {
      const name = isNew ? (pnameInput.value.trim() || '') : group.name;
      if (isNew && !name) { alert(t('provider.newName')); return; }
      api('/api/settings', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          providerConfig: {
            provider: name,
            baseURL: $('#p-baseurl').value.trim() || undefined,
            apiKey: $('#p-apikey').value.trim() || undefined,
            userAgent: $('#p-useragent').value.trim() || undefined,
          },
        }),
      }).then(() => {
        $('#p-apikey').value = '';
        cfgProviderSel = name;
        cfgProviderNewName = '';
        refreshStatus().then((s) => { renderProvidersNav(s); renderProviderEdit(s); }).catch(() => {});
      }).catch((err) => alert(t('provider.errSave', { msg: err.message })));
    };
  }
  // 获取模型列表（GET {baseURL}/models → 勾选启用）
  if (fetchBtn) {
    fetchBtn.onclick = async () => {
      const b = $('#p-baseurl').value.trim() || (group ? group.baseURL : '');
      if (!b) { alert(t('provider.noBaseURL')); return; }
      if (fetchResult) {
        fetchResult.classList.remove('hidden');
        fetchResult.innerHTML = `<div class="spin">${t('provider.fetching')}</div>`;
      }
      try {
        const data = await api('/api/settings', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            providerDiscover: { baseURL: b, apiKey: $('#p-apikey').value.trim() || (group ? group.apiKey : undefined) || undefined },
          }),
        });
        const ids = Array.isArray(data.models) ? data.models : [];
        if (!fetchResult) return;
        if (ids.length === 0) {
          fetchResult.innerHTML = `<div>${t('provider.fetchEmpty')}</div>`;
          return;
        }
        fetchResult.innerHTML = `<div>${t('provider.fetched', { n: ids.length })}</div>` +
          `<div class="fetch-hint">${t('provider.selectHint')}</div>` +
          ids.map((id) => `<label><input type="checkbox" value="${esc(id)}"> ${esc(id)}</label>`).join('') +
          `<button id="btn-add-selected" class="primary-button" style="margin-top:6px" type="button">${t('provider.addSelected')}</button>`;
        const refreshAddBtn = () => {
          const btn = $('#btn-add-selected');
          const n = fetchResult.querySelectorAll('input:checked').length;
          if (btn) { btn.disabled = n === 0; btn.textContent = n > 0 ? `${t('provider.addSelected')}（${n}）` : t('provider.addSelected'); }
        };
        fetchResult.querySelectorAll('input[type="checkbox"]').forEach((c) => c.addEventListener('change', refreshAddBtn));
        refreshAddBtn();
        $('#btn-add-selected')?.addEventListener('click', async () => {
          const checked = [...fetchResult.querySelectorAll('input:checked')].map((c) => c.value);
          if (!checked.length) return;
          const provider = await ensureProviderName();
          if (!provider) return;
          Promise.all(checked.map((mid) => api('/api/settings', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ providerModel: { provider, modelName: mid } }),
          }))).then(() => {
            if (fetchResult) fetchResult.classList.add('hidden');
            refreshStatus().then((s) => renderProviderEdit(s)).catch(() => {});
          }).catch((err) => alert(t('provider.errAdd', { msg: err.message })));
        });
      } catch (err) {
        if (fetchResult) fetchResult.innerHTML = `<div>${t('provider.errFetch', { msg: esc(err.message) })}</div>`;
      }
    };
  }
  // 组内模型列表
  const models = group ? providerModelsOf(group) : [];
  const countEl = $('#p-models-count');
  if (countEl) countEl.textContent = t('provider.modelsCount', { n: models.length });
  // 手动添加与「获取模型列表」勾选两种方式并存（不再互斥）
  const addRow = $('#pm-name')?.closest('.pm-add-row');
  if (addRow) addRow.classList.remove('hidden');
  renderProviderModels(s, group, isNew);
}

/** 渲染 provider 组内模型管理区（二级主从）：左侧模型列表 + 右侧选中模型详情表单 */
function renderProviderModels(s, group, isNew) {
  const container = $('#provider-models');
  if (!container) return;
  const models = isNew ? [] : providerModelsOf(group);
  // 选中越界回收：选中名称不在当前组时清空（切分组已在入口清空；这里兜底删除模型后）
  if (cfgModelSel && !models.some((m) => m.name === cfgModelSel)) cfgModelSel = null;
  // 有模型但未选中时，默认选中第一个（开箱即选中可编辑，不必再点一次）
  if (!cfgModelSel && models.length > 0) cfgModelSel = models[0].name;
  container.innerHTML = '';
  if (models.length === 0) container.appendChild(el('div', 'cfg-model-empty', t('provider.emptyModels')));
  models.forEach((m) => container.appendChild(providerModelListRow(s, group, m)));
  renderProviderModelDetail(s, group, isNew);
}

/** 主列：单个模型列表行（名称 + 摘要徽标 + 默认/删除动作；点击 → 右侧详情） */
function providerModelListRow(s, group, m) {
  const isDefault = m.name === s.model || `${group.name}/${m.name}` === s.model;
  const row = el('div', 'pm-list-row' + (m.name === cfgModelSel ? ' active' : ''));
  row.appendChild(el('span', 'pm-name', m.name));
  const cds = el('span', 'pm-cds');
  if (isDefault) cds.appendChild(el('span', 'pm-badge def', t('provider.defaultBadge')));
  // 思考级别摘要徽标：模型级设置了思考级别/选项时在列表行直接可见
  if (m.reasoningEffort) cds.appendChild(el('span', 'pm-badge eff', `思考 ${m.reasoningEffort}`));
  else if (m.reasoningEffortOptions?.length) cds.appendChild(el('span', 'pm-badge eff', `思考级别 ${m.reasoningEffortOptions.length} 档`));
  if (m.overrideBaseURL || m.overrideApiKey) cds.appendChild(el('span', 'pm-badge ovr', t('provider.override')));
  row.appendChild(cds);
  const acts = el('span', 'pm-row-actions');
  if (!isDefault) {
    const defBtn = el('button', 'pm-btn', '★');
    defBtn.title = t('provider.setDefault');
    defBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      api('/api/settings', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ setDefaultModel: { model: `${group.name}/${m.name}` } }),
      }).then(() => refreshStatus().then((s) => renderProviderEdit(s)).catch(() => {}))
        .catch((err) => alert(t('provider.errSetDefault', { msg: err.message })));
    });
    acts.appendChild(defBtn);
  }
  const delBtn = el('button', 'pm-btn danger', '×');
  delBtn.title = t('provider.removeModel');
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!confirm(t('provider.removeConfirm', { name: m.name }))) return;
    api('/api/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerRemove: { provider: group.name, modelName: m.name } }),
    }).then(() => {
      if (cfgModelSel === m.name) cfgModelSel = null; // 删的是选中项 → 落到下一个默认选中
      refreshStatus().then((s) => renderProviderEdit(s)).catch(() => {});
    }).catch((err) => alert(t('provider.errDelete', { msg: err.message })));
  });
  acts.appendChild(delBtn);
  row.appendChild(acts);
  // 点击整行 → 选中到右侧详情编辑
  row.addEventListener('click', () => {
    if (cfgModelSel === m.name) return;
    cfgModelSel = m.name;
    document.querySelectorAll('#provider-models .pm-list-row').forEach((r) => r.classList.toggle('active', r === row));
    renderProviderModelDetail(s, group, false);
  });
  return row;
}

/** 右侧：渲染选中模型的详情表单（模型名/apiModel/显示名/思考级别选项·当前级别/上下文/继承·覆盖/保存） */
function renderProviderModelDetail(s, group, isNew) {
  const empty = $('#pm-detail-empty');
  const formBox = $('#pm-detail-form');
  if (!empty || !formBox) return;
  const models = isNew ? [] : providerModelsOf(group);
  const m = models.find((x) => x.name === cfgModelSel) || null;
  if (!m) {
    empty.classList.remove('hidden');
    formBox.classList.add('hidden');
    formBox.innerHTML = '';
    return;
  }
  empty.classList.add('hidden');
  formBox.classList.remove('hidden');
  const isDefault = m.name === s.model || `${group.name}/${m.name}` === s.model;
  const hasOverride = !!(m.overrideBaseURL || m.overrideApiKey);
  formBox.innerHTML = `
    <div class="pm-form-head">
      <span class="pm-form-name">${esc(m.name)}</span>
      ${isDefault ? `<span class="pm-badge def">${esc(t('provider.defaultBadge'))}</span>` : ''}
      ${m.reasoningEffort ? `<span class="pm-badge eff">思考 ${esc(m.reasoningEffort)}</span>` : ''}
      <span class="pm-form-sub">${group.name ? `${esc(group.name)}/` : ''}${esc(m.name)}</span>
    </div>
    <div class="pm-row"><label>${t('provider.fldApiModel')}</label><input class="cfg-text" value="${esc(m.apiModel || '')}" placeholder="${esc(m.name)}"></div>
    <div class="pm-row"><label>${t('provider.fldDisplay')}</label><input class="cfg-text" value="${esc(m.displayName || '')}" placeholder="${esc(m.name)}"></div>
    <div class="pm-row"><label>${t('provider.fldEfforts')}</label><div class="pm-eff-input"><input class="cfg-text" value="${esc((m.reasoningEffortOptions || []).join(', '))}" placeholder="low,medium,high,xhigh,max" title="${esc(t('settings.variantsDesc'))}"><p class="pm-hint">${esc(t('settings.variantsDesc'))}</p></div></div>
    <div class="pm-row"><label>${t('provider.fldEffort')}</label><select class="setting-control"></select></div>
    <div class="pm-row"><label>${t('provider.fldContext')}</label><input class="setting-control" type="number" value="${m.limit?.context || ''}" placeholder="128000" min="0" step="1000"></div>
    <div class="pm-row"><label></label><span class="inherit-toggle${hasOverride ? '' : ' active'}" data-mode="inherit">${t('provider.inherit')}</span>&nbsp;/&nbsp;<span class="inherit-toggle${hasOverride ? ' active' : ''}" data-mode="override">${t('provider.override')}</span></div>
    <div class="pm-row" data-ovr><label>${t('provider.fldBaseURL')}</label><input class="cfg-text" value="${esc(m.overrideBaseURL || '')}" placeholder="${esc(group ? group.baseURL || '' : '')}"></div>
    <div class="pm-row" data-ovr><label>${t('provider.fldApiKey')}</label><input type="password" class="cfg-text" placeholder="sk-…"></div>
    <div class="pm-row"><button class="primary-button" type="button">${t('provider.save')}</button></div>
  `;
  const opts = (m.reasoningEffortOptions || s.reasoningEffortOptions || ['low', 'medium', 'high', 'xhigh', 'max']).filter(Boolean);
  const effSel = formBox.querySelector('select');
  opts.forEach((o) => {
    const op = document.createElement('option');
    op.value = o; op.textContent = o;
    if (o === (m.reasoningEffort || s.reasoningEffort || opts[0])) op.selected = true;
    effSel.appendChild(op);
  });
  const ovrRows = formBox.querySelectorAll('[data-ovr]');
  if (!hasOverride) ovrRows.forEach((r) => r.style.display = 'none');
  formBox.querySelectorAll('.inherit-toggle').forEach((tog) => {
    tog.addEventListener('click', () => {
      formBox.querySelectorAll('.inherit-toggle').forEach((x) => x.classList.remove('active'));
      tog.classList.add('active');
      const isOvr = tog.dataset.mode === 'override';
      ovrRows.forEach((r) => r.style.display = isOvr ? '' : 'none');
    });
  });
  formBox.querySelector('button.primary-button').addEventListener('click', () => {
    const inputs = formBox.querySelectorAll('input');
    const isOverride = formBox.querySelector('.inherit-toggle.active')?.dataset.mode === 'override';
    api('/api/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providerModel: {
          provider: group.name,
          modelName: m.name,
          apiModel: inputs[0].value.trim() || undefined,
          displayName: inputs[1].value.trim() || undefined,
          reasoningEffortOptions: inputs[2].value.split(',').map((s) => s.trim()).filter(Boolean) || undefined,
          reasoningEffort: effSel.value || undefined,
          contextLimit: Number(inputs[3].value) > 0 ? Number(inputs[3].value) : undefined,
          overrideBaseURL: isOverride ? (inputs[4]?.value?.trim() || undefined) : undefined,
          overrideApiKey: isOverride ? (inputs[5]?.value?.trim() || undefined) : undefined,
        },
      }),
    }).then(() => refreshStatus().then((s) => renderProviderEdit(s)).catch(() => {}))
      .catch((err) => alert(t('provider.errSave', { msg: err.message })));
  });
}

/** 设置面板「模型配置」tab 数据刷新：左侧分组列表 + 右侧编辑区 + 底部动作按钮 */
function fillModelConfigForm(s) {
  // 首次打开（从未选择过分组）：自动选中当前默认模型所属的 provider 分组——
  // 已添加的 provider 模型列表直接可见（而非停在「选择左侧分组」空态）
  if (cfgProviderSel === null) {
    const groups = Array.isArray(s.providers) ? s.providers : [];
    if (groups.length > 0) {
      const cur = s.model || '';
      const named = groups.find((g) => g.name);
      const own = groups.find((g) => g.name && providerModelsOf(g).some((m) => m.name === cur || `${g.name}/${m.name}` === cur));
      cfgProviderSel = own ? own.name : (named ? named.name : groups[0].name);
    }
  }
  renderProvidersNav(s);
  renderProviderEdit(s);
  // 添加模型（组内；新建模式下先落盘 provider 配置再添加）——onclick 覆盖注册防重复监听。
  // apiModel 等其余字段放到右侧详情表单里编辑（添加后自动选中该模型并打开详情）。
  $('#btn-add-model').onclick = async () => {
    const nameInput = $('#pm-name');
    const modelName = nameInput.value.trim();
    if (!modelName) return;
    const provider = await ensureProviderName();
    if (!provider) return;
    api('/api/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerModel: { provider, modelName } }),
    }).then(() => {
      nameInput.value = '';
      cfgModelSel = modelName; // 添加后自动选中 → 右侧详情直接可编辑 apiModel/级别/上下文
      refreshStatus().then((s) => { renderProvidersNav(s); renderProviderEdit(s); }).catch(() => {});
    }).catch((err) => alert(t('provider.errAdd', { msg: err.message })));
  };
  // 新建 provider
  $('#btn-provider-new').onclick = () => {
    cfgProviderSel = '__new__';
    cfgProviderNewName = '';
    cfgModelSel = null;
    renderProvidersNav(s);
    renderProviderEdit(s);
  };
}
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
  initScrollFollow();
  try {
    await refreshStatus();
  } catch (e) {
    // 连接失败：左侧栏 top-status-dot 由 SSE onerror 标红，此处静默
  }
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

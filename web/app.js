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
  turnFirstTokenSum: 0, // 本轮首 token 延迟累计（turn-footer 首 token 均值用）
  turnFirstTokenCount: 0,
  turnUsages: [],
  turnLlmMs: 0,         // 本轮 LLM 墙钟累计（turn-footer 当次速率用；对标 TUI turnLlmMs）
  turnGenMs: 0,         // 本轮纯生成耗时累计（turn-footer 当次速率用；对标 TUI turnGenMs）
  sessionFilter: '',
  expandedGroups: new Set(), // 工作区分组展开记忆（'!项目' 前缀 = 强制收起的当前工作区组）
  runningSessions: new Set(), // 运行中的会话 id 集合（唯一真相源）
  _localRunning: new Set(), // 本地刚启动的会话（doSend 设置，status 覆盖前保持；run.end 清除）
  cfgModelName: null,       // 设置 → 模型配置 tab 当前编辑的模型名
  sessionStats: new Map(),  // sessionId -> { turns, steps, llmMs, toolsMs, genMs, cached }
  sessionUsage: new Map(),  // sessionId -> { prompt, completion, total, cached, lastPrompt }
  messageQueue: [],     // 运行中 Enter 入队的消息（仅当前会话）
  steerText: null,      // 运行中 Cmd+Enter 打断消息（仅当前会话，优先于 queue）
  delegateRuns: [],     // 运行中 delegate 子代理（输入框上方面板；{seq,title,status,stopped,stopRequested,expanded,items,dropped}）
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
  // 消息操作
  'msg.copy': '复制',
  'msg.rewrite': '重新编写',
  'msg.retry': '重试',
  // 通知（右上角 Alert notification）
  'notify.copied': '已复制',
  'notify.copyFailed': '复制失败',
  'notify.modelSwitched': '已切换到 {model}',
  'notify.saved': '✓ 已保存',
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
  'ask.head': '? 向用户提问',
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
  'tool.ok': '完成',
  'tool.noOutput': '（无输出）',
  'tool.nchars': '{n} 字符',
  // 子代理
  'subagent.running': '运行中',
  'subagent.thinking': '思考中',
  'subagent.stopped': '已停止',
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
  'settings.mcp': 'MCP 服务',
  'settings.mcpSub': '外部工具服务器（本地命令 / 远端 HTTP）。增删写入全局配置并即时生效；未连接的服务器可重连。',
  'settings.skills': '技能',
  'settings.skillsSub': '模型按需加载的技能（SKILL.md）。新建写入项目 .agents/skills，刷新后即时发现；网络检索安装仍走 /skill find|add。',
  'mcp.reconnect': '重连',
  'mcp.empty': '还没有 MCP 服务器——下方添加，或输入区 /mcp add',
  'mcp.addTitle': '添加服务器',
  'mcp.addHint': '同 /mcp add 语法：命令 [参数]，或 --url <http> [--approval <mode>]。',
  'mcp.namePh': '服务器名',
  'mcp.cmdPh': '命令 [参数] 或 --url <http>',
  'mcp.add': '添加',
  'mcp.installTitle': '从 Registry 安装',
  'mcp.installPh': 'registry id',
  'mcp.install': '安装',
  'mcp.login': '登录',
  'mcp.delete': '删除',
  'mcp.tools': '工具',
  'mcp.resources': '资源',
  'mcp.prompts': '提示词',
  'mcp.unconnected': '未连接',
  'mcp.stdio': '本地命令',
  'mcp.http': '远端 HTTP',
  'mcp.confirmDelete': '确定删除 MCP 服务器「{name}」？',
  'mcp.count': '{n} 个服务器',
  'mcp.reconnected': '已重连（当前 {n} 个工具）',
  'skill.refresh': '刷新',
  'skill.empty': '未发现技能——下方新建，或 /skill find 检索安装',
  'skill.createTitle': '新建技能',
  'skill.namePh': '技能名（小写字母/数字/连字符）',
  'skill.descPh': '一句话描述（模型据此选用）',
  'skill.create': '新建',
  'skill.show': '查看',
  'skill.global': '全局',
  'skill.manual': '仅手动',
  'skill.subagent': '子代理',
  'skill.count': '{n} 个技能',
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
  'provider.empty': '还没有 provider——点「+ 新建 provider」添加',
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
  'provider.models': '模型列表',
  'provider.modelsCount': '{n} 个模型',
  'provider.enableHint': '启用该模型',
  'provider.disableHint': '停用该模型（移除配置）',
  'provider.editHint': '点击行打开编辑（上下文/思考级别等）',
  'provider.editTitle': '编辑模型',
  'provider.autoFetchFail': '自动获取模型列表失败——可点「刷新模型列表」重试',
  'provider.addPlaceholder': '自定义模型名',
  'provider.searchProvider': '搜索 provider…',
  'provider.searchModel': '搜索模型…',
  'provider.noMatch': '无匹配',
  'provider.fromModelsDev': '来自 models.dev',
  'provider.colName': '模型名',
  'provider.colApiModel': 'apiModel',
  'provider.colDefault': '默认',
  'provider.colEffort': '思考级别',
  'provider.colContext': 'context',
  'provider.colOps': '操作',
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
  'provider.refresh': '刷新模型列表',
  'provider.catalogBadge': '目录',
  'provider.catalogCount': '+{n} 目录',
  'provider.add': '添加',
  'provider.addHint': '添加到组内模型',
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
  'settings.toolsCount': '{n} 个工具',
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
  'shortcut.cyclePermissionDesc': '只读 → 请求批准 → 帮我批准 → 完全访问（静默）',
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
  'modal.rewindSub': '每轮对话自动快照工作区修改文件；回滚文件到该回合状态（对话保留）。列表附与当前工作区的差异。',
  'settings.language': '界面语言',
  'settings.languageDesc': '设置 → 通用 → 语言 中切换（中文 / English），保存后立即生效。',
  'modal.dirTitle': '选择工作目录',
  'modal.up': '上级',
  'modal.cancel': '取消',
  'modal.select': '选择此目录',
  'modal.close': '关闭',
  // 工作区 / 会话（侧栏 chrome + 操作菜单）
  'ws.unknown': '（未知工作区）',
  'ws.actions': '工作区操作',
  'ws.newIn': '在 {name} 新建会话',
  'ws.remove': '移除工作区',
  'ws.removeConfirm': '移除工作区「{name}」？\n其下 {count} 个会话将被一并删除（目录本身不受影响）。',
  'ws.current': '当前工作区',
  'session.actions': '会话操作',
  'session.rename': '重命名',
  'session.titlePrompt': '会话标题',
  'session.fork': '分叉新会话（/fork）',
  'session.export': '导出 Markdown（/export）',
  'session.rewind': '会话检查点（/rewind）',
  'session.delete': '删除会话',
  'session.deleteConfirm': '删除该会话？此操作不可恢复。',
  'session.deleteNamedConfirm': '删除会话「{name}」？此操作不可恢复。',
  'session.unknown': '未知会话',
  'session.msgCount': '{n} 条消息',
  'approval.confirmTitle': '该操作需要你的确认',
  // /fork 对话框
  'fork.prompt': '分叉新会话：保留前 N 条消息（1..{max}，原会话保留）',
  'fork.invalid': 'N 须为 1..{max} 的整数',
  // /rewind 检查点面板
  'rewind.loading': '加载检查点…',
  'rewind.empty': '暂无检查点——对话轮次会自动打点（每轮用户消息提交时快照工作区修改文件）',
  'rewind.loadFailed': '加载失败：{msg}',
  'rewind.noText': '（无文本）',
  'rewind.diff': '与当前差 Δ{n} 行（+{add} −{rem}）',
  'rewind.same': '与当前一致',
  'rewind.files': '{n} 个文件',
  'rewind.rollback': '回滚到此处',
  'rewind.confirm': '回滚工作区文件到检查点 #{index}？（对话历史保留）',
  'rewind.done': '已回滚到检查点 #{index}（{n} 个文件处理）',
  'rewind.failed': '回滚失败：{msg}',
  // delegate / 工具卡（动态状态）
  'subagent.label': '子代理',
  'subagent.work': '工具',
  'subagent.stop': '⏹ 停止',
  'subagent.stopping': '停止中…',
  'subagent.stoppedBtn': '⏹ 已停止',
  'subagent.earlierDropped': '… 更早 {n} 条已省略',
  'subagent.depth': '运行中（深度 {n}）',
  'subagent.doneSteps': '完成 · {n} 步',
  'tool.runningEllipsis': '运行中…',
  'tool.liveHidden': '… {n} 行被隐藏',
  // composer / 状态
  'composer.planMode': '计划模式',
  'composer.standardMode': '标准模式',
  'composer.ctxTitle': '上下文: {used} / {limit} ({pct}%)',
  'composer.ctxTitleShort': '上下文: {used}',
  'turn.firstToken': ' · 首 token {dur}',
  'model.head': '模型',
  'model.none': '当前无可用模型',
  'model.effortHead': '思考级别',
  'model.noEffort': '该模型未提供思考级别',
  'queue.toSteer': '转为 steer 打断消息',
  'queue.toQueue': '转为排队消息',
  'queue.remove': '删除',
  // 目录选择器
  'dir.loading': '加载中…',
  'dir.empty': '此目录下没有子目录',
  'dir.unreadable': '无法读取目录：{msg}',
  // 错误通知（catch 模板）
  'err.workspaceSwitch': '切换工作目录失败：{msg}',
  'err.openSession': '打开会话失败：{msg}',
  'err.fork': 'fork 失败：{msg}',
  'err.delete': '删除失败：{msg}',
  'err.remove': '移除失败：{msg}',
  'err.rename': '重命名失败：{msg}',
  'err.switchModel': '切换失败：{msg}',
  'err.settings': '设置失败：{msg}',
  'err.lang': '语言设置失败：{msg}',
  'err.readImage': '⚠ 无法读取图片：{name}',
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
  // message actions
  'msg.copy': 'Copy',
  'msg.rewrite': 'Rewrite',
  'msg.retry': 'Retry',
  // notifications (top-right alert)
  'notify.copied': 'Copied',
  'notify.copyFailed': 'Copy failed',
  'notify.modelSwitched': 'Switched to {model}',
  'notify.saved': '✓ Saved',
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
  'ask.head': '? Ask the user',
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
  'tool.ok': 'Done',
  'tool.noOutput': '(no output)',
  'tool.nchars': '{n} chars',
  // 子代理
  'subagent.running': 'Running',
  'subagent.thinking': 'Thinking',
  'subagent.stopped': 'Stopped',
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
  'settings.mcp': 'MCP servers',
  'settings.mcpSub': 'External tool servers (local commands / remote HTTP). Changes are saved to the global config and take effect immediately; reconnect servers that failed.',
  'settings.skills': 'Skills',
  'settings.skillsSub': 'Skills the model loads on demand (SKILL.md). New skills go to the project .agents/skills and are discovered after refresh; use /skill find|add for registry installs.',
  'mcp.reconnect': 'Reconnect',
  'mcp.empty': 'No MCP servers yet — add one below or via /mcp add',
  'mcp.addTitle': 'Add server',
  'mcp.addHint': 'Same syntax as /mcp add: command [args], or --url <http> [--approval <mode>].',
  'mcp.namePh': 'Server name',
  'mcp.cmdPh': 'command [args] or --url <http>',
  'mcp.add': 'Add',
  'mcp.installTitle': 'Install from registry',
  'mcp.installPh': 'registry id',
  'mcp.install': 'Install',
  'mcp.login': 'Login',
  'mcp.delete': 'Delete',
  'mcp.tools': 'Tools',
  'mcp.resources': 'Resources',
  'mcp.prompts': 'Prompts',
  'mcp.unconnected': 'Not connected',
  'mcp.stdio': 'Local command',
  'mcp.http': 'Remote HTTP',
  'mcp.confirmDelete': 'Delete MCP server "{name}"?',
  'mcp.count': '{n} servers',
  'mcp.reconnected': 'Reconnected ({n} tools now)',
  'skill.refresh': 'Refresh',
  'skill.empty': 'No skills found — create one below or via /skill find',
  'skill.createTitle': 'New skill',
  'skill.namePh': 'Skill name (lowercase, digits, hyphens)',
  'skill.descPh': 'One-line description (used for selection)',
  'skill.create': 'Create',
  'skill.show': 'View',
  'skill.global': 'Global',
  'skill.manual': 'Manual only',
  'skill.subagent': 'Subagent',
  'skill.count': '{n} skills',
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
  'provider.empty': 'No providers yet — click "+ New provider" to add one',
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
  'provider.models': 'Model list',
  'provider.modelsCount': '{n} models',
  'provider.enableHint': 'Enable this model',
  'provider.disableHint': 'Disable this model (remove config)',
  'provider.editHint': 'Click a row to edit context, effort, etc.',
  'provider.editTitle': 'Edit model',
  'provider.autoFetchFail': 'Auto-fetch of models failed — click "Refresh models" to retry',
  'provider.addPlaceholder': 'Custom model name',
  'provider.searchProvider': 'Search providers…',
  'provider.searchModel': 'Search models…',
  'provider.noMatch': 'No match',
  'provider.fromModelsDev': 'from models.dev',
  'provider.colName': 'Model',
  'provider.colApiModel': 'apiModel',
  'provider.colDefault': 'Default',
  'provider.colEffort': 'Effort',
  'provider.colContext': 'Context',
  'provider.colOps': 'Actions',
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
  'provider.refresh': 'Refresh model list',
  'provider.catalogBadge': 'catalog',
  'provider.catalogCount': '+{n} catalog',
  'provider.add': 'Add',
  'provider.addHint': 'Add to group models',
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
  'settings.toolsCount': '{n} tools',
  'modal.rewindTitle': 'Session checkpoints (/rewind)',
  'modal.rewindSub': 'The workspace is snapshotted after every turn; roll files back to that turn\'s state (conversation is kept). The list also shows diffs against the current workspace.',
  'settings.language': 'Interface language',
  'settings.languageDesc': 'Switch in Settings → General → Language (中文 / English); takes effect immediately after saving.',
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
  'shortcut.cyclePermissionDesc': 'read → ask → safe → full (silent)',
  'shortcut.openSettings': 'Open settings',
  'shortcut.openSettingsDesc': 'Open the settings dialog',
  'shortcut.cheatsheet': 'Shortcut cheatsheet',
  'shortcut.cheatsheetDesc': 'View all shortcuts and current bindings',
  'shortcut.planMode': 'Toggle plan mode',
  'shortcut.planModeDesc': 'Read-only research mode',
  'shortcut.searchPlaceholder': 'Search feature or shortcut… (click an item to rebind in settings)',
  'shortcut.jumpToSettings': 'Click to rebind in Settings → Shortcuts',
  'shortcut.noMatch': 'No shortcut matches "{q}" — try a feature name, group, or key like ⌘K',
  // workspace / session (sidebar chrome + action menus)
  'ws.unknown': '(unknown workspace)',
  'ws.actions': 'Workspace actions',
  'ws.newIn': 'New session in {name}',
  'ws.remove': 'Remove workspace',
  'ws.removeConfirm': 'Remove workspace "{name}"?\nIts {count} sessions will be deleted too (the folder itself is untouched).',
  'ws.current': 'Current workspace',
  'session.actions': 'Session actions',
  'session.rename': 'Rename',
  'session.titlePrompt': 'Session title',
  'session.fork': 'Fork new session (/fork)',
  'session.export': 'Export as Markdown (/export)',
  'session.rewind': 'Session checkpoints (/rewind)',
  'session.delete': 'Delete session',
  'session.deleteConfirm': 'Delete this session? This cannot be undone.',
  'session.deleteNamedConfirm': 'Delete session "{name}"? This cannot be undone.',
  'session.unknown': 'Unknown session',
  'session.msgCount': '{n} messages',
  'approval.confirmTitle': 'This action needs your confirmation',
  // /fork dialog
  'fork.prompt': 'Fork new session: keep the first N messages (1..{max}; the original session is kept)',
  'fork.invalid': 'N must be an integer from 1 to {max}',
  // /rewind checkpoint panel
  'rewind.loading': 'Loading checkpoints…',
  'rewind.empty': 'No checkpoints yet — sessions are snapshotted automatically each turn (modified workspace files are recorded when you submit a message)',
  'rewind.loadFailed': 'Failed to load: {msg}',
  'rewind.noText': '(no text)',
  'rewind.diff': 'Δ{n} lines different from current (+{add} −{rem})',
  'rewind.same': 'same as current',
  'rewind.files': '{n} files',
  'rewind.rollback': 'Roll back to here',
  'rewind.confirm': 'Roll workspace files back to checkpoint #{index}? (chat history is kept)',
  'rewind.done': 'Rolled back to checkpoint #{index} ({n} files processed)',
  'rewind.failed': 'Rollback failed: {msg}',
  // delegate / tool card (dynamic states)
  'subagent.label': 'Subagent',
  'subagent.work': 'tool',
  'subagent.stop': '⏹ Stop',
  'subagent.stopping': 'Stopping…',
  'subagent.stoppedBtn': '⏹ Stopped',
  'subagent.earlierDropped': '… {n} earlier entries omitted',
  'subagent.depth': 'Running (depth {n})',
  'subagent.doneSteps': 'Done · {n} steps',
  'tool.runningEllipsis': 'Running…',
  'tool.liveHidden': '… {n} lines hidden',
  // composer / status
  'composer.planMode': 'Plan mode',
  'composer.standardMode': 'Standard mode',
  'composer.ctxTitle': 'Context: {used} / {limit} ({pct}%)',
  'composer.ctxTitleShort': 'Context: {used}',
  'turn.firstToken': ' · first token {dur}',
  'model.head': 'Model',
  'model.none': 'No model available',
  'model.effortHead': 'Reasoning',
  'model.noEffort': 'This model has no reasoning levels',
  'queue.toSteer': 'Convert to steer interrupt message',
  'queue.toQueue': 'Convert to queued message',
  'queue.remove': 'Remove',
  // folder picker
  'dir.loading': 'Loading…',
  'dir.empty': 'No subdirectories here',
  'dir.unreadable': 'Cannot read directory: {msg}',
  // error notifications (catch templates)
  'err.workspaceSwitch': 'Failed to switch workspace: {msg}',
  'err.openSession': 'Failed to open session: {msg}',
  'err.fork': 'Fork failed: {msg}',
  'err.delete': 'Delete failed: {msg}',
  'err.remove': 'Remove failed: {msg}',
  'err.rename': 'Rename failed: {msg}',
  'err.switchModel': 'Switch failed: {msg}',
  'err.settings': 'Settings update failed: {msg}',
  'err.lang': 'Failed to set language: {msg}',
  'err.readImage': '⚠ Could not read image: {name}',
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
  updateComposerMeta();
  renderThemeOptions(state.status?.webTheme || getStoredTheme() || 'system');
  renderShortcutsSettings();
  renderLangOptions(); // 设置 · 通用语言分段（中文/English，与主题分段同风格）
  const aboutLang = $('#about-language');
  if (aboutLang) aboutLang.textContent = state.language === 'en' ? 'English' : '中文';
  return state.language;
}

/** 设置 · 通用语言分段（中文/English，主题 seg-group 同风格，点击即切换+落盘） */
function renderLangOptions() {
  const box = $('#lang-options');
  if (!box) return;
  box.innerHTML = '';
  [['zh', '中文'], ['en', 'English']].forEach(([v, label]) => {
    const b = el('button', 'seg-btn' + (state.language === v ? ' active' : ''), label);
    b.type = 'button';
    b.addEventListener('click', () => {
      if (state.language === v) return;
      applyLanguage(v);
      api('/api/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ language: v }),
      }).catch((err) => notify(t('err.lang', { msg: err.message }), 'error'));
    });
    box.appendChild(b);
  });
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

/** 逐块渲染 markdown（围栏代码块 / 表格保持原样，行内做 inline 处理）。
 *  优先走 markstream（web/markdown-renderer.js：流式 AST + diff 围栏），
 *  vendor.js 未加载时回退到下方手写实现，保证页面不因渲染器缺失而白屏。 */
function mdToHtml(text, opts) {
  if (window.OmniMarkdown && window.OmniMarkdown.render) {
    return window.OmniMarkdown.render(text, opts || {});
  }
  return legacyMdToHtml(text);
}

/** 旧手写渲染器（回退路径，非主路径） */
function legacyMdToHtml(text) {
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

let _scrollRaf = null;
let _isProgrammaticScroll = false;

// 滚动到底部：force = 无条件滚；否则只在 autoFollow 态滚（用户上滚后暂停跟随）
function scrollBottom(force) {
  const sb = _scrollBody();
  if (!sb) return;
  if (force) state.autoFollow = true;
  if (state.autoFollow) {
    _isProgrammaticScroll = true;
    sb.scrollTop = sb.scrollHeight;
    if (_scrollRaf) cancelAnimationFrame(_scrollRaf);
    _scrollRaf = requestAnimationFrame(() => {
      _scrollRaf = null;
      if (sb && state.autoFollow) {
        sb.scrollTop = sb.scrollHeight;
      }
      setTimeout(() => { _isProgrammaticScroll = false; }, 80);
    });
  }
}
// scroll 事件：检测用户手动上滚 / 回底——上滚即暂停自动跟随，回底恢复
function initScrollFollow() {
  const sb = _scrollBody();
  if (!sb) return;

  // 监听鼠标真实滚轮
  sb.addEventListener('wheel', (e) => {
    if (e.deltaY < -2) {
      const dist = sb.scrollHeight - sb.scrollTop - sb.clientHeight;
      if (dist > 30) state.autoFollow = false;
    } else if (e.deltaY > 2) {
      const dist = sb.scrollHeight - sb.scrollTop - sb.clientHeight;
      if (dist < 60) state.autoFollow = true;
    }
  }, { passive: true });

  // 监听触摸滑动
  let touchStartY = 0;
  sb.addEventListener('touchstart', (e) => {
    if (e.touches && e.touches[0]) touchStartY = e.touches[0].clientY;
  }, { passive: true });
  sb.addEventListener('touchmove', (e) => {
    if (e.touches && e.touches[0]) {
      const delta = e.touches[0].clientY - touchStartY;
      if (delta > 10) {
        state.autoFollow = false;
      } else if (delta < -10) {
        const dist = sb.scrollHeight - sb.scrollTop - sb.clientHeight;
        if (dist < 60) state.autoFollow = true;
      }
    }
  }, { passive: true });

  // 原生 scroll 事件兜底（过滤程序化滚动）
  sb.addEventListener('scroll', () => {
    if (_isProgrammaticScroll) return;
    const dist = sb.scrollHeight - sb.scrollTop - sb.clientHeight;
    if (dist <= 40) {
      state.autoFollow = true;
    } else if (dist > 180) {
      state.autoFollow = false;
    }
  }, { passive: true });
}

/* ---------------- 消息操作按钮（复制 / 重新编写 / 重试；图标按钮，悬停显示） ----------------
 * 用户消息：复制 + 重新编写（把原文带回输入框）；助手消息：复制 + 重试（重发前一条用户消息）。
 * 按钮放 `.msg-actions` 容器（bubble/md-body 之后），CSS 悬停显示；助手按钮在 md-body
 * 外的兄弟节点——流式重绘只清 innerHTML 不影响按钮。 */
function msgIconButton(title, svgInner, onClick) {
  const btn = el('button', 'msg-action-btn');
  btn.type = 'button';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.innerHTML = svgInner;
  btn.appendChild(svg);
  btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return btn;
}

/* 复制图标（两层矩形） */
const SVG_ICON_COPY =
  '<rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10" fill="none" stroke="currentColor" stroke-width="2"/>';
/* 重新编写图标（铅笔） */
const SVG_ICON_EDIT =
  '<path d="M17 3l4 4L8 20l-5 1 1-5L17 3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>';
/* 重试图标（循环箭头） */
const SVG_ICON_RETRY =
  '<path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';

/** 找 `wrap` 之前最近的一条 `.msg.user` 泡泡文本（重试用：重新发送该提示词） */
function prevUserMsgText(wrap) {
  let n = wrap.previousElementSibling;
  while (n) {
    if (n.classList && n.classList.contains('msg') && n.classList.contains('user')) {
      const bub = n.querySelector('.bubble');
      return bub ? bub.textContent.trim() : '';
    }
    n = n.previousElementSibling;
  }
  return '';
}

/* 助手消息块（流式光标：打字机效果，注入 span 到最后一个文本块末尾，与字符同行） */
function assistantBlock(sessionId) {
  setEmptyState(false);
  const b = makeBlock('assistant', sessionId);
  const wrap = el('div', 'msg assistant');
  const body = el('div', 'md-body');
  wrap.appendChild(body);
  // 操作按钮：拷贝（全部回答内容）+ 重新处理（重发前一条用户消息）——不随块默认挂载，
  // 而是由 showActions() 在整轮（run）真正结束时才挂到「最后一个回答」上：
  // 中间的 thinking/tool 回答块不带按钮（避免每条服务端消息都有拷贝/刷新）。
  const actions = el('div', 'msg-actions');
  actions.appendChild(msgIconButton(t('msg.copy'), SVG_ICON_COPY, () => copyText(b._text || '')));
  actions.appendChild(msgIconButton(t('msg.retry'), SVG_ICON_RETRY, () => {
    const prompt = prevUserMsgText(wrap);
    if (prompt) doSend(prompt);
  }));
  b.showActions = () => {
    if (actions.parentNode || !actions.children.length) return;
    wrap.appendChild(actions);
    scrollBottom();
  };
  lastAnswerBlock = b; // 记录最近一个回答块：run.end / error / cancel / 历史加载时对它挂按钮
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
  b._actions = actions;
  b.paint = () => {
    body.innerHTML = mdToHtml(b._text, { final: !b._streaming });
    if (b._streaming) appendStreamCursor(body);
    scrollBottom();
  };
  return b;
}

/* 终答揭示：轮次结束（run.end / error / cancel）或历史加载后，把拷贝/重新处理按钮挂到
 * 最后一个回答块上（中间思考/工具段落不挂）。showActions 幂等，重复调用无副作用。 */
function revealLastAnswer() {
  if (lastAnswerBlock) { lastAnswerBlock.showActions(); lastAnswerBlock = null; }
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
  b._text = text || '';
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
        row.appendChild(el('span', 'bubble-file', a.name || ''));
      }
    });
    bubble.appendChild(row);
  }
  if (text) bubble.appendChild(document.createTextNode(text));
  wrap.appendChild(bubble);
  // 操作按钮：复制 + 重新编写（把原文带回输入框编辑）
  const actions = el('div', 'msg-actions');
  actions.appendChild(msgIconButton(t('msg.copy'), SVG_ICON_COPY, () => copyText(text || '')));
  actions.appendChild(msgIconButton(t('msg.rewrite'), SVG_ICON_EDIT, () => {
    input.value = text || '';
    autoResize();
    input.focus();
    // 光标移到结尾（编辑整段原文）
    try { input.setSelectionRange(input.value.length, input.value.length); } catch { /* ignore */ }
  }));
  wrap.appendChild(actions);
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
        notify(t('attach.modelNoImage', { name: file.name }), 'info');
        continue;
      }
      if (file.size > IMAGE_MAX_BYTES) {
        notify(t('attach.imageTooLarge', { name: file.name }), 'error');
        continue;
      }
      const dataUrl = await compressImage(file);
      if (!dataUrl) { notify(t('err.readImage', { name: file.name }), 'error'); continue; }
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
  if (!label) return;
  const collapsed = head.classList.contains('collapsed');
  // running 时实时耗时；完成用终值
  const dur = b._durMs || (box.classList.contains('running') ? Date.now() - (b._startTime || Date.now()) : 0);
  const durStr = formatDuration(dur);
  if (collapsed) {
    if (icon) {
      icon.textContent = '+';
      icon.classList.remove('spinning');
    }
    label.innerHTML = `<span class="th-title">Thought:</span> <span class="th-dur">${durStr}</span>`;
  } else if (box.classList.contains('running')) {
    if (icon) {
      icon.innerHTML = `<span class="spin spinning">${SPIN[spinIdx % SPIN.length]}</span>`;
    }
    label.innerHTML = `<span class="th-title">Thought:</span> <span class="th-dur">${durStr}</span>`;
  } else {
    if (icon) {
      icon.textContent = '-';
      icon.classList.remove('spinning');
    }
    label.innerHTML = `<span class="th-title">Thought:</span> <span class="th-dur">${durStr}</span>`;
  }
}

/* 工具卡片 */
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinIdx = 0;
function toolBlock(sessionId, data) {
  setEmptyState(false);
  const b = makeBlock('tool', sessionId);
  const wrap = el('div', 'msg');
  const name = data.name || 'tool';
  const isExplored = name === 'read_file' || name === 'search_code' || name === 'list_directory' || name === 'web_fetch' || name === 'web_search';
  const isEdit = name === 'write_file' || name === 'edit_file';

  if (isExplored) {
    const block = el('div', 'explored-block running');
    const headText = name === 'read_file' ? 'Explored — 1 read' : name === 'web_fetch' ? 'Explored — 1 fetch' : 'Explored — 1 search';
    const head = el('div', 'explored-head');
    head.innerHTML = `<span class="explored-icon">→</span><span class="explored-title">${esc(headText)}</span> <span class="spin">${SPIN[0]}</span>`;
    const item = el('div', 'explored-item', data.argsPreview || name);
    item.classList.add('hidden');
    head.addEventListener('click', () => {
      item.classList.toggle('hidden');
      scrollBottom();
    });
    block.appendChild(head);
    block.appendChild(item);
    wrap.appendChild(block);
    msgList().appendChild(wrap);

    b._card = block;
    b.appendLive = () => {};
    b.spin = (frame) => {
      const sp = head.querySelector('.spin');
      if (sp) sp.textContent = frame;
    };
    b.result = (r) => {
      block.classList.remove('running');
      const sp = head.querySelector('.spin');
      if (sp) sp.remove();
      if (name === 'search_code') {
        let matches = 0;
        if (r.preview && r.preview.length) {
          const first = r.preview[0] ?? '';
          const m = first.match(/(\d+)\s*处/);
          if (m) matches = parseInt(m[1], 10);
          else matches = r.preview.filter((l) => l.trim() && !l.startsWith('…') && !l.includes('匹配结果')).length;
        }
        item.textContent = `${data.argsPreview || name} (${matches} match${matches > 1 ? 'es' : ''})`;
      } else if (name === 'list_directory') {
        let count = 0;
        if (r.preview && r.preview.length) {
          const first = r.preview[0] ?? '';
          const m = first.match(/(\d+)\s*个/);
          if (m) count = parseInt(m[1], 10);
          else count = r.preview.filter((l) => l.trim() && !l.startsWith('…')).length;
        }
        item.textContent = `${data.argsPreview || name}${count > 0 ? ` (${count} items)` : ''}`;
      } else if (name === 'read_file' || name === 'web_fetch') {
        item.textContent = data.argsPreview || name;
      }
      if (!r.ok) {
        item.classList.add('error');
        if (r.error) item.textContent += ` [${r.error}]`;
      }
      scrollBottom();
    };
    return b;
  }

  if (isEdit) {
    const diffWrap = el('div', 'tc-diff running');
    const initTitle = name === 'write_file' ? `← Write ${data.args?.path || ''}` : `← Edit ${data.args?.path || ''}`;
    diffWrap.innerHTML = `<div class="md-diff-wrap"><div class="md-diff-head-title">${esc(initTitle)} <span class="spin">${SPIN[0]}</span></div></div>`;
    wrap.appendChild(diffWrap);
    msgList().appendChild(wrap);

    b._card = diffWrap;
    b.appendLive = () => {};
    b.spin = (frame) => {
      const sp = diffWrap.querySelector('.spin');
      if (sp) sp.textContent = frame;
    };
    b.result = (r) => {
      diffWrap.classList.remove('running');
      const diff = r.detail?.diff;
      const edit = r.detail?.edit;
      if (r.ok && name === 'edit_file' && edit && window.OmniMarkdown?.renderEditDiff) {
        diffWrap.innerHTML = window.OmniMarkdown.renderEditDiff(edit.path, edit.oldLines, edit.newLines);
      } else if (r.ok && name === 'write_file' && diff && window.OmniMarkdown?.renderFileDiff) {
        diffWrap.innerHTML = window.OmniMarkdown.renderFileDiff(diff.original, diff.content, diff.path);
      } else {
        const title = name === 'write_file' ? `← Write ${data.args?.path || ''}` : `← Edit ${data.args?.path || ''}`;
        const noOut = r.ok ? t('tool.noOutput') : (r.error || t('tool.failed'));
        diffWrap.innerHTML = `<div class="md-diff-wrap"><div class="md-diff-head-title">${esc(title)}</div><pre class="tc-output">${esc((r.preview || []).join('\n') || noOut)}</pre></div>`;
      }
      scrollBottom();
    };
    return b;
  }

  const card = el('div', 'tool-card running');
  const head = el('div', 'tc-head');
  let st = null;
  if (name === 'run_command') {
    const cmd = (data.args?.command || data.argsPreview || '').trim().replace(/^●\s*Bash\(/, '').replace(/\)$/, '').replace(/^\$\s*/, '');
    head.innerHTML = `<span class="tool-prompt">$</span> <span class="tool-cmd">${esc(cmd)}</span> <span class="spin">${SPIN[0]}</span>`;
  } else if (name === 'delegate') {
    // 子代理卡片（1.0 可视化）：标题 = 委托摘要，状态 = 运行中 spinner；
    // body 折叠容器 = 执行明细（subagent 事件驱动追加：思考/工具/结果）
    const summary = data.argsPreview || 'delegate';
    head.innerHTML = `<span class="tc-cmd">${esc(t('subagent.label'))}</span> <span class="tc-delegate-task">${esc(summary)}</span> <span class="spin">${SPIN[0]}</span>`;
    st = el('span', 'tc-state');
    st.textContent = t('subagent.running');
    head.appendChild(st);
  } else {
    head.appendChild(el('span', 'tc-cmd', data.name || 'tool'));
    st = el('span', 'tc-state');
    st.innerHTML = `<span class="spin">${SPIN[0]}</span>${esc(data.argsPreview || t('tool.running'))}`;
    head.appendChild(st);
  }
  const body = el('div', 'tc-body');
  body.classList.add('hidden');
  const live = el('div', 'tc-live');
  live.classList.add('hidden');
  head.addEventListener('click', () => {
    if (!card.classList.contains('running')) body.classList.toggle('hidden');
    scrollBottom();
  });
  card.appendChild(head); card.appendChild(live); card.appendChild(body);
  wrap.appendChild(card);
  msgList().appendChild(wrap);
  b._card = card; b._head = head; b._st = st; b._body = body; b._live = live; b._data = data;
  b._input = data.args && Object.keys(data.args).length ? JSON.stringify(data.args, null, 2) : data.argsPreview || '';
  b._output = t('tool.runningEllipsis');
  b._error = false;
  b._liveBuf = [];
  b.spin = (frame) => {
    const sp = head.querySelector('.spin');
    if (sp) sp.textContent = frame;
  };
  b.appendLive = (line) => {
    if (!line) return;
    b._liveBuf.push(line);
    if (b._liveBuf.length > 16) b._liveBuf.shift();
    const show = b._liveBuf.slice(-6);
    const hidden = b._liveBuf.length - show.length;
    b._live.innerHTML = '';
    for (const ln of show) {
      const row = el('div', 'tc-live-line');
      row.textContent = ln;
      b._live.appendChild(row);
    }
    if (hidden > 0) {
      b._live.appendChild(el('div', 'tc-live-meta', t('tool.liveHidden', { n: hidden })));
    }
    b._live.classList.remove('hidden');
    scrollBottom();
  };
  b.result = (r) => {
    card.classList.remove('running');
    const sp = head.querySelector('.spin');
    if (sp) sp.remove();
    if (name === 'delegate') {
      // delegate 卡片：结果区由子代理明细接管（tool.result 只负责摘除运行态；
      // 明细内容已在 subagent end 事件渲染，这里避免用输出预览覆盖它）
      if (st) st.textContent = r.ok ? t('tool.ok') : t('tool.failed');
      return;
    }
    const ok = r.ok;
    if (st) st.textContent = ok ? t('tool.nchars', { n: r.chars }) : t('tool.failed');
    const lines = (r.preview || []).slice(0, 12).join('\n');
    const out = (r.preview && r.preview.length ? lines : ok ? t('tool.noOutput') : r.error || t('tool.noOutput'));
    b._output = out;
    b._error = !ok;
    b._liveBuf = [];
    b._live.innerHTML = '';
    b._live.classList.add('hidden');
    body.innerHTML = '';
    body.appendChild(el('div', 'tc-output', out));
    if (!ok) {
      body.classList.remove('hidden');
    } else {
      body.classList.add('hidden');
    }
  };
  // 子代理事件驱动更新（delegate 卡片；非 delegate 无操作）：追加明细 + 状态 + 停止按钮。
  // 明细行数上限（防超长子代理把 DOM 撑爆）：超出丢最早、显示省略提示。
  b._subItems = [];
  b._subDropped = 0;
  b._subStop = null;
  const subPaint = () => {
    // 全量重建明细 DOM（含停止按钮；先摘除旧按钮引用）
    if (b._subStop) { b._subStop.remove(); b._subStop = null; }
    body.innerHTML = '';
    if (b._subDropped > 0) body.appendChild(el('div', 'tc-live-meta', t('subagent.earlierDropped', { n: b._subDropped })));
    for (const it of b._subItems) {
      if (it.kind === 'think') body.appendChild(el('div', 'tc-sub-think', `💭 ${it.text}`));
      else if (it.kind === 'tool') body.appendChild(el('div', 'tc-sub-tool', `→ ${it.text}`));
      else body.appendChild(el('div', 'tc-sub-result' + (it.ok === false ? ' err' : ''), `${it.ok === false ? '✗' : '✓'} ${it.text}`));
    }
    const running = card.classList.contains('running');
    const showStop = running && !b._subStopped;
    if (!running) {
      if (b._subStopped) body.appendChild(el('div', 'tc-sub-stopped', t('subagent.stoppedBtn')));
    } else if (showStop) {
      b._subStop = el('button', 'tc-sub-stop', t('subagent.stop'));
      b._subStop.addEventListener('click', (e) => {
        e.stopPropagation();
        b._subStop.disabled = true;
        b._subStop.textContent = t('subagent.stopping');
        fetch(`/api/sessions/${encodeURIComponent(state.session)}/subagents/stop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ seq: data.seq }),
        }).catch(() => {
          if (b._subStop) { b._subStop.disabled = false; b._subStop.textContent = t('subagent.stop'); }
        });
      });
      body.appendChild(b._subStop);
    }
  };
  b.subagent = (ev) => {
    if (name !== 'delegate') return;
    if (ev.type === 'start') {
      if (st) st.textContent = t('subagent.running');
    } else if (ev.type === 'step') {
      const act = ev.tool || t('subagent.thinking');
      if (st) st.textContent = `${act} ${ev.step}/${ev.maxSteps}`;
    } else if (ev.type === 'think') {
      b._subItems.push({ kind: 'think', text: ev.text || '' });
    } else if (ev.type === 'toolStart') {
      b._subItems.push({ kind: 'tool', text: ev.argsPreview || ev.text || '' });
    } else if (ev.type === 'toolEnd') {
      const head0 = ((ev.outputPreview || [])[0] || '').split('\n')[0];
      b._subItems.push({ kind: 'result', text: head0 || (ev.toolOk === false ? t('tool.failed') : t('tool.noOutput')), ok: ev.toolOk !== false });
    } else if (ev.type === 'stopped') {
      b._subStopped = true;
      if (st) st.textContent = t('subagent.stopped');
      if (b._subStop) { b._subStop.remove(); b._subStop = null; }
    } else if (ev.type === 'end') {
      card.classList.remove('running');
      const sp = head.querySelector('.spin');
      if (sp) sp.remove();
      if (st) st.textContent = ev.status === 'ok' ? t('tool.ok') : t('tool.failed');
      if (b._subStop) { b._subStop.remove(); b._subStop = null; }
      body.classList.remove('hidden'); // 完成后展开显示明细（结果比命令重要）
    }
    // 截断：超过 60 条丢最早
    const MAX = 60;
    if (b._subItems.length > MAX) {
      const drop = b._subItems.length - MAX;
      b._subItems.splice(0, drop);
      b._subDropped += drop;
    }
    // 展开（或运行中用户已打开）时实时刷新；head 点击展开后也重绘最新明细
    if (!body.classList.contains('hidden')) subPaint();
  };
  // head 点击展开/收起：原 toggle handler 已存在，展开后追加重绘最新明细
  head.addEventListener('click', () => {
    if (!body.classList.contains('hidden')) subPaint();
  });
  return b;
}

/* 从历史消息渲染已完成的 thinking 块（刷新恢复用：reasoning / reasoningMs 已随 assistant
 * 消息持久化）。reasoningMs = 思考耗时毫秒；旧会话（无该字段）→ 用 block 的 finish() 里
 * `_startTime → Date.now()` 兜底（即加载耗时，非原始），或 0。 */
function renderHistoryThinking(sessionId, reasoning, reasoningMs) {
  const b = thinkingBlock(sessionId);
  b._chars = String(reasoning || '').length;
  b._body.textContent = reasoning || '';
  // 有持久化的原始思考耗时 → 覆写 startTimer，让 finish() 算出正确原始耗时
  if (typeof reasoningMs === 'number' && reasoningMs > 0) {
    b._startTime = Date.now() - reasoningMs;
  }
  b.finish();
  return b;
}

/* 从历史消息渲染已完成的工具卡片（刷新恢复用） */
function renderHistoryTool(sessionId, name, argsJson, output) {
  setEmptyState(false);
  const b = makeBlock('tool', sessionId);
  const wrap = el('div', 'msg');
  const isExplored = name === 'read_file' || name === 'search_code' || name === 'list_directory' || name === 'web_fetch' || name === 'web_search';
  const isEdit = name === 'write_file' || name === 'edit_file';

  let parsedArgs = {};
  try { parsedArgs = JSON.parse(argsJson || '{}'); } catch {}
  const preview = formatToolArgs(name, parsedArgs);

  if (isExplored) {
    const block = el('div', 'explored-block');
    const headText = name === 'read_file' ? 'Explored — 1 read' : name === 'web_fetch' ? 'Explored — 1 fetch' : 'Explored — 1 search';
    const head = el('div', 'explored-head');
    head.innerHTML = `<span class="explored-icon">→</span><span class="explored-title">${esc(headText)}</span>`;
    const item = el('div', 'explored-item', preview || name);
    item.classList.add('hidden');
    head.addEventListener('click', () => {
      item.classList.toggle('hidden');
      scrollBottom();
    });
    block.appendChild(head);
    block.appendChild(item);
    wrap.appendChild(block);
    msgList().appendChild(wrap);
    b._card = block;
    return b;
  }

  if (isEdit) {
    const diffWrap = el('div', 'tc-diff');
    const path = parsedArgs.path || '';
    const isNew = parsedArgs.original == null && parsedArgs.content != null;
    const headPrefix = isNew ? '← Write' : '← Edit';
    if (window.OmniMarkdown?.renderFileDiff && parsedArgs.content != null) {
      diffWrap.innerHTML = window.OmniMarkdown.renderFileDiff(parsedArgs.original, parsedArgs.content, path);
    } else {
      diffWrap.innerHTML = `<div class="md-diff-wrap"><div class="md-diff-head-title">${headPrefix} ${esc(path)}</div><pre class="tc-output">${esc(output || '')}</pre></div>`;
    }
    wrap.appendChild(diffWrap);
    msgList().appendChild(wrap);
    b._card = diffWrap;
    return b;
  }

  const card = el('div', 'tool-card');
  const head = el('div', 'tc-head');
  if (name === 'run_command') {
    const cmd = (parsedArgs.command || preview || '').trim().replace(/^●\s*Bash\(/, '').replace(/\)$/, '');
    head.innerHTML = `<span class="tool-dot">●</span> <span class="tool-name">Bash</span><span class="tool-args">(${esc(cmd)})</span>`;
  } else {
    head.appendChild(el('span', 'tc-cmd', name || 'tool'));
    const st = el('span', 'tc-state');
    const chars = output ? output.length : 0;
    const charsTxt = chars ? t('tool.nchars', { n: chars }) : t('tool.noOutput');
    st.textContent = preview ? `${preview} · ${charsTxt}` : charsTxt;
    head.appendChild(st);
  }
  const body = el('div', 'tc-body');
  body.classList.add('hidden');
  head.addEventListener('click', () => {
    body.classList.toggle('hidden');
    scrollBottom();
  });
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
  if ((name === 'read_file' || name === 'write_file' || name === 'edit_file') && a.path) return a.path;
  if (name === 'list_directory' && a.path) return a.path;
  if (name === 'search_code' && a.pattern) return a.pattern;
  if (name === 'web_fetch' && a.url) return `* Fetch ${a.url}`;
  if (name === 'web_search' && a.query) return `* Search ${a.query}`;
  if (name === 'skill' && a.name) return `* Skill ${a.name}`;
  if (name === 'ask_user' && a.question) return `? ${String(a.question).split('\n').map((l) => l.trim()).find(Boolean) || ''}`;
  if (name === 'delegate' && a.task) return `→ ${a.agent ? `${a.agent} · ` : ''}${String(a.task).split('\n').map((l) => l.trim()).find(Boolean) || ''}`.slice(0, 120);
  if (name === 'diagnose') return `* Check ${a.scope || 'all'}`;
  if (name === 'todo_write' && Array.isArray(a.todos)) {
    const done = a.todos.filter((t) => t && typeof t === 'object' && t.status === 'completed').length;
    return `☑ ${done}/${a.todos.length} 完成`;
  }
  if (name === 'memory_search' && a.query) return `* Recall ${a.query}`;
  if (name === 'memory_read' && a.path) return `* Memory ${a.path}`;
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
  return String(sid || '').slice(0, 8) || t('session.unknown');
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
    meta.title = t('approval.confirmTitle');
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
    const p = s.project || t('ws.unknown');
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
    addBtn.title = t('ws.newIn', { name: projectName(project) });
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      switchWorkspace(project).then(() => newSession()).catch((err) => notify(t('err.workspaceSwitch', { msg: err.message }), 'error'));
    });
    head.appendChild(addBtn);
    const moreBtn = el('span', 'ws-gadd', '⋯');
    moreBtn.title = t('ws.actions');
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
      const ts = state.language === 'en'
        ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ` ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
        : `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const copy = el('div', 'session-copy');
      copy.appendChild(el('div', 'stitle', s.title || t('session.new')));
      const meta = el('div', 'smeta');
      meta.appendChild(el('span', '', t('session.msgCount', { n: s.messages || 0 })));
      meta.appendChild(el('span', '', ts));
      copy.appendChild(meta);
      item.appendChild(copy);
      const more = el('span', 'session-more', '⋯');
      more.title = t('session.actions');
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        showSessionActions(e, s);
      });
      item.appendChild(more);
      // 点击跨工作区的会话：先切到该工作区（工具/记忆/系统提示跟随），再加载对话
      item.addEventListener('click', () => {
        const target = s.project && s.project !== t('ws.unknown') ? s.project : null;
        const needSwitch = target && target !== (state.status?.cwd || '');
        const doSelect = () => selectSession(s.id).catch((e) => console.error(e));
        if (needSwitch) switchWorkspace(target).then(doSelect).catch((err) => notify(t('err.openSession', { msg: err.message }), 'error'));
        else doSelect();
      });
      body.appendChild(item);
    }
    list.appendChild(body);
  }
}

/** 工作区分组显示名：目录 basename（根目录显示 /）；未知工作区显示翻译占位 */
function projectName(p) {
  if (!p || p === t('ws.unknown')) return p || t('ws.unknown');
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
  const ren = mk(t('session.rename'), async (id) => {
    const title = prompt(t('session.titlePrompt'), $('#chat-title').textContent || '');
    if (!title || !title.trim()) return;
    await api(`/api/sessions/${id}/rename`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: title.trim() }) });
    $('#chat-title').textContent = title.trim();
    refreshSessions().catch(() => {});
  });
  const forkB = mk(t('session.fork'), (id) => openForkDialog({ id }));
  const exp = mk(t('session.export'), (id) => window.open(`/api/sessions/${id}/export`, '_blank'));
  const rw = mk(t('session.rewind'), (id) => openRewindModal(id));
  const del = mk(t('session.delete'), async (id) => {
    if (!confirm(t('session.deleteConfirm'))) return;
    await api(`/api/sessions/${id}/delete`, { method: 'DELETE' }).catch((err) => notify(t('err.delete', { msg: err.message }), 'error'));
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
    const raw = prompt(t('fork.prompt', { max: maxN }), String(Math.max(1, Math.min(maxN, 4))));
    if (raw === null) return;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > maxN) { notify(t('fork.invalid', { max: maxN }), 'error'); return; }
    api(`/api/sessions/${s.id}/fork`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ n }),
    })
      .then(() => refreshSessions())
      .catch((err) => notify(t('err.fork', { msg: err.message }), 'error'));
  }).catch(() => {});
}

/** /rewind 面板：列出检查点（附与当前工作区差异），一键回滚 */
async function openRewindModal(sessionId) {
  $('#rewind-modal').classList.remove('hidden');
  const list = $('#rewind-list');
  list.innerHTML = `<div class="dir-empty">${esc(t('rewind.loading'))}</div>`;
  try {
    const cps = await api(`/api/sessions/${sessionId}/checkpoints`);
    list.innerHTML = '';
    if (!cps.length) {
      list.appendChild(el('div', 'dir-empty', t('rewind.empty')));
      return;
    }
    [...cps].reverse().forEach((c) => {
      const row = el('div', 'rewind-row');
      const main = el('div', 'rewind-main');
      main.appendChild(el('div', 'rewind-msg', `#${c.index} · ${c.userMessage || t('rewind.noText')}`));
      const d = c.diff || { add: 0, rem: 0 };
      const diffTxt = d.add + d.rem > 0 ? t('rewind.diff', { n: d.add + d.rem, add: d.add, rem: d.rem }) : t('rewind.same');
      main.appendChild(el('div', 'rewind-meta', `${new Date(c.time).toLocaleString()} · ${t('rewind.files', { n: c.files })} · ${diffTxt}`));
      row.appendChild(main);
      const btn = el('button', 'primary', t('rewind.rollback'));
      btn.type = 'button';
      btn.addEventListener('click', async () => {
        if (!confirm(t('rewind.confirm', { index: c.index }))) return;
        try {
          await api(`/api/sessions/${sessionId}/rewind`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ index: c.index }),
          });
          $('#rewind-modal').classList.add('hidden');
          notify(t('rewind.done', { index: c.index, n: c.files }), 'success');
        } catch (err) { notify(t('rewind.failed', { msg: err.message }), 'error'); }
      });
      row.appendChild(btn);
      list.appendChild(row);
    });
  } catch (err) {
    list.innerHTML = '';
    list.appendChild(el('div', 'dir-empty', t('rewind.loadFailed', { msg: err.message })));
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
  const del = el('button', 'ctx-item danger', t('ws.remove'));
  del.type = 'button';
  del.addEventListener('click', () => {
    closeSessionActions();
    if (!confirm(t('ws.removeConfirm', { name: projectName(project), count }))) return;
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
      .catch((err) => notify(t('err.remove', { msg: err.message }), 'error'));
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
  const ren = el('button', 'ctx-item', t('session.rename'));
  ren.type = 'button';
  ren.addEventListener('click', () => {
    closeSessionActions();
    const title = prompt(t('session.titlePrompt'), s.title || '');
    if (title === null) return;
    const newTitle = title.trim();
    if (!newTitle) return;
    api(`/api/sessions/${s.id}/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: newTitle }),
    })
      .then(() => {
        s.title = newTitle;
        const live = state.sessions.find((x) => x.id === s.id);
        if (live) live.title = newTitle;
        if (state.session === s.id) $('#chat-title').textContent = newTitle;
        renderSessionList();
      })
      .catch((err) => notify(t('err.rename', { msg: err.message }), 'error'));
  });
  const del = el('button', 'ctx-item danger', t('session.delete'));
  del.type = 'button';
  del.addEventListener('click', () => {
    closeSessionActions();
    if (!confirm(t('session.deleteNamedConfirm', { name: s.title || s.id }))) return;
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
      .catch((err) => notify(t('err.delete', { msg: err.message }), 'error'));
  });
  if (s.project === (state.status?.cwd || '')) {
    const forkB = el('button', 'ctx-item', t('session.fork'));
    forkB.type = 'button';
    forkB.addEventListener('click', () => { closeSessionActions(); openForkDialog(s); });
    const exp = el('button', 'ctx-item', t('session.export'));
    exp.type = 'button';
    exp.addEventListener('click', () => { closeSessionActions(); window.open(`/api/sessions/${s.id}/export`, '_blank'); });
    const rw = el('button', 'ctx-item', t('session.rewind'));
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
  state.turnUsages = [];
  state.turnLlmMs = 0;
  state.turnGenMs = 0;
  state.turnFirstTokenSum = 0;
  state.turnFirstTokenCount = 0;
  state.inFlight = 0;
  updateDetails();
}

/** 清空当前会话的待发送队列（切换会话 / 新建 / 删除时调用，避免消息错发到别的会话） */
function clearPendingMessages() {
  state.messageQueue = [];
  state.steerText = null;
  state.delegateRuns.length = 0; // delegate 面板同属「当前会话运行中」的临时 UI
  const ql = $('#queue-list'); if (ql) { ql.classList.add('hidden'); ql.innerHTML = ''; }
  renderDelegatePanel();
  updateComposer();
}

function renderWelcome() {
  setEmptyState($('#messages').children.length === 0);
}

function updateDetails() {
  const st = state.status || {};
  const eff = st.reasoningEffort;
  const label = $('#composer-model-label');
  // 结构：模型 · provider 组 · 思考级别（思考级别用独立 span 上档位色——与卡片 slider 档位配色一致）
  // 会话平均速率由 updatePillAvg() 写入 #composer-avg-rate（胶囊内模型名右侧）
  if (st.model) {
    const cur = (Array.isArray(st.models) ? st.models : []).find((m) => m && m.name === st.model);
    const provider = (cur && cur.provider) || '';
    label.textContent = '';
    const m = document.createElement('span');
    m.textContent = st.model;
    label.appendChild(m);
    if (provider) {
      const p = document.createElement('span');
      p.textContent = `· ${provider}`;
      p.style.opacity = '.78'; // provider 组弱化显示，介于模型名与档位色之间
      label.appendChild(p);
    }
    if (eff) {
      const e = document.createElement('span');
      e.textContent = `· ${eff}`;
      e.style.color = currentLevelColor(st) || '';
      e.style.fontWeight = '600';
      label.appendChild(e);
    }
  } else {
    label.textContent = '—';
  }
  $('#composer-mode').textContent = state.planMode ? t('composer.planMode') : t('composer.standardMode');
  updatePermissionPill();
  updateContextRing();
}

/** 更新模型胶囊内的会话平均速率（`· 167 tok/s`；无数据时隐藏） */
function updatePillAvg() {
  const tag = $('#composer-avg-rate');
  if (!tag) return;
  const s = state.session ? state.sessionStats.get(state.session) : null;
  const u = state.session ? state.sessionUsage.get(state.session) : null;
  const rate = (s && u) ? sessionAvgRate(s, u) : 0;
  if (rate > 0) {
    tag.textContent = `· ${rate} tok/s`;
    tag.classList.remove('hidden');
  } else {
    tag.textContent = '';
    tag.classList.add('hidden');
  }
}
/** 更新输入区下方右侧的上下文用量（渐变进度条动画 + `18.3K/128K (19%)`；无用量时隐藏） */
function updateContextRing() {
  const tag = $('#composer-ctx');
  if (!tag) return;
  const u = state.session ? state.sessionUsage.get(state.session) : null;
  const lastPrompt = (u && u.lastPrompt) || 0;
  const limit = contextLimit() || 0;
  if (lastPrompt <= 0) {
    tag.classList.add('hidden');
    updateComposerMetaVisibility();
    return;
  }
  const pct = limit > 0 ? Math.min(100, Math.round((lastPrompt / limit) * 100)) : 0;
  const usage = limit > 0 ? `${fmtCompact(lastPrompt)}/${fmtCompact(limit)} (${pct}%)` : fmtCompact(lastPrompt);
  const fill = $('#composer-ctx-fill');
  const label = $('#composer-ctx-text');
  if (fill) fill.style.width = `${pct}%`;
  if (label) label.textContent = usage;
  let color = 'var(--blue, #3b82f6)';
  if (pct >= 90) color = 'var(--red, #ef4444)';
  else if (pct >= 70) color = 'var(--amber, #f59e0b)';
  tag.style.setProperty('--ctx-color', color);
  tag.classList.remove('hidden');
  tag.title = limit > 0
    ? t('composer.ctxTitle', { used: fmtCompact(lastPrompt), limit: fmtCompact(limit), pct })
    : t('composer.ctxTitleShort', { used: fmtCompact(lastPrompt) });
  updateComposerMetaVisibility();
}

/* 权限 pill（composer 底栏左侧）：label 文本 + 配色类 */
function updatePermissionPill() {
  const st = state.status || {};
  const perm = st.permission || 'safe';
  const map = { full: t('perm.full'), safe: t('perm.safe'), ask: t('perm.ask'), read: t('perm.read') };
  const pl = $('#perm-label');
  if (pl) pl.textContent = map[perm] || perm;
  const pill = $('#btn-permission');
  // 四档程度色类（read/ask/safe/full 都有独立配色；未知档回退基础样式）
  if (pill) pill.className = 'perm-pill' + (['read', 'ask', 'safe', 'full'].includes(perm) ? ` ${perm}` : '');
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
/* 权限四档（放行程度升序，与输入区权限面板一致）：只读 < 请求批准 < 帮我批准 < 完全访问 */
const PERM_TIERS = ['read', 'ask', 'safe', 'full'];
function permMeta(v) {
  return {
    read: ['perm.read', 'perm.readDesc'],
    ask: ['perm.ask', 'perm.askDesc'],
    safe: ['perm.safe', 'perm.safeDesc'],
    full: ['perm.fullTitle', 'perm.fullDesc'],
  }[v] || ['perm.safe', 'perm.safeDesc'];
}
/** 权限档位行（输入区 pop 与设置 · 通用共用同一构造：图标 + 标题 + 描述 + 选中勾） */
function makePermItem(v, perm) {
  const [titleKey, descKey] = permMeta(v);
  const btn = el('button', `pp-item ${v}` + (perm === v ? ' active' : '')); // 档位类：弹层内四项按程度配色
  btn.type = 'button';
  const ic = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  ic.setAttribute('class', 'pp-icon');
  const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  u.setAttribute('href', '#i-shield');
  ic.appendChild(u);
  btn.appendChild(ic);
  const main = el('div', 'pp-main');
  main.appendChild(el('div', 'pp-title', t(titleKey)));
  main.appendChild(el('div', 'pp-desc', t(descKey)));
  btn.appendChild(main);
  if (perm === v) {
    const ck = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ck.setAttribute('class', 'pp-check');
    const cu = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    cu.setAttribute('href', '#i-check');
    ck.appendChild(cu);
    btn.appendChild(ck);
  }
  btn.addEventListener('click', () => {
    applySettings({ permission: v }).catch((err) => notify(t('err.settings', { msg: err.message }), 'error'));
    closeAllComposerPops();
  });
  return btn;
}
/** 设置 · 通用权限列表（与输入区权限面板同一份四档，点击即切换） */
function renderSettingsPermList() {
  const box = $('#set-perm-list');
  if (!box) return;
  const perm = (state.status && state.status.permission) || 'safe';
  box.innerHTML = '';
  PERM_TIERS.forEach((v) => box.appendChild(makePermItem(v, perm)));
}
function renderPermissionPop() {
  renderSettingsPermList(); // 设置页列表同源重绘（refreshStatus/语言切换/联动切换统一走这里）
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
  PERM_TIERS.forEach((v) => list.appendChild(makePermItem(v, perm)));
  pop.appendChild(list);
}
/** 渲染回合底部统计信息（Build / 模型 / 耗时 / tok/s / Tokens 消耗明细） */
function renderTurnFooter(sessionId, data) {
  const usages = data.usages || [];
  const tokens = data.tokens;
  if (!usages.length && (!tokens || (tokens.prompt + tokens.completion === 0))) return null;

  let sumNew = 0, sumCached = 0, sumTotal = 0;
  for (const item of usages) {
    const cached = item.cached || 0;
    sumNew += Math.max(0, item.prompt - cached);
    sumCached += cached;
    sumTotal += (item.total || (item.prompt + item.completion));
  }
  if (usages.length === 0 && tokens) {
    const cached = tokens.cached || 0;
    sumNew = Math.max(0, tokens.prompt - cached);
    sumCached = cached;
    sumTotal = tokens.prompt + tokens.completion;
  }

  const fmtN = (n) => n.toLocaleString();
  const wrap = el('div', 'msg');
  const footer = el('div', 'turn-footer');

  const modelName = data.model || state.status?.model || 'Omni';
  const durMs = data.durMs || 0;
  const durStr = formatDuration(durMs);
  const genMs = data.genMs || 0;
  const compTok = data.completion || usages.reduce((acc, u) => acc + (u.completion || 0), 0);
  const rate = genMs > 0 ? Math.round(compTok / (genMs / 1000)) : (durMs > 0 ? Math.round(compTok / (durMs / 1000)) : 0);
  const rateStr = rate > 0 ? ` · ${rate} tok/s` : '';
  const ftAvg = data.firstTokenAvg;
  const ftStr = (ftAvg != null && ftAvg > 0) ? t('turn.firstToken', { dur: fmtToolDur(ftAvg) }) : '';

  const metaDiv = el('div', 'turn-meta', `Build · ${modelName} · ${durStr}${ftStr}${rateStr}`);
  footer.appendChild(metaDiv);

  const tokensDiv = el('div', 'turn-tokens');
  const stepCount = Math.max(1, usages.length);
  const headText = `- Tokens: ${stepCount} step${stepCount > 1 ? 's' : ''} · ${fmtN(sumNew)} new · ${fmtN(sumCached)} cached · ${fmtN(sumTotal)} total`;
  const tokensHead = el('div', 'turn-tokens-head', headText);
  const tokensTable = el('div', 'turn-tokens-table');

  const headerRow = el('div', 'token-row header');
  headerRow.innerHTML = `<span class="col-step">Step</span><span class="col-new">New</span><span class="col-cached">Cached</span><span class="col-total">Total</span>`;
  tokensTable.appendChild(headerRow);

  const stepList = usages.length > 0 ? usages : [{ prompt: tokens?.prompt || sumNew, completion: tokens?.completion || 0, cached: sumCached, total: sumTotal }];
  for (let i = 0; i < stepList.length; i++) {
    const item = stepList[i];
    const stepName = i === stepList.length - 1 ? 'stop' : 'tool-call';
    const cached = item.cached || 0;
    const newTok = Math.max(0, item.prompt - cached);
    const tot = item.total || (item.prompt + item.completion);
    const row = el('div', 'token-row');
    row.innerHTML = `<span class="col-step">${stepName}</span><span class="col-new">${fmtN(newTok)}</span><span class="col-cached">${fmtN(cached)}</span><span class="col-total">${fmtN(tot)}</span>`;
    tokensTable.appendChild(row);
  }

  tokensHead.addEventListener('click', () => {
    tokensTable.classList.toggle('hidden');
    scrollBottom();
  });

  tokensDiv.appendChild(tokensHead);
  tokensDiv.appendChild(tokensTable);
  footer.appendChild(tokensDiv);
  wrap.appendChild(footer);
  msgList().appendChild(wrap);
  return wrap;
}

/** 从历史消息渲染会话内容（用户/思考/工具卡片/回答/回合统计）——selectSession 与
 *  运行中刷新后的 run.end 回填共用；不清会话状态、不动待发送队列。 */
async function renderSessionHistory(id) {
  try {
    const data = await api(`/api/sessions/${id}/messages`);
    const s = state.sessions.find((x) => x.id === id);
    $('#chat-title').textContent = s?.title || (data.meta?.title) || t('session.title');
    // 会话级累计按历史重建（底部状态行 = 全会话平均，不只是本页新消息）
    rebuildSessionStats(id, data.messages);
    updateComposerMeta();

    let currentTurnUsages = [];
    let currentTurnModel = null;
    let currentTurnDurMs = 0;
    let currentTurnGenMs = 0;
    let currentTurnFirstTokenSum = 0;
    let currentTurnFirstTokenCount = 0;

    const flushTurnFooter = () => {
      if (currentTurnUsages.length > 0) {
        renderTurnFooter(id, {
          usages: currentTurnUsages,
          model: currentTurnModel,
          durMs: currentTurnDurMs,
          genMs: currentTurnGenMs,
          firstTokenAvg: currentTurnFirstTokenCount > 0 ? currentTurnFirstTokenSum / currentTurnFirstTokenCount : null,
        });
        currentTurnUsages = [];
        currentTurnModel = null;
        currentTurnDurMs = 0;
        currentTurnGenMs = 0;
        currentTurnFirstTokenSum = 0;
        currentTurnFirstTokenCount = 0;
      }
    };

    data.messages.forEach((m) => {
      const txt = typeof m.content === 'string' ? m.content : '';
      if (m.role === 'user') {
        flushTurnFooter(); // 遇到新一轮用户消息：先结算并渲染上一轮的 turn-footer
        // 数组 content（图片/文本附件）：解析为附件 chips + 正文（历史恢复最小渲染）
        const parsed = parseUserContent(m.content);
        userBlock(id, parsed.text, parsed.attachments);
      } else if (m.role === 'assistant') {
        if (m.usage) currentTurnUsages.push(m.usage);
        if (m.model) currentTurnModel = m.model;
        if (typeof m.durMs === 'number') currentTurnDurMs += m.durMs;
        if (typeof m.genMs === 'number') currentTurnGenMs += m.genMs;
        if (typeof m.firstTokenMs === 'number' && m.firstTokenMs > 0) {
          currentTurnFirstTokenSum += m.firstTokenMs;
          currentTurnFirstTokenCount++;
        }

        // 先恢复 thinking（reasoning + reasoningMs 已持久化，恢复耗时），再恢复工具卡片，
        // 最后正文——与实时 SSE 渲染顺序一致（user → thinking → tool → answer）
        if (m.reasoning) renderHistoryThinking(id, m.reasoning, m.reasoningMs);
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
    flushTurnFooter(); // 历史最后一条消息后：结算并渲染最后一轮的 turn-footer
    revealLastAnswer(); // 历史已加载完：仅最后一个回答带 拷贝/重新处理
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
    renderAboutTools(s.tools);
    $('#about-server').textContent = `http://${location.host}`;
    $('#plan-mode').checked = state.planMode;
    const sp = $('#set-plan');
    if (sp) sp.checked = state.planMode;
    const sc = $('#set-concurrency');
    if (sc) sc.value = String(s.concurrency || 3);
    updateConcurrencySlider(s.concurrency || 3); // 并发滑条填充/刻度/读数同步
    fillModelConfigForm(s);
    applyLanguage(s.language || 'zh');
    // 主题：后端配置优先（覆盖本地缓存），并同步本地缓存
    const theme = applyTheme(s.webTheme || 'system');
    storeTheme(theme);
    const workspaceName = s.cwd ? s.cwd.split('/').filter(Boolean).pop() || t('ws.current') : t('ws.current');
    $('#hero-workspace-name').textContent = workspaceName;
    updateDetails();
    updateComposer();
    updateStatusText();
    updateComposerMeta();
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
  renderDelegatePanel(); // 运行中 delegate 面板（空时自隐藏）——会话切换/发送/结束即刷新
  updateComposerMeta(); // 输入区下方元信息行（会话切换/发送/结束即刷新）
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

/* ---- 输入区元信息行（左文件夹/loading · 中均值/输入输出/缓存 · 右上下文用量）----
 * 每会话独立累计（sessionStats/sessionUsage Map，SSE 事件驱动 + 历史重建）。 */
function sessionAvgRate(s, u) {
  const live = (state.liveStream && state.liveStream.sessionId === state.session) ? state.liveStream : null;
  // 全无计时数据（无请求、无 live）→ 报 0（调用方隐藏），避免 1ms 下限造出离谱峰值
  if (s.llmMs <= 0 && s.genMs <= 0 && (!live || live.liveGenMs <= 0)) return 0;
  const comp = u.completion + (live?.streamTokens ?? 0);
  const baseGen = s.genMs > 0 ? s.genMs : Math.max(1, s.llmMs);
  const gen = baseGen + (live?.liveGenMs ?? 0);
  return gen > 0 ? Math.round(comp / (gen / 1000)) : 0;
}
/** 当前模型 context 上限（config limit.context；未知返回 0）——输入框模型胶囊内 context 环用 */
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
    state.sessionStats.set(sid, { turns: 0, steps: 0, llmMs: 0, toolsMs: 0, genMs: 0, cached: 0 });
  }
  return state.sessionStats.get(sid);
}
function usageOf(sid) {
  if (!state.sessionUsage.has(sid)) {
    state.sessionUsage.set(sid, { prompt: 0, completion: 0, total: 0, cached: 0, lastPrompt: 0 });
  }
  return state.sessionUsage.get(sid);
}
/* 从历史消息重建会话级累计（切会话/刷新恢复时调用）：
 * 输入/输出/缓存/llmMs/genMs/轮数/步数按 assistant 消息持久化的 usage/durMs/genMs/tool_calls 求和；
 * 首 token（firstTokenSum/Count）、瞬时 lastTps、工具耗时 toolsMs 无持久化，保持本页事件值不动
 * （首 token 等下一轮新消息到达再展示）。先重置再累加，避免与 SSE 事件重复计数；
 * run.end 后回填历史（含刚结束的一轮）同样走这里，结果与事件累计一致。 */
function rebuildSessionStats(id, messages) {
  const s = statsOf(id);
  const u = usageOf(id);
  s.turns = 0; s.steps = 0; s.llmMs = 0; s.genMs = 0; s.cached = 0;
  u.prompt = 0; u.completion = 0; u.total = 0; u.cached = 0; u.lastPrompt = 0;
  for (const m of messages || []) {
    if (m.role === 'user') { s.turns += 1; continue; }
    if (m.role !== 'assistant') continue;
    const um = m.usage;
    if (um) {
      u.prompt += um.prompt || 0;
      u.completion += um.completion || 0;
      u.total += um.total || ((um.prompt || 0) + (um.completion || 0));
      u.cached += um.cached || 0;
      s.cached += um.cached || 0;
      u.lastPrompt = um.prompt || 0;
    }
    if (typeof m.durMs === 'number') s.llmMs += m.durMs;
    if (typeof m.genMs === 'number') s.genMs += m.genMs;
    if (Array.isArray(m.tool_calls)) s.steps += m.tool_calls.length;
  }
}
/** 渲染输入区下方元信息行：左[文件夹/loading] · 中[输入输出/缓存] · 右[上下文用量] */
function updateComposerMeta() {
  updatePillAvg();
  updateContextRing();
  const wrap = $('#composer-meta');
  if (!wrap) return;
  const s = state.session ? state.sessionStats.get(state.session) : null;
  const u = state.session ? state.sessionUsage.get(state.session) : null;
  const en = state.language === 'en';
  // 中部：输入输出精简文本 + 缓存（无缓存数据不显示）
  const mid = $('#composer-mid');
  const parts = [];
  if (u && (u.prompt > 0 || u.completion > 0)) {
    parts.push(en ? `In ${fmtCompact(u.prompt)} · Out ${fmtCompact(u.completion)}` : `输入 ${fmtCompact(u.prompt)} · 输出 ${fmtCompact(u.completion)}`);
  }
  if (s && u && s.cached > 0 && u.prompt > 0) {
    const pct = Math.min(100, Math.round((s.cached / u.prompt) * 100));
    parts.push(en ? `Cache ${pct}%` : `缓存 ${pct}%`);
  }
  mid.textContent = parts.join(' · ');
  mid.classList.toggle('hidden', parts.length === 0);
  updateComposerMetaVisibility();
}
/** 整行显隐：中/右全空才隐藏 */
function updateComposerMetaVisibility() {
  const wrap = $('#composer-meta');
  if (!wrap) return;
  const mid = $('#composer-mid');
  const ctx = $('#composer-ctx');
  const show = [mid, ctx].some((n) => n && !n.classList.contains('hidden') && (n.textContent || '').trim() !== '');
  wrap.classList.toggle('hidden', !show);
}

/** 浏览新工作区：Electron 原生对话框；纯浏览器 → 页面内文件夹浏览器（服务端列目录，可导航到任意绝对路径）。
 *  浏览器 webkitdirectory 只能拿到所选文件夹的相对路径（File.path 只在 Electron 有），
 *  打开后还得再回退页面内浏览器，是多余的两步，因此纯浏览器直接走页面内目录浏览器。 */
function browseWorkspace() {
  if (window.omni && typeof window.omni.pickDirectory === 'function') {
    window.omni.pickDirectory()
      .then((dir) => {
        if (dir) switchWorkspace(dir).catch((err) => notify(t('err.workspaceSwitch', { msg: err.message }), 'error'));
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
    'thinking.end', 'tool.start', 'tool.result', 'tool.output', 'answer.chunk', 'answer.end',
    'stream.progress', 'turn.step', 'lap', 'toolsLap', 'usage', 'subagent', 'hook.output',
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
  updateComposerMeta();
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

let lastAnswerBlock = null; // 最近一个回答块（终答才挂拷贝/重新处理按钮）：run.end/error/cancel/历史加载时消费
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
  if (state.liveStream?.sessionId === ev.sessionId) {
    state.liveStream = null;
    updateComposerMeta();
  }
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
  // delegate 子代理（1.0 面板模型）：运行中不渲染流内工具卡，进入输入框上方的
  // delegate 面板（state.delegateRuns + renderDelegatePanel）；完成后 tool.result
  // 移除面板行 + 对话流留结果摘要。
  if (ev.name === 'delegate' && ev.seq != null) {
    if (!state.delegateRuns.some((r) => r.seq === ev.seq)) {
      state.delegateRuns.push({
        seq: ev.seq,
        title: ev.argsPreview || t('subagent.label'),
        status: t('subagent.running'),
        stopped: false,
        stopRequested: false,
        expanded: false,
        items: [],
        dropped: 0,
      });
      renderDelegatePanel();
    }
    state.inFlight++;
    updateComposerMeta();
    return;
  }
  const block = toolBlock(ev.sessionId, ev);
  currentTools.set(ev.seq ?? `f${currentTools.size}`, block);
  state.inFlight++;
  updateComposerMeta();
});
/* run_command 实时输出（live streaming）：按 seq 配对追加到卡片的 live 容器 */
bus.on('tool.output', (ev) => {
  if (ev.sessionId !== state.session) return;
  const key = ev.seq;
  const tool = key !== undefined ? currentTools.get(key) : null;
  if (tool && tool.appendLive) {
    // chunk 可能含多行（防御性 split：run_command 端已按 \n 拆过）
    for (const line of String(ev.chunk || '').split('\n')) tool.appendLive(line);
  }
});
bus.on('tool.result', (ev) => {
  if (ev.sessionId !== state.session) return;
  const key = ev.seq;
  // delegate 子代理完成：移除面板行 + 对话流留结果摘要卡（含明细，点击展开）
  const drIdx = state.delegateRuns.findIndex((r) => r.seq === key);
  if (drIdx >= 0) {
    const [run] = state.delegateRuns.splice(drIdx, 1);
    renderDelegatePanel();
    delegateResultBlock(ev.sessionId, ev, run);
    state.inFlight--;
    updateComposerMeta();
    return;
  }
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
  if (!state.turnUsages) state.turnUsages = [];
  state.turnUsages.push({
    prompt: ev.prompt || 0,
    completion: ev.completion || 0,
    total: ev.total || ((ev.prompt || 0) + (ev.completion || 0)),
    cached: ev.cached || 0,
  });
  state.turnTokens.prompt += ev.prompt || 0;
  state.turnTokens.completion += ev.completion || 0;
  state.turnTokens.cached += ev.cached || 0;
  // 会话级累计（输入区下方状态行）
  const u = usageOf(ev.sessionId);
  const s = statsOf(ev.sessionId);
  u.prompt += ev.prompt || 0;
  u.completion += ev.completion || 0;
  u.total += ev.total || 0;
  u.cached += ev.cached || 0;
  s.cached += ev.cached || 0; // 缓存命中累计（之前漏加导致 Web 缓存恒显示 0%，对标 TUI onUsage）
  u.lastPrompt = ev.prompt || 0; // 当前上下文 = 最近一次请求的 prompt token（footer context 段）
  updateComposerMeta();
});

bus.on('subagent', (ev) => {
  if (ev.sessionId !== state.session) return;
  const sev = ev.ev;
  if (!sev) return;
  // 按工具配对 seq 更新 delegate 面板行（并行多委托各自归集）；无 seq 回退最近运行行
  let run = null;
  if (sev.seq != null) {
    run = state.delegateRuns.find((r) => r.seq === sev.seq) ?? null;
  }
  if (!run) {
    run = [...state.delegateRuns].reverse().find((r) => !r.stopped && !r.stopRequested) ?? null;
  }
  if (run) {
    if (sev.type === 'start') {
      run.status = sev.depth > 0 ? t('subagent.depth', { n: sev.depth }) : t('subagent.running');
    } else if (sev.type === 'step') {
      run.status = `${sev.tool || t('subagent.thinking')} ${sev.step}/${sev.maxSteps}`;
    } else if (sev.type === 'think') {
      const txt = String(sev.text || '').slice(0, 400);
      if (txt) { run.items.push({ kind: 'think', text: txt }); trimRun(run); }
    } else if (sev.type === 'toolStart') {
      run.items.push({ kind: 'tool', text: sev.argsPreview || sev.text || t('subagent.work') });
      run.status = `⠋ ${sev.text || t('subagent.work')}…`;
      trimRun(run);
    } else if (sev.type === 'toolEnd') {
      const head0 = String((sev.outputPreview || [])[0] || '').split('\n')[0];
      run.items.push({ kind: 'result', text: head0 || (sev.toolOk === false ? t('tool.failed') : t('tool.noOutput')), ok: sev.toolOk !== false });
      trimRun(run);
    } else if (sev.type === 'stopped') {
      run.stopped = true;
      run.status = t('subagent.stopped');
    } else if (sev.type === 'end') {
      run.status = sev.status === 'ok' ? t('subagent.doneSteps', { n: sev.steps || 0 }) : t('tool.failed');
    }
    renderDelegatePanel();
  } else {
    // 无面板行（/orchestrate worker 等无 seq 流卡）：回退找 currentTools 里的 delegate 卡
    let block = null;
    if (sev.seq != null) block = currentTools.get(sev.seq) ?? null;
    if (!block) {
      for (const [, tb] of currentTools) {
        if (tb._data && tb._data.name === 'delegate') { block = tb; break; }
      }
    }
    if (block && block.subagent) block.subagent(sev);
  }
  if (sev.type === 'start') {
    state.inFlight++;
  } else if (sev.type === 'end') {
    state.inFlight--;
  }
  updateComposerMeta();
});

/* delegate 明细截断（超出 120 条丢最早） */
function trimRun(run) {
  const MAX = 120;
  if (run.items.length > MAX) {
    const drop = run.items.length - MAX;
    run.items.splice(0, drop);
    run.dropped += drop;
  }
}

/* 输入框上方 delegate 面板全量重绘（运行中的子代理；点击展开明细 + ⏹ 停止） */
function renderDelegatePanel() {
  const panel = $('#delegate-panel');
  if (!panel) return;
  const runs = state.delegateRuns;
  if (!runs.length) { panel.classList.add('hidden'); panel.innerHTML = ''; return; }
  panel.classList.remove('hidden');
  panel.innerHTML = '';
  for (const run of runs) {
    const item = el('div', 'dp-item' + (run.expanded ? ' open' : ''));
    const head = el('button', 'dp-head');
    const arrow = el('span', 'dp-arrow', '▶');
    const title = el('span', 'dp-title', run.title);
    const status = el('span', 'dp-status' + (run.stopped || run.stopRequested ? ' stopped' : ' running'), run.status);
    head.appendChild(arrow); head.appendChild(title); head.appendChild(status);
    head.addEventListener('click', () => {
      run.expanded = !run.expanded;
      renderDelegatePanel();
    });
    item.appendChild(head);
    const body = el('div', 'dp-body');
    if (run.dropped > 0) body.appendChild(el('div', 'dp-more', t('subagent.earlierDropped', { n: run.dropped })));
    // 明细最多显示最近 40 条（DOM 防爆）
    const shown = run.items.slice(-40);
    if (run.items.length > 40 && run.dropped === 0) {
      body.appendChild(el('div', 'dp-more', t('subagent.earlierDropped', { n: run.items.length - 40 })));
    }
    for (const it of shown) {
      if (it.kind === 'think') body.appendChild(el('div', 'dp-think', `💭 ${it.text}`));
      else if (it.kind === 'tool') body.appendChild(el('div', 'dp-tool', `→ ${it.text}`));
      else body.appendChild(el('div', 'dp-result' + (it.ok === false ? ' err' : ''), `${it.ok === false ? '✗' : '✓'} ${it.text}`));
    }
    if (run.stopped || run.stopRequested) {
      body.appendChild(el('div', 'dp-stopped', t('subagent.stoppedBtn')));
    } else {
      const stopBtn = el('button', 'dp-stop', t('subagent.stop'));
      stopBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        run.stopRequested = true;
        run.status = t('subagent.stopping');
        stopBtn.disabled = true;
        stopBtn.textContent = t('subagent.stopping');
        renderDelegatePanel();
        fetch(`/api/sessions/${encodeURIComponent(state.session)}/subagents/stop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ seq: run.seq }),
        }).catch(() => {
          run.stopRequested = false;
          renderDelegatePanel();
        });
      });
      body.appendChild(stopBtn);
    }
    item.appendChild(body);
    panel.appendChild(item);
  }
}

/* delegate 完成 → 对话流结果摘要卡（点击展开明细） */
function delegateResultBlock(sessionId, r, run) {
  setEmptyState(false);
  const b = makeBlock('tool', sessionId);
  const wrap = el('div', 'msg');
  const stopped = run.stopped || run.stopRequested;
  const ok = r.ok && !stopped;
  const card = el('div', 'tool-card');
  const head = el('div', 'tc-head');
  head.innerHTML = `<span class="tc-cmd">${esc(t('subagent.label'))}</span> <span class="tc-delegate-task">${esc(run.title)}</span>`;
  const st = el('span', 'tc-state');
  st.textContent = ok ? t('tool.ok') : t('tool.failed');
  if (stopped) st.textContent = t('subagent.stopped');
  head.appendChild(st);
  const body = el('div', 'tc-body');
  body.classList.add('hidden');
  head.addEventListener('click', () => {
    body.classList.toggle('hidden');
    if (!body.classList.contains('hidden')) paint();
    scrollBottom();
  });
  const paint = () => {
    body.innerHTML = '';
    if (run.dropped > 0) body.appendChild(el('div', 'tc-live-meta', t('subagent.earlierDropped', { n: run.dropped })));
    for (const it of run.items.slice(-60)) {
      if (it.kind === 'think') body.appendChild(el('div', 'tc-sub-think', `💭 ${it.text}`));
      else if (it.kind === 'tool') body.appendChild(el('div', 'tc-sub-tool', `→ ${it.text}`));
      else body.appendChild(el('div', 'tc-sub-result' + (it.ok === false ? ' err' : ''), `${it.ok === false ? '✗' : '✓'} ${it.text}`));
    }
    if (stopped) body.appendChild(el('div', 'tc-sub-stopped', t('subagent.stoppedBtn')));
  };
  paint();
  card.appendChild(head); card.appendChild(body);
  wrap.appendChild(card);
  msgList().appendChild(wrap);
  scrollBottom();
}

bus.on('run.end', async (ev) => {
  state.runningSessions.delete(ev.sessionId);
  state._localRunning.delete(ev.sessionId);
  statsOf(ev.sessionId).turns += 1; // 状态行：轮次累计
  updateComposerMeta();
  if (ev.sessionId !== state.session) { refreshSessions(); return; }
  currentTools.clear(); // 取消/打断时部分工具可能无 result 到达，清理避免错配下一轮
  // 回合结束兜底：delegate 面板清空（正常路径 tool.result 已逐个移除；取消/异常时残留）
  state.delegateRuns.length = 0;
  renderDelegatePanel();
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
  revealLastAnswer(); // 本轮真正结束：只在最后一个回答块上挂 拷贝/重新处理
  // 本轮统计行（对标 GUI 样式：Build · 模型 · 耗时 · 首 token · 速率 + Tokens 表格）
  // 注意：必须用本轮累计（turnLlmMs/turnGenMs/turnTokens/turnFirstToken），不能用会话累计 s/u——
  // 之前误传 s.llmMs/s.genMs/u.completion 导致每轮 footer 都等于会话平均（与底部状态行一致）
  const usages = state.turnUsages || [];
  const modelName = state.status?.model || 'Omni';
  renderTurnFooter(ev.sessionId, {
    usages,
    model: modelName,
    durMs: state.turnLlmMs || 0,
    genMs: state.turnGenMs || 0,
    tokens: state.turnTokens,
    completion: state.turnTokens.completion,
    firstTokenAvg: state.turnFirstTokenCount > 0 ? state.turnFirstTokenSum / state.turnFirstTokenCount : null,
  });
  state.turnUsages = [];
  state.turnTokens = { prompt: 0, completion: 0, cached: 0 };
  state.turnLlmMs = 0;
  state.turnGenMs = 0;
  state.turnFirstTokenSum = 0;
  state.turnFirstTokenCount = 0;
  state.inFlight = 0;
  if (state.liveStream?.sessionId === ev.sessionId) state.liveStream = null;
  updateComposerMeta();
  refreshSessions().then(updateDetails);
  scrollBottom(true);

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

// stream.progress：流式生成实时速率与用量
bus.on('stream.progress', (ev) => {
  if (ev.sessionId !== state.session) return;
  state.liveStream = ev;
  updateComposerMeta();
});

// lap：LLM 请求墙钟 / 首 token / 生成耗时（tok/s 用 genMs——排除首 token 等待）
bus.on('lap', (ev) => {
  if (ev.sessionId !== state.session) return;
  if (state.liveStream?.sessionId === ev.sessionId) state.liveStream = null;
  const s = statsOf(ev.sessionId);
  s.llmMs += ev.llmMs || 0;
  state.turnLlmMs += ev.llmMs || 0;
  if (ev.firstTokenMs != null) { state.turnFirstTokenSum += ev.firstTokenMs; state.turnFirstTokenCount++; }
  if (ev.genMs != null) { s.genMs += ev.genMs; state.turnGenMs += ev.genMs; }
  updateComposerMeta();
});

// toolsLap：工具执行墙钟
bus.on('toolsLap', (ev) => {
  if (ev.sessionId !== state.session) return;
  statsOf(ev.sessionId).toolsMs += ev.toolsMs || 0;
  updateComposerMeta();
});

// hook.output：Hook 输出回显
bus.on('hook.output', (ev) => {
  if (!ev.lines || !ev.lines.length) return;
  if (ev.sessionId && ev.sessionId !== state.session) return;
  metaLine(ev.sessionId || state.session, [`${ev.event || 'hook'}: ${ev.lines[0]}`]);
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
  revealLastAnswer(); // 出错：残存回答也算终答，允许拷贝/重试
  currentTools.clear();
  stopRunRing();
  updateComposer();
  scrollBottom(true);
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
      $('#chat-title').textContent = s.title || t('session.title');
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
  { name: '/plan', desc: '切换计划模式（只读调研，直接切换开关）' },
  { name: '/permission', desc: '权限面板切换（无参数打开面板，有参数直接切换）' },
  { name: '/model', desc: '模型面板切换（无参数打开面板，/model <名> 直接切换）' },
  { name: '/variants', desc: '思考级别面板切换（无参数打开面板，有参数直接切换）' },
  { name: '/models', desc: '模型能力快照：/models refresh 在线更新（models.dev）' },
  { name: '/undo', desc: '撤销最近的文件修改（all = 全部）' },
  { name: '/redo', desc: '重做上次撤销（all = 全部）' },
  { name: '/compact', desc: '手动压缩上下文为摘要' },
  { name: '/review', desc: '代码审查（typecheck + git diff）' },
  { name: '/diff', desc: '查看未提交改动（--stat 只看统计 · --full 不截断）' },
  { name: '/rewind', desc: '检查点面板（无参数打开面板，/rewind <N> 直接回滚）' },
  { name: '/trace', desc: '查看运行轨迹账本' },
  { name: '/agents', desc: '查看子代理配置与定义' },
  { name: '/orchestrate', desc: '并行编排（fan-out delegate → 汇总 → 审查）' },
  { name: '/goal', desc: '目标机制（自动推导验收标准并循环执行）' },
  { name: '/loop', desc: '/goal 别名' },
  { name: '/thinking', desc: '展开/收起全部思考过程' },
  { name: '/skill', desc: '技能管理（设置 → 技能页列表/新建/查看，或 find/add/show）' },
  { name: '/init', desc: '生成 AGENTS.md 项目记忆（--global 全局）' },
  { name: '/export', desc: '导出会话为 Markdown（直接下载文件）' },
  { name: '/config', desc: '查看配置文件路径' },
  { name: '/mcp', desc: 'MCP 管理（设置 → MCP 页可视化增删/重连/登录，或 resources/prompts/install）' },
  { name: '/rename', desc: '重命名会话（无参数弹窗输入，有参数直接改名）' },
  { name: '/session', desc: '会话切换面板（无参数打开面板，有参数直接跳转）' },
  { name: '/resume', desc: '会话切换面板（无参数打开面板，有参数直接跳转）' },
  { name: '/doctor', desc: '环境诊断（Node/API/配置）' },
  { name: '/spec', desc: '规格三件套（/spec <特性>）：requirements(EARS)/design/tasks 落盘 .omni/specs/' },
  { name: '/preset', desc: '能力一键预设（/preset browser 安装浏览器自动化双雄 MCP）' },
  { name: '/settings', desc: '打开设置面板（/settings <面板> 直达对应页）' },];

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
    const label = item.isDir ? item.name + '/' : item.name;
    row.innerHTML = '<span class="mention-label">' + esc(label) + '</span>';
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
  // 选中项滚进可视区（文件较多超出 max-height 时保证当前项可见）
  const cur = items[mentionSelIdx];
  if (cur) cur.scrollIntoView({ block: 'nearest' });
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
  cmdFiltered.forEach((c, i) => {
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
  const max = cmdFiltered.length;
  if (!max) return;
  cmdSelIdx = (cmdSelIdx + delta + max) % max;
  const items = cmdPalette.querySelectorAll('.cmd-item');
  items.forEach((n, i) => n.classList.toggle('selected', i === cmdSelIdx));
  // 选中项滚进可视区（列表超出 max-height 时上下键能预览到最下面的 item）
  const cur = items[cmdSelIdx];
  if (cur) cur.scrollIntoView({ block: 'nearest' });
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

/* —— 斜杠命令与 Web UI 联动（输入区命令直达真实功能，不只弹面板） ——
 * 有原生 UI 的命令走 UI（面板/弹窗/下载/切换），无 UI 的才走后端 /api/command 面板展示：
 *   模型/权限/计划/设置/检查点/分叉/导出/重命名/会话切换 → 原生 UI；
 *   状态/上下文/diff/review/诊断等纯文本命令 → 保留 cmd-panel 展示。
 * 后端联动型（/plan 带参切换类）走 /api/command 但渲染为右上角通知 + 状态刷新，
 * 不再弹 cmd-panel，保证“执行结果落到界面上”。 */
function parseSlash(cmd) {
  const s = String(cmd || '').trim();
  const sp = s.indexOf(' ');
  if (sp < 0) return { base: s, arg: '' };
  return { base: s.slice(0, sp), arg: s.slice(sp + 1).trim() };
}
/** 打开设置面板并直达指定 pane（general/theme/apikey/shortcuts/about；大小写/中文别名兼容） */
function openSettingsPane(arg) {
  openSettings();
  const a = String(arg || '').trim().toLowerCase();
  if (!a) return;
  const alias = {
    general: 'general', '通用': 'general',
    theme: 'theme', '主题': 'theme',
    apikey: 'apikey', api: 'apikey', model: 'apikey', '模型': 'apikey', '模型配置': 'apikey',
    mcp: 'mcp',
    skills: 'skills', skill: 'skills', '技能': 'skills',
    shortcuts: 'shortcuts', shortcut: 'shortcuts', '快捷键': 'shortcuts',
    about: 'about', '关于': 'about',
  };
  const target = alias[a] || alias[a.split(/\s+/)[0]] || null;
  if (!target) return;
  activateSettingsPane(target);
  if (target === 'mcp') loadMcpPane();
  else if (target === 'skills') loadSkillPane();
}
/** 设置面板直达某 pane（导航与内容同步切换） */
function activateSettingsPane(pane) {
  document.querySelectorAll('.settings-nav-item').forEach((n) => n.classList.toggle('active', n.dataset.pane === pane));
  document.querySelectorAll('#settings-modal .settings-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === pane));
}
/** 设置 · 关于工具 chips（输入区 pill 同族外观 + 计数，替代逗号分隔纯文本） */
function renderAboutTools(tools) {
  const box = $('#about-tools');
  const count = $('#about-tools-count');
  const list = Array.isArray(tools) ? tools : [];
  if (box) {
    box.innerHTML = '';
    list.forEach((name) => box.appendChild(el('span', 'tool-chip', String(name))));
  }
  if (count) count.textContent = t('settings.toolsCount', { n: list.length });
}
$('#about-copy-version').addEventListener('click', () => copyText($('#about-version').textContent || ''));
$('#about-copy-server').addEventListener('click', () => copyText($('#about-server').textContent || ''));
/* 关于 → 语言行：跳转到通用面板（与通用语言分段同一落点） */
{
  const gotoLang = $('#about-goto-lang');
  if (gotoLang) {
    gotoLang.addEventListener('click', () => activateSettingsPane('general'));
    gotoLang.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateSettingsPane('general'); }
    });
  }
}
/** 打开权限面板（composer 内联 pop） */
function openPermissionPop() {
  closeCmdPanel();
  renderPermissionPop();
  $('#permission-pop').classList.remove('hidden');
  $('#model-pop').classList.add('hidden');
}
/** 会话切换面板：带过滤预填（/session <关键词> 多命中/未命中时用） */
function openSessionSwitchWithFilter(q) {
  openSessionSwitch();
  const inp = $('#sw-search');
  if (inp) {
    inp.value = q || '';
    swFilter = q || '';
    swSelIdx = 0;
    renderSessionSwitch();
    inp.focus();
  }
}
/** 后端联动型命令：走 /api/command，但渲染为通知 + 状态刷新，不弹 cmd-panel。
 * 适用于 /plan /permission<档位> /model<名> /variants<级别> /clear ——执行结果直接落到 UI 控件上。 */
async function runBackendLinked(cmd) {
  try {
    const result = await api('/api/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: cmd, sessionId: state.session, background: true }),
    });
    closeCmdPanel();
    const lines = Array.isArray(result.lines) ? result.lines : [];
    if (lines.length) notify(lines.join('\n'), 'success');
    await refreshStatus().catch(() => {});
    // 弹层若开着即时重绘（模型/权限切换后面板内的选中态同步）
    try {
      if (!$('#model-pop').classList.contains('hidden')) renderModelPop(state.status || {});
      if (!$('#permission-pop').classList.contains('hidden')) renderPermissionPop();
    } catch { /* 渲染失败不阻塞 */ }
    // /clear 靠 clear 事件清消息流；这里补刷侧栏标题（标题可能已变）与状态条
    if (parseSlash(cmd).base === '/clear') refreshSessions().catch(() => {});
  } catch (e) {
    notify(t('cmd.failed', { msg: e.message }), 'error');
  }
}

async function runSlashCommand(cmd) {
  const { base, arg } = parseSlash(cmd);
  // —— 1. 纯前端 UI 命令（不经过后端） ——
  // /model、/variants 无参数 → 打开输入区的模型选择面板（模型下拉 + 思考级别滑条）
  if ((base === '/model' || base === '/variants') && !arg) {
    closeCmdPanel();
    openModelPop();
    return;
  }
  if (base === '/thinking') {
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
  // /permission 无参数 → 打开权限面板（composer 内联 pop，与胶囊按钮同款）
  if (base === '/permission' && !arg) {
    openPermissionPop();
    return;
  }
  // /plan → 直接切换计划开关（与 composer 计划 toggle 同链路，不弹面板）
  if (base === '/plan') {
    closeCmdPanel();
    try { togglePlanMode(); } catch { /* toggle 内部已处理 */ }
    notify(state.planMode ? '已进入计划模式（只读调研，不会修改文件；/plan 退出）。' : '已退出计划模式（可正常修改文件/执行命令）。', 'success');
    return;
  }
  // /settings → 打开设置面板（支持 /settings <面板名> 直达）
  if (base === '/settings') {
    closeCmdPanel();
    openSettingsPane(arg);
    return;
  }
  // /rewind 无参数 → 打开检查点面板；带参数 → 直接调 REST 回滚（与面板同接口）
  if (base === '/rewind') {
    if (!state.session) { notify(t('session.new'), 'info'); return; }
    if (!arg) { closeCmdPanel(); openRewindModal(state.session); return; }
    const n = Number(arg.split(/\s+/)[0]);
    if (!Number.isInteger(n)) { notify('用法：/rewind <序号>（无参数打开检查点面板）', 'error'); return; }
    try {
      const r = await api(`/api/sessions/${state.session}/rewind`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ index: n }),
      });
      const cnt = Array.isArray(r.results) ? r.results.length : '';
      notify(cnt === '' ? `已回滚到检查点 #${n}` : t('rewind.done', { index: n, n: cnt }), 'success');
    } catch (e) { notify(t('rewind.failed', { msg: e.message }), 'error'); }
    return;
  }
  // /fork 无参数 → 打开分叉对话框；带参数 → 直接调 REST 分叉（与对话框同接口）
  if (base === '/fork') {
    if (!state.session) { notify(t('session.new'), 'info'); return; }
    if (!arg) { closeCmdPanel(); openForkDialog({ id: state.session }); return; }
    const n = Number(arg.split(/\s+/)[0]);
    if (!Number.isInteger(n) || n < 1) { notify(t('fork.invalid', { max: '?' }), 'error'); return; }
    try {
      await api(`/api/sessions/${state.session}/fork`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ n }),
      });
      await refreshSessions().catch(() => {});
      notify('已分叉新会话（侧栏可见）', 'success');
    } catch (e) { notify(t('err.fork', { msg: e.message }), 'error'); }
    return;
  }
  // /export → 直接下载（与会话菜单“导出”同接口，不弹面板）
  if (base === '/export') {
    if (!state.session) { notify(t('session.new'), 'info'); return; }
    closeCmdPanel();
    window.open(`/api/sessions/${state.session}/export`, '_blank');
    return;
  }
  // /rename → 走 REST 重命名（广播 title 事件，侧栏/标题即时更新；无参数弹窗输入）
  if (base === '/rename') {
    if (!state.session) { notify(t('session.new'), 'info'); return; }
    let title = arg;
    if (!title) {
      const raw = prompt(t('session.titlePrompt'), $('#chat-title').textContent || '');
      if (raw === null) return;
      title = raw.trim();
      if (!title) return;
    }
    try {
      await api(`/api/sessions/${state.session}/rename`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      // SSE title 事件会更新标题；这里乐观更新避免等待往返
      $('#chat-title').textContent = title;
      const live = state.sessions.find((x) => x.id === state.session);
      if (live) live.title = title;
      renderSessionList();
      notify(t('notify.saved'), 'success');
    } catch (e) { notify(t('err.rename', { msg: e.message }), 'error'); }
    return;
  }
  // /session /resume → 会话切换面板（无参数/all 打开面板，有参数本地匹配直达）
  if (base === '/session' || base === '/resume') {
    if (!arg || arg === 'all' || arg === 'list') { closeCmdPanel(); openSessionSwitch(); return; }
    const key = arg.split(/\s+/)[0].toLowerCase();
    const matches = (state.sessions || []).filter((s) =>
      (s.id || '').toLowerCase().startsWith(key) ||
      (s.id || '').toLowerCase() === key ||
      (s.title || '').toLowerCase().includes(key)
    );
    closeCmdPanel();
    if (matches.length === 1) { pickSession(matches[0]); return; }
    if (matches.length > 1) { openSessionSwitchWithFilter(arg.split(/\s+/)[0]); notify(`找到 ${matches.length} 个匹配，已打开切换面板`, 'info'); return; }
    // 本地无命中：尝试按完整 id 直接加载（磁盘会话可能尚未进列表），失败则打开面板
    try { await selectSession(arg.split(/\s+/)[0]); }
    catch { openSessionSwitchWithFilter(arg.split(/\s+/)[0]); notify(`会话「${arg.split(/\s+/)[0]}」不存在，已打开切换面板`, 'error'); }
    return;
  }
  // —— 2. 后端联动型（走后端，但渲染为通知+UI 刷新，不弹面板） ——
  // /plan 已在上节直连 toggle；这里处理带参切换类与 /clear
  if (base === '/permission' && arg) { await runBackendLinked(cmd); return; }
  if (base === '/clear') { await runBackendLinked(cmd); return; }
  if (base === '/model' && arg) {
    const sub = arg.split(/\s+/)[0];
    // add/fetch 走后端复杂流程（拉取网关清单/持久化），保留面板展示
    if (sub !== 'add' && sub !== 'fetch') { await runBackendLinked(cmd); return; }
  }
  if (base === '/variants' && arg) { await runBackendLinked(cmd); return; }
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
    // 某些命令改变了状态/会话列表/当前消息，按类刷新界面（执行结果要"落到界面上"）
    const c = cmd.trim();
    // ① 改运行时状态（模型/权限/计划/思考级别/上下文统计等）→ 刷新状态条
    //    （/clear 靠 clear 事件清消息流，此处再刷状态条清底部 context/缓存统计）
    const statusCmds = ['/plan', '/permission', '/variants', '/model', '/models', '/thinking', '/preset', '/clear'];
    if (statusCmds.some((x) => c === x || c.startsWith(x + ' '))) {
      refreshStatus().catch(() => {});
    }
    // ② 改会话列表/侧栏（新建/删除/改名/分叉/记忆/跨会话消息落盘）→ 刷新侧栏
    const sessionCmds = ['/rename', '/session', '/resume', '/fork', '/init', '/skill add', '/memory-apply', '/send'];
    if (sessionCmds.some((x) => c === x || c.startsWith(x + ' '))) {
      refreshSessions().catch(() => {});
    }
    // ③ /compact 折叠了当前会话旧消息为摘要 → 空闲时整段重拉历史让结果落到消息流
    //    （运行中不重拉避免打断实时流；/undo /redo /rewind 只改工作区文件与 system 消息，
    //     system 不渲染故无需重拉；/clear 已有 clear 事件清空）
    if (c === '/compact' && state.session && !sessionRunning()) {
      renderSessionHistory(state.session).catch(() => {});
    }
    // ④ MCP 工具链变化 → 状态栏工具数刷新（status 里含 tools）
    const mcpCmds = ['/mcp add', '/mcp remove', '/mcp login', '/mcp reconnect', '/mcp install'];
    if (mcpCmds.some((x) => c.startsWith(x))) {
      refreshStatus().catch(() => {});
      refreshSessions().catch(() => {});
    }
    // /session <id> 或 /resume <id>：直接加载会话
    if (state.session && (c.startsWith('/session ') || c.startsWith('/resume ')) && !c.includes('all') && !c.includes('list')) {
      const arg = c.split(/\s+/)[1];
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
const PERM_ORDER = ['read', 'ask', 'safe', 'full'];

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
  applySettings({ permission: next }).catch((err) => notify(t('err.settings', { msg: err.message }), 'error')); // 静默切换（D12），失败才提示
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
  applySettings({ planMode: next }).catch((err) => notify(t('err.settings', { msg: err.message }), 'error'));
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
  // ① 同步 execCommand 路径（点击 handler 内有用户手势上下文，不依赖窗口焦点——
  //    writeText 在文档未聚焦时抛 NotAllowedError 且不可恢复，这里优先保证成功）
  const ta = el('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { /* ignore */ }
  ta.remove();
  if (ok) { notify(t('notify.copied'), 'success'); return; }
  // ② execCommand 不可用/失败 → 异步 Clipboard API（async 上下文已失手势，可能被拒）
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text)
      .then(() => notify(t('notify.copied'), 'success'))
      .catch(() => notify(t('notify.copyFailed'), 'error'));
    return;
  }
  // ③ 两条路都不通：至少给用户反馈
  notify(t('notify.copyFailed'), 'error');
}

/* 右上角通知（Alert notification）：所有瞬时提示统一入口。
 * type：info（默认）/ success（成功）/ error（错误）；自动消失（错误 4.5s，其余 2.6s），
 * 悬停暂停计时，可点击 ✕ 关闭；同屏最多叠 4 条，超过先移除最旧的。 */
function notify(msg, type = 'info') {
  if (!msg) return;
  let box = $('#notifications');
  if (!box) {
    box = el('div', 'notifications');
    box.id = 'notifications';
    document.body.appendChild(box);
  }
  while (box.children.length >= 4) box.removeChild(box.firstChild);
  const n = el('div', 'notify ' + type);
  const icon = el('span', 'notify-icon');
  icon.textContent = type === 'error' ? '✕' : type === 'success' ? '✓' : 'ℹ';
  const text = el('span', 'notify-text');
  text.textContent = msg;
  const close = el('button', 'notify-close', '✕');
  close.type = 'button';
  close.title = t('modal.close');
  close.addEventListener('click', () => dismiss(n));
  n.appendChild(icon); n.appendChild(text); n.appendChild(close);
  box.appendChild(n);
  // rAF + setTimeout 双保险：rAF 不触发（headless/后台标签页）时也能在下一帧加 show 类
  requestAnimationFrame(() => { setTimeout(() => n.classList.add('show'), 0); });
  let timer = setTimeout(() => dismiss(n), type === 'error' ? 4500 : 2600);
  // 悬停暂停自动消失
  n.addEventListener('mouseenter', () => clearTimeout(timer));
  n.addEventListener('mouseleave', () => { timer = setTimeout(() => dismiss(n), type === 'error' ? 4500 : 2600); });
}
function dismiss(n) {
  if (!n || n.dataset.gone) return;
  n.dataset.gone = '1';
  n.classList.remove('show');
  n.classList.add('hide');
  setTimeout(() => n.remove(), 200);
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
    row.appendChild(el('div', 'sw-meta', `${projectName(s.project || t('ws.unknown'))} · ${t('session.msgCount', { n: s.messages || 0 })}`));
    row.addEventListener('click', () => pickSession(s));
    list.appendChild(row);
  });
  // 上下键切换后选中项滚进可视区（会话多超出 sw-list 高度时保证当前项可见）
  const selRow = list.querySelector('.sw-item.selected');
  if (selRow) selRow.scrollIntoView({ block: 'nearest' });
}
function pickSession(s) {
  closeSessionSwitch();
  const target = s.project && s.project !== t('ws.unknown') ? s.project : null;
  const needSwitch = target && target !== (state.status?.cwd || '');
  const doSelect = () => selectSession(s.id).catch((e) => console.error(e));
  if (needSwitch) switchWorkspace(target).then(doSelect).catch((err) => notify(t('err.openSession', { msg: err.message }), 'error'));
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
    notify(t('shortcut.conflict', { combo: formatCombo(combo), label: featureLabel(clash) }), 'error');
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
      if (state.attachments.length) { notify(t('attach.running'), 'info'); return; } // 运行中不支持附件
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
    if (!$('#skill-create-modal').classList.contains('hidden')) { closeSkillCreate(); escConsumed = true; }
    else if (!$('#mc-model-edit').classList.contains('hidden')) { closeMcModelEdit(); escConsumed = true; }
    else if (!$('#session-switch-modal').classList.contains('hidden')) { closeSessionSwitch(); escConsumed = true; }
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
    // 新一轮开始：重置本轮累计（run.end 已重置，这里兜底——队列连发时保证本轮 footer 纯净）
    state.turnUsages = [];
    state.turnTokens = { prompt: 0, completion: 0, cached: 0 };
    state.turnLlmMs = 0;
    state.turnGenMs = 0;
    state.turnFirstTokenSum = 0;
    state.turnFirstTokenCount = 0;
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
    const badge = el('span', 'qi-badge ' + (item.steer ? 'steer' : 'queue'), item.steer ? '↑' : 'Q');
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
      // Q → ↑（转 steer）
      toggleBtn.title = t('queue.toSteer');
      toggleBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M13 2L4 14h7l-1 8 9-12h-7z" fill="currentColor" stroke="none"/></svg>';
      toggleBtn.addEventListener('click', (e) => { e.stopPropagation(); toSteer(i); });
    } else {
      // ↑ → Q（转 queue）
      toggleBtn.title = t('queue.toQueue');
      toggleBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 12h14M12 5v14" stroke-width="2"/></svg>';
      toggleBtn.addEventListener('click', (e) => { e.stopPropagation(); toQueue(i); });
    }
    actions.appendChild(toggleBtn);

    // 删除按钮
    const delBtn = el('button', 'qi-btn', '');
    delBtn.title = t('queue.remove');
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
    revealLastAnswer(); // 取消：残存回答也算终答，允许拷贝/重试
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
  closeMcModelEdit(); // 关闭可能打开的模型编辑弹窗
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
/* 思考强度配色：**不同档位不同颜色**——低档=品牌蓝（冷）→ 靛/紫 → 品红 → 最高档=橙（暖），
 * 轨道渐变按档位数在每个档位位置生成色标（i/(n-1)），任意档位数在色板上均匀插值取色。
 * thumb 光晕 / 激活刻度 / 当前值文字同步当前档位颜色（--slider-glow / --level-color）。 */
const LEVEL_COLORS = ['#4176e6', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899', '#f97316'];
function levelHexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
/** t∈[0,1] → 色板位置上的插值色（0=首色，1=末色） */
function lerpLevelColor(t) {
  const max = LEVEL_COLORS.length - 1;
  const pos = Math.min(max, Math.max(0, t * max));
  const i = Math.floor(pos);
  const f = pos - i;
  const a = levelHexToRgb(LEVEL_COLORS[i]);
  const b = levelHexToRgb(LEVEL_COLORS[Math.min(max, i + 1)]);
  return `rgb(${Math.round(a.r + (b.r - a.r) * f)}, ${Math.round(a.g + (b.g - a.g) * f)}, ${Math.round(a.b + (b.b - a.b) * f)})`;
}
/** 第 i 档（共 n 档）的档位色 */
const levelColor = (i, n) => lerpLevelColor(n <= 1 ? 0 : i / (n - 1));
/** 按当前 status 解析当前思考档位的档位色（与 popover 卡片一致的逻辑）；无思考级别/无选项时返回 null */
function currentLevelColor(st) {
  const efforts = Array.isArray(st && st.reasoningEffortOptions) ? st.reasoningEffortOptions.filter(Boolean) : [];
  if (!efforts.length) return null;
  const cur = (st && st.reasoningEffort) || efforts[0];
  return levelColor(Math.max(0, efforts.indexOf(cur)), efforts.length);
}
/** 整个轨道的渐变：每档一个色标（i/(n-1) 处取该档颜色） */
function levelGradient(n) {
  const stops = [];
  for (let i = 0; i < n; i++) {
    const t = n <= 1 ? 0 : i / (n - 1);
    stops.push(`${levelColor(i, n)} ${Math.round(t * 100)}%`);
  }
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

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
  pop.appendChild(el('div', 'pop-head', t('model.head')));
  if (!models.length) {
    pop.appendChild(el('div', 'pop-empty', t('model.none')));
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
      const picked = models.find((m) => m.name === v);
      // 不立即关闭：用户可能反复切换模型/思考级别；重渲染弹层以刷新新模型的思考级别选项
      applySettings({ model: v })
        .then(() => {
          renderModelPop(state.status || {});
          notify(t('notify.modelSwitched', { model: (picked ? modelLabel(picked) : v) }), 'success');
        })
        .catch((err) => notify(t('err.switchModel', { msg: err.message }), 'error'));
    });
    pop.appendChild(sel);
  }

  // 思考级别：modern slider with linear gradient（动画参考：Lottie「modern-slider-with-linear-gradient」）
  // —— 多段渐变填充轨道（indigo→violet→pink + 顶部光泽）+ 发光白 thumb（呼吸光晕）+ 档位刻度点
  //     + 底部标签。交互沿用无级滑条：拖动连续不跳格、填充/thumb 跟手预览最近档位，松手吸附并
  //    播放动效（thumb 涟漪 + 标签/刻度弹跳）；选择后**不自动关闭**（用户可能反复调整模型/
  //    思考级别），点击弹层外或 Esc 才关闭。原生 range 保留为透明交互层（拖拽 / 点击跳转 /
  //    键盘方向键 / aria）。
  pop.appendChild(el('div', 'pop-sep'));
  pop.appendChild(el('div', 'pop-head', t('model.effortHead')));
  if (!efforts.length) {
    pop.appendChild(el('div', 'pop-empty', t('model.noEffort')));
  } else {
    const curEff = s.reasoningEffort || efforts[0];
    // 不显示 slider 上方的当前档位文字（.pop-val）：底部标签高亮已足够；
    // 同时避免其 pop-val-snap 弹跳动画（scale + opacity 闪烁）在卡片顶部制造「整卡晃动」观感
    const idx = Math.max(0, efforts.indexOf(curEff));
    const steps = Math.max(1, efforts.length - 1);
    // 自定义渲染层：底轨 → 渐变填充 → 刻度点 → 发光 thumb；原生 range 盖在最上层作交互层
    // 档位配色：轨道渐变按档位生成色标，光晕/刻度/当前值用当前档位颜色
    const wrap = el('div', 'slider-wrap');
    wrap.style.setProperty('--slider-grad', levelGradient(efforts.length));
    wrap.style.setProperty('--slider-glow', levelColor(idx, efforts.length));
    pop.style.setProperty('--level-color', levelColor(idx, efforts.length));
    const inner = el('div', 'slider-inner');
    inner.appendChild(el('div', 'slider-track'));
    inner.appendChild(el('div', 'slider-fill'));
    const dots = el('div', 'slider-dots');
    inner.appendChild(dots);
    const thumb = el('div', 'slider-thumb');
    inner.appendChild(thumb);
    wrap.appendChild(inner);
    const range = document.createElement('input');
    range.type = 'range';
    range.className = 'slider-input';
    range.min = '0';
    range.max = String(efforts.length - 1);
    range.step = 'any'; // 无级拖拽：拖动过程不跳格
    range.value = String(idx);
    range.setAttribute('aria-label', t('model.effortHead'));
    wrap.appendChild(range);
    pop.appendChild(wrap);
    // 档位刻度点（视觉指示；点击直达走底部标签——交互层盖住轨道）
    efforts.forEach((_, i) => {
      const dot = el('span', 'slider-dot');
      dot.style.left = steps === 1 ? '50%' : `calc(var(--pad) + (100% - 2 * var(--pad)) * ${i} / ${steps})`;
      if (i === idx) dot.classList.add('active'); // 初始高亮当前档位
      dots.appendChild(dot);
    });
    const ticks = el('div', 'pop-ticks');
    efforts.forEach((t, i) => {
      const sp = el('span', null, t);
      if (i === idx) sp.classList.add('active'); // 初始高亮当前档位
      sp.style.left = steps === 1 ? '50%' : `calc(var(--pad) + (100% - 2 * var(--pad)) * ${i} / ${steps})`; // 与刻度点同 x：端点标签 none/max 对齐滑块两端
      sp.addEventListener('click', () => { // 点刻度直达该档
        range.value = String(i);
        range.dispatchEvent(new Event('change'));
      });
      ticks.appendChild(sp);
    });
    pop.appendChild(ticks);
    let applied = idx;
    const setFill = (pos) => wrap.style.setProperty('--fill', String((pos / steps) * 100));
    const nearestIdx = () => Math.min(efforts.length - 1, Math.max(0, Math.round(Number(range.value))));
    // 标签 + 刻度点高亮；animate=true 时给刚激活的标签/刻度点缩放弹跳（重触发 .pop 动画）
    const setTicks = (pos, animate) => {
      ticks.querySelectorAll('span').forEach((sp, i) => {
        const on = i === pos;
        sp.classList.toggle('active', on);
        if (on && animate) { sp.classList.remove('pop'); void sp.offsetWidth; sp.classList.add('pop'); }
      });
      dots.querySelectorAll('span').forEach((d, i) => {
        const on = i === pos;
        d.classList.toggle('active', on);
        if (on && animate) { d.classList.remove('pop'); void d.offsetWidth; d.classList.add('pop'); }
      });
      // 档位颜色同步：thumb 光晕 + 当前值/激活刻度文字颜色 = 当前档位色
      const c = levelColor(pos, efforts.length);
      wrap.style.setProperty('--slider-glow', c);
      pop.style.setProperty('--level-color', c);
    };
    // 重触发单次 CSS 动画（刻度/标签弹跳）
    setFill(idx);
    // 拖动中：填充/thumb 跟手（dragging 时 CSS 无过渡）+ 预览吸附档位标签 + 高亮（不弹跳）
    range.addEventListener('input', () => {
      wrap.classList.add('dragging');
      const pos = nearestIdx();
      setFill(pos);
      setTicks(pos, false);
    });
    // 松手：吸附最近档位并生效；播放动效（刻度/标签弹跳），弹层保持打开
    range.addEventListener('change', () => {
      const pos = nearestIdx();
      const v = efforts[pos];
      range.value = String(pos); // 吸附
      wrap.classList.remove('dragging');
      setFill(pos);
      setTicks(pos, true);
      if (!v) return;
      // 不再 replay(thumb, 'snap')：旧涟漪动画会在 max 时于 slider 右端闪出上下贯穿的光环（“切 max 整卡抖动”）
      if (pos === applied) return;
      applySettings({ reasoningEffort: v })
        .then(() => { applied = pos; }) // 不关闭：用户可能反复调整思考级别，点弹层外才关闭
        .catch((err) => { notify(t('err.settings', { msg: err.message }), 'error'); range.value = String(applied); });
    });
  }
}

/* 代码块拷贝按钮（markdown-renderer 输出 .md-code-copy，委托处理点击：复制代码正文） */
document.addEventListener('click', (e) => {
  const btn = e.target && e.target.closest ? e.target.closest('.md-code-copy') : null;
  if (!btn) return;
  const block = btn.closest('.md-code-block');
  const codeEl = block && block.querySelector('pre code');
  if (codeEl) copyText(codeEl.textContent);
});

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
    // MCP/技能页懒加载（打开即刷新，其它页不受影响）
    if (pane === 'mcp') loadMcpPane();
    else if (pane === 'skills') loadSkillPane();
  });
});

/* ---------------- 设置 · MCP/技能页（可视化管理：列表 + 增删 + 重连/登录 + 新建） ---------------- */
let mcpServers = []; // GET /api/mcp 缓存（含连接状态与工具/资源/提示词）
let mcpSel = null;   // 当前选中服务器名
let skillList = [];  // GET /api/skills 缓存

async function loadMcpPane() {
  const chips = $('#mcp-chips');
  if (!chips) return;
  try {
    const d = await api('/api/mcp');
    mcpServers = Array.isArray(d.servers) ? d.servers : [];
    if (!mcpServers.some((s) => s.name === mcpSel)) mcpSel = mcpServers.length ? mcpServers[0].name : null;
    renderMcpChips();
    renderMcpDetail();
    const c = $('#mcp-count');
    if (c) c.textContent = t('mcp.count', { n: mcpServers.length });
    const empty = $('#mcp-empty');
    if (empty) empty.classList.toggle('hidden', mcpServers.length > 0);
  } catch (e) { notify(e.message, 'error'); }
}

/** MCP 服务器 chips（模型配置 provider chips 同风格：名 + 工具数 + ✕ 删除） */
function renderMcpChips() {
  const box = $('#mcp-chips');
  if (!box) return;
  box.innerHTML = '';
  mcpServers.forEach((s) => {
    const b = el('button', 'mc-chip' + (mcpSel === s.name ? ' active' : ''));
    b.type = 'button';
    b.dataset.server = s.name;
    b.appendChild(el('span', 'mc-chip-name', s.name));
    b.appendChild(el('span', 'mc-chip-count', String((s.tools || []).length)));
    const del = el('span', 'mc-chip-del', '✕');
    del.dataset.del = s.name;
    del.title = t('mcp.confirmDelete', { name: s.name });
    b.appendChild(del);
    box.appendChild(b);
  });
}
$('#mcp-chips')?.addEventListener('click', (e) => {
  const target = e.target;
  const del = target.closest ? target.closest('.mc-chip-del') : null;
  if (del) {
    const name = del.dataset.del;
    if (!confirm(t('mcp.confirmDelete', { name }))) return;
    mcpAction('remove', { name });
    return;
  }
  const chip = target.closest ? target.closest('.mc-chip') : null;
  if (!chip) return;
  mcpSel = chip.dataset.server ?? '';
  renderMcpChips();
  renderMcpDetail();
});

/** 选中服务器详情（类型/端点 + 工具/资源/提示词 + 登录） */
function renderMcpDetail() {
  const box = $('#mcp-detail');
  if (!box) return;
  const s = mcpServers.find((x) => x.name === mcpSel) || null;
  if (!s) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  box.innerHTML = '';
  const group = el('div', 'settings-group');
  const addRow = (title, right) => {
    const r = el('div', 'setting-row');
    const info = el('div', 'setting-info');
    info.appendChild(el('h4', null, title));
    r.appendChild(info);
    if (right) r.appendChild(right);
    group.appendChild(r);
  };
  // 类型行：状态徽标 + 端点 + 登录（HTTP）
  const badge = el('span', 'mc-badge ' + (!s.connected ? 'off' : s.type === 'http' ? 'http' : 'std'),
    !s.connected ? t('mcp.unconnected') : t(s.type === 'http' ? 'mcp.http' : 'mcp.stdio'));
  const endWrap = el('div', 'about-value');
  endWrap.appendChild(badge);
  const endpoint = s.type === 'http' ? (s.url || '') : [s.command].concat(s.args || []).filter(Boolean).join(' ');
  if (endpoint) endWrap.appendChild(el('code', 'mono-value', endpoint));
  if (s.type === 'http') {
    const login = el('button', 'secondary-button', t('mcp.login'));
    login.type = 'button';
    login.addEventListener('click', () => mcpAction('login', { name: s.name }));
    endWrap.appendChild(login);
  }
  addRow(s.name + (s.hasInstructions ? ' · instructions ✓' : ''), endWrap);
  const tools = s.tools || [];
  if (tools.length) addRow(`${t('mcp.tools')} · ${tools.length}`, el('div', 'mcp-kv', tools.slice(0, 30).join(', ') + (tools.length > 30 ? ' …' : '')));
  const res = s.resources || [];
  if (res.length) addRow(`${t('mcp.resources')} · ${res.length}`, el('div', 'mcp-kv', res.slice(0, 10).map((r) => r.uri).join('\n')));
  const prompts = s.prompts || [];
  if (prompts.length) addRow(`${t('mcp.prompts')} · ${prompts.length}`, el('div', 'mcp-kv', prompts.map((x) => x.name).join(', ')));
  box.appendChild(group);
}

/** MCP 写操作（add/remove/login/install/reconnect）：落盘 + 重连 + 刷列表/状态 */
async function mcpAction(action, body) {
  try {
    const r = await api('/api/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, ...(body || {}) }),
    });
    if (action === 'reconnect') notify(t('mcp.reconnected', { n: r.tools ?? 0 }), 'success');
    else notify(r.message || r.persistMessage || t('notify.saved'), 'success');
    await loadMcpPane();
    await refreshStatus().catch(() => {});
  } catch (e) { notify(e.message, 'error'); }
}
$('#btn-mcp-reconnect').addEventListener('click', () => mcpAction('reconnect', {}));
$('#btn-mcp-add').addEventListener('click', async () => {
  const name = $('#mcp-name').value.trim();
  const text = $('#mcp-text').value.trim();
  if (!name || !text) { notify(t('mcp.addHint'), 'error'); return; }
  try {
    const r = await api('/api/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'add', name, text }),
    });
    notify(r.persistMessage || t('notify.saved'), 'success');
    $('#mcp-name').value = '';
    $('#mcp-text').value = '';
    mcpSel = name;
    await loadMcpPane();
    await refreshStatus().catch(() => {});
  } catch (e) { notify(e.message, 'error'); }
});
$('#btn-mcp-install').addEventListener('click', async () => {
  const id = $('#mcp-install-id').value.trim();
  if (!id) return;
  try {
    const r = await api('/api/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'install', id }),
    });
    notify(r.message || t('notify.saved'), 'success');
    $('#mcp-install-id').value = '';
    if (r.name) mcpSel = r.name;
    await loadMcpPane();
    await refreshStatus().catch(() => {});
  } catch (e) { notify(e.message, 'error'); }
});

/** 设置 · 技能列表（名 + 来源/行为徽标 + 描述，点击查看走 /skill show 面板） */
async function loadSkillPane() {
  const list = $('#skill-list');
  if (!list) return;
  try {
    const d = await api('/api/skills');
    skillList = Array.isArray(d.skills) ? d.skills : [];
    list.innerHTML = '';
    skillList.forEach((s) => {
      const r = el('div', 'setting-row');
      const info = el('div', 'setting-info');
      const h = el('h4', null, s.name);
      const badges = el('span', 'skill-badges');
      if (s.global) badges.appendChild(el('span', 'mc-badge std', t('skill.global')));
      if (s.manual) badges.appendChild(el('span', 'mc-badge off', t('skill.manual')));
      if (s.subagent) badges.appendChild(el('span', 'mc-badge http', t('skill.subagent')));
      h.appendChild(badges);
      info.appendChild(h);
      if (s.description) info.appendChild(el('p', null, s.description));
      r.appendChild(info);
      const view = el('button', 'secondary-button', t('skill.show'));
      view.type = 'button';
      view.addEventListener('click', () => runSlashCommand('/skill show ' + s.name));
      r.appendChild(view);
      list.appendChild(r);
    });
    const c = $('#skill-count');
    if (c) c.textContent = t('skill.count', { n: skillList.length });
    const empty = $('#skill-empty');
    if (empty) empty.classList.toggle('hidden', skillList.length > 0);
    list.classList.toggle('hidden', skillList.length === 0);
  } catch (e) { notify(e.message, 'error'); }
}
$('#btn-skill-refresh').addEventListener('click', () => loadSkillPane());
/* 新建技能弹窗（头部与刷新并排；回车确认，Esc/遮罩/取消关闭） */
function openSkillCreate() {
  const inp = $('#skill-name');
  if (inp) inp.value = '';
  const desc = $('#skill-desc');
  if (desc) desc.value = '';
  $('#skill-create-modal').classList.remove('hidden');
  if (inp) setTimeout(() => inp.focus(), 0);
}
function closeSkillCreate() { $('#skill-create-modal').classList.add('hidden'); }
$('#btn-skill-create').addEventListener('click', openSkillCreate);
$('#btn-close-skill-create').addEventListener('click', closeSkillCreate);
$('#btn-skill-cancel').addEventListener('click', closeSkillCreate);
$('#skill-create-modal').addEventListener('click', (e) => { if (e.target === $('#skill-create-modal')) closeSkillCreate(); });
[$('#skill-name'), $('#skill-desc')].forEach((n) => n && n.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('#btn-skill-create-confirm').click(); }
}));
$('#btn-skill-create-confirm').addEventListener('click', async () => {
  const name = $('#skill-name').value.trim();
  const description = $('#skill-desc').value.trim();
  if (!name) { notify(t('skill.namePh'), 'error'); return; }
  try {
    await api('/api/skills/create', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, description }),
    });
    notify(t('notify.saved'), 'success');
    closeSkillCreate();
    await loadSkillPane();
  } catch (e) { notify(e.message, 'error'); }
});
$('#set-plan').addEventListener('change', (e) => {
  applySettings({ planMode: e.target.checked }).catch((err) => notify(t('err.settings', { msg: err.message }), 'error'));
});

/* 设置 · 通用并发滑条（复用输入区 slider 结构：1..16 档，拖动跟手、松手吸附落盘） */
const CC_MIN = 1, CC_MAX = 16;
const ccFillOf = (v) => ((Math.max(CC_MIN, Math.min(CC_MAX, v)) - CC_MIN) / (CC_MAX - CC_MIN)) * 100;
/** 并发滑条全量同步（填充/thumb/刻度/读数；range 值幂等回写，拖动中调用无跳变） */
function updateConcurrencySlider(v) {
  const n = Math.max(CC_MIN, Math.min(CC_MAX, parseInt(v) || 3));
  const wrap = $('#cc-slider');
  if (wrap) wrap.style.setProperty('--fill', String(ccFillOf(n)));
  const range = $('#set-concurrency');
  if (range) range.value = String(n);
  const dots = $('#cc-dots');
  if (dots) dots.querySelectorAll('.slider-dot').forEach((d, i) => d.classList.toggle('active', i === n - CC_MIN));
  const ticks = $('#cc-ticks');
  if (ticks) ticks.querySelectorAll('span').forEach((sp) => sp.classList.toggle('active', sp.dataset.v === String(n)));
  const val = $('#cc-val');
  if (val) val.textContent = String(n);
}
function initConcurrencySlider() {
  const range = $('#set-concurrency');
  if (!range || range.dataset.init) return;
  range.dataset.init = '1';
  const steps = CC_MAX - CC_MIN;
  const dots = $('#cc-dots');
  if (dots) {
    for (let i = 0; i <= steps; i++) {
      const d = el('span', 'slider-dot');
      d.style.left = `calc(var(--pad) + (100% - 2 * var(--pad)) * ${i} / ${steps})`;
      dots.appendChild(d);
    }
  }
  const ticks = $('#cc-ticks');
  if (ticks) {
    [CC_MIN, CC_MAX].forEach((v) => {
      const i = v - CC_MIN;
      const sp = el('span', null, String(v));
      sp.style.left = `calc(var(--pad) + (100% - 2 * var(--pad)) * ${i} / ${steps})`;
      sp.dataset.v = String(v);
      sp.addEventListener('click', () => {
        range.value = String(v);
        range.dispatchEvent(new Event('change'));
      });
      ticks.appendChild(sp);
    });
  }
  range.addEventListener('input', () => {
    const wrap = $('#cc-slider');
    if (wrap) wrap.classList.add('dragging');
    updateConcurrencySlider(Number(range.value));
  });
  range.addEventListener('change', () => {
    const wrap = $('#cc-slider');
    if (wrap) wrap.classList.remove('dragging');
  });
  updateConcurrencySlider(Number(range.value) || 3);
}
initConcurrencySlider();

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

$('#set-concurrency').addEventListener('change', (e) => {
  const val = Math.max(CC_MIN, Math.min(CC_MAX, parseInt(e.target.value) || 3));
  e.target.value = String(val);
  updateConcurrencySlider(val);
  applySettings({ webConcurrency: val }).catch((err) => notify(t('err.settings', { msg: err.message }), 'error'));
});
/* ---------------- 模型配置（providers 分组：一个端点配置多个模型，设置面板「模型配置」tab） ---------------- */
let cfgProviderSel = null;   // 当前选中分组：null=未选、'name'=provider、'__new__'=新建
let cfgProviderNewName = '';
let cfgProviderApiKey = '';  // 当前编辑 provider 的已保存 apiKey（眼睛按钮 reveal 用）
let mcNewCatalog = null;     // 新建 provider 模式下「获取模型列表」的临时目录（建组前缓存，勾选即建组）
let mcFetching = null;       // 正在获取模型列表的 provider 名（列表内 loading 态）
const mcAutoFetched = new Set(); // 本会话已自动获取过目录的 provider 名（避免每次刷新都重拉）
// 持久化「本会话已自动获取过」标记（localStorage 按 key 存，刷新页面/重开设置不再自动拉）——
// 模型列表自动获取只发生在该 provider 目录从未加载过且本机从未自动拉过；之后需手动点「获取/刷新模型列表」。
const mcAutoFetchedKey = (name) => 'omni.mcAutoFetched_' + name;
const mcAutoTried = (name) => mcAutoFetched.has(name) || (typeof localStorage !== 'undefined' && !!localStorage.getItem(mcAutoFetchedKey(name)));
const mcMarkAutoTried = (name) => { mcAutoFetched.add(name); try { localStorage.setItem(mcAutoFetchedKey(name), '1'); } catch { /* 隐私/无存储环境忽略 */ } };
let mcEditModel = null;      // 模型编辑弹窗当前目标 { provider, model }

// 模型能力表缓存（models.dev 快照 → /api/settings/model-capabilities；name → {found, context, effortOptions}）
const mcCaps = new Map();
let mcRenderSeq = 0;         // 能力表异步补缺的渲染序号守卫（防并发重排交错）

function providerModelsOf(g) { return Array.isArray(g && g.models) ? g.models : []; }

function formatCtx(n) {
  if (!n) return '';
  if (n >= 1000000) return `${n % 1000000 === 0 ? n / 1000000 : (n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** 批量查能力表（去重 + 缓存；失败静默缓存负结果，不阻塞渲染） */
async function fillModelCapabilities(names) {
  const missing = [...new Set(names.filter(Boolean))].filter((n) => !mcCaps.has(n));
  await Promise.all(missing.map(async (n) => {
    try {
      const d = await api('/api/settings/model-capabilities?name=' + encodeURIComponent(n));
      mcCaps.set(n, { found: !!d.found, context: d.context || null, effortOptions: Array.isArray(d.effortOptions) ? d.effortOptions : null });
    } catch {
      mcCaps.set(n, { found: false, context: null, effortOptions: null });
    }
  }));
}

/** 思考级别选项解析：模型自定义 → 全局 → 能力表 → 目录缓存提示 → 默认五档（保证下拉永不空白） */
function effortOptionsOf(s, group, m, catHint) {
  if (m && Array.isArray(m.reasoningEffortOptions) && m.reasoningEffortOptions.length) return m.reasoningEffortOptions;
  if (Array.isArray(s.reasoningEffortOptions) && s.reasoningEffortOptions.length) return s.reasoningEffortOptions;
  const cap = m ? mcCaps.get(m.name) : null;
  if (cap && Array.isArray(cap.effortOptions) && cap.effortOptions.length) return cap.effortOptions;
  if (Array.isArray(catHint) && catHint.length) return catHint;
  return ['low', 'medium', 'high', 'xhigh', 'max'];
}

/** 当前生效思考级别：模型级 → 全局 → 选项第一档（保证下拉有值回显） */
function currentEffortOf(s, m, opts) {
  if (m && m.reasoningEffort) return m.reasoningEffort;
  if (s.reasoningEffort) return s.reasoningEffort;
  return opts[0] || '';
}

/**
 * 添加模型前解析目标 provider 名（手动添加与「获取模型列表」勾选两种方式共用）。
 * - 新建模式（__new__）：先落盘 provider 配置（baseURL/apiKey/userAgent），返回新分组名；
 * - 已选分组：直接返回分组名；未选（null）返回 null（不可添加）。
 */
async function ensureProviderName() {
  if (cfgProviderSel === '__new__' || cfgProviderNewName) {
    const name = $('#p-name').value.trim();
    if (!name) { notify(t('provider.newName'), 'info'); return null; }
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
      notify(t('provider.errSave', { msg: err.message }), 'error');
      return null;
    }
    cfgProviderSel = name;
    cfgProviderNewName = '';
    $('#p-apikey').value = '';
    return name;
  }
  return cfgProviderSel || null;
}

/** 渲染顶部 Provider 选择条（搜索过滤后的 chips + 新建按钮）；点击走 #mc-provider-chips 委托 */
function renderProviderBar(s) {
  const chipsBox = $('#mc-provider-chips');
  if (!chipsBox) return;
  const groups = Array.isArray(s.providers) ? s.providers : [];
  const q = ($('#mc-provider-search').value || '').trim().toLowerCase();
  const filtered = groups.filter((g) => !q || (g.name || '').toLowerCase().includes(q));
  const isNew = cfgProviderSel === '__new__' || cfgProviderNewName;
  chipsBox.innerHTML = filtered.map((g) => {
    const active = cfgProviderSel === g.name && !isNew;
    return `<button class="mc-chip${active ? ' active' : ''}" type="button" data-provider="${esc(g.name)}">
      <span class="mc-chip-name">${esc(g.name)}</span>
      <span class="mc-chip-count">${providerModelsOf(g).length}</span>
      <span class="mc-chip-del" data-del="${esc(g.name)}" title="${esc(t('provider.removeProviderConfirm', { name: g.name }))}">✕</span>
    </button>`;
  }).join('') + (filtered.length === 0 && groups.length > 0 ? `<span class="mc-chip-none">${esc(t('provider.noMatch'))}</span>` : '');
}
// 委托监听：chip 点击切换分组 / ✕ 删除 provider（不用 per-item 闭包——每次重建 DOM，
// 闭包捕获的旧 s 可能过期；委托读 state.status 恒为最新）
$('#mc-provider-chips')?.addEventListener('click', (e) => {
  const del = e.target.closest('.mc-chip-del');
  if (del) {
    const name = del.dataset.del;
    if (!confirm(t('provider.removeProviderConfirm', { name }))) return;
    api('/api/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerRemove: { provider: name } }),
    }).then(() => {
      if (cfgProviderSel === name) cfgProviderSel = null;
      refreshStatus().catch(() => {});
    }).catch((err) => notify(t('provider.errDelete', { msg: err.message }), 'error'));
    return;
  }
  const chip = e.target.closest('.mc-chip');
  if (!chip) return;
  cfgProviderSel = chip.dataset.provider ?? '';
  cfgProviderNewName = '';
  closeMcModelEdit(); // 切换分组：关闭可能打开的编辑弹窗
  const s = state.status || {};
  renderProviderBar(s);
  renderProviderPanel(s);
});

/** 渲染 Provider 配置面板（provider 级字段 + 组内模型表格） */
function renderProviderPanel(s) {
  const groups = Array.isArray(s.providers) ? s.providers : [];
  const empty = $('#mc-empty');
  const panel = $('#mc-provider-panel');
  const isNew = cfgProviderSel === '__new__' || cfgProviderNewName;
  const group = !isNew ? groups.find((g) => g.name === cfgProviderSel) || null : null;
  if (!group && !isNew) {
    if (empty) empty.classList.remove('hidden');
    if (panel) panel.classList.add('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');
  if (panel) panel.classList.remove('hidden');

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
  // provider 头徽标（默认模型 / 有覆盖模型）
  const badges = $('#mc-provider-badges');
  if (badges) {
    badges.innerHTML = '';
    if (group) {
      const models = providerModelsOf(group);
      const mk = (cls, txt) => { const b = el('span', 'mc-badge ' + cls, txt); badges.appendChild(b); };
      if (models.some((m) => m.name === s.model || `${group.name}/${m.name}` === s.model)) mk('def', t('provider.defaultBadge'));
      if (models.some((m) => m.overrideBaseURL || m.overrideApiKey)) mk('ovr', t('provider.override'));
    }
  }

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
  const fetchResult = $('#p-fetch-result');
  if (fetchResult) fetchResult.classList.add('hidden');
  const saveNote = $('#mc-save-note');
  if (saveNote) saveNote.textContent = '';

  // 删除 provider（新建模式无删除）
  const delBtn = $('#btn-del-provider');
  if (delBtn) {
    delBtn.onclick = () => {
      if (!group || !confirm(t('provider.removeProviderConfirm', { name: group.name }))) return;
      api('/api/settings', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerRemove: { provider: group.name } }),
      }).then(() => { cfgProviderSel = null; refreshStatus().catch(() => {}); })
        .catch((err) => notify(t('provider.errDelete', { msg: err.message }), 'error'));
    };
  }
  // 保存 provider（新建 = 创建 + 切到新分组；已有 = 更新）——成功内联提示
  const saveBtn = $('#btn-save-provider');
  if (saveBtn) {
    saveBtn.onclick = () => {
      const name = isNew ? (pnameInput.value.trim() || '') : group.name;
      if (isNew && !name) { notify(t('provider.newName'), 'info'); return; }
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
        if (saveNote) {
          saveNote.textContent = t('provider.saved');
          setTimeout(() => { if (saveNote.textContent === t('provider.saved')) saveNote.textContent = ''; }, 2200);
        }
        notify(t('notify.saved'), 'success');
        refreshStatus().catch(() => {});
      }).catch((err) => notify(t('provider.errSave', { msg: err.message }), 'error'));
    };
  }
  // 获取模型列表 / 刷新缓存（GET {baseURL}/models）：
  //  · provider 已保存 → 目录落盘缓存（providers.<name>.modelCatalog），刷新模型列表合并展示
  //  · provider 未保存（新建流程）→ 临时目录 mcNewCatalog，勾选行时先建 provider 再添加
  const fetchBtn = $('#btn-p-fetch');
  if (fetchBtn) {
    const hasCatalog = Array.isArray(group?.modelCatalog) && group.modelCatalog.length > 0;
    fetchBtn.textContent = hasCatalog ? t('provider.refresh') : t('provider.fetch');
    fetchBtn.onclick = () => {
      const b = $('#p-baseurl').value.trim() || (group ? group.baseURL : '');
      if (!b) { notify(t('provider.noBaseURL'), 'error'); return; }
      if (isNew) {
        doFetchNewCatalog();
      } else {
        mcMarkAutoTried(group.name); // 手动刷新后不再自动拉取
        doFetchModels(group);
      }
    };
  }
  // 组内模型区（预览列表）：目录 + 已配置合并，勾选即启用、行点击弹窗编辑
  const models = group ? providerModelsOf(group) : [];
  // 先立即同步渲染列表，保证目录与已配置模型立即可见
  renderModelList(s, group, isNew);
  // 能力表补缺后异步刷新列表（补充 context / 思考级别档位提示）
  const seq = ++mcRenderSeq;
  const modelNames = isNew ? [] : models.map((m) => m.name);
  fillModelCapabilities(modelNames).then(() => {
    if (seq !== mcRenderSeq) return;
    const groups2 = Array.isArray(s.providers) ? s.providers : [];
    const live2 = !group ? null : (groups2.find((g) => g.name === group.name) || group);
    renderModelList(s, live2, isNew);
  }).catch(() => {});
  // 模型列表默认获取：已保存 provider 且从未拉取过目录 → 自动拉取（loading 态在列表内展示）
  if (group && !isNew && !Array.isArray(group.modelCatalog) && !mcAutoTried(group.name)) {
    mcMarkAutoTried(group.name);
    doFetchModels(group);
  }
}

/** 拉取已保存 provider 的模型目录（providerDiscover → 服务端落盘缓存），完成后刷新列表 */
async function doFetchModels(group) {
  mcFetching = group.name;
  ++mcRenderSeq; // 使挂起的能力表渲染失效（避免旧 group 引用覆盖新目录）
  const s0 = state.status || {};
  renderModelList(s0, group, false); // 立即显示 loading 行
  const items = await fetchProviderModels(group, true);
  mcFetching = null;
  const s = state.status || {};
  const groups = Array.isArray(s.providers) ? s.providers : [];
  const live = groups.find((g) => g.name === group.name) || group;
  if (items === null) {
    // 失败：列表内联提示（不阻塞已配置模型展示），可点「刷新」重试
    const note = $('#mc-fetch-note');
    if (note) { note.textContent = t('provider.autoFetchFail'); note.classList.remove('hidden'); }
    renderModelList(s, live, false);
    return;
  }
  if (live) live.modelCatalog = items; // 内存即时更新（服务端已落盘，refreshStatus 后同样生效）
  const note = $('#mc-fetch-note');
  if (note) note.classList.add('hidden');
  renderModelList(s, live, false);
}

/** 新建 provider 模式：拉取临时目录（mcNewCatalog），勾选行时先建 provider 再添加 */
async function doFetchNewCatalog() {
  mcFetching = '__new__';
  const s = state.status || {};
  renderModelList(s, null, true);
  const items = await fetchProviderModels(null, false);
  mcFetching = null;
  if (items !== null) mcNewCatalog = items;
  renderModelList(state.status || {}, null, true);
}

/** 调用 providerDiscover（共用获取逻辑）；返回模型条目数组，失败返回 null（错误已内联展示） */
async function fetchProviderModels(group, silent) {
  const b = $('#p-baseurl').value.trim() || (group ? group.baseURL : '');
  if (!b) { if (!silent) notify(t('provider.noBaseURL'), 'error'); return null; }
  const fetchResult = $('#p-fetch-result');
  if (fetchResult) {
    fetchResult.classList.remove('hidden');
    fetchResult.innerHTML = `<div class="spin">${t('provider.fetching')}</div>`;
  }
  try {
    const data = await api('/api/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providerDiscover: {
          baseURL: b,
          apiKey: $('#p-apikey').value.trim() || (group ? group.apiKey : undefined) || undefined,
          provider: group ? group.name : undefined, // 已保存 provider → 目录落盘缓存
        },
      }),
    });
    const items = Array.isArray(data.models) ? data.models : [];
    if (fetchResult) fetchResult.classList.add('hidden');
    if (items.length === 0 && !silent) {
      if (fetchResult) { fetchResult.classList.remove('hidden'); fetchResult.innerHTML = `<div>${t('provider.fetchEmpty')}</div>`; }
    }
    return items;
  } catch (err) {
    if (fetchResult) fetchResult.innerHTML = `<div>${t('provider.errFetch', { msg: esc(err.message) })}</div>`;
    return null;
  }
}

/**
 * 渲染组内模型预览列表（勾选启用 + 点击行弹窗编辑）。
 * **统一模型列表** = 缓存目录（modelCatalog）+ 已配置模型（models）+ 当前选中模型 + 自定义模型。
 * 勾选 = 启用/停用（勾选态始终反映已配置模型，refreshStatus 后保持）；行点击打开编辑弹窗。
 * group 参数只用于定位（内部按 name 从 s.providers 重新读取，避免调用方传入旧引用）。
 */
function renderModelList(s, group, isNew) {
  const box = $('#provider-models');
  if (!box) return;
  const groups = Array.isArray(s.providers) ? s.providers : [];
  const liveGroup = !group ? null : (groups.find((g) => g.name === group.name) || group);
  const models = isNew || !liveGroup ? [] : providerModelsOf(liveGroup);
  const catalog = isNew ? (mcNewCatalog || []) : (liveGroup && Array.isArray(liveGroup.modelCatalog) ? liveGroup.modelCatalog : []);
  // 计数 = 已配置 + 目录未启用（随列表渲染同步，自动获取后即时更新）
  const countEl = $('#p-models-count');
  if (countEl) {
    const configured = models.length;
    const pending = catalog.filter((c) => c && c.id && !models.some((m) => m.name === c.id)).length;
    countEl.textContent = pending > 0 ? `${t('provider.modelsCount', { n: configured })} · ${t('provider.catalogCount', { n: pending })}` : t('provider.modelsCount', { n: configured });
  }
  // 合并：catalog 条目 → 目录态（未勾选）；models 条目 → 已配置态（勾选，catalog 命中补充能力元数据）
  const merged = [];
  const seen = new Set();
  for (const m of models) {
    const cat = catalog.find((c) => c && c.id === m.name);
    merged.push({ ...m, name: m.name, _fromCatalog: false, _ctxHint: cat && cat.context ? cat.context : null });
    seen.add(m.name);
  }
  for (const c of catalog) {
    if (!c || !c.id || seen.has(c.id)) continue;
    merged.push({ name: c.id, _fromCatalog: true, _ctxHint: c.context || null, _effortHint: Array.isArray(c.effortOptions) ? c.effortOptions : null });
  }
  // 当前选中（默认）模型归属本组但不在列表 → 附加（已配置态）
  const cur = s.model || '';
  if (liveGroup && cur && (cur === liveGroup.name || `${liveGroup.name}/${cur}`.includes('/'))) {
    const curName = cur.startsWith(`${liveGroup.name}/`) ? cur.slice(liveGroup.name.length + 1) : cur;
    if (curName && !seen.has(curName) && !isNew) {
      merged.push({ name: curName, _fromCatalog: false, _selected: true, _ctxHint: null });
      seen.add(curName);
    }
  }
  const q = ($('#mc-model-search').value || '').trim().toLowerCase();
  const filtered = merged.filter((m) => !q || m.name.toLowerCase().includes(q) || (m.apiModel || '').toLowerCase().includes(q));
  box.innerHTML = '';
  const fetching = mcFetching === (liveGroup ? liveGroup.name : '__new__');
  // 加载中且列表完全为空：bare 模式（去掉灰底/表头/「空」提示），只显示简洁 loading 行
  if (fetching && merged.length === 0) {
    box.classList.add('bare');
    const load = el('div', 'mc-loading');
    load.appendChild(el('span', 'spin'));
    load.appendChild(el('span', null, t('provider.fetching')));
    box.appendChild(load);
    return;
  }
  box.classList.remove('bare');
  // 表头（吸顶）：勾选 | 模型名 | apiModel | 思考级别 | context | 默认
  const thead = el('div', 'mc-thead');
  const th = (txt, cls) => { const c = el('span', 'mc-th' + (cls ? ' ' + cls : ''), txt); thead.appendChild(c); };
  thead.appendChild(el('span', 'mc-th'));
  th(t('provider.colName'));
  th(t('provider.colApiModel'));
  th(t('provider.colEffort'));
  th(t('provider.colContext'));
  th(t('provider.colDefault'));
  box.appendChild(thead);
  if (filtered.length === 0) {
    box.appendChild(el('div', 'mc-empty-models', merged.length === 0 ? t('provider.emptyModels') : t('provider.noMatch')));
  } else {
    filtered.forEach((m) => box.appendChild(modelListRow(s, liveGroup, m, isNew)));
  }
  if (fetching) {
    const load = el('div', 'mc-loading');
    load.appendChild(el('span', 'spin'));
    load.appendChild(el('span', null, t('provider.fetching')));
    box.appendChild(load);
  }
}

/** 列表行：勾选 = 启用/停用；行点击 = 弹窗编辑（列表仅预览，无行内编辑） */
function modelListRow(s, group, m, isNew) {
  const configured = !m._fromCatalog;
  const isDefault = m.name === s.model || (group && `${group.name}/${m.name}` === s.model) || !!m._selected;
  const cap = mcCaps.get(m.name) || null;
  const effHint = m._effortHint || (cap && Array.isArray(cap.effortOptions) ? cap.effortOptions : null);
  const ctxHint = m._ctxHint || (cap && cap.context ? cap.context : null);
  const row = el('div', 'mc-tr mc-list-tr' + (configured ? '' : ' cat'));
  row.dataset.model = m.name;
  row.title = t('provider.editHint');
  // 勾选列：已配置始终勾选（refreshStatus 后回显真实状态）
  const chkCell = el('div', 'mc-cell mc-cell-chk');
  const chk = el('input', 'mc-check');
  chk.type = 'checkbox';
  chk.checked = configured;
  chk.title = configured ? t('provider.disableHint') : t('provider.enableHint');
  chk.addEventListener('change', () => toggleModelEnable(s, group, m, chk.checked, isNew));
  chkCell.appendChild(chk);
  row.appendChild(chkCell);
  // 模型名 + 状态徽标（默认 / 目录）
  const nameCell = el('div', 'mc-cell mc-model-name');
  nameCell.appendChild(el('span', 'mc-name', m.name));
  if (isDefault) nameCell.appendChild(el('span', 'mc-badge def', t('provider.defaultBadge')));
  if (m._fromCatalog) nameCell.appendChild(el('span', 'mc-badge cat', t('provider.catalogBadge')));
  row.appendChild(nameCell);
  // apiModel 预览
  const apiCell = el('div', 'mc-cell mc-prev');
  apiCell.appendChild(el('span', 'mc-prev-text', m.apiModel || m.name));
  row.appendChild(apiCell);
  // 思考级别预览（目录/能力表档位提示）
  const effCell = el('div', 'mc-cell mc-prev');
  effCell.appendChild(el('span', 'mc-prev-text', effHint && effHint.length ? effHint.join('/') : '—'));
  row.appendChild(effCell);
  // context 预览（目录/能力表提示）
  const ctxCell = el('div', 'mc-cell mc-prev');
  const ctxVal = (m.limit && m.limit.context) || ctxHint || '';
  ctxCell.appendChild(el('span', 'mc-prev-text' + (ctxVal ? '' : ' muted'), ctxVal ? formatCtx(ctxVal) : '—'));
  row.appendChild(ctxCell);
  // 默认（★）快捷动作
  const defCell = el('div', 'mc-cell mc-cell-center');
  if (configured) {
    const defBtn = el('button', 'mc-def-btn' + (isDefault ? ' on' : ''), isDefault ? '★' : '☆');
    defBtn.type = 'button';
    defBtn.title = isDefault ? t('provider.defaultSet') : t('provider.setDefault');
    if (!isDefault) {
      defBtn.addEventListener('click', () => {
        api('/api/settings', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ setDefaultModel: { model: `${group.name}/${m.name}` } }),
        }).then(() => refreshStatus().catch(() => {}))
          .catch((err) => notify(t('provider.errSetDefault', { msg: err.message }), 'error'));
      });
    }
    defCell.appendChild(defBtn);
  } else {
    defCell.appendChild(el('span', 'mc-cat-dash', '—'));
  }
  row.appendChild(defCell);
  // 点击行（非勾选/按钮区域）→ 打开编辑弹窗
  row.addEventListener('click', (e) => {
    if (e.target.closest('input, button')) return;
    openMcModelEdit(s, group, m, isNew);
  });
  return row;
}

/** 勾选切换：启用 = 添加（能力表/目录自动预填默认值）；停用 = 移除模型 */
async function toggleModelEnable(s, group, m, on, isNew) {
  let provider = group ? group.name : null;
  if (!provider) {
    provider = await ensureProviderName(); // 新建模式：先落盘 provider 再添加
    if (!provider) return;
  }
  if (on) {
    await fillModelCapabilities([m.name]);
    const cap = mcCaps.get(m.name) || null;
    try {
      await api('/api/settings', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          providerModel: {
            provider,
            modelName: m.name,
            contextLimit: m._ctxHint || (cap && cap.context ? cap.context : undefined),
            reasoningEffortOptions: m._effortHint && m._effortHint.length > 1 ? m._effortHint : (cap && Array.isArray(cap.effortOptions) && cap.effortOptions.length > 1 ? cap.effortOptions : undefined),
          },
        }),
      });
    } catch (err) {
      notify(t('provider.errAdd', { msg: err.message }), 'error');
    }
  } else {
    if (!confirm(t('provider.removeConfirm', { name: m.name }))) return;
    try {
      await api('/api/settings', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerRemove: { provider, modelName: m.name } }),
      });
      if (mcEditModel && mcEditModel.provider === provider && mcEditModel.model.name === m.name) closeMcModelEdit();
    } catch (err) {
      notify(t('provider.errDelete', { msg: err.message }), 'error');
    }
  }
  refreshStatus().catch(() => {}); // 勾选态始终回显真实状态
}

/** 打开模型编辑弹窗（列表行点击；新建模式下先落盘 provider 再打开） */
function openMcModelEdit(s, group, m, isNew) {
  const doOpen = (provider, g) => {
    mcEditModel = { provider, model: m };
    renderMcModelEdit(state.status || {}, g, m);
    $('#mc-model-edit').classList.remove('hidden');
    const first = $('#mc-edit-body input, #mc-edit-body select');
    if (first) first.focus();
  };
  if (isNew || !group) {
    ensureProviderName().then((provider) => {
      if (!provider) return;
      const s2 = state.status || {};
      const groups = Array.isArray(s2.providers) ? s2.providers : [];
      const g = groups.find((x) => x.name === provider) || null;
      doOpen(provider, g);
    });
    return;
  }
  doOpen(group.name, group);
}

/** 渲染编辑弹窗表单：上下文/思考级别等默认值取自目录/能力表（models.dev），列表仅预览 */
function renderMcModelEdit(s, group, m) {
  const body = $('#mc-edit-body');
  if (!body) return;
  body.innerHTML = '';
  const cap = mcCaps.get(m.name) || null;
  const opts = effortOptionsOf(s, group, m, m._effortHint);
  const curEff = currentEffortOf(s, m, opts);
  const ctxHint = m._ctxHint || (cap && cap.context ? cap.context : null);
  const hasOverride = !!(m.overrideBaseURL || m.overrideApiKey);
  // 模型名（静态）
  const nameRow = el('div', 'pm-row mc-edit-row');
  nameRow.appendChild(el('label', null, t('provider.colName')));
  nameRow.appendChild(el('span', 'mc-edit-name', m.name));
  body.appendChild(nameRow);
  // apiModel（API 名）
  const apiIn = el('input', 'cfg-text mc-e-api');
  apiIn.value = m.apiModel || '';
  apiIn.placeholder = m.name;
  const apiRow = el('div', 'pm-row mc-edit-row');
  apiRow.appendChild(el('label', null, t('provider.fldApiModel')));
  apiRow.appendChild(apiIn);
  body.appendChild(apiRow);
  // 显示名
  const dispIn = el('input', 'cfg-text mc-e-display');
  dispIn.value = m.displayName || '';
  dispIn.placeholder = m.name;
  const dispRow = el('div', 'pm-row mc-edit-row');
  dispRow.appendChild(el('label', null, t('provider.fldDisplay')));
  dispRow.appendChild(dispIn);
  body.appendChild(dispRow);
  // 上下文长度（默认取目录/能力表）
  const ctxIn = el('input', 'cfg-text mc-e-ctx');
  ctxIn.type = 'number'; ctxIn.min = '0'; ctxIn.step = '1000';
  ctxIn.value = (m.limit && m.limit.context) || '';
  ctxIn.placeholder = ctxHint ? formatCtx(ctxHint) : '128000';
  const ctxBox = el('div', 'pm-ctx-input');
  ctxBox.appendChild(ctxIn);
  const ctxPresets = el('div', 'pm-ctx-presets');
  [['128K', 128000], ['200K', 200000], ['1M', 1000000], ['2M', 2000000]].forEach(([lbl, val]) => {
    const btn = el('button', 'ctx-preset-btn', lbl);
    btn.type = 'button';
    btn.onclick = () => { ctxIn.value = val; };
    ctxPresets.appendChild(btn);
  });
  ctxBox.appendChild(ctxPresets);
  const ctxRow = el('div', 'pm-row mc-edit-row');
  ctxRow.appendChild(el('label', null, t('provider.fldContext')));
  ctxRow.appendChild(ctxBox);
  body.appendChild(ctxRow);
  // 思考级别选项（默认取目录/能力表）
  const effIn = el('input', 'cfg-text mc-e-efforts');
  effIn.value = (m.reasoningEffortOptions || []).join(', ');
  effIn.placeholder = (cap && cap.effortOptions) ? cap.effortOptions.join(', ') : 'low, medium, high, xhigh, max';
  const effBox = el('div', 'pm-eff-input');
  effBox.appendChild(effIn);
  if (cap && cap.found) effBox.appendChild(el('p', 'pm-hint mc-caps-src', `· ${t('provider.fromModelsDev')}`));
  else effBox.appendChild(el('p', 'pm-hint', t('settings.variantsDesc')));
  const effRow = el('div', 'pm-row mc-edit-row');
  effRow.appendChild(el('label', null, t('provider.fldEfforts')));
  effRow.appendChild(effBox);
  body.appendChild(effRow);
  // 当前思考级别（Think Level）
  const allEfforts = Array.from(new Set([...opts, 'none', 'auto', 'low', 'medium', 'high', 'xhigh', 'max']));
  const curSel = el('select', 'setting-control mc-e-effort');
  allEfforts.forEach((o) => {
    const op = document.createElement('option');
    op.value = o; op.textContent = o;
    if (o === curEff) op.selected = true;
    curSel.appendChild(op);
  });
  if (!curEff || !allEfforts.includes(curEff)) curSel.selectedIndex = 0;
  const curRow = el('div', 'pm-row mc-edit-row');
  curRow.appendChild(el('label', null, t('provider.fldEffort')));
  curRow.appendChild(curSel);
  body.appendChild(curRow);
  // 继承 / 覆盖（模型级自定义端点）
  const ovrRow = el('div', 'pm-row mc-edit-row');
  ovrRow.appendChild(el('label', null, ''));
  const inheritTog = el('span', 'inherit-toggle' + (hasOverride ? '' : ' active'), t('provider.inherit'));
  inheritTog.dataset.mode = 'inherit';
  const overrideTog = el('span', 'inherit-toggle' + (hasOverride ? ' active' : ''), t('provider.override'));
  overrideTog.dataset.mode = 'override';
  ovrRow.appendChild(inheritTog);
  ovrRow.appendChild(el('span', null, '/'));
  ovrRow.appendChild(overrideTog);
  const ovrUrl = el('input', 'cfg-text mc-e-ovr-url');
  ovrUrl.placeholder = group ? (group.baseURL || 'baseURL') : 'baseURL';
  ovrUrl.style.display = hasOverride ? '' : 'none';
  const ovrKey = el('input', 'cfg-text mc-e-ovr-key');
  ovrKey.type = 'password';
  ovrKey.placeholder = 'sk-…';
  ovrKey.style.display = hasOverride ? '' : 'none';
  ovrRow.appendChild(ovrUrl);
  ovrRow.appendChild(ovrKey);
  body.appendChild(ovrRow);
  [inheritTog, overrideTog].forEach((tog) => {
    tog.addEventListener('click', () => {
      inheritTog.classList.toggle('active', tog === inheritTog);
      overrideTog.classList.toggle('active', tog === overrideTog);
      const isOvr = tog === overrideTog;
      ovrUrl.style.display = isOvr ? '' : 'none';
      ovrKey.style.display = isOvr ? '' : 'none';
    });
  });
  // 保存 / 取消
  const actRow = el('div', 'pm-row mc-edit-actions');
  const saveNote = el('span', 'save-note');
  const cancelBtn = el('button', 'secondary-button', t('modal.cancel'));
  cancelBtn.type = 'button';
  cancelBtn.addEventListener('click', closeMcModelEdit);
  const saveBtn = el('button', 'primary-button', t('provider.save'));
  saveBtn.type = 'button';
  saveBtn.addEventListener('click', () => {
    const isOverride = overrideTog.classList.contains('active');
    api('/api/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providerModel: {
          provider: mcEditModel.provider,
          modelName: m.name,
          apiModel: apiIn.value.trim() || undefined,
          displayName: dispIn.value.trim() || undefined,
          reasoningEffortOptions: effIn.value.split(',').map((x) => x.trim()).filter(Boolean) || undefined,
          reasoningEffort: curSel.value || undefined,
          contextLimit: Number(ctxIn.value) > 0 ? Number(ctxIn.value) : undefined,
          overrideBaseURL: isOverride ? (ovrUrl.value.trim() || undefined) : undefined,
          overrideApiKey: isOverride ? (ovrKey.value.trim() || undefined) : undefined,
        },
      }),
    }).then(() => {
      saveNote.textContent = t('provider.saved');
      setTimeout(() => {
        closeMcModelEdit();
        refreshStatus().catch(() => {});
      }, 350);
    }).catch((err) => notify(t('provider.errSave', { msg: err.message }), 'error'));
  });
  actRow.appendChild(saveNote);
  actRow.appendChild(cancelBtn);
  actRow.appendChild(saveBtn);
  body.appendChild(actRow);
}

function closeMcModelEdit() {
  $('#mc-model-edit').classList.add('hidden');
  mcEditModel = null;
}
// 弹窗关闭：✕ / 点击遮罩 / Esc（Esc 链在全局 keydown 中优先处理）
$('#btn-close-mc-edit')?.addEventListener('click', closeMcModelEdit);
$('#mc-model-edit')?.addEventListener('click', (e) => { if (e.target === e.currentTarget) closeMcModelEdit(); });

/** 设置面板「模型配置」tab 数据刷新：Provider 条 + 面板 + 模型表格 */
function fillModelConfigForm(s) {
  // 首次打开（从未选择过分组）：自动选中当前默认模型所属的 provider 分组——
  // 已添加的 provider 模型列表直接可见（而非停在空态）
  if (cfgProviderSel === null) {
    const groups = Array.isArray(s.providers) ? s.providers : [];
    if (groups.length > 0) {
      const cur = s.model || '';
      const named = groups.find((g) => g.name);
      const own = groups.find((g) => g.name && providerModelsOf(g).some((m) => m.name === cur || `${g.name}/${m.name}` === cur));
      cfgProviderSel = own ? own.name : (named ? named.name : groups[0].name);
    }
  }
  renderProviderBar(s);
  renderProviderPanel(s);
  // 添加模型（组内；新建模式下先落盘 provider 配置再添加）——onclick 覆盖注册防重复监听。
  // 能力表命中的自动预填 context / 思考级别选项；添加后自动展开新行编辑其余字段。
  const nameInput = $('#pm-name');
  if (nameInput) {
    nameInput.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        $('#btn-add-model')?.click();
      }
    };
  }
  $('#btn-add-model').onclick = async () => {
    const modelName = nameInput.value.trim();
    if (!modelName) return;
    const provider = await ensureProviderName();
    if (!provider) return;
    await fillModelCapabilities([modelName]);
    const cap = mcCaps.get(modelName) || null;
    api('/api/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providerModel: {
          provider,
          modelName,
          contextLimit: cap && cap.context ? cap.context : undefined,
          reasoningEffortOptions: cap && Array.isArray(cap.effortOptions) && cap.effortOptions.length > 1 ? cap.effortOptions : undefined,
        },
      }),
    }).then(async () => {
      nameInput.value = '';
      await refreshStatus();
      // 添加后直接打开编辑弹窗（填写 apiModel/上下文/思考级别等）
      const s2 = state.status || {};
      const groups = Array.isArray(s2.providers) ? s2.providers : [];
      const g = groups.find((x) => x.name === provider) || null;
      const mm = g ? providerModelsOf(g).find((x) => x.name === modelName) : null;
      if (mm) openMcModelEdit(s2, g, mm, false);
      else { cfgProviderSel = provider; renderProviderBar(s2); renderProviderPanel(s2); }
    }).catch((err) => notify(t('provider.errAdd', { msg: err.message }), 'error'));
  };
  // 新建 provider
  $('#btn-provider-new').onclick = () => {
    cfgProviderSel = '__new__';
    cfgProviderNewName = '';
    mcNewCatalog = null;
    closeMcModelEdit();
    renderProviderBar(s);
    renderProviderPanel(s);
  };
}
// Provider / 模型搜索过滤（实时）
$('#mc-provider-search')?.addEventListener('input', () => {
  const s = state.status || {};
  renderProviderBar(s);
});
$('#mc-model-search')?.addEventListener('input', () => {
  const s = state.status || {};
  const groups = Array.isArray(s.providers) ? s.providers : [];
  const isNew = cfgProviderSel === '__new__' || cfgProviderNewName;
  const group = !isNew ? groups.find((g) => g.name === cfgProviderSel) || null : null;
  renderModelList(s, group, isNew);
});
$('#plan-mode').addEventListener('change', (e) => {
  applySettings({ planMode: e.target.checked }).catch((err) => notify(t('err.settings', { msg: err.message }), 'error'));
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
  list.appendChild(el('div', 'dir-empty', t('dir.loading')));
  try {
    const data = await api(`/api/fs/dirs?path=${encodeURIComponent(p)}`);
    dirPickerPath = data.current;
    $('#dirpicker-current').textContent = data.current;
    list.innerHTML = '';
    if (!data.dirs.length) {
      list.appendChild(el('div', 'dir-empty', t('dir.empty')));
      return;
    }
    for (const name of data.dirs) {
      const item = el('button', 'dir-item');
      item.type = 'button';
      item.appendChild(el('span', 'dir-name', name));
      item.addEventListener('click', () => navigateDirPicker(`${data.current}/${name}`.replace(/\/+/g, '/')));
      list.appendChild(item);
    }
  } catch (e) {
    list.innerHTML = '';
    list.appendChild(el('div', 'dir-empty', t('dir.unreadable', { msg: e.message })));
  }
}

$('#btn-dir-up').addEventListener('click', () => {
  if (dirPickerPath && dirPickerPath !== '/') navigateDirPicker(dirPickerPath.replace(/\/[^/]+\/?$/, '') || '/');
});
$('#btn-dir-select').addEventListener('click', () => {
  if (!dirPickerPath) return;
  closeDirPicker();
  switchWorkspace(dirPickerPath).catch((err) => notify(t('err.workspaceSwitch', { msg: err.message }), 'error'));
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

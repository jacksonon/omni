/**
 * TUI 本地化：界面 chrome 字符串的中英文字典（/settings 语言切换，默认中文）。
 *
 * 设计：
 *   · `t(lang, key)` 取字符串（缺失回退中文，再缺失回退 key 本身——新 key 忘配不炸）；
 *   · `tf(lang, key, vars)` 取字符串并做 `{var}` 插值；
 *   · 命令面板的具体输出（/status 列表、/session 列表等命令结果内容）暂保持中文，
 *     只本地化界面 chrome（菜单/状态栏/footer/待发送/联想/审批卡/help/tokens 模块等）——
 *     见 Doc/evolution-log.md 第一百一十五次。
 */

/** 支持的界面语言 */
export type TuiLang = 'zh' | 'en';

/** 全部支持的语言（/settings 语言面板按此列出） */
export const TUI_LANGS: TuiLang[] = ['zh', 'en'];

/** 语言选项显示名（用其自身语言——中文 / English，用户不切换语言也能认出目标语言） */
export const TUI_LANG_LABELS: Record<TuiLang, string> = { zh: '中文', en: 'English' };

const ZH: Record<string, string> = {
  // footer 统计行段（layout.ts STATUSLINE_SEGMENTS：label 面板显示名 / build 段文本）
  'statusline.speed.label': '首token/速率',
  'statusline.speed': '首 token 平均 {avg}s · {rate} tok/s',
  'statusline.cache.label': '缓存命中',
  'statusline.cache': '缓存命中 {pct}%',
  'statusline.tokens.label': '输入/输出',
  'statusline.tokens': '输入 {in} tok · 输出 {out} tok',
  'statusline.context.label': '上下文',
  'statusline.context': '上下文 {used}{limit}',

  // 内容区（rows.ts）
  'tokens.summary': '⚡ {n} 次 LLM 请求 · 输入 {in} · 输出 {out} · 缓存 {cached}',
  'tokens.item': '  - LLM 请求：输入 {in} · 输出 {out} · 缓存 {cached}',
  'scroll.topHint': '↑ 上方还有 {n} 行 · 滚轮/PgUp 上滚',
  'scroll.backHint': '↑ 已上滚 {n} 行 · 共 {total} 行 · End 回到最新',
  'menu.hint': '↑/↓ 或数字选择 · Enter 确认 · Esc 取消',
  'toast.copied': '✓ 已复制',
  'toast.modelSwitched': '✓ 已切换到 {model}',
  'cmdpanel.hint': '↑↓ 滚动 · Esc 关闭（还有 {n} 行）',
  'cmdpanel.close': 'Esc 关闭',
  'cmdpanel.none': '（无输出）',
  'trace.title': '轨迹（{n} 条）',
  'trace.empty': '暂无轨迹——开始对话后这里会记录每一轮请求/工具/消息',
  'trace.hint': 'Esc 收起 · ↑↓ 选择 · 点击查看详情',
  'trace.back': '返回',
  'trace.scrollUp': '↑ 还有 {n} 行',
  'trace.scrollDown': '↓ 还有 {n} 行',
  'approval.hint': '[y] 批准    [n] 拒绝（Enter/Esc 同）',
  'settings.title': '设置：状态行',
  'settings.hint': '空格 勾选/取消 · ←/→ 排序 · a 对齐 · Enter 保存生效 · Esc 取消',
  'statusline.align': '对齐',
  'statusline.align.left': '左侧',
  'statusline.align.center': '居中',
  'statusline.align.right': '右侧',

  // 输入区 / footer（render.ts）——模型行 = footerMode（模式前缀独立着色 Build/Plan）
  // + footerModel（模型名+provider，'{model}{provider}'）拼接；mode 前缀走 footer.mode.*
  'input.placeholder': '输入消息，Enter 发送；Shift+Enter 换行',
  'footer.model': '{model}{provider}',
  'footer.mode.build': 'Build',
  'footer.mode.plan': 'Plan',
  'footer.effort': ' · {effort}',
  'pending.title': '⏳ 待发送（{q}{s}）',
  'pending.steer': ' · ⚡ {s} 打断',
  'pending.more': '  · 还有 {n} 条…',
  'suggest.hint': '  {arrow} 还有 {n} 个（↑/↓ 滚动）',
  'suggest.commandsTitle': '命令',
  'suggest.filesTitle': '文件',
  'cmdgroup.session': '会话',
  'cmdgroup.model': '模型',
  'cmdgroup.agent': '智能体',
  'cmdgroup.system': '系统',
  'shortcut.hint': 'Ctrl-X 快捷键：t 主题 · p 权限 · m 模型 · v 思考级别 · s 设置 · l 计划 · h 思考 · u 撤销 · r 重做 · c 清空 · ? 帮助（Esc 取消）',

  // 状态栏 / 帮助（output.ts）
  'status.ready': '模型 {model} · 就绪',
  'status.requestFailed': '请求失败',
  'status.aborted': '已中止',
  'status.approval': '等待审批：{tool}',
  'status.ask': '等待你的选择（↑↓ 移动 · 空格 勾选 · Enter 提交）',
  'ask.single': '单选',
  'ask.multiple': '多选',
  'ask.custom': '自定义',
  'ask.customPlaceholder': '输入内容…',
  'ask.confirm': '确认',
  'ask.hint': '↑↓ 选择 · 空格 勾选 · 输入自定义后 Enter 提交 · Esc 取消',
  'help.title': '帮助',
  'help.intro': '直接输入消息开始对话，Enter 发送；Shift+Enter 换行（需终端支持修饰键；多行输入自动增高）。',
  'help.shortcuts': '快捷键：Ctrl+X 前缀——t 主题 · p 权限 · m 模型 · v 思考级别 · s 设置 · l 计划模式 · h 思考显示 · u 撤销 · r 重做 · c 清空 · ? 帮助（再按 Esc 取消）',
  'help.commands': '/settings 设置（状态行 / 语言 / 主题 / token 统计 / 诊断） · /permission 安全权限（低/中/高/全量） · /thinking 思考展开/折叠 · /plan 计划模式（只读调研） · /undo 撤销本次会话的文件修改 · /rewind 会话检查点（回滚工作区到历史回合） · /init [--global] 生成项目/全局记忆 · /agents 子代理配置 · /orchestrate 并行编排（fan-out+汇总+对抗审查） · /goal 目标机制（自动推导验收标准并循环直至达标） · /exit 退出 · /clear 清空上下文 · /help 显示帮助',
  'help.scroll': '滚动：鼠标滚轮 / PgUp/PgDn 翻页 · Ctrl+U/Ctrl+D 翻页（输入框为空）· ↑/↓ 逐行（输入框为空）· End 回到底部',
  'help.more': '完整命令参考：omni --help（控制台）',

  // 菜单（commands.ts）——操作提示在面板内部 menu.hint 行渲染，不再写状态栏
  'menu.theme.title': '主题',
  'menu.theme.system': '跟随系统',
  'menu.theme.light': '亮色',
  'menu.theme.dark': '深色',
  'menu.permission.title': '安全权限',
  'menu.permission.read': '低（只读）',
  'menu.permission.safe': '中（标准）',
  'menu.permission.ask': '高（谨慎）',
  'menu.permission.full': '全量（直通）',
  'menu.variants.title': '思考级别',
  'menu.model.title': '模型',
  'menu.model.ungrouped': '未分组',
  'menu.session.title': '会话',
  'menu.settings.title': '设置',
  'settings.statusline': '状态行（底部对话信息）',
  'settings.language': '语言',
  'settings.theme': '主题（亮色 / 深色 / 跟随系统）',
  'settings.tokens': '当次 token 统计（输入/输出/缓存）',
  'settings.doctor': '环境诊断（Node/Bun/API/配置）',
  'menu.language.title': '语言',
  'confirm.session': '已选择会话 → {label}（加载中…）',
};

const EN: Record<string, string> = {
  'statusline.speed.label': 'First token/Rate',
  'statusline.speed': 'First token avg {avg}s · {rate} tok/s',
  'statusline.cache.label': 'Cache hit',
  'statusline.cache': 'Cache hit {pct}%',
  'statusline.tokens.label': 'In/Out',
  'statusline.tokens': 'In {in} tok · Out {out} tok',
  'statusline.context.label': 'Context',
  'statusline.context': 'Context {used}{limit}',

  'tokens.summary': '⚡ {n} LLM requests · In {in} · Out {out} · Cached {cached}',
  'tokens.item': '  - LLM request: In {in} · Out {out} · Cached {cached}',
  'scroll.topHint': '↑ {n} more lines above · Scroll/PgUp up',
  'scroll.backHint': '↑ Scrolled up {n} · {total} total · End to bottom',
  'menu.hint': '↑/↓ select · Enter confirm · Esc cancel',
  'toast.copied': '✓ Copied',
  'toast.modelSwitched': '✓ Switched to {model}',
  'cmdpanel.hint': '↑↓ scroll · Esc close ({n} more)',
  'cmdpanel.close': 'Esc close',
  'cmdpanel.none': '(no output)',
  'trace.title': 'Trace ({n})',
  'trace.empty': 'Empty — each turn/request/tool will be recorded here',
  'trace.hint': 'Esc close · ↑↓ select · click for details',
  'trace.back': 'Back',
  'trace.scrollUp': '↑ {n} more',
  'trace.scrollDown': '↓ {n} more',
  'approval.hint': '[y] Approve    [n] Reject (Enter/Esc same)',
  'settings.title': 'Settings: Status line',
  'settings.hint': 'Space · ←/→ move · a align · Enter · Esc cancel',
  'statusline.align': 'Align',
  'statusline.align.left': 'Left',
  'statusline.align.center': 'Center',
  'statusline.align.right': 'Right',

  'input.placeholder': 'Type a message, Enter to send; Shift+Enter for newline',
  'footer.model': '{model}{provider}',
  'footer.mode.build': 'Build',
  'footer.mode.plan': 'Plan',
  'footer.effort': ' · {effort}',
  'pending.title': '⏳ Pending ({q}{s})',
  'pending.steer': ' · ⚡ {s} steer',
  'pending.more': '  · {n} more…',
  'suggest.hint': '  {arrow} {n} more (↑/↓ scroll)',
  'suggest.commandsTitle': 'Commands',
  'suggest.filesTitle': 'Files',
  'cmdgroup.session': 'Session',
  'cmdgroup.model': 'Model',
  'cmdgroup.agent': 'Agent',
  'cmdgroup.system': 'System',
  'shortcut.hint': 'Ctrl-X: t theme · p permission · m model · v level · s settings · l plan · h thinking · u undo · r redo · c clear · ? help (Esc cancel)',

  'status.ready': 'Model {model} · Ready',
  'status.requestFailed': 'Request failed',
  'status.aborted': 'Aborted',
  'status.approval': 'Waiting for approval: {tool}',
  'status.ask': 'Waiting for your choice (↑↓ move · space toggle · Enter submit)',
  'ask.single': 'single',
  'ask.multiple': 'multi',
  'ask.custom': 'Custom',
  'ask.customPlaceholder': 'type here…',
  'ask.confirm': 'Confirm',
  'ask.hint': '↑↓ select · space toggle · type custom + Enter submit · Esc cancel',
  'help.title': 'Help',
  'help.intro': 'Type a message to chat, Enter to send; Shift+Enter for newline (needs terminal modifier support; auto-grows for multi-line).',
  'help.shortcuts': 'Shortcuts: Ctrl+X prefix — t theme · p permission · m model · v thinking level · s settings · l plan mode · h thinking display · u undo · r redo · c clear · ? help (Esc cancels)',
  'help.commands': '/settings settings (statusline / language / theme / token stats / diagnostics) · /permission security (read/safe/ask/full) · /thinking expand/collapse thinking · /plan plan mode (read-only) · /undo undo file changes · /rewind session checkpoints (roll workspace back to a past turn) · /init [--global] generate AGENTS.md · /agents subagent config · /orchestrate parallel pipeline (fan-out+combine+review) · /goal goal mechanism (derive criteria and loop until met) · /exit quit · /clear clear context · /help help',
  'help.scroll': 'Scroll: mouse wheel / PgUp/PgDn pages · Ctrl+U/Ctrl+D pages (empty input) · ↑/↓ per line (empty input) · End to bottom',
  'help.more': 'Full command list: omni --help (console)',

  'menu.theme.title': 'Theme',
  'menu.theme.system': 'System',
  'menu.theme.light': 'Light',
  'menu.theme.dark': 'Dark',
  'menu.permission.title': 'Security',
  'menu.permission.read': 'Read (read-only)',
  'menu.permission.safe': 'Safe (default)',
  'menu.permission.ask': 'Ask (all commands)',
  'menu.permission.full': 'Full (no checks)',
  'menu.variants.title': 'Thinking level',
  'menu.model.title': 'Model',
  'menu.model.ungrouped': 'Ungrouped',
  'menu.session.title': 'Sessions',
  'menu.settings.title': 'Settings',
  'settings.statusline': 'Status line (footer stats)',
  'settings.language': 'Language',
  'settings.theme': 'Theme (light / dark / system)',
  'settings.tokens': 'Per-turn token stats (in/out/cache)',
  'settings.doctor': 'Environment diagnostics (Node/Bun/API/config)',
  'menu.language.title': 'Language',
  'menu.language.status': 'Language: ↑/↓ or number · Enter confirm · Esc cancel',
  'confirm.session': 'Session selected → {label} (loading…)',
};

/** 取字符串（en 缺失回退 zh，再缺失回退 key——新 key 忘配不炸） */
export function t(lang: TuiLang, key: string): string {
  if (lang === 'en') {
    const v = EN[key];
    if (v !== undefined) return v;
  }
  const z = ZH[key];
  return z !== undefined ? z : key;
}

/** 取字符串并做 `{var}` 插值（未出现的变量原样保留，调用方保证传全） */
export function tf(lang: TuiLang, key: string, vars: Record<string, string | number>): string {
  let s = t(lang, key);
  for (const [k, v] of Object.entries(vars)) {
    s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}

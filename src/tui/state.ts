/**
 * TUI 状态：Agent 运行过程的可变状态（纯对象，无响应式依赖）。
 *
 * 由 TuiOutput 写入，render 层在每次 paint 时读取并重建渲染树。
 * 模型：一列"段落"（TuiLine），paint 时按 \n 拆成多行。
 */
import type { PermissionTier } from '../safety/policy.js';
import type { TokenUsage } from '../output/types.js';
import type { WriteDiff } from '../output/format.js';
import type { TuiLang } from './i18n.js';
import type { TraceRow } from '../agent/trace.js';
import type { AskResult } from '../tools/ask.js';

/** spinner 动画帧（braille 点阵） */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * 终端主题设置（/theme 命令可切换）：
 *   · system = 跟随系统（默认，按终端背景亮度自动检测）
 *   · light / dark = 手动强制
 */
export type TuiThemeMode = 'system' | 'light' | 'dark';

export type TuiLineKind =
  | 'thinking' // 💭 思考（浅色）
  | 'answer' // 最终回答（默认色）
  | 'user' // 用户消息（白字灰底 + 蓝色细线，无 ❯ 前缀）
  | 'meta' // 元信息（浅色）
  | 'warn' // 警告（黄色）
  | 'task' // 任务标题（青色加粗）
  | 'tool' // 工具调用卡片（可点击展开/收起）
  | 'tokens'; // 当次 token 使用统计（收起=汇总，点击展开=逐次 LLM 请求明细）

/**
 * 当次对话轮（一次用户消息 → 回答结束）的 token 使用统计（kind === 'tokens' 时由
 * TuiLine.tokens 携带）：usages = 该轮内**每次 LLM 请求**的用量（onUsage 按请求顺序
 * 收集，一轮可能有多次——多步工具调用每步各一次），汇总 = 各请求之和；
 * expanded = 是否展开逐项明细（默认收起只显示汇总，用户要求）。
 */
export interface TurnTokens {
  usages: TokenUsage[];
  expanded: boolean;
}

/** 工具卡片状态：执行中 / 成功 / 失败 */
export type ToolStatus = 'running' | 'ok' | 'err';

/**
 * 工具调用卡片数据（kind === 'tool' 时由 TuiLine.card 携带）。
 * 渲染成圆角方框：标题 + 摘要 + 状态；完成后默认收起，点击展开输出。
 */
export interface ToolCard {
  id: number;
  name: string;
  /** 人类可读摘要（如 `$ echo mock-ok` / `→ Read 路径`） */
  summary: string;
  status: ToolStatus;
  /** 输出预览行（previewOutput 前 5 行） */
  output: string[];
  /** 是否展开显示输出 */
  expanded: boolean;
  /** 工具返回的字符数（收起态执行缩略行显示） */
  chars?: number;
  /** read_file：并行多读合并的路径列表（>1 时标题 `→ Read N files`，展开逐条 ⤷） */
  paths?: string[];
  /** write_file 写入前后对比（新增=original null / 修改=左右对比；无对比数据为 null） */
  diff?: WriteDiff | null;
  /** delegate 子代理结果摘要（onSubagentEvent end 填充）：收起态显示命令行 + `✓ N 步 · 结果首行` */
  subagent?: { name: string; ok: boolean; steps: number; summary?: string };
  /** delegate 原命令行快照（onSubagentEvent start 保存，end 还原——运行中 summary 被进度覆盖） */
  _cmd?: string;
}

export interface TuiLine {
  kind: TuiLineKind;
  text: string;
  /** kind === 'tool' 时携带卡片数据 */
  card?: ToolCard;
  /** kind === 'thinking' 时携带思考耗时（毫秒；思考中由 TuiOutput 逐 chunk 刷新实时值，
   *  思考区结束时写入最终值，展开态头行显示 `· 3.2s`） */
  thinkingMs?: number;
  /** kind === 'thinking' 且正在流式思考（思考区未结束）：头行前缀显示 loading spinner
   *  （`⠋ thinking · 实时耗时`）；思考完（finish）置 false → 头行变 `- thinking · 耗时` */
  thinkingRunning?: boolean;
  /** kind === 'tokens' 时携带当次 token 统计（usages + 展开态） */
  tokens?: TurnTokens;
}

/** 待发送消息类型：queue = 正常排队（Enter）；steer = 打断优先（Cmd/Ctrl/Option+Enter，插入最前） */
export type PendingMode = 'queue' | 'steer';

/** 待发送消息（输入框上方小视图展示；进入对话前可选中/移动/删除/编辑） */
export interface PendingMessage {
  id: number;
  mode: PendingMode;
  text: string;
}

/** 内容区滚动意图（一次性，由 computeRows 在下次重绘时消费） */
export type ScrollAction = 'line-up' | 'line-down' | 'page-up' | 'page-down' | 'top' | 'bottom';

/** 滚动意图；lines 为逐行滚动步长（鼠标滚轮一格约 3 行） */
export interface ScrollIntent {
  action: ScrollAction;
  lines?: number;
}

/** 命令面板（/theme 等）：圆角方框 + 可选项，↑/↓ 或数字选择、Enter 确认、Esc 取消 */
export interface TuiMenu {
  /** 面板 id（选择后按 id 分发处理） */
  id: string;
  /** 面板标题（如「主题」） */
  title: string;
  /** 选项（group=true 为分组头行：dim 展示、不可选中、不参与 ↑/↓/数字选择） */
  options: { label: string; value: string; group?: boolean }[];
  /** 当前高亮的选项下标（› 光标） */
  selectedIndex: number;
  /** 当前生效的值（✓ 标记） */
  currentValue: string;
  /**
   * 窗口滚动：可见窗口首项下标（选项超面板高度时滚动查看，同联想浮层 suggest.top 模式）。
   * 由渲染层（menuPanelRows）每帧收敛——选中项必须保持在窗口内（交互层 ↑/↓ 移动
   * selectedIndex，渲染兜底把窗口跟随到选中项）。
   */
  scrollTop: number;
}

/**
 * 工具调用审批（安全护栏）：`run_command` 命中危险命令 / 权限分级要求确认时，
 * 内容流末尾渲染审批卡片（`[y] 批准  [n] 拒绝`），鼠标点击左右半区或键盘 y/n 决定。
 */
export interface TuiApproval {
  /** 请求审批的工具名 */
  tool: string;
  /** 人类可读摘要（如 `$ rm -rf /`） */
  summary: string;
  /** 需要审批的原因（危险命令匹配 / 权限策略） */
  reason: string;
}

/**
 * 向用户提问面板（ask_user 工具）：输入区上方**竖向勾选列表**（`[x]` 勾选、支持
 * 单选/多选、末尾自定义行键入内容），底部确认行（Enter/点击确认提交）。与审批
 * 卡片同队列模式（串行展示）。
 */
export interface TuiAsk {
  /** 问题（模型 ask_user 的 question） */
  question: string;
  /** 候选选项（2-6 个；面板每行一个） */
  options: string[];
  /** true = 多选（可勾选多个选项）；false = 单选（勾选自动互斥） */
  multiple: boolean;
  /** 勾选的选项下标集合（单选最多 1 个；Set 便于切换） */
  selected: Set<number>;
  /** 自定义输入内容（末尾自定义行；有内容即视为勾选） */
  custom: string;
  /** 高亮行光标（0..options.length；options.length = 自定义行） */
  cursor: number;
}

/**
 * 状态行设置面板（/settings statusline）：多选 + 排序编辑。
 * 不同于单选面板（TuiMenu）——每项可勾选/取消（空格）、可排序（←/→）、
 * Enter 保存并生效、Esc 取消。渲染复用菜单浮层（menuOverlay）。
 */
export interface StatuslinePanel {
  /** 全部段（顺序即当前显示顺序）；enabled=false 的段不显示 */
  items: { id: string; label: string; enabled: boolean }[];
  /** 高亮项下标（↑/↓ 移动；空格勾选/取消；←/→ 排序） */
  selected: number;
}

/**
 * 会话运行统计（footer 统计行数据源）：
 *   · turns —— 轮数（onTurnStart，交互每轮用户提交 / 单次任务各 1 次）
 *   · steps —— 工具调用总次数（onToolStep）
 *   · llmMs —— LLM 流式请求累计墙钟（onLlmLap）
 *   · toolsMs —— 工具执行累计墙钟（onToolsLap）
 *   · firstTokenSum / firstTokenCount —— 首 token 延迟累计（平均 = sum/count）
 *   · cached —— 缓存命中 token 累计（onUsage；命中率 = cached / prompt）
 */
export interface SessionStats {
  turns: number;
  steps: number;
  llmMs: number;
  toolsMs: number;
  firstTokenSum: number;
  firstTokenCount: number;
  /** 纯生成耗时累计（lastContentAt - firstTokenAt，排除首 token 等待；tok/s = completion / genMs） */
  genMs: number;
  cached: number;
}

/**
 * 命令输出面板：**所有 / 命令的输出（含 /skill、/session、/status 等）统一进这个
 * 独立浮层窗口，不进对话流（state.lines）**——用户要求「所有的 command 都是独立
 * 窗口，不要影响对话流」。圆角方框 + 标题，内容超高时 ↑/↓ 滚动，Esc/Enter 关闭。
 */
export interface CmdPanel {
  /** 面板标题（如 /skill、/session 20260813） */
  title: string;
  /** 输出行（纯文本；渲染层按面板宽折行 + 垂直滚动） */
  lines: string[];
  /** 滚动位置（渲染层 clamp 到合法区间） */
  scroll: number;
}

/**
 * 斜杠命令联想列表（输入框内容以 / 开头时显示在输入框上方）。
 *
 * 非模态：用户可继续输入（列表按最新文本过滤，无匹配自动隐藏）；
 * ↑/↓ 移动高亮、Tab 填入命令、Enter 直接执行高亮命令、Esc 关闭。
 * 由 repaintTree 在 paint 时按输入框最新文本刷新（互不影响输入）。
 */
export interface CmdSuggestion {
  /** / 后面的已输入部分（用于过滤） */
  query: string;
  /** 全部匹配的命令名（name 与 aliases；**不再截断**——↑/↓ 可滚动到全部，渲染层只显示窗口） */
  items: string[];
  /** 可见窗口首项下标（滚动位置；选中项始终在窗口内） */
  top: number;
  /** 当前高亮下标（0..items.length-1） */
  selected: number;
  /** 可见窗口行数（repaint 按高度预算计算；interactive 滚动用） */
  window: number;
}

/**
 * @ 提及文件选择列表（输入框内容含 @ 时显示在输入框上方，与 / 命令联想共用浮层）。
 *
 * 非模态：可继续输入（列表按光标前最后一个 @ 后的文本过滤，无匹配自动隐藏）；
 * ↑/↓ 移动高亮、Tab/Enter 选中插入、Esc 关闭；目录以 / 结尾（选中后保留 / 继续
 * 进入下一层浏览），文件插入后加空格结束提及。
 * 查询为**模糊匹配 + 跨目录递归检索**：非空查询从 cwd 递归整个项目（文件名前缀 >
 * 文件名包含 > 路径包含 > fzf 模糊子序列）；空查询（或 @dir/）只列该目录顶层。
 */
export interface MentionSuggestion {
  /** @ 后的查询（可含 / 限定目录，如 src/ma → 只在 src/ 下检索）；空 = 顶层浏览 */
  query: string;
  /** @ 在输入文本中的起始下标（插入时替换 @query 整段） */
  atIndex: number;
  /** 全部匹配的文件/目录路径（目录以 / 结尾；含目录前缀；**不截断**——↑/↓ 可滚动） */
  items: string[];
  /** 可见窗口首项下标（滚动位置；选中项始终在窗口内） */
  top: number;
  /** 当前高亮下标 */
  selected: number;
  /** 可见窗口行数（repaint 按高度预算计算；interactive 滚动用） */
  window: number;
}

export interface TuiState {
  lines: TuiLine[];
  status: string;
  model: string;
  /** 当前模型所属 provider 组名（config providers 分组；模型不在分组内为空串）。
   *  interactive 从 runOpts.models 按 state.model 解析；/model 切换时 applyEndpoint 同步。 */
  provider: string;
  version: string;
  /** 内容区滚动位置：null = 跟随最新（自动）；数字 = 视口首行索引（上滚状态） */
  scrollTop: number | null;
  /** 待消费的滚动意图（按键/滚轮 → computeRows 消费，避免滚动数学散落在事件层） */
  scrollIntent: ScrollIntent | null;
  /**
   * 输入框当前内容行数（1-5，多行编辑自动增高）。repaintTree 每次从
   * 输入框的 lineCount 实时同步；computeRows 用它精确计算内容区预算——
   * 输入框变高时内容区相应减少，状态栏/输入框永远不会被挤出去。
   */
  /**
   * Ctrl+X 前缀快捷键是否激活（opencode 风格）：激活时下一个按键触发
   * 绑定动作（t 主题 / p 权限 / m 模型 / v 级别 / s 设置 / l 计划 / h 思考 /
   * u 撤销 / r 重做 / c 清空 / ? 帮助），Esc 或未绑定键取消前缀。
   * 激活期间状态栏显示绑定键提示（shortcut.hint）。
   */
  shortcutPrefix: boolean;
  /** spinner 帧索引（-1 = 不显示） */
  spinnerIndex: number;
  /**
   * hero 横幅动画帧偏移（0-360，逐帧 +4 循环）：未开始对话时 rainbow 彩虹色随帧
   * 旋转（每行按行号错相 → 竖向流动渐变）。由 interactive 的动画定时器推进。
   */
  bannerHue: number;
  /**
   * 统计行左侧 loading（会话进行中一直转；Esc 取消/会话结束消失）：
   * loading = 是否显示；loadingIndex = 当前帧（-1 = 隐藏）。由 TuiOutput
   * 的 startLoading/stopLoading 维护（独立于状态栏 spinner——流式期间
   * spinnerIndex 会被置 -1，loading 不受影响）。
   */
  loading: boolean;
  loadingIndex: number;
  /** 是否正在流式生成回答（显示光标在末尾） */
  generating: boolean;
  /**
   * 是否展开显示全部思考过程（点击思考行可单独切换；默认 true）。false = 每个思考
   * 段落折叠成一行 `+ thinking`。会话级状态（/clear 不清除），buildBody 渲染时读取。
   */
  thinkingExpanded: boolean;
  /**
   * 是否展示思考过程流（/thinking 命令切换；默认跟随配置 showThinking）。false =
   * buildBody 渲染时过滤掉所有 thinking 行（历史与新轮的思考都不显示，会话级 /clear
   * 不清除）；TuiOutput 同步停止建模块/写 chunk（数据仍捕获并落盘 .omni/last-thinking.md，
   * 重新打开即恢复显示）。
   */
  thinkingShow: boolean;
  /**
   * 是否展示当次 token 使用统计（/tokens 命令切换；默认 true）。false = buildBody
   * 渲染时过滤掉所有 tokens 行（历史与新轮的统计都不显示，会话级 /clear 不清除）；
   * onTurnEnd 仍照常插入（数据保留，重新打开即恢复显示）。
   */
  showTokens: boolean;
  /**
   * **单独展开**的思考行下标集合：折叠态（thinkingExpanded=false）下点击某条
   * `+ thinking` 摘要可只展开该条。下标 = state.lines 中的索引（流式 appendLine
   * 只追加不插入，下标稳定）；/thinking 切换或 /clear 清空。
   */
  expandedThinking: Set<number>;
  /**
   * **单独收起**的思考行下标集合：展开态（thinkingExpanded=true）下点击某条
   * `- thinking` 头行/内容可只收起该条（回到 `+ thinking`）。/thinking 切换或
   * /clear 清空。与 expandedThinking 互补——全局开关决定默认态，两个集合记录
   * 用户点击产生的反例（effective = thinkingExpanded ? !collapsed : expanded）。
   */
  collapsedThinking: Set<number>;
  inputLines: number;
  /** 当前工作目录（footer 左下角显示，超长中段省略） */
  cwd: string;
  /**
   * 可用模型名列表（顶层 model + config `models`；/model 面板列出）。
   * 由 interactive 从 runOpts.models 初始化；/model 切换时 state.model 变更。
   */
  models: string[];
  /**
   * 会话标题（首轮对话结束后由模型自动概括生成，设为**终端窗口/标签页标题**
   * （setTerminalTitle，OSC 0），不显示在信息流里；null = 尚未生成/生成失败）。
   * 会话级状态，/clear 不清除；渲染层不读它，仅 interactive.ts 作「生成一次」的守卫。
   */
  sessionTitle: string | null;
  /**
   * 退出提示恢复命令（如 `omni -s <会话id>`）：交互循环 persistTurn 落盘真实消息后
   * 设置；/exit 或 Ctrl+C 退出、终端恢复后打印给用户（不空会话不提示）。
   */
  restoreHint: string | null;
  /** 会话累计 token 用量（footer 右下角显示，来自每次响应的 usage） */
  tokens: TokenUsage;
  /**
   * 会话运行统计（footer 统计行：首 token/速率/缓存命中/输入输出）。
   * 由 TuiOutput 按事件累加（onLlmLap/onToolsLap/onUsage）。
   */
  stats: SessionStats;
  /**
   * 最近一次 LLM 请求的 prompt token（= 当前上下文大小；onUsage 每次覆盖——
   * 「从 LLM 消息内拿到」：流末 chunk 的 usage.prompt）。footer context 段显示。
   */
  lastPromptTokens: number;
  /** 当前模型 context 上限（config `limit.context`；interactive 按端点解析，未知为 0）。
   *  footer context 段在已知时显示 `上下文 {used}/{limit}`。 */
  contextLimit: number;
  /**
   * 终端主题设置（system/light/dark，/theme 可切换）：
   * system 时按 detectedTheme（终端实测）取色。
   */
  themeMode: TuiThemeMode;
  /** 终端实测主题（OpenTUI 按背景亮度检测，OSC 查询；system 模式用） */
  detectedTheme: 'dark' | 'light';
  /** 当前打开的命令面板（null = 无面板；打开时键盘事件由面板消费） */
  menu: TuiMenu | null;
  /**
   * 状态行设置面板（/settings statusline；null = 无）。与 menu 互斥（同用菜单浮层）；
   * 打开时键盘事件由 handleSettingsPanelKey 消费（interactive.ts 先于输入框拦截）。
   */
  settingsPanel: StatuslinePanel | null;
  /**
   * 底部状态行（输入区域下方的对话信息）显示哪些段、什么顺序：段 id 数组
   * （speed/cache/tokens/context）。来自配置 statusline（tui-entry 初始化）；
   * /settings statusline 保存后立即生效（buildFooterStats 按它拼行）。空数组 = 不显示。
   */
  statusline: string[];
  /**
   * 待持久化的状态行段顺序（/settings statusline Enter 保存时写入，interactive 每轮
   * 消费并写入配置文件——应用已即时生效，这里只负责落盘；与 sessionPick 同模式）。
   */
  statuslineSave: string[] | null;
  /**
   * 界面语言（/settings 语言面板切换；来自配置 language，tui-entry 初始化）。
   * 切换后界面 chrome 即时按新语言重绘（rows/render/output/commands 全部经 t()/tf()）。
   */
  language: TuiLang;
  /**
   * 待持久化的语言（/settings 语言面板 Enter 保存时写入，interactive 每轮消费并
   * 写入配置文件——应用已即时生效，这里只负责落盘；与 statuslineSave 同模式）。
   */
  languageSave: TuiLang | null;
  /**
   * 待持久化的默认模型名（/model <名称> 切换 / 面板确认时写入，interactive 每轮
   * 消费并写入配置文件顶层 model 字段——下次启动默认就是切换后的模型）。
   */
  modelSave: string | null;
  /**
   * 待持久化的思考级别（/variants 面板确认时写入，interactive 每轮消费并写入
   * 配置文件顶层 reasoningEffort 字段——下次启动仍是切换后的思考级别）。
   */
  variantsSave: string | null;
  /**
   * 命令输出面板（所有 / 命令的输出窗口；null = 无）。
   * 独立浮层（绝对定位居中），不占内容流——命令输出不再写进对话流（用户要求）。
   * 打开时键盘事件由面板消费（↑/↓ 滚动、Esc/Enter 关闭）。
   */
  cmdPanel: CmdPanel | null;
  /** 命令联想列表（null = 不显示；paint 时按输入框文本刷新） */
  cmdSuggest: CmdSuggestion | null;
  /**
   * @ 提及文件选择列表（null = 不显示；paint 时按光标前最后一个 @ 后的文本刷新）。
   * 与命令联想互斥（/ 开头显示命令联想，否则含 @ 时显示提及）；共用同一个浮层。
   */
  mention: MentionSuggestion | null;
  /**
   * 用户按 Esc 关闭提及时的「atIndex:query」键（非 null = 保持隐藏）。
   * 文本变化（atIndex/query 改变）→ 提及恢复；同文本重绘不复活（与命令联想同理）。
   */
  mentionDismissedKey: string | null;
  /**
   * 计划模式（/plan 切换）：只读调研，不修改文件。
   * 会话级状态（/clear 不清除）；footer 模型行模式前缀显示 `Plan`（普通为 `Build`）；
   * interactive 每轮把它同步进 runOpts.planMode（loop 据此过滤只读工具 + 系统提示）。
   */
  planMode: boolean;
  /**
   * 安全权限档位（/permission 切换）：低=read / 中=safe / 高=ask / 全量=full。
   * 会话级状态；interactive 每轮同步进 runOpts.permission 并 setTier 到共用闸门。
   */
  permission: PermissionTier;
  /**
   * 当前模型思考级别（/variants 切换；reasoning_effort，如 low/medium/high）。
   * 会话级状态；interactive 每轮同步进 runOpts.reasoningEffort（loop 请求带上）。
   */
  reasoningEffort: string;
  /**
   * 当前选中的命名 variant（1.0 P0-3，/variants 面板选「命名叠加层」后记录 id；
   * interactive 每轮同步进 runOpts.activeVariant——loop 把该 variant 的
   * body/headers/effort deep-merge 进请求）。null = 未选命名变体。
   */
  activeVariant: string | null;
  /** /variants 面板支持的思考级别选项（来自配置 reasoningEffortOptions） */
  reasoningEffortOptions: string[];
  /**
   * /session 面板确认的会话 id（TUI 面板选择后只记录意图，interactive 每轮
   * 异步加载并恢复该会话——confirmMenu 是纯 state 操作拿不到回调，与 /model 同模式）。
   * 非 null 时 interactive 在处理完恢复后置 null。
   */
  sessionPick: string | null;
  /**
   * /settings 菜单确认「环境诊断」项的意图（confirmMenu 是纯 state 操作拿不到
   * ctx——只记录意图，interactive 每轮消费后调 runCommand('/settings doctor')）。
   * 非 null 时 interactive 在每轮命令分发前执行诊断并置 false。
   */
  doctorPending: boolean;
  /** 输入框当前文本（repaintTree 同步，buildBody/联想共用） */
  inputText: string;
  /**
   * 用户按 Esc 关闭联想时的输入框文本（非 null = 保持隐藏）。
   * 文本一旦变化（继续输入/删除）→ 联想恢复；同文本重绘不复活列表。
   * 避免 repaintTree 每次按 inputText 重新生成列表导致 Esc 失效。
   */
  cmdSuggestDismissedText: string | null;
  /** 工具调用审批卡片（安全护栏）：非空时内容流末尾渲染审批卡（y 批准 / n 拒绝 / 点击左右半区） */
  approval: TuiApproval | null;
  /** ask_user 提问面板（输入区上方；非空 = 等待用户选择） */
  ask: TuiAsk | null;
  /**
   * ask_user 面板的 resolver（TuiOutput 挂载；startTui 字母键 / interactive Enter
   * 自定义提交消费；resolve 后自动展示队列下一条）。null = 面板已关闭。
   */
  askResolve: ((r: AskResult | null) => void) | null;
  /**
   * ask 面板刚消费了一次 Esc（startTui ask 按键 handler 置位：Esc = 取消提问）。
   * interactive 的 Esc=取消运行分支读它跳过取消（取消提问 ≠ 取消对话），读后复位。
   * 与 approvalKeyJustConsumed 同模式（ask handler 先于 interactive 订阅执行）。
   */
  askKeyJustConsumed: boolean;
  /**
   * 审批卡片刚消费了一次 Esc（startTui 审批按键 handler 置位：Esc = 拒绝审批）。
   * interactive 的 Esc=取消运行分支读它跳过取消（拒绝审批 ≠ 取消对话），读后复位。
   * 审批 handler 先于 interactive 的 keypress 订阅执行（注册顺序），故能可靠传递。
   */
  approvalKeyJustConsumed: boolean;
  /**
   * Agent 正在运行（runAgent 执行中）。interactive 在每轮 runAgent 前后维护。
   * 运行中提交的消息进入待发送列表 pending（Enter=queue 追加末尾 / Cmd|Ctrl+Enter=steer 插最前）。
   */
  running: boolean;
  /**
   * 取消回调（interactive 注册：abort 当前流式响应；Esc 取消与运行中 Ctrl+Enter（steer）调用；
   * 运行结束后置 null）。放 state 上让命令层无需反向依赖 interactive 即可取消。
   */
  cancelRun: (() => void) | null;
  /**
   * 待发送消息（运行中提交，显示在输入框正上方小视图——与灰色块一起钉在视口底部）：
   * 顺序即发送顺序——steer（打断）消息在插入时放最前（unshift），queue 追加在末尾，
   * 回合结束后 interactive 按 shift() 消费（打断优先）。每条带 mode 徽标（· queue / ⚡ steer）；
   * 用户在消息进入对话前可用 ↑/↓ 选中、←/→ 排序、Backspace/Delete 删除、Enter 编辑。
   */
  pending: PendingMessage[];
  /** 待发送列表中高亮的消息下标（-1 = 无，输入框为焦点；点击/↑ 进入选择） */
  pendingSelected: number;
  /** 待发送消息 id 递增（编辑替换时保持稳定身份） */
  pendingSeq: number;
  /**
   * 本次提交的模式：keypress 检测 Enter（queue）/ Cmd|Ctrl|Option+Enter（steer）写入，
   * submit 回调消费后重置为 queue。运行中提交处理据此分流。
   */
  submitMode: 'queue' | 'steer';
  /**
   * 轨迹面板（/trace 展开右侧栏）：traceOpen = 面板可见；traceRows = 折叠投影
   * （interactive 每轮对话后 refreshTrace 刷新）；traceScroll = 面板内部滚动偏移
   * （0 = 最新在底部；↑/↓ 回看历史）；traceSelected = 列表页选中行下标
   * （-1 = 无；点击/Enter 推入详情页）；traceDetail = 详情页快照（非空 = 已推入
   * 详情页：标题 + 完整内容行——点击轨迹行进入，Esc/返回行回列表）。
   */
  traceOpen: boolean;
  traceRows: TraceRow[];
  traceScroll: number;
  traceSelected: number;
  /** 详情页（非空 = 面板显示详情页：返回行 + 行标题 + 完整内容；Esc/点返回回列表）：
   * rowIdx = 点击的 traceRows 行下标（内容渲染时实时取，快照语义由 traceDetailLines 保证） */
  traceDetail: { rowIdx: number } | null;
  /**
   * 审批结果回调（TuiOutput.requestApproval 注入；渲染层/按键层调用后由
   * TuiOutput 置 null）。放 state 上让 startTui（鼠标）与 interactive（按键）
   * 无需反向依赖 TuiOutput 即可完成审批。
   */
  approvalResolve: ((allow: boolean) => void) | null;
}

export function createTuiState(): TuiState {
  return {
    lines: [],
    status: '',
    model: '',
    provider: '',
    version: '',
    scrollTop: null,
    scrollIntent: null,
    shortcutPrefix: false,
    spinnerIndex: -1,
    bannerHue: 0,
    loading: false,
    loadingIndex: -1,
    generating: false,
    thinkingExpanded: true,
    thinkingShow: true,
    showTokens: true,
    expandedThinking: new Set(),
    collapsedThinking: new Set(),
    inputLines: 1,
    cwd: process.cwd(),
    models: [],

    activeVariant: null,    sessionTitle: null,
    restoreHint: null,
    tokens: { prompt: 0, completion: 0, total: 0 },
    stats: { turns: 0, steps: 0, llmMs: 0, toolsMs: 0, firstTokenSum: 0, firstTokenCount: 0, genMs: 0, cached: 0 },
    // 最近一次 LLM 请求的 prompt token（= 当前上下文大小，onUsage 每次覆盖）+
    // 当前模型 context 上限（config limit.context；interactive 按端点解析）
    lastPromptTokens: 0,
    contextLimit: 0,
    themeMode: 'system',
    detectedTheme: 'dark',
    menu: null,
    settingsPanel: null,
    statusline: ['speed', 'cache', 'tokens', 'context'],
    statuslineSave: null,
    language: 'zh',
    languageSave: null,
    modelSave: null,
    variantsSave: null,
    cmdPanel: null,
    cmdSuggest: null,
    mention: null,
    mentionDismissedKey: null,
    planMode: false,
    permission: 'safe',
    reasoningEffort: '',
    reasoningEffortOptions: ['low', 'medium', 'high', 'xhigh', 'max'],
    sessionPick: null,
    doctorPending: false,
    inputText: '',
    cmdSuggestDismissedText: null,
    approval: null,
    approvalKeyJustConsumed: false,
    approvalResolve: null,
    ask: null,
    askResolve: null,
    askKeyJustConsumed: false,
    running: false,
    cancelRun: null,
    pending: [],
    pendingSelected: -1,
    pendingSeq: 0,
    submitMode: 'queue',
    traceOpen: false,
    traceRows: [],
    traceScroll: 0,
    traceSelected: -1,
    traceDetail: null,
  };
}

/** 追加一个段落 */
export function pushLine(state: TuiState, line: TuiLine): void {
  state.lines.push(line);
}

/**
 * 打开命令面板（runCommand 分发前调用，设定标题；面板打开后命令输出用 pushCmdLine 追加）。
 * 覆盖已有面板（新一轮命令重置输出）。
 */
export function openCmdPanel(state: TuiState, title: string): void {
  state.cmdPanel = { title, lines: [], scroll: 0 };
}

/**
 * 追加一行到命令面板（不存在则创建，标题默认「命令」）。
 * 命令输出统一走这里——**不进对话流**（用户要求所有 command 独立窗口）。
 * 兼容传 TuiLine（只取 text；kind 颜色在面板里不区分，统一面板样式）。
 */
export function pushCmdLine(state: TuiState, line: TuiLine | string, title?: string): void {
  const text = typeof line === 'string' ? line : line.text;
  if (!state.cmdPanel) state.cmdPanel = { title: title ?? '命令', lines: [], scroll: 0 };
  state.cmdPanel.lines.push(text);
}

/** 若最后一段 kind 相同则追加文本，否则新起一段（用于流式内容累积） */
export function appendLine(state: TuiState, kind: TuiLineKind, text: string): void {
  const last = state.lines[state.lines.length - 1];
  if (last && last.kind === kind) {
    last.text += text;
  } else {
    state.lines.push({ kind, text });
  }
}

/** 清空全部内容行（/clear 命令） */
export function clearLines(state: TuiState): void {
  state.lines.length = 0;
  state.scrollTop = null;
  state.scrollIntent = null;
  state.expandedThinking.clear(); // 行下标失效，单独展开/收起标记一并清空
  state.collapsedThinking.clear();
}

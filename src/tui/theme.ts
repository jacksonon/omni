/**
 * TUI 主题：深色/亮色两套色板 + 主题解析（system/light/dark）。
 *
 * 从 render.ts 拆出（业务划分）：渲染编排（mount/repaint/事件）留在 render.ts，
 * 主题取色逻辑独立成层，mountTree/repaintTree/rows 共用。
 */
import { CODE_FG, DIFF_ADD_FG, DIFF_REM_FG, INLINE_CODE_FG, QUOTE_FG } from './markdown.js';
import type { TuiState } from './state.js';

/**
 * 主题色板：深色/亮色两套。深色基本维持原样（仅内容默认色从纯白微调为
 * `#e2e8f0`，与用户消息文字一致）；亮色模式下灰色块与用户消息改淡灰底 +
 * 深色文字，**内容区文字（AI 回答/思考/meta/工具卡片）也换深色**——此前内容行
 * 默认 fg 硬编码白色，浅色终端上白字看不见（用户报告）。OpenTUI 按终端背景亮度
 * 自动检测（OSC 10/11 查询），存于 state.themeMode，默认深色。
 */
export interface TuiTheme {
  /** 内容区背景（根 Box）：深色不设置（透终端底色），亮色白色——修复亮色模式界面整体仍是黑色 */
  background?: string;
  /** 输入框底色：与灰块同色融合（深色 #3f3f46 / 亮色 #e4e4e7，用户要求亮色下去掉白色背景） */
  inputBg: string;
  /** footer 灰色块 / 用户消息底色 */
  footerBg: string;
  /** 用户消息文字色 */
  userText: string;
  /** 蓝色细线 / 强调色 */
  accentBlue: string;
  /** footer 模型行文字色 */
  footerText: string;
  /** footer 路径/token 行文字色 */
  footerDim: string;
  /**
   * 模式前缀文字色（模型行左侧 Build/Plan）：
   * Build（默认执行模式）青色、Plan（/plan 计划模式）洋红粉——避开思考级别的
   * 绿/琥珀/橙/红/紫 专用色阶（否则 Build 绿与 low 绿、级别色相互混淆）。
   */
  modeBuild: string;
  modePlan: string;
  /**
   * 思考级别（reasoningEffort）文字色：**强度递进色阶**——low 绿 → medium 琥珀 →
   * high 橙 → xhigh 红 → max 紫（级别越高越“热”），未知/自定义级别回退 footerDim。
   * 深色主题用 400 档（深灰底上明亮清晰）、亮色主题用 600 档（浅底上对比足够）。
   */
  effortColors: Record<string, string>;
  /** 输入框文字色 */
  inputText: string;
  /** 输入框占位符色 */
  placeholder: string;
  /** 内容区默认文字色（AI 回答/meta/工具卡片正文等） */
  contentText: string;
  /** 内容区浅色文字（思考/meta/提示行：dark 走 dim 属性，light 显式深灰） */
  contentDim: string;
  /** 命令联想/提及浮层底色（独立下拉面板，与 footer 灰块区分） */
  suggestBg: string;
  /** 命令联想/提及浮层圆角边框色（面板整体有背景 + 圆角 12 风格） */
  suggestBorder: string;
  /** 命令联想/提及浮层普通项文字色（选中项用 suggestSelBg/suggestSelFg 整行高亮） */
  suggestText: string;
  /** 联想浮层选中行底色（整行桃色高亮，对标命令面板风格） */
  suggestSelBg: string;
  /** 联想浮层选中行文字色（桃底深字，保证可读） */
  suggestSelFg: string;
  /** 联想浮层分组头文字色（紫色分组名） */
  suggestGroup: string;
  /**
   * 工具卡片块底色（执行中/进行中）：**超淡黄**（amber-50，两主题统一）。
   * 结果到达后按状态换底色——成功 → 淡绿（cardOkBg）、失败 → 淡红（cardErrBg）；
   * 块为**完整长方形**（无圆角缺角），文字统一深色。
   */
  cardBg: string;
  /**
   * 工具卡片块上的文字色（执行/结果/输出/提示等 dim 角色 + 命令行）：
   * 黄底（超淡黄）上统一用深棕近黑，两主题一致——淡黄底上浅色字不可读。
   */
  cardDim: string;
  /** 工具执行成功卡片块底色：**淡绿**（green-100，两主题统一）——用户要求「执行成功使用淡绿色背景」 */
  cardOkBg: string;
  /** 成功卡片文字色：绿底上统一深绿（green-900）——淡绿底上浅色字不可读 */
  cardOkDim: string;
  /** 工具执行失败卡片块底色：**淡红**（red-100，两主题统一）——用户要求「执行异常显示淡红色背景」 */
  cardErrBg: string;
  /** 失败卡片文字色：红底上统一深红（red-900）——淡红底上浅色字不可读 */
  cardErrDim: string;
  /** diff 新增行文字色（write_file 统一 diff 新增行）：深绿（green-700，两主题统一，淡底上可读） */
  diffAdd: string;
  /** diff 删除行文字色（write_file 统一 diff 删除行）：深红（red-700，两主题统一，淡底上可读） */
  diffRem: string;
  /** diff 新增行背景色（淡绿，green-100/50——Claude Code Edit 风格行级底色） */
  diffAddBg: string;
  /** diff 删除行背景色（淡红，red-100/50） */
  diffRemBg: string;
  /** diff 上下文行背景色（未改动行：极淡灰，与卡片底色区分） */
  diffCtxBg: string;
  /**
   * 拖选高亮（字符级精选取中）文字色：选中的字符用背景色块 + 反白文字标出
   *（OpenTUI 无选区 API，omni 自绘）。深色 = 亮蓝底深字、亮色 = 深蓝底白字。
   */
  selBg: string;
  selFg: string;
}

const DARK_THEME: TuiTheme = {
  inputBg: '#3f3f46', // 深色：输入框与灰色块同色融合（现状）
  footerBg: '#3f3f46',
  userText: '#e2e8f0',
  accentBlue: '#3b82f6',
  footerText: '#d4d4d8',
  footerDim: '#9ca3af',
  modeBuild: '#22d3ee', // Build：青色（cyan-300）——避开思考级别色阶（原绿与 low 绿重合）
  modePlan: '#f472b6', // Plan：洋红粉（pink-400）——与 Build 青互异、避开思考级别色阶
  inputText: '#e2e8f0',
  placeholder: '#6b7280',
  contentText: '#e2e8f0',
  contentDim: '#9ca3af',
  suggestBg: '#27272a', // 比 footer 深一档（zinc-800），浮层从灰块中浮出
  suggestBorder: '#52525b', // zinc-600：圆角边框略亮于面板底，勾出圆角轮廓
  suggestText: '#e2e8f0',
  suggestSelBg: '#e8a87c', // 选中行桃色整行高亮（#E8A87C salmon）
  suggestSelFg: '#1c1917', // 桃底深字（stone-900）
  suggestGroup: '#b392f0', // 分组头紫色（命令面板风格）
  cardBg: '#3f3f46', // 工具卡片块底色（执行中）：**淡灰**（zinc-700）——用户要求「淡灰色背景，不要高对比的彩色」
  cardDim: '#e4e4e7', // 灰底上的文字：浅灰（zinc-200）——深底配浅字统一感
  cardOkBg: '#3f3f46', // 执行成功：**淡灰**（与执行中同色）——成功/执行中/失败统一灰底，靠状态色/标记区分
  cardOkDim: '#e4e4e7', // 灰底上的文字：浅灰（同 cardDim）
  cardErrBg: '#3f3f46', // 执行失败：**淡灰**（同上）——失败靠 ✗ 标记和 diff 红字传达，不靠底色
  cardErrDim: '#e4e4e7', // 灰底上的文字：浅灰（同 cardDim）
  diffAdd: '#4ade80', // diff 新增（green-400）——深灰底上浅绿字清晰
  diffRem: '#f87171', // diff 删除（red-400）——深灰底上浅红字清晰
  diffAddBg: '#14532d', // diff 新增行底：深绿（green-900）——灰块里再用深绿背景给"新增"行
  diffRemBg: '#7f1d1d', // diff 删除行底：深红（red-900）——深灰底上深红块
  diffCtxBg: '#52525b', // diff 上下文行底：略深灰（zinc-600）——比卡片底色稍亮一行做视觉分隔
  selBg: '#1e40af', // 拖选高亮底：深蓝（blue-800）——深底上亮蓝块清晰
  selFg: '#eff6ff', // 拖选高亮文字：淡蓝白（blue-50）——深蓝底上白字可读
  // 思考级别颜色（亮色主题，60 档）：绿→琥珀→橙→红→紫 强度递进
  effortColors: {
    low: '#4ade80', // green-400
    medium: '#fbbf24', // amber-400
    high: '#fb923c', // orange-400
    xhigh: '#f87171', // red-400
    max: '#c084fc', // purple-400
  },
};

const LIGHT_THEME: TuiTheme = {
  background: '#ffffff', // 内容区白色背景（修复亮色模式界面整体仍黑）
  inputBg: '#e4e4e7', // 与灰块同色（用户要求去掉输入框白色背景，与灰色块融为一体）
  footerBg: '#e4e4e7', // 淡灰（zinc-200）
  userText: '#27272a', // 深灰近黑（zinc-800）
  accentBlue: '#2563eb', // 稍深蓝，保证浅底对比度
  footerText: '#3f3f46', // zinc-700
  footerDim: '#71717a', // zinc-500
  modeBuild: '#0891b2', // Build：青色（cyan-600，浅底对比够）——避开思考级别色阶
  modePlan: '#db2777', // Plan：洋红粉（pink-600，浅底对比够）——避开思考级别色阶
  inputText: '#27272a',
  placeholder: '#9ca3af', // zinc-400
  contentText: '#27272a', // 内容区文字改深色（修复浅底白字）
  contentDim: '#52525b', // zinc-600：思考/meta/提示在浅底上仍清晰
  suggestBg: '#ffffff', // 亮色下浮层用白底，与淡灰 footer 区分
  suggestBorder: '#a1a1aa', // zinc-400：亮色下圆角边框用中灰
  suggestText: '#27272a',
  suggestSelBg: '#c2703d', // 亮色下选中行深桃色（浅底对比够）+ 白字
  suggestSelFg: '#ffffff',
  suggestGroup: '#7c3aed', // 分组头紫色（violet-600，浅底可读）
  cardBg: '#e4e4e7', // 工具卡片块底色：**淡灰**（zinc-200）——用户要求「淡灰色背景，不要高对比的彩色」
  cardDim: '#27272a', // 灰底上的文字：深灰（zinc-800）——浅底配深字统一感
  cardOkBg: '#e4e4e7', // 执行成功：**淡灰**（与执行中同色）——统一灰底，靠状态/标记区分
  cardOkDim: '#27272a', // 灰底上的文字：深灰（同 cardDim）
  cardErrBg: '#e4e4e7', // 执行失败：**淡灰**（同上）——失败靠 ✗ 标记和 diff 红字传达
  cardErrDim: '#27272a', // 灰底上的文字：深灰（同 cardDim）
  diffAdd: '#15803d', // diff 新增（green-700）——两主题统一
  diffRem: '#b91c1c', // diff 删除（red-700）——两主题统一
  diffAddBg: '#dcfce7', // diff 新增行底：淡绿（green-100）——两主题统一
  diffRemBg: '#fee2e2', // diff 删除行底：淡红（red-100）——两主题统一
  diffCtxBg: '#f4f4f5', // diff 上下文行底：极淡灰（zinc-100）——两主题统一
  selBg: '#bfdbfe', // 拖选高亮底：淡蓝（blue-200）——浅底上淡蓝块区分
  selFg: '#172554', // 拖选高亮文字：深蓝（blue-950）——淡蓝底上深字可读
  // 思考级别颜色（亮色主题，600 档）：绿→琥珀→橙→红→紫 强度递进（浅底上对比足够）
  effortColors: {
    low: '#16a34a', // green-600
    medium: '#d97706', // amber-600
    high: '#ea580c', // orange-600
    xhigh: '#dc2626', // red-600
    max: '#9333ea', // purple-600
  },
};

/** 判断主题是否为亮色（用于 dim 行显式取深色文字等分支） */
export function isLightTheme(theme: TuiTheme): boolean {
  return theme === LIGHT_THEME;
}

/**
 * 主题化颜色：亮色模式下把「浅底上不可读」的颜色映射为深色变体。
 * 深色模式原样返回（维持既有外观）。markdown 颜色常量直接引用
 * markdown.ts 的导出（CODE_FG/INLINE_CODE_FG/QUOTE_FG），常量变更时映射自动同步。
 */
const LIGHT_COLOR_MAP: Record<string, string> = {
  white: LIGHT_THEME.contentText, // 内容默认白 → 深灰
  cyan: '#0e7490', // 亮青在浅底看不清 → 深青
  yellow: '#a16207', // 亮黄 → 深琥珀
  [INLINE_CODE_FG]: '#a16207', // markdown 行内代码（琥珀）→ 深琥珀
  [CODE_FG]: '#475569', // markdown 代码块（浅蓝灰）→ 深蓝灰
  [DIFF_ADD_FG]: '#15803d', // markdown diff 围栏新增行 → 深绿（同浅色主题 diffAdd）
  [DIFF_REM_FG]: '#b91c1c', // markdown diff 围栏删除行 → 深红（同浅色主题 diffRem）
  [QUOTE_FG]: '#52525b', // markdown 引用（浅灰）→ 深灰
};

export function themeColor(color: string, theme: TuiTheme): string;
export function themeColor(color: string | undefined, theme: TuiTheme): string | undefined;
export function themeColor(color: string | undefined, theme: TuiTheme): string | undefined {
  if (!color) return color;
  if (isLightTheme(theme)) return LIGHT_COLOR_MAP[color] ?? color;
  return color;
}

/** 解析生效主题：system 跟随终端实测，light/dark 手动强制 */
export function themeFor(state: TuiState): TuiTheme {
  const mode = state.themeMode === 'system' ? state.detectedTheme : state.themeMode;
  return mode === 'light' ? LIGHT_THEME : DARK_THEME;
}

/**
 * 思考级别 → 文字色：命中 effortColors 用级别色，未知/自定义级别回退 footerDim。
 * 级别切换（/variants）或主题切换时 repaintTree 每帧重取，即时生效。
 */
export function effortColor(effort: string | undefined, theme: TuiTheme): string {
  if (!effort) return theme.footerDim;
  return theme.effortColors[effort] ?? theme.footerDim;
}

/** HSL → CSS hex（彩虹动画用）：h∈[0,360)、s/l∈[0,1]，返回 `#rrggbb` */
export function hslToHex(h: number, s: number, l: number): string {
  const f = (n: number): number => {
    const k = (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  const to = (v: number): string =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
}

/**
 * 模式前缀循环色（模型行 Build/Plan，对标 hero 横幅彩虹）：
 * bannerHue 驱动全色相循环，Plan 固定错相 180°——两模式永远可区分；
 * 亮度跟横幅同规则（亮色压暗/深色提亮，保证对比度）。
 */
export function modeCycleColor(bannerHue: number, planMode: boolean, light: boolean): string {
  const hue = (((planMode ? bannerHue + 180 : bannerHue) % 360) + 360) % 360;
  return hslToHex(hue, 0.85, light ? 0.42 : 0.64);
}

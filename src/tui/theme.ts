/**
 * TUI 主题：深色/亮色两套色板 + 主题解析（system/light/dark）。
 *
 * 从 render.ts 拆出（业务划分）：渲染编排（mount/repaint/事件）留在 render.ts，
 * 主题取色逻辑独立成层，mountTree/repaintTree/rows 共用。
 */
import { CODE_FG, INLINE_CODE_FG, QUOTE_FG } from './markdown.js';
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
  /** 命令联想/提及浮层普通项文字色（选中项用 accentBlue） */
  suggestText: string;
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
  /** diff 新增行文字色（write_file 左右对比右列 / 新增文件全文）：深绿（green-700，两主题统一，淡底上可读） */
  diffAdd: string;
  /** diff 删除行文字色（write_file 左右对比左列）：深红（red-700，两主题统一，淡底上可读） */
  diffRem: string;
}

const DARK_THEME: TuiTheme = {
  inputBg: '#3f3f46', // 深色：输入框与灰色块同色融合（现状）
  footerBg: '#3f3f46',
  userText: '#e2e8f0',
  accentBlue: '#3b82f6',
  footerText: '#d4d4d8',
  footerDim: '#9ca3af',
  inputText: '#e2e8f0',
  placeholder: '#6b7280',
  contentText: '#e2e8f0',
  contentDim: '#9ca3af',
  suggestBg: '#27272a', // 比 footer 深一档（zinc-800），浮层从灰块中浮出
  suggestBorder: '#52525b', // zinc-600：圆角边框略亮于面板底，勾出圆角轮廓
  suggestText: '#e2e8f0',
  cardBg: '#fefce8', // 工具卡片块底色（执行中）：**超淡黄**（amber-50）——用户要求「超淡黄色背景」，两主题统一
  cardDim: '#713f12', // 黄底上的文字：深棕（amber-900）——淡黄底上浅色字不可读，统一深色
  cardOkBg: '#dcfce7', // 执行成功：**淡绿**（green-100）——用户要求「执行成功使用淡绿色背景」，两主题统一
  cardOkDim: '#14532d', // 绿底上的文字：深绿（green-900）——淡绿底上浅色字不可读
  cardErrBg: '#fee2e2', // 执行失败：**淡红**（red-100）——用户要求「执行异常显示淡红色背景」，两主题统一
  cardErrDim: '#7f1d1d', // 红底上的文字：深红（red-900）——淡红底上浅色字不可读
  diffAdd: '#15803d', // diff 新增（green-700）：淡绿/淡黄/淡红底上都可读，两主题统一
  diffRem: '#b91c1c', // diff 删除（red-700）：淡绿/淡黄/淡红底上都可读，两主题统一
};

const LIGHT_THEME: TuiTheme = {
  background: '#ffffff', // 内容区白色背景（修复亮色模式界面整体仍黑）
  inputBg: '#e4e4e7', // 与灰块同色（用户要求去掉输入框白色背景，与灰色块融为一体）
  footerBg: '#e4e4e7', // 淡灰（zinc-200）
  userText: '#27272a', // 深灰近黑（zinc-800）
  accentBlue: '#2563eb', // 稍深蓝，保证浅底对比度
  footerText: '#3f3f46', // zinc-700
  footerDim: '#71717a', // zinc-500
  inputText: '#27272a',
  placeholder: '#9ca3af', // zinc-400
  contentText: '#27272a', // 内容区文字改深色（修复浅底白字）
  contentDim: '#52525b', // zinc-600：思考/meta/提示在浅底上仍清晰
  suggestBg: '#ffffff', // 亮色下浮层用白底，与淡灰 footer 区分
  suggestBorder: '#a1a1aa', // zinc-400：亮色下圆角边框用中灰
  suggestText: '#27272a',
  cardBg: '#fefce8', // 工具卡片块底色（执行中）：**超淡黄**（amber-50）——用户要求「超淡黄色背景」，两主题统一
  cardDim: '#713f12', // 黄底上的文字：深棕（amber-900）——与暗色一致
  cardOkBg: '#dcfce7', // 执行成功：**淡绿**（green-100）——两主题统一
  cardOkDim: '#14532d', // 绿底上的文字：深绿（green-900）——与暗色一致
  cardErrBg: '#fee2e2', // 执行失败：**淡红**（red-100）——两主题统一
  cardErrDim: '#7f1d1d', // 红底上的文字：深红（red-900）——与暗色一致
  diffAdd: '#15803d', // diff 新增（green-700）——两主题统一
  diffRem: '#b91c1c', // diff 删除（red-700）——两主题统一
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

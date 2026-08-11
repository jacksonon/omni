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
  /** 命令联想浮层底色（独立下拉面板，与 footer 灰块区分） */
  suggestBg: string;
  /** 命令联想浮层普通项文字色（选中项用 accentBlue） */
  suggestText: string;
  /** 工具卡片边框色：暗色下普通白色、亮色下灰色（用户要求无彩色边框） */
  cardBorder: string;
}

const DARK_THEME: TuiTheme = {
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
  suggestText: '#e2e8f0',
  cardBorder: '#e2e8f0', // 普通白色边框
};

const LIGHT_THEME: TuiTheme = {
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
  suggestText: '#27272a',
  cardBorder: '#71717a', // 亮色下灰色边框
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

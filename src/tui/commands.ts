/**
 * Commands（/ 命令）框架：斜杠命令注册表 + 命令面板交互。
 *
 * 交互模式输入 `/xxx` 提交时，interactive.ts 调 runCommand 按命令名分发。
 * 带面板的命令（如 /theme）会打开一个圆角方框选项面板（state.menu）：
 * ↑/↓ 或数字键选择、Enter 确认、Esc 取消；面板打开时键盘事件由
 * handleMenuKey 消费（interactive.ts 在全局 keypress 里先于输入框拦截）。
 */
import type { TextareaRenderable } from '@opentui/core';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { TuiOutput } from './output.js';
import type { TuiKey, TuiSession } from './render.js';
import { pushLine, type TuiState, type TuiThemeMode } from './state.js';

/** 命令执行上下文（interactive.ts 组装） */
export interface TuiCommandContext {
  state: TuiState;
  out: TuiOutput;
  session: TuiSession;
  input: TextareaRenderable;
  messages: ChatCompletionMessageParam[];
}

/** 命令执行结果：'exit' 表示退出交互循环（interactive.ts 据此 break） */
export type TuiCommandResult = 'exit' | void;

export interface TuiCommand {
  name: string;
  description: string;
  /** 额外别名（如 /quit） */
  aliases?: string[];
  run(ctx: TuiCommandContext): TuiCommandResult | Promise<TuiCommandResult>;
}

/**
 * 执行斜杠命令：解析命令名 → 注册表分发；未找到时提示（不打断对话）。
 * 返回 'exit' 表示应退出交互循环。
 */
export async function runCommand(ctx: TuiCommandContext, raw: string): Promise<TuiCommandResult> {
  const name = raw.slice(1).trim().split(/\s+/)[0] ?? '';
  const cmd = findCommand(name);
  if (!cmd) {
    pushLine(ctx.state, { kind: 'warn', text: `未知命令 /${name}（/help 查看可用命令）` });
    return;
  }
  return cmd.run(ctx);
}

/** 命令注册表：新增命令在这里登记（interactive.ts 按此分发） */
export const TUI_COMMANDS: TuiCommand[] = [
  {
    name: 'theme',
    description: '切换主题（亮色 / 深色 / 跟随系统）',
    run: (ctx) => openThemeMenu(ctx.state),
  },
  {
    name: 'thinking',
    description: '展开 / 折叠全部思考过程',
    run: (ctx) => {
      // 全局开关：buildBody 渲染时读取——展开=每个思考段落完整显示（默认），
      // 折叠=每个段落压成一行 `+ thinking`（+ 表示可点击展开；无行数/提示文案）。
      // 会话级，/clear 不清除；切换时清空单独展开标记（避免折叠态残留单条展开）。
      // 不推 meta 提示文字（用户要求：已折叠/已展开这类提示不要出现在对话流）。
      ctx.state.thinkingExpanded = !ctx.state.thinkingExpanded;
      ctx.state.expandedThinking.clear();
    },
  },
  {
    name: 'exit',
    aliases: ['quit'],
    description: '退出 TUI',
    run: () => 'exit', // 返回信号：interactive.ts break 循环，tui-entry 的 finally 统一 stop 会话
  },
  {
    name: 'clear',
    description: '清空对话上下文',
    run: (ctx) => {
      ctx.messages.length = 0;
      ctx.out.clearScrollback();
    },
  },
  {
    name: 'help',
    description: '显示帮助',
    run: (ctx) => ctx.out.showHelp(),
  },
];

/** 按名称（含别名）查找命令，未找到返回 undefined */
export function findCommand(name: string): TuiCommand | undefined {
  const n = name.toLowerCase();
  return TUI_COMMANDS.find((c) => c.name === n || c.aliases?.includes(n));
}

/**
 * 命令联想（输入框以 / 开头时）：按 / 后面的前缀过滤注册表（名字与别名都匹配）。
 * 空查询返回全部命令；无匹配返回空数组（联想列表自动隐藏）。
 *
 * 刻意不 trim：Tab 填入的命令带尾空格（`/theme `）→ 查询 `theme ` 不再前缀匹配
 * → 联想自动隐藏（用户可直接 Enter 执行；继续输入则按新文本重新联想）。
 */
export function commandSuggestions(query: string): TuiCommand[] {
  const q = query.toLowerCase();
  if (!q) return TUI_COMMANDS;
  return TUI_COMMANDS.filter(
    (c) => c.name.startsWith(q) || c.aliases?.some((a) => a.startsWith(q))
  );
}

/** 主题选项（/theme 面板） */
const THEME_OPTIONS: { label: string; value: TuiThemeMode }[] = [
  { label: '跟随系统', value: 'system' },
  { label: '亮色', value: 'light' },
  { label: '深色', value: 'dark' },
];

/** 打开主题面板：高亮当前生效项，供 ↑/↓/数字 + Enter/Esc 操作 */
export function openThemeMenu(state: TuiState): void {
  // 面板是绝对定位浮层（menuOverlay），不依赖内容滚动位置，无需调整 scrollTop
  const current = state.themeMode;
  const idx = Math.max(
    0,
    THEME_OPTIONS.findIndex((o) => o.value === current)
  );
  state.menu = {
    id: 'theme',
    title: '主题',
    options: THEME_OPTIONS,
    selectedIndex: idx,
    currentValue: current,
  };
  state.status = '主题：↑/↓ 或数字选择 · Enter 确认 · Esc 取消';
}

/**
 * 处理面板键盘输入（interactive.ts 在全局 keypress 里调用；返回是否消费了按键）。
 * ↑/↓/数字：移动选择；Enter：确认；Esc：取消。
 */
export function handleMenuKey(key: TuiKey, state: TuiState): boolean {
  const menu = state.menu;
  if (!menu) return false;
  switch (key.name) {
    case 'up':
      menu.selectedIndex = (menu.selectedIndex - 1 + menu.options.length) % menu.options.length;
      return true;
    case 'down':
      menu.selectedIndex = (menu.selectedIndex + 1) % menu.options.length;
      return true;
    case 'return':
    case 'kpenter':
    case 'linefeed':
      confirmMenu(state);
      return true;
    case 'escape':
    case 'esc':
      closeMenu(state);
      return true;
    default: {
      // 数字键 1..9 直接选中
      const n = Number(key.name);
      if (Number.isInteger(n) && n >= 1 && n <= menu.options.length) {
        menu.selectedIndex = n - 1;
        confirmMenu(state);
        return true;
      }
      return false;
    }
  }
}

/** 确认当前选项：按面板 id 分发处理（theme → 切换 themeMode），然后关闭面板 */
function confirmMenu(state: TuiState): void {
  const menu = state.menu;
  if (!menu) return;
  const opt = menu.options[menu.selectedIndex];
  const label = opt.label;
  if (menu.id === 'theme') {
    state.themeMode = opt.value as TuiThemeMode;
    pushLine(state, { kind: 'meta', text: `已切换主题 → ${label}` });
  }
  state.menu = null;
  state.status = '';
}

/** 取消面板：原样关闭（导出供测试/其它调用方复用） */
export function closeMenu(state: TuiState): void {
  state.menu = null;
  state.status = '';
}

/**
 * Commands（/ 命令）框架：斜杠命令注册表 + 命令面板交互。
 *
 * 交互模式输入 `/xxx` 提交时，interactive.ts 调 runCommand 按命令名分发。
 * 带面板的命令（如 /theme）会打开一个圆角方框选项面板（state.menu）：
 * ↑/↓ 或数字键选择、Enter 确认、Esc 取消；面板打开时键盘事件由
 * handleMenuKey 消费（interactive.ts 在全局 keypress 里先于输入框拦截）。
 */
import type { TextareaRenderable } from '@opentui/core';
import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import {
  generateAgentsFile,
  generateGlobalAgentsFile,
  findProjectRoot,
  writeAgentsFile,
  writeGlobalAgentsFile,
} from '../agent/init.js';
import type { TuiOutput } from './output.js';
import type { TuiKey, TuiSession } from './render.js';
import type { PermissionTier } from '../safety/policy.js';
import { applyUndo, type UndoStack } from '../tools/undo.js';
import { pushLine, type TuiState, type TuiThemeMode } from './state.js';

/** 命令执行上下文（interactive.ts 组装） */
export interface TuiCommandContext {
  state: TuiState;
  out: TuiOutput;
  session: TuiSession;
  input: TextareaRenderable;
  messages: ChatCompletionMessageParam[];
  /** 需要 LLM 的命令（/init）使用；由 interactive.ts 传入 */
  client?: OpenAI;
  model?: string;
  /** 命令名后的参数（如 `/init --global` 的 `--global`） */
  args?: string;
  /** /undo 撤销栈（attachRuntime 创建，写入工具已包装快照；interactive 从 runOpts 传入） */
  undoStack?: UndoStack;
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
  const parts = raw.slice(1).trim().split(/\s+/);
  const name = parts[0] ?? '';
  const cmd = findCommand(name);
  if (!cmd) {
    pushLine(ctx.state, { kind: 'warn', text: `未知命令 /${name}（/help 查看可用命令）` });
    return;
  }
  // 传入命令名后的参数（如 /init --global 的 --global），供命令实现读取
  return cmd.run({ ...ctx, args: parts.slice(1).join(' ') });
}

/** 命令注册表：新增命令在这里登记（interactive.ts 按此分发） */
export const TUI_COMMANDS: TuiCommand[] = [
  {
    name: 'theme',
    description: '切换主题（亮色 / 深色 / 跟随系统）',
    run: (ctx) => openThemeMenu(ctx.state),
  },
  {
    name: 'permission',
    description: '切换安全权限（低=只读 / 中=标准 / 高=谨慎 / 全量=直通）',
    run: (ctx) => openPermissionMenu(ctx.state),
  },
  {
    name: 'plan',
    description: '切换计划模式（只读调研，不修改文件）',
    run: (ctx) => {
      // 会话级开关：只对模型暴露只读工具（read_file/list_directory/search_code）+ 系统提示
      // 追加只读说明（loop 读 runOpts.planMode；interactive 每轮从 state 同步）。
      // footer 模型行显示「模型 X · 计划模式」作为常驻指示；不推 meta 提示文字。
      ctx.state.planMode = !ctx.state.planMode;
    },
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
    name: 'undo',
    description: '撤销本次会话的 write_file 修改（all = 全部撤销）',
    run: async (ctx) => {
      // /undo：pop 最近一次写操作快照并恢复文件（新建文件则删除）；
      // /undo all：逆序恢复全部快照，回到会话开始前的文件状态。
      // 撤销后向 messages 注入 system 提示——模型不再基于已回滚的旧内容继续操作。
      const stack = ctx.undoStack;
      if (!stack || stack.size === 0) {
        pushLine(ctx.state, { kind: 'warn', text: '没有可撤销的写操作（本次会话尚未修改文件）' });
        return;
      }
      const all = /(?:^|\s)all(?=\s|$)/.test(ctx.args ?? '');
      if (all) {
        const entries = stack.popAll();
        const results: string[] = [];
        for (const e of entries) {
          results.push(await applyUndo(e).catch(() => `撤销失败：${e.path}`));
        }
        pushLine(ctx.state, { kind: 'meta', text: `已撤销全部 ${results.length} 个写操作` });
        for (const r of results) pushLine(ctx.state, { kind: 'meta', text: `· ${r}` });
        ctx.messages.push({ role: 'system', content: `[已执行 /undo all] 本次会话 ${results.length} 个文件修改已全部回滚，请勿再基于旧结果操作。` });
        return;
      }
      const entry = stack.pop();
      if (!entry) return;
      const msg = await applyUndo(entry).catch(() => `撤销失败：${entry.path}`);
      const left = stack.size;
      pushLine(ctx.state, { kind: 'meta', text: left > 0 ? `${msg}（还有 ${left} 个可撤销，/undo all 全部撤销）` : `${msg}（无更多可撤销）` });
      ctx.messages.push({ role: 'system', content: `[已执行 /undo] ${msg}。该文件的写操作已回滚，请勿再基于旧内容操作。` });
    },
  },
  {
    name: 'init',
    description: '扫描项目并生成 AGENTS.md 项目记忆文件（--global 生成全局记忆）',
    run: async (ctx) => {
      // /init：定位项目根 → 扫描结构 → LLM 生成 AGENTS.md → 写入（已存在不覆盖）
      // /init --global：生成 ~/.config/omni/AGENTS.md（跨项目用户偏好）
      const { client, model } = ctx;
      if (!client || !model) {
        pushLine(ctx.state, { kind: 'warn', text: '/init 需要 LLM 客户端（当前环境不可用）' });
        return;
      }
      const isGlobal = /(?:^|\s)--global(?=\s|$)/.test(ctx.args ?? '');
      if (isGlobal) {
        pushLine(ctx.state, { kind: 'meta', text: '正在扫描用户环境并生成全局记忆 AGENTS.md…' });
        await ctx.session.paint().catch(() => {});
        const content = await generateGlobalAgentsFile(client, model);
        if (!content) {
          pushLine(ctx.state, { kind: 'warn', text: '全局记忆生成失败（网络 / API 问题），请重试' });
          return;
        }
        const res = await writeGlobalAgentsFile(content);
        if (!res.ok) {
          pushLine(ctx.state, {
            kind: 'warn',
            text: `已存在 ${res.path}，/init --global 不覆盖（如需重新生成请先删除或重命名）`,
          });
          return;
        }
        pushLine(ctx.state, { kind: 'meta', text: `已生成全局记忆 ${res.path}（所有项目会话自动加载）` });
        return;
      }
      const root = findProjectRoot(process.cwd());
      pushLine(ctx.state, { kind: 'meta', text: `正在扫描项目并生成 AGENTS.md（项目根：${root}）…` });
      // 先刷一帧：progress 行在 LLM 调用（可能 10s+）期间可见，否则用户面对冻结 UI
      await ctx.session.paint().catch(() => {});
      const content = await generateAgentsFile(client, model, root);
      if (!content) {
        pushLine(ctx.state, { kind: 'warn', text: 'AGENTS.md 生成失败（网络 / API 问题），请重试' });
        return;
      }
      const res = await writeAgentsFile(root, content);
      if (!res.ok) {
        pushLine(ctx.state, {
          kind: 'warn',
          text: `已存在 ${res.path}，/init 不覆盖（如需重新生成请先删除或重命名）`,
        });
        return;
      }
      pushLine(ctx.state, { kind: 'meta', text: `已生成 ${res.path}（下次会话自动加载为项目记忆）` });
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

/** 权限选项（/permission 面板）：低=read 只读 / 中=safe 标准（危险命令询问，默认）/ 高=ask 谨慎（全部询问）/ 全量=full 直通 */
export const PERMISSION_OPTIONS: { label: string; value: PermissionTier }[] = [
  { label: '低（只读）', value: 'read' },
  { label: '中（标准）', value: 'safe' },
  { label: '高（谨慎）', value: 'ask' },
  { label: '全量（直通）', value: 'full' },
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

/** 打开权限面板：高亮当前档位，供 ↑/↓/数字 + Enter/Esc 操作 */
export function openPermissionMenu(state: TuiState): void {
  const current = state.permission;
  const idx = Math.max(0, PERMISSION_OPTIONS.findIndex((o) => o.value === current));
  state.menu = {
    id: 'permission',
    title: '安全权限',
    options: PERMISSION_OPTIONS,
    selectedIndex: idx,
    currentValue: current,
  };
  state.status = '安全权限：↑/↓ 或数字选择 · Enter 确认 · Esc 取消';
}

/** 确认当前选项：按面板 id 分发处理（theme → 切换 themeMode；permission → 切换权限档位），然后关闭面板 */
function confirmMenu(state: TuiState): void {
  const menu = state.menu;
  if (!menu) return;
  const opt = menu.options[menu.selectedIndex];
  const label = opt.label;
  if (menu.id === 'theme') {
    state.themeMode = opt.value as TuiThemeMode;
    pushLine(state, { kind: 'meta', text: `已切换主题 → ${label}` });
  } else if (menu.id === 'permission') {
    // 切换权限档位：interactive 每轮把 state.permission 同步进 runOpts.permission
    // 并 setTier 到共用闸门（子代理同步）；meta 提示当前档位语义
    state.permission = opt.value as PermissionTier;
    pushLine(state, { kind: 'meta', text: `已切换安全权限 → ${label}` });
  }
  state.menu = null;
  state.status = '';
}

/** 取消面板：原样关闭（导出供测试/其它调用方复用） */
export function closeMenu(state: TuiState): void {
  state.menu = null;
  state.status = '';
}

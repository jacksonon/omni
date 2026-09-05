/**
 * TUI 快捷键（Ctrl+X 前缀，opencode 风格）：
 * 按 Ctrl+X 进入快捷菜单（状态栏显示绑定键提示），再按绑定键触发对应 / 命令；
 * Esc 取消前缀；未绑定键取消前缀并放行给输入框（继续编辑即返回）。
 *
 * 复用 / 命令注册表（runCommand 统一分发）——/settings theme、/permission、
 * /model、/variants、/plan、/thinking、/undo、/redo、/clear、/settings help 全部走
 * 同一套命令逻辑（面板打开 / 静默切换 / 输出到命令面板），与手输命令完全等价，
 * 新增命令无需改这里（想绑新键只需加一行）。
 */
import type { TuiKey } from './render.js';

/** 绑定键 → 斜杠命令 */
export const TUI_SHORTCUTS: Record<string, string> = {
  t: '/settings theme', // 主题面板（/theme 已并入 /settings theme）
  p: '/permission', // 安全权限面板
  m: '/model', // 模型面板
  v: '/variants', // 思考级别面板
  s: '/settings', // 设置菜单
  l: '/plan', // 计划模式（静默切换）
  h: '/thinking', // 思考展示开关（静默切换）
  u: '/undo', // 撤销文件修改
  r: '/redo', // 重做
  c: '/clear', // 清空上下文
  '?': '/settings help', // 帮助（已移入 settings）
};

/**
 * 前缀激活时匹配按键：
 *   · 命中绑定 → 返回要触发的命令（调用方执行 runCommand）
 *   · Esc → 返回 null（取消前缀，不传给输入框）
 *   · 未绑定键 → 返回 undefined（取消前缀，按键放行给输入框继续处理）
 */
export function matchShortcutKey(key: TuiKey): string | null | undefined {
  if (key.name === 'escape' || key.name === 'esc') return null;
  return TUI_SHORTCUTS[key.name] ?? undefined;
}

/**
 * 安全策略：权限分级 + 危险命令检测。
 *
 * 从 tools/run-command.ts 迁出（业务划分）：危险命令清单不再埋在工具实现里，
 * 而是作为安全层的一部分——所有工具（含 MCP 外部工具 / 子代理）统一过闸。
 *
 * 权限分级（permission 配置）：
 *   · full —— 一切直接执行（含危险命令，用户选择全量信任即不设防）
 *   · safe —— 危险命令**询问用户**（默认；交给用户决定），其余直接执行
 *   · ask  —— 所有工具调用都询问
 *   · read —— 只读模式：run_command / write_file 直接拒绝（不给询问机会）
 */
export type PermissionTier = 'full' | 'safe' | 'ask' | 'read';

/** 危险命令清单：命中即拦（full 直通 / safe 以上转审批）。正则保守，避免误伤 */ 
const DANGEROUS_COMMANDS: { re: RegExp; msg: string }[] = [
  { re: /(\s|^)rm\s+-[a-z]*r[a-z]*f\s+\//, msg: '对根目录执行 rm -rf' },
  { re: /(\s|^)mkfs/, msg: '格式化磁盘（mkfs）' },
  { re: /(\s|^)dd\s+if=/, msg: 'dd 写盘' },
  { re: /(\s|^)(shutdown|reboot|halt)\b/, msg: '关机/重启命令' },
  { re: /:\(\)\s*\{/, msg: '检测到 fork bomb' },
  { re: /(\s|^)git\s+push\b/, msg: 'git push（不可逆的远程推送）' },
];

/** 检测命令是否危险：返回原因（安全则为 null） */
export function dangerousCommand(command: string): string | null {
  for (const { re, msg } of DANGEROUS_COMMANDS) {
    if (re.test(command)) return msg;
  }
  return null;
}

/** 有写副作用的工具（read 模式下拒绝） */
const WRITE_TOOLS = new Set(['write_file', 'run_command']);

/**
 * 工具调用过闸结果：
 *   · allow —— 直接放行
 *   · deny —— 直接拒绝（读模式），reason 说明原因
 *   · needApproval —— 需要用户确认，reason 说明为什么
 */
export type GateResult =
  | { allow: true }
  | { allow: false; reason: string }
  | { needApproval: true; reason: string };

/** 按权限分级判定某次工具调用：放行 / 拒绝 / 需审批 */
export function gateTool(tier: PermissionTier, toolName: string, args: Record<string, unknown>): GateResult {
  // read：写/执行类工具直接拒绝（连询问都不给——纯读模式）
  if (tier === 'read') {
    if (WRITE_TOOLS.has(toolName)) {
      return { allow: false, reason: '当前权限为只读（read），不允许执行该工具' };
    }
    return { allow: true };
  }
  // run_command：危险命令检测（full 直通任意命令 / safe 及以上转审批）
  if (toolName === 'run_command' && tier !== 'full') {
    const danger = dangerousCommand(String(args.command ?? ''));
    if (danger) return { needApproval: true, reason: danger };
  }
  // ask：所有工具调用都需要确认
  if (tier === 'ask') return { needApproval: true, reason: 'ask 模式：所有工具调用需用户确认' };
  return { allow: true };
}

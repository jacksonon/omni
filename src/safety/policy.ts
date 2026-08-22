/**
 * 安全策略：权限分级 + 危险命令检测 + per-tool 审批模式。
 *
 * 从 tools/run-command.ts 迁出（业务划分）：危险命令清单不再埋在工具实现里，
 * 而是作为安全层的一部分——所有工具（含 MCP 外部工具 / 子代理）统一过闸。
 *
 * 权限分级（permission 配置）：
 *   · full —— 一切直接执行（含危险命令，用户选择全量信任即不设防）
 *   · safe —— 危险命令**询问用户**（默认；交给用户决定），其余直接执行
 *   · ask  —— 所有工具调用都询问
 *   · read —— 只读模式：run_command / write_file 直接拒绝（不给询问机会）
 *
 * per-tool 审批模式（Tool.approvalMode，MCP server 级 defaultToolsApprovalMode 烘焙）：
 *   · auto    —— 跟随全局 permission 档位（缺省）
 *   · prompt  —— 该工具总是询问用户
 *   · writes  —— 只读工具放行、写工具询问（MCP 工具无法证明只读 → 视为写，询问）
 *   · approve —— 该工具直接放行（不询问；read 档位下的写工具仍被硬拒——read 是硬约束）
 */
import type { Tool, ToolApprovalMode } from '../tools/types.js';

export type PermissionTier = 'full' | 'safe' | 'ask' | 'read';
export type { ToolApprovalMode } from '../tools/types.js';

/** 危险命令清单：命中即拦（full 直通 / safe 以上转审批）。正则保守，避免误伤 */ 
const DANGEROUS_COMMANDS: { re: RegExp; msg: string }[] = [
  { re: /(\s|^)rm\s+-[a-z]*r[a-z]*f\s+\//, msg: '对根目录执行 rm -rf' },
  { re: /(\s|^)mkfs/, msg: '格式化磁盘（mkfs）' },
  { re: /(\s|^)dd\s+if=/, msg: 'dd 写盘' },
  { re: /(\s|^)(shutdown|reboot|halt)\b/, msg: '关机/重启命令' },
  { re: /:\(\)\s*\{/, msg: '检测到 fork bomb' },
  { re: /(\s|^)git\s+push\b/, msg: 'git push（不可逆的远程推送）' },
  { re: /(\s|^)git\s+reset\s+--hard\b/, msg: 'git reset --hard（丢弃本地改动）' },
  { re: /(\s|^)git\s+clean\s+-[a-z]*f[a-z]*\b/, msg: 'git clean -f（删除未跟踪文件）' },
  { re: /(\s|^)chmod\s+-R\s+777\b/, msg: 'chmod -R 777（权限全开）' },
  { re: /(\s|^)curl\s+.*\|\s*(sudo\s+)?(ba)?sh\b/, msg: '管道执行远程脚本' },
  { re: /(\s|^)sudo\s+(rm|mkfs|dd|shutdown|reboot|halt)\b/, msg: 'sudo 危险操作' },
];

/** 检测命令是否危险：返回原因（安全则为 null）。
 *  extraPatterns —— 用户/项目级扩展正则（config `dangerousPatterns`），
 *  匹配返回「扩展拦截：<正则原文>」。 */
export function dangerousCommand(command: string, extraPatterns?: string[]): string | null {
  for (const { re, msg } of DANGEROUS_COMMANDS) {
    if (re.test(command)) return msg;
  }
  for (const raw of extraPatterns ?? []) {
    try {
      if (new RegExp(raw).test(command)) return `扩展危险规则命中：${raw}`;
    } catch {
      // 非法正则：忽略（config 层已过滤大部分；这里兜底）
    }
  }
  return null;
}

/** 静态写工具（read 档位拒绝 / writes 审批判定） */
const WRITE_TOOLS = new Set(['write_file', 'run_command']);

/** 某工具是否写操作：静态写工具（write_file/run_command）、或 MCP 工具（带 approvalMode 字段，
 *  无法证明只读 → 视为写，readOnly===true 除外）。静态只读工具（read_file 等）不视为写。 */
export function isWriteOperation(tool: Tool): boolean {
  if (WRITE_TOOLS.has(tool.name)) return true;
  if (tool.readOnly === true) return false;
  // MCP 工具烘焙了 approvalMode（即使 'auto'）；静态非写工具没有该字段 → 只读
  return tool.approvalMode !== undefined;
}

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

/** per-tool 审批模式在全局档位判定基础上的覆盖（纯函数；mode 缺省/auto = 原样） */
export function applyApprovalMode(
  mode: ToolApprovalMode | undefined,
  g: GateResult,
  tool: Tool
): GateResult {
  if (!mode || mode === 'auto') return g;
  if (mode === 'approve') {
    // 直接放行（但 deny 保留——read 档位硬拒绝是硬约束，approve 不能绕过）
    if ('allow' in g && !g.allow) return g;
    return { allow: true };
  }
  if (mode === 'prompt') {
    // 总是询问（deny 保留）
    if ('allow' in g && !g.allow) return g;
    return { needApproval: true, reason: `${tool.name} 配置为总是询问（prompt 审批模式）` };
  }
  // writes：只读放行、写询问（MCP 工具无法证明只读 → 视为写）
  if (mode === 'writes') {
    if (!isWriteOperation(tool)) return g;
    if ('allow' in g && !g.allow) return g;
    return { needApproval: true, reason: `${tool.name} 是写操作（writes 审批模式）` };
  }
  return g;
}

/** 按权限分级 + per-tool 审批模式判定某次工具调用：放行 / 拒绝 / 需审批。
 *  extraPatterns —— 用户/项目级危险命令扩展正则（config dangerousPatterns）。 */
export function gateTool(
  tier: PermissionTier,
  tool: Tool,
  args: Record<string, unknown>,
  extraPatterns?: string[]
): GateResult {
  const name = tool.name;
  let g: GateResult;
  // read：写/执行类工具直接拒绝（连询问都不给——纯读模式）
  if (tier === 'read') {
    if (isWriteOperation(tool)) {
      g = { allow: false, reason: '当前权限为只读（read），不允许执行该工具' };
    } else {
      g = { allow: true };
    }
    // 只读工具在 read 档位放行；per-tool approve 不覆盖 read 硬拒绝
    return applyApprovalMode(tool.approvalMode, g, tool);
  }
  // run_command：危险命令检测（full 直通任意命令 / safe 及以上转审批）——
  // 只拦截危险命令，不 return（普通命令继续落到下方 ask 检查）
  if (name === 'run_command' && tier !== 'full') {
    const danger = dangerousCommand(String(args.command ?? ''), extraPatterns);
    if (danger) {
      return applyApprovalMode(tool.approvalMode, { needApproval: true, reason: danger }, tool);
    }
  }
  // ask：所有工具调用都需要确认
  if (tier === 'ask') {
    g = { needApproval: true, reason: 'ask 模式：所有工具调用需用户确认' };
  } else {
    g = { allow: true };
  }
  return applyApprovalMode(tool.approvalMode, g, tool);
}

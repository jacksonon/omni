/**
 * 安全护栏（safety/）：工具调用的统一闸门。
 *
 * 职责划分：
 *   · policy.ts —— 纯判定（权限分级 + 危险命令检测），无副作用
 *   · audit.ts  —— 审计日志落盘
 *   · index.ts  —— Safety 门卫：把 policy 判定 + 用户审批回调 + 审计组合成一次调用
 *
 * Agent 主循环（loop.ts）与子代理（subagent.ts）共用同一个 Safety 实例——
 * 子代理的工具调用与主代理同权限、同审批、同审计。
 */
import type { Tool } from '../tools/types.js';
import { writeAudit } from './audit.js';
import { gateTool, type PermissionTier } from './policy.js';

export type { PermissionTier } from './policy.js';

/** 审批请求（Output 层实现 UI：console readline / TUI 审批卡片） */
export interface ApprovalRequest {
  tool: string;
  /** 人类可读摘要（如 `$ rm -rf /`） */
  summary: string;
  /** 需要审批的原因 */
  reason: string;
}

export interface SafetyOptions {
  /** 权限分级（default full = 直通，兼容无配置调用） */
  tier: PermissionTier;
  /** 是否写审计日志 */
  audit: boolean;
  /** 审批回调（返回 true = 允许执行；缺省 = 拒绝，fail-safe） */
  requestApproval?: (req: ApprovalRequest) => Promise<boolean> | boolean;
  /** 参数人类可读摘要（传 formatToolCall 复用；缺省用工具名） */
  summarize?: (tool: string, args: Record<string, unknown>) => string;
}

export class Safety {
  constructor(private opts: SafetyOptions) {}

  /**
   * 工具调用过闸：判定 → （需要时）审批 → 审计。返回 { allow, reason? }。
   * 拒绝时 reason 说明原因（由 loop 作为工具结果回传模型，触发自我纠错）。
   */
  async gate(tool: Tool, args: Record<string, unknown>): Promise<{ allow: boolean; reason?: string }> {
    const summary = this.opts.summarize?.(tool.name, args) ?? tool.name;
    const g = gateTool(this.opts.tier, tool.name, args);
    // 联合类型收窄：GateResult = {allow:true} | {allow:false;reason} | {needApproval:true;reason}
    if ('allow' in g && g.allow) {
      this.record(tool.name, summary, 'allow');
      return { allow: true };
    }
    if ('allow' in g) {
      // 直接拒绝（读模式 / full 级危险命令硬拦截）
      this.record(tool.name, summary, `deny:${g.reason}`);
      return { allow: false, reason: g.reason };
    }
    // 需要审批：交给 Output 层的回调（console readline / TUI 审批卡片）
    const ok = await this.requestApproval({ tool: tool.name, summary, reason: g.reason });
    this.record(tool.name, summary, ok ? 'approved' : 'rejected');
    return ok ? { allow: true } : { allow: false, reason: '用户拒绝了该操作' };
  }

  private async requestApproval(req: ApprovalRequest): Promise<boolean> {
    try {
      return await (this.opts.requestApproval ?? (() => false))(req);
    } catch {
      return false; // 审批流程异常 → fail-safe 拒绝
    }
  }

  private record(tool: string, summary: string, decision: string): void {
    if (!this.opts.audit) return;
    void writeAudit({ tool, summary, decision }); // fire-and-forget
  }
}

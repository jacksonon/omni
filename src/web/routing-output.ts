/**
 * omni web 本地后端的 Output 路由对象（从 server.ts 抽出）。
 *
 * attachRuntime 只需 output 的 审批 / 提问 / hook 输出 / 子代理事件 四个通道。
 * 由于我们**全局单运行**，路由对象把调用转发给「当前运行会话」的 WebOutput
 * （currentOutput 在每次运行开始时设置、结束后清空）——并发安全且有单一语义。
 */
import type { ApprovalRequest } from '../safety/index.js';
import { type WebOutput } from './output.js';
import { emitEvent } from './state.js';

let currentOutput: WebOutput | null = null;

/** 设置/清空当前运行会话的 WebOutput（运行开始/结束时由 server.ts 调用） */
export function setCurrentOutput(o: WebOutput | null): void {
  currentOutput = o;
}

export function getCurrentOutput(): WebOutput | null {
  return currentOutput;
}

/** attachRuntime 输入的 Output 路由对象（导出供 web/index.ts 透传） */
export const routingOutput = {
  requestApproval: (req: ApprovalRequest) =>
    currentOutput ? currentOutput.requestApproval(req) : Promise.resolve(false),
  askUser: (q: string, opts: string[], multi?: boolean) =>
    currentOutput ? currentOutput.askUser(q, opts, multi ?? false) : Promise.resolve(null),
  onHookOutput: (event: string, lines: string[]) => {
    emitEvent('hook.output', { sessionId: null, event, lines: lines.slice(0, 5) });
  },
  onSubagentEvent: (ev: unknown) => {
    const sid = currentOutput?.sessionId ?? null;
    emitEvent('subagent', { sessionId: sid, ev });
  },
  onAutoReview: (req: ApprovalRequest, verdict: { approve: boolean; reason: string }) =>
    currentOutput?.onAutoReview?.(req, verdict),
  onBackgroundSubagentDone: (r: { id: string; name: string; status: 'ok' | 'err'; result: string; durationMs: number }) =>
    currentOutput?.onBackgroundSubagentDone?.(r),
};
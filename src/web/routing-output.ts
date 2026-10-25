/** 工作区内并发会话的异步 Output 路由；MCP/hooks/delegate 回调跟随发起它的运行。 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ApprovalRequest } from '../safety/index.js';
import { type WebOutput } from './output.js';
import { emitEvent } from './state.js';

const outputs = new AsyncLocalStorage<WebOutput>();
let fallbackOutput: WebOutput | null = null;
/** 兼容旧调用；实际运行始终使用 withCurrentOutput，避免不同会话抢占路由。 */
export function setCurrentOutput(output: WebOutput | null): void { fallbackOutput = output; }
export function getCurrentOutput(): WebOutput | null { return outputs.getStore() ?? fallbackOutput; }
export function withCurrentOutput<T>(output: WebOutput, action: () => T): T { return outputs.run(output, action); }

export const routingOutput = {
  requestApproval: (req: ApprovalRequest) => getCurrentOutput()?.requestApproval(req) ?? Promise.resolve(false),
  askUser: (q: string, opts: string[], multi?: boolean) => getCurrentOutput()?.askUser(q, opts, multi ?? false) ?? Promise.resolve(null),
  onHookOutput: (event: string, lines: string[]) => {
    emitEvent('hook.output', { sessionId: getCurrentOutput()?.sessionId ?? null, event, lines: lines.slice(0, 5) });
  },
  onSubagentEvent: (ev: unknown) => emitEvent('subagent', { sessionId: getCurrentOutput()?.sessionId ?? null, ev }),
  onAutoReview: (req: ApprovalRequest, verdict: { approve: boolean; reason: string }) => getCurrentOutput()?.onAutoReview?.(req, verdict),
  onBackgroundSubagentDone: (r: { id: string; name: string; status: 'ok' | 'err'; result: string; durationMs: number }) => getCurrentOutput()?.onBackgroundSubagentDone?.(r),
};

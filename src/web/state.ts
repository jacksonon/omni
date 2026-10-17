/**
 * omni web 本地后端的共享运行态（从 server.ts 抽出）：
 * 会话/监听器/审批/提问/运行句柄容器 + 审批提问登记处。
 *
 * 注意：这些是**模块级可变容器**（Map/Set 原地增删，从不整体重新赋值），
 * 因此其它模块可以安全 import 并直接读写——保持 server.ts 单进程单实例语义。
 */
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ApprovalRequest } from '../safety/index.js';
import type { AskResult } from '../tools/ask.js';
import type { WebBroadcast } from './events.js';
import { type PendingApproval, type PendingAsk } from './output.js';

/* ---------------- 会话存储与运行管理（1.0 P0-2 多会话并发）---------------- */
export interface WebSession {
  id: string;
  file: string | null;
  messages: ChatCompletionMessageParam[];
  /** 已持久化的可落盘消息数（增量追加起点；/clear 式压缩后重置为 0） */
  persisted: number;
  title: string;
  created: number;
  updated: number;
}

export interface RunningRun {
  sessionId: string;
  controller: AbortController;
  /** steer 打断槽（每运行独立——多会话并发下不再用共享变量） */
  interruptText: string | null;
}

export const sessions = new Map<string, WebSession>();
export const listeners = new Set<WebBroadcast>();
export const approvals = new Map<string, PendingApproval>();
export const asks = new Map<string, PendingAsk>();
/** 并发运行表：sessionId → 运行句柄（每会话限 1 个并发；全局上限 cfg.webConcurrency） */
export const runs = new Map<string, RunningRun>();

/** /send 排队（第六节 P2 轻量多会话协调）：容量空闲时逐条执行（FIFO） */
export const queuedSends: { targetId: string; text: string }[] = [];

export const pendingRegistry = {
  addApproval(sessionId: string, req: ApprovalRequest): Promise<boolean> {
    const id = `ap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    return new Promise<boolean>((resolve) => {
      approvals.set(id, { sessionId, resolve });
      emitEvent('approval.request', {
        sessionId,
        approvalId: id,
        tool: req.tool,
        summary: req.summary,
        reason: req.reason,
      });
    });
  },
  addAsk(
    sessionId: string,
    question: string,
    options: string[],
    multiple: boolean
  ): Promise<AskResult | null> {
    const id = `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    return new Promise<AskResult | null>((resolve) => {
      asks.set(id, { sessionId, options, multiple, resolve });
      emitEvent('ask.request', { sessionId, askId: id, question, options, multiple });
    });
  },
};
/* ---------------- 事件缓冲（SSE 受限时的长轮询回退） ---------------- */
/**
 * Cloudflare Quick Tunnel 等代理会缓冲 text/event-stream，导致浏览器收不到
 * ready/answer 等事件。这里保留最近 N 条广播，供 /api/events/poll 按 seq 拉取；
 * 长轮询请求在事件到达或超时后结束，能穿过这类缓冲代理。
 */
export interface BufferedEvent {
  seq: number;
  type: Parameters<WebBroadcast>[0];
  data: Record<string, unknown>;
  at: number;
}
const MAX_BUFFERED_EVENTS = 1000;
const eventBuffer: BufferedEvent[] = [];
let lastEventSeq = 0;

/** 广播事件：写入环形缓冲 + 推送给所有 SSE 客户端 */
export function emitEvent(type: Parameters<WebBroadcast>[0], data: Record<string, unknown>): void {
  lastEventSeq += 1;
  eventBuffer.push({ seq: lastEventSeq, type, data, at: Date.now() });
  if (eventBuffer.length > MAX_BUFFERED_EVENTS) {
    eventBuffer.splice(0, eventBuffer.length - MAX_BUFFERED_EVENTS);
  }
  for (const l of listeners) {
    try {
      l(type, data);
    } catch {
      // 单个客户端异常不影响其它
    }
  }
}

/** 当前事件序号（新客户端从这里开始拉取，避免重放历史） */
export function currentEventSeq(): number {
  return lastEventSeq;
}

/** 按 seq 取事件；返回最新 seq 供下一次轮询 */
export function eventsSince(since: number): { seq: number; events: BufferedEvent[] } {
  if (since >= lastEventSeq) return { seq: lastEventSeq, events: [] };
  return { seq: lastEventSeq, events: eventBuffer.filter((e) => e.seq > since) };
}

/**
 * 消息组装：把流式累积的正文与工具调用组装成 assistant 消息，解析工具参数。
 */
import type { ChatCompletionAssistantMessageParam, ChatCompletionMessageParam } from 'openai/resources/chat/completions';

/** 工具调用流式累积单元 */
export interface ToolCallAccum {
  id: string;
  name: string;
  args: string;
}

/** 把流式累积的 tool_calls（按 index 分组）组装成 assistant 消息。
 *  reasoning 可选——供持久化用（web 刷新后恢复 thinking 展示），
 *  调用方应在发送到 API 前去除（loop.ts 的 requestMessages 负责剥离）。
 *  subagent 等不传 reasoning 时，其 assistant 消息不带该字段——不会被 API 拒绝。 */
export function buildAssistantMessage(
  content: string,
  toolCalls: Map<number, ToolCallAccum>,
  reasoning?: string
): ChatCompletionAssistantMessageParam {
  const assistantMsg: ChatCompletionAssistantMessageParam = {
    role: 'assistant',
    content: content || null,
  };
  if (toolCalls.size > 0) {
    assistantMsg.tool_calls = [...toolCalls.entries()].map(([i, c]) => ({
      id: c.id || `call_${i}`,
      type: 'function' as const,
      function: { name: c.name, arguments: c.args || '{}' },
    }));
  }
  if (reasoning) {
    (assistantMsg as unknown as Record<string, unknown>).reasoning = reasoning;
  }
  return assistantMsg;
}

/** 从消息中剥离非标准字段（reasoning），返回新数组（不修改原数组）。
 *  用于 API 发送前清洗——避免久非标准字段被网关拒绝。 */
export function stripNonStandardFields(
  messages: ChatCompletionMessageParam[]
): ChatCompletionMessageParam[] {
  return messages.map((m) => {
    if (m.role !== 'assistant') return m;
    const r = (m as unknown as Record<string, unknown>).reasoning;
    if (!r) return m;
    const clone = { ...m };
    delete (clone as unknown as Record<string, unknown>).reasoning;
    return clone;
  });
}

/** 解析工具调用的 JSON 参数，非法 JSON 返回失败 */
export function parseArgs(
  raw: string | undefined
): { ok: true; args: Record<string, unknown> } | { ok: false } {
  try {
    return { ok: true, args: JSON.parse(raw || '{}') };
  } catch {
    return { ok: false };
  }
}

/**
 * 消息组装：把流式累积的正文与工具调用组装成 assistant 消息，解析工具参数。
 */
import type { ChatCompletionAssistantMessageParam } from 'openai/resources/chat/completions';

/** 工具调用流式累积单元 */
export interface ToolCallAccum {
  id: string;
  name: string;
  args: string;
}

/** 把流式累积的 tool_calls（按 index 分组）组装成 assistant 消息 */
export function buildAssistantMessage(
  content: string,
  toolCalls: Map<number, ToolCallAccum>
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
  return assistantMsg;
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

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

export interface AssistantUsage {
  prompt: number;
  completion: number;
  total?: number;
  cached?: number;
}

/** 把流式累积的 tool_calls（按 index 分组）组装成 assistant 消息。
 *  reasoning / usage / model / durMs / genMs / firstTokenMs 可选——供持久化用
 *  （web 刷新后恢复 thinking 与 turn-footer 展示，含每轮首 token 均值），
 *  调用方应在发送到 API 前去除（loop.ts 的 requestMessages 负责剥离）。
 *  subagent 等不传这些字段时，其 assistant 消息不带该字段——不会被 API 拒绝。 */
export function buildAssistantMessage(
  content: string,
  toolCalls: Map<number, ToolCallAccum>,
  reasoning?: string,
  reasoningMs?: number,
  meta?: {
    usage?: AssistantUsage;
    model?: string;
    durMs?: number;
    genMs?: number;
    firstTokenMs?: number | null;
  }
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
  // 思考耗时（毫秒）随 reasoning 一并持久化——供 TUI/Web/console 恢复对话时回放
  //「- thinking · 耗时」头行；缺失（旧会话）→ 恢复显示内容无耗时。
  if (reasoning && typeof reasoningMs === 'number' && reasoningMs > 0) {
    (assistantMsg as unknown as Record<string, unknown>).reasoningMs = Math.round(reasoningMs);
  }
  if (meta?.usage) {
    (assistantMsg as unknown as Record<string, unknown>).usage = meta.usage;
  }
  if (meta?.model) {
    (assistantMsg as unknown as Record<string, unknown>).model = meta.model;
  }
  if (typeof meta?.durMs === 'number' && meta.durMs > 0) {
    (assistantMsg as unknown as Record<string, unknown>).durMs = Math.round(meta.durMs);
  }
  if (typeof meta?.genMs === 'number' && meta.genMs > 0) {
    (assistantMsg as unknown as Record<string, unknown>).genMs = Math.round(meta.genMs);
  }
  // 首 token 延迟随消息持久化——恢复历史时 turn-footer 的「首 token」段有数可算
  if (typeof meta?.firstTokenMs === 'number' && meta.firstTokenMs > 0) {
    (assistantMsg as unknown as Record<string, unknown>).firstTokenMs = Math.round(meta.firstTokenMs);
  }
  return assistantMsg;
}

const NON_STANDARD_FIELDS = ['reasoning', 'reasoningMs', 'usage', 'model', 'durMs', 'genMs', 'firstTokenMs'];

/** 从消息中剥离非标准字段（reasoning / reasoningMs / usage / model 等），返回新数组（不修改原数组）。
 *  用于 API 发送前清洗——避免非标准字段被网关拒绝。 */
export function stripNonStandardFields(
  messages: ChatCompletionMessageParam[]
): ChatCompletionMessageParam[] {
  return messages.map((m) => {
    if (m.role !== 'assistant') return m;
    const rec = m as unknown as Record<string, unknown>;
    const hasField = NON_STANDARD_FIELDS.some((f) => f in rec);
    if (!hasField) return m;
    const clone = { ...m };
    for (const f of NON_STANDARD_FIELDS) {
      delete (clone as unknown as Record<string, unknown>)[f];
    }
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

/**
 * 高精度 token 估算（对标 cl100k / o200k / deepseek BPE 分词规则）：
 * - CJK 汉字 / 日文 / 韩文：每个字符 1 token
 * - 英文单词：按词首空格+子词切分，短词 1 token、长词 ~4 字符/token
 * - 数字：按 1-3 位切分
 * - 标点 / 符号：每个符号 1 token
 * - 空白 / 缩进：每 2-4 空格或换行 1 token
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const tokens = text.match(
    /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]|(?:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu
  );
  if (!tokens) return Math.max(1, Math.ceil(text.length / 4));
  let count = 0;
  for (const tok of tokens) {
    const trimmed = tok.trim();
    const len = trimmed.length;
    if (!len) {
      count += 1;
    } else if (/^[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]$/.test(trimmed)) {
      count += 1;
    } else if (/^\p{L}+$/u.test(trimmed)) {
      count += len <= 8 ? 1 : Math.ceil(len / 4);
    } else if (/^\p{N}+$/u.test(trimmed)) {
      count += Math.ceil(len / 3);
    } else {
      count += Math.max(1, Math.ceil(len / 4));
    }
  }
  return count;
}


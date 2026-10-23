/**
 * Responses API 协议适配（OpenAI Responses API，对标 Chat Completions 的另一条协议）。
 *
 * 背景：部分网关（如 OpenCode Zen）把不同模型部署在不同协议上——
 * 标准模型走 `/chat/completions`，Meta Muse Spark 系列只走 `/responses`。
 * 用 Chat 协议调 Responses-only 模型会直接 400：
 * `{"type":"ModelProtocolUnsupported","message":"Model does not support this protocol."}`。
 * omni 历史只实现 Chat（`client.chat.completions.create`），故 muse-spark 全灭。
 *
 * 本模块只做无状态转换层，不碰循环/工具执行：
 * · Chat 历史（loop 维护的 `ChatCompletionMessageParam[]`）→ Responses `input`
 * · Chat 嵌套 tools → Responses 扁平 tools
 * · `reasoning_effort` → `reasoning: { effort }`（Responses 只认 low/medium/high）
 * · `max_tokens` → `max_output_tokens`；严禁下发 Chat 专有字段
 *   （`stream_options` / `reasoning_effort` / `max_tokens` / `cache_control`）
 * · 流事件 → 累积为 loop 已有的 `{ content, reasoning, toolCalls, usage }` 形态，
 *   下游（assistant 消息组装/工具执行）完全复用，不分叉。
 */
import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ToolCallAccum } from './messages.js';

/** 模型传输协议：completions（默认）/ responses（muse-spark 等） */
export type ResponseProtocol = 'completions' | 'responses';

/** 是否走 Responses 协议：显式配置优先；未配置时 muse-spark 按网关现实默认 responses */
export function shouldUseResponses(
  endpoint: { protocol?: string } | undefined,
  modelName: string
): boolean {
  if (endpoint?.protocol === 'responses') return true;
  if (endpoint?.protocol === 'completions') return false;
  return /muse-spark/i.test(modelName ?? '');
}

/** 是否为「模型不支持该协议」400（Chat 调 Responses-only 模型时的网关拒绝） */
export function isProtocolUnsupportedError(err: unknown): boolean {
  const e = err as { status?: number; message?: string; error?: { type?: string; message?: string } };
  const msg = `${e?.message ?? ''} ${(e?.error as { message?: string })?.message ?? ''}`.toLowerCase();
  const type = String((e?.error as { type?: string })?.type ?? '').toLowerCase();
  return (
    e?.status === 400 &&
    (msg.includes('does not support this protocol') ||
      type.includes('modelprotocolunsupported') ||
      msg.includes('modelprotocolunsupported'))
  );
}

/** omni 思考档位 → Responses reasoning.effort（只认 low/medium/high；none/auto 不下发） */
export function mapResponsesEffort(effort?: string): 'low' | 'medium' | 'high' | undefined {
  if (!effort || effort === 'none' || effort === 'auto') return undefined;
  const v = effort.trim().toLowerCase();
  if (v === 'low' || v === 'minimal') return 'low';
  if (v === 'medium') return 'medium';
  if (v === 'high' || v === 'xhigh' || v === 'max') return 'high';
  return undefined;
}

/** Chat 嵌套 tools → Responses 扁平 tools（`{type:function,name,description,parameters}`） */
export function chatToolsToResponsesTools(
  toolSchemas: Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }>
): Array<{ type: 'function'; name: string; description: string; parameters: unknown }> {
  return toolSchemas.map((t) => ({
    type: 'function' as const,
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
  }));
}

type ResponsesInputItem = Record<string, unknown>;

/** Chat 单条文本抽取（string 或分段数组里的 text 段） */
function chatTextOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        const part = p as { type?: string; text?: string };
        return part?.type === 'text' && typeof part.text === 'string' ? part.text : '';
      })
      .join('');
  }
  return '';
}

/**
 * Chat 历史 → Responses `input`（无状态全量，每轮重发完整历史）。
 * · system → `{role:system}`；user（含图片）→ input_text/input_image 段
 * · assistant 正文 → `{role:assistant}`；assistant tool_calls → function_call 项
 * · tool 结果 → function_call_output 项（call_id 配对）
 */
export function chatMessagesToResponsesInput(messages: ChatCompletionMessageParam[]): ResponsesInputItem[] {
  const out: ResponsesInputItem[] = [];
  for (const m of messages) {
    const role = (m as { role?: string }).role;
    if (role === 'system' || role === 'developer') {
      const text = chatTextOf((m as { content?: unknown }).content);
      if (text) out.push({ type: 'message', role: 'system', content: text });
      continue;
    }
    if (role === 'user') {
      const raw = (m as { content?: unknown }).content;
      if (typeof raw === 'string') {
        out.push({ type: 'message', role: 'user', content: raw });
        continue;
      }
      if (Array.isArray(raw)) {
        const parts: Record<string, unknown>[] = [];
        for (const p of raw) {
          const part = p as { type?: string; text?: string; image_url?: { url?: string } | string };
          if (part?.type === 'text' && typeof part.text === 'string' && part.text) {
            parts.push({ type: 'input_text', text: part.text });
          } else if (part?.type === 'image_url') {
            const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
            if (url) parts.push({ type: 'input_image', image_url: url, detail: 'auto' });
          } else if (part?.type === 'input_image' || part?.type === 'input_text') {
            parts.push(part as Record<string, unknown>);
          }
        }
        if (parts.length > 0) out.push({ type: 'message', role: 'user', content: parts });
        continue;
      }
      continue;
    }
    if (role === 'assistant') {
      const a = m as { content?: unknown; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
      const text = chatTextOf(a.content);
      if (text) out.push({ type: 'message', role: 'assistant', content: text });
      for (const tc of a.tool_calls ?? []) {
        out.push({
          type: 'function_call',
          call_id: tc.id,
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments || '{}',
        });
      }
      continue;
    }
    if (role === 'tool') {
      const t = m as { tool_call_id?: string; content?: unknown };
      const text = chatTextOf(t.content);
      out.push({ type: 'function_call_output', call_id: t.tool_call_id ?? '', output: text });
      continue;
    }
    // function（旧协议）等其余 role：按文本兜底为 user，避免丢上下文
    const fallback = chatTextOf((m as { content?: unknown }).content);
    if (fallback) out.push({ type: 'message', role: 'user', content: fallback });
  }
  return out;
}

/** Responses 请求参数组装（Chat 专有字段一律不带，避免网关 400 校验失败） */
export function buildResponsesParams(
  endpoint: { limit?: { output?: number } } | undefined,
  model: string,
  input: ResponsesInputItem[],
  tools: Array<{ type: 'function'; name: string; description: string; parameters: unknown }>,
  extra: { reasoningEffort?: string; signal?: AbortSignal }
): { params: Record<string, unknown>; options: { signal?: AbortSignal } } {
  const params: Record<string, unknown> = { model, input, stream: true };
  if (tools.length > 0) params.tools = tools;
  const effort = mapResponsesEffort(extra.reasoningEffort);
  if (effort) params.reasoning = { effort };
  if (endpoint?.limit?.output) params.max_output_tokens = Math.max(1, Math.floor(endpoint.limit.output));
  return { params, options: { ...(extra.signal ? { signal: extra.signal } : {}) } };
}

/** Responses 用量 → 通用计数（供 onUsage / 持久化，与 Chat 侧同口径） */
export function responsesUsageToCounts(
  usage: { input_tokens?: number; output_tokens?: number; output_tokens_details?: { reasoning_tokens?: number }; total_tokens?: number; input_tokens_details?: { cached_tokens?: number } } | null | undefined
): { prompt: number; completion: number; total: number; cached: number } | undefined {
  if (!usage) return undefined;
  const prompt = usage.input_tokens ?? 0;
  const completion = usage.output_tokens ?? 0;
  return {
    prompt,
    completion,
    total: usage.total_tokens ?? prompt + completion,
    cached: usage.input_tokens_details?.cached_tokens ?? 0,
  };
}

/**
 * Responses 流事件累积（供 loop/subagent 复用）：
 * 把 `client.responses.create({stream:true})` 的事件流折叠为
 * `{ content, reasoning, toolCalls, usage }`——与 Chat 侧变量同形，下游复用。
 * 调用方负责 Output 回调（onAnswer/thinking.write/onStreamProgress）与计时，
 * 这里只做纯累积 + 返回增量标记（调用方据此驱动 UI/计时）。
 */
export class ResponsesAccumulator {
  content = '';
  reasoning = '';
  toolCalls = new Map<number, ToolCallAccum>();
  usage: { input_tokens?: number; output_tokens?: number; output_tokens_details?: { reasoning_tokens?: number }; total_tokens?: number; input_tokens_details?: { cached_tokens?: number } } | null = null;
  /** output_index → toolCalls key（Responses 并行调用按 output_index 区分） */
  private indexKey = new Map<number, number>();
  private nextKey = 0;

  private keyFor(outputIndex: number): number {
    const hit = this.indexKey.get(outputIndex);
    if (hit !== undefined) return hit;
    const key = this.nextKey++;
    this.indexKey.set(outputIndex, key);
    return key;
  }

  /**
   * 消费单个流事件，返回增量（调用方据此写 Output/计时）。
   * 未知事件返回空增量（忽略，不中断）。
   */
  consume(ev: Record<string, unknown>): { text?: string; reasoning?: string; toolDelta?: boolean; tokenText?: string; usage?: boolean } {
    const type = String((ev as { type?: string }).type ?? '');
    if (type === 'response.output_text.delta' && typeof (ev as { delta?: unknown }).delta === 'string') {
      const d = (ev as { delta: string }).delta;
      this.content += d;
      return { text: d };
    }
    // 推理增量：summary 文本与 reasoning 文本都收（不同网关只发其中一种）
    if (
      (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta' || type === 'response.reasoning_summary.delta') &&
      typeof (ev as { delta?: unknown }).delta === 'string'
    ) {
      const d = (ev as { delta: string }).delta;
      this.reasoning += d;
      return { reasoning: d };
    }
    if (type === 'response.output_item.added') {
      const item = (ev as { item?: Record<string, unknown>; output_index?: number }).item;
      const idx = Number((ev as { output_index?: number }).output_index ?? 0);
      if (item?.type === 'function_call') {
        const key = this.keyFor(idx);
        const cur = this.toolCalls.get(key) ?? { id: '', name: '', args: '' };
        const callId = String(item.call_id ?? item.id ?? '');
        if (callId && !cur.id) cur.id = callId;
        let tokenText = '';
        if (typeof item.name === 'string' && item.name && !cur.name) { cur.name = item.name; tokenText += item.name; }
        if (typeof item.arguments === 'string' && item.arguments && !cur.args) { cur.args = item.arguments; tokenText += item.arguments; }
        this.toolCalls.set(key, cur);
        return { toolDelta: true, tokenText };
      }
      return {};
    }
    if (type === 'response.function_call_arguments.delta') {
      const idx = Number((ev as { output_index?: number }).output_index ?? 0);
      const d = (ev as { delta?: unknown }).delta;
      if (typeof d === 'string' && d) {
        const key = this.keyFor(idx);
        const cur = this.toolCalls.get(key) ?? { id: '', name: '', args: '' };
        cur.args += d;
        this.toolCalls.set(key, cur);
        return { toolDelta: true, tokenText: d };
      }
      return {};
    }
    if (type === 'response.function_call_arguments.done') {
      const idx = Number((ev as { output_index?: number }).output_index ?? 0);
      const args = (ev as { arguments?: unknown }).arguments;
      const itemId = (ev as { item_id?: unknown }).item_id;
      const key = this.keyFor(idx);
      const cur = this.toolCalls.get(key) ?? { id: '', name: '', args: '' };
      const tokenText = typeof args === 'string' && args.startsWith(cur.args) ? args.slice(cur.args.length) : '';
      if (typeof args === 'string' && args) cur.args = args;
      if (typeof itemId === 'string' && itemId && !cur.id) cur.id = itemId;
      this.toolCalls.set(key, cur);
      return { toolDelta: true, tokenText };
    }
    if (type === 'response.output_item.done') {
      const item = (ev as { item?: Record<string, unknown>; output_index?: number }).item;
      const idx = Number((ev as { output_index?: number }).output_index ?? 0);
      if (item?.type === 'function_call') {
        const key = this.keyFor(idx);
        const cur = this.toolCalls.get(key) ?? { id: '', name: '', args: '' };
        const tokenText = (cur.name ? '' : String(item.name ?? '')) + (typeof item.arguments === 'string' && item.arguments.startsWith(cur.args) ? item.arguments.slice(cur.args.length) : '');
        const callId = String(item.call_id ?? item.id ?? cur.id);
        if (callId) cur.id = callId;
        if (typeof item.name === 'string' && item.name) cur.name = item.name;
        if (typeof item.arguments === 'string' && item.arguments) cur.args = item.arguments;
        this.toolCalls.set(key, cur);
        return { toolDelta: true, tokenText };
      }
      return {};
    }
    if (type === 'response.output_text.done') {
      const text = (ev as { text?: unknown }).text;
      if (typeof text === 'string' && text && !this.content) {
        this.content += text;
        return { text };
      }
      return {};
    }
    if (type === 'response.reasoning_summary_text.done' || type === 'response.reasoning_text.done') {
      const text = (ev as { text?: unknown }).text;
      if (typeof text === 'string' && text && !this.reasoning) {
        this.reasoning += text;
        return { reasoning: text };
      }
      return {};
    }
    if (type === 'response.completed' || type === 'response.incomplete') {
      const resp = (ev as { response?: { usage?: ResponsesAccumulator['usage'] } }).response;
      if (resp?.usage) {
        this.usage = resp.usage;
        return { usage: true };
      }
      return {};
    }
    return {};
  }
}

/** Responses 流的 TS 宽松类型（SDK 事件联合类型庞大，调用方按需收窄） */
export type ResponsesStream = AsyncIterable<Record<string, unknown>>;

/** 从 Responses 客户端发起流式请求（宽松签名，避免 SDK 版本间类型漂移） */
export async function createResponsesStream(
  client: OpenAI,
  params: Record<string, unknown>,
  options: { signal?: AbortSignal; headers?: Record<string, string> }
): Promise<ResponsesStream> {
  const api = (client as unknown as {
    responses: { create: (p: unknown, o?: unknown) => Promise<AsyncIterable<Record<string, unknown>>> };
  }).responses;
  return api.create(params, options) as Promise<ResponsesStream>;
}

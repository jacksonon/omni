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

/** 工具调用被中断（取消/打断/异常）时回传的合成结果文案 */
export const TOOL_INTERRUPTED_RESULT =
  '[已中断：该工具调用未返回结果（用户取消、被打断或执行异常）。如需该结果请重新调用。]';

/** 带 id 的工具调用最小形状（assistant.tool_calls 元素） */
type ToolCallLike = { id?: unknown; [k: string]: unknown };

/** 取 assistant 消息的 tool_calls（非数组/缺失返回 null） */
function toolCallsOf(m: ChatCompletionMessageParam): ToolCallLike[] | null {
  if (m.role !== 'assistant') return null;
  const raw = (m as { tool_calls?: unknown }).tool_calls;
  return Array.isArray(raw) ? (raw as ToolCallLike[]) : null;
}

/**
 * 给一组工具调用补「未返回结果」的合成 tool 消息（配对占位）。
 * 用于工具执行阶段被 abort / 异常中断：assistant(tool_calls) 已在请求前入历史，
 * 不补配对的话下一条消息紧跟悬空 tool_calls，网关直接 400
 * （"An assistant message with 'tool_calls' must be followed by tool messages..."）。
 */
export function appendInterruptedToolResults(
  messages: ChatCompletionMessageParam[],
  calls: Array<{ id: string }>,
  content: string = TOOL_INTERRUPTED_RESULT
): void {
  for (const call of calls) {
    messages.push({ role: 'tool', tool_call_id: call.id, content });
  }
}

/**
 * 修复历史消息里的 tool_calls ↔ tool 结果配对（发给 API 前的兜底清洗）。
 *
 * 网关约束：带 tool_calls 的 assistant 后面必须紧跟每个 call id 对应的 tool 消息，
 * 才能出现下一条 user/assistant；tool 消息也必须能对应到尚未回应的 call。
 * 会话被中断（工具执行期 Esc/停止/插话）、旧版本落盘的脏历史、手工裁剪都可能破坏配对，
 * 一旦破坏该会话后续每次请求都 400。这里做非破坏性修复（返回新数组，不改原历史）：
 *
 * - 悬空 tool_calls（后续消息不再是它的 tool 结果）→ 先补合成 tool 占位；
 * - 孤儿 tool 消息（无对应未回应调用）/ 重复回应同一 id → 丢弃；
 * - 结束位置仍悬空 → 补占位（尾部 assistant 也必须被回应）；
 * - tool_calls 为空数组 → 去掉该字段（部分网关不接受空数组）；
 * - 老会话缺失 call id → 生成稳定占位 id。
 *
 * 只处理结构配对，不改正文与顺序；已合法的历史原样（同引用）返回。
 */
export function repairToolPairing(
  messages: ChatCompletionMessageParam[],
  placeholder: string = TOOL_INTERRUPTED_RESULT
): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [];
  const pending = new Set<string>();
  let repaired = false;
  let seq = 0;
  const flush = (): void => {
    if (pending.size === 0) return;
    for (const id of pending) out.push({ role: 'tool', tool_call_id: id, content: placeholder });
    pending.clear();
    repaired = true;
  };

  for (const m of messages) {
    if (m.role === 'tool') {
      const id = (m as { tool_call_id?: unknown }).tool_call_id;
      // 孤儿（无主）或重复回应的 tool 消息会让网关 400 → 丢弃
      if (typeof id !== 'string' || !pending.has(id)) {
        repaired = true;
        continue;
      }
      pending.delete(id);
      out.push(m);
      continue;
    }
    // 进入下一条非 tool 消息前，先把仍未回应的调用收尾
    flush();
    const calls = toolCallsOf(m);
    if (!calls) {
      out.push(m);
      continue;
    }
    if (calls.length === 0) {
      // 空 tool_calls 数组：删字段（语义等同没有工具调用）
      const clone = { ...m } as Record<string, unknown>;
      delete clone.tool_calls;
      out.push(clone as unknown as ChatCompletionMessageParam);
      repaired = true;
      continue;
    }
    let changed = false;
    const normalized = calls.map((tc) => {
      if (typeof tc?.id === 'string' && tc.id) return tc;
      changed = true;
      return { ...tc, id: `call_repair_${++seq}` };
    });
    if (changed) {
      out.push({
        ...m,
        tool_calls: normalized,
      } as unknown as ChatCompletionMessageParam);
      repaired = true;
    } else {
      out.push(m);
    }
    for (const tc of normalized) pending.add((tc as { id: string }).id);
  }
  flush();
  return repaired ? out : messages;
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


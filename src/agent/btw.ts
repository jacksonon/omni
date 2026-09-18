/**
 * 旁问（/btw）：不打断主线任务、答案不进对话历史的一次性侧问。
 *
 * 与 /review 同类：独立轻量请求（转录不 push 回 messages），但多一个**只读迷你工具循环**
 * （read_file / search_code / list_directory）——模型可查证事实而不是凭空回答。
 * 上下文 = 当前对话快照（最近若干条 user/assistant 纯文本），因此能回答「刚才那个报错」
 * 这类依赖当前会话的问题；回答默认可选 --keep 留在上下文（见 formatBtwNote）。
 */
import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { Tool } from '../tools/types.js';
import { readFileTool } from '../tools/read-file.js';
import { searchCodeTool } from '../tools/search-code.js';
import { listDirectoryTool } from '../tools/list-directory.js';
import { truncate } from '../tools/util.js';
import { buildAssistantMessage, parseArgs, type ToolCallAccum } from './messages.js';

/** 旁问系统提示（不进主对话；工具仅只读三件套） */
export const BTW_SYSTEM_PROMPT =
  '你是 omni 的旁问助手。用户在主线任务进行中插入了一个临时问题（by the way）——\n' +
  '只回答这个问题：不要继续主线任务、不要修改文件、不要提出大段实施计划。\n' +
  '需要事实依据时用只读工具（read_file / search_code / list_directory）核实，不要凭猜测编造；\n' +
  '信息不足或查不到就直说。回答简洁（默认 1-3 句，必要时列点），不要复述工具输出全文。';

/** 旁问可用工具：只读三件套（不写盘、不过审批闸门） */
export const BTW_TOOLS: Tool[] = [readFileTool, searchCodeTool, listDirectoryTool];

const TOOL_DEFS: OpenAI.Chat.Completions.ChatCompletionTool[] = BTW_TOOLS.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.parameters },
}));

/** 解析 /btw 参数：--keep = 把旁问 Q/A 作为 system 消息留在对话上下文 */
export function parseBtwArgs(raw: string): { keep: boolean; question: string } {
  const s = raw.trim();
  if (s === '--keep') return { keep: true, question: '' };
  if (s.startsWith('--keep ')) return { keep: true, question: s.slice('--keep'.length).trim() };
  return { keep: false, question: s };
}

/**
 * 构造旁问上下文快照：只取最近 N 条 user/assistant 纯文本消息（过滤脚手架 system、
 * tool 消息与带 tool_calls 的 assistant——避免悬空引用导致 API 400），总字符超限时
 * 从最旧开始丢弃。
 */
export function snapshotForBtw(
  messages: ChatCompletionMessageParam[],
  maxMessages = 20,
  maxChars = 24_000
): ChatCompletionMessageParam[] {
  const picked: ChatCompletionMessageParam[] = [];
  let chars = 0;
  for (let i = messages.length - 1; i >= 0 && picked.length < maxMessages; i--) {
    const m = messages[i];
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (typeof m.content !== 'string' || !m.content.trim()) continue;
    const text = m.content.length > maxChars ? m.content.slice(-maxChars) : m.content;
    if (chars + text.length > maxChars && picked.length > 0) break;
    picked.unshift({ role: m.role, content: text });
    chars += text.length;
  }
  return picked;
}

/** --keep 时留在上下文的 system 消息（persistable：下次落盘随会话文件保存） */
export function formatBtwNote(question: string, answer: string): string {
  return `[旁问] 问：${question}\n答：${answer}`;
}

export interface BtwOptions {
  /** 只读工具工作目录（缺省 = 进程 cwd；worktree 场景由调用方传入） */
  cwd?: string;
  /** 最多模型步数（缺省 4；最后一步不带工具，强制收口成文字回答） */
  maxSteps?: number;
  /** 工具调用进度回调（UI 展示「· read_file」等） */
  onTool?: (name: string, args: Record<string, unknown>) => void;
}

export interface BtwResult {
  ok: boolean;
  answer: string;
  /** 实际执行的只读工具调用次数 */
  toolCalls: number;
  /** ok=false 时的错误信息 */
  error?: string;
}

/**
 * 跑一次旁问：快照 + 问题 + 只读工具循环，返回最终文字回答。
 * 失败返回 ok=false（调用方提示，不打断对话）。
 */
export async function askBtw(
  client: OpenAI,
  model: string,
  messages: ChatCompletionMessageParam[],
  question: string,
  opts?: BtwOptions
): Promise<BtwResult> {
  const maxSteps = Math.max(1, opts?.maxSteps ?? 4);
  const transcript: ChatCompletionMessageParam[] = [
    { role: 'system', content: BTW_SYSTEM_PROMPT },
    ...snapshotForBtw(messages),
    { role: 'user', content: question },
  ];
  let usedTools = 0;
  let lastText = '';
  try {
    for (let step = 0; step < maxSteps; step++) {
      const allowTools = step < maxSteps - 1; // 最后一步不带工具：强制收口成文字
      const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
        model,
        messages: transcript,
        stream: true,
        max_tokens: 1500,
        ...(allowTools ? { tools: TOOL_DEFS } : {}),
      };
      const stream = await client.chat.completions.create(params);
      let content = '';
      const toolCalls = new Map<number, ToolCallAccum>();
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) content += delta.content;
        for (const tc of delta?.tool_calls ?? []) {
          const cur = toolCalls.get(tc.index) ?? { id: '', name: '', args: '' };
          if (tc.id) cur.id += tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          toolCalls.set(tc.index, cur);
        }
      }
      if (content.trim()) lastText = content.trim();
      if (toolCalls.size === 0 || !allowTools) {
        return { ok: true, answer: content.trim() || lastText, toolCalls: usedTools };
      }
      transcript.push(buildAssistantMessage(content, toolCalls));
      const calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c).slice(0, 4);
      for (const tc of calls) {
        const tool = BTW_TOOLS.find((t) => t.name === tc.name);
        const parsed = parseArgs(tc.args);
        opts?.onTool?.(tc.name, parsed.ok ? parsed.args : {});
        let result: string;
        if (!tool) {
          result = `错误：旁问不支持工具「${tc.name}」（仅只读：${BTW_TOOLS.map((t) => t.name).join(' / ')}）`;
        } else if (!parsed.ok) {
          result = '错误：工具参数不是合法 JSON';
        } else {
          try {
            result = await tool.execute(parsed.args, { cwd: opts?.cwd });
          } catch (err) {
            result = `错误：${err instanceof Error ? err.message : String(err)}`;
          }
        }
        usedTools++;
        transcript.push({
          role: 'tool',
          tool_call_id: tc.id || `btw_${step}_${usedTools}`,
          content: truncate(result),
        });
      }
    }
    return { ok: true, answer: lastText, toolCalls: usedTools };
  } catch (err) {
    return { ok: false, answer: lastText, toolCalls: usedTools, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 子代理（subagent）：在隔离的上下文里独立完成一段委托任务。
 *
 * 与主循环（loop.ts）的区别：
 *   · **无 UI 输出**——子代理不向 Output 发事件（过程静默），只把最终结论
 *     文本返回给父代理（父代理把它画成一张普通工具卡片）；
 *   · **隔离上下文**——看不到父对话历史，只在委托任务 + 自己的工具结果上推理；
 *   · **步数上限更小**（默认 10），防止子代理失控拖长主流程；
 *   · **共用安全护栏**——子代理的工具调用走同一个 Safety 实例（同权限/审批/审计）。
 *
 * 工具调用同样支持并行（Promise.all）。
 */
import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { Safety } from '../safety/index.js';
import { truncate } from '../tools/index.js';
import type { Tool } from '../tools/types.js';
import { buildAssistantMessage, parseArgs, type ToolCallAccum } from './messages.js';

const SUBAGENT_PROMPT =
  '你是 Omni 的子代理，负责独立完成一项被委托的子任务。\n' +
  '准则：只完成委托的任务，不越界；先观察再动手（list_directory / read_file）；' +
  '完成后用简洁的中文总结结果。\n委托任务：';

export interface SubagentOptions {
  /** 子代理可用工具（调用方已剔除 delegate，防止无限递归） */
  tools: Tool[];
  /** 安全护栏（与主代理同一实例） */
  gate: Safety;
  /** 子代理最大循环步数（默认 10） */
  maxSteps?: number;
}

export async function runSubagent(
  client: OpenAI,
  model: string,
  task: string,
  opts: SubagentOptions
): Promise<string> {
  const maxSteps = opts.maxSteps ?? 10;
  const messages: ChatCompletionMessageParam[] = [{ role: 'user', content: SUBAGENT_PROMPT + task }];
  const toolSchemas = opts.tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  for (let step = 0; step < maxSteps; step++) {
    let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
    try {
      stream = await client.chat.completions.create({
        model,
        messages,
        tools: toolSchemas,
        stream: true,
      });
    } catch (err: any) {
      return `子代理请求失败：${err?.message ?? err}`;
    }

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

    const assistantMsg = buildAssistantMessage(content, toolCalls);
    messages.push(assistantMsg);

    if (toolCalls.size === 0) {
      // 子代理给出最终结论
      return content.trim() || '（子代理无文字输出）';
    }

    // 并行执行子代理的工具调用（同样过安全闸：审批/审计与主代理一致）
    const calls = assistantMsg.tool_calls!;
    const results = await Promise.all(
      calls.map(async (call) => {
        const tool = opts.tools.find((t) => t.name === call.function.name);
        if (!tool) return `错误：未知工具「${call.function.name}」`;
        const parsed = parseArgs(call.function.arguments);
        if (!parsed.ok) return `错误：工具参数不是合法 JSON：${call.function.arguments}`;
        const gate = await opts.gate.gate(tool, parsed.args);
        if (!gate.allow) return `已拦截：${gate.reason}`;
        try {
          return await tool.execute(parsed.args);
        } catch (err: any) {
          return `执行失败：${err?.message ?? err}`;
        }
      })
    );
    results.forEach((result, i) => {
      messages.push({ role: 'tool', tool_call_id: calls[i].id, content: truncate(result) });
    });
  }

  return '（子代理达到步数上限，任务未完成）';
}

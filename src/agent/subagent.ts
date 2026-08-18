/**
 * 子代理（subagent）：在隔离的上下文里独立完成一段委托任务。
 *
 * 与主循环（loop.ts）的区别：
 *   · **无 UI 输出**——子代理不向 Output 发事件（过程静默），只把最终结论
 *     文本返回给父代理（父代理把它画成一张普通工具卡片）；但通过
 *     onEvent 上报生命周期进度（start/step/end）供 UI 可视化（第六节 P1）；
 *   · **隔离上下文**——看不到父对话历史，只在委托任务 + 自己的工具结果上推理；
 *   · **步数上限更小**（默认 10），防止子代理失控拖长主流程；
 *   · **共用安全护栏**——子代理的工具调用走同一个 Safety 实例（同权限/审批/审计）；
 *     定义子代理（SubagentDef）可配独立 permission（专用 Safety，见第六节 P1）；
 *   · **可嵌套**（第六节 P1）——tools 里若含 delegate 工具（由 createDelegateTool
 *     按深度上限注入），子代理可再委托子任务，parentId/depth 表达层级。
 *
 * 工具调用同样支持并行（Promise.all）。
 */
import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { HookRunner } from '../hooks/index.js';
import { Safety, type ApprovalRequest, type PermissionTier } from '../safety/index.js';
import { truncate } from '../tools/index.js';
import type { Tool } from '../tools/types.js';
import type { SubagentEvent } from './types.js';
import { buildAssistantMessage, parseArgs, type ToolCallAccum } from './messages.js';

/** 子代理基础系统提示（委托任务 + 命名子代理的 instructions 拼接在任务段之后） */
const SUBAGENT_PROMPT =
  '你是 Omni 的子代理，负责独立完成一项被委托的子任务。\n' +
  '准则：只完成委托的任务，不越界；先观察再动手（list_directory / read_file）；' +
  '完成后用简洁的中文总结结果。\n委托任务：';

/** 子代理实例 id 递增（进程内唯一；parentId 关联嵌套层级） */
let subagentSeq = 0;

export interface SubagentOptions {
  /** 子代理可用工具（调用方已按需剔除/注入 delegate——嵌套由 delegate 工具按深度控制） */
  tools: Tool[];
  /** 安全护栏（与主代理同一实例；定义子代理配了 permission 时用它建专用闸门） */
  gate: Safety;
  /** 子代理最大循环步数（默认 10） */
  maxSteps?: number;
  /**
   * Hooks 运行器（与主代理同一实例）：SubagentStart/SubagentStop 生命周期事件 +
   * 子代理内部工具调用同样过 PreToolUse/PostToolUse（enforcement 语义：
   * 主代理配的 guard-env / guard-dangerous 对子代理的写入/命令同样生效）。
   */
  hooks?: HookRunner;
  /** 审计开关（定义子代理配了 permission、建专用 Safety 时用；缺省 = 主闸门配置） */
  auditLog?: boolean;
  /** 审批回调（定义子代理配了 permission、建专用 Safety 时用；缺省 = 主闸门配置） */
  requestApproval?: (req: ApprovalRequest) => Promise<boolean> | boolean;
  /** 总结工具摘要（建专用 Safety 时用；缺省 = 工具名） */
  summarize?: (tool: string, args: Record<string, unknown>) => string;
  /** per-agent 权限档位（SubagentDef.permission；缺省 = 主闸门档位） */
  permission?: PermissionTier;
  /** 技能预载全文（SubagentDef.skills 加载的 SKILL.md 内容，注入系统提示） */
  skills?: string;
  /** 子代理名（事件/提示用；缺省 'delegate'） */
  name?: string;
  /** 进度事件回调（UI 可视化：start/step/end；由 delegate 工具闭包分发） */
  onEvent?: (ev: SubagentEvent) => void;
  /** 子代理实例 id（createDelegateTool 分配；嵌套时逐层传） */
  id?: string;
  /** 父代理 id（null = 主代理直接委托） */
  parentId?: string | null;
  /** 嵌套深度（0 = 主代理直接委托；每层 +1） */
  depth?: number;
}

/** 事件回调统一收口（start/step/end；onEvent 缺省 no-op） */
function emit(opts: SubagentOptions, ev: Omit<SubagentEvent, 'id' | 'parentId' | 'depth' | 'name'>): void {
  opts.onEvent?.({
    ...ev,
    id: opts.id ?? 'sub',
    parentId: opts.parentId ?? null,
    depth: opts.depth ?? 0,
    name: opts.name ?? 'delegate',
  });
}

export async function runSubagent(
  client: OpenAI,
  model: string,
  task: string,
  opts: SubagentOptions
): Promise<string> {
  // Hooks：SubagentStart（fire-and-forget，任务回传；失败静默）
  opts.hooks?.subagentStart(task);
  // 进度事件：start（UI 可视化 + /trace 嵌套树的根）
  emit(opts, { type: 'start', task });
  const t0 = Date.now();
  const maxSteps = opts.maxSteps ?? 10;
  // 命名子代理（SubagentDef）的 instructions 拼进提示词；技能预载全文紧随其后
  const prompt =
    SUBAGENT_PROMPT +
    task +
    (opts.skills ? `\n\n已预载技能：\n${opts.skills}` : '');
  const messages: ChatCompletionMessageParam[] = [{ role: 'user', content: prompt }];
  const toolSchemas = opts.tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  // 专用 Safety（SubagentDef.permission 配置时）：per-agent 权限档位独立于主代理
  //（read 只读子代理不会因主代理切到 full 而获得写权限）；缺省 = 主闸门（共用）
  const gate: Safety =
    opts.permission !== undefined
      ? new Safety({
          tier: opts.permission,
          audit: opts.auditLog ?? false,
          requestApproval: opts.requestApproval ?? (() => false),
          summarize: opts.summarize,
        })
      : opts.gate;
  // 所有返回路径统一收尾：SubagentStop（结论回传）+ end 进度事件 + 最终回答
  const finish = (answer: string, steps: number): string => {
    const status: 'ok' | 'err' =
      /^(错误|执行失败|已拦截)/.test(answer) || answer.includes('（子代理') ? 'err' : 'ok';
    opts.hooks?.subagentStop(answer);
    emit(opts, { type: 'end', status, summary: answer.slice(0, 200), steps, durationMs: Date.now() - t0 });
    return answer;
  };

  for (let step = 0; step < maxSteps; step++) {
    emit(opts, { type: 'step', step, maxSteps }); // 思考/请求中（无工具名）
    let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
    try {
      stream = await client.chat.completions.create({
        model,
        messages,
        tools: toolSchemas,
        stream: true,
      });
    } catch (err: any) {
      return finish(`子代理请求失败：${err?.message ?? err}`, step);
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
      return finish(content.trim() || '（子代理无文字输出）', step + 1);
    }

    // 并行执行子代理的工具调用（同样过安全闸：审批/审计与主代理一致；
    // hooks 同主代理：PreToolUse 硬拦截/改写参数、PostToolUse 输出回传）
    const calls = assistantMsg.tool_calls!;
    // 执行中进度：step 事件补发一次带**当前动作**（工具名）——UI 显示
    // `子代理 X · ⠋ search_code (3/10)`，比裸步数直观（第六节 P1 预览增强）
    emit(opts, {
      type: 'step',
      step,
      maxSteps,
      tool: calls.length === 1 ? calls[0].function.name : `${calls.length} 个工具`,
    });
    const results = await Promise.all(
      calls.map(async (call) => {
        const tool = opts.tools.find((t) => t.name === call.function.name);
        if (!tool) return `错误：未知工具「${call.function.name}」`;
        const parsed = parseArgs(call.function.arguments);
        if (!parsed.ok) return `错误：工具参数不是合法 JSON：${call.function.arguments}`;
        // Hooks：PreToolUse（与主循环同语义——block 跳过闸门与执行、updatedInput 改写参数）
        let args = parsed.args;
        let hookBlocked: string | null = null;
        if (opts.hooks?.has('PreToolUse')) {
          const pre = await opts.hooks.preToolUse(tool.name, args);
          if (!pre.allow) {
            hookBlocked = pre.reason ?? 'PreToolUse hook 阻止了该调用';
          } else if (pre.updatedInput && typeof pre.updatedInput === 'object') {
            args = { ...args, ...pre.updatedInput };
          }
        }
        const g = hookBlocked ? null : await gate.gate(tool, args);
        let result: string;
        if (hookBlocked) {
          result = `已拦截（hook）：${hookBlocked}\n请向用户说明情况，由其决定如何继续。`;
        } else if (!g!.allow) {
          result = `已拦截：${g!.reason}`;
        } else {
          try {
            result = await tool.execute(args);
          } catch (err: any) {
            result = `执行失败：${err?.message ?? err}`;
          }
          if (opts.hooks?.has('PostToolUse')) {
            const post = await opts.hooks.postToolUse(tool.name, args, result);
            if (post.extra.length > 0) result = `${result}\n\n[hook 输出]\n${post.extra.join('\n')}`;
          }
        }
        return result;
      })
    );
    results.forEach((result, i) => {
      messages.push({ role: 'tool', tool_call_id: calls[i].id, content: truncate(result) });
    });
  }

  return finish('（子代理达到步数上限，任务未完成）', maxSteps);
}

/** 分配一个子代理实例 id（进程内唯一；嵌套逐层传） */
export function nextSubagentId(): string {
  return `sub${++subagentSeq}`;
}

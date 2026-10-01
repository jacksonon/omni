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
import type { SubagentRecord, SubagentRegistry } from './subagent-registry.js';
import { detailItemFromEvent, SUBAGENT_DETAIL_MAX } from './subagent-registry.js';
import { buildAssistantMessage, parseArgs, type ToolCallAccum } from './messages.js';
import { extractReasoning } from './thinking.js';
import { formatToolCall, previewOutput } from '../output/format.js';

/** 子代理基础系统提示（委托任务 + 命名子代理的 instructions 拼接在任务段之后） */
const SUBAGENT_PROMPT =
  '你是 Omni 的子代理，负责独立完成一项被委托的子任务。\n' +
  '准则：只完成委托的任务，不越界；先观察再动手（list_directory / read_file）；' +
  '完成后用简洁的中文总结结果。\n委托任务：';

/** 子代理实例 id 递增（进程内唯一；parentId 关联嵌套层级） */
let subagentSeq = 0;

/** 思考增量批量上报：累积少量再发（事件通道不过载；think 事件 text 截断到 400 字） */
function emitThink(opts: SubagentOptions, text: string): void {
  if (!text) return;
  // 子代理思考只在展开详情时展示，增量事件保持粗粒度（≤400 字/次）
  const trimmed = text.length > 400 ? text.slice(0, 400) : text;
  emit(opts, { type: 'think', text: trimmed });
}

/** 判断是否已请求停止（signal abort 或已发 stopped） */
function isStopped(opts: SubagentOptions): boolean {
  return opts.signal?.aborted === true;
}

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
  /**
   * 子代理工作目录（1.0 P0-6 worktree 隔离）：提供时全部工具调用以它为 cwd——
   * 路径解析与命令执行都落在独立工作树里；缺省 undefined = 进程 cwd。
   */
  cwd?: string;
  /**
   * 主循环工具配对序号（delegate 卡片精确路由）：runSubagent 直驱的委托工具
   * 对应的 onToolStep toolSeq。所有进度事件带 seq 透传——TUI/Web 按它把事件归集
   * 到正确的 delegate 卡片（并行多委托/嵌套不再互相覆盖）。缺省 null = 无配对。
   */
  seq?: number | null;
  /**
   * 子代理取消信号（per-subagent AbortController）：主循环 Esc 取消/UI「停止」按钮
   * 触发。abort 后：流式 LLM 请求立即断连（iter.return）、工具执行循环在步间退出，
   * 发 stopped 进度事件并以明确文案结束（不再幽灵跑完）。
   */
  signal?: AbortSignal;
  /** AI 自动审批（2026-09 补课）：定义子代理建专用 Safety 时透传审阅器 */
  autoReview?: (req: ApprovalRequest) => Promise<{ approve: boolean; reason: string } | null>;
  /** Team 协作看板（2026-09 DYN）：SendMessage 收件箱（发给本子代理 id 的消息） */
  team?: import('./team.js').TeamBoard;
  /**
   * 子代理线程记录（Agent View / 子代理任务中心）：提供时 runSubagent 实时维护它——
   * transcript（完整 messages，续跑/钻取的唯一真相源）、status/steps/items/result。
   * 由 delegate / orchestrate 创建并注册进 runOpts.subagentRegistry。
   */
  record?: SubagentRecord;
  /** 子代理线程注册表（完成/停止时 touch 通知 UI；可选） */
  registry?: SubagentRegistry;
  /** 实际使用的模型名（事件/记录标注；缺省 undefined） */
  model?: string;
  /** 思考级别（reasoning_effort；随请求下发，缺省不带该参数） */
  effort?: string;
  /** 命名的子代理定义名（记录标注用；缺省 'delegate'） */
  agent?: string;
}

/** 事件回调统一收口（start/step/end/think/toolStart/toolEnd；onEvent 缺省 no-op） */
function emit(opts: SubagentOptions, ev: Omit<SubagentEvent, 'id' | 'parentId' | 'depth' | 'name'>): void {
  const full: SubagentEvent = {
    ...ev,
    id: opts.id ?? 'sub',
    parentId: opts.parentId ?? null,
    depth: opts.depth ?? 0,
    name: opts.name ?? 'delegate',
    seq: opts.seq ?? null,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
  };
  opts.onEvent?.(full);
  // Agent View 明细留存（钻取视图）：think/toolStart/toolEnd → 记录 items（截断防爆）
  const rec = opts.record;
  if (rec) {
    const item = detailItemFromEvent(full);
    if (item) {
      rec.items.push(item);
      if (rec.items.length > SUBAGENT_DETAIL_MAX) {
        rec.dropped += rec.items.length - SUBAGENT_DETAIL_MAX;
        rec.items.splice(0, rec.items.length - SUBAGENT_DETAIL_MAX);
      }
    }
  }
}

export async function runSubagent(
  client: OpenAI,
  model: string,
  task: string,
  opts: SubagentOptions
): Promise<string> {
  // Hooks：SubagentStart（fire-and-forget，任务回传；失败静默）
  opts.hooks?.subagentStart(task);
  const t0 = Date.now();
  const maxSteps = opts.maxSteps ?? 10;
  const rec = opts.record;
  if (!opts.model) opts.model = model; // 事件/记录标注当前模型（Agent View 展示）
  // 线程登记兜底：调用方（delegate/orchestrate）通常已先注册 resume 闭包，这里只补
  // 未登记的（不覆盖既有条目，避免丢掉 resume 能力）。
  if (rec && opts.registry && !opts.registry.get(rec.id)) opts.registry.register({ record: rec });
  // 线程记录（Agent View）：已有 transcript = 续跑（复用原 messages 继续）；否则新建
  const isResume = !!rec && rec.transcript.length > 0;
  // 命名子代理（SubagentDef）的 instructions 拼进提示词；技能预载全文紧随其后
  const prompt =
    SUBAGENT_PROMPT +
    task +
    (opts.cwd ? `\n\n当前工作目录：${opts.cwd}（独立 git 工作树——你的文件读写与命令执行都发生在这里，不影响主工作区）` : '') +
    (opts.skills ? `\n\n已预载技能：\n${opts.skills}` : '');
  const messages: ChatCompletionMessageParam[] =
    rec && rec.transcript.length > 0 ? rec.transcript : [{ role: 'user', content: prompt }];
  if (rec) {
    rec.transcript = messages;
    rec.status = 'running';
    rec.endedAt = undefined;
    rec.steps = 0;
    rec.maxSteps = maxSteps;
    rec.model = rec.model ?? model;
    rec.effort = opts.effort;
    if (isResume) rec.resumed = true;
    else rec.task = task;
  }
  // 进度事件：start（UI 可视化 + /trace 账本嵌套的根）
  emit(opts, { type: 'start', task: rec?.task ?? task });
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
          ...(opts.autoReview ? { autoReview: opts.autoReview } : {}),
        })
      : opts.gate;
  // 所有返回路径统一收尾：SubagentStop（结论回传）+ end 进度事件 + 最终回答。
  // 被主动停止（signal abort）时：先发 stopped 进度事件（UI 知道这是用户停止而非
  // 自然失败），再走常规 finish 链（hooks + end 事件，status='err'、文案标明停止）。
  const finish = (answer: string, steps: number): string => {
    const dur = Date.now() - t0;
    if (rec) {
      rec.steps = steps;
      rec.endedAt = Date.now();
    }
    if (isStopped(opts)) {
      emit(opts, { type: 'stopped', steps, durationMs: dur });
      const stoppedAnswer = answer.startsWith('（子代理') ? answer : `（子代理已停止）${answer ? `：${answer}` : ''}`;
      opts.hooks?.subagentStop(stoppedAnswer);
      emit(opts, { type: 'end', status: 'err', summary: '已停止', steps, durationMs: dur });
      if (rec) {
        rec.status = 'stopped';
        rec.result = stoppedAnswer;
        opts.registry?.recordDone(rec);
      }
      return stoppedAnswer;
    }
    const status: 'ok' | 'err' =
      /^(错误|执行失败|已拦截)/.test(answer) || answer.includes('（子代理') ? 'err' : 'ok';
    opts.hooks?.subagentStop(answer);
    emit(opts, { type: 'end', status, summary: answer.slice(0, 200), steps, durationMs: dur });
    if (rec) {
      rec.status = status;
      rec.result = answer;
      opts.registry?.recordDone(rec);
    }
    return answer;
  };

  for (let step = 0; step < maxSteps; step++) {
    if (isStopped(opts)) return finish('', step); // 停止请求在步间到达 → 立即退出
    if (rec) rec.steps = step;
    // Team 消息注入（2026-09 DYN）：发给本子代理的 send_message 在下一步前兑现
    const inbox = opts.team?.takeMessages(opts.id ?? '');
    if (inbox && inbox.length > 0) {
      for (const m of inbox) {
        messages.push({ role: 'user', content: `[team 消息 from ${m.from}] ${m.text}` });
      }
    }
    emit(opts, { type: 'step', step, maxSteps }); // 思考/请求中（无工具名）
    let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
    try {
      stream = await client.chat.completions.create({
        model,
        messages,
        tools: toolSchemas,
        stream: true,
        // 子代理取消：abort 信号透传给 SDK——用户停止后流式请求立即断连
        ...(opts.signal ? { signal: opts.signal } : {}),
        // 思考级别（/variants 同口径：none/auto 不下发）
        ...(opts.effort && opts.effort !== 'none' && opts.effort !== 'auto'
          ? { reasoning_effort: opts.effort as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming['reasoning_effort'] }
          : {}),
      });
    } catch (err: any) {
      // 主动停止导致的请求中断（AbortError）→ 按停止收尾，不当作请求失败
      if (isStopped(opts) || err?.name === 'AbortError' || err?.name === 'APIUserAbortError') {
        return finish('', step);
      }
      return finish(`子代理请求失败：${err?.message ?? err}`, step);
    }

    let content = '';
    let reasoningBuf = '';
    const toolCalls = new Map<number, ToolCallAccum>();
    let aborted = false;
    try {
      for await (const chunk of stream) {
        if (isStopped(opts)) {
          aborted = true;
          break; // 停止请求到达：断流退出（SDK signal 也会在下次拉取时抛错）
        }
        const delta = chunk.choices[0]?.delta;
        // 思考增量（reasoning_content / 兼容字段）：实时上报 think 事件（展开详情展示）
        const piece = extractReasoning(delta);
        if (piece) {
          reasoningBuf += piece;
          emitThink(opts, piece);
        }
        if (delta?.content) content += delta.content;
        for (const tc of delta?.tool_calls ?? []) {
          const cur = toolCalls.get(tc.index) ?? { id: '', name: '', args: '' };
          if (tc.id) cur.id += tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          toolCalls.set(tc.index, cur);
        }
      }
    } catch (err: any) {
      // SDK 抛 AbortError = 我们的 signal 断连 → 按停止收尾
      if (isStopped(opts) || err?.name === 'AbortError' || err?.name === 'APIUserAbortError') aborted = true;
      else throw err;
    }
    if (aborted) return finish('', step);

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
        if (!tool) {
          emit(opts, { type: 'toolStart', text: call.function.name, argsPreview: '' });
          emit(opts, { type: 'toolEnd', text: call.function.name, toolOk: false, outputPreview: ['未知工具'] });
          return `错误：未知工具「${call.function.name}」`;
        }
        const parsed = parseArgs(call.function.arguments);
        if (!parsed.ok) {
          emit(opts, { type: 'toolStart', text: tool.name, argsPreview: '' });
          emit(opts, { type: 'toolEnd', text: tool.name, toolOk: false, outputPreview: ['参数非法 JSON'] });
          return `错误：工具参数不是合法 JSON：${call.function.arguments}`;
        }
        // 明细上报：工具开始（摘要 = formatToolCall 人类可读行；卡片展开后展示）
        emit(opts, { type: 'toolStart', text: tool.name, argsPreview: formatToolCall(tool.name, parsed.args) });
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
            // 工具执行本身不可中途取消（execute 无 signal）；与主循环同策略——
            // 停止时由外层放弃等待，工具副作用继续（结果丢弃）
            result = await tool.execute(args, { cwd: opts.cwd, agentId: opts.id });
          } catch (err: any) {
            result = `执行失败：${err?.message ?? err}`;
          }
          if (opts.hooks?.has('PostToolUse')) {
            const post = await opts.hooks.postToolUse(tool.name, args, result);
            if (post.extra.length > 0) result = `${result}\n\n[hook 输出]\n${post.extra.join('\n')}`;
          }
        }
        // 明细上报：工具完成（结果预览行；与主循环 onToolResult preview 同构）
        const ok = !/^(错误|执行失败|已拦截)/.test(result);
        emit(opts, { type: 'toolEnd', text: tool.name, toolOk: ok, outputPreview: previewOutput(result, 3, 300) });
        return result;
      })
    );
    // 停止在工具执行期间到达：工具仍在后台跑（结果丢弃），子代理立即结束
    if (isStopped(opts)) return finish('', step + 1);
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

/**
 * 续跑一个子代理线程（Agent View 的「追问」，对标 Claude Code 打开 transcript 发
 * follow-up / resume subagents，Codex 的 open agent thread + steer）：
 * 把一条 user 追问 push 进原 transcript，带完整历史继续跑同一个循环。
 * 调用方（delegate / orchestrate 的 resume 闭包）负责把与首跑一致的运行上下文
 * （tools / gate / hooks / 模型路由…）透传进来；返回最终结论文本。
 */
export async function resumeSubagent(
  client: OpenAI,
  model: string,
  record: SubagentRecord,
  followUp: string,
  opts: Omit<SubagentOptions, 'record'>
): Promise<string> {
  record.transcript.push({ role: 'user', content: followUp });
  return runSubagent(client, model, record.task, { ...opts, record });
}

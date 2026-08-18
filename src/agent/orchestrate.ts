/**
 * 编排流水线（第六节 P2「动态工作流轻量版」+「/loop 循环任务」+「agent teams 并行协调」）。
 *
 * 固定 pipeline（对标 Claude Code dynamic workflows / Qwen Code 的轻量版，暂不支持
 * 模型写 JS 脚本）：
 *   · /orchestrate——fan-out 并行 delegate（多个 worker 子代理，可选按已定义
 *     SubagentDef 分工）→ 汇总器合并 → 对抗审查员找漏洞 → 输出「综合 + 审查」结论；
 *   · /loop + /goal——循环执行任务直至验收标准满足（每次迭代 = 一个 worker 子代理，
 *     可选 LLM 验收判定器检查是否达标），上限 5 次防失控。
 *
 * 与既有能力复用：worker 走 runSubagent（隔离上下文 + 共用安全闸 + 进度事件），
 * 汇总/审查/验收是独立轻量 LLM 请求（不进 messages 历史，对标 /review）。
 * 三个固定角色（worker / 汇总器 / 对抗审查员 / 验收判定器）的 system 提示词前缀
 * 被 mock server 识别，离线 e2e 可用固定输出验证。
 */
import type OpenAI from 'openai';
import { runSubagent, nextSubagentId } from './subagent.js';
import type { SubagentDef } from './subagent-defs.js';
import type { RunOptions, SubagentEvent } from './types.js';
import type { EventRecorder } from './events.js';

/**
 * worker 进度事件汇聚：UI 回调（Output.onSubagentEvent）+ 轨迹记录器（/trace 嵌套树）——
 * 与 delegate 工具的 onEvent 同语义（编排 worker 直接跑 runSubagent，这里补记轨迹）。
 */
function workerEvent(rec: EventRecorder | undefined, cb: ((ev: SubagentEvent) => void) | undefined) {
  return (ev: SubagentEvent): void => {
    cb?.(ev);
    if (!rec) return;
    if (ev.type === 'start') rec.subagentStart(ev.id, ev.parentId, ev.depth, ev.name, ev.task ?? '');
    else if (ev.type === 'step') rec.subagentStep(ev.id, ev.depth, ev.step ?? 0, ev.maxSteps ?? 0);
    else rec.subagentEnd(ev.id, ev.depth, ev.status === 'ok', ev.summary ?? '', ev.steps ?? 0, ev.durationMs ?? 0);
  };
}

/** worker 子代理系统提示（mock server 按此前缀识别返回固定结果） */
export const ORCHESTRATE_WORKER_PREFIX = '你是 Omni 编排流水线的一个子代理';
const WORKER_PROMPT =
  `${ORCHESTRATE_WORKER_PREFIX}（worker），从指定角度独立完成任务。` +
  '只完成分配给你的角度，不越界；完成后用简洁中文总结结果。\n角度：';

/** 汇总器系统提示（mock 识别前缀） */
export const COMBINE_PREFIX = '把以下多个子代理的独立结果汇总';
const COMBINE_SYSTEM = `${COMBINE_PREFIX}成一份统一结论（去重、合并、标出分歧与共识）。直接输出结论，不要复述要求。`;

/** 对抗审查员系统提示（mock 识别前缀） */
export const REVIEW_PREFIX = '你是 Omni 编排的对抗审查员';
const REVIEW_SYSTEM =
  `${REVIEW_PREFIX}。审查以下综合结果，指出潜在问题、遗漏与风险，并给出具体改进建议。` +
  '先列问题，再给建议，最后一行给出「总体结论：可采纳 / 需修正」。';

/** 验收判定器系统提示（mock 识别前缀） */
export const GOAL_PREFIX = '你是 Omni 验收判定器';
const GOAL_SYSTEM = `${GOAL_PREFIX}。判定以下结果是否满足验收标准，只回答「满足」或「不满足」，并附一句理由。`;

/** 默认并行 worker 数（未指定 --agents 时按角度 fan-out） */
const DEFAULT_WORKERS = 3;
/** /loop 最大迭代次数（防失控） */
const MAX_ITERATIONS = 5;

/** 编排进度回调（TUI 命令面板 / CLI stdout；worker 进度事件可复用 Output.onSubagentEvent） */
export interface PipelineCallbacks {
  /** 状态/进度行 */
  log(text: string): void;
  /** 等待一帧（TUI session.paint；CLI no-op） */
  tick?(): Promise<void>;
  /** 子代理进度事件（复用 Output.onSubagentEvent 链路 / CLI dim 行） */
  onSubagentEvent?(ev: SubagentEvent): void;
}

/** 一次流式 LLM 请求并累积正文（汇总/审查/验收判定等编排内调用共用；不进历史） */
async function completeText(
  client: OpenAI,
  model: string,
  system: string,
  user: string,
  maxTokens?: number
): Promise<string> {
  let content = '';
  try {
    const stream = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      stream: true,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
    });
    for await (const chunk of stream) {
      const d = chunk.choices[0]?.delta;
      if (d?.content) content += d.content;
    }
  } catch (err: any) {
    return `（请求失败：${err?.message ?? err}）`;
  }
  return content.trim();
}

/** 解析 /orchestrate 与 /loop 的参数（任务 + 可选 --agents a,b,c / --goal <标准>） */
export function parsePipelineArgs(
  raw: string
): { task: string; agents?: string[]; goal?: string; parallel?: number } {
  const agentsM = raw.match(/--agents\s+([\w,-]+)/);
  const goalM = raw.match(/--goal\s+(.+?)(?=\s+--|$)/);
  const parallelM = raw.match(/--parallel\s+(\d+)/);
  // 任务 = 去掉已识别的 flag 段后的剩余文本（首段）
  let task = raw
    .replace(/--agents\s+[\w,-]+/, '')
    .replace(/--goal\s+.+?(?=\s+--|$)/, '')
    .replace(/--parallel\s+\d+/, '')
    .trim();
  // 多 flag 时去掉重复空格
  task = task.replace(/\s{2,}/g, ' ').trim();
  const n = parallelM ? Number(parallelM[1]) : undefined;
  return {
    task,
    agents: agentsM ? agentsM[1].split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    goal: goalM ? goalM[1].trim() : undefined,
    parallel: n && Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined,
  };
}

/** 默认 worker 角度（未指定 --agents 时按角度 fan-out——覆盖执行/逆向/边界三条线） */
const DEFAULT_ANGLES = ['正面推进：直接按任务目标完成', '逆向检查：从反例/失败模式出发审查方案', '边界探索：找遗漏场景与极端情况'];

/**
 * /orchestrate：fan-out 并行 delegate → 汇总 → 对抗审查。
 * workers：--agents a,b,c 时按已定义 SubagentDef 分工（各自 model/permission/tools/skills）；
 * 否则 N 个（默认 3，--parallel 可调）按角度 fan-out 的通用 worker。
 * 返回 { combined, review }——命令层把它们拼进面板/输出。
 */
export async function runOrchestrate(
  raw: string,
  defs: SubagentDef[] | undefined,
  opts: { client: OpenAI; model: string; runOpts: RunOptions } & PipelineCallbacks
): Promise<{ combined: string; review: string }> {
  const { task, agents } = parsePipelineArgs(raw);
  if (!task) throw new Error('用法：/orchestrate <任务> [--agents a,b,c] [--parallel N]（缺省按 3 个角度并行）');
  const runOpts = opts.runOpts;
  // worker 模型路由（第六节 P1 architect/editor）：编排执行阶段用 editor 轻模型
  const workerModel = runOpts.editorModel ?? opts.model;
  // worker 可用工具：除 delegate 外的全部（含 MCP）；worker 内不嵌套（编排已并行）
  const workerTools = (runOpts.tools ?? []).filter((t) => t.name !== 'delegate');
  // 安全闸 / hooks 与主循环共用（审批/审计/enforcement 一致）
  const gate = runOpts.safetyGate;
  const hooks = runOpts.hooks;

  // 解析 --agents → 按定义的 SubagentDef 分工；否则按角度 fan-out
  let jobs: { label: string; def?: SubagentDef; prompt: string }[];
  if (agents && agents.length > 0) {
    const unknown = agents.filter((a) => !defs?.some((d) => d.name === a));
    if (unknown.length > 0) {
      throw new Error(
        `未找到子代理定义：${unknown.join('、')}。可用：${(defs ?? []).map((d) => d.name).join('、') || '（无）'}`
      );
    }
    jobs = agents.map((a) => ({
      label: a,
      def: defs!.find((d) => d.name === a),
      prompt: task,
    }));
  } else {
    jobs = DEFAULT_ANGLES.map((angle) => ({ label: `worker-角度`, def: undefined, prompt: `${angle}。\n任务：${task}` }));
  }
  if (!gate) throw new Error('安全闸未初始化（当前环境不可用）');

  opts.log(`╭─ 编排开始：${task.slice(0, 60)}${task.length > 60 ? '…' : ''}`);
  opts.log(`├─ fan-out：${jobs.length} 个 worker 并行（${agents ? '按定义子代理分工' : '按角度分工'}）`);
  await opts.tick?.();

  // fan-out：并行跑所有 worker（每个 = 一个隔离上下文子代理，共用安全闸）。
  // 定义子代理（--agents）走 per-agent 配置：模型 / 权限 / 工具白名单 / 技能预载 / 步数；
  // 通用 worker（按角度）用 editor 轻模型 + 默认配置。
  const started = Date.now();
  const results = await Promise.all(
    jobs.map(async (job, i) => {
      const id = nextSubagentId();
      opts.log(`│  ├─ worker ${i + 1}/${jobs.length}：${job.label} 开始`);
      await opts.tick?.();
      // 定义子代理：工具白名单 / 技能预载 / 权限 / 步数 / 模型
      const whitelist = job.def?.tools ? new Set(job.def.tools) : null;
      const tools = whitelist ? workerTools.filter((t) => whitelist.has(t.name)) : workerTools;
      let skillsText = '';
      if (job.def?.skills && job.def.skills.length > 0) {
        const { loadSkillContent } = await import('./skill.js');
        const parts: string[] = [];
        for (const s of job.def.skills) {
          const c = await loadSkillContent(s).catch(() => null);
          if (c) parts.push(`### ${s}\n${c}`);
        }
        if (parts.length > 0) skillsText = parts.join('\n\n');
      }
      const answer = await runSubagent(opts.client, job.def?.model ?? workerModel, job.prompt, {
        tools,
        gate,
        maxSteps: job.def?.maxSteps ?? runOpts.maxSubagentSteps,
        hooks,
        permission: job.def?.permission,
        skills: skillsText,
        name: job.def?.name ?? `worker${i + 1}`,
        onEvent: workerEvent(runOpts.events, opts.onSubagentEvent),
        id,
        parentId: null,
        depth: 0,
      });
      return `[${job.label}]\n${answer}`;
    })
  );
  opts.log(`├─ worker 全部完成（${((Date.now() - started) / 1000).toFixed(1)}s）`);

  // 汇总：一次轻量 LLM 请求合并各 worker 结果
  opts.log('├─ 汇总器合并…');
  await opts.tick?.();
  const combined = await completeText(
    opts.client,
    opts.model,
    COMBINE_SYSTEM,
    results.map((r, i) => `—— worker ${i + 1} ——\n${r}`).join('\n\n')
  );

  // 对抗审查：审查综合结果找漏洞
  opts.log('├─ 对抗审查…');
  await opts.tick?.();
  const review = await completeText(opts.client, opts.model, REVIEW_SYSTEM, combined, 800);
  opts.log('╰─ 编排完成');
  return { combined, review };
}

/**
 * /loop [/goal]：循环执行任务直至验收标准满足。
 * 每次迭代 = 一个 worker 子代理（带上一轮结果作上下文）；配置了 --goal 时用
 * 验收判定器 LLM 检查是否达标（回答含「满足」即停），否则跑满 MAX_ITERATIONS。
 */
export async function runLoop(
  raw: string,
  opts: { client: OpenAI; model: string; runOpts: RunOptions } & PipelineCallbacks
): Promise<string> {
  const { task, goal } = parsePipelineArgs(raw);
  if (!task) throw new Error('用法：/loop <任务> [--goal <验收标准>]（循环执行直至达标，上限 5 次）');
  const runOpts = opts.runOpts;
  const workerModel = runOpts.editorModel ?? opts.model;
  const workerTools = (runOpts.tools ?? []).filter((t) => t.name !== 'delegate');
  const gate = runOpts.safetyGate;
  if (!gate) throw new Error('安全闸未初始化（当前环境不可用）');
  const hooks = runOpts.hooks;

  opts.log(`╭─ 循环任务：${task.slice(0, 60)}${task.length > 60 ? '…' : ''}`);
  if (goal) opts.log(`├─ 验收标准：${goal.slice(0, 80)}`);
  opts.log(`├─ 最大迭代：${MAX_ITERATIONS} 次`);
  await opts.tick?.();

  let lastResult = '';
  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    opts.log(`│  ├─ 迭代 ${i}/${MAX_ITERATIONS} 开始`);
    await opts.tick?.();
    const prompt = `${task}${lastResult ? `\n\n上一轮结果（${i - 1} 轮）：\n${lastResult}\n\n请在此基础上继续推进，不要重复已完成的工作。` : ''}`;
    const id = nextSubagentId();
    const answer = await runSubagent(opts.client, workerModel, prompt, {
      tools: workerTools,
      gate,
      maxSteps: runOpts.maxSubagentSteps,
      hooks,
      name: 'loop-worker',
      onEvent: workerEvent(runOpts.events, opts.onSubagentEvent),
      id,
      parentId: null,
      depth: 0,
    });
    lastResult = answer;
    // 验收判定（--goal 配置时）：LLM 判定是否达标
    if (goal) {
      opts.log(`│  ├─ 验收判定（第 ${i} 轮）…`);
      await opts.tick?.();
      const verdict = await completeText(opts.client, opts.model, GOAL_SYSTEM, `验收标准：${goal}\n\n结果：\n${answer}`, 200);
      // 「不满足」含「满足」子串——精确判「满足」且未被「不」否定
      const met = verdict.includes('满足') && !verdict.includes('不满足');
      opts.log(`│  ├─ 判定：${met ? '✓ 满足' : '✗ 不满足'}（${verdict.replace(/\n/g, ' ').slice(0, 80)}）`);
      await opts.tick?.();
      if (met) {
        opts.log(`╰─ 第 ${i} 轮达成验收标准，循环结束`);
        return `${answer}\n\n[验收达成：第 ${i} 轮] ${verdict}`;
      }
    } else {
      opts.log(`│  ├─ 迭代 ${i} 完成`);
    }
  }
  opts.log(`╰─ 达到迭代上限（${MAX_ITERATIONS}），任务可能未完全达标`);
  return `${lastResult}\n\n[达到迭代上限 ${MAX_ITERATIONS} 次，未配置验收标准或未达标]`;
}

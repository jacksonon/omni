/**
 * delegate：委托工具——把一段独立的子任务交给子代理（subagent）完成。
 *
 * 模型侧：主代理觉得某个子任务「值得隔离上下文、独立验证」时调用它；
 * 执行侧：subagent.ts 跑一个无 UI 的嵌套循环（隔离上下文、小步数上限、
 * 共用安全护栏），只把最终结论文本返回给主代理（画成普通工具卡片）。
 *
 * 第六节「子代理与编排」扩展（P1）：
 *  · **agent 参数**——delegate 可按 `.agents/subagents/*.md` 定义的命名子代理
 *    （SubagentDef）委托：per-agent 模型 / 权限 / 工具白名单 / 技能预载 / 步数上限；
 *  · **嵌套**——子代理的可用工具里再挂一个 delegate（深度 < maxSubagentDepth，
 *    默认 5 层上限），子代理可再委托子任务，parentId/depth 表达层级；
 *  · **进度可视化**——runSubagent 的 start/step/end 事件经 onEvent 分发
 *    （Output.onSubagentEvent → TUI 卡片 live 状态）+ EventRecorder（/trace 嵌套树）；
 *  · **模型路由**——architect/editor（第六节 P1）：/plan 用 architect 强模型、
 *    执行用 editor 轻模型（缺省 = 当前模型）；定义子代理的 model 字段优先。
 *
 * 防递归：每层 delegate 都从子代理工具列表里剔除自身后再按深度注入新的 delegate
 *（递归深度受 maxSubagentDepth 控制，不是无限）。
 */
import { runSubagent, nextSubagentId } from '../agent/subagent.js';
import type { SubagentDef } from '../agent/subagent-defs.js';
import type { ModelRuntime } from '../client.js';
import type { HookRunner } from '../hooks/index.js';
import type { Safety } from '../safety/index.js';
import { truncate } from './util.js';
import type { Tool } from './types.js';
import type { RunOptions, SubagentEvent } from '../agent/types.js';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export interface DelegateToolOptions {
  /** 当前模型运行时引用（与主循环共用）：/model 切换后子代理自动用新模型/端点 */
  modelRuntime: ModelRuntime;
  /** 子代理可用工具（内部会按嵌套深度注入新的 delegate） */
  tools: Tool[];
  /** 安全护栏（与主代理同一实例） */
  gate: Safety;
  /** 子代理最大循环步数（缺省 10） */
  maxSteps?: number;
  /** Hooks 运行器（与主代理同一实例）：SubagentStart/Stop + 子代理工具调用过 Pre/PostUse */
  hooks?: HookRunner;
  /**
   * 动态读取的运行选项（attachRuntime 注入 runOpts）：planMode / architectModel /
   * editorModel / maxSubagentDepth / subagents / events——delegate 在**执行时**读取
   *（/plan、/model 运行时切换即时生效，工具只创建一次）。
   */
  runOpts?: RunOptions;
  /** 已发现的子代理定义（agent 参数按名选用；attachRuntime 注入） */
  subagents?: SubagentDef[];
  /** 嵌套深度（0 = 主代理直接委托；每层 +1） */
  depth?: number;
  /** 子代理最大嵌套深度（缺省 5） */
  maxDepth?: number;
  /** 父代理 id（嵌套用；null = 主代理） */
  parentId?: string | null;
  /**
   * 进度事件回调（attachRuntime 注入：Output.onSubagentEvent + 轨迹事件落盘）。
   * 嵌套子代理的事件沿同一回调链汇聚。
   */
  onEvent?: (ev: SubagentEvent) => void;
  /** 审计开关（定义子代理配 permission、建专用 Safety 时用；缺省 = 主闸门配置） */
  auditLog?: boolean;
  /** 审批回调（同上；缺省 = 主闸门配置） */
  requestApproval?: (req: import('../safety/index.js').ApprovalRequest) => Promise<boolean> | boolean;
  /** 工具摘要（同上；缺省 = 工具名） */
  summarize?: (tool: string, args: Record<string, unknown>) => string;
}

/**
 * 给「子代理」生成一份工具列表：从调用方的工具里剔除 delegate 自身，若嵌套深度
 * 未达上限则再注入一个新的 delegate（子代理可再委托；深度 +1）。
 * parentId = 父代理实例 id（execute 分配后传入——嵌套子代理的事件用它关联父级）。
 */
function buildSubTools(opts: DelegateToolOptions, depth: number, parentId: string | null): Tool[] {
  const subTools = opts.tools.filter((t) => t.name !== 'delegate');
  const maxDepth = opts.maxDepth ?? 5;
  if (depth + 1 < maxDepth) {
    subTools.push(createDelegateTool({ ...opts, tools: subTools, depth: depth + 1, parentId }));
  }
  return subTools;
}

export function createDelegateTool(opts: DelegateToolOptions): Tool {
  return {
    name: 'delegate',
    description:
      '把一段独立的子任务委托给子代理完成，返回最终结论（过程不展示）。' +
      '适合：需要隔离上下文的长任务、可独立验证的小任务、并行探索多个方向。' +
      '注意：子代理看不到主对话历史，请把必要上下文与验收标准写进 task。' +
      (opts.subagents && opts.subagents.length > 0
        ? ` 可选 agent 参数按名委托已定义子代理：${opts.subagents.map((s) => `${s.name}（${s.description}）`).join('、')}。`
        : ''),
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '子任务的完整描述（含必要上下文、目标与验收标准）' },
        agent: {
          type: 'string',
          description:
            '可选：已定义子代理的名字（.agents/subagents/*.md；缺省 = 通用委托）。' +
            '定义子代理有专用模型/权限/工具白名单/技能预载，适合固定角色的专业任务（如 code-reviewer 只读审查）。',
        },
        worktree: {
          type: ['boolean', 'string'],
          description:
            '可选：git worktree 隔离（1.0 P0-6）。true = 在独立工作树执行（自动建临时分支）；' +
            '字符串 = 指定新分支名。并行委托写同一仓库时用它防写冲突；结果附改动统计与合并方式。',
        },
        cleanup: {
          type: 'boolean',
          description: '可选：worktree 完成后是否清理（默认 false 保留——便于检查/合并 diff）。',
        },
      },
      required: ['task'],
    },
    async execute(args) {
      const task = String(args.task ?? '').trim();
      if (!task) return '错误：delegate 需要 task 参数（子任务描述）';
      const agentName = typeof args.agent === 'string' && args.agent.trim() ? args.agent.trim() : undefined;
      // agent 参数 → 按名找定义；未找到提示可用列表（自我纠错：模型可改 agent 或去掉）
      const def = agentName
        ? opts.subagents?.find((s) => s.name === agentName)
        : undefined;
      if (agentName && !def) {
        const avail = (opts.subagents ?? []).map((s) => s.name).join('、');
        return `错误：未找到子代理定义「${agentName}」${avail ? `。可用：${avail}` : '（.agents/subagents/ 下未定义任何子代理）'}`;
      }
      // worktree 隔离（1.0 P0-6）：在独立 git 工作树里跑子代理，防并行写冲突。
      // 实现：git worktree add 到 <repoRoot>/.omni/worktrees/<名>；子代理 cwd 指向它；
      // 结束后按 cleanup 决定保留/清理，并附改动统计与合并方式。
      const wantWorktree = args.worktree === true || (typeof args.worktree === 'string' && !!args.worktree.trim());
      let wtPath: string | null = null;
      let wtBranch: string | null = null;
      let wtNote = '';
      if (wantWorktree) {
        const { execSync } = await import('node:child_process');
        const baseCwd = process.cwd();
        try {
          const repoRoot = execSync('git rev-parse --show-toplevel', { cwd: baseCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
          if (!repoRoot) throw new Error('not a git repo');
          const branchArg = typeof args.worktree === 'string' ? args.worktree.trim() : '';
          const id0 = nextSubagentId();
          wtBranch = branchArg || `omni-wt-${id0}-${Date.now().toString(36)}`;
          wtPath = path.join(repoRoot, '.omni', 'worktrees', `${wtBranch.replace(/[^\w.-]+/g, '-')}`);
          if (existsSync(wtPath)) throw new Error(`目标工作树已存在：${wtPath}`);
          mkdirSync(path.dirname(wtPath), { recursive: true });          execSync(`git worktree add ${JSON.stringify(wtPath)} -b ${JSON.stringify(wtBranch)}`, {
            cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000,
          });
        } catch (err) {
          return `错误：worktree 创建失败——${err instanceof Error ? err.message : err}。可去掉 worktree 参数改为在工作区内委托。`;
        }
      }
      const runOpts = opts.runOpts;
      const depth = opts.depth ?? 0;
      // 实例 id（嵌套逐层传：父代理在 runSubagent 里拿自己的 id，这里生成的 id
      // 由子代理事件带出，parentId 用父代理 id）
      const id = nextSubagentId();
      const parentId = opts.parentId ?? null;
      // 模型路由（第六节 P1 architect/editor + 定义子代理 model 字段优先）：
      // · 定义子代理 model → 用它（per-agent 固定模型）
      // · 否则按 planMode 路由：/plan 用 architect 强模型、执行用 editor 轻模型
      // · 缺省 = 当前运行时模型（/model 切换即时生效）
      const current = opts.modelRuntime.model;
      const routed =
        def?.model ??
        (runOpts && runOpts.planMode ? runOpts.architectModel : runOpts?.editorModel) ??
        current;
      // 进度事件汇聚（UI 可视化 + /trace 轨迹）：UI 回调 + 事件记录器
      const onEvent = (ev: SubagentEvent): void => {
        opts.onEvent?.(ev);
        // /trace 嵌套树：子代理事件也进轨迹记录器（subagent/start·step·end）
        if (runOpts?.events) {
          const e = runOpts.events;
          if (ev.type === 'start') e.subagentStart(ev.id, ev.parentId, ev.depth, ev.name, ev.task ?? '');
          else if (ev.type === 'step') e.subagentStep(ev.id, ev.depth, ev.step ?? 0, ev.maxSteps ?? 0);
          else e.subagentEnd(ev.id, ev.depth, ev.status === 'ok', ev.summary ?? '', ev.steps ?? 0, ev.durationMs ?? 0);
        }
      };
      // 子代理可用工具：剔除 delegate 后按深度注入新的 delegate（嵌套）——
      // parentId = 本实例 id：嵌套子代理的事件用它关联父级
      const subTools = buildSubTools(opts, depth, id);
      // 定义子代理配置：工具白名单（缺省 = 全部）/ 步数上限 / 技能预载 / 权限
      const whitelist = def?.tools ? new Set(def.tools) : null;
      const tools = whitelist ? subTools.filter((t) => whitelist.has(t.name)) : subTools;
      const maxSteps = def?.maxSteps ?? opts.maxSteps;
      // 技能预载：把定义里 skills 字段列的 SKILL.md 全文注入子代理提示词
      //（异步加载；失败静默——技能缺失不阻塞委托）
      let skillsText = '';
      if (def?.skills && def.skills.length > 0) {
        const { loadSkillContent } = await import('../agent/skill.js');
        const parts: string[] = [];
        for (const s of def.skills) {
          const c = await loadSkillContent(s).catch(() => null);
          if (c) parts.push(`### ${s}\n${c}`);
        }
        if (parts.length > 0) skillsText = parts.join('\n\n');
      }
      const answer = await runSubagent(opts.modelRuntime.client, routed, task, {
        tools,
        gate: opts.gate,
        maxSteps,
        hooks: opts.hooks,
        permission: def?.permission,
        auditLog: opts.auditLog,
        requestApproval: opts.requestApproval,
        summarize: opts.summarize,
        skills: skillsText,
        name: def?.name ?? 'delegate',
        onEvent,
        id,
        parentId,
        depth,
        cwd: wtPath ?? undefined,
      });
      // worktree 收尾：改动统计 + 保留/清理 + 合并提示
      if (wtPath) {
        const { execSync } = await import('node:child_process');
        let stat = '';
        try {
          const st = execSync(`git -C ${JSON.stringify(wtPath)} status --porcelain`, { encoding: 'utf8', timeout: 10_000 });
          const files = st.split('\n').filter((l) => l.trim());
          stat = `${files.length} 个文件改动`;
        } catch {
          stat = '（无法读取工作树状态）';
        }
        const doCleanup = args.cleanup === true;
        if (doCleanup) {
          try {
            execSync(`git worktree remove --force ${JSON.stringify(wtPath)}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 });
            wtNote = `（worktree 已清理；分支 ${wtBranch} 保留，可 git diff main..${wtBranch} 查看改动）`;
          } catch {
            wtNote = `（清理失败——worktree 保留在 ${wtPath}）`;
          }
        } else {
          wtNote = `（worktree 保留：${wtPath} · ${stat} · 分支 ${wtBranch}。合并：git -C "${wtPath}" diff > patch 后 git apply，或 git merge ${wtBranch}）`;
        }
      }
      return `子代理结果${def ? `（${def.name}）` : ''}${wtNote ? ` [worktree:${wtBranch}]` : ''}：\n${truncate(answer)}${wtNote ? `\n\n${wtNote}` : ''}`;
    },
  };
}

/**
 * delegate：委托工具——把一段独立的子任务交给子代理（subagent）完成。
 *
 * 模型侧：主代理觉得某个子任务「值得隔离上下文、独立验证」时调用它；
 * 执行侧：subagent.ts 跑一个无 UI 的嵌套循环（隔离上下文、小步数上限、
 * 共用安全护栏），只把最终结论文本返回给主代理（画成普通工具卡片）。
 *
 * 防递归：本工具从子代理可用工具列表中剔除（subagent 内看不到 delegate）。
 */
import { runSubagent } from '../agent/subagent.js';
import type { ModelRuntime } from '../client.js';
import type { Safety } from '../safety/index.js';
import { truncate } from './util.js';
import type { Tool } from './types.js';

export interface DelegateToolOptions {
  /** 当前模型运行时引用（与主循环共用）：/model 切换后子代理自动用新模型/端点 */
  modelRuntime: ModelRuntime;
  /** 子代理可用工具（内部会剔除 delegate 本身） */
  tools: Tool[];
  /** 安全护栏（与主代理同一实例） */
  gate: Safety;
  /** 子代理最大循环步数（缺省 10） */
  maxSteps?: number;
}

export function createDelegateTool(opts: DelegateToolOptions): Tool {
  // 子代理可用工具 = 全部工具 - delegate（防无限递归）
  const subTools = opts.tools.filter((t) => t.name !== 'delegate');
  return {
    name: 'delegate',
    description:
      '把一段独立的子任务委托给子代理完成，返回最终结论（过程不展示）。' +
      '适合：需要隔离上下文的长任务、可独立验证的小任务、并行探索多个方向。' +
      '注意：子代理看不到主对话历史，请把必要上下文与验收标准写进 task。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '子任务的完整描述（含必要上下文、目标与验收标准）' },
      },
      required: ['task'],
    },
    async execute(args) {
      const task = String(args.task ?? '').trim();
      if (!task) return '错误：delegate 需要 task 参数（子任务描述）';
      // 运行时读取当前模型（/model 切换后子代理自动跟随，不需要重建工具）
      const answer = await runSubagent(opts.modelRuntime.client, opts.modelRuntime.model, task, {
        tools: subTools,
        gate: opts.gate,
        maxSteps: opts.maxSteps,
      });
      return `子代理结果：\n${truncate(answer)}`;
    },
  };
}

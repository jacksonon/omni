/**
 * Team 工具（2026-09 DYN）：
 *  · task_board —— 共享任务看板（主代理与子代理都能增改查；owner 认领）
 *  · send_message —— 子代理/主代理互发消息（运行中投递；收方在下一步被注入上下文）
 *
 * 运行时注入（同上 delegate/ask/todo 模式）：静态注册表不登记——需要 runOpts 引用。
 */
import type { Tool, ToolContext } from './types.js';
import { ensureTeam, type TeamTaskStatus } from '../agent/team.js';
import type { RunOptions } from '../agent/types.js';

const STATUSES: TeamTaskStatus[] = ['pending', 'in_progress', 'completed', 'failed'];

export function createTaskBoardTool(runOpts: RunOptions): Tool {
  return {
    name: 'task_board',
    description:
      '共享任务看板：主代理与所有子代理共用。多代理协作时先用 add 建任务（owner 缺省由 worker 认领），' +
      'worker 执行中用 update/claim 汇报状态（in_progress/completed/failed），任何角色都能 list 查看全局进度。' +
      '单代理长任务也可用它维护任务列表（与 todo_write 类似但跨子代理共享）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'update', 'claim', 'list'], description: 'add 新建 / update 改状态或备注 / claim 认领 / list 查看' },
        title: { type: 'string', description: 'add：任务标题' },
        id: { type: 'string', description: 'update/claim：任务 id（如 t1）或标题' },
        status: { type: 'string', enum: STATUSES, description: 'update：新状态' },
        owner: { type: 'string', description: 'claim/update：负责人（子代理名或 id）' },
        note: { type: 'string', description: 'update：进展/阻塞备注（一句话）' },
      },
      required: ['action'],
    },
    readOnly: true, // 只改内存看板，不改工作区文件（计划模式可用）
    approvalMode: 'auto',
    execute: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
      const board = ensureTeam(runOpts);
      const action = String(args.action ?? '');
      const self = ctx?.agentId ?? 'main';
      if (action === 'add') {
        const title = String(args.title ?? '').trim();
        if (!title) return '错误：action=add 需要 title';
        const t = board.addTask(title, typeof args.note === 'string' ? args.note : undefined);
        return `已新建任务 [${t.id}] ${t.title}（当前共 ${board.tasks.length} 项）`;
      }
      if (action === 'update' || action === 'claim') {
        const idOrTitle = String(args.id ?? '').trim();
        if (!idOrTitle) return `错误：action=${action} 需要 id（或标题）`;
        const patch: Record<string, unknown> = {};
        if (action === 'claim') patch.owner = typeof args.owner === 'string' && args.owner.trim() ? args.owner.trim() : self;
        if (typeof args.status === 'string' && STATUSES.includes(args.status as TeamTaskStatus)) patch.status = args.status;
        if (typeof args.owner === 'string') patch.owner = args.owner;
        if (typeof args.note === 'string') patch.note = args.note;
        const t = board.updateTask(idOrTitle, patch as never);
        if (!t) return `错误：未找到任务「${idOrTitle}」（用 list 查看全部）`;
        return `已更新 [${t.id}] ${t.title} → ${t.status}${t.owner ? ` · @${t.owner}` : ''}${t.note ? ` · ${t.note}` : ''}`;
      }
      if (action === 'list') {
        if (board.tasks.length === 0) return '任务看板为空（action=add 新建）';
        const lines = board.summaryLines();
        const done = board.tasks.filter((t) => t.status === 'completed').length;
        return `任务看板（${done}/${board.tasks.length} 完成）：\n${lines.join('\n')}`;
      }
      return `错误：未知 action「${action}」（add/update/claim/list）`;
    },
  };
}

export function createSendMessageTool(runOpts: RunOptions): Tool {
  return {
    name: 'send_message',
    description:
      '向主代理或其它子代理发送消息（异步投递）——用于多代理协作：worker 汇报关键发现/请求决策，' +
      '主代理下达补充指令。收方在下一步收到消息并据此调整；消息不阻塞当前执行。',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '接收方：main（主代理）或子代理 id/名（如 sub1）；* = 广播' },
        text: { type: 'string', description: '消息内容（简洁明确，含必要上下文）' },
      },
      required: ['to', 'text'],
    },
    readOnly: true,
    approvalMode: 'auto',
    execute: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
      const to = String(args.to ?? 'main').trim() || 'main';
      const text = String(args.text ?? '').trim();
      if (!text) return '错误：send_message 需要 text';
      const board = ensureTeam(runOpts);
      const from = ctx?.agentId ?? 'main';
      const m = board.send(from, to, text);
      return `消息已发送（#${m.id} ${from} → ${to}）`;
    },
  };
}

/**
 * TodoWrite 任务清单工具（P1，Claude Code 标配）：
 * 模型维护结构化 todo 列表（新建/更新/完成），用户实时看到任务进度。
 *
 * · 状态存 RunOptions.todoList（内存，会话级）
 * · 工具执行后返回确认 + 当前进度摘要（模型自我管理）
 * · /status 命令可查看当前 todo 进度
 */
import type { Tool } from './types.js';
import type { RunOptions } from '../agent/types.js';

export interface TodoItem {
  content: string;
  status: 'in_progress' | 'completed' | 'pending';
}

/** 创建 TodoWrite 工具（运行时注入 runOpts 引用） */
export function createTodoWriteTool(runOpts: RunOptions): Tool {
  return {
    name: 'todo_write',
    description:
      '维护当前任务的结构化待办清单（新建/更新/完成）。' +
      '适合多步骤任务：规划步骤时写入 todos（status=in_progress 表示当前步骤），' +
      '每完成一步更新为 completed 并推进下一步。' +
      '参数 todos 是完整清单（每次传全部项），内容用简洁任务描述。',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '任务描述（简短，如"运行测试"）' },
              status: { type: 'string', enum: ['in_progress', 'completed', 'pending'], description: '状态' },
            },
            required: ['content', 'status'],
          },
          description: '完整待办清单（每次传入全部项）',
        },
      },
      required: ['todos'],
    },
    async execute(args) {
      const raw = args.todos;
      if (!Array.isArray(raw)) return '错误：todos 必须是数组';
      const list: TodoItem[] = [];
      for (const t of raw) {
        if (!t || typeof t !== 'object') continue;
        const content = typeof (t as { content?: unknown }).content === 'string' ? (t as { content: string }).content : '';
        const status = (t as { status?: unknown }).status;
        const s = status === 'completed' || status === 'pending' ? status : 'in_progress';
        if (content.trim()) list.push({ content: content.trim(), status: s });
      }
      runOpts.todoList = list;
      runOpts.onTodo?.(list); // 实时回调（TUI 输入区上方 todo 小视图；未注入时静默跳过）
      const done = list.filter((t) => t.status === 'completed').length;
      const active = list.filter((t) => t.status === 'in_progress').length;
      const pending = list.filter((t) => t.status === 'pending').length;
      const summary = list.map((t, i) => `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '·'} ${i + 1}. ${t.content}`).join('\n');
      return `已更新任务清单（共 ${list.length} 项：完成 ${done} · 进行中 ${active} · 待办 ${pending}）：\n${summary}`;
    },
  };
}

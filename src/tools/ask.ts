/**
 * ask_user：向用户提问（agent 处理歧义/需要用户决策时）。
 *
 * 模型遇到「两难选择 / 多方案取舍 / 需要用户偏好」时调用：给出问题 + 2-6 个选项，
 * TUI 在输入区上方弹出**竖向勾选列表**（`[x]` 勾选、支持单选/多选、末尾自定义行
 * 键入内容），底部确认行（Enter/点击确认提交）。console 端 TTY 用 readline 询问。
 *
 * 交互语义（TUI 面板）：
 *   · ↑/↓ 移动高亮 · 空格 勾选/取消（多选可勾多个；单选自动互斥）
 *   · 自定义行（末尾）：高亮到该行后直接键入内容（实时显示在行内）
 *   · Enter / 点击「✓ 确认」提交 · Esc 取消
 * 非交互（管道）模式无法询问 → 返回取消（fail-safe，不阻塞任务）。
 *
 * 运行时注入（同 delegate 模式）：静态注册表不放该工具——execute 需要 askUser
 * 回调，由入口 attachRuntime 用 createAskUserTool(output.askUser) 组装进工具链。
 */
import type { Tool } from './types.js';

export interface AskResult {
  /** 用户的选择（多选时 = choices 的文本连接，如「A、B」；单选 = 单个文本） */
  choice: string;
  /** true = 包含自定义输入（choice/choices 中的最后一段为自定义内容） */
  custom: boolean;
  /** 全部勾选内容（选项文本 + 自定义输入，按面板顺序） */
  choices: string[];
}

/** 用户提问回调（ConsoleOutput / TuiOutput 实现 UI；null = 用户取消/无法交互） */
export type AskUserFn = (
  question: string,
  options: string[],
  multiple: boolean
) => Promise<AskResult | null>;

/** 创建 ask_user 工具（运行时注入 askUser 回调；未注入 = 非交互，返回无法询问） */
export function createAskUserTool(askUser: AskUserFn | undefined): Tool {
  return {
    name: 'ask_user',
    description:
      '向用户提问以消除歧义：当任务存在多种合理方案、需要用户偏好或决策时调用。' +
      '参数 question 是问题描述，options 提供 2-6 个可选方案；multiple=true 时用户可' +
      '勾选多个（默认单选），末尾恒有自定义输入项（用户可键入自己的答案）。' +
      '结果返回用户勾选的选项（多选为列表）+ 自定义输入（若有）。' +
      '注意：只有真正需要用户决策时才调用，不要为可自行判断的小事打扰用户。',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: '向用户提出的问题（一句话说清需要决策的内容）',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 6,
          description: '候选方案列表（2-6 个，每个一句话；面板末尾恒有自定义输入项）',
        },
        multiple: {
          type: 'boolean',
          description: '是否允许多选（默认 false = 单选；true = 用户可勾选多个选项）',
        },
      },
      required: ['question', 'options'],
    },
    async execute(args) {
      const question = String(args.question ?? '');
      const options = Array.isArray(args.options)
        ? args.options.map((o) => String(o)).filter(Boolean)
        : [];
      const multiple = args.multiple === true;
      if (!question || options.length < 2) {
        return '错误：ask_user 需要 question（非空）与至少 2 个 options';
      }
      if (!askUser) return '用户无法输入（当前非交互式会话）——请根据已有信息自行决定并继续';
      const r = await askUser(question, options.slice(0, 6), multiple);
      if (!r) return '用户取消了提问——请根据已有信息自行决定并继续';
      if (r.custom && r.choice) {
        return `用户选择了：${r.choice}（含自定义输入）`;
      }
      return r.choice ? `用户选择了选项：${r.choice}` : '用户未选择任何选项——请根据已有信息自行决定并继续';
    },
  };
}

/**
 * ask_user：向用户提问（agent 处理歧义/需要用户决策时）。
 *
 * 模型遇到「两难选择 / 多方案取舍 / 需要用户偏好」时调用：给出问题 + 2-6 个选项，
 * TUI 在输入区上方弹出选项面板（A/B/C/D 字母键勾选或输入自定义内容），结果作为
 * 工具结果回传——模型据此继续。console 端 TTY 用 readline 询问。
 *
 * 交互语义：
 *   · 选项字母键（a-d…）→ 选择对应选项
 *   · 输入任意文本 + Enter → 自定义输入（不限于选项）
 *   · Esc → 取消（返回「用户取消了提问」，模型自行处理）
 * 非交互（管道）模式无法询问 → 返回取消（fail-safe，不阻塞任务）。
 *
 * 运行时注入（同 delegate 模式）：静态注册表不放该工具——execute 需要 askUser
 * 回调，由入口 attachRuntime 用 createAskUserTool(output.askUser) 组装进工具链。
 */
import type { Tool } from './types.js';

export interface AskResult {
  /** 用户的选择：选项文本（custom=false）或自定义输入（custom=true） */
  choice: string;
  /** true = 自定义输入；false = 选择了提供的选项 */
  custom: boolean;
}

/** 用户提问回调（ConsoleOutput / TuiOutput 实现 UI；null = 用户取消/无法交互） */
export type AskUserFn = (question: string, options: string[]) => Promise<AskResult | null>;

/** 创建 ask_user 工具（运行时注入 askUser 回调；未注入 = 非交互，返回无法询问） */
export function createAskUserTool(askUser: AskUserFn | undefined): Tool {
  return {
    name: 'ask_user',
    description:
      '向用户提问以消除歧义：当任务存在多种合理方案、需要用户偏好或决策时调用。' +
      '参数 question 是问题描述，options 提供 2-6 个可选方案（用户可用 A/B/C/D 选择，' +
      '也可输入自定义答案）。结果返回用户的选择（选项文本或自定义输入）。' +
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
          description: '候选方案列表（2-6 个，每个一句话；用户也可不选这些而自定义输入）',
        },
      },
      required: ['question', 'options'],
    },
    async execute(args) {
      const question = String(args.question ?? '');
      const options = Array.isArray(args.options)
        ? args.options.map((o) => String(o)).filter(Boolean)
        : [];
      if (!question || options.length < 2) {
        return '错误：ask_user 需要 question（非空）与至少 2 个 options';
      }
      if (!askUser) return '用户无法输入（当前非交互式会话）——请根据已有信息自行决定并继续';
      const r = await askUser(question, options.slice(0, 6));
      if (!r) return '用户取消了提问——请根据已有信息自行决定并继续';
      return r.custom ? `用户自定义输入：${r.choice}` : `用户选择了选项：${r.choice}`;
    },
  };
}

/**
 * 会话标题生成：首轮对话结束后，用一次独立的轻量 LLM 调用概括对话主题。
 *
 * 设计要点：
 * - **不阻塞主流程**：runTuiInteractive 在首轮 runAgent 返回后 fire-and-forget，
 *   标题稍后到达（用户已在输入第二轮时标题悄悄出现）；
 * - **失败静默**：无 Key/网络错误/网关不支持 → 返回 null，标题不显示，不打扰对话；
 * - **独立请求**：不进入 messages 历史（标题是 UI 元数据，不该污染模型上下文）；
 * - **小 max_tokens**：只让模型输出标题本身（mock server 用 max_tokens ≤ 60
 *   识别标题请求并返回固定标题）。
 */
import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { visualWidth } from '../tui/width.js';

/** 标题系统提示：直接输出标题本身，不要任何解释/引号/标点结尾 */
const TITLE_SYSTEM_PROMPT =
  '你是会话标题生成器。根据下面的对话内容生成一个简洁的中文标题（概括主题，不超过 15 个字）。' +
  '只输出标题本身：不要引号、不要书名号、不要标点结尾、不要任何解释。';

/** 标题最大显示列宽（超长截断 + 省略号；CJK 全角算 2 列） */
const TITLE_MAX_COLS = 24;

/** 清洗模型输出的标题：去引号/换行/多余空白，按显示列宽截断 */
export function cleanTitle(raw: string): string | null {
  let t = raw.trim().replace(/^[\s"“”「」『』《》]+|[\s"“”「」『』《》]+$/g, '').replace(/\s+/g, ' ');
  t = t.replace(/[。.!！?？；;，,：:]+$/, ''); // 去掉结尾标点
  if (!t) return null;
  if (visualWidth(t) <= TITLE_MAX_COLS) return t;
  // 按列宽截断（不切代理对），省略号占 1 列
  const budget = TITLE_MAX_COLS - 1;
  let out = '';
  let cols = 0;
  for (const ch of t) {
    const w = visualWidth(ch);
    if (cols + w > budget) break;
    out += ch;
    cols += w;
  }
  return `${out}…`;
}

/**
 * 用首条用户消息 + 首条助手回答生成会话标题（fire-and-forget 调用方）。
 *
 * @returns 标题；任何失败返回 null（调用方静默忽略，不打扰对话）
 */
export async function generateSessionTitle(
  client: OpenAI,
  model: string,
  messages: ChatCompletionMessageParam[]
): Promise<string | null> {
  try {
    // 取首条用户消息与首条助手消息。注意：工具调用轮次的 assistant 消息 content 为
    // null/空——只取非空字符串正文，绝不把 JSON.stringify(null) 的 'null' 喂给标题模型
    const firstUser = messages.find((m) => m.role === 'user');
    const firstAssistant = messages.find((m) => m.role === 'assistant');
    const userText = firstUser && typeof firstUser.content === 'string' ? firstUser.content : '';
    const assistantText = firstAssistant && typeof firstAssistant.content === 'string' ? firstAssistant.content : '';
    const excerpt = [userText ? `用户：${userText}` : '', assistantText ? `助手：${assistantText}` : '']
      .filter(Boolean)
      .join('\n')
      .slice(0, 2000);

    // 流式请求（与主循环一致，兼容 mock server 与各家网关）；收集 content 增量
    const stream = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: TITLE_SYSTEM_PROMPT },
        { role: 'user', content: excerpt },
      ],
      max_tokens: 50,
      stream: true,
    });
    let text = '';
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta?.content ?? '';
    }
    return cleanTitle(text);
  } catch {
    return null; // 失败静默：标题是可选的 UI 增强，不能打扰对话
  }
}

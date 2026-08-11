/**
 * 交互模式：readline 循环，消息跨轮次保留（上下文连续）。
 * 支持 /exit、/clear、/help 命令。
 */
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { prepareContext } from '../agent/context.js';
import { runAgent } from '../agent/loop.js';
import type { RunOptions } from '../agent/types.js';
import type { Output } from '../output/types.js';
import { cyan, dim } from '../ui.js';
import { printHelp } from './args.js';

export async function runInteractive(
  client: OpenAI,
  model: string,
  messages: ChatCompletionMessageParam[],
  runOpts: RunOptions,
  out: Output
): Promise<void> {
  const rl = readline.createInterface({ input, output, prompt: cyan('omni> ') });
  // stdin 流结束（EOF）时接口会自动关闭，之后不能再调 prompt，这里做安全守卫
  const safePrompt = () => {
    try {
      rl.prompt();
    } catch {
      /* 接口已关闭，忽略 */
    }
  };
  console.log('输入任务开始；/exit 退出，/help 查看帮助。');
  safePrompt();
  for await (const line of rl) {
    const cmd = line.trim();
    if (cmd === '/exit') break;
    if (cmd === '/clear') {
      messages.length = 0;
      console.log(dim('（已清空上下文，开始新一轮对话）'));
      safePrompt();
      continue;
    }
    if (cmd === '/help') {
      printHelp();
      safePrompt();
      continue;
    }
    if (!cmd) {
      safePrompt();
      continue;
    }
    messages.push({ role: 'user', content: cmd });
    out.onUserMessage(cmd);
    // 上下文管理：首轮预载相关文件 + 长对话摘要压缩（选项由入口注入 runOpts.context）
    await prepareContext(client, model, messages, runOpts.context ?? {});
    await runAgent(client, model, messages, runOpts, out);
    out.onTurnEnd();
    safePrompt();
  }
  rl.close();
}

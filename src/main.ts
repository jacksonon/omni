/**
 * 共享主流程：参数解析、配置加载、客户端构建、单次任务 / 交互模式调度。
 *
 * 输出端通过 makeOutput(cfg) 工厂注入：
 * - index.ts（console 入口）→ ConsoleOutput
 * - tui-entry.tsx（TUI 入口）→ TuiOutput
 *
 * 用法：
 *   omni "<任务描述>"              单次执行一个任务
 *   omni -m deepseek-chat "任务"   指定模型
 *   omni                          进入交互模式（/exit 退出，/help 查看帮助）
 */
import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { runAgent } from './agent/loop.js';
import type { RunOptions } from './agent/types.js';
import { runInteractive } from './cli/interactive.js';
import { parseArgs, printHelp } from './cli/args.js';
import { loadConfig, type ConfigOverrides, type OmniConfig } from './config/index.js';
import type { Output } from './output/types.js';
import { tools } from './tools/index.js';
import { red } from './ui.js';
import { VERSION } from './version.js';

// 抑制第三方依赖（openai SDK 等）触发的 Node 过时 API 警告，保持终端干净
process.removeAllListeners('warning');

/** Agent 运行所需的共享上下文（配置 + 客户端 + 消息 + 运行选项） */
export interface RunContext {
  cfg: OmniConfig;
  client: OpenAI;
  messages: ChatCompletionMessageParam[];
  runOpts: RunOptions;
}

/**
 * 解析配置并构建客户端（console 入口与 TUI 入口共用，避免重复逻辑）。
 *
 * 抛错而非 process.exit：让入口层决定如何清理（TUI 需先退出全屏再报错）。
 */
export function prepareRun(overrides: ConfigOverrides): RunContext {
  const cfg = loadConfig(overrides);
  if (!cfg.apiKey) {
    throw new Error(
      `未找到 API Key。设置方式：
  · 配置文件 omni.json / omni.jsonc 的 "apiKey" 字段
  · 环境变量 OMNI_API_KEY（或 OPENAI_API_KEY）
更多帮助见 omni --help`
    );
  }

  // timeout/maxRetries：端点不可达时快速失败（SDK 默认单请求超时 10 分钟 + 多次重试，会长时间无反馈）
  // defaultHeaders：部分网关 WAF 拦截 SDK 默认 UA，配置 userAgent 可绕过
  const client = new OpenAI({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseURL,
    timeout: 60_000,
    maxRetries: 1,
    ...(cfg.userAgent ? { defaultHeaders: { 'user-agent': cfg.userAgent } } : {}),
  });
  const messages: ChatCompletionMessageParam[] = [];
  const runOpts: RunOptions = { tools, stream: true, maxSteps: cfg.maxSteps, showThinking: cfg.showThinking };
  return { cfg, client, messages, runOpts };
}

export async function main(makeOutput: (cfg: OmniConfig) => Output): Promise<void> {
  const { taskArgs, overrides, help, version } = parseArgs(process.argv.slice(2));
  if (help) {
    printHelp();
    return;
  }
  if (version) {
    console.log(`omni v${VERSION}`);
    return;
  }

  const { cfg, client, messages, runOpts } = prepareRun(overrides);
  const output = makeOutput(cfg);
  output.banner(cfg);

  const singleTask = taskArgs.join(' ').trim();
  if (singleTask) {
    // 单次任务模式：Ctrl+C 清掉 spinner 行后退出（交互模式保留 readline 默认的清行行为）
    // TUI 模式由渲染器自行处理 Ctrl+C（output.exitOnCtrlC），这里跳过避免打断全屏退出清理
    if (!output.exitOnCtrlC) {
      process.on('SIGINT', () => {
        process.stderr.write('\n');
        process.exit(130);
      });
    }
    messages.push({ role: 'user', content: singleTask });
    await runAgent(client, cfg.model, messages, runOpts, output);
    return;
  }

  await runInteractive(client, cfg.model, messages, runOpts, output);
}

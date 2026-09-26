/**
 * omni mini：纯终端 CLI 模式（Codex CLI 形态）。
 *
 * 复用 runInteractive（全部斜杠命令 / 审批 / 会话持久化 / 撤销栈 / 命令面板）与
 * runAgent，只换渲染层（MiniOutput）+ 追加 Ctrl+T 快捷键——mini 的工具输出默认
 * 只显示前 3 行，`+N lines (ctrl+t to view transcript)` 指的就是这里：Ctrl+T 打印
 * 完整轨迹账本（agent/trace.ts 的事件折叠投影，与 /trace 同一数据源）。
 */
import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { runAgent } from '../agent/loop.js';
import { buildTraceTextLines } from '../agent/trace.js';
import type { RunOptions } from '../agent/types.js';
import { MiniOutput, TRANSCRIPT_HINT } from '../output/mini.js';
import type { Output } from '../output/types.js';
import { bold, dim } from '../ui.js';
import { runInteractive } from './interactive.js';

/** stdin 的 keypress 事件类型（readline 接口激活后由解码器派发） */
type KeypressHandler = (str: string, key: { name?: string; ctrl?: boolean }) => void;

/** stdin 的最小接口（避免依赖 Node 类型里 keypress 重载的存在与否） */
interface KeypressStream {
  isTTY?: boolean;
  on(event: 'keypress', listener: KeypressHandler): void;
  off(event: 'keypress', listener: KeypressHandler): void;
}

/**
 * 安装 Ctrl+T 轨迹账本快捷键（返回卸载函数）。
 * 只挂在 TTY 上：readline.createInterface 会激活 keypress 解码器，这里只订阅。
 * 打印时机可能落在用户正在输入的行上，readline 在下一次按键时会重绘该行。
 */
function installTranscriptViewer(runOpts: RunOptions): () => void {
  const stdin = process.stdin as unknown as KeypressStream;
  if (!stdin.isTTY) return () => {};
  const onKey: KeypressHandler = (_str, key) => {
    if (!key?.ctrl || key.name !== 't') return;
    const events = runOpts.events?.events ?? [];
    const stream = process.stdout;
    stream.write('\n\n'); // 与上一单元格留空行（弹在当前输入行下方）
    if (events.length === 0) {
      stream.write(`  ${dim('暂无轨迹——开始对话后这里会记录每一轮请求/工具/消息')}\n`);
      return;
    }
    stream.write(`  ${dim(`完整轨迹（${events.length} 条事件 · ${TRANSCRIPT_HINT} 对应此处）：`)}\n`);
    for (const line of buildTraceTextLines(events, { full: true })) stream.write(`  ${dim(line)}\n`);
    stream.write('\n');
  };
  stdin.on('keypress', onKey);
  return () => stdin.off('keypress', onKey);
}

/** 交互模式主循环（`omni mini`；渲染层为 MiniOutput） */
export async function runMiniInteractive(
  client: OpenAI,
  model: string,
  messages: ChatCompletionMessageParam[],
  runOpts: RunOptions,
  out: Output
): Promise<void> {
  const uninstall = installTranscriptViewer(runOpts);
  // 交互模式：渲染层据此擦掉 readline 回显的输入行（避免输入显示两遍）
  if (out instanceof MiniOutput) out.markInteractive();
  try {
    // intro 由 mini 自己接管（banner 的 Tip 行），内置「输入任务开始…」提示跳过
    await runInteractive(client, model, messages, runOpts, out, {
      intro: false,
      prompt: bold('› '),
      // 把 readline 句柄交给渲染层：轮内输出经它重画 › 输入行（见 MiniOutput 输出协作）
      onRl: (rl) => {
        if (out instanceof MiniOutput) out.attachInput(rl);
      },
    });
  } finally {
    uninstall();
  }
}

/** 单次任务（`omni mini "<任务>"`）：回显输入 + 同一渲染层 + 回合耗时线，跑完即退出 */
export async function runMiniOneShot(
  client: OpenAI,
  model: string,
  messages: ChatCompletionMessageParam[],
  runOpts: RunOptions,
  out: Output,
  prompt: string
): Promise<void> {
  out.onUserMessage(prompt);
  await runAgent(client, model, messages, runOpts, out);
  out.onTurnEnd();
}

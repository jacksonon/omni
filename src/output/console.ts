/**
 * ConsoleOutput：命令行输出实现（Node / bun / 管道模式通用）。
 *
 * 行为与重构前的直接输出完全一致：
 * - 思考：浅灰实时流式 + 保留在屏幕（不折叠）
 * - 工具步骤：→ [n/max] 工具(参数) + ✓/✗ 返回 N 字符
 * - 管道模式（非 TTY）：思考不内联，仅提示落盘路径；颜色自动禁用
 */
import { printBanner } from '../cli/banner.js';
import { printHelp } from '../cli/args.js';
import type { OmniConfig } from '../config/index.js';
import type { ThinkingDisplay } from '../agent/types.js';
import { createThinkingDisplay } from '../agent/thinking.js';
import { createSpinner, cyan, dim, green, isTTY, red, yellow, type Spinner } from '../ui.js';
import type { Output } from './types.js';

export interface ConsoleOutputOptions {
  /** 是否展示思考过程（来自配置 showThinking） */
  showThinking: boolean;
  /** 是否流式输出正文与步骤（管道模式为 false 时保持输出可控） */
  stream: boolean;
}

export class ConsoleOutput implements Output {
  readonly thinking: ThinkingDisplay;
  private spinner: Spinner | null = null;

  constructor(private opts: ConsoleOutputOptions) {
    this.thinking = createThinkingDisplay(opts.showThinking);
  }

  banner(cfg: OmniConfig): void {
    printBanner(cfg);
  }

  onRound(step: number, maxSteps: number): void {
    this.spinner = createSpinner(`思考中…（第 ${step + 1} 轮）`);
  }

  onStreamStart(): void {
    this.spinner?.stop();
    this.spinner = null;
  }

  onAnswer(text: string): void {
    if (this.opts.stream) process.stdout.write(text);
  }

  onAnswerEnd(): void {
    if (this.opts.stream) process.stdout.write('\n');
  }

  onRequestFailed(err: unknown): void {
    this.spinner?.stop(red('✗ 请求失败'));
    this.spinner = null;
  }

  onThinkingSaved(len: number, file: string | null): void {
    // 管道模式（非 TTY）下思考不内联显示，提示已落盘便于回溯
    if (this.opts.showThinking && !isTTY && this.opts.stream) {
      console.log(dim(`💭 思考过程（${len} 字符）→ ${file ?? '.omni/last-thinking.md'}`));
    }
  }

  onToolStep(step: number, maxSteps: number, name: string, argsPreview: string): void {
    if (this.opts.stream) {
      console.log(`\n  ${cyan('→')} ${dim(`[${step + 1}/${maxSteps}]`)} ${cyan(name)}(${dim(argsPreview)})`);
    }
  }

  onToolResult(ok: boolean, chars: number): void {
    if (this.opts.stream) {
      console.log(`  ${ok ? green('✓') : red('✗')} ${dim(`返回 ${chars} 字符`)}`);
    }
  }

  onMaxSteps(max: number): void {
    console.log(`\n${yellow('⚠️ 已达到最大步数')}（${max}），任务可能未完成。可增大 OMNI_MAX_STEPS 重试。`);
  }

  onUserMessage(text: string): void {
    console.log(`${cyan('❯')} ${text}`);
  }

  onTurnEnd(): void {
    console.log('');
  }

  onWaitForInput(): void {
    // readline 提示符即等待输入，无需额外提示
  }

  clearScrollback(): void {
    // console 交互模式不清屏，仅清上下文
  }

  showHelp(): void {
    printHelp();
  }
}

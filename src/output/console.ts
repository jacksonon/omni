/**
 * ConsoleOutput：命令行输出实现（Node / bun / 管道模式通用）。
 *
 * - 思考：浅灰实时流式 + 保留在屏幕（不折叠）
 * - 工具调用：画成圆角方框卡片（与 TUI 同款）——步骤时开框显示 ⏳ 执行中，
 *   结果到达后填入输出预览并收框；console 无点击交互，展开/收起不适用，
 *   采用「执行中开框 → 完成后输出直接进框」的静态展开形态
 * - 管道模式（非 TTY）：思考不内联，仅提示落盘路径；颜色自动禁用
 */
import readline from 'node:readline/promises';
import { stdin as input, stderr as errOut } from 'node:process';
import { printBanner } from '../cli/banner.js';
import { printHelp } from '../cli/args.js';
import type { OmniConfig } from '../config/index.js';
import type { ThinkingDisplay } from '../agent/types.js';
import { createThinkingDisplay } from '../agent/thinking.js';
import type { ApprovalRequest } from '../safety/index.js';
import { createSpinner, dim, isTTY, red, yellow, type Spinner } from '../ui.js';
import { cardBottomLine, cardContentLine, cardSepLine, wrapText } from './format.js';
import type { Output, TokenUsage } from './types.js';

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

  banner(cfg: OmniConfig, toolNames?: string[]): void {
    printBanner(cfg, toolNames);
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

  onUsage(_usage: TokenUsage): void {
    // console 无 footer 展示位，忽略（token 用量仅 TUI 展示）
  }

  onRequestFailed(err: unknown): void {
    this.spinner?.stop(red('✗ 请求失败'));
    this.spinner = null;
    // 打印实际错误（401/网络/端点等），用户才能知道修什么（发消息闪退的排查线索）
    console.log(red(`✗ ${(err as Error)?.message ?? String(err)}`));
  }

  onThinkingSaved(len: number, file: string | null): void {
    // 管道模式（非 TTY）下思考不内联显示，提示已落盘便于回溯
    if (this.opts.showThinking && !isTTY && this.opts.stream) {
      console.log(dim(`💭 思考过程（${len} 字符）→ ${file ?? '.omni/last-thinking.md'}`));
    }
  }

  /** 当前打开的卡片框内容宽（结果到达时续填收框） */
  private boxInner: number | null = null;
  /** 管道模式暂存的命令摘要（无光标控制，结果到达时一次成框，避免 ⏳ 与结果叠放） */
  private boxStep: string | null = null;

  /** 终端可见列数（管道模式无 columns → 80 兜底） */
  private termInner(): number {
    const cols = (process.stdout as { columns?: number }).columns ?? 80;
    return Math.max(2, cols - 6); // 左缩进 2 + 两侧边框 2×2
  }

  onToolStep(step: number, maxSteps: number, name: string, argsPreview: string): void {
    if (!this.opts.stream) return;
    const inner = this.termInner();
    this.boxInner = inner;
    if (isTTY) {
      // TTY：先开框（顶边 + 命令 + ⏳ 执行中），结果到达时原位收口（见 onToolResult）
      console.log(`\n  ${`╭${'─'.repeat(inner)}╮`}`);
      for (const seg of wrapText(argsPreview, inner - 1)) console.log(`  ${cardContentLine(seg, inner)}`);
      console.log(`  ${dim(cardContentLine('⏳ 执行中…', inner))}`);
    } else {
      // 管道：无光标控制，暂存命令，等结果一次成框
      this.boxStep = argsPreview;
    }
  }

  onToolResult(ok: boolean, chars: number, preview?: string[]): void {
    if (!this.opts.stream) return;
    const inner = this.boxInner ?? this.termInner();
    this.boxInner = null;
    const stepCmd = this.boxStep;
    this.boxStep = null;
    if (isTTY) {
      // 原位收口：光标上移 1 行 + 清行，把「⏳ 执行中…」替换为结果块（框原地长高）
      process.stdout.write('\x1b[1A\x1b[K');
    } else if (stepCmd != null) {
      // 管道：补开框（顶边 + 命令）
      console.log(`\n  ${`╭${'─'.repeat(inner)}╮`}`);
      for (const seg of wrapText(stepCmd, inner - 1)) console.log(`  ${cardContentLine(seg, inner)}`);
    }
    console.log(`  ${dim(cardContentLine(ok ? `✓ 执行成功 · ${chars} 字符` : '✗ 执行失败', inner))}`);
    console.log(`  ${dim(cardSepLine(inner))}`);
    for (const line of preview ?? []) {
      for (const seg of wrapText(line, inner - 1)) console.log(`  ${dim(cardContentLine(seg, inner))}`);
    }
    console.log(`  ${cardBottomLine(inner)}`);
  }

  onMaxSteps(max: number): void {
    console.log(`\n${yellow('⚠️ 已达到最大步数')}（${max}），任务可能未完成。可增大 OMNI_MAX_STEPS 重试。`);
  }

  onUserMessage(text: string): void {
    console.log(text);
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

  /**
   * 工具调用审批（安全护栏）：TTY 下用 readline 在 stderr 询问（不污染 stdout 管道），
   * y/回车 = 允许，其余 = 拒绝；非 TTY（管道）自动拒绝（fail-safe）。
   * 并行工具调用的多个审批通过 promise 链串行（readline 接口不并发）。
   */
  private approvalTail: Promise<void> = Promise.resolve();
  requestApproval(req: ApprovalRequest): Promise<boolean> {
    let resolveMe!: (b: boolean) => void;
    const p = new Promise<boolean>((r) => (resolveMe = r));
    this.approvalTail = this.approvalTail.then(async () => {
      try {
        resolveMe(await this.promptApproval(req));
      } catch {
        resolveMe(false); // 审批异常 → fail-safe 拒绝
      }
    });
    return p;
  }

  private async promptApproval(req: ApprovalRequest): Promise<boolean> {
    if (!isTTY) return false; // 管道模式自动拒绝（无法交互）
    const rl = readline.createInterface({ input, output: errOut });
    try {
      const ans = await rl.question(
        `\n${yellow('⚠️ 需要审批')} ${req.tool}\n  ${req.summary}\n  ${dim(req.reason)}\n  批准执行？[y/N] `
      );
      return /^y/i.test(ans.trim());
    } finally {
      rl.close();
    }
  }
}

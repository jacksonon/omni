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
import type { HookEventName } from '../hooks/index.js';
import type { ThinkingDisplay } from '../agent/types.js';
import { createThinkingDisplay } from '../agent/thinking.js';
import type { ApprovalRequest } from '../safety/index.js';
import type { AskResult } from '../tools/ask.js';
import { createSpinner, cyan, dim, isTTY, red, yellow, type Spinner } from '../ui.js';
import { cardBottomLine, cardContentLine, cardSepLine, countDiffLines, isExitCodeZeroLine, wrapText } from './format.js';
import type { Output, TokenUsage, ToolResultDetail } from './types.js';

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

  onToolStep(step: number, maxSteps: number, name: string, argsPreview: string, _args?: Record<string, unknown>): void {
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

  onToolResult(ok: boolean, chars: number, preview?: string[], detail?: ToolResultDetail): void {
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
    // write_file：改动摘要行（新增 N 行 / 修改 +A −D 行；细节对比见 TUI 卡片展开）
    if (detail?.diff) {
      const d = detail.diff;
      const line =
        d.original === null
          ? `新增文件 · 全文 ${d.content.split('\n').length} 行`
          : (() => {
              const st = countDiffLines(d.original, d.content);
              return `修改 · +${st.add} −${st.rem} 行`;
            })();
      console.log(`  ${dim(cardContentLine(line, inner))}`);
    }
    console.log(`  ${dim(cardSepLine(inner))}`);
    // 展示层过滤「退出码: 0」行（成功已由 ✓ 传达，用户要求不显示；完整结果仍回传模型）
    for (const line of (preview ?? []).filter((l) => !isExitCodeZeroLine(l))) {
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

  /** hooks 输出回显（生命周期自动化）：dim 行打印到 stdout（不改写流程，仅提示） */
  onHookOutput(event: HookEventName, lines: string[]): void {
    if (!this.opts.stream) return;
    for (const l of lines) console.log(dim(`⚡ hook[${event}] ${l}`));
  }

  /** 子代理进度事件（第六节 P1 可视化）：dim 行打印到 stderr（不污染 stdout 结果/管道） */
  onSubagentEvent(ev: import('../agent/types.js').SubagentEvent): void {
    if (!this.opts.stream) return;
    const indent = '  '.repeat(ev.depth);
    if (ev.type === 'start') {
      console.log(dim(`${indent}⠙ 子代理 ${ev.name} 开始：${(ev.task ?? '').split('\n')[0]}`));
    } else if (ev.type === 'step') {
      // step 事件带当前动作（工具名，执行前补发）：`子代理 X · ⠙ run_command 3/10`
      console.log(dim(`${indent}⠙ 子代理 ${ev.name} · ${ev.tool ?? '思考中'} ${ev.step}/${ev.maxSteps}`));
    } else {
      console.log(
        dim(`${indent}${ev.status === 'ok' ? '✓' : '✗'} 子代理 ${ev.name} 完成 · ${ev.steps} 步 · ${((ev.durationMs ?? 0) / 1000).toFixed(1)}s`)
      );
    }
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

  /**
   * 向用户提问（ask_user 工具）：TTY 下用 readline 打印问题 + 竖向选项列表，
   * 输入选项序号（单选 1 个 / 多选逗号分隔）或自定义文本，Enter 确认；空 = 取消；
   * 非 TTY（管道）返回 null（无法交互）。串行队列与审批一致（readline 不并发）。
   */
  private askTail: Promise<void> = Promise.resolve();
  askUser(question: string, options: string[], multiple: boolean): Promise<AskResult | null> {
    let resolveMe!: (r: AskResult | null) => void;
    const p = new Promise<AskResult | null>((r) => (resolveMe = r));
    this.askTail = this.askTail.then(async () => {
      try {
        resolveMe(await this.promptAskUser(question, options, multiple));
      } catch {
        resolveMe(null); // 提问异常 → 视为取消（不阻塞任务）
      }
    });
    return p;
  }

  private async promptAskUser(question: string, options: string[], multiple: boolean): Promise<AskResult | null> {
    if (!isTTY) return null; // 管道模式无法交互
    const rl = readline.createInterface({ input, output: errOut });
    try {
      const lines = options.map((o, i) => `  ${i + 1}. ${o}`);
      const ans = await rl.question(
        `\n${cyan('❓')} ${question}（${multiple ? '多选' : '单选'}）\n${lines.join('\n')}\n  ${dim('自定义：直接输入内容')}\n  输入选项序号${multiple ? '（逗号分隔可多选）' : ''}或自定义文本，回车确认；空输入取消：`
      );
      const t = ans.trim();
      if (!t) return null; // 空输入 = 取消
      // 纯数字/逗号 = 选项序号（多选逗号分隔）；其它 = 自定义输入
      if (/^[\d,\s]+$/.test(t)) {
        const idxs = [...new Set(t.split(/[,，\s]+/).map((s) => parseInt(s, 10)).filter((n) => n >= 1 && n <= options.length))];
        if (idxs.length === 0) return { choice: t, custom: true, choices: [t] };
        const picked = idxs.map((i) => options[i - 1]!);
        return { choice: picked.join('、'), custom: false, choices: picked };
      }
      return { choice: t, custom: true, choices: [t] };
    } finally {
      rl.close();
    }
  }
}

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
import { bold, createSpinner, cyan, dim, green, isTTY, red, yellow, type Spinner } from '../ui.js';
import { cardBottomLine, cardContentLine, cardSepLine, countDiffLines, editToUnifiedDiff, isExitCodeZeroLine, unifiedDiff, wrapText } from './format.js';
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

  /** fallback 回退成功（P0）：dim 行提示（回退已生效，仅告知） */
  onFallback(model: string): void {
    console.log(dim(`↩ 已回退到备用模型 ${model}`));
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

  /** 当前工具调用类型与参数，用于差异化渲染 */
  private currentTool: { name: string; preview: string; args?: Record<string, unknown> } | null = null;

  onToolStep(step: number, maxSteps: number, name: string, argsPreview: string, args?: Record<string, unknown>): void {
    if (!this.opts.stream) return;
    this.currentTool = { name, preview: argsPreview, args };
    const inner = this.termInner();
    this.boxInner = inner;

    if (name === 'read_file') {
      console.log(`\n  ${dim('→ Explored — 1 read')}`);
      return;
    }

    if (name === 'search_code' || name === 'list_directory') {
      console.log(`\n  ${dim('→ Explored — 1 search')}`);
      return;
    }

    if (name === 'web_fetch') {
      console.log(`\n  ${dim('→ Explored — 1 fetch')}`);
      return;
    }

    if (name === 'write_file' || name === 'edit_file') {
      console.log(`\n  ${bold(argsPreview)}\n`);
      return;
    }

    if (name === 'run_command') {
      console.log(`\n  ${green('●')} ${bold('Bash')}${dim(argsPreview.replace(/^●\s*Bash/, ''))}`);
      return;
    }

    if (isTTY) {
      // TTY：常规工具开框（顶边 + 命令 + ⏳ 执行中），结果到达时原位收口
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
    const tool = this.currentTool;
    this.currentTool = null;

    if (tool?.name === 'read_file') {
      // 图 1 风格：read 工具执行后无需额外方框
      return;
    }

    if (tool?.name === 'search_code') {
      // 图 1 风格：输出 * Grep "..." in ... (N matches)
      let matches = 0;
      if (preview && preview.length) {
        const first = preview[0] ?? '';
        const m = first.match(/(\d+)\s*处/);
        if (m) matches = parseInt(m[1], 10);
        else matches = preview.filter((l) => l.trim() && !l.startsWith('…') && !l.includes('匹配结果')).length;
      }
      const matchSuffix = matches > 0 ? ` (${matches} match${matches > 1 ? 'es' : ''})` : ' (0 matches)';
      console.log(`  ${dim(tool.preview + matchSuffix)}`);
      return;
    }

    if (tool?.name === 'list_directory') {
      // 图 1 风格：输出 📁 path (N items)
      let count = 0;
      if (preview && preview.length) {
        const first = preview[0] ?? '';
        const m = first.match(/(\d+)\s*个/);
        if (m) count = parseInt(m[1], 10);
        else count = preview.filter((l) => l.trim() && !l.startsWith('…')).length;
      }
      const countSuffix = count > 0 ? ` (${count} item${count > 1 ? 's' : ''})` : '';
      console.log(`  ${dim(tool.preview + countSuffix)}`);
      return;
    }

    if (tool?.name === 'write_file' || tool?.name === 'edit_file') {
      // 图 2 风格：输出带行号和红绿背景的高亮 unified diff
      const diffData = detail?.diff
        ? unifiedDiff(detail.diff.original, detail.diff.content)
        : detail?.edit
          ? editToUnifiedDiff(detail.edit.oldLines, detail.edit.newLines)
          : null;

      if (diffData && diffData.lines.length > 0) {
        const maxNo = diffData.lines.reduce((m, l) => Math.max(m, l.oldNo ?? 0, l.newNo ?? 0), 0);
        const digits = Math.max(3, String(maxNo).length);
        for (const dl of diffData.lines) {
          const noStr = dl.kind === 'rem' ? (dl.oldNo != null ? String(dl.oldNo) : '') : (dl.newNo != null ? String(dl.newNo) : dl.oldNo != null ? String(dl.oldNo) : '');
          const padNo = noStr.padStart(digits, ' ');
          if (dl.kind === 'rem') {
            const line = `  ${padNo} -  ${dl.text}`;
            console.log(isTTY ? `\x1b[48;5;52m\x1b[38;5;203m${line}\x1b[0m` : line);
          } else if (dl.kind === 'add') {
            const line = `  ${padNo} +  ${dl.text}`;
            console.log(isTTY ? `\x1b[48;5;22m\x1b[38;5;120m${line}\x1b[0m` : line);
          } else {
            const line = `  ${dim(padNo)}     ${dl.text}`;
            console.log(line);
          }
        }
        if (diffData.truncated) {
          console.log(`  ${dim('…（diff 超长，已截断）')}`);
        }
      }
      return;
    }

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
    // 展示层过滤「退出码: 0」行（成功已由 ✓ 传达，用户要求不显示；完整结果仍回传模型）
    for (const line of (preview ?? []).filter((l) => !isExitCodeZeroLine(l))) {
      for (const seg of wrapText(line, inner - 1)) console.log(`  ${dim(cardContentLine(seg, inner))}`);
    }
    console.log(`  ${cardBottomLine(inner)}`);
  }

  onMaxSteps(max: number): void {
    console.log(`\n${yellow('⚠️ 已达到最大步数')}（${max}），任务可能未完成。可增大 OMNI_MAX_STEPS 重试。`);
  }

  /**
   * run_command 实时输出：dim 行写到 stderr（不污染 stdout 管道结果）。
   * 累积一个 ring buffer（最多 8 行）写到卡片框下；新行超出时把最早的顶出。
   * 不在卡片上原地刷新（console 终端控制能力有限），改用"持续 dim 行追加"——
   * 用户感受是命令在持续输出（远比"卡半天不出"好）；最终结果由 onToolResult 收尾。
   */
  private liveOutLines: string[] = [];
  onCommandOutput(chunk: string, isError: boolean, _toolSeq?: number): void {
    if (!this.opts.stream || !isTTY) return; // 管道模式：忽略实时（最终结果仍回传）
    // chunk 已经是单行（run_command 内部按 \n 拆好）；按 \n 再切一次防御
    for (const line of chunk.split('\n')) {
      if (!line) continue;
      this.liveOutLines.push(line);
      if (this.liveOutLines.length > 8) this.liveOutLines.shift();
      // 写到 stderr：dim 灰，前缀 `│` 与卡片右边框呼应
      process.stderr.write(`  ${dim('│ ' + line)}\n`);
    }
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

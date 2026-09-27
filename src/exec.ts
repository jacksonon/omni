/**
 * Headless 执行模式（`omni exec`）+ MCP server 模式（`omni mcp-server`）：
 * 把 omni 变成可组合的 Unix 命令（对标 `codex exec` / `claude -p`）。
 *
 * `omni exec "<任务>"`：
 *   · --json：事件 JSONL（codex --json 对等；即 stream-json）。
 *   · stdout 只输出最终结果；进度（思考/工具调用/错误）走 stderr —— 可 `| jq` / `> file` 安全重定向
 *   · --output-format text|json|stream-json：
 *       text        —— 最终回答纯文本
 *       json        —— 单对象 { result, cost_usd, duration_ms, num_turns, session_id, exit_code }
 *       stream-json —— 每行一个轨迹事件 `{"t":"ev","e":{...}}`（复用 events.ts 的 ev 序列），
 *                      最后一行 `{"t":"result", ...}` —— 下游 tail -1 即得结构化结果
 *   · stdin 两种形态：任务为 `-` = 整段 stdin 即 prompt；任务非空且 stdin 被管道 → 注入为上下文
 *   · --max-turns N    —— 步数上限（超出 → 非零退出；管道可 &&/|| 分支）
 *   · --allowed-tools  —— 工具白名单（纯工具过滤，复用 /plan 只读过滤语义）
 *   · --output-schema  —— 最终回答强制符合 JSON Schema（内联 JSON 或文件路径；不符 → 非零退出）
 *   · exit code：0 = 正常完成；1 = 请求失败 / 触达步数上限 / schema 校验失败
 *   · 会话持久化：每次执行落盘 JSONL 会话（json 输出带 session_id），`exec resume <id>` 续跑
 *
 * `omni mcp-server`：stdio JSON-RPC 暴露 `omni_exec` / `omni_reply` 两个工具，
 * 让 Claude Code / opencode 等外部 harness 把 omni 当子代理用（协议与 tools/mcp.ts 客户端对称）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import {
  collectImageAttachments,
  loadImageAttachment,
  MAX_IMAGE_FILES,
  prepareContext,
  userMessageWithImages,
  type ImageAttachment,
} from './agent/context.js';
import { runAgent } from './agent/loop.js';
import { EventRecorder, type TrajEvent } from './agent/events.js';
import { appendSessionMessages, createSession, finalizeSession, findSessionById, latestSession, listSessions, loadSession, persistableMessages } from './agent/session.js';
import { forkSession } from './agent/session-fork.js';
import { captureCommand, collectDiff, detectCheckCommand, reviewCode } from './agent/review.js';
import type { RunOptions, ThinkingDisplay } from './agent/types.js';
import type { ConfigOverrides } from './config/index.js';
import { attachRuntime, prepareRun, type RunContext } from './main.js';
import type { Output, TokenUsage } from './output/types.js';
import { dim, parseColorMode, red, setColorOverride, yellow, type ColorMode } from './ui.js';
import { VERSION } from './version.js';

/* ─────────────────────────────── 参数解析 ─────────────────────────────── */

export type ExecOutputFormat = 'text' | 'json' | 'stream-json';

export interface ExecParseResult {
  /** 原始任务文本（'-' = 从 stdin 读整段 prompt；在 runExec 内异步解析） */
  promptRaw: string;
  /** `exec resume <id>` 或 `--resume <id>`：恢复的会话 id */
  resumeId: string | null;
  /** `--last`：恢复当前目录最近一次会话（codex exec resume --last 对等；无会话时报错） */
  resumeLast: boolean;
  /** `--all`：最近会话取消目录过滤（codex resume --all 对等；配 --last 用） */
  resumeAll: boolean;
  /** `exec fork <id>`：分叉源会话 id（codex exec fork 对等） */
  forkId: string | null;
  /** `exec fork --last`：分叉当前目录最近一次会话 */
  forkLast: boolean;
  /** `exec review [额外要求]`：非交互代码审查（codex exec review 对等；轻量单请求，不建会话） */
  reviewMode: boolean;
  /** `exec review --base <分支>`：相对该分支审查工作区改动（codex --base 对等） */
  reviewBase?: string;
  /** `exec review --commit <SHA>`：审查某提交引入的改动（codex --commit 对等；与 --base 互斥） */
  reviewCommit?: string;
  /** `exec review --title <标题>`：审查对象标题（codex --title 对等；展示进审查摘要上下文） */
  reviewTitle?: string;
  outputFormat: ExecOutputFormat;
  /** --max-turns：步数上限（超出 → 非零退出） */
  maxTurns?: number;
  /** --allowed-tools：逗号分隔的工具白名单（纯工具过滤） */
  allowedTools?: string[];
  /** --output-schema：最终回答须符合的 JSON Schema（内联 JSON 或文件路径） */
  outputSchema?: Record<string, unknown>;
  /** --model/-m：模型覆盖（runExec 合并进 overrides 再 prepareRun，与全局 -m 同效） */
  model?: string;
  /** -i/--image <文件>（可重复）：显式图片附件（codex exec -i 对等；与 @图.png 提及合并去重） */
  images: string[];
  /** --quiet/-q：静默 stderr 进度（只留 stdout 结果） */
  quiet?: boolean;
  /** --approve-for-me：AI 自动审批（模型审阅需要审批的操作；失败回退拒绝） */
  approveForMe?: boolean;
  /** -o/--output-last-message <文件>：最终回答落盘（codex exec 同款；写失败非零退出） */
  outputLastMessage?: string | null;
  /** --color <always|never|auto>：颜色开关（codex exec --color 对等；缺省 auto 跟随终端/环境变量） */
  color?: ColorMode;
  /** --ephemeral：不落盘会话文件（codex exec --ephemeral 对等；json 的 session_id 为 null） */
  ephemeral: boolean;
  /** --add-dir <目录>（可重复）：沙箱额外可写目录（codex --add-dir 对等；runExec 合并进 overrides） */
  addDirs: string[];
}

/** argv 级 `exec --help/-h` 预检（双入口共用：全局 parseArgs 把 --help/-h 吞成标记，
 * 此处扫原始参数先拦截，否则 exec 专属用法永远不可达；`--` 之后一律当任务文本）。
 * 命中则打印专属帮助返回 true，调用方直接 return。 */
export function handleExecHelp(argv: string[], lang?: string | null): boolean {
  // exec/e 全套 + 顶层 review 直达（codex review --help 对等；review 即 exec review）
  if (argv[0] !== 'exec' && argv[0] !== 'e' && argv[0] !== 'review') return false;
  const rest = argv.slice(1);
  const dash = rest.indexOf('--');
  const flagPart = dash < 0 ? rest : rest.slice(0, dash);
  if (!flagPart.some((a) => a === '--help' || a === '-h')) return false;
  console.log(execHelpText(lang));
  return true;
}

/** `omni exec --help` 文本（parseExecArgs --help 抛出同文；main 层 exec 分支优先打印，绕过全局 --help 短路）；
 * `--lang en` 出英文版（缺省中文，与 cfg 默认语言一致） */
export function execHelpText(lang?: string | null): string {
  if (lang === 'en') return execHelpTextEn();

  return (
    '用法：omni exec "<任务>" [--output-format text|json|stream-json] [--json] [--max-turns N] [--allowed-tools a,b] [--output-schema \'{...}\'] [--quiet] [--approve-for-me] [-o <文件>] [--resume <id>] [--last] [--all] [-m <模型>] [-i <图片> …] [--color always|never|auto] [--ephemeral] [--add-dir <目录> …]\n' +
            '  exec resume <id|--last> [后续任务]：恢复会话续跑（--last = 当前目录最近一次，无 id 时亦可用 exec --last；--all 取消目录过滤）。\n' +
            '  exec fork <id|--last> [--all] [后续任务]：分叉出新会话再跑（无后续任务 = 仅分叉，stdout 新会话 id）。\n' +
            '  exec review [额外要求] [--base <分支> | --commit <SHA> | --uncommitted] [--title <标题>]：非交互代码审查（typecheck + 改动 → 单次 LLM 审查，不建会话；缺省审未提交改动）。\n' +
            '  --ephemeral：不落盘会话文件（json 的 session_id 为 null；与 resume/fork 互斥）。\n' +
            '  --add-dir <目录>（可重复）：沙箱额外可写目录。\n' +
            '  --json：事件 JSONL（codex --json 对等；即 stream-json：逐行轨迹事件，末行结果）。\n' +
            '  stdout 只输出最终结果（text 纯文本 / json 单对象 / stream-json 轨迹+末行结果），进度（思考/工具）走 stderr；--quiet 静默 stderr 只留结果。\n' +
            '  --approve-for-me：需要审批的操作先经模型审阅（approve 放行 / deny 拒绝），不改变沙箱与权限边界。'
  );
}

/** exec 专属帮助英文版（--lang en；行数与中文版一一对应） */
function execHelpTextEn(): string {
  return (
    'Usage: omni exec "<task>" [--output-format text|json|stream-json] [--json] [--max-turns N] [--allowed-tools a,b] [--output-schema \'{...}\'] [--quiet] [--approve-for-me] [-o <file>] [--resume <id>] [--last] [--all] [-m <model>] [-i <image> ...] [--color always|never|auto] [--ephemeral] [--add-dir <dir> ...]\n' +
            '  exec resume <id|--last> [follow-up]: resume a session (--last = most recent in cwd; also usable as exec --last; --all disables cwd filtering).\n' +
            '  exec fork <id|--last> [--all] [follow-up]: fork into a new session, then continue (no follow-up = fork only, prints new id).\n' +
            '  exec review [focus] [--base <branch> | --commit <SHA> | --uncommitted] [--title <title>]: non-interactive code review (typecheck + changes, single LLM call, no session; default: uncommitted changes).\n' +
            '  --ephemeral: no session files (json session_id is null; mutually exclusive with resume/fork).\n' +
            '  --add-dir <dir> (repeatable): extra writable dirs for the sandbox.\n' +
            '  --json: event JSONL (like codex --json; i.e. stream-json: one trace event per line, last line is the result).\n' +
            '  stdout carries only the final result (text / single json object / stream-json); progress goes to stderr; --quiet silences stderr.\n' +
            '  --approve-for-me: review approval requests with the model first (never widens sandbox/permissions).'
  );
}

/** 解析 exec 子命令参数（exec 专属 flag；--model/-m/-i/--add-dir/--approve-for-me 已被 parseArgs 收进 overrides，此处解析供直接调用；子命令互斥 fail-fast） */
export function parseExecArgs(args: string[]): ExecParseResult {
  let promptRaw = '';
  let resumeId: string | null = null;
  let resumeLast = false;
  let resumeAll = false;
  let forkId: string | null = null;
  let forkLast = false;
  let reviewMode = false;
  let reviewBase: string | undefined;
  let reviewCommit: string | undefined;
  let reviewTitle: string | undefined;
  let reviewUncommitted = false;
  let outputFormat: ExecOutputFormat = 'text';
  let maxTurns: number | undefined;
  let allowedTools: string[] | undefined;
  let outputSchema: Record<string, unknown> | undefined;
  let model: string | undefined;
  let quiet = false;
  let approveForMe = false;
  let outputLastMessage: string | null = null;
  let color: ColorMode | undefined;
  const addDirs: string[] = [];
  let ephemeral = false;
  const images: string[] = [];
  const positionals: string[] = [];

  // 子命令形态：`omni exec resume <id> [prompt]` / `omni exec resume --last [prompt]`
  if (args[0] === 'resume') {
    if (args[1] === '--last') {
      resumeLast = true;
      args = args.slice(2);
    } else {
      // `--` 开头的残留不是 id（如裸 --all）：按缺失处理，进下方显式报错
      resumeId = args[1] && !args[1].startsWith('-') ? args[1] : null;
      args = args.slice(args[1] && !args[1].startsWith('-') ? 2 : 1);
    }
    // 裸 `exec resume`（无 id/--last）：显式报错而非吞成新任务（与 fork 同口径）
    if (!resumeId && !resumeLast) throw new Error('缺少会话 id：omni exec resume <id|--last> [后续任务]');
  }
  // 子命令形态：`omni exec fork <id|--last> [--all] [prompt]`（codex exec fork 对等；
  // 无 prompt = 仅分叉，stdout 新会话 id，可管道组合）
  if (args[0] === 'fork') {
    if (args[1] === '--last') {
      forkLast = true;
      args = args.slice(2);
    } else {
      // 同 resume：`--` 开头不是 id，按缺失处理
      forkId = args[1] && !args[1].startsWith('-') ? args[1] : null;
      args = args.slice(forkId ? 2 : 1);
    }
    if (!forkId && !forkLast) throw new Error('缺少会话 id：omni exec fork <id|--last> [后续任务]');
  }
  // 子命令形态：`omni exec review [额外审查要求]`（codex exec review 对等；
  // 剩余位置参数拼成额外要求，`-` 从 stdin 读）
  if (args[0] === 'review') {
    reviewMode = true;
    args = args.slice(1);
  }

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.startsWith('--') && a.includes('=') ? a.indexOf('=') : -1;
    const name = eq >= 0 ? a.slice(0, eq) : a;
    const inlineValue = eq >= 0 ? a.slice(eq + 1) : undefined;
    const takeValue = (): string => {
      const v = inlineValue ?? args[++i];
      if (v === undefined) throw new Error(`参数 ${name} 缺少值`);
      return v;
    };
    switch (name) {
      case '--output-format':
        outputFormat = takeValue() as ExecOutputFormat;
        if (!['text', 'json', 'stream-json'].includes(outputFormat)) {
          throw new Error(`--output-format 仅支持 text | json | stream-json（收到「${outputFormat}」）`);
        }
        break;
      case '--max-turns': {
        const n = Number(takeValue());
        if (!Number.isInteger(n) || n < 1) throw new Error(`--max-turns 需要正整数（收到「${n}」）`);
        maxTurns = n;
        break;
      }
      case '--allowed-tools':
        allowedTools = takeValue().split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case '--output-schema': {
        const raw = takeValue();
        try {
          const parsed = JSON.parse(raw);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('schema 须为对象');
          outputSchema = parsed;
        } catch (e) {
          if (raw.startsWith('{') || raw.startsWith('[')) throw new Error(`--output-schema 不是合法 JSON：${(e as Error).message}`);
          // 非内联 JSON → 视为文件路径（如 schema.json）
          try {
            outputSchema = JSON.parse(readFileSync(raw, 'utf8'));
          } catch (fe) {
            throw new Error(`--output-schema 读取失败：${raw}（${(fe as Error).message}）`);
          }
        }
        break;
      }
      case '--resume':
        resumeId = takeValue();
        break;
      case '--last':
        // 最近一次会话（codex exec resume --last 对等；当前目录范围）
        resumeLast = true;
        break;
      case '--all':
        // 取消目录过滤（codex resume --all 对等；配 --last 用，不配则忽略）
        resumeAll = true;
        break;
      case '--model':
      case '-m':
        model = takeValue();
        break;
      case '-i':
      case '--image': {
        const v = takeValue();
        if (v) images.push(v);
        break;
      }
      case '--json':
        // 事件 JSONL（codex --json 对等；即 --output-format stream-json：逐行轨迹事件，末行结果）
        outputFormat = 'stream-json';
        break;
      case '--color':
        color = parseColorMode(takeValue());
        break;
      case '--ephemeral':
        // 不持久化会话文件（codex exec --ephemeral 对等；mini 单次默认如此）
        ephemeral = true;
        break;
      case '--add-dir': {
        const v = takeValue();
        if (v) addDirs.push(v);
        break;
      }
      case '--base':
        // 审查基准分支（codex exec review --base 对等；仅 review 生效，见下方互斥校验）
        reviewBase = takeValue();
        break;
      case '--commit':
        // 审查指定提交（codex exec review --commit 对等；仅 review 生效）
        reviewCommit = takeValue();
        break;
      case '--title': {
        // 审查对象标题（codex exec review --title 对等；仅 review 生效）
        const v = takeValue();
        if (v !== undefined) reviewTitle = v;
        break;
      }
      case '--uncommitted':
        // 显式缺省（codex --uncommitted 对等：本来就只审未提交改动；接受以兼容脚本，不改变行为）
        reviewUncommitted = true;
        break;
      case '--quiet':
      case '-q':
        quiet = true;
        break;
      case '--approve-for-me':
        approveForMe = true;
        break;
      case '-o':
      case '--output-last-message': {
        const v = takeValue();
        if (v !== undefined) outputLastMessage = v;
        break;
      }
      case '--help':
      case '-h':
        throw new Error(execHelpText());
      case '--':
        positionals.push(...args.slice(i + 1));
        i = args.length;
        break;
      default:
        if (a.startsWith('-') && a !== '-') throw new Error(`未知参数：${a}（omni exec --help 查看用法）`);
        positionals.push(a);
    }
  }
  promptRaw = positionals.join(' ').trim();
  if (!promptRaw && (resumeId || resumeLast) && !forkId && !forkLast && !reviewMode) {
    // `exec resume <id|--last>` 无后续 prompt：续跑原任务（不再提交新消息）
    promptRaw = '[继续上次任务]';
  }
  if (ephemeral && (resumeId || resumeLast || forkId || forkLast)) {
    throw new Error('--ephemeral 与 resume/fork 互斥（不落盘的会话无法续跑或分叉）');
  }
  // 子命令互斥（同轮只能续跑/分叉/审查其一；混写如 fork A --resume B 不猜意图，直接报错）
  if (reviewMode && (resumeId || resumeLast || forkId || forkLast)) {
    throw new Error('exec review 不支持 resume/fork（审查是单次请求，不进会话）');
  }
  if ((forkId || forkLast) && (resumeId || resumeLast)) {
    throw new Error('fork 与 resume 互斥（一次只能分叉或续跑其一）');
  }
  if (resumeId && resumeLast) {
    throw new Error('resume <id> 与 --last 互斥（指定会话还是最近会话，只能选其一）');
  }
  if (reviewMode && (allowedTools?.length || maxTurns !== undefined || outputSchema)) {
    // review 是单次审查（无 agent 循环）：loop 系 flags 在此无意义，显式拒绝而非静默吞掉
    throw new Error('exec review 不支持 --allowed-tools/--max-turns/--output-schema（无 agent 循环，直接单次审查）');
  }
  if (!promptRaw && !forkId && !forkLast && !reviewMode) throw new Error('缺少任务描述：omni exec "<任务>"（或用 - 从 stdin 读取）');
  if ((reviewBase || reviewCommit || reviewUncommitted || reviewTitle) && !reviewMode) {
    throw new Error('--base/--commit/--uncommitted/--title 仅 exec review 可用（审查范围，非 agent 循环参数）');
  }
  if (reviewBase && reviewCommit) {
    throw new Error('--base 与 --commit 互斥（基准分支还是指定提交，只能选其一）');
  }
  if (reviewUncommitted && (reviewBase || reviewCommit)) {
    throw new Error('--uncommitted 与 --base/--commit 互斥（缺省即审未提交，二选一）');
  }
  return { promptRaw, resumeId, resumeLast, resumeAll, forkId, forkLast, reviewMode, reviewBase, reviewCommit, reviewTitle, ephemeral, addDirs, outputFormat, maxTurns, allowedTools, outputSchema, model, quiet, approveForMe, outputLastMessage, images, color };
}

/* ─────────────────────────────── Exec 输出（stdout 干净） ─────────────────────────────── */

/** 从管道读 stdin（TTY 下不阻塞）；无数据/读取失败 → null（mini 单次复用，保持两端同语义） */
export function readStdinIfPiped(): string | null {
  if (process.stdin.isTTY) return null;
  try {
    const s = readFileSync(0, 'utf8');
    return s.length > 0 ? s : null;
  } catch {
    return null;
  }
}

/**
 * Headless 输出：stdout 零污染（只由 runExec 在结束时打印结果），
 * 进度（思考/工具步骤/错误）全部走 stderr。token 用量累计供 cost 估算。
 */
export class ExecOutput implements Output {
  readonly thinking: ThinkingDisplay;
  /** 会话累计 token 用量（onUsage 累计；cost 估算用） */
  inTokens = 0;
  outTokens = 0;
  cachedTokens = 0;
  /** 最终回答文本（onAnswer 累计；结果提取以 messages 为准，这里仅兜底） */
  answerText = '';

  constructor(
    private quiet = false,
    private showThinking = true
  ) {
    // 思考流式输出到 stderr（与 stdout 结果隔离），连续写不加换行——
    // 之前用 log(dim(piece)) 逐片加换行，导致终端每词一行（竖排 bug）。
    // shown 跟随是否正在输出：loop 在正文/工具开始与流结束时 finish() 补换行。
    let started = false;
    const self = this;
    this.thinking = {
      get shown() {
        return started;
      },
      write(piece: string) {
        if (self.quiet || !self.showThinking) return;
        if (!piece) return;
        // 归一化 \r（与 console 一致，避免光标回行首破坏显示）
        const clean = piece.replace(/\r\n/g, '\n').replace(/\r/g, '');
        if (!clean) return;
        started = true;
        process.stderr.write(dim(clean));
      },
      finish() {
        if (!started) return;
        started = false;
        if (self.quiet || !self.showThinking) return;
        process.stderr.write('\n');
      },
    };
  }

  /** 进度行（stderr；MCP 模式 quiet 时静默） */
  log(line: string): void {
    if (this.quiet) return;
    process.stderr.write(line.endsWith('\n') ? line : line + '\n');
  }

  banner(): void {
    /* headless：不打印 banner（机器可读） */
  }

  onRound(step: number, maxSteps: number): void {
    this.log(dim(`[${step + 1}/${maxSteps}] 思考中…`));
  }
  onStreamStart(): void {
    /* 无 spinner */
  }
  onAnswer(text: string): void {
    this.answerText += text;
  }
  onAnswerEnd(): void {
    /* 结果统一在结束时输出 */
  }
  onUsage(u: TokenUsage): void {
    this.inTokens += u.prompt ?? 0;
    this.outTokens += u.completion ?? 0;
    this.cachedTokens += u.cached ?? 0;
  }
  onRequestFailed(err: unknown): void {
    this.log(red(`✗ 请求失败：${(err as Error)?.message ?? String(err)}`));
  }
  onThinkingSaved(): void {
    /* 思考已实时走 stderr，不提示落盘 */
  }
  onToolStep(_step: number, _max: number, name: string, argsPreview: string): void {
    this.log(dim(`→ ${name} ${argsPreview}`));
  }
  onToolResult(ok: boolean, chars: number): void {
    this.log(dim(`${ok ? '✓' : '✗'} 工具结果 · ${chars} 字符`));
  }
  onMaxSteps(max: number): void {
    this.log(yellow(`⚠️ 已达到最大步数（${max}），任务可能未完成（退出码 1）`));
  }
  onUserMessage(): void {}
  onTurnEnd(): void {}
  onWaitForInput(): void {}
  clearScrollback(): void {}
  showHelp(): void {}
  onHookOutput(event: string, lines: string[]): void {
    for (const l of lines) this.log(dim(`hook[${event}] ${l}`));
  }
}

/* ─────────────────────────────── JSON Schema 子集校验 ─────────────────────────────── */

/**
 * 从模型回答中提取 JSON 对象（schema 校验的兜底——模型可能输出 ```json 围栏 /
 * 前后缀散文）：
 *   1. ```json 围栏内容
 *   2. 全串直接 parse
 *   3. 首个 `{` 到最后一个 `}` 的子串（尾随散文在 } 之后时）
 * 都失败 → null。
 */
export function extractJsonObject(text: string): unknown | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text;
  for (const t of [candidate, text]) {
    try {
      return JSON.parse(t);
    } catch {
      /* 继续尝试收窄 */
    }
  }
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * JSON Schema 子集校验器（无框架依赖，覆盖 CI 常用场景）：
 * type（含数组联合）/ enum / properties / required / additionalProperties:false /
 * items / minLength·maxLength / pattern / minimum·maximum / minItems·maxItems。
 * 返回错误路径列表（空 = 通过）。
 */
export function validateAgainstSchema(value: unknown, schema: Record<string, unknown>, path = '$'): string[] {
  const errs: string[] = [];
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const t = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (types.length > 0 && !types.includes(t)) {
    errs.push(`${path}: 期望类型 ${types.join('|')}，实际 ${t}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))) {
    errs.push(`${path}: 不在枚举范围内`);
  }
  if (t === 'string') {
    const s = String(value);
    if (typeof schema.minLength === 'number' && s.length < schema.minLength) errs.push(`${path}: 长度 < ${schema.minLength}`);
    if (typeof schema.maxLength === 'number' && s.length > schema.maxLength) errs.push(`${path}: 长度 > ${schema.maxLength}`);
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern).test(s)) errs.push(`${path}: 不匹配 pattern ${schema.pattern}`);
      } catch {
        /* 非法 pattern 忽略 */
      }
    }
  } else if (t === 'number') {
    const n = value as number;
    if (typeof schema.minimum === 'number' && n < schema.minimum) errs.push(`${path}: < ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && n > schema.maximum) errs.push(`${path}: > ${schema.maximum}`);
  } else if (t === 'object') {
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const req of (schema.required as string[] | undefined) ?? []) {
      if (!(req in (value as object))) errs.push(`${path}: 缺少必填字段 ${req}`);
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(value as object)) {
        if (!(k in props)) errs.push(`${path}: 不允许的字段 ${k}`);
      }
    }
    for (const [k, sub] of Object.entries(props)) {
      if (k in (value as object)) errs.push(...validateAgainstSchema((value as Record<string, unknown>)[k], sub, `${path}.${k}`));
    }
  } else if (t === 'array') {
    const arr = value as unknown[];
    if (typeof schema.minItems === 'number' && arr.length < schema.minItems) errs.push(`${path}: 元素数 < ${schema.minItems}`);
    if (typeof schema.maxItems === 'number' && arr.length > schema.maxItems) errs.push(`${path}: 元素数 > ${schema.maxItems}`);
    const items = schema.items;
    if (items && typeof items === 'object' && !Array.isArray(items)) {
      arr.forEach((v, i) => errs.push(...validateAgainstSchema(v, items as Record<string, unknown>, `${path}[${i}]`)));
    }
  }
  return errs;
}

/* ─────────────────────────────── Headless 执行核心 ─────────────────────────────── */

/** 最终回答提取：从 messages 末尾向前找最后一个带正文的 assistant 消息 */
export function extractFinalAnswer(messages: ChatCompletionMessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content) return m.content;
  }
  return '';
}

/** 最近一次轮结束原因（events 末尾的 turn/end；无 → null） */
export function lastTurnReason(rec?: EventRecorder): string | null {
  const evs = rec?.events ?? [];
  for (let i = evs.length - 1; i >= 0; i--) {
    const ev = evs[i];
    if (ev.k === 'turn/end') return ev.reason;
  }
  return null;
}

/** 会话 id = 会话文件名主干（createSession 只返回路径；id 是文件名的 <id>.jsonl 部分） */
function sessionIdOf(file: string | null | undefined): string | null {
  if (!file) return null;
  const base = file.split(/[\\/]/).pop() ?? file;
  return base.endsWith('.jsonl') ? base.slice(0, -'.jsonl'.length) : base;
}

export interface HeadlessOptions {
  /** 用户 prompt（'[继续上次任务]' = resume 不提交新消息时由调用方注入的占位） */
  prompt: string;
  /** 恢复的会话 id（exec resume <id> / mcp omni_reply） */
  resumeId?: string | null;
  outputFormat: ExecOutputFormat;
  /** 最终回答须符合的 JSON Schema（不符 → exitCode 1 + stderr 错误列表） */
  outputSchema?: Record<string, unknown>;
  /** stream-json：每个轨迹事件实时输出（调用方负责写 stdout） */
  onEvent?: (e: TrajEvent) => void;
  /** 是否把管道 stdin 注入为上下文（exec CLI；MCP server 的 stdin 是 JSON-RPC 通道，必须关） */
  injectStdin?: boolean;
  /** 显式图片附件路径（-i/--image；与 @提及 合并去重后随用户消息发出） */
  images?: string[];
  /** 不落盘会话文件（--ephemeral；事件仅内存 + 实时回调，json 的 session_id 为 null） */
  ephemeral?: boolean;
  /** resume 载入播报开关（缺省开；fork 续跑传 false——fork 行已说明来源，避免重复播报） */
  announceResume?: boolean;
}

export interface HeadlessResult {
  result: string;
  costUsd: number;
  durationMs: number;
  numTurns: number;
  sessionId: string | null;
  exitCode: number;
  /** token 用量（1.0 P1-10 成本效率报告；onUsage 累计） */
  tokens: { prompt: number; completion: number; cached: number };
  /** 无工具调用的回合数（纯对话轮——「空转」检测：模型没动工具就收尾） */
  idleTurns: number;
  /** 失败类别：completed / error / max-steps / aborted / schema-fail（成本报告维度） */
  errorType: string;
}

/** 输入/输出单价（$/1M tokens，估算用；可用 OMNI_INPUT_PRICE_PER_M / OMNI_OUTPUT_PRICE_PER_M 覆盖） */
const INPUT_PRICE_PER_M = Number(process.env.OMNI_INPUT_PRICE_PER_M ?? 1);
const OUTPUT_PRICE_PER_M = Number(process.env.OMNI_OUTPUT_PRICE_PER_M ?? 2);

/**
 * 执行一次 headless 回合：会话持久化（新建/恢复）→ prompt 组装 → runAgent →
 * 结果提取 + exit code（0 完成 / 1 失败·超限·schema 不符）。
 * exec CLI 与 MCP server（omni_exec / omni_reply）共用。
 */
export async function runHeadless(ctx: RunContext, output: ExecOutput, opts: HeadlessOptions): Promise<HeadlessResult> {
  const { cfg, client, messages, runOpts } = ctx;
  // 会话：resume → 复用原文件；否则新建（json 输出的 session_id + exec resume 续跑）；
  // --ephemeral → 不建文件（内存轨迹 + stdout 结果，无法续跑/分叉，解析层已互斥）
  const sessionPath = opts.ephemeral ? null : opts.resumeId ? await findSessionById(opts.resumeId) : await createSession({ project: process.cwd(), model: cfg.model });
  if (opts.resumeId && !sessionPath) {
    throw new Error(`会话「${opts.resumeId}」不存在（json 输出的 session_id 或 -l 列表查看）`);
  }
  runOpts.sessionPath = sessionPath ?? undefined;
  // 轨迹记录器：stream-json 时每个事件实时输出（落盘与实时互不冲突）
  runOpts.events = await EventRecorder.open(sessionPath ?? null, opts.onEvent);
  // 会话播报（stderr；quiet/MCP 下静默；codex exec 运行头对等：模型 + 会话 id 可观测）：
  // resume → 载入历史消息（后续追加只写新增，不重复落盘）+ 已恢复播报；
  // 新建 → 新会话播报；--ephemeral → 临时会话播报（fork 续跑传 announceResume:false 抑制重复）。
  if (opts.resumeId && sessionPath) {
    const loaded = await loadSession(sessionPath);
    if (loaded) messages.push(...loaded.messages);
    if (opts.announceResume !== false) {
      output.log(dim(`已恢复会话 ${opts.resumeId}（${loaded ? loaded.messages.length : 0} 条历史消息）· 模型 ${cfg.model}`));
    }
  } else if (opts.ephemeral) {
    output.log(dim(`exec 临时会话（--ephemeral 不落盘）· 模型 ${cfg.model}`));
  } else {
    const sid = sessionIdOf(sessionPath);
    output.log(dim(sid ? `exec 新会话 ${sid} · 模型 ${cfg.model}` : `exec 会话文件创建失败（仅内存轨迹）· 模型 ${cfg.model}`));
  }
  const basePersist = persistableMessages(messages).length; // 历史中已落盘的消息数（新增只写之后的部分）

  // UserPromptSubmit hook（与单任务/交互一致）：改写 prompt 进上下文
  let userPrompt = opts.prompt;
  if (runOpts.hooks?.has('UserPromptSubmit')) {
    userPrompt = (await runOpts.hooks.userPromptSubmit(opts.prompt)).prompt;
  }
  // prompt+stdin 注入（`omni exec "prompt"` 且 stdin 被管道）：stdin 内容作为上下文附加。
  // 仅 exec CLI 开启（MCP server 的 stdin 是 JSON-RPC 通道，不能当上下文读）
  const injected = opts.injectStdin ? readStdinIfPiped() : null;
  const finalPrompt = injected ? `${userPrompt}\n\n[stdin 输入]\n${injected}` : userPrompt;
  // 图片附件（codex exec -i 对等 + @图.png 提及）：vision parts 随用户消息发出；
  // 无 vision 模型由 loop modalities 校验明确报错；不存在/超限静默跳过。
  const attachments: ImageAttachment[] = await collectImageAttachments(finalPrompt, process.cwd()).catch(() => []);
  if (opts.images?.length) {
    const seen = new Set(attachments.map((a) => path.resolve(process.cwd(), a.path)));
    for (const p of opts.images) {
      if (attachments.length >= MAX_IMAGE_FILES) break;
      const abs = path.resolve(process.cwd(), p);
      if (seen.has(abs)) continue;
      seen.add(abs);
      const att = await loadImageAttachment(abs, p).catch(() => null);
      if (att) attachments.push(att);
    }
  }
  if (attachments.length > 0) {
    output.log(dim(`（已附加 ${attachments.length} 张图片：${attachments.map((a) => a.path).join('、')}）`));
  }
  messages.push(userMessageWithImages(finalPrompt, attachments));
  await prepareContext(client, cfg.model, messages, runOpts.context ?? {}, runOpts.events);

  // --output-schema：要求模型以 JSON 输出（systemNote 拼进每个 system 提示，不污染消息历史）
  if (opts.outputSchema) {
    runOpts.systemNote = `\n\n[输出要求] 请以单个 JSON 对象回答，严格符合如下 JSON Schema：\n${JSON.stringify(opts.outputSchema)}`;
  }

  const t0 = Date.now();
  await runAgent(client, cfg.model, messages, runOpts, output);
  const durationMs = Date.now() - t0;

  // 持久化：新增消息 + 轨迹事件 + 刷新 meta（失败静默，不打扰流程）
  const newMsgs = persistableMessages(messages).slice(basePersist);
  if (sessionPath && newMsgs.length > 0) await appendSessionMessages(sessionPath, newMsgs);
  await runOpts.events?.flush();
  if (sessionPath) await finalizeSession(sessionPath);

  const result = extractFinalAnswer(messages);
  const reason = lastTurnReason(runOpts.events);
  let exitCode = reason === 'completed' ? 0 : 1;
  // --output-schema：最终回答强制符合 JSON Schema（不符 → 非零退出 + 错误列到 stderr）。
  // 先按原样校验；失败时提取 JSON（围栏/前后缀散文兜底）再校验一次——模型软要求 JSON
  // 输出（systemNote），提取兜底避免围栏/散文导致 CI 误判
  if (opts.outputSchema) {
    let errs = validateAgainstSchema(result, opts.outputSchema);
    if (errs.length > 0) {
      const extracted = extractJsonObject(result);
      if (extracted !== null) errs = validateAgainstSchema(extracted, opts.outputSchema);
    }
    if (errs.length > 0) {
      output.log(red(`✗ 最终回答不符合 --output-schema：\n${errs.map((e) => `  ${e}`).join('\n')}`));
      output.log(dim(`  实际回答（前 300 字符）：${result.slice(0, 300)}`));
      exitCode = 1;
    }
  }
  const costUsd = (output.inTokens / 1e6) * INPUT_PRICE_PER_M + (output.outTokens / 1e6) * OUTPUT_PRICE_PER_M;
  // 1.0 P1-10：token 用量 / 空转回合 / 失败类别（成本效率报告维度）
  const tokens = { prompt: output.inTokens, completion: output.outTokens, cached: output.cachedTokens };
  const idleTurns = messages.filter(
    (m): m is import('openai/resources/chat/completions.js').ChatCompletionAssistantMessageParam =>
      m.role === 'assistant' && !('tool_calls' in m) || (m.role === 'assistant' && !(m as { tool_calls?: unknown }).tool_calls)
  ).length;
  const errorType =
    exitCode !== 0 && opts.outputSchema ? 'schema-fail'
    : reason === 'completed' ? 'completed'
    : reason === 'max-steps' ? 'max-steps'
    : reason === 'aborted' ? 'aborted'
    : 'error';
  return {
    result,
    costUsd: Number(costUsd.toFixed(6)),
    durationMs,
    numTurns: runOpts.events?.turn ?? 0,
    sessionId: sessionIdOf(sessionPath),
    exitCode,
    tokens,
    idleTurns,
    errorType,
  };
}

/** json 输出对象（stream-json 的末行 t:'result' 同构） */
export function resultJson(res: HeadlessResult, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    result: res.result,
    cost_usd: res.costUsd,
    duration_ms: res.durationMs,
    num_turns: res.numTurns,
    session_id: res.sessionId,
    exit_code: res.exitCode,
    // 1.0 P1-10 成本效率字段（additive）
    tokens: res.tokens,
    idle_turns: res.idleTurns,
    error_type: res.errorType,
    ...extra,
  };
}

/**
 * `omni exec review [额外要求]`：收集改动 → 跑校验 → 单次 LLM 审查。
 * stdout 干净（text = 审查正文；json = 结果对象，可 | jq）；进度走 stderr（--quiet 静默）。
 * 返回进程退出码（0 完成 / 1 失败；无改动按 0 处理，stderr 说明）。
 */
export async function runExecReview(
  ctx: RunContext,
  extra: string,
  opts: Pick<ExecParseResult, 'outputFormat' | 'outputLastMessage' | 'quiet' | 'images' | 'reviewBase' | 'reviewCommit' | 'reviewTitle'>
): Promise<number> {
  const { cfg, client } = ctx;
  const output = new ExecOutput(opts.quiet === true, false);
  const t0 = Date.now();
  output.log(dim('正在收集改动并运行 typecheck…'));
  const checkCmd = detectCheckCommand();
  const check = checkCmd
    ? { command: checkCmd, output: (await captureCommand(checkCmd, 120_000)).output }
    : { command: null as string | null, output: '（无脚本）' };
  // 审查范围（codex exec review --base/--commit 对等；缺省=未提交改动）：
  // ref 拼进 shell 前先做字符集限定（防命令注入；起始禁 `-` 防 git 选项注入）
  let diff: { ok: boolean; output: string };
  if (opts.reviewCommit) {
    const sha = opts.reviewCommit.trim();
    if (!/^[0-9a-fA-F]{4,64}$/.test(sha)) {
      output.log(red(`--commit 非法（须为 4-64 位十六进制 SHA）：${sha.slice(0, 40)}`));
      return 1;
    }
    const exists = await captureCommand(`git cat-file -e ${sha}^{commit}`);
    if (!exists.ok) {
      output.log(red(`commit ${sha} 不存在（git cat-file 校验失败）`));
      return 1;
    }
    const shown = await captureCommand(`git show ${sha} -- .`);
    diff = { ok: shown.ok, output: shown.ok && shown.output ? shown.output : '（无改动）' };
    if (!diff.ok) {
      output.log(red(`读取 commit ${sha} 失败：${shown.output.slice(0, 200)}`));
      return 1;
    }
  } else if (opts.reviewBase) {
    const base = opts.reviewBase.trim();
    // rev 表达式字符集限定（分支名 + HEAD~1 / HEAD^ 等常见写法；禁 shell 元字符与起始 `-`）
    if (base.length > 128 || !/^[A-Za-z0-9_][A-Za-z0-9_.\/~^-]*$/.test(base)) {
      output.log(red(`--base 非法（限字母数字/_.\\/~^-, 不以 - 开头）：${base.slice(0, 40)}`));
      return 1;
    }
    // 存在性前置校验（collectDiff 对坏分支宽容：diff 失败但 status 成功仍 ok，
    // 会把拼写错误的基准静默审成 status——此处必须先验明正身）
    const verify = await captureCommand(`git rev-parse --verify ${base}`);
    if (!verify.ok) {
      output.log(red(`基准「${base}」不存在（git rev-parse 校验失败）`));
      return 1;
    }
    const d = await collectDiff({ base });
    if (!d.ok) {
      output.log(red(`基准分支「${base}」diff 失败：${d.output.slice(0, 200)}`));
      return 1;
    }
    diff = d;
  } else {
    diff = await collectDiff();
    if (!diff.ok) {
      output.log(red(`无法获取 git diff：${diff.output.slice(0, 200)}`));
      return 1;
    }
  }
  if (diff.output === '（无改动）') {
    output.log(dim('工作区没有改动可审查（git diff 为空）'));
    return 0;
  }
  // 图片附件（-i 显式 + 额外要求里的 @图.png 提及；与 headless 同口径组装 vision parts）
  const attachments: ImageAttachment[] = await collectImageAttachments(extra, process.cwd()).catch(() => []);
  if (opts.images?.length) {
    const seen = new Set(attachments.map((a) => path.resolve(process.cwd(), a.path)));
    for (const f of opts.images) {
      if (attachments.length >= MAX_IMAGE_FILES) break;
      const abs = path.resolve(process.cwd(), f);
      if (seen.has(abs)) continue;
      seen.add(abs);
      const att = await loadImageAttachment(abs, f).catch(() => null);
      if (att) attachments.push(att);
    }
  }
  if (attachments.length > 0) {
    output.log(dim(`（已附加 ${attachments.length} 张图片：${attachments.map((a) => a.path).join('、')}）`));
  }
  const review = await reviewCode(client, cfg.model, diff.output, { command: check.command, output: check.output }, extra || undefined, attachments, opts.reviewTitle);
  if (!review) {
    output.log(red('审查失败（网络 / API 问题），请重试'));
    return 1;
  }
  const durationMs = Date.now() - t0;
  if (opts.outputFormat === 'text') {
    process.stdout.write(review.endsWith('\n') ? review : review + '\n');
  } else {
    process.stdout.write(
      JSON.stringify({
        result: review,
        cost_usd: 0,
        duration_ms: durationMs,
        num_turns: 0,
        session_id: null,
        exit_code: 0,
        ...(opts.outputFormat === 'stream-json' ? { t: 'result' } : {}),
      }) + '\n'
    );
  }
  if (opts.outputLastMessage) {
    try {
      writeFileSync(opts.outputLastMessage, review);
    } catch (err) {
      process.stderr.write(`审查结果落盘失败（${opts.outputLastMessage}）：${(err as Error)?.message ?? err}\n`);
      return 1;
    }
  }
  return 0;
}

/* ─────────────────────────────── CLI 入口：omni exec ─────────────────────────────── */

/** 应用 exec 专属运行选项（工具过滤 / 步数上限） */
function applyExecOpts(runOpts: RunOptions, opts: ExecParseResult): void {
  if (opts.allowedTools?.length) {
    const allowed = new Set(opts.allowedTools);
    runOpts.tools = runOpts.tools.filter((t) => allowed.has(t.name));
  }
  if (opts.maxTurns) {
    runOpts.maxSteps = Math.min(runOpts.maxSteps ?? 50, opts.maxTurns);
  }
}

/**
 * 最近会话解析：缺省当前目录范围；`--all` 取消目录过滤（codex resume --all 对等）。
 * verb 仅用于无会话报错文案（恢复/分叉）。
 */
async function resolveLatestSession(scopeAll: boolean, verb: '恢复' | '分叉') {
  const latest = scopeAll
    ? ((await listSessions(undefined, { includeArchived: false }))[0] ?? null)
    : await latestSession(process.cwd());
  if (!latest) {
    throw new Error(
      scopeAll ? `暂无可${verb}的会话（先 omni exec 跑一次，或用 -l 查看全部）` : `当前目录暂无可${verb}的会话（先 omni exec 跑一次，或用 -l 查看全部，或加 --all 跨目录）`
    );
  }
  return latest;
}

/** `omni exec ...` 入口：返回进程退出码（0 成功 / 1 失败） */
export async function runExec(args: string[], overrides: ConfigOverrides): Promise<number> {
  const opts = parseExecArgs(args);
  // --color：显式颜色开关（always/never 覆盖环境变量与 TTY 判定；auto/缺省归一化回默认，
  // 同进程复用 runExec 时不把上次覆盖泄漏给下次调用）
  setColorOverride(opts.color === 'always' ? 'always' : opts.color === 'never' ? 'never' : null);
  // `-` = 整段 stdin 即 prompt；TTY 下读不到 → 报错
  let prompt = opts.promptRaw;
  if (prompt === '-') {
    const s = readStdinIfPiped();
    if (!s) throw new Error('任务为 `-` 但 stdin 无输入（echo "任务" | omni exec -）');
    prompt = s;
  }
  // exec 级 --model/-m 与 --add-dir：先于 prepareRun 合并进 overrides 副本
  //（客户端按覆盖后模型建；沙箱装配时展开额外可写目录；不碰调用方原对象）
  const effective: ConfigOverrides = { ...overrides };
  if (opts.model && !effective.model) effective.model = opts.model;
  if (opts.addDirs.length) effective.addDirs = [...(effective.addDirs ?? []), ...opts.addDirs];
  // exec 级 -i/--image：全局 -i 先被 parseArgs 收走，此处合并（互斥通道，不重复）
  const mergedImages = [...(effective.images ?? []), ...opts.images];
  const ctx = prepareRun(effective);
  const { cfg } = ctx;
  // exec review：非交互审查（与 /review 同数据源；轻量单请求，不建会话/不跑 agent 循环）
  if (opts.reviewMode) {
    return runExecReview(ctx, prompt, { ...opts, images: mergedImages });
  }
  // --approve-for-me：启用 AI 自动审批（attachRuntime 读取 cfg.autoReview 构建审阅器）
  if (opts.approveForMe) cfg.autoReview = true;
  const output = new ExecOutput(opts.quiet === true, cfg.showThinking !== false);
  await attachRuntime(ctx, output);
  applyExecOpts(ctx.runOpts, opts);
  // --last：解析为当前目录最近一次会话 id（无会话 → 明确报错而非新建，避免续跑语义丢失）
  let resumeId = opts.resumeId;
  if (opts.resumeLast && !resumeId) {
    const latest = await resolveLatestSession(opts.resumeAll, '恢复');
    resumeId = latest.id;
  }
  // fork：全量复制源会话可保留消息成新会话（codex exec fork 对等；原会话保留）。
  // 无 prompt = 仅分叉：stdout 新会话 id（可 `| xargs` 组合），json 形态同样给 session_id。
  if (opts.forkId || opts.forkLast) {
    let srcId = opts.forkId;
    if (!srcId) {
      srcId = (await resolveLatestSession(opts.resumeAll, '分叉')).id;
    }
    const srcPath = await findSessionById(srcId);
    if (!srcPath) throw new Error(`会话「${srcId}」不存在（json 输出的 session_id 或 -l 列表查看）`);
    const loaded = await loadSession(srcPath);
    const count = loaded ? persistableMessages(loaded.messages).length : 0;
    if (count === 0) throw new Error(`会话「${srcId}」无可 fork 的消息（空会话无法分叉）`);
    const forkFile = await forkSession(srcPath, count, process.cwd(), cfg.model);
    if (!forkFile) throw new Error(`fork 会话「${srcId}」失败`);
    const forkedId = path.basename(forkFile, '.jsonl');
    output.log(dim(`已从会话 ${srcId} fork 新会话 ${forkedId}（${count} 条消息）`));
    if (!prompt) {
      if (opts.outputFormat === 'text') {
        process.stdout.write(forkedId + '\n');
      } else {
        process.stdout.write(
          JSON.stringify({
            result: '',
            cost_usd: 0,
            duration_ms: 0,
            num_turns: 0,
            session_id: forkedId,
            exit_code: 0,
            ...(opts.outputFormat === 'stream-json' ? { t: 'result' } : {}),
          }) + '\n'
        );
      }
      return 0;
    }
    resumeId = forkedId;
  }
  const isForkedContinue = Boolean(opts.forkId || opts.forkLast) && Boolean(resumeId);
  const res = await runHeadless(ctx, output, {
    prompt,
    resumeId,
    announceResume: isForkedContinue ? false : undefined,
    outputFormat: opts.outputFormat,
    outputSchema: opts.outputSchema,
    injectStdin: true,
    images: mergedImages,
    ephemeral: opts.ephemeral || undefined,
    onEvent: opts.outputFormat === 'stream-json' ? (e) => process.stdout.write(JSON.stringify({ t: 'ev', e }) + '\n') : undefined,
  });
  // 结果输出（text 纯文本；json / stream-json 均为单行 JSON，可 | jq / tail -1）
  if (opts.outputFormat === 'text') {
    process.stdout.write(res.result ? res.result + '\n' : '');
  } else {
    process.stdout.write(JSON.stringify(resultJson(res, opts.outputFormat === 'stream-json' ? { t: 'result' } : {})) + '\n');
  }
  // -o：最终回答落盘（codex --output-last-message 对等；写失败非零退出）
  if (opts.outputLastMessage) {
    try {
      writeFileSync(opts.outputLastMessage, res.result);
    } catch (err) {
      process.stderr.write(`最终回答落盘失败（${opts.outputLastMessage}）：${(err as Error)?.message ?? err}\n`);
      return 1;
    }
  }
  return res.exitCode;
}

/* ─────────────────────────────── MCP server 模式：omni mcp-server ─────────────────────────────── */

const PROTOCOL_VERSION = '2024-11-05';

interface RpcRequest {
  jsonrpc: string;
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

/** omni 作为 MCP server：stdio JSON-RPC，暴露 omni_exec / omni_reply 两个工具 */
export async function runMcpServer(overrides: ConfigOverrides): Promise<number> {
  // 启动即校验配置（缺 API Key 早失败，报错信息清晰）
  prepareRun(overrides);
  const rl = readline.createInterface({ input: process.stdin });
  // 请求串行处理（每条 tools/call 独立会话；避免并发跑 Agent 抢占 stderr/资源）
  let tail: Promise<void> = Promise.resolve();
  const respond = (id: number, result: unknown): void => {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  };
  const respondError = (id: number, message: string): void => {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } }) + '\n');
  };

  const handle = (line: string): void => {
    let req: RpcRequest;
    try {
      req = JSON.parse(line);
    } catch {
      return; // 非 JSON 行忽略
    }
    if (!req || typeof req.method !== 'string') return;
    // 通知（无 id）：不回响应
    if (req.id == null) return;
    const id = req.id;
    switch (req.method) {
      case 'initialize':
        respond(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'omni-mcp', version: VERSION },
        });
        return;
      case 'ping':
        respond(id, {});
        return;
      case 'resources/list':
        respond(id, { resources: [] });
        return;
      case 'tools/list':
        respond(id, {
          tools: [
            {
              name: 'omni_exec',
              description: '启动一次 omni headless 执行（新建会话）：给出任务描述，返回结构化结果（含 session_id 供 omni_reply 续跑）。',
              inputSchema: {
                type: 'object',
                properties: {
                  prompt: { type: 'string', description: '任务描述（必填）' },
                  model: { type: 'string', description: '覆盖模型（默认配置）' },
                  max_turns: { type: 'integer', description: '步数上限（超出 → 失败）' },
                  allowed_tools: { type: 'array', items: { type: 'string' }, description: '工具白名单' },
                  output_schema: { type: 'object', description: '最终回答须符合的 JSON Schema' },
                },
                required: ['prompt'],
              },
            },
            {
              name: 'omni_reply',
              description: '继续已存在的 omni 会话（omni_exec 返回的 session_id）：载入历史上下文后回答新问题。',
              inputSchema: {
                type: 'object',
                properties: {
                  session_id: { type: 'string', description: 'omni_exec 返回的会话 id（必填）' },
                  prompt: { type: 'string', description: '继续任务的问题' },
                  model: { type: 'string', description: '覆盖模型' },
                  max_turns: { type: 'integer' },
                },
                required: ['session_id', 'prompt'],
              },
            },
          ],
        });
        return;
      case 'tools/call': {
        const { name, arguments: args } = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
        if (name !== 'omni_exec' && name !== 'omni_reply') {
          respondError(id, `未知工具：${name}`);
          return;
        }
        tail = tail.then(async () => {
          try {
            const res = await runMcpTool(name, args ?? {}, overrides);
            respond(id, { content: [{ type: 'text', text: JSON.stringify(resultJson(res)) }], isError: res.exitCode !== 0 });
          } catch (err) {
            respondError(id, err instanceof Error ? err.message : String(err));
          }
        });
        return;
      }
      default:
        respondError(id, `未知方法：${req.method}`);
    }
  };

  rl.on('line', handle);
  await new Promise<void>((resolve) => rl.on('close', () => resolve()));
  await tail; // 排空在途请求
  return 0;
}

/** MCP tools/call 的执行体（omni_exec 新建会话 / omni_reply 恢复会话，共用 runHeadless） */
async function runMcpTool(
  name: string,
  args: Record<string, unknown>,
  overrides: ConfigOverrides
): Promise<HeadlessResult> {
  const prompt = typeof args.prompt === 'string' && args.prompt ? args.prompt : (name === 'omni_exec' ? '' : undefined);
  if (!prompt) throw new Error('缺少必填参数 prompt');
  const modelOverride: ConfigOverrides = typeof args.model === 'string' && args.model ? { ...overrides, model: args.model } : overrides;
  const ctx = prepareRun(modelOverride);
  const output = new ExecOutput(true); // MCP 模式进度静默（结果经 JSON-RPC 返回）
  await attachRuntime(ctx, output);
  // omni_reply：max_turns 同样透传（resumeId 复用原会话）
  if (name === 'omni_reply') {
    const resumeId = typeof args.session_id === 'string' && args.session_id ? args.session_id : null;
    if (!resumeId) throw new Error('omni_reply 缺少必填参数 session_id');
    ctx.runOpts.maxSteps = Math.min(ctx.runOpts.maxSteps ?? 50, typeof args.max_turns === 'number' ? args.max_turns : ctx.runOpts.maxSteps ?? 50);
    return runHeadless(ctx, output, { prompt, resumeId, outputFormat: 'json' });
  }
  // omni_exec：新建会话
  if (Array.isArray(args.allowed_tools)) {
    const allowed = new Set(args.allowed_tools.filter((t): t is string => typeof t === 'string'));
    if (allowed.size > 0) ctx.runOpts.tools = ctx.runOpts.tools.filter((t) => allowed.has(t.name));
  }
  ctx.runOpts.maxSteps = Math.min(ctx.runOpts.maxSteps ?? 50, typeof args.max_turns === 'number' ? args.max_turns : ctx.runOpts.maxSteps ?? 50);
  return runHeadless(ctx, output, {
    prompt,
    outputFormat: 'json',
    outputSchema: args.output_schema && typeof args.output_schema === 'object' ? (args.output_schema as Record<string, unknown>) : undefined,
  });
}

/**
 * Headless 执行模式（`omni exec`）+ MCP server 模式（`omni mcp-server`）：
 * 把 omni 变成可组合的 Unix 命令（对标 `codex exec` / `claude -p`）。
 *
 * `omni exec "<任务>"`：
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
import { readFileSync } from 'node:fs';
import readline from 'node:readline';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { prepareContext } from './agent/context.js';
import { runAgent } from './agent/loop.js';
import { EventRecorder, type TrajEvent } from './agent/events.js';
import { appendSessionMessages, createSession, finalizeSession, findSessionById, loadSession, persistableMessages } from './agent/session.js';
import type { RunOptions, ThinkingDisplay } from './agent/types.js';
import type { ConfigOverrides } from './config/index.js';
import { attachRuntime, prepareRun, type RunContext } from './main.js';
import type { Output, TokenUsage } from './output/types.js';
import { dim, red, yellow } from './ui.js';
import { VERSION } from './version.js';

/* ─────────────────────────────── 参数解析 ─────────────────────────────── */

export type ExecOutputFormat = 'text' | 'json' | 'stream-json';

export interface ExecParseResult {
  /** 原始任务文本（'-' = 从 stdin 读整段 prompt；在 runExec 内异步解析） */
  promptRaw: string;
  /** `exec resume <id>` 或 `--resume <id>`：恢复的会话 id */
  resumeId: string | null;
  outputFormat: ExecOutputFormat;
  /** --max-turns：步数上限（超出 → 非零退出） */
  maxTurns?: number;
  /** --allowed-tools：逗号分隔的工具白名单（纯工具过滤） */
  allowedTools?: string[];
  /** --output-schema：最终回答须符合的 JSON Schema（内联 JSON 或文件路径） */
  outputSchema?: Record<string, unknown>;
  /** --model：模型覆盖（走既有 overrides，这里只透传展示用） */
  model?: string;
  /** --quiet/-q：静默 stderr 进度（只留 stdout 结果） */
  quiet?: boolean;
}

/** 解析 exec 子命令参数（exec 专属 flag；--model/--config 已被 parseArgs 收进 overrides） */
export function parseExecArgs(args: string[]): ExecParseResult {
  let promptRaw = '';
  let resumeId: string | null = null;
  let outputFormat: ExecOutputFormat = 'text';
  let maxTurns: number | undefined;
  let allowedTools: string[] | undefined;
  let outputSchema: Record<string, unknown> | undefined;
  let model: string | undefined;
  let quiet = false;
  const positionals: string[] = [];

  // 子命令形态：`omni exec resume <id> [prompt]`
  if (args[0] === 'resume') {
    resumeId = args[1] ?? null;
    args = args.slice(2);
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
      case '--model':
        model = takeValue();
        break;
      case '--quiet':
      case '-q':
        quiet = true;
        break;
      case '--help':
      case '-h':
        throw new Error(
          '用法：omni exec "<任务>" [--output-format text|json|stream-json] [--max-turns N] [--allowed-tools a,b] [--output-schema \'{...}\'] [--quiet] [--resume <id>]\n' +
            '  stdout 只输出最终结果（text 纯文本 / json 单对象 / stream-json 轨迹+末行结果），进度（思考/工具）走 stderr；--quiet 静默 stderr 只留结果。'
        );
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
  if (!promptRaw && resumeId) {
    // `exec resume <id>` 无后续 prompt：续跑原任务（不再提交新消息）
    promptRaw = '[继续上次任务]';
  }
  if (!promptRaw) throw new Error('缺少任务描述：omni exec "<任务>"（或用 - 从 stdin 读取）');
  return { promptRaw, resumeId, outputFormat, maxTurns, allowedTools, outputSchema, model, quiet };
}

/* ─────────────────────────────── Exec 输出（stdout 干净） ─────────────────────────────── */

/** 从管道读 stdin（TTY 下不阻塞）；无数据/读取失败 → null */
function readStdinIfPiped(): string | null {
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
  // 会话：resume → 复用原文件；否则新建（json 输出的 session_id + exec resume 续跑）
  const sessionPath = opts.resumeId ? await findSessionById(opts.resumeId) : await createSession({ project: process.cwd(), model: cfg.model });
  if (opts.resumeId && !sessionPath) {
    throw new Error(`会话「${opts.resumeId}」不存在（json 输出的 session_id 或 -l 列表查看）`);
  }
  runOpts.sessionPath = sessionPath ?? undefined;
  // 轨迹记录器：stream-json 时每个事件实时输出（落盘与实时互不冲突）
  runOpts.events = await EventRecorder.open(sessionPath ?? null, opts.onEvent);
  // resume：载入历史消息（后续追加只写新增，不重复落盘）
  if (opts.resumeId && sessionPath) {
    const loaded = await loadSession(sessionPath);
    if (loaded) messages.push(...loaded.messages);
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
  messages.push({ role: 'user', content: finalPrompt });
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

/** `omni exec ...` 入口：返回进程退出码（0 成功 / 1 失败） */
export async function runExec(args: string[], overrides: ConfigOverrides): Promise<number> {
  const opts = parseExecArgs(args);
  // `-` = 整段 stdin 即 prompt；TTY 下读不到 → 报错
  let prompt = opts.promptRaw;
  if (prompt === '-') {
    const s = readStdinIfPiped();
    if (!s) throw new Error('任务为 `-` 但 stdin 无输入（echo "任务" | omni exec -）');
    prompt = s;
  }
  const ctx = prepareRun(overrides);
  const { cfg } = ctx;
  const output = new ExecOutput(opts.quiet === true, cfg.showThinking !== false);
  await attachRuntime(ctx, output);
  applyExecOpts(ctx.runOpts, opts);
  const res = await runHeadless(ctx, output, {
    prompt,
    resumeId: opts.resumeId,
    outputFormat: opts.outputFormat,
    outputSchema: opts.outputSchema,
    injectStdin: true,
    onEvent: opts.outputFormat === 'stream-json' ? (e) => process.stdout.write(JSON.stringify({ t: 'ev', e }) + '\n') : undefined,
  });
  // 结果输出（text 纯文本；json / stream-json 均为单行 JSON，可 | jq / tail -1）
  if (opts.outputFormat === 'text') {
    process.stdout.write(res.result ? res.result + '\n' : '');
  } else {
    process.stdout.write(JSON.stringify(resultJson(res, opts.outputFormat === 'stream-json' ? { t: 'result' } : {})) + '\n');
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

/**
 * Hooks 生命周期自动化（对标 Claude Code hooks）：
 * 在生命周期事件上挂 shell 命令，JSON 协议——事件上下文经 stdin 喂入，stdout 返回 JSON 决策。
 *
 * 事件：
 *   · UserPromptSubmit —— 用户提交 prompt 后（返回 `updatedPrompt` 可改写 prompt）
 *   · PreToolUse —— 工具调用前（JSON 返回 `decision: "block"` 可**硬拦截**；`updatedInput` 改写参数）
 *   · PostToolUse —— 工具调用后（`hookSpecificOutput` 输出回传上下文字段，如 lint 结果）
 *   · Stop —— agent 准备结束（返回 block 可要求继续修；`stop_hook_active` 只允许续一次防死循环）
 *   · Notification —— fire-and-forget 通知（会话完成等）
 *   · SessionStart —— 会话开始（每会话一次；`hookSpecificOutput` 注入上下文）
 *   · SubagentStart / SubagentStop —— 子代理开始/结束（任务与结论回传）
 *   · PreCompact —— 长对话摘要压缩前（可做归档/通知；fire-and-forget）
 *
 * matcher 按工具名过滤（`*` = 全部，`read_*` = 前缀通配，缺省 = `*`）；
 * 超时 / 命令不存在 / 输出非 JSON → **降级放行**（不阻塞主流程），并把原因（含 stderr）回显。
 *
 * 分层配置：config 各层（全局 → 项目 → 自定义）的 hooks **叠加合并**（同事件全部运行，
 * 低层在前）——项目 hook 与全局 hook 共存，无需在单层重复声明。
 */
import { spawn } from 'node:child_process';

export type HookEventName =
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Stop'
  | 'Notification'
  | 'SessionStart'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact';

export const HOOK_EVENTS: HookEventName[] = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'Notification',
  'SessionStart',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
];

export interface HookDefinition {
  /** 匹配工具名：`*` = 全部（缺省）；`read_*` / `*_file` = 通配；仅 PreToolUse / PostToolUse 有意义 */
  matcher?: string;
  /** shell 命令（如 `sh lint.sh`）：事件 JSON 经 stdin 喂入，stdout JSON 为决策 */
  command: string;
  /** 超时毫秒（默认 60s）；超时 = 降级放行 */
  timeoutMs?: number;
}

/** config `hooks` 字段：{ 事件名: [HookDefinition] } */
export type HooksConfig = Partial<Record<HookEventName, HookDefinition[]>>;

/** 喂给 hook 脚本的 stdin JSON（Claude Code hook 协议子集） */
export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd: string;
  hook_event_name: HookEventName;
  source: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** PostToolUse：工具执行结果（截断后） */
  tool_response?: string;
  /** UserPromptSubmit：用户提交的原始 prompt */
  prompt?: string;
  /** Stop：模型已被要求继续过一次时 true（只允许再续一次，防死循环） */
  stop_hook_active?: boolean;
}

/** hook 脚本的 stdout JSON 决策（各事件取自己关心的字段，其余忽略） */
export interface HookOutputJson {
  /** PreToolUse / Stop：approve | block / continue | block */
  decision?: 'approve' | 'block' | 'continue';
  /** SessionStart / 其它：注入上下文的额外说明（如启动策略） */
  description?: string;
  /** block 时的原因（回传模型/回显） */
  reason?: string;
  /** UserPromptSubmit：改写后的 prompt（替代原 prompt） */
  updatedPrompt?: string;
  /** PreToolUse：合并进工具参数（覆盖同名键，供 hook 补充/修正参数） */
  updatedInput?: Record<string, unknown>;
  /** PostToolUse / 其它：追加回传上下文的输出行（如 lint 结果） */
  hookSpecificOutput?: string[];
  /** Stop：是否抑制停止提示输出 */
  suppressOutput?: boolean;
}

export interface HookRunResult {
  /** 解析出的 JSON（非 JSON / 失败 = null，调用方降级放行） */
  json: HookOutputJson | null;
  /** 原始 stdout（诊断用） */
  raw: string;
  /** 是否超时/异常（降级放行 + 回显原因） */
  failed: boolean;
  /** 失败/降级原因 */
  failReason?: string;
}

export interface HookRunnerOptions {
  /** config hooks 字段（缺省 undefined = 全部事件 no-op） */
  hooks?: HooksConfig;
  cwd: string;
  sessionId?: string;
  transcriptPath?: string;
  /** 回显 hook 输出（TUI 对话流 / console stderr；缺省静默） */
  onOutput?: (event: HookEventName, lines: string[]) => void;
}

/** 通配符匹配：`*` = 全部；`read_*` = 前缀；`*_file` = 后缀；缺省 = `*` */
export function matchTool(matcher: string | undefined, toolName: string): boolean {
  if (!matcher || matcher === '*') return true;
  if (!matcher.includes('*')) return matcher === toolName;
  const re = new RegExp(`^${matcher.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(toolName);
}

/**
 * 执行单个 hook：spawn shell 命令 → stdin 喂 JSON → 收集 stdout → 解析 JSON。
 * 超时 kill（SIGKILL）+ 降级返回 { json: null, failed: true }。
 */
export function runHook(
  command: string,
  input: HookInput,
  timeoutMs: number,
  cwd: string
): Promise<HookRunResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, { shell: true, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ json: null, raw: '', failed: true, failReason: `无法启动命令：${err instanceof Error ? err.message : err}` });
      return;
    }
    let out = '';
    let errOut = '';
    let done = false;
    const finish = (failed: boolean, failReason?: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const trimmed = out.trim();
      resolve({ json: parseHookJson(trimmed), raw: trimmed, failed, failReason });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(true, `超时（>${timeoutMs}ms 被终止）`);
    }, timeoutMs);
    // 防 stdout 无限膨胀（上限 1MB，超限截断仍尝试解析）
    let outLen = 0;
    child.stdout.on('data', (d: Buffer) => {
      outLen += d.length;
      if (outLen <= 1024 * 1024) out += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      errOut += d.toString();
      if (errOut.length > 16_384) errOut = errOut.slice(-16_384);
    });
    child.on('error', (err) => finish(true, `命令错误：${err.message}`));
    child.on('close', (code) => {
      // 非零退出码不视为失败（hook 可能用退出码传状态）；只解析 stdout JSON。
      // stderr 捕获：失败/无输出时把 stderr 尾部并入失败原因（排障信息不丢）
      if (code !== 0 && !out.trim()) {
        const stderrTail = errOut.trim().slice(-400);
        finish(true, `命令退出码 ${code}（无输出）${stderrTail ? `：${stderrTail}` : ''}`);
      } else finish(false);
    });
    child.stdin.on('error', () => {}); // 脚本不读 stdin → EPIPE 忽略
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

/** 解析 hook stdout 为 JSON：整体解析 → 失败则取末尾最后一个 `{...}` 对象（脚本可能先打印日志） */
function parseHookJson(text: string): HookOutputJson | null {
  if (!text) return null;
  try {
    const obj = JSON.parse(text);
    return obj && typeof obj === 'object' ? (obj as HookOutputJson) : null;
  } catch {
    const m = /\{[\s\S]*\}/.exec(text);
    if (!m) return null;
    try {
      const obj = JSON.parse(m[0]);
      return obj && typeof obj === 'object' ? (obj as HookOutputJson) : null;
    } catch {
      return null;
    }
  }
}

/** 把 hook 输出回显（截断行数，防刷屏；完整 hookSpecificOutput 仍回传模型） */
const ECHO_LINES = 5;
function echoOutput(opts: HookRunnerOptions | undefined, event: HookEventName, lines: string[]): void {
  if (!lines.length || lines.every((l) => !l.trim())) return;
  opts?.onOutput?.(event, lines.slice(0, ECHO_LINES));
}

/**
 * Hook 运行器：把配置的 hooks 暴露成各事件的异步方法。未配置的事件 = no-op。
 * 所有方法失败降级放行（hook 是辅助，不能因 hook 挂了把 agent 卡死）。
 */
export class HookRunner {
  constructor(private opts: HookRunnerOptions) {}

  /** 是否配置了该事件（loop / 交互层据此跳过空调用） */
  has(event: HookEventName): boolean {
    const defs = this.opts.hooks?.[event];
    return !!defs && defs.length > 0;
  }

  /** 该事件的全部定义（匹配给定工具名的过滤后列表） */
  private defsFor(event: HookEventName, toolName?: string): HookDefinition[] {
    return (this.opts.hooks?.[event] ?? []).filter((d) => (toolName === undefined ? true : matchTool(d.matcher, toolName)));
  }

  private runAll(
    event: HookEventName,
    buildInput: (d: HookDefinition, i: number) => HookInput,
    toolName?: string
  ): Promise<HookRunResult[]> {
    const defs = this.defsFor(event, toolName);
    return Promise.all(
      defs.map((d, i) => runHook(d.command, buildInput(d, i), d.timeoutMs ?? 60_000, this.opts.cwd))
    );
  }

  private baseInput(event: HookEventName, extra: Partial<HookInput> = {}): HookInput {
    return {
      cwd: this.opts.cwd,
      hook_event_name: event,
      source: 'omni',
      session_id: this.opts.sessionId,
      transcript_path: this.opts.transcriptPath,
      ...extra,
    };
  }

  /**
   * UserPromptSubmit：用户提交 prompt 后（可改写）。返回改写后的 prompt 与收集的输出行。
   * 最后一个返回 updatedPrompt 的 hook 生效；无改写 = 原 prompt。
   */
  async userPromptSubmit(prompt: string): Promise<{ prompt: string; output: string[] }> {
    if (!this.has('UserPromptSubmit')) return { prompt, output: [] };
    const results = await this.runAll('UserPromptSubmit', () => this.baseInput('UserPromptSubmit', { prompt }));
    let finalPrompt = prompt;
    const output: string[] = [];
    for (const r of results) {
      if (r.failed) {
        output.push(`[hook 失败（${r.failReason ?? '未知错误'}）→ 已忽略]`);
        echoOutput(this.opts, 'UserPromptSubmit', output.slice(-1));
        continue;
      }
      if (r.json?.updatedPrompt && r.json.updatedPrompt.trim()) {
        finalPrompt = r.json.updatedPrompt; // 最后一个改写生效
        output.push(`已改写 prompt：${finalPrompt.slice(0, 80)}${finalPrompt.length > 80 ? '…' : ''}`);
      }
      if (r.json?.hookSpecificOutput?.length) {
        output.push(...r.json.hookSpecificOutput);
      }
    }
    echoOutput(this.opts, 'UserPromptSubmit', output);
    return { prompt: finalPrompt, output };
  }

  /**
   * PreToolUse：工具调用前。任一 hook block → 硬拦截（allow=false + reason）；
   * updatedInput 合并进工具参数（后执行的 hook 覆盖同名键）。hookSpecificOutput 拼接进输出。
   */
  async preToolUse(
    toolName: string,
    toolInput: Record<string, unknown>
  ): Promise<{ allow: boolean; reason?: string; updatedInput?: Record<string, unknown>; output: string[] }> {
    if (!this.has('PreToolUse')) return { allow: true, output: [] };
    const results = await this.runAll(
      'PreToolUse',
      () => this.baseInput('PreToolUse', { tool_name: toolName, tool_input: toolInput }),
      toolName
    );
    let allow = true;
    let reason: string | undefined;
    let updatedInput: Record<string, unknown> | undefined;
    const output: string[] = [];
    for (const r of results) {
      if (r.failed) {
        output.push(`[PreToolUse hook 失败（${r.failReason ?? '未知错误'}）→ 放行]`);
        echoOutput(this.opts, 'PreToolUse', output.slice(-1));
        continue;
      }
      if (r.json?.decision === 'block') {
        allow = false;
        reason = r.json.reason ?? 'PreToolUse hook 阻止了该调用';
      }
      if (r.json?.updatedInput && typeof r.json.updatedInput === 'object') {
        updatedInput = { ...(updatedInput ?? {}), ...r.json.updatedInput };
      }
      if (r.json?.hookSpecificOutput?.length) output.push(...r.json.hookSpecificOutput);
    }
    if (!allow) output.push(`已拦截：${reason}`);
    echoOutput(this.opts, 'PreToolUse', output);
    return { allow, reason, updatedInput, output };
  }

  /**
   * PostToolUse：工具调用后。hookSpecificOutput 拼接成 `extra` 追加回传上下文
   *（如 lint 结果让模型自修复）；工具结果照常回传。
   */
  async postToolUse(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolResponse: string
  ): Promise<{ extra: string[]; output: string[] }> {
    if (!this.has('PostToolUse')) return { extra: [], output: [] };
    const results = await this.runAll(
      'PostToolUse',
      () => this.baseInput('PostToolUse', { tool_name: toolName, tool_input: toolInput, tool_response: toolResponse }),
      toolName
    );
    const extra: string[] = [];
    const output: string[] = [];
    for (const r of results) {
      if (r.failed) {
        output.push(`[PostToolUse hook 失败（${r.failReason ?? '未知错误'}）→ 忽略]`);
        echoOutput(this.opts, 'PostToolUse', output.slice(-1));
        continue;
      }
      if (r.json?.hookSpecificOutput?.length) {
        extra.push(...r.json.hookSpecificOutput);
        output.push(...r.json.hookSpecificOutput);
      }
    }
    echoOutput(this.opts, 'PostToolUse', output);
    return { extra, output };
  }

  /**
   * Stop：agent 准备结束。任一 hook block → 要求继续（allow=false + reason，loop 把 reason
   * 作为 system 消息回传模型继续修）。`stop_hook_active` 已 true 时忽略 block（只允许续一次）。
   */
  async stop(stopHookActive: boolean): Promise<{ allow: boolean; reason?: string }> {
    if (!this.has('Stop')) return { allow: true };
    const results = await this.runAll('Stop', () => this.baseInput('Stop', { stop_hook_active: stopHookActive }));
    let allow = true;
    let reason: string | undefined;
    const output: string[] = [];
    for (const r of results) {
      if (r.failed) {
        output.push(`[Stop hook 失败（${r.failReason ?? '未知错误'}）→ 放行]`);
        echoOutput(this.opts, 'Stop', output.slice(-1));
        continue;
      }
      if (r.json?.decision === 'block' && !stopHookActive) {
        allow = false;
        reason = r.json.reason ?? 'Stop hook 要求继续修复';
        output.push(`要求继续：${reason}`);
      }
    }
    echoOutput(this.opts, 'Stop', output);
    return { allow, reason };
  }

  /** Notification：fire-and-forget（不等待、失败静默） */
  notification(payload: Record<string, unknown> = {}): void {
    void this.fireAndCollect('Notification', { ...payload });
  }

  /** 通用 fire-and-forget 收集（Notification/SubagentStart/SubagentStop/PreCompact 共用） */
  private async fireAndCollect(event: HookEventName, payload: Record<string, unknown>): Promise<string[]> {
    if (!this.has(event)) return [];
    const results = await this.runAll(event, () => this.baseInput(event, { ...payload }));
    const lines: string[] = [];
    for (const r of results) {
      if (r.failed) lines.push(`[${event} hook 失败（${r.failReason ?? '未知错误'}）→ 已忽略]`);
      else if (r.json?.hookSpecificOutput?.length) lines.push(...r.json.hookSpecificOutput);
    }
    echoOutput(this.opts, event, lines);
    return lines;
  }

  /**
   * SessionStart：会话开始（**每会话只触发一次**，runAgent 首轮调用）。
   * 返回 hookSpecificOutput（注入上下文的额外内容，如启动策略/环境快照）。
   */
  async sessionStart(): Promise<string[]> {
    if (this.sessionStarted) return [];
    this.sessionStarted = true;
    return this.fireAndCollect('SessionStart', { message_type: 'session_start' });
  }

  /** SubagentStart：子代理开始（任务回传）；fire-and-forget */
  subagentStart(task: string): void {
    void this.fireAndCollect('SubagentStart', { message_type: 'subagent_start', subagent_task: task });
  }

  /** SubagentStop：子代理结束（结论回传）；fire-and-forget */
  subagentStop(result: string): void {
    void this.fireAndCollect('SubagentStop', { message_type: 'subagent_stop', subagent_result: result.slice(0, 2000) });
  }

  /** PreCompact：长对话摘要压缩前（归档/通知）；fire-and-forget */
  preCompact(messageCount: number): void {
    void this.fireAndCollect('PreCompact', { message_type: 'pre_compact', message_count: messageCount });
  }

  /** 会话开始标记（SessionStart 每会话一次；runAgent 首轮置位） */
  private sessionStarted = false;
  /** 重置会话开始标记（/clear 后新一轮会话重新触发；单任务无所谓） */
  resetSessionStart(): void {
    this.sessionStarted = false;
  }
}

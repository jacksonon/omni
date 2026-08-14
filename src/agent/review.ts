/**
 * 代码审查（/review 命令）：对工作区改动做一次「typecheck + git diff → LLM 审查」。
 *
 * 流程（与 /init 同类：独立轻量 LLM 调用，不进入 messages 历史）：
 *   1. `git diff HEAD` 收集工作区改动（未跟踪的新文件不在 diff 里，用 git status 补充）；
 *   2. 跑项目自带的 typecheck（package.json scripts.typecheck，缺失则试 lint）；
 *   3. 把 diff + typecheck 输出喂给一次流式 LLM 调用，输出问题清单与改进建议。
 *
 * 失败策略：git/typecheck 不可用时降级（只审能拿到的部分）；LLM 调用失败返回 null
 * （命令层提示，不打断对话）。
 */
import { exec } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

const execAsync = promisify(exec);

/** 审查系统提示：mock server 用 messages[0] 前缀识别该请求 */
export const REVIEW_SYSTEM_PROMPT =
  '你是资深代码审查员。根据给出的 git diff 与 typecheck 结果，审查代码改动：\n' +
  '1. 指出明显的 bug、边界问题、安全问题与风格问题；\n' +
  '2. 对每个问题说明改动位置与改进建议；\n' +
  '3. typecheck 报错必须逐条说明如何修复；\n' +
  '4. 用中文输出，简洁有条理（Markdown 列表），不要复述 diff 全文。';

/** 执行命令并捕获输出（不继承 stdio——TUI 全屏下子进程输出会污染渲染） */
export async function captureCommand(
  command: string,
  timeoutMs = 60_000
): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: process.cwd(),
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    const out = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
    return { ok: true, output: out || '（无输出）' };
  } catch (err: any) {
    const parts = [`退出码: ${err.code ?? 'unknown'}${err.killed ? '（超时被终止）' : ''}`];
    if (err.stdout) parts.push(String(err.stdout).trim());
    if (err.stderr) parts.push(String(err.stderr).trim());
    return { ok: false, output: parts.join('\n') };
  }
}

/** 检测项目自带的校验命令：package.json scripts 优先 typecheck，其次 lint；都无返回 null */
export function detectCheckCommand(cwd = process.cwd()): string | null {
  try {
    const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    const scripts = pkg?.scripts ?? {};
    if (typeof scripts.typecheck === 'string') return 'npm run typecheck';
    if (typeof scripts.lint === 'string') return 'npm run lint';
    return null;
  } catch {
    return null;
  }
}

/** 收集工作区改动：git diff HEAD（含暂存）+ git status 未跟踪文件 */
export async function collectDiff(): Promise<{ ok: boolean; output: string }> {
  const diff = await captureCommand('git diff HEAD -- .');
  const status = await captureCommand('git status --short');
  if (!diff.ok && !status.ok) return { ok: false, output: diff.output };
  const parts = [
    diff.output !== '（无输出）' ? diff.output : '（无改动）',
    status.output !== '（无输出）' ? `git status:\n${status.output}` : '',
  ].filter(Boolean);
  return { ok: true, output: parts.join('\n\n').slice(0, 50_000) };
}

/** 组装审查输入（diff + typecheck 结果） */
export function buildReviewInput(
  diff: string,
  check: { command: string | null; output: string }
): string {
  return [
    check.command
      ? `## typecheck 结果（${check.command}）\n${check.output.slice(0, 10_000)}`
      : '## typecheck\n（项目没有 typecheck/lint 脚本，跳过）',
    `## git diff（工作区改动）\n${diff.slice(0, 30_000)}`,
  ].join('\n\n');
}

/**
 * 一次流式 LLM 调用审查代码改动；失败返回 null（命令层提示，不打扰对话）。
 */
export async function reviewCode(
  client: OpenAI,
  model: string,
  diff: string,
  check: { command: string | null; output: string }
): Promise<string | null> {
  const transcript: ChatCompletionMessageParam[] = [
    { role: 'system', content: REVIEW_SYSTEM_PROMPT },
    { role: 'user', content: buildReviewInput(diff, check) },
  ];
  try {
    const stream = await client.chat.completions.create({
      model,
      messages: transcript,
      stream: true,
      max_tokens: 2000,
    });
    let text = '';
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta?.content ?? '';
    }
    return text.trim() || null;
  } catch {
    return null;
  }
}

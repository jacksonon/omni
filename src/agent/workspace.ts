/**
 * 工作目录解析（`/cd` 共享助手，2026-09 补课——对标 Codex /cd）：
 * 运行中切换会话工作目录，复用进程 cwd（CLI/TUI 单会话进程；Web 走工作区切换）。
 *
 * 纯函数：只做参数解析与校验，不执行 chdir（调用方决定 UI 反馈与生效时机）。
 */
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type CdResolveResult =
  | { kind: 'show'; dir: string }
  | { kind: 'change'; dir: string }
  | { kind: 'error'; error: string };

/**
 * 解析 `/cd` 参数：
 *  - 空参数 → show（调用方展示当前目录）
 *  - `~` / `~/x` → 家目录展开
 *  - 相对路径 → 基于 cwd 解析
 *  - 目标不存在 / 不是目录 → error（可读原因）
 */
export function resolveCdArg(arg: string | undefined, cwd: string): CdResolveResult {
  const raw = (arg ?? '').trim();
  if (!raw) return { kind: 'show', dir: cwd };
  let target = raw;
  if (target === '~') target = os.homedir();
  else if (target.startsWith('~/') || target.startsWith('~\\')) target = path.join(os.homedir(), target.slice(2));
  const abs = path.resolve(cwd, target);
  try {
    if (!existsSync(abs)) return { kind: 'error', error: `目录不存在：${abs}` };
    if (!statSync(abs).isDirectory()) return { kind: 'error', error: `不是目录：${abs}` };
  } catch (err) {
    return { kind: 'error', error: `无法访问：${abs}（${err instanceof Error ? err.message : String(err)}）` };
  }
  return { kind: 'change', dir: abs };
}

/**
 * TUI 崩溃日志：把未捕获异常/未处理拒绝/重绘错误写入磁盘，
 * 供“闪退”类问题事后排查（崩溃瞬间终端恢复，stderr 输出不可见）。
 *
 * 日志位置：$XDG_CONFIG_HOME/omni/tui-crash.log（默认 ~/.config/omni/tui-crash.log），
 * 与配置文件同目录，便于发现。追加写，不清空；每条带时间戳与标签。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function crashLogPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'omni', 'tui-crash.log');
}

/** 写一条崩溃日志（写失败不影响主流程） */
export function logCrash(tag: string, err: unknown): void {
  try {
    const file = crashLogPath();
    mkdirSync(path.dirname(file), { recursive: true });
    const detail =
      err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : JSON.stringify(err);
    appendFileSync(file, `\n===== ${new Date().toISOString()} [${tag}] =====\n${detail}\n`);
  } catch {
    // 日志写入失败时静默：不应因为记录崩溃而二次崩溃
  }
}

/** 记录启动/正常退出标记（帮助区分“干净退出”与“崩溃”） */
export function logLifecycle(tag: 'start' | 'exit-clean', detail: string): void {
  try {
    const file = crashLogPath();
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `\n[${new Date().toISOString()}] ${tag}: ${detail}\n`);
  } catch {
    // 同上
  }
}

/**
 * 输入历史跨会话持久化（codex composer history 对等：persistent + in-session 合并，
 * Up/Down 与 Ctrl+R 跨进程可用）。readline 的 rl.history 本身 newest-first，
 * 落盘 oldest→newest JSON 数组（上限 200 条，只收录非空行）。
 * TTY 交互独占：管道模式不读写（任务文本不进回想）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 历史条数上限（codex 侧有界批量；超限丢最旧） */
export const INPUT_HISTORY_MAX = 200;

function historyFilePath(): string {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(configHome, 'omni', 'input-history.json');
}

/** 读回历史（oldest→newest；缺失/损坏回空数组，不打扰启动） */
export function loadInputHistory(): string[] {
  try {
    const raw = readFileSync(historyFilePath(), 'utf8');
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
      .slice(-INPUT_HISTORY_MAX);
  } catch {
    return [];
  }
}

/**
 * 把 readline 历史落盘（入参 newest-first，即 rl.history 原样；空行过滤、上限截断）。
 * 同步小文件写（提交级调用，sub-ms；失败静默——历史丢了不该打断对话）。
 */
export function saveInputHistory(newestFirst: readonly string[]): void {
  try {
    const olds = [...newestFirst]
      .filter((x) => typeof x === 'string' && x.trim() !== '')
      .slice(0, INPUT_HISTORY_MAX)
      .reverse();
    const file = historyFilePath();
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, `${JSON.stringify(olds)}\n`);
  } catch {
    /* 历史持久化永不打断交互 */
  }
}

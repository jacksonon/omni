/**
 * 思考过程展示：流式捕获 reasoning_content / reasoning / thinking 字段，
 * 以浅灰色实时显示并保留在屏幕上（不折叠），完整内容同时落盘 .omni/last-thinking.md。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dim, isTTY } from '../ui.js';
import type { ThinkingDisplay } from './types.js';

const NOOP_DISPLAY: ThinkingDisplay = {
  get shown() {
    return false;
  },
  write() {},
  finish() {},
};

/** 粗略估算字符串的终端显示宽度（CJK/emoji 按 2 列，其余按 1 列） */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    w += ch.codePointAt(0)! > 0x2e7f ? 2 : 1;
  }
  return w;
}

const PREFIX = '💭 '; // 思考内容行前缀
const PREFIX_W = 3; // 💭(2 列) + 空格(1 列)

export function createThinkingDisplay(enabled: boolean): ThinkingDisplay {
  if (!enabled) return NOOP_DISPLAY; // 设置里关闭思考展示 → 完全静默
  let shown = false;
  let col = 0; // 当前行内容列数（不含前缀）
  let atLineStart = false; // 行首待输出前缀（前缀延迟到字符到达，避免空行残留）
  let endedWithNewline = true; // 最后输出的字符是否为换行
  return {
    get shown() {
      return shown;
    },
    write(piece: string) {
      if (!isTTY) return; // 管道模式不内联显示，避免污染输出
      // 归一化换行：CRLF/孤立 \r 会让终端把光标拉回行首，破坏列计数
      piece = piece.replace(/\r\n/g, '\n').replace(/\r/g, '');
      if (!shown) {
        shown = true;
        process.stdout.write(`${dim('💭 思考过程')}\n`);
        col = 0;
        atLineStart = true;
        endedWithNewline = true;
      }
      const maxCols = Math.max(20, (process.stdout.columns ?? 80) - PREFIX_W - 2);
      const emitPrefix = () => {
        process.stdout.write(dim(PREFIX));
        atLineStart = false;
      };
      let buf = ''; // 待输出的普通文本（避免逐字符包裹 ANSI 码）
      const flush = () => {
        if (!buf) return;
        if (atLineStart) emitPrefix(); // 行首的第一段内容前补前缀
        process.stdout.write(dim(buf));
        buf = '';
      };
      for (const ch of piece) {
        if (ch === '\n') {
          flush();
          process.stdout.write('\n');
          col = 0;
          atLineStart = true;
          endedWithNewline = true;
          continue;
        }
        const w = ch.codePointAt(0)! > 0x2e7f ? 2 : 1;
        if (atLineStart) emitPrefix(); // 行首字符前输出前缀
        if (col + w > maxCols) {
          // 当前行放不下 → 自行折行，避免终端软换行破坏后续对齐
          flush();
          process.stdout.write('\n');
          col = 0;
          atLineStart = true;
          emitPrefix();
        }
        buf += ch;
        col += w; // 实时累计当前行宽度（chunk 内折行判断依赖实时 col）
        endedWithNewline = false;
      }
      flush();
    },
    finish() {
      if (!shown) return;
      // 最后一行若未以换行结束，补一个换行，让后续内容从新行开始
      if (!endedWithNewline) process.stdout.write('\n');
      shown = false;
      col = 0;
      atLineStart = false;
      endedWithNewline = true;
    },
  };
}

/** 从流式 delta 中提取思考内容（兼容 reasoning_content / reasoning / thinking 三种字段命名） */
export function extractReasoning(delta: unknown): string | undefined {
  if (!delta || typeof delta !== 'object') return undefined;
  const d = delta as Record<string, unknown>;
  for (const key of ['reasoning_content', 'reasoning', 'thinking']) {
    const v = d[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/** 把完整思考内容落盘（供回溯查看），失败时静默返回 null */
export async function saveThinking(text: string): Promise<string | null> {
  if (!text.trim()) return null;
  try {
    const dir = path.join(process.cwd(), '.omni');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'last-thinking.md');
    await fs.writeFile(file, text.trim(), 'utf8');
    return file;
  } catch {
    return null;
  }
}

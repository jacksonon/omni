/**
 * TUI Vim 键位（2026-09 补课，输入框 Vim 模式）。
 *
 * 纯文本变换（text + cursorOffset → text + cursorOffset），不依赖 OpenTUI——
 * interactive.ts 把结果写回 TextareaRenderable（replaceText 保留 undo 历史），
 * 单测直接断言纯函数。
 *
 * 支持子集（normal 模式）：
 *   移动 h j k l w b e 0 $ gg G
 *   进入插入 i a I A o O
 *   编辑 x dd cc dw yy p u（u 由 Textarea 自身 undo 承担，这里不处理）
 */

export interface VimRuntime {
  /** 多键前缀（d/c/y/g） */
  pending: string;
  /** 行寄存器（yy/p） */
  register: string;
}

export interface VimEdit {
  text: string;
  cursor: number;
  insert: boolean;
  pending: string;
  register: string;
}

const isWordChar = (ch: string): boolean => /[\p{L}\p{N}_]/u.test(ch);

function lineStartOf(text: string, cursor: number): number {
  const nl = text.lastIndexOf('\n', Math.max(0, cursor - 1));
  return nl < 0 ? 0 : nl + 1;
}

function lineEndOf(text: string, cursor: number): number {
  const nl = text.indexOf('\n', cursor);
  return nl < 0 ? text.length : nl;
}

/** 当前行内容（不含换行） */
export function vimCurrentLine(text: string, cursor: number): { start: number; end: number } {
  return { start: lineStartOf(text, cursor), end: lineEndOf(text, cursor) };
}

/** 下一个词首（w）：先跳过当前词，再跳过空白/标点 */
function nextWordStart(text: string, cursor: number): number {
  let i = cursor;
  if (i < text.length && isWordChar(text[i])) {
    while (i < text.length && isWordChar(text[i])) i++;
  }
  while (i < text.length && !isWordChar(text[i])) i++;
  return i;
}

/** 前一个词首（b） */
function prevWordStart(text: string, cursor: number): number {
  let i = cursor - 1;
  while (i > 0 && !isWordChar(text[i])) i--;
  while (i > 0 && isWordChar(text[i - 1])) i--;
  return Math.max(0, i);
}

/** 词尾（e）：移动到当前/下一个词的最后一个字符 */
function wordEnd(text: string, cursor: number): number {
  let i = cursor;
  if (i < text.length && isWordChar(text[i])) {
    while (i + 1 < text.length && isWordChar(text[i + 1])) i++;
    return i;
  }
  while (i < text.length && !isWordChar(text[i])) i++;
  while (i + 1 < text.length && isWordChar(text[i + 1])) i++;
  return Math.min(Math.max(0, i), Math.max(0, text.length - 1));
}

/** 上下移动一行（保持列号，clamp 到行尾） */
function moveLine(text: string, cursor: number, delta: 1 | -1): number {
  const col = cursor - lineStartOf(text, cursor);
  if (delta === -1) {
    const start = lineStartOf(text, cursor);
    if (start === 0) return cursor;
    const prevStart = lineStartOf(text, start - 1);
    const prevEnd = lineEndOf(text, prevStart);
    return Math.min(prevStart + col, prevEnd);
  }
  const end = lineEndOf(text, cursor);
  if (end >= text.length) return cursor;
  const nextStart = end + 1;
  const nextEnd = lineEndOf(text, nextStart);
  return Math.min(nextStart + col, nextEnd);
}

/** 删除 current 行（含换行；最后一行则删前一换行） */
function deleteLine(text: string, cursor: number): { text: string; cursor: number } {
  const { start, end } = vimCurrentLine(text, cursor);
  if (end < text.length) {
    return { text: text.slice(0, start) + text.slice(end + 1), cursor: start };
  }
  if (start > 0) {
    return { text: text.slice(0, start - 1), cursor: Math.max(0, start - 1) };
  }
  return { text: '', cursor: 0 };
}

/**
 * normal 模式按键处理。返回 null = 未消费（调用方放行给输入框，如 Ctrl 组合）。
 * 已消费的按键一律返回 VimEdit（即使文本未变，如纯移动）。
 */
export function applyVimNormal(
  text: string,
  cursor: number,
  key: string,
  rt: VimRuntime
): VimEdit | null {
  const base = (over: Partial<VimEdit> = {}): VimEdit => ({
    text,
    cursor: Math.max(0, Math.min(cursor, text.length)),
    insert: false,
    pending: '',
    register: rt.register,
    ...over,
  });

  // 多键前缀：d/c/y/g
  if (rt.pending) {
    const p = rt.pending;
    const pending = '';
    if (p === 'd') {
      if (key === 'd') {
        const r = deleteLine(text, cursor);
        return base({ text: r.text, cursor: Math.min(r.cursor, r.text.length), pending });
      }
      if (key === 'w') {
        const to = nextWordStart(text, cursor);
        return base({ text: text.slice(0, cursor) + text.slice(to), cursor, pending });
      }
      return base({ pending }); // 未知组合：清前缀
    }
    if (p === 'c') {
      if (key === 'c') {
        const { start, end } = vimCurrentLine(text, cursor);
        return base({ text: text.slice(0, start) + text.slice(end), cursor: start, insert: true, pending });
      }
      if (key === 'w') {
        const to = nextWordStart(text, cursor);
        return base({ text: text.slice(0, cursor) + text.slice(to), cursor, insert: true, pending });
      }
      return base({ pending });
    }
    if (p === 'y') {
      if (key === 'y') {
        const { start, end } = vimCurrentLine(text, cursor);
        return base({ register: text.slice(start, end) + '\n', pending });
      }
      return base({ pending });
    }
    if (p === 'g') {
      if (key === 'g') return base({ cursor: 0, pending });
      return base({ pending });
    }
    return base({ pending });
  }

  switch (key) {
    case 'h':
      return base({ cursor: Math.max(0, cursor - 1) });
    case 'l':
      return base({ cursor: Math.min(text.length, cursor + 1) });
    case 'j':
      return base({ cursor: moveLine(text, cursor, 1) });
    case 'k':
      return base({ cursor: moveLine(text, cursor, -1) });
    case 'w':
      return base({ cursor: nextWordStart(text, cursor) });
    case 'b':
      return base({ cursor: prevWordStart(text, cursor) });
    case 'e':
      return base({ cursor: wordEnd(text, cursor) });
    case '0':
      return base({ cursor: lineStartOf(text, cursor) });
    case '$':
      return base({ cursor: lineEndOf(text, cursor) });
    case 'g':
    case 'd':
    case 'c':
    case 'y':
      return base({ pending: key });
    case 'G':
      return base({ cursor: text.length });
    case 'i':
      return base({ insert: true });
    case 'a':
      return base({ cursor: Math.min(text.length, cursor + 1), insert: true });
    case 'I':
      return base({ cursor: lineStartOf(text, cursor), insert: true });
    case 'A':
      return base({ cursor: lineEndOf(text, cursor), insert: true });
    case 'o': {
      const end = lineEndOf(text, cursor);
      return base({ text: text.slice(0, end) + '\n' + text.slice(end), cursor: end + 1, insert: true });
    }
    case 'O': {
      const start = lineStartOf(text, cursor);
      return base({ text: text.slice(0, start) + '\n' + text.slice(start), cursor: start, insert: true });
    }
    case 'x':
      return cursor < text.length ? base({ text: text.slice(0, cursor) + text.slice(cursor + 1) }) : base();
    case 'p': {
      if (!rt.register) return base();
      const end = lineEndOf(text, cursor);
      const inserted = rt.register.endsWith('\n') ? rt.register : rt.register + '\n';
      return base({
        text: text.slice(0, end) + '\n' + inserted + text.slice(end + (end < text.length ? 1 : 0)),
        cursor: end + 1,
        register: rt.register,
      });
    }
    default:
      return null; // 未绑定（含 Ctrl 组合/功能键）：交给外层放行
  }
}

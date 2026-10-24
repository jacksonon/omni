/** mini 提交类型与键盘协议；队列状态独立于 readline 的隐藏行缓冲。 */
export type MiniSubmitMode = 'queue' | 'steer';
export interface MiniPendingInput {
  id: number;
  mode: MiniSubmitMode;
  text: string;
}
export interface MiniInputActions {
  busy(): boolean;
  pending(): readonly MiniPendingInput[];
  submit(text: string, mode: MiniSubmitMode): boolean;
  editLastQueued(): string | null;
  continueLine(text: string): void;
}
export interface MiniInputKey {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  super?: boolean;
  sequence?: string;
  miniHandled?: boolean;
  miniBuffered?: boolean;
}

/** 请求区分 Cmd/Ctrl+Enter；不支持的终端会忽略。退出时弹出协议栈。 */
export const ENABLE_MINI_KEYBOARD = '\x1b[>1u';
export const DISABLE_MINI_KEYBOARD = '\x1b[<u';

/** 仅解码 mini 需要的控制键；返回 null 表示原生 readline 继续负责。 */
export function miniExtendedKey(sequence: string): (MiniInputKey & { release: boolean; text: string }) | null {
  const kitty = /^\x1b\[(\d+)(?:;(\d+)(?::([123]))?)?u$/.exec(sequence);
  const xterm = /^\x1b\[27;(\d+);(13|9|27|127)~$/.exec(sequence);
  if (!kitty && !xterm) return null;
  const code = Number(kitty?.[1] ?? xterm![2]);
  if (![13, 9, 27, 127].includes(code) && (code < 32 || code > 126)) return null;
  const modifiers = Math.max(0, Number(kitty?.[2] ?? xterm?.[1] ?? 1) - 1);
  return {
    name: code === 13 ? 'return' : code === 9 ? 'tab' : code === 27 ? 'escape' : code === 127 ? 'backspace' : code === 32 ? 'space' : String.fromCharCode(code).toLowerCase(),
    text: String.fromCharCode(code),
    shift: !!(modifiers & 1),
    // Node 的 meta 通常代表 Option；Kitty 的 super 才是 macOS Command。
    meta: !!(modifiers & 2),
    ctrl: !!(modifiers & 4),
    super: !!(modifiers & (8 | 32)),
    sequence,
    release: kitty?.[3] === '3',
  };
}

export function isMiniSteerKey(key?: MiniInputKey): boolean {
  return (key?.name === 'return' || key?.name === 'enter') && !!(key.ctrl || key.super);
}

/** 先于所有快捷键监听器规范化，保证 CSI-u 下 Ctrl+C/Ctrl+T 等仍然工作。 */
export function installMiniKeyNormalizer(input: NodeJS.EventEmitter): () => void {
  let pending = '';
  let pendingAt = 0;
  const normalize = (text: string, key?: MiniInputKey) => {
    if (!key) return;
    let sequence = key.sequence ?? text ?? '';
    // Node 会拆开 modifyOtherKeys 和 CSI-u 的事件类型字段，先在此重组。
    if (pending && Date.now() - pendingAt < 200) sequence = pending + sequence;
    pending = '';
    const decoded = miniExtendedKey(sequence);
    if (!decoded && /^\x1b\[(?:27;\d+;\d*|\d+;\d+:[123]?)$/.test(sequence)) {
      pending = sequence;
      pendingAt = Date.now();
      Object.assign(key, { name: undefined, ctrl: false, meta: false, super: false, miniHandled: true, miniBuffered: true });
      return;
    }
    if (!decoded) return;
    if (decoded.release) Object.assign(key, { sequence, name: undefined, ctrl: false, meta: false, super: false, miniHandled: true, miniBuffered: true });
    else Object.assign(key, decoded, { miniBuffered: false });
  };
  Object.assign(normalize, { miniKeyNormalizer: true });
  input.prependListener('keypress', normalize);
  return () => input.off('keypress', normalize);
}

/** steer 按提交顺序消费，普通 queue 只在当前回合结束后消费。 */
export class MiniInputBuffer {
  private nextId = 1;
  private queued: MiniPendingInput[] = [];
  private interrupts: MiniPendingInput[] = [];

  pending(): readonly MiniPendingInput[] { return [...this.interrupts, ...this.queued]; }
  hasInterrupt(): boolean { return this.interrupts.length > 0; }
  enqueue(text: string, mode: MiniSubmitMode): MiniPendingInput {
    const item = { id: this.nextId++, text, mode };
    (mode === 'steer' ? this.interrupts : this.queued).push(item);
    return item;
  }
  takeInterrupt(): MiniPendingInput | undefined { return this.interrupts.shift(); }
  /** 自然结束/显式取消的边界未消费 steer，保留到下一轮最前面。 */
  deferInterrupts(): void {
    this.queued.unshift(...this.interrupts);
    this.interrupts = [];
  }
  shift(): MiniPendingInput | undefined { return this.queued.shift(); }
  editLastQueued(): string | null {
    for (let i = this.queued.length - 1; i >= 0; i--) {
      if (this.queued[i].mode === 'queue') return this.queued.splice(i, 1)[0]!.text;
    }
    return null;
  }
}

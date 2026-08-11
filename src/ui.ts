/**
 * 终端 UI 工具：ANSI 颜色、TTY 检测、spinner、运行时检测。
 *
 * 颜色规则：
 * - 管道/重定向输出（非 TTY）时自动禁用颜色，保证输出可被 grep/写入文件；
 * - 支持 NO_COLOR=1（强制关闭）与 FORCE_COLOR=1（强制开启）。
 */

/** 是否运行在 bun 运行时（OpenTUI 全屏 TUI 依赖 bun 的原生 FFI） */
export const isBun: boolean = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
export const isTTY: boolean =
  process.env.FORCE_COLOR === '1'
    ? true
    : process.env.NO_COLOR === '1'
      ? false
      : process.stdout.isTTY === true;

const wrap =
  (code: string) =>
  (s: string): string =>
    isTTY ? `\x1b[${code}m${s}\x1b[0m` : s;

export const bold = wrap('1');
export const dim = wrap('2');
export const cyan = wrap('36');
export const green = wrap('32');
export const yellow = wrap('33');
export const red = wrap('31');

/**
 * 终端窗口/标签页标题的 OSC 0 序列（`\x1b]0;标题\x07`，tab/窗口标题通用）。
 * 标题会清洗掉控制字符（防注入任意转义序列）；纯函数，便于单元断言。
 */
export function terminalTitleSequence(title: string): string {
  return `\x1b]0;${title.replace(/[\x00-\x1f\x7f]/g, '')}\x07`;
}

/** 设置终端窗口/标签页标题（仅 TTY 下发送——非 TTY 无窗口可设置，写了也是垃圾字节） */
export function setTerminalTitle(title: string): void {
  if (!isTTY) return;
  process.stdout.write(terminalTitleSequence(title));
}

export interface Spinner {
  /** 停止并清除 spinner 行，可附带一条结束消息 */
  stop(msg?: string): void;
  /** 动态修改 spinner 的提示文字 */
  setText(text: string): void;
}

/** 简单 spinner：仅 TTY 下显示，写入 stderr（不污染 stdout 的输出流） */
export function createSpinner(text: string): Spinner {
  if (!isTTY) {
    return {
      stop: () => {},
      setText: () => {},
    };
  }
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  let stopped = false;
  const render = () => process.stderr.write(`\r${cyan(frames[i++ % frames.length])} ${dim(text)}\x1b[K`);
  render();
  const id = setInterval(render, 80);
  return {
    setText: (t) => {
      text = t;
    },
    stop: (msg = '') => {
      if (stopped) return;
      stopped = true;
      clearInterval(id);
      process.stderr.write(`\r\x1b[K${msg}\n`);
    },
  };
}

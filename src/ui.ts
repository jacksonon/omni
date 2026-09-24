/**
 * 终端 UI 工具：ANSI 颜色、TTY 检测、spinner、运行时检测。
 *
 * 颜色规则：
 * - 管道/重定向输出（非 TTY）时自动禁用颜色，保证输出可被 grep/写入文件；
 * - 支持 NO_COLOR=1（强制关闭）与 FORCE_COLOR=1（强制开启）。
 */

/** 是否运行在 bun 运行时（OpenTUI 全屏 TUI 依赖 bun 的原生 FFI） */
export const isBun: boolean = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

/**
 * 是否接在真实终端上——决定"能不能交互/能不能做光标控制"（审批询问、ask_user、
 * spinner、实时输出、窗口标题），**与是否上色无关**。
 * ⚠️ 不要把 NO_COLOR/FORCE_COLOR 掺进来：`NO_COLOR=1` 的真实终端里，审批/信任询问
 * 会被静默跳过（fail-safe 拒绝一切），`FORCE_COLOR=1` 的管道里则会误当真终端去询问。
 */
export const isTTY: boolean = process.stdout.isTTY === true;

/**
 * 是否输出 ANSI 颜色：真实终端且未设 NO_COLOR；FORCE_COLOR=1 强制开启（优先级最高），
 * NO_COLOR=1 强制关闭。仅颜色决策用这个，交互决策用 isTTY。
 */
export function useColorFor(env: { FORCE_COLOR?: string; NO_COLOR?: string }, stdoutIsTTY: boolean): boolean {
  if (env.FORCE_COLOR === '1') return true; // 强制开启（优先级最高）
  if (env.NO_COLOR === '1') return false; // 强制关闭
  return stdoutIsTTY;
}

export const useColor: boolean = useColorFor(process.env, isTTY);

const wrap =
  (code: string) =>
  (s: string): string =>
    useColor ? `\x1b[${code}m${s}\x1b[0m` : s;

export const bold = wrap('1');
export const dim = wrap('2');
export const italic = wrap('3');
export const cyan = wrap('36');
export const magenta = wrap('35');
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

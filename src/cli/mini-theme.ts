/** mini 共用面板配色；未知背景使用终端默认色，避免亮色终端出现黑块。 */
import { useColor } from '../ui.js';

let dark: boolean | undefined;
const background = Number(process.env.COLORFGBG?.split(';').at(-1));
if (process.env.COLORFGBG) dark = background < 7 || background === 8;

export function miniPanelBackground(): string {
  if (!useColor) return '';
  if (dark === undefined) return '\x1b[49m';
  return dark ? '\x1b[48;2;27;27;27m' : '\x1b[48;2;240;240;240m';
}

export function miniSelection(): string {
  return useColor ? '\x1b[48;2;88;151;245m\x1b[30m' : '';
}

/** 在 readline 安装前查询背景，避免终端应答被当成用户输入。 */
export async function detectMiniTheme(): Promise<void> {
  const input = process.stdin;
  if (!input.isTTY || !process.stdout.isTTY || !useColor) return;
  const wasRaw = input.isRaw;
  const wasPaused = input.isPaused();
  await new Promise<void>(resolve => {
    let pending = '';
    const finish = () => {
      clearTimeout(timer);
      input.off('data', onData);
      input.pause();
      input.setRawMode(wasRaw);
      if (pending) input.unshift(Buffer.from(pending));
      if (!wasPaused) input.resume();
      resolve();
    };
    const onData = (chunk: Buffer) => {
      pending += chunk.toString();
      const match = /\x1b\]11;rgb:([\da-f]+)\/([\da-f]+)\/([\da-f]+)(?:\x07|\x1b\\)/i.exec(pending);
      if (!match) return;
      const rgb = match.slice(1, 4).map(s => parseInt(s!, 16) / (16 ** s!.length - 1));
      dark = rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722 < 0.5;
      pending = pending.replace(match[0], '');
      finish();
    };
    const timer = setTimeout(finish, 150);
    input.setRawMode(true);
    input.on('data', onData);
    input.resume();
    process.stdout.write('\x1b]11;?\x07');
  });
}

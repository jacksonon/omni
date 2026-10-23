/** mini 输入区装饰：原生 readline 负责编辑，显示层补灰底、占位与两行状态。 */
import { fuzzySlashMatch, MINI_SLASH_DESCRIPTIONS } from './picker.js';
import { formatTokenCount } from '../config/model-context.js';
import { dim, useColor } from '../ui.js';
import { visualWidth } from '../tui/width.js';
import { truncateToWidth } from '../output/format.js';

export interface MiniComposerStatus {
  model: string;
  effort?: string;
  contextLimit?: number;
  contextUsed?: number;
  estimated?: boolean;
  running: boolean;
  plan: boolean;
}

export function miniComposerStatus(status: MiniComposerStatus, width: number): string {
  const segments = [status.model + (status.effort ? ` ${status.effort}` : '')];
  if (status.contextLimit) segments.push(`${formatTokenCount(status.contextLimit)} window`);
  if (status.contextLimit && status.contextUsed !== undefined) {
    const left = Math.max(0, Math.min(100, Math.round((1 - status.contextUsed / status.contextLimit) * 100)));
    segments.push(`Context ${status.estimated ? '~' : ''}${left}% left`);
  }
  if (status.plan) segments.push('Plan');
  segments.push(status.running ? 'Working' : 'Ready');
  // 窄屏优先保留模型与运行状态，超长模型名按显示列裁剪。
  while (segments.length > 2 && visualWidth(`  ${segments.join(' · ')}`) > width - 1) segments.splice(1, 1);
  if (segments.length === 2) {
    const room = width - 1 - visualWidth(`   · ${segments[1]}`);
    segments[0] = truncateToWidth(segments[0]!, Math.max(0, room));
  }
  const plain = `  ${segments.join(' · ')}`;
  const text = visualWidth(plain) <= width - 1 ? plain : truncateToWidth(plain, Math.max(1, width - 1));
  if (!useColor) return text;
  const colored = status.running && text.endsWith('Working')
    ? text.slice(0, -7) + '\x1b[38;2;181;145;229mWorking'
    : text;
  return `\x1b[38;2;215;180;124m${colored}\x1b[0m`;
}

/** Node promises readline 用 Symbol 方法，旧运行时用字符串别名。 */
function methodKey(rl: object, name: string): string | symbol | undefined {
  for (let proto: object | null = rl; proto; proto = Object.getPrototypeOf(proto)) {
    const key = Object.getOwnPropertySymbols(proto).find(symbol => symbol.description === name);
    if (key) return key;
  }
  return name in rl ? name : undefined;
}

export interface MiniComposer {
  clearInput(): void;
  dispose(): void;
}

export function installMiniComposer(input: object, getStatus: () => MiniComposerStatus): MiniComposer | null {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  // readline 的内部绘制方法仅用于包裹渲染，不修改 line/cursor 的编辑语义。
  const rl = input as Record<string | symbol, any>;
  const refreshKey = methodKey(rl, '_refreshLine');
  const ttyKey = methodKey(rl, '_ttyWrite');
  const writeKey = methodKey(rl, '_writeToOutput');
  if (!refreshKey || !ttyKey || !writeKey) return null;
  const refresh = rl[refreshKey], ttyWrite = rl[ttyKey], write = rl[writeKey];
  const out = process.stdout;
  const bg = () => useColor ? '\x1b[48;2;27;27;27m' : '';
  let drawing = false;
  let visible = false;
  let disposed = false;
  let generation = 0;
  let menuHeight = 0;
  let selected = 0;
  let lastQuery = '';
  let dismissedFor: string | null = null;
  const suggestions = (): string[] => {
    const line = rl.line as string;
    if (dismissedFor !== null && line !== dismissedFor) dismissedFor = null;
    if (getStatus().running || !/^\/[a-z-]*$/.test(line) || line === dismissedFor) return [];
    if (line !== lastQuery) { selected = 0; lastQuery = line; }
    const commands = fuzzySlashMatch(line.slice(1));
    // 裸 / 优先显示常用入口，其余命令仍可通过方向键与过滤找到。
    if (line === '/') {
      const first = ['/model', '/variants', '/permission', '/status', '/context', '/plan', '/review', '/mcp'];
      return [...first.filter(c => commands.includes(c)), ...commands.filter(c => !first.includes(c))];
    }
    return commands;
  };
  const positions = () => {
    const cursor = rl.cursor;
    const pos = rl.getCursorPos();
    try { rl.cursor = rl.line.length; return { pos, end: rl.getCursorPos() }; }
    finally { rl.cursor = cursor; }
  };
  const move = (rows: number) => rows ? `\x1b[${Math.abs(rows)}${rows > 0 ? 'B' : 'A'}` : '';
  const restoreColumn = (cols: number) => `\r${cols ? `\x1b[${cols}C` : ''}`;
  const hideFooter = () => {
    if (!visible) return;
    const { pos, end } = positions();
    const down = end.rows - pos.rows + 1;
    out.write(`\x1b[0m${move(down)}\r\x1b[0J${move(-down)}${restoreColumn(pos.cols)}`);
    visible = false;
  };
  rl[writeKey] = function(text: string) {
    return write.call(this, drawing ? text.replace(/\x1b\[0m/g, `\x1b[0m${bg()}`) : text);
  };
  rl[refreshKey] = function() {
    if (disposed) return refresh.call(this);
    const commands = suggestions();
    selected = Math.min(selected, Math.max(0, commands.length - 1));
    const height = Math.max(0, Math.min(8, (out.rows || 24) - rl.getCursorPos().rows - 5, commands.length));
    // 面板与输入共用一块受控区域；行数变更先清旧块，再顺序重画，不覆盖聊天记录。
    if (menuHeight || height) {
      out.write(`\x1b[0m${move(-((rl.prevRows || 0) + menuHeight))}\r\x1b[0J`);
      rl.prevRows = 0;
      const width = out.columns || 80;
      const start = Math.max(0, Math.min(selected - Math.floor(height / 2), commands.length - height));
      const nameWidth = Math.min(18, Math.max(8, Math.floor(width / 3)));
      for (let i = start; i < start + height; i++) {
        const command = commands[i]!;
        const label = width >= 36 ? truncateToWidth(command, nameWidth).padEnd(nameWidth) + '  ' + (MINI_SLASH_DESCRIPTIONS[command] ?? '') : command;
        const row = truncateToWidth(`${i === selected ? '› ' : '  '}${label}`, Math.max(1, width - 1));
        const color = i === selected && useColor ? '\x1b[48;2;88;151;245m\x1b[30m' : '';
        out.write(`${color}${row}\x1b[K\x1b[0m\n\r`);
      }
      menuHeight = height;
    }
    drawing = true;
    out.write(bg());
    try { refresh.call(this); } finally { drawing = false; }
    const { pos, end } = positions();
    const width = out.columns || 80;
    const tailRows = end.rows - pos.rows;
    out.write(`${move(tailRows)}${restoreColumn(end.cols)}${bg()}\x1b[K`);
    if (!rl.line) out.write(dim(truncateToWidth('Ask Omni to do anything', Math.max(0, width - end.cols - 1))));
    // 用换行分配页底空间，再按相对行归位；终端滚屏后仍停在原输入字符上。
    out.write(`${bg()}\n\r\x1b[K\x1b[0m\n\r\x1b[0J`);
    out.write(miniComposerStatus(getStatus(), width));
    out.write(`\n\r${dim(truncateToWidth(menuHeight ? '  ↑↓ 选择 · tab 填入 · enter 执行 · esc 关闭' : '  @ 文件 · / 命令 · ? 快捷键 · ctrl+t 轨迹', Math.max(1, width - 1)))}`);
    out.write(`${move(-(end.rows - pos.rows + 3))}${restoreColumn(pos.cols)}\x1b[0m`);
    visible = true;
    generation++;
  };
  rl[ttyKey] = function(text: string, key?: { name?: string; ctrl?: boolean }) {
    const commands = suggestions();
    if (commands.length && !key?.ctrl) {
      if (key?.name === 'up' || key?.name === 'down') {
        selected = (selected + (key.name === 'up' ? -1 : 1) + commands.length) % commands.length;
        rl[refreshKey]();
        return;
      }
      if (key?.name === 'escape') {
        dismissedFor = rl.line;
        rl[refreshKey]();
        return;
      }
      if (key?.name === 'tab' || key?.name === 'return' || key?.name === 'enter') {
        rl.line = commands[selected] + (key.name === 'tab' ? ' ' : '');
        rl.cursor = rl.line.length;
        dismissedFor = rl.line;
        rl[refreshKey]();
        if (key.name === 'tab') return;
      }
    }
    const submit = key?.name === 'return' || key?.name === 'enter';
    const leave = submit || (key?.ctrl && ['c', 'd', 'z'].includes(key.name ?? ''));
    if (leave) {
      if (menuHeight) { dismissedFor = rl.line; rl[refreshKey](); }
      hideFooter();
    }
    const before = generation;
    const result = ttyWrite.call(this, text, key);
    // readline 对行末插字/左右移动会走快速路径，必须同步清占位和重画灰底。
    if (!leave && !rl.closed && generation === before) rl[refreshKey]();
    return result;
  };
  const onLine = () => { visible = false; out.write('\x1b[0m'); };
  rl.on('line', onLine);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    rl[refreshKey] = refresh; rl[ttyKey] = ttyWrite; rl[writeKey] = write;
    rl.off('line', onLine);
    out.write('\x1b[0m');
  };
  rl.once('close', dispose);
  return {
    clearInput() {
      if (!visible) { out.write('\r\x1b[2K'); return; }
      const { pos } = positions();
      out.write(`\x1b[0m${move(-(pos.rows + menuHeight))}\r\x1b[0J`);
      menuHeight = 0;
      rl.prevRows = 0;
      visible = false;
    },
    dispose,
  };
}

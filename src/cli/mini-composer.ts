import { isMiniSteerKey, miniExtendedKey, type MiniInputActions, type MiniInputKey, type MiniPendingInput } from './mini-input.js';
import { dockMiniViewport, restoreMiniViewport } from './mini-viewport.js';
import { miniPanelBackground, miniSelection } from './mini-theme.js';
/** mini 输入区装饰：原生 readline 负责编辑，显示层补灰底、占位与两行状态。 */
import { fuzzySlashMatch, matchMention, MINI_SLASH_DESCRIPTIONS } from './picker.js';
import { formatTokenCount } from '../config/model-context.js';
import { bold, dim, useColor } from '../ui.js';
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

/** 跟进消息属于输入区上方的临时对话流；消费后由正式用户消息接替。 */
export function miniPendingRows(items: readonly MiniPendingInput[], width: number, limit: number): string[] {
  if (items.length === 0 || limit < 2) return [];
  const rows: string[] = [];
  const steering = items.filter(item => item.mode === 'steer');
  const queued = items.filter(item => item.mode === 'queue');
  if (steering.length) {
    rows.push(bold('• Steering current turn'));
    for (const item of steering) rows.push(dim(`  ↳ ${item.text.replace(/\s+/g, ' ')}`));
  }
  if (queued.length) {
    rows.push(bold('• Queued follow-up inputs'));
    for (const item of queued) rows.push(dim(`  ↳ ${item.text.replace(/\s+/g, ' ')}`));
    rows.push(dim('  ↑ edit last queued message'));
  }
  const visible = rows.length > limit
    ? [rows[0]!, dim(`  … ${items.length} pending messages`), ...(limit > 2 ? rows.slice(-(limit - 2)) : [])]
    : rows;
  return visible.map(row => truncateToWidth(row, Math.max(1, width - 1)));
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
  suspend(): void;
  resume(): void;
  /** 提交后清除完整编辑块（含上下留白），供消息流重新排版。 */
  clearSubmitted(): boolean;
  dispose(): void;
}

export function installMiniComposer(input: object, getStatus: () => MiniComposerStatus, getActions: () => MiniInputActions | undefined = () => undefined): MiniComposer | null {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  // readline 的内部绘制方法仅用于包裹渲染，不修改 line/cursor 的编辑语义。
  const rl = input as Record<string | symbol, any>;
  const refreshKey = methodKey(rl, '_refreshLine');
  const ttyKey = methodKey(rl, '_ttyWrite');
  const writeKey = methodKey(rl, '_writeToOutput');
  if (!refreshKey || !ttyKey || !writeKey) return null;
  const refresh = rl[refreshKey], ttyWrite = rl[ttyKey], write = rl[writeKey];
  const out = process.stdout;
  const bg = miniPanelBackground;
  let padded = false;
  let submittedRows = 0;
  let submittedCleared = false;
  let anchorNext = false;
  let contentAnchor = false;
  let anchoredHeight = 0;
  let drawing = false;
  let visible = false;
  let disposed = false;
  let suspended = false;
  let generation = 0;
  let renderedWidth = out.columns || 80;
  let renderedHeight = out.rows || 24;
  let menuHeight = 0;
  let pendingHeight = 0;
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
  const restoreContent = (): boolean => {
    if (!contentAnchor) return false;
    restoreMiniViewport(out);
    contentAnchor = false;
    padded = false;
    menuHeight = 0;
    pendingHeight = 0;
    rl.prevRows = 0;
    visible = false;
    return true;
  };
  const hideFooter = () => {
    if (!visible) return;
    const { pos, end } = positions();
    if (padded) out.write(`${move(-(pos.rows + 1))}\r\x1b[0m\x1b[2K${move(pos.rows + 1)}${restoreColumn(pos.cols)}`);
    const down = end.rows - pos.rows + 1;
    out.write(`\x1b[0m${move(down)}\r\x1b[0J${move(-down)}${restoreColumn(pos.cols)}`);
    visible = false;
  };
  rl[writeKey] = function(text: string) {
    return write.call(this, drawing ? bg() + text.replace(/\x1b\[0m/g, `\x1b[0m${bg()}`) : text);
  };
  rl[refreshKey] = function() {
    if (disposed) return refresh.call(this);
    if (suspended) return;
    // 无论启动、流式输出还是命令结束，新显示的输入区都走同一个页底布局。
    if (!visible) anchorNext = true;
    const width = out.columns || 80;
    const resized = width !== renderedWidth || (out.rows || 24) !== renderedHeight;
    if (resized) {
      renderedWidth = width;
      renderedHeight = out.rows || 24;
      // 终端已按新宽度重排，readline 的旧 prevRows 不能继续用来回退。
      rl.prevRows = rl.getCursorPos().rows;
    }
    const commands = suggestions();
    const endRows = positions().end.rows;
    const height = Math.max(0, Math.min(8, (out.rows || 24) - endRows - 8, commands.length));
    const pendingRows = miniPendingRows(getActions()?.pending() ?? [], width, Math.max(0, (out.rows || 24) - endRows - 8 - (height ? height + 2 : 0)));
    const inputHeight = endRows + 5 + (height ? height + 2 : 0) + pendingRows.length;
    if (contentAnchor && (resized || inputHeight !== anchoredHeight)) anchorNext = true;
    const anchorFrame = anchorNext && out.writableCorked === 0;
    if (anchorNext) {
      anchorNext = false;
      if (anchorFrame) {
        out.cork();
        out.write('\x1b[?2026h');
      }
      if (!restoreContent() && visible) {
        const { pos } = positions();
        out.write(`${move(-(pos.rows + menuHeight + pendingHeight + (padded ? 1 : 0)))}\r\x1b[0m\x1b[0J`);
      }
      anchoredHeight = inputHeight;
      dockMiniViewport(out, inputHeight);
      contentAnchor = true;
      menuHeight = 0;
      pendingHeight = 0;
      padded = false;
      visible = false;
      rl.prevRows = 0;
    }
    selected = Math.min(selected, Math.max(0, commands.length - 1));
    // 面板与输入共用一块受控区域；行数变更先清旧块，再顺序重画，不覆盖聊天记录。
    const rebuild = menuHeight > 0 || height > 0 || pendingHeight > 0 || pendingRows.length > 0;
    if (rebuild) {
      out.write(`\x1b[0m${move(-((rl.prevRows || 0) + menuHeight + pendingHeight + (padded ? 1 : 0)))}\r\x1b[0J`);
      rl.prevRows = 0;
      const width = out.columns || 80;
      const start = Math.max(0, Math.min(selected - Math.floor(height / 2), commands.length - height));
      const nameWidth = Math.min(18, Math.max(8, Math.floor(width / 3)));
      if (height) out.write(`${bg()}${bold(truncateToWidth('  命令', Math.max(1, width - 1)))}${bg()}\x1b[K\x1b[0m\n\r${bg()}\x1b[K\x1b[0m\n\r`);
      for (let i = start; i < start + height; i++) {
        const command = commands[i]!;
        const label = width >= 36 ? truncateToWidth(command, nameWidth).padEnd(nameWidth) + '  ' + (MINI_SLASH_DESCRIPTIONS[command] ?? '') : command;
        const row = truncateToWidth(`${i === selected ? '› ' : '  '}${label}`, Math.max(1, width - 1));
        const color = i === selected ? miniSelection() : bg();
        out.write(`${color}${row}\x1b[K\x1b[0m\n\r`);
      }
      menuHeight = height ? height + 2 : 0;
      for (const row of pendingRows) out.write(`\x1b[0m${row}\x1b[K\n\r`);
      pendingHeight = pendingRows.length;
    }
    if (!padded || rebuild) {
      out.write(`${bg()}\x1b[K\n\r\x1b[0m`);
      padded = true;
    } else {
      // 重画顶部留白，不改变 readline 的行内位置。
      const pos = rl.getCursorPos();
      out.write(`${move(-(pos.rows + 1))}\r${bg()}\x1b[K\x1b[0m${move(pos.rows + 1)}${restoreColumn(pos.cols)}`);
    }
    drawing = true;
    // readline 自己的 ED 清屏必须使用终端底色；只在真正写文本时附加灰底。
    out.write('\x1b[0m');
    try { refresh.call(this); } finally { drawing = false; }
    const { pos, end } = positions();
    const tailRows = end.rows - pos.rows;
    out.write(`${move(tailRows)}${restoreColumn(end.cols)}${bg()}\x1b[K`);
    if (!rl.line) out.write(dim(truncateToWidth('Ask Omni to do anything', Math.max(0, width - end.cols - 1))));
    // 用换行分配页底空间，再按相对行归位；终端滚屏后仍停在原输入字符上。
    out.write(`${bg()}\n\r\x1b[K\x1b[0m\n\r\x1b[0J`);
    out.write(miniComposerStatus(getStatus(), width));
    out.write(`\n\r${dim(truncateToWidth(menuHeight ? '  ↑↓ 选择 · tab 填入 · enter 执行 · esc 关闭' : getStatus().running ? '  tab queue · cmd/ctrl+enter steer · ↑ 编辑最后一条 queue' : '  @ 文件 · / 命令 · ? 快捷键 · ctrl+t 轨迹', Math.max(1, width - 1)))}`);
    out.write(`${move(-(end.rows - pos.rows + 3))}${restoreColumn(pos.cols)}\x1b[0m`);
    visible = true;
    generation++;
    if (anchorFrame) {
      out.write('\x1b[?2026l');
      out.uncork();
    }
  };
  const clearInput = () => {
    if (restoreContent()) return;
    if (!visible) { out.write('\r\x1b[2K'); return; }
    const { pos } = positions();
    out.write(`\x1b[0m${move(-(pos.rows + menuHeight + pendingHeight + (padded ? 1 : 0)))}\r\x1b[0J`);
    menuHeight = 0;
    pendingHeight = 0;
    padded = false;
    rl.prevRows = 0;
    visible = false;
  };
  rl[ttyKey] = function(text: string, key?: MiniInputKey) {
    if (key?.miniBuffered) return;
    const decoded = miniExtendedKey(key?.sequence ?? text ?? '');
    if (decoded?.release) {
      if (key) Object.assign(key, { name: undefined, ctrl: false, meta: false, super: false, miniHandled: true });
      return;
    }
    if (decoded) {
      key ??= {};
      Object.assign(key, decoded);
      text = decoded.super && decoded.name !== 'return' ? '' : decoded.text;
    }
    const actions = suspended ? undefined : getActions();
    const enter = key?.name === 'return' || key?.name === 'enter';
    const line = rl.line as string;
    const resetDraft = () => {
      clearInput();
      rl.line = ''; rl.cursor = 0; rl.prevRows = 0;
    };
    if (actions && enter && (key?.shift || key?.meta) && !isMiniSteerKey(key)) {
      if (key) key.miniHandled = true;
      resetDraft();
      actions.continueLine(line);
      rl[refreshKey]();
      return;
    }
    if (actions && key?.name === 'up' && !line && !key.ctrl && !key.meta && !key.super) {
      const previous = actions.editLastQueued();
      if (previous !== null) {
        resetDraft();
        rl.line = previous; rl.cursor = previous.length;
        rl[refreshKey]();
        return;
      }
    }
    const tabMessage = actions && key?.name === 'tab' && !key.ctrl && !key.shift && !key.meta && !key.super && !!line.trim() &&
      !line.trimStart().startsWith('/') && !matchMention(line, process.cwd(), rl.cursor);
    const steer = actions && isMiniSteerKey(key);
    if (actions && actions.busy() &&
        (steer || tabMessage || (enter && !line.trimStart().startsWith('/')))) {
      if (key) key.miniHandled = true;
      resetDraft();
      actions.submit(line, steer ? 'steer' : 'queue');
      rl[refreshKey]();
      return;
    }
    if (tabMessage || steer) {
      key ??= {};
      key.name = 'return'; key.ctrl = false; key.super = false;
      text = '\r';
    }
    const commands = suggestions();
    if (commands.length && !key?.ctrl && !key?.super) {
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
      if (submit) submittedCleared = false;
      if (menuHeight) { dismissedFor = rl.line; rl[refreshKey](); }
      if (submit && visible) {
        const { end } = positions();
        submittedRows = end.rows + 1 + (padded ? 1 : 0);
      }
      hideFooter();
    }
    const before = generation;
    const result = ttyWrite.call(this, text, key);
    // readline 对行末插字/左右移动会走快速路径，必须同步清占位和重画灰底。
    if (!leave && !rl.closed && generation === before) rl[refreshKey]();
    return result;
  };
  const onLine = () => {
    if (restoreContent()) {
      submittedRows = 0;
      submittedCleared = true;
    }
    padded = false;
    visible = false;
    out.write('\x1b[0m');
  };
  rl.on('line', onLine);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    restoreContent();
    rl[refreshKey] = refresh; rl[ttyKey] = ttyWrite; rl[writeKey] = write;
    rl.off('line', onLine);
    out.write('\x1b[0m');
  };
  // readline 已订阅 resize 并调用被装饰的 refresh；不再二次绘制。
  rl.once('close', dispose);
  return {
    suspend() { suspended = true; },
    resume() { suspended = false; },
    clearSubmitted() {
      if (submittedCleared) {
        submittedCleared = false;
        restoreContent(); // 排队消息之间可能已经重画过新的页底输入。
        return true;
      }
      if (!submittedRows) return false;
      out.write(`\x1b[0m${move(-submittedRows)}\r\x1b[0J`);
      submittedRows = 0;
      padded = false;
      rl.prevRows = 0;
      return true;
    },
    clearInput,
    dispose,
  };
}

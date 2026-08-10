/**
 * TUI 渲染层（命令式，不依赖 solid 响应式）。
 *
 * 背景：OpenTUI 的 solid 集成在此环境存在 JSX 转换时序问题（入口文件在
 * preload 注册插件前就被转换），信号变更无法触发重绘。因此这里直接用
 * @opentui/core 的 renderable 构建渲染树，状态变更后显式调用 loop() 重绘。
 *
 * 布局（交互模式，纵向 flex）：
 *   ┌─ Omni v0.1.0 · grok-4.5 ──────────────┐  ← 根 Box 边框 + 标题
 *   │  ❯ 你是谁？                           │  ← 内容行（尾部窗口，自动跟随最新）
 *   │  💭 思考…                             │
 *   │  → [1/20] list_directory(…)           │
 *   │  ✓ 返回 55 字符                       │
 *   │  ...（内容不足时此处留空）            │
 *   │  等待输入…                            │  ← 状态栏（输入框上方）
 *   │  ┌─ 输入 ─────────────────────────┐   │  ← 输入框（marginTop:auto 钉在底部）
 *   │  │ 输入消息，Enter 发送…           │   │
 *   │  └────────────────────────────────┘   │
 *   └───────────────────────────────────────┘
 *
 * 输入框通过 marginTop:auto 吸收剩余空间，始终固定在视口最底部；
 * 状态栏在输入框正上方。单次任务模式（无输入框）时状态栏固定在末行。
 */
import { BoxRenderable, InputRenderable, StyledText, TextAttributes, TextRenderable, createCliRenderer, createTextAttributes, parseColor } from '@opentui/core';
import type { RenderContext } from '@opentui/core';
import { logCrash } from './crashlog.js';
import { markdownToRows, type MdChunk } from './markdown.js';
import type { TuiLineKind, TuiState } from './state.js';

export interface TuiSession {
  /** 立即重绘一帧（状态变更后调用） */
  paint(): Promise<void>;
  /** 退出全屏（恢复终端） */
  stop(): Promise<void>;
  /** 交互模式的输入框（单次任务模式为 null） */
  input: InputRenderable | null;
  /**
   * 订阅每次按键（返回取消订阅函数）。
   * 全局监听先于输入框（renderable）执行，回调可调用 preventDefault() 阻止输入框处理该键。
   */
  onKeyPress(cb: (key: TuiKey) => void): () => void;
}

/** 按键事件（KeyEvent 的结构化子集，含阻止派发能力） */
export interface TuiKey {
  name: string;
  sequence: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  super?: boolean;
  /** 阻止后续 renderable（输入框）处理该按键 */
  preventDefault(): void;
  stopPropagation(): void;
}

/** 行样式（对应 createTextAttributes 的字段） */
export interface RowStyle {
  dim?: boolean;
  bold?: boolean;
  fg?: string;
}

/** 每种内容行的展示样式：思考浅色、步骤青色、成功绿、失败红、警告黄、用户蓝加粗、任务青加粗 */
export function rowStyle(kind: TuiLineKind): RowStyle {
  switch (kind) {
    case 'thinking':
      return { dim: true };
    case 'step':
      return { fg: 'cyan' };
    case 'result-ok':
      return { fg: 'green' };
    case 'result-err':
      return { fg: 'red' };
    case 'warn':
      return { fg: 'yellow' };
    case 'user':
      return { fg: 'blue', bold: true };
    case 'task':
      return { fg: 'cyan', bold: true };
    case 'meta':
      return { dim: true };
    default:
      return {};
  }
}

export interface Row {
  text: string;
  style: RowStyle;
  /** 行内样式片段（answer 行走 Markdown 渲染时存在；否则用整行 style） */
  chunks?: MdChunk[];
}

/** 内容区可用宽度 = 视口宽 - 根边框(2) - paddingX(2) */
const CONTENT_PAD = 4;

/** 单个字符的终端显示列数（CJK/全角 2 列，其余 1 列） */
function charWidth(ch: string): number {
  const c = ch.codePointAt(0) ?? 0;
  if (
    (c >= 0x2e80 && c <= 0x9fff) || // 部首..CJK 统一表意
    (c >= 0xac00 && c <= 0xd7a3) || // 谚文音节
    (c >= 0xf900 && c <= 0xfaff) || // CJK 兼容表意
    (c >= 0xfe30 && c <= 0xfe4f) || // CJK 兼容形式
    (c >= 0xff00 && c <= 0xff60) || // 全角形式
    (c >= 0xffe0 && c <= 0xffe6)
  ) {
    return 2;
  }
  return 1;
}

/** 字符串的终端显示宽度（列数） */
function visualWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += charWidth(ch);
  return w;
}

/**
 * 计算 text 在 budget 列内最多能容纳的字符数（UTF-16 码元）。
 * 断点不会落在代理对中间（emoji 等 astral 字符整对保留或整对舍弃）。
 */
function fitCount(text: string, budget: number): number {
  if (budget <= 0) return 0;
  let cols = 0;
  let i = 0;
  for (; i < text.length; i++) {
    const w = charWidth(text[i]);
    if (cols + w > budget) break;
    cols += w;
  }
  // 断点落在代理对后半（emoji 等 astral 字符）时回退到前半之前，避免切出半个乱码
  while (i > 0 && i < text.length) {
    const code = text.charCodeAt(i);
    if (code >= 0xdc00 && code <= 0xdfff) i--;
    else break;
  }
  return i;
}

/** 可断行标点：断在这些字符之后（标点留在行尾）。中文为主——CJK 散文无空格，
 * 标点是天然断点；英文逗号句号也可断（长 URL 通常含 '.' 可借此断行）。 */
const BREAK_AFTER = '，。、；：！？）》」』】…·,.;:!?)]}';

/** prefix 内最后一个可断行标点的位置（无则 -1） */
function lastBreakPunctIndex(prefix: string): number {
  let pi = -1;
  for (const ch of BREAK_AFTER) {
    const idx = prefix.lastIndexOf(ch);
    if (idx > pi) pi = idx;
  }
  return pi;
}

/**
 * 把一行（样式片段）按显示列数折成多行（自动换行，替代原来的截断）。
 *
 * 规则：CJK 全角算 2 列；优先在空格处断行（词边界，空格丢弃），其次在标点后断行
 * （标点留行尾，中文散文友好），否则按列硬断；不切断代理对。折行后每行恰好占
 * 1 个终端行，因此行数预算（computeRows 的 cap）精确成立，状态栏/输入框不会被
 * 挤出视口——这正是原来交给 TextBuffer word 换行会撑破预算、只能退而截断的问题。
 */
function wrapChunks(chunks: MdChunk[], width: number): MdChunk[][] {
  if (width < 2) return [chunks]; // 极端窄视口：放弃折行，交给终端处理
  if (chunks.length === 0) return [chunks]; // 空行（保留占位）
  const rows: MdChunk[][] = [];
  let cur: MdChunk[] = [];
  let used = 0;
  const flush = (): void => {
    if (cur.length) {
      rows.push(cur.filter((c) => c.text.length > 0));
      cur = [];
    }
    used = 0;
  };
  for (const c of chunks) {
    let text = c.text;
    while (text.length > 0) {
      const remain = width - used;
      if (remain >= visualWidth(text)) {
        cur.push({ ...c, text });
        used += visualWidth(text); // 整段可放下：累积列数（后续 chunk 继续接在同一行）
        break;
      }
      const fit = fitCount(text, remain);
      if (fit <= 0) {
        // 行首放不下（如只剩 1 列又遇到全角字符）→ 换到下一行重试
        flush();
        continue;
      }
      const prefix = text.slice(0, fit);
      const sp = prefix.lastIndexOf(' ');
      const pi = lastBreakPunctIndex(prefix);
      // 断点优先级：空格（断在空格处）> 最近标点之后（标点留行尾）> 硬断
      let cut: number;
      if (sp > 0 && sp >= pi) cut = sp;
      else if (pi > 0) cut = pi + 1;
      else cut = fit;
      cur.push({ ...c, text: text.slice(0, cut) });
      text = text.slice(cut);
      if (sp > 0 && sp >= pi) text = text.slice(1); // 空格断行：空格随断点丢弃
      else if (text.startsWith(' ')) text = text.slice(1); // 标点/硬断后：跳过续行前导空格
      flush();
    }
  }
  flush();
  return rows.length ? rows : [[]];
}

/** 把一行按内容宽度折成多行（chunks 行保留行内样式，普通行整行套样式） */
function wrapRow(row: Row, width: number): Row[] {
  if (!row.chunks) {
    return wrapChunks([{ text: row.text }], width).map((chunks) => ({
      text: chunks.map((c) => c.text).join(''),
      style: row.style,
    }));
  }
  return wrapChunks(row.chunks, width).map((chunks) => ({
    text: chunks.map((c) => c.text).join(''),
    style: row.style,
    chunks,
  }));
}

/** 状态 → 全部内容行（未裁剪窗口），每行已按内容宽度折行（不截断） */
function buildBody(state: TuiState, width: number): Row[] {
  const body: Row[] = [];
  for (const line of state.lines) {
    if (line.kind === 'answer') {
      // 最终回答走行式 Markdown 渲染（加粗/行内代码/代码块/标题/引用等）
      for (const md of markdownToRows(line.text)) {
        body.push(
          ...wrapRow(
            { text: md.chunks.map((c) => c.text).join(''), style: rowStyle(line.kind), chunks: md.chunks },
            width
          )
        );
      }
      continue;
    }
    for (const seg of line.text.split('\n')) {
      body.push(...wrapRow({ text: seg, style: rowStyle(line.kind) }, width));
    }
  }
  return body;
}

/**
 * 状态 → 可见内容行（尾部窗口 + 滚动）。状态栏是独立的 renderable，不在这里。
 *
 * 行数预算：根 Box 边框(2) + paddingY(2) = 4 行固定；
 * 交互模式再占 输入框(3) + 状态栏(1) = 4 行，内容区 = 高度 - 8；
 * 单次任务模式内容区 = 高度 - 5。
 *
 * 滚动：scrollTop = null 跟随最新；上滚时显示「内容窗 + 底部提示行」。
 * scrollIntent（按键发出的一次性指令）在此消费，滚动数学集中在这一处。
 */
export function computeRows(
  state: TuiState,
  size: { height: number; width: number },
  opts?: { withInput?: boolean }
): Row[] {
  const { height, width } = size;
  const body = buildBody(state, Math.max(1, (width ?? 80) - CONTENT_PAD));
  // 极小高度时不强塞内容行（避免把输入框挤出视口）
  const cap = Math.max(0, (height ?? 24) - 4 - (opts?.withInput ? 4 : 1));
  const total = body.length;

  // 消费滚动意图（按键 → 一次性指令 → 这里换算成 scrollTop）
  if (state.scrollIntent) {
    const { action } = state.scrollIntent;
    state.scrollIntent = null;
    if (total > cap && cap >= 2) {
      const contentCap = cap - 1; // 上滚模式预留 1 行给提示条
      const maxTop = Math.max(0, total - contentCap);
      const cur = state.scrollTop ?? maxTop;
      const page = Math.max(1, contentCap);
      switch (action) {
        case 'line-up':
          state.scrollTop = Math.max(0, cur - 1);
          break;
        case 'line-down':
          state.scrollTop = cur + 1 >= maxTop ? null : cur + 1;
          break;
        case 'page-up':
          state.scrollTop = Math.max(0, cur - page);
          break;
        case 'page-down':
          state.scrollTop = cur + page >= maxTop ? null : cur + page;
          break;
        case 'top':
          state.scrollTop = 0;
          break;
        case 'bottom':
          state.scrollTop = null;
          break;
      }
    }
  }

  if (total <= cap) {
    state.scrollTop = null;
    return body;
  }
  if (state.scrollTop == null) return body.slice(total - cap);

  // 上滚模式：内容窗 cap-1 行 + 底部滚动提示行
  const contentCap = Math.max(1, cap - 1);
  const top = Math.min(state.scrollTop, Math.max(0, total - contentCap));
  state.scrollTop = top;
  if (top + contentCap >= total) {
    // 已滚到内容最底（内容收缩等边界情况）→ 回到跟随模式
    state.scrollTop = null;
    return body.slice(total - cap);
  }
  const visible = body.slice(top, top + contentCap);
  visible.push({
    text: `↑ 已上滚 ${total - top - contentCap} 行 · 共 ${total} 行 · End 回到最新`,
    style: { dim: true },
  });
  return visible;
}

/** 渲染树：根 Box + 内容文本节点 + 输入框（可选）+ 状态栏 */
export interface TuiTree {
  root: BoxRenderable;
  cells: TextRenderable[];
  status: TextRenderable;
  inputBox: BoxRenderable | null;
  input: InputRenderable | null;
}

/** 建树（首帧）：根边框 + 输入框 + 状态栏挂到 root 下，内容行由 repaintTree 维护 */
export function mountTree(ctx: RenderContext, state: TuiState, opts?: { withInput?: boolean }): TuiTree {
  const root = new BoxRenderable(ctx, {
    flexGrow: 1, // 撑满视口高度，让输入框的 marginTop:auto 能把剩余空间吸收到内容区下方
    flexDirection: 'column',
    paddingX: 1,
    paddingY: 1,
    border: true,
    borderStyle: 'single',
    borderColor: 'cyan',
    title: '',
    titleColor: 'cyan',
    titleAlignment: 'left',
  });
  (ctx as unknown as { root: BoxRenderable }).root.add(root);

  let inputBox: BoxRenderable | null = null;
  let input: InputRenderable | null = null;
  if (opts?.withInput) {
    inputBox = new BoxRenderable(ctx, {
      flexDirection: 'column',
      paddingX: 0,
      paddingY: 0,
      border: true,
      borderStyle: 'single',
      borderColor: '#6b7280',
      title: '输入',
      titleColor: '#6b7280',
      titleAlignment: 'left',
      // auto 上边距吸收内容区剩余空间：无论内容多少，输入框都钉在视口最底部
      marginTop: 'auto',
    });
    // InputRenderable 自带 Enter → submit 绑定（return/kpenter/linefeed），
    // Enter 时 emit 'enter' 事件（注意：它重写了 submit()，不走父类的 onSubmit 回调）
    input = new InputRenderable(ctx, {
      placeholder: '输入消息，Enter 发送；/exit 退出，/help 查看帮助',
      maxLength: 4000,
      textColor: '#e2e8f0',
      placeholderColor: '#6b7280',
    });
    inputBox.add(input);
  }

  // 子节点顺序：内容行（动态）→ 状态栏 → 输入框（最底部）
  const status = new TextRenderable(ctx, {
    content: '',
    attributes: createTextAttributes({ dim: true }),
    wrapMode: 'none',
  });
  root.add(status);
  if (inputBox) root.add(inputBox);

  const tree: TuiTree = { root, cells: [], status, inputBox, input };
  repaintTree(ctx, tree, state, opts);
  return tree;
}

/** 重绘：更新标题/状态栏，按当前状态重建所有内容行，并画一帧 */
export function repaintTree(ctx: RenderContext, tree: TuiTree, state: TuiState, opts?: { withInput?: boolean }): void {
  tree.root.title = `Omni v${state.version} · ${state.model}`;
  const height = (ctx as { height?: number }).height ?? 24;
  const width = (ctx as { width?: number }).width ?? 80;
  // 视口过小时隐藏状态栏，优先保证输入框完整可见
  //（交互模式需 8 行：输入框 3 + 状态栏 1 + 边框/内边距 4；单任务模式仅需 5 行）
  tree.status.visible = opts?.withInput ? height >= 8 : height >= 5;
  tree.status.content = state.status;

  for (const c of tree.cells) tree.root.remove(c);
  tree.cells = [];

  const anchor = tree.status; // 内容行始终插在状态栏之前（状态栏与输入框固定在底部）
  for (const row of computeRows(state, { height, width }, opts)) {
    if (row.chunks) {
      // 行式 Markdown：按片段构建 StyledText（每片段独立颜色/属性）
      const styled = new StyledText(
        row.chunks.map((c) => ({
          __isChunk: true as const,
          text: c.text,
          ...(c.fg ? { fg: parseColor(c.fg) } : {}),
          attributes:
            (c.bold ? TextAttributes.BOLD : 0) |
            (c.italic ? TextAttributes.ITALIC : 0) |
            (c.dim ? TextAttributes.DIM : 0) |
            (c.underline ? TextAttributes.UNDERLINE : 0),
        }))
      );
      // wrapMode: none —— 行已在 buildBody 中按列数折行，这里每行固定 1 个终端行，行数预算不被打破（见 computeRows 注释）
      tree.cells.push(new TextRenderable(ctx, { content: styled, wrapMode: 'none' }));
    } else {
      tree.cells.push(
        new TextRenderable(ctx, {
          content: row.text,
          attributes: createTextAttributes(row.style),
          ...(row.style.fg ? { fg: parseColor(row.style.fg) } : {}),
          wrapMode: 'none',
        })
      );
    }
  }
  for (const c of tree.cells) tree.root.insertBefore(c, anchor);
}

/** 创建 TUI 会话：建树 + 首帧，返回 paint/stop/input/onKeyPress */
export async function startTui(state: TuiState, opts?: { withInput?: boolean }): Promise<TuiSession> {
  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  const ctx = renderer as unknown as RenderContext; // CliRenderer 实现了 RenderContext
  const tree = mountTree(ctx, state, opts);

  // 重绘串行化：流式节流/按键/flush 的 paint 可能重叠，而 OpenTUI 渲染器
  // 不允许并发 loop()（原生侧非线程安全，并发调用是闪退高危候选）。
  // 用 promise 链排队；单次失败写崩溃日志后不阻塞后续重绘，同时把错误上抛
  // 给调用方（flush / 交互循环可见，避免静默吞掉）。
  let paintChain: Promise<void> = Promise.resolve();
  const paint = async (): Promise<void> => {
    const run = paintChain.then(async () => {
      try {
        repaintTree(ctx, tree, state, opts);
        // 显式画一帧（与测试渲染器 renderOnce 内部一致；CLI 渲染器同样可用）
        await (renderer as unknown as { loop(): Promise<void> }).loop();
      } catch (e) {
        logCrash('paint', e);
        throw e;
      }
    });
    paintChain = run.catch(() => {}); // 链保持已决状态，单次失败不影响下一次重绘
    await run; // 调用方拿到真实结果（失败时 reject）
  };

  await paint();
  // 跟踪 onKeyPress 订阅：stop() 时统一清理，避免订阅泄漏
  const keyUnsubs = new Set<() => void>();
  return {
    paint,
    stop: async () => {
      for (const unsub of keyUnsubs) unsub();
      keyUnsubs.clear();
      renderer.stop();
    },
    input: tree.input,
    onKeyPress: (cb) => {
      const handler = (key: TuiKey) => {
        cb(key);
      };
      renderer.keyInput.on('keypress', handler);
      const unsub = () => {
        renderer.keyInput.off('keypress', handler);
      };
      keyUnsubs.add(unsub);
      return () => {
        keyUnsubs.delete(unsub);
        unsub();
      };
    },
  };
}

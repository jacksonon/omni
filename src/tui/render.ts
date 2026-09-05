/**
 * TUI 渲染层（命令式，不依赖 solid 响应式）。
 *
 * 背景：OpenTUI 的 solid 集成在此环境存在 JSX 转换时序问题（入口文件在
 * preload 注册插件前就被转换），信号变更无法触发重绘。因此这里直接用
 * @opentui/core 的 renderable 构建渲染树，状态变更后显式调用 loop() 重绘。
 *
 * 业务划分（结构拆分，按职责分层）：
 *   · layout.ts —— 布局常量 + 按显示列数的折行/截断数学（不依赖 OpenTUI）
 *   · theme.ts  —— 主题色板与取色（system/light/dark）
 *   · rows.ts   —— 状态 → 内容行（buildBody/computeRows/点击命中，纯函数）
 *   · render.ts —— 渲染编排：mountTree（建树）/ repaintTree（细胞池复用重绘）/
 *                  applyRowToCell（行 → 单元格原位更新）/ startTui（事件编排）
 *
 * 布局（交互模式，纵向 flex，无边框/标题）：
 *   ▍你好（白字灰底）                      ← 内容行（用户消息带蓝细线+灰底）
 *   💭 思考…
 *   ...（内容不足时此处留空）
 *   等待输入…                              ← 状态栏（灰块上方）
 *   ⏳ 待发送（3 · ↑ 1 打断）  ← 待发送小视图（灰块正上方，钉底）：· queue / ↑ steer
 *     · 排队消息 / ↑ 打断消息      ↑/↓ 选中 · ←/→ 排序 · Enter 编辑 · Del 删除
 *   ╭──────────────────────────────╮ ← 灰色块（16px 圆角；输入框 + 模型行）
 *   ▍ 输入消息，Enter 发送…         │ 多行输入框（▍ 蓝色细线贴左缘、竖跨整块）
 *   ▍ Build · grok-4.5 demo · medium · ⠹ esc interrupt │ 模型行（模式/模型/组/级别 + 速率右侧 loading/esc 打断提示）
 *   ╰──────────────────────────────╯
 *   首 token 平均 6.5s · 112 tok/s| …    ← 统计行（仅统计内容，对齐可配；loading/esc 已入模型行）
 * 灰色块（输入框 + 模型行，淡灰色背景，四边 16px 圆角）与对话流区分；
 * 左侧**蓝色细线（▍，与对话流用户消息同款）**贴左缘、**竖跨整个灰色背景**（含上下
 * 圆角边框行，用户要求：高度 = 边框 2 + 输入 inputLines + 间距 1 + 模型 1 = inputLines+4，
 * 显式 height 钉住 + marginTop/Bottom:-1 溢出到边框行，不撑大灰块）；高度低（paddingY 0，
 * 输入框与模型行之间留 1 行间距，灰块 = 圆角边框 2 + 输入 inputLines + 间距 1 + 模型 1 = inputLines+4）。
 * 模型行（**左对齐**——用户要求从右侧移到左侧显示）显示当前模型 + 思考强度（思考强度用稍淡颜色）
 * + 速率右侧的 loading/esc 打断提示（会话进行中转圈 + `esc interrupt`，`·` 分隔符仅 loading 时显示）。
 * 运行中提交分流：Enter = queue（追加待发送列表末尾）；Cmd/Ctrl/Super/Option+Enter = steer
 *（插入最前，打断当前回合优先执行）；Esc 取消当前对话。待发送小视图显示在**灰色块正上方**
 *（与灰块一起钉在视口底部，位置确定不随内容浮动），每条带 mode 徽标（·/↑）；
 * 可 ↑/↓ 选中、←/→ 排序、Enter 编辑、Backspace/Delete 删除、Esc/继续输入退出。
 * 发送/取消按钮已移除（TUI 无点击交互）。
 * 灰块外底行（输入区下方）：左[文件夹] …… 右[输入/输出 · 缓存 · 上下文用量]——
 * 输入/输出与缓存从模型行移到右侧上下文用量左侧（dim 色），回答中左侧也保持显示文件夹。
 * 通过 marginTop:auto 吸收剩余空间，始终固定在视口最底部。单次任务模式
 * （无输入框）时仅状态栏，无灰色块与统计行。
 *
 * 命令联想列表（输入 / 时）是**独立浮层**（suggestBox）：绝对定位 + 面板底色，
 * 悬停在输入框（灰色块）上方，不占内容流、不挤动对话（用户要求独立界面）；
 * 非模态，可继续输入；↑/↓ 高亮、Tab/Enter/鼠标点击填入。
 */
import {
  BoxRenderable,
  StyledText,
  TextAttributes,
  TextRenderable,
  TextareaRenderable,
  createCliRenderer,
  createTextAttributes,
  parseColor,
} from '@opentui/core';
import type { RenderContext } from '@opentui/core';
import { execFileSync } from 'node:child_process';
import { openInEditor } from '../agent/report.js';
import { commandSuggestions, confirmMenu, findCommand, scheduleCmdPanelAutoClose } from './commands.js';
import { logCrash } from './crashlog.js';
import { dim } from '../ui.js';
import { t, tf } from './i18n.js';
import { detectMention, insertMention, listMentionCandidates } from './mention.js';
import { TRACE_TEXT_COLS, TRACE_W, traceDetailLines, tracePanelLines } from './trace.js';
import { ACCENT_BAR, CONTENT_PAD, contextPercent, estimateInputLines, fitCount, formatCompact, formatContextUsage, formatMiniBar, sessionAvgRate, truncatePathHead } from './layout.js';
import { effortColor, isLightTheme, themeColor, themeFor, type TuiTheme } from './theme.js';
import { SPINNER_FRAMES, pushLine, pushToast, type CmdSuggestion, type MentionSuggestion, type TuiState } from './state.js';
import { editPending } from './pending.js';
import { visualWidth } from './width.js';
import {
  cmdPanelRows,
  computeRows,
  delegatePanelRows,
  hitTestApproval,
  hitTestCard,
  hitTestThinking,
  hitTestTokens,
  markRowSelected,
  menuPanelRows,
  selectionMoved,
  selectionText,
  type CardRect,
  type Row,
  type RowStyle,
  type TuiSelection,
} from './rows.js';

// 行构建与命中判定（纯函数层）对 render 的调用方保持原有导出面（快照测试等）
export {
  buildBody,
  computeRows,
  hitTestApproval,
  hitTestCard,
  hitTestThinking,
  hitTestTokens,
  menuPanelRows,
  rowStyle,
  type CardRect,
  type Row,
  type RowStyle,
} from './rows.js';
export { themeColor, themeFor, isLightTheme, type TuiTheme } from './theme.js';

/**
 * hero 大号品牌字标「OMNI」：4 行高的粗体方块字（█，几何现代风格，阅读清晰且
 * 明显比单行文字大——用户反馈单行 Omni 太小）。纯 ASCII/BLOCK 判宽与雪字符一致，
 * 避免个别终端按全角渲染导致错位。每行固定 23 列等宽（可整体居中）；渲染时按
 * 行号错相彩虹色渐变（bannerHue 驱动，竖向流动）。行数 = OMNI_BANNER.length
 *（hero 垂直居中预算用）；无 subtitle（用户要求去掉）。
 */
const OMNI_BANNER = [
  ' ███  █   █ █   █ █████',
  '█   █ ██ ██ ██  █   █  ',
  '█   █ █ █ █ █ █ █   █  ',
  ' ███  █   █ █  ██ █████',
];

/** hero 品牌头行数（用于垂直居中预算） */
const HERO_LINES = OMNI_BANNER.length;

/** HSL → CSS hex（彩虹动画用）：h∈[0,360)、s/l∈[0,1]，返回 `#rrggbb` */
export function hslToHex(h: number, s: number, l: number): string {
  const f = (n: number): number => {
    const k = (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  const to = (v: number): string =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
}

export interface TuiSession {
  /** 立即重绘一帧（状态变更后调用） */
  paint(): Promise<void>;
  /** 退出全屏（恢复终端） */
  stop(): Promise<void>;
  /** 交互模式的输入框（多行 Textarea；单次任务模式为 null） */
  input: TextareaRenderable | null;
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
  /** Alt/Option（OpenTUI 里 Option 键记作 option，与 meta 同源但 kitty 协议下可独立） */
  option?: boolean;
  /** 阻止后续 renderable（输入框）处理该按键 */
  preventDefault(): void;
  stopPropagation(): void;
}

/** 渲染树：根 Box + 内容文本节点 + 灰色块（输入框/模型/按钮）+ 统计行 + 状态栏 */
export interface TuiTree {
  root: BoxRenderable;
  cells: TextRenderable[];
  status: TextRenderable;
  /** Omni 标题（hero 模式——未开始对话时居中显示在输入区上方；正常模式隐藏） */
  omniTitle: BoxRenderable | null;
  /** 横幅文字行（OMNI_BANNER 每行一个 TextRenderable；按行错相彩虹色单独设 fg） */
  omniCells: TextRenderable[];
  /** 底部固定块（ask + 待发送区 + 灰色块）：hero 模式去 marginTop:auto 让根 justifyContent 居中 */
  bottomBlock: BoxRenderable | null;
  /** 灰色块（输入行 + 模型行，交互模式非 null；单次任务模式为 null） */
  footerBox: BoxRenderable | null;
  /** 灰块外底行（文件夹/上下文，输入区下方，左右分别与输入区对齐） */
  metaRow: BoxRenderable | null;
  /** 灰块外底行左侧：文件夹全路径（分支）——精简无图标；回答中也保持显示（loading 已移入模型行） */
  metaLeft: TextRenderable | null;
  /** 灰块外底行弹性间隔（把右侧段推到行尾，与输入区右对齐） */
  metaSpacer: BoxRenderable | null;
  /** 灰块外底行右侧：上下文用量（迷你条 + `18.3K/128K (19%)`；无用量时隐藏） */
  metaCtx: TextRenderable | null;
  /** 灰色块左侧蓝色细线（▍，与对话流用户消息同款）：紧贴左缘、竖跨整个灰色背景（含上下边框行） */
  blueLine: TextRenderable | null;
  input: TextareaRenderable | null;
  /** 模型行 / 思考强度 / 会话平均速率 / loading+esc 打断提示（repaintTree 每次刷新内容） */
  footerModel: TextRenderable | null;
  /** 模式前缀（Build/Plan，独立着色：Build 青 / Plan 洋红，避开思考级别色阶；repaintTree 每次按 planMode 刷新） */
  footerMode: TextRenderable | null;
  /** 思考级别（`· medium`，按级别强度着色 effortColor；未设置思考级别时为空） */
  footerEffort: TextRenderable | null;
  /** 会话累计平均速率（`· 167 tok/s`，含 live 增量；无数据时隐藏） */
  footerAvg: TextRenderable | null;
  /** loading + esc 打断提示（`· ⠹ esc interrupt`；会话进行中显示在速率右侧，spinner 帧随 loadingIndex 推进） */
  footerLoad: TextRenderable | null;
  /** 输入/输出精简文本（`输入 X · 输出 Y`；灰块外底行右侧、上下文用量左侧；无数据时隐藏） */
  footerIO: TextRenderable | null;
  /** 缓存命中（`缓存 N%`；灰块外底行右侧、上下文用量左侧；无缓存数据时隐藏） */
  footerCache: TextRenderable | null;
  /** 待发送消息区（输入框上方小视图：显示 queue/steer 消息，回合结束后按序发送；可选中/排序/删除/编辑） */
  queueBox: BoxRenderable | null;
  queueCells: TextRenderable[];
  /** 任务清单小视图（输入框上方、待发送区上方：todo_write 更新实时显示 ✓/▸/·） */
  todoBox: BoxRenderable | null;
  todoCells: TextRenderable[];
  /**
   * 运行中 delegate 面板（输入框正上方、todo/待发送区上方：command 样式——footerBg
   * 底 + 左侧深灰竖线；每条运行中 delegate 一行，点击展开明细 + ⏹ 停止）。
   */
  delegateBox: BoxRenderable | null;
  delegateCells: TextRenderable[];
  /** 每次重绘刷新：delegate 面板行的屏幕 y → 动作（toggle 展开/收起 · stop 停止；点击命中用） */
  delegateRects: Map<number, { run: number; kind: 'toggle' | 'stop' }>;
  /** 每次重绘刷新：待发送消息行的屏幕 y → pending 下标（点击选中用；仅消息行，不含标题/还有 N 条） */
  pendingRects: Map<number, number>;
  /** 每次重绘刷新：卡片 id → 本次可见的屏幕 y 范围（点击命中用） */
  cardRects: Map<number, CardRect>;
  /** 每次重绘刷新：思考折叠摘要/单独展开行的屏幕 y → state.lines 下标（点击单独展开/收起） */
  thinkingRects: Map<number, number>;
  /** 每次重绘刷新：token 统计模块行的屏幕 y → state.lines 下标（点击展开/收起汇总明细） */
  tokensRects: Map<number, number>;
  /** 每次重绘刷新：本地文件链接行的屏幕 y → 该行内可点击跨度（行内起始列/显示宽度/绝对路径；点击外部编辑器打开） */
  fileRects: Map<number, { col: number; width: number; path: string }[]>;
  /** 每次重绘刷新：审批卡片本次可见的屏幕 y 范围（点击批准/拒绝用；无审批为 null） */
  approvalRect: { top: number; bottom: number } | null;
  /** 命令联想 / @ 提及列表（独立浮层：圆角方框 + 背景，绝对定位悬停在输入框上方，不占内容流；非模态） */
  suggestBox: BoxRenderable | null;
  suggestCells: TextRenderable[];
  /** 联想浮层本次可见的屏幕 y 区间（0-based 事件坐标；鼠标点击命中/穿透判定用） */
  suggestRect: { top: number; bottom: number } | null;
  /** 联想浮层内部行 → items 下标映射（-1 = ↑/↓ 提示行，不可点击；点击命中用） */
  suggestRowMap: number[];
  /** 命令面板浮层（/theme alert：绝对定位居中，不占用内容流） */
  menuOverlay: BoxRenderable | null;
  menuCells: TextRenderable[];
  /** 菜单浮层左侧深灰竖线（同输入区蓝线写法，独立渲染列） */
  menuBar: TextRenderable | null;
  /** 菜单浮层内部行 → 选项下标映射（-1 = 标题/提示/底边行，不可点击；鼠标点击命中用） */
  menuRowMap: number[];
  /** 命令输出面板浮层（所有 / 命令的独立窗口：绝对定位居中，不占用内容流/不参与滚动） */
  cmdPanelOverlay: BoxRenderable | null;
  cmdPanelCells: TextRenderable[];
  /** 命令输出面板左侧深灰竖线（同输入区蓝线写法，独立渲染列） */
  cmdPanelBar: TextRenderable | null;
  /** 轨迹面板浮层（/trace 右侧栏：绝对定位右缘，宽 TRACE_W；展开时内容宽度收缩） */
  traceBox: BoxRenderable | null;
  traceCells: TextRenderable[];
  /** 轨迹面板可点击区域（面板内部行；屏幕 0-based y 区间）+ 行 → traceRows 下标映射（-1 = 标题/提示行） */
  traceRect: { top: number; bottom: number } | null;
  traceRowMap: number[];
  /** 轨迹面板占据的屏幕列起始（x ≥ 该值且 y 命中 traceRect 的点击归属面板，不穿透内容） */
  traceLeft: number;
  /** ask_user 提问面板（bottomBlock 内、待发送区上方：问题 + 选项 + 提示；非空时可见） */
  askBox: BoxRenderable | null;
  askCells: TextRenderable[];
  /** 每次重绘刷新：ask 面板行的屏幕 y → 行类型（鼠标点击勾选/确认用） */
  askRects: Map<number, { kind: 'opt' | 'custom' | 'confirm'; idx?: number }>;
  /**
   * 本次可见的内容行（computeRows 结果，含滚动提示/窗口），供拖选字符级定位
   * （x → 行内列 → 字符）与 up 时提取选区文本。每次重绘刷新。
   */
  lastRows: Row[];
  /**
   * 拖选选区（字符级精选取中）：非 null = 正在/刚完成一次拖选。
   * 坐标用内容行下标 + 显示列（相对行首），渲染/提取都按它。
   * up 时若 selectionMoved 为 false（纯点击）则清除不复制。
   */
  sel: TuiSelection | null;
  /** 右上角 toast 浮层（Alert notification：绝对定位右上角，短暂显示自动消失） */
  toastBox: BoxRenderable | null;
  toastCell: TextRenderable | null;
}

/** 建树（首帧）：根 Box（无边框）+ 输入框 + 状态栏挂到 root 下，内容行由 repaintTree 维护 */
export function mountTree(ctx: RenderContext, state: TuiState, opts?: { withInput?: boolean }): TuiTree {
  const theme = themeFor(state);
  const root = new BoxRenderable(ctx, {
    flexGrow: 1, // 撑满视口高度，让输入框的 marginTop:auto 能把剩余空间吸收到内容区下方
    flexDirection: 'column',
    paddingX: 1,
    paddingY: 1,
    // 内容区背景：亮色模式白色（修复界面整体仍黑）；深色不设置 = 透终端底色（现状）
    ...(theme.background ? { backgroundColor: theme.background } : {}),
  });
  (ctx as unknown as { root: BoxRenderable }).root.add(root);
  let footerBox: BoxRenderable | null = null;
  let blueLine: TextRenderable | null = null;
  let input: TextareaRenderable | null = null;
  let footerModel: TextRenderable | null = null;
  let footerMode: TextRenderable | null = null;
  let footerEffort: TextRenderable | null = null;
  let footerAvg: TextRenderable | null = null;
  let footerLoad: TextRenderable | null = null;
  let metaRow: BoxRenderable | null = null;
  let metaLeft: TextRenderable | null = null;
  let metaSpacer: BoxRenderable | null = null;
  let metaCtx: TextRenderable | null = null;
  /** 输入/输出 · 缓存（灰块外底行右侧、上下文用量左侧；随 metaRow 创建） */
  let footerIO: TextRenderable | null = null;
  let footerCache: TextRenderable | null = null;
  let queueBox: BoxRenderable | null = null;
  const queueCells: TextRenderable[] = [];
  let todoBox: BoxRenderable | null = null;
  const todoCells: TextRenderable[] = [];
  let delegateBox: BoxRenderable | null = null;
  const delegateCells: TextRenderable[] = [];
  let askBox: BoxRenderable | null = null;
  const askCells: TextRenderable[] = [];
  if (opts?.withInput) {
    // 灰色块：淡灰背景（按主题），整块行布局——蓝色细线贴左缘竖跨整块，
    // 右侧内容列（输入框 + 模型行）。auto 上边距吸收内容区剩余空间：
    // 无论内容多少，灰色块都钉在视口底部。
    footerBox = new BoxRenderable(ctx, {
      flexDirection: 'row',
      alignItems: 'stretch',
      // marginTop:auto 已上移到底部固定块（bottomBlock）——待发送消息区 + 灰色块
      // 一起钉底（否则自由空间会落在待发送区下方、把它推到内容区位置）
      backgroundColor: theme.footerBg,
      // 16px 圆角：OpenTUI 无 borderRadius——用 rounded 边框 + 同色边框线模拟：
      // 边框字符背景透明，圆角（╭╮╰╯）外露出终端底色形成圆角；边框线本身与背景同色不可见
      border: true,
      borderStyle: 'rounded',
      borderColor: theme.footerBg,
    });

    // 左侧蓝色细线（▍ 3/8 块，与对话流用户消息左侧同款）：**紧贴灰块左缘**、竖跨整块。
    // marginLeft:-1 把细线拉到圆角边框列上（边框线同色不可见，细线盖住边框格 →
    // 与用户消息的 ▍ 一样贴块左缘；探针实测负 margin 生效）。高度（inputLines + 4 =
    // 圆角边框 2 + 输入 + 间距 1 + 模型行）由 repaintTree 每次重绘按最新 inputLines
    // 同步；marginTop/Bottom -1 使 margin-box 与内容列同高不撑大灰块，同时渲染起点
    // 上移 1 行盖住顶边框、向下溢到底边框——**竖跨整个灰色背景**（用户要求）。
    // bg 与灰块同色，折行/增高时连续
    blueLine = new TextRenderable(ctx, { content: '', wrapMode: 'none', marginLeft: -1, marginTop: -1, marginBottom: -1 });
    blueLine.fg = parseColor(theme.accentBlue);
    blueLine.bg = parseColor(theme.footerBg);
    footerBox.add(blueLine);

    // 内容列：paddingX 1 让输入文字与圆角边框保持 1 列间距（细线让 1 列）；
    // **paddingY 0 + gap 1**（用户要求输入区域高度低：灰块 = 圆角边框 2 + 输入 inputLines
    // + 间距 1 + 模型 1 = inputLines+4；gap 1 让输入文字与模型行之间留 1 行间距——
    // 用户反馈「输入文字和模型那一行太近了」）
    const contentCol = new BoxRenderable(ctx, {
      flexDirection: 'column',
      flexGrow: 1,
      paddingX: 1,
      paddingY: 0,
    });

    // 多行输入框（对标 opencode）：Enter 发送、Shift+Enter 换行、内容自动增高。
    // 不设固定 height，只给 minHeight/maxHeight → yoga 按内容行数自动增高（1-5 行），
    // 超过 5 行后内部滚动（光标始终可见）；多行粘贴保留换行。
    // 自定义 keyBindings 与默认绑定合并：return/kpenter/linefeed → submit（覆盖默认
    // 的 newline），shift+return 等 → newline；其余编辑键（↑↓/Home/End/Ctrl+U 等）不变。
    input = new TextareaRenderable(ctx, {
      // 占位符必须单行内放得下：多行输入框高度预算按 inputLines（内容行数）计算，
      // 占位符若折行会让输入框实际高度超预算、把内容区挤出（见 computeRows 注释）。
      placeholder: t(state.language, 'input.placeholder'), // mount 时初始值；切语言后由 repaintTree 每帧刷新即时生效
      minHeight: 1,
      maxHeight: 5,
      flexGrow: 1,
      textColor: theme.inputText,
      placeholderColor: theme.placeholder,
      backgroundColor: theme.inputBg, // 输入框底色：与灰块同色融合（亮色下用户要求去掉白色背景）
      keyBindings: [
        { name: 'return', action: 'submit' },
        { name: 'kpenter', action: 'submit' },
        { name: 'linefeed', action: 'submit' },
        { name: 'return', shift: true, action: 'newline' },
        { name: 'kpenter', shift: true, action: 'newline' },
        { name: 'linefeed', shift: true, action: 'newline' },
        // 修饰键 + Enter 全部路由到 submit（steer 提交）：默认只有 meta+return 绑定 submit，
        // kitty/modifyOtherKeys 终端里 Ctrl+Enter、Super+Enter 会以独立修饰位到达，
        // 不补绑定就会被 EditBuffer 吞掉（steer 复现不出来的根因之一）
        { name: 'return', meta: true, action: 'submit' },
        { name: 'return', ctrl: true, action: 'submit' },
        { name: 'return', super: true, action: 'submit' },
        { name: 'kpenter', meta: true, action: 'submit' },
        { name: 'kpenter', ctrl: true, action: 'submit' },
        { name: 'kpenter', super: true, action: 'submit' },
        { name: 'linefeed', meta: true, action: 'submit' },
        { name: 'linefeed', ctrl: true, action: 'submit' },
        { name: 'linefeed', super: true, action: 'submit' },
      ],
    });
    contentCol.add(input);

    // 模型行（输入框下方，灰色块内）：模式/模型/级别/均值/输入输出/缓存
    // （无数据段隐藏；超宽按 缓存→输入输出 顺序隐藏；模式前缀 Build 青 / Plan 洋红独立着色，
    // 级别按强度着色）。文件夹与上下文已移出灰块，见下方 metaRow。
    const modelRow = new BoxRenderable(ctx, {
      flexDirection: 'row',
      justifyContent: 'flex-start',
      alignItems: 'center',
      gap: 1,
    });
    // 模式前缀（`Build` / `Plan` + 分隔符 ` ·`）：独立 TextRenderable 按模式着色
    footerMode = new TextRenderable(ctx, { content: '', wrapMode: 'none' });
    footerMode.fg = parseColor(theme.footerText);
    modelRow.add(footerMode);
    // 模型文本（模型名 + provider 组名）：`mock demo`（前缀在 footerMode，这里是纯模型名）
    footerModel = new TextRenderable(ctx, { content: '', wrapMode: 'none' });
    footerModel.fg = parseColor(theme.footerText);
    modelRow.add(footerModel);
    // 思考级别（` · medium`，按级别强度着色 effortColor；未设置思考级别时为空）
    footerEffort = new TextRenderable(ctx, { content: '', wrapMode: 'none' });
    footerEffort.fg = parseColor(theme.footerDim);
    modelRow.add(footerEffort);
    // 会话累计平均速率（`· 167 tok/s`）
    footerAvg = new TextRenderable(ctx, { content: '', wrapMode: 'none' });
    footerAvg.fg = parseColor(theme.footerDim);
    modelRow.add(footerAvg);
    // loading + esc 打断提示（`· ⠹ esc interrupt`）：会话进行中显示在速率右侧，
    // spinner 帧随 loadingIndex 推进（repaintTree 刷新）；会话结束隐藏
    footerLoad = new TextRenderable(ctx, { content: '', wrapMode: 'none' });
    footerLoad.fg = parseColor(theme.footerDim);
    modelRow.add(footerLoad);
    contentCol.add(modelRow);

    footerBox.add(contentCol);
  }

  // 灰块外底行（输入区下方）：左[文件夹全路径] …… 右[输入/输出 · 缓存 · 上下文用量]，
  // 左右分别与输入区（灰块内容列）对齐。loading 不再占据左侧（已移入模型行速率右侧）。
  if (opts?.withInput) {
    metaRow = new BoxRenderable(ctx, {
      flexDirection: 'row',
      justifyContent: 'flex-start',
      alignItems: 'center',
      gap: 1,
      marginTop: 1,
      // 与灰块内容列左右对齐：根 paddingX(1) + margin 2 = 内容文本起始列(3)；
      // 右侧同理，上下文用量右缘与输入区文本右缘对齐
      marginLeft: 2,
      marginRight: 2,
    });
    metaLeft = new TextRenderable(ctx, { content: '', wrapMode: 'none' });
    metaLeft.fg = parseColor(theme.footerDim);
    metaRow.add(metaLeft);
    metaSpacer = new BoxRenderable(ctx, { flexDirection: 'row', flexGrow: 1 });
    metaRow.add(metaSpacer);
    // 输入/输出（`输入 X · 输出 Y`）+ 缓存（`缓存 N%`）：**在上下文用量左侧**——
    // 从模型行移到灰块外底行右侧（dim 色，与上下文同排；无数据各段隐藏）
    footerIO = new TextRenderable(ctx, { content: '', wrapMode: 'none' });
    footerIO.fg = parseColor(theme.footerDim);
    metaRow.add(footerIO);
    footerCache = new TextRenderable(ctx, { content: '', wrapMode: 'none' });
    footerCache.fg = parseColor(theme.footerDim);
    metaRow.add(footerCache);
    metaCtx = new TextRenderable(ctx, { content: '', wrapMode: 'none' });
    metaCtx.fg = parseColor(theme.footerDim);
    metaRow.add(metaCtx);
    // 注意：metaRow 挂到 root 尾部（bottomBlock 之后，见 mount 末尾）——
    // 早挂会被渲染到内容区顶部（root 子节点顺序 = 渲染顺序）
    // hero（无对话 / /clear 后回到初始居中态）下整行隐藏——该行的左侧文件夹
    // 与右侧上下文/输入输出都随「对话是否存在」出现，初始态不显示
    metaRow.visible = false;
  }

  // 子节点顺序：内容行（动态）→ 状态栏 → 灰色块（marginTop:auto 钉底）。
  // 状态栏 marginTop:1 —— 与内容区之间留 1 行间距（用户反馈「工具执行之后如果有
  // 执行中、思考中（状态栏 ⠋ 文案），要和工具执行的区域有一点间隔，现在贴在一起了」
  // ——内容不满屏时状态栏紧贴最后一行内容（如工具卡片），加间距后不再紧贴）。
  const status = new TextRenderable(ctx, {
    content: '',
    attributes: createTextAttributes({ dim: true }),
    wrapMode: 'none',
    marginTop: 1,
  });
  root.add(status);

  // Omni 品牌头（hero 模式——未开始对话时居中显示在输入区上方）：品牌名行
  //（◈ Omni，逐字符彩虹渐变）+ tagline 行（dim，i18n）。每行独立 TextRenderable（
  // alignSelf:center 在根列布局中水平居中）；正常模式隐藏不占布局。颜色由 repaintTree
  // 按 bannerHue 逐帧刷新（彩虹流动动画，见 hero 块）。
  const omniTitle = new BoxRenderable(ctx, {
    flexDirection: 'column',
    alignSelf: 'stretch',
    marginBottom: 1,
    visible: false,
  });
  const omniCells: TextRenderable[] = [];
  // 大号字标每行：整行居中、加粗。彩虹渐变在 repaintTree 的 hero 块里按行号错相设置
  //（bannerHue 驱动竖向流动，用户要求动画）。
  for (const l of OMNI_BANNER) {
    const cell = new TextRenderable(ctx, {
      content: l,
      wrapMode: 'none',
      alignSelf: 'center',
      attributes: createTextAttributes({ bold: true }),
    });
    omniTitle.add(cell);
    omniCells.push(cell);
  }
  root.add(omniTitle);

  // 命令联想（输入 / 时）与 @ 提及文件选择共用这个浮层：**独立浮层**——绝对定位 +
  // 输入区同款风格（与输入区同底色 footerBg + 左侧深灰竖线 ▍ + 与输入区同宽，见 repaintTree），
  // 悬停在输入框（灰色块）上方，不占内容流、不挤动对话（用户要求独立界面、非当前对话流）。非模态：
  // 不拦截输入，用户可继续打字（列表按最新文本过滤，无匹配自动隐藏）；↑/↓ 高亮、
  // Tab/Enter 填入、鼠标点击某项填入。位置（top/left）与宽度由 repaintTree 每帧重算。
  const suggestBox = new BoxRenderable(ctx, {
    position: 'absolute',
    zIndex: 9, // 低于 /theme 面板浮层（10），高于内容流
    flexDirection: 'column',
    visible: false,
    // 扁平无边框 + 输入区同底：行内逐行绘制左侧深灰 ▍（同输入区蓝线写法）+ 文本补空格铺满整宽
    backgroundColor: theme.footerBg,
    paddingX: 0,
  });
  root.add(suggestBox);
  const suggestCells: TextRenderable[] = [];
  for (let i = 0; i < 20; i++) {
    const c = new TextRenderable(ctx, { content: '', wrapMode: 'none' });
    suggestBox.add(c);
    suggestCells.push(c);
  }

  // 命令面板浮层（/theme alert）：绝对定位居中（top/left 每帧重算），zIndex 高于内容；
  // 独立于会话流——菜单不占内容行、不参与滚动（用户要求「额外显示一个 alert」）。
  // **输入区同款风格**：整体填输入区底色（不透明浮于对话流之上）+ 行内逐行左侧深灰 ▍
  // （同输入区蓝线写法，见 applyPanelRowToCell）；居中但比原来大（panelW 上限 56）。
  const menuOverlay = new BoxRenderable(ctx, {
    position: 'absolute',
    zIndex: 10,
    visible: false,
    flexDirection: 'row',
    backgroundColor: theme.footerBg,
  });
  root.add(menuOverlay);
  // 左侧深灰竖线（同输入区蓝线写法：独立渲染列逐行 ▍，颜色换深灰 suggestBorder）+
  // 内容列（卡片行纯文本，经 applyRowToCell 渲染；行内不拼 chunk，避免宽字符错位）
  const menuBar = new TextRenderable(ctx, { content: '', wrapMode: 'none' });
  menuBar.fg = parseColor(theme.suggestBorder);
  menuBar.bg = parseColor(theme.footerBg);
  menuOverlay.add(menuBar);
  const menuContent = new BoxRenderable(ctx, { flexDirection: 'column' });
  menuOverlay.add(menuContent);
  // 细胞池预分配**充足**行数：窗口滚动后菜单面板行数 = 标题 1 + 窗口（≤12）+
  // 上下提示 ≤2 + 操作提示 1 + 底边 1 ≤ 17；60 行覆盖超高视口（与 cmdPanel 同策略）。
  // 池不足时超出部分不渲染 = 面板「展示不全」（用户实测反馈：/session 面板有提示行
  // 但选项/底边被裁）——快照只断言纯函数行数、从未验证 pool 容量，回归靠这个注释防。
  const menuCells: TextRenderable[] = [];
  for (let i = 0; i < 60; i++) {
    const c = new TextRenderable(ctx, { content: '', wrapMode: 'none' });
    menuContent.add(c);
    menuCells.push(c);
  }

  // 命令输出面板浮层（所有 / 命令的独立窗口）：绝对定位居中（top/left 每帧重算），
  // 与 /theme 菜单浮层同级（zIndex 10，二者不同时打开）。细胞池预分配充足行数
  // （可见主体行 ≤ 视口-6，60 行覆盖超高视口；不参与内容流/滚动）。
  // **输入区同款风格**：整体填输入区底色（不透明浮于对话流之上）+ 行内逐行左侧深灰 ▍；
  // 居中但比原来大（panelW 上限 88）。
  const cmdPanelOverlay = new BoxRenderable(ctx, {
    position: 'absolute',
    zIndex: 10,
    visible: false,
    flexDirection: 'row',
    backgroundColor: theme.footerBg,
  });
  root.add(cmdPanelOverlay);
  // 左侧深灰竖线（同菜单浮层/输入区蓝线写法）+ 内容列
  const cmdPanelBar = new TextRenderable(ctx, { content: '', wrapMode: 'none' });
  cmdPanelBar.fg = parseColor(theme.suggestBorder);
  cmdPanelBar.bg = parseColor(theme.footerBg);
  cmdPanelOverlay.add(cmdPanelBar);
  const cmdPanelContent = new BoxRenderable(ctx, { flexDirection: 'column' });
  cmdPanelOverlay.add(cmdPanelContent);
  const cmdPanelCells: TextRenderable[] = [];
  for (let i = 0; i < 60; i++) {
    const c = new TextRenderable(ctx, { content: '', wrapMode: 'none' });
    cmdPanelContent.add(c);
    cmdPanelCells.push(c);
  }

  // 轨迹面板浮层（/trace 右侧栏）：绝对定位右缘（top/left 每帧重算），zIndex 低于
  // 菜单/命令面板（内容流之上、浮层之下）；展开时内容宽度收缩（computeRows 读
  // state.traceOpen——对话流右移，线条重新折行，面板不盖内容）。细胞池预分配
  // 充足行数（视口最高 ~60 行；不参与内容流/滚动）。
  const traceBox = new BoxRenderable(ctx, {
    position: 'absolute',
    zIndex: 8,
    flexDirection: 'column',
    visible: false,
    backgroundColor: theme.suggestBg,
    border: true,
    borderStyle: 'rounded',
    borderColor: theme.suggestBorder,
    paddingX: 1,
  });
  root.add(traceBox);
  const traceCells: TextRenderable[] = [];
  for (let i = 0; i < 60; i++) {
    const c = new TextRenderable(ctx, { content: '', wrapMode: 'none' });
    traceBox.add(c);
    traceCells.push(c);
  }

  // 右上角 toast 浮层（Alert notification）：绝对定位右上角（top=1、右缘=1），
  // 短暂显示自动消失；zIndex 最高（11）——不被菜单/命令面板/轨迹面板遮挡。
  // 宽度按文本显示宽每帧重算（clamp 到视口内）；无 toast 时整体隐藏。
  const toastBox = new BoxRenderable(ctx, {
    position: 'absolute',
    zIndex: 11,
    flexDirection: 'row',
    visible: false,
    backgroundColor: theme.suggestBg,
    border: true,
    borderStyle: 'rounded',
    borderColor: theme.suggestBorder,
    paddingX: 1,
  });
  root.add(toastBox);
  const toastCell = new TextRenderable(ctx, { content: '', wrapMode: 'none' });
  toastBox.add(toastCell);

  // 待发送消息区：灰色块（输入框）正上方——运行中 Enter 提交的消息在此显示
  //（每条一行「N queued · 文本」，对标 Claude Code queued 样式——用户要求），不参与
  // 内容区滚动；回合结束后 interactive 按序消费。行数随 pending 长度变化（最多 4 条 +
  // 超出时「还有 N 条」1 行）。
  // **command 面板同款样式**（用户要求）：输入区同底色 footerBg（与灰色块连成一体，
  // 待发送区紧贴输入区上方）+ 行首左侧深灰竖线 ▍（同联想/命令面板写法，行内逐行渲染）。
  // paddingX 0——竖线贴面板左缘（与灰块圆角边框同列），行内容用「▍ + 空格」自排版。
  queueBox = new BoxRenderable(ctx, {
    flexDirection: 'column',
    paddingX: 0,
    gap: 0,
    visible: false,
    backgroundColor: theme.footerBg,
  });
  for (let i = 0; i < 7; i++) {
    const c = new TextRenderable(ctx, { content: '', wrapMode: 'none' });
    queueBox.add(c);
    queueCells.push(c);
  }

  // 任务清单小视图：待发送区上方（todo_write 工具更新 → RunOptions.onTodo 镜像
  // state.todoList → 这里渲染 ✓ 完成 / ▸ 进行中 / · 待办，最多 4 条 + 超出提示）。
  // 空清单隐藏（不占布局）。显示但不点击（todo 状态由模型维护，非用户操作对象）。
  // 与待发送区同款 command 面板背景 + 左侧竖线——两者都紧贴输入区，视觉上是一整块
  // 从灰块向上延伸的连续面板（todo 在上、queue 在下）。
  todoBox = new BoxRenderable(ctx, {
    flexDirection: 'column',
    paddingX: 0,
    gap: 0,
    visible: false,
    backgroundColor: theme.footerBg,
  });
  for (let i = 0; i < 6; i++) {
    const c = new TextRenderable(ctx, { content: '', wrapMode: 'none' });
    todoBox.add(c);
    todoCells.push(c);
  }

  // ask_user 提问面板（输入区上方、待发送区上方）：问题 + 选项行 + 自定义输入 + 操作提示。
  // **扁平面板 + 输入区同款底色**（用户要求：像 command 面板一样有背景色——
  // theme.footerBg 填充，无边框；顶部留白 1 行 + 问题 1 + 选项 n + 自定义 1 + 确认 1 + 提示 1；
  // 预算同步 computeRows options+5）。
  askBox = new BoxRenderable(ctx, {
    flexDirection: 'column',
    paddingX: 1,
    gap: 0,
    visible: false,
    backgroundColor: theme.footerBg,
  });
  for (let i = 0; i < 12; i++) {
    const c = new TextRenderable(ctx, { content: '', wrapMode: 'none' });
    askBox.add(c);
    askCells.push(c);
  }

  // 运行中 delegate 面板（ask 之下、todo/queue 之上）：**command 面板同款样式**——
  // footerBg 底 + 行首深灰竖线 ▍（同 queue/todo 面板，视觉上从灰块向上连续延伸）。
  // 每条运行中 delegate 一行：`→ 子代理 · 摘要`（可点击展开明细 + ⏹ 停止）；
  // 空列表隐藏（不占布局）。细胞池预分配充足行数（单条展开明细最多约 12 行 + 标题，
  // 并行最多 3 条 → 池 48 行；超出部分不渲染（池不足时行数预算已收缩内容区）。
  delegateBox = new BoxRenderable(ctx, {
    flexDirection: 'column',
    paddingX: 0,
    gap: 0,
    visible: false,
    backgroundColor: theme.footerBg,
  });
  for (let i = 0; i < 48; i++) {
    const c = new TextRenderable(ctx, { content: '', wrapMode: 'none' });
    delegateBox.add(c);
    delegateCells.push(c);
  }

  // 底部固定块：**待发送消息区 + 灰色块** 一起钉在视口底部（marginTop:auto 吸收
  // 自由空间——待发送区永远紧贴输入框上方，不随内容浮动；点击命中区域因此确定）。
  // 空待发送时 queueBox 不可见（不占布局），底部块只剩灰色块，行为与之前一致。
  const bottomBlock = new BoxRenderable(ctx, {
    flexDirection: 'column',
    marginTop: 'auto',
  });
  if (askBox) bottomBlock.add(askBox);
  if (delegateBox) bottomBlock.add(delegateBox);
  if (todoBox) bottomBlock.add(todoBox);
  if (queueBox) bottomBlock.add(queueBox);
  if (footerBox) bottomBlock.add(footerBox);
  root.add(bottomBlock);
  // 灰块外底行（文件夹/上下文）挂 bottomBlock 尾部：紧跟灰块、随底部块一起钉底，
  // 与灰块共用同一宽度轴 → 左/右分别与输入区文本对齐（marginLeft/Right 2），上方隔 1 行。
  if (metaRow) bottomBlock.add(metaRow);

  const tree: TuiTree = {
    root,
    cells: [],
    status,
    omniTitle,
    omniCells,
    bottomBlock,
    footerBox,
    metaRow,
    metaLeft,
    metaSpacer,
    metaCtx,
    blueLine,
    input,
    footerModel,
    footerMode,
    footerEffort,
    footerAvg,
    footerLoad,
    footerIO,
    footerCache,
    queueBox,
    queueCells,
    todoBox,
    todoCells,
    delegateBox,
    delegateCells,
    delegateRects: new Map(),
    pendingRects: new Map(),
    cardRects: new Map(),
    thinkingRects: new Map(),
    tokensRects: new Map(),
    fileRects: new Map(),
    approvalRect: null,
    askBox,
    askCells,
    askRects: new Map(),
    suggestBox,
    suggestCells,
    suggestRect: null,
    suggestRowMap: [],
    menuOverlay,
    menuCells,
    menuBar,
    menuRowMap: [],
    cmdPanelOverlay,
    cmdPanelCells,
    cmdPanelBar,
    traceBox,
    traceCells,
    traceRect: null,
    traceRowMap: [],
    traceLeft: 0,
    lastRows: [],
    sel: null,
    toastBox,
    toastCell,
  };
  repaintTree(ctx, tree, state, opts);
  return tree;
}

/** 按列宽截断文本（CJK 感知；超出补省略号——ask 面板选项/问题行用） */
function fitAsk(text: string, cols: number): string {
  const n = fitCount(text, cols);
  return n < text.length ? text.slice(0, Math.max(0, n - 1)) + '…' : text;
}

/** 最近一条 applyRowToCell 错误（去重：连续相同错误只记一次，避免长会话刷爆崩溃日志） */
let lastRowError = '';

/**
 * 把一行内容原位应用到复用单元格（chunks 行 → StyledText；普通行 → 文本 + 样式）。
 *
 * 样式必须**无条件**复位：细胞跨帧复用，上一帧可能是蓝色 user 行、下一帧是
 * 无色 answer 行——`fg`/`attributes` 不重置会残留旧颜色（chunk 行复位为主题默认色，
 * 普通行无 fg 时同样回退主题默认色）。
 *
 * 颜色按主题取：亮色模式下内容默认色为深灰（浅底白字不可读），dim 行（思考/meta/
 * 提示行）显式设深灰文字（dim 白字在浅底上同样看不见）；深色模式维持 dim 属性白字。
 */
function applyRowToCell(cell: TextRenderable, row: Row, theme: TuiTheme): void {
  const isLight = isLightTheme(theme);
  if (row.chunks) {
    // 行式 Markdown：按片段构建 StyledText（每片段独立颜色/属性）
    cell.content = new StyledText(
      row.chunks.map((c) => {
        // 亮色模式：dim 且未指定颜色的片段显式设深灰并去掉 dim 属性——
        // dim 属性在浅色终端上按半亮渲染，叠加深灰会发灰发浅（可读性差）；
        // 直接给中深灰纯色更清晰。其余片段照常（带 fg 的按主题映射）。
        const dimNoFg = isLight && c.dim && !c.fg;
        return {
          __isChunk: true as const,
          text: c.text,
          ...(c.fg ? { fg: parseColor(themeColor(c.fg, theme)) } : {}),
          ...(dimNoFg ? { fg: parseColor(theme.contentDim) } : {}),
          ...(c.bg ? { bg: parseColor(c.bg) } : {}),
          attributes:
            (c.bold ? TextAttributes.BOLD : 0) |
            (c.italic ? TextAttributes.ITALIC : 0) |
            (c.dim && !dimNoFg ? TextAttributes.DIM : 0) |
            (c.underline ? TextAttributes.UNDERLINE : 0) |
            (c.strike ? TextAttributes.STRIKETHROUGH : 0),
        };
      })
    );
    (cell as { attributes?: number }).attributes = 0;
    (cell as { fg?: unknown }).fg = parseColor(theme.contentText);
  } else {
    cell.content = row.text;
    // 亮色模式：dim 行（思考/meta/提示）去掉 dim 属性，改显式深灰纯色（理由同上）；
    // 深色模式维持 dim 属性（浅灰效果不变）。
    const style = isLight && row.style.dim && !row.style.fg ? { ...row.style, dim: false } : row.style;
    (cell as { attributes?: number }).attributes = createTextAttributes(style);
    let fg: string | undefined = row.style.fg ? themeColor(row.style.fg, theme) : undefined;
    if (!fg && row.style.dim && isLight) fg = theme.contentDim;
    (cell as { fg?: unknown }).fg = fg ? parseColor(fg) : parseColor(theme.contentText);
  }
}

/**
 * 重绘：更新状态栏，内容行走**细胞池复用**，并画一帧。
 *
 * 关键修复（用户报告「超过 1 屏内容全被清空」的根因）：早期实现每帧
 * remove 全部旧 cells + new TextRenderable——每个 TextRenderable 持有一个
 * 原生 TextBuffer，流式逐字/滚轮/按键触发的反复重建会耗尽原生对象池
 * （实测约 1365 次重绘后 createTextBuffer 抛「Failed to create native
 * renderable」）。异常发生在「旧 cells 已移除、新的还没建完」之间，内容区
 * 就永久清空且每次重试都失败——崩溃日志里 6295 行该错误的实锤。
 *
 * 改为池只增不减：行数增加才新建（一次性原生分配），行数减少只隐藏
 * （visible=false，不销毁、无原生抖动）；行内容原位更新 content/attributes/fg
 * （setter 均为运行时可用，实测 5000 次原位更新零失败）。单行应用失败时
 * 保留旧内容并记崩溃日志，不让整帧挂掉——内容永远不会再被「清空」。
 */
export function repaintTree(ctx: RenderContext, tree: TuiTree, state: TuiState, opts?: { withInput?: boolean }): void {
  const height = (ctx as { height?: number }).height ?? 24;
  const width = (ctx as { width?: number }).width ?? 80;
  // 主题色按最新 themeMode/detectedTheme 重刷：终端主题检测是异步的（OSC 查询可能晚于首帧），
  // 检测完成后 detectedTheme 更新 → 下一帧自动换色（用户消息底色在 buildBody 里同步取主题）
  const theme = themeFor(state);
  // 根背景：亮色白色 / 深色不设置（undefined 恢复透终端底色）；主题切换（/theme 或检测晚到）即时生效
  tree.root.backgroundColor = theme.background ?? undefined;
  if (tree.footerBox) tree.footerBox.backgroundColor = theme.footerBg;
  if (tree.input) {
    tree.input.textColor = theme.inputText;
    tree.input.placeholderColor = theme.placeholder;
    // placeholder 文本随语言即时刷新（切语言立刻生效，不等重启——mount 时初始值在 mountTree）
    tree.input.placeholder = t(state.language, 'input.placeholder');
    tree.input.backgroundColor = theme.inputBg;
  }
  if (tree.footerModel) tree.footerModel.fg = parseColor(theme.footerText);
  // 思考级别按级别取色（强度递进色阶：low 绿→medium 琥珀→high 橙→xhigh 红→max 紫），
  // 未知/自定义级别回退 footerDim；/variants 切换或主题切换时每帧重取即时生效
  if (tree.footerEffort) tree.footerEffort.fg = parseColor(effortColor(state.reasoningEffort, theme));
  // 待发送消息区（输入框上方小视图）行数预算：最多 4 条消息（每条「N queued · 文本」一行）
  // + 超出时「还有 N 条」1 行。由 computeRows / footerTop（联想浮层）共用——预算同步收缩，
  // 灰色块永远完整可见。
  const pendingCount = state.pending.length;
  const pendingVisibleMsgs = Math.min(4, pendingCount);
  const pendingRows = pendingCount > 0 ? pendingVisibleMsgs + (pendingCount > 4 ? 1 : 0) : 0;
  // 任务清单小视图（待发送区上方）行数预算：最多 4 条 + 超出时「还有 N 项」1 行（空清单 0 行）。
  const todoCount = state.todoList.length;
  const todoRows = todoCount > 0 ? Math.min(4, todoCount) + (todoCount > 4 ? 1 : 0) : 0;
  // 运行中 delegate 面板（输入区上方、ask 之下）：折叠 1 行/条，展开加明细（delegatePanelRows 纯函数，
  // 与 computeRows/hero 预算同源——delegateBox 实际渲染行数 = 该值，见下方 delegateBox 渲染段）。
  const delegateRows = opts?.withInput ? delegatePanelRows(state) : 0;
  // 灰色块顶部（0-based 屏幕行）。联想/菜单/命令面板浮层共用：
  // 浮层底边钳制在此行上方——永不遮住输入区。inputLines 刷新后（下方 if 块内）重新赋值。
  let footerTop = (height ?? 24) - 7 - pendingRows - todoRows - delegateRows - 1;
  // 状态栏：dark 保持 dim 白字（原样）；light 去掉 dim 属性 + 显式深灰文字
  //（浅底上 dim 白字看不见，dim+深灰又会半亮发浅）
  (tree.status as { attributes?: number }).attributes = createTextAttributes(isLightTheme(theme) ? {} : { dim: true });
  tree.status.fg = parseColor(isLightTheme(theme) ? theme.contentDim : '#ffffff');
  // 实时同步输入框高度预算：多行输入框随内容自动增高（1-5 行），每次重绘
  // 按「逻辑行数 + 长行折行」估算当前可见行数（lineCount 不含折行，见
  // estimateInputLines 注释），computeRows 据此收缩内容区——灰色块永远完整可见。
  // 输入框实际宽度 = 视口 - 根内边距(2) - 蓝色细线(1) - 内容列左右 padding(2)
  if (tree.input) {
    const inner = Math.max(1, (width ?? 80) - CONTENT_PAD - 3);
    state.inputLines = Math.min(5, Math.max(1, estimateInputLines(tree.input.plainText, inner)));
  }

  // —— hero 模式（未开始对话，state.lines 为空）——
  // 底部输入区**垂直居中**（不再是钉在视口底部），输入区上方显示
  // 品牌头（Omni 单词标志 + tagline，彩虹色流动动画，bannerHue 驱动）。
  // 实现：根 justifyContent 改为 center、底部固定块去掉 marginTop:auto
  // （否则 auto 边距吸收全部自由空间、justifyContent 失效），横幅显示、状态栏隐藏
  // （「模型 X · 就绪」在居中 hero 布局下是冗余的——模型已在灰块内模型行展示）。
  // 菜单/命令输出面板打开时**保持 hero**（浮层按 heroOffset 钳制到居中灰块上缘，
  // 像联想下拉一样是输入区的上延——用户要求打开面板不得把输入区拉到底部）；
  // ask 打开时仍退出 hero（ask 面板是 bottomBlock 内的流式节点，按底部钉住布局渲染）；
  // 首条消息进入（lines 非空）后逐帧自动恢复到底部钉住布局。
  const hero =
    !!opts?.withInput &&
    state.lines.length === 0 &&
    !state.ask;
  let heroOffset = 0; // hero 模式下灰色块相对「底部钉住」位置上移的行数（浮层/命中区按此换算）
  if (hero && tree.omniTitle && tree.bottomBlock) {
    // 居中组（自上而下）：状态栏 marginTop(1)——hero 隐藏「就绪」后空文本高 0 但
    // margin 仍占 1 行（visible=false 不摘除布局节点，探针实测）+ 大号字标
    //（OMNI_BANNER = HERO_LINES 行）+ 间距(1) + 底部固定块[灰色块 inputLines+4 +
    // 任务清单 todoRows + 待发送区 pendingRows + ask 面板]。灰块外底行（metaRow，
    // margin 1 + 行 1）hero 下整行隐藏：visible=false 摘除内容行但 marginTop:1
    // 残留占 1 行（探针实测），故组高只计 margin 1 行——按全 2 行预算会让居中偏上。
    const inputLines = Math.max(1, state.inputLines);
    const askRows = state.ask ? state.ask.options.length + 5 : 0;
    const groupH = 1 + HERO_LINES + 1 + todoRows + pendingRows + delegateRows + askRows + (inputLines + 4) + 1;
    // 居中偏移 = 内容盒（视口 - 根 paddingY 2）剩余空间的一半，**round 而非 floor**：
    // yoga 对半行居中做四舍五入（floor 会在奇数剩余时把灰块算低 1 行 → 联想浮层
    // 与输入区之间漏出 1 行缝隙；40 例宽高矩阵探针实测，见 scripts/probe-tmp/dbg-hero-formula.ts）
    const groupTop = Math.max(1, 1 + Math.round(((height ?? 24) - 2 - groupH) / 2));
    // 灰色块顶 = 组顶 + 状态栏 margin(1) + 字标(HERO_LINES) + 间距(1)；底部钉住时的灰块顶 = height - 7 - pendingRows - todoRows - delegateRows - inputLines
    const grayTopCentered = groupTop + 1 + HERO_LINES + 1;
    const grayTopBottom = (height ?? 24) - 7 - pendingRows - todoRows - delegateRows - inputLines;
    heroOffset = Math.max(0, grayTopBottom - grayTopCentered);
    tree.root.justifyContent = 'center';
    tree.bottomBlock.marginTop = 0; // 去掉 auto：让根 justifyContent 平分上下空间
    tree.omniTitle.visible = true;
    // 彩虹流动（用户要求：按行错相渐变 + bannerHue 驱动，颜色沿字标竖向流动）。
    // 亮色主题压暗（浅底上高亮色对比不足）；深色主题提亮。每行一个实色 fg。
    const isLight = isLightTheme(theme);
    for (let i = 0; i < tree.omniCells.length; i++) {
      const hue = (state.bannerHue + i * 26) % 360;
      tree.omniCells[i]!.fg = parseColor(hslToHex(hue, 0.85, isLight ? 0.42 : 0.64));
    }
    (tree.status as { visible?: boolean }).visible = false; // hero 下隐藏「就绪」状态栏
    // 无对话（hero）时输入区宽度：用户要求可用宽的 0.75（不到满宽、留两侧白）。
    // **必须用显式 width 而非 maxWidth**：alignSelf:center 下容器宽 = 内容宽，flexGrow
    // 没有剩余空间可分 → maxWidth 设多大都不会撑开（实测盒子缩到内容宽）。显式 width
    // 给了确定宽度供 contentCol flexGrow 填满 + 居中。退出 hero 恢复（else 分支清 width）。
    // 待发送/任务清单面板（todo/queue）跟随灰块同宽居中——它们是灰块的上延面板，
    // 边角场景（/clear 后残留）下背景与灰块对齐，不会整行通铺。
    if (tree.footerBox) {
      const avail = Math.max(24, (width ?? 80) - CONTENT_PAD);
      const footerW = Math.max(32, Math.round(avail * 0.75));
      tree.footerBox.alignSelf = 'center';
      tree.footerBox.width = footerW;
      if (tree.delegateBox) {
        tree.delegateBox.alignSelf = 'center';
        tree.delegateBox.width = footerW;
      }
      if (tree.todoBox) {
        tree.todoBox.alignSelf = 'center';
        tree.todoBox.width = footerW;
      }
      if (tree.queueBox) {
        tree.queueBox.alignSelf = 'center';
        tree.queueBox.width = footerW;
      }
    }
    footerTop -= heroOffset; // 浮层/菜单/命令面板/ask 全部按居中后的灰块顶钳制
  } else {
    if (tree.omniTitle) tree.omniTitle.visible = false;
    if (tree.bottomBlock) tree.bottomBlock.marginTop = 'auto';
    tree.root.justifyContent = 'flex-start';
    // 恢复输入区域为整行宽 + 左对齐（normal 模式）——与 hero 版本互斥（清掉显式 width）
    if (tree.footerBox) {
      tree.footerBox.alignSelf = 'stretch';
      tree.footerBox.width = 'auto';
    }
    if (tree.delegateBox) {
      tree.delegateBox.alignSelf = 'stretch';
      tree.delegateBox.width = 'auto';
    }
    if (tree.todoBox) {
      tree.todoBox.alignSelf = 'stretch';
      tree.todoBox.width = 'auto';
    }
    if (tree.queueBox) {
      tree.queueBox.alignSelf = 'stretch';
      tree.queueBox.width = 'auto';
    }
  }
  // 蓝色细线：按最新 inputLines 同步——内容 = 圆角边框 2 + 内部（输入 + 间距 1 + 模型）
  // = inputLines + 4 行；显式 height 钉到 inputLines + 4，marginTop/Bottom -1 使
  // **margin-box = inputLines + 2 与内容列同高（不撑大灰层）**，渲染起点上移 1 行
  // 盖住顶边框行、向下溢到底边框行——**竖跨整个灰色背景含上下圆角边框行**（用户要求）。
  // 颜色按主题（fg 蓝 / bg 与灰块同色）
  if (tree.blueLine) {
    tree.blueLine.height = Math.max(1, state.inputLines) + 4;
    tree.blueLine.content = Array(Math.max(1, state.inputLines) + 4).fill(ACCENT_BAR).join('\n');
    tree.blueLine.fg = parseColor(theme.accentBlue);
    tree.blueLine.bg = parseColor(theme.footerBg);
  }
  // 命令联想列表（非模态）：paint 时按输入框**最新**文本刷新——联想不拦截输入，
  // 用户可继续打字（列表按新前缀过滤，无匹配自动隐藏）；↑/↓ 高亮、Tab 填入、
  // Enter 直接执行高亮命令、Esc 关闭、鼠标点击某项填入（见 interactive.ts 与
  // startTui 的鼠标 handler）。必须在下方联想浮层渲染块之前刷新（它读 state.cmdSuggest；
  // 联想是独立浮层，不参与内容区预算）。
  if (tree.input && opts?.withInput) {
    state.inputText = tree.input.plainText;
    // 面板是圆角方框（内部行 + 上下边框 2）：底部边框距灰色块 ≥1 行、顶部 ≥1 行
    // → 最大内部行数 ≤ footerTop - 3（footerTop = 视口 - 根底内边距(1) - 任务清单(todoRows) - 待发送区(pendingRows) - delegate 面板(delegateRows) - 灰色块(inputLines+4，含圆角边框)）
    footerTop = (height ?? 24) - 7 - pendingRows - todoRows - delegateRows - state.inputLines - heroOffset; // 灰色块顶部（0-based 屏幕行）；hero 居中模式再减 heroOffset
    if (!state.menu && state.inputText.startsWith('/')) {
      // 用户按 Esc 关闭过联想且文本未变 → 保持隐藏（否则 repaintTree 每次
      // 按 inputText 重新生成列表，Esc 就失效了——review 抓到的 bug）
      if (state.cmdSuggestDismissedText === state.inputText) {
        state.cmdSuggest = null;
      } else {
        if (state.cmdSuggestDismissedText !== null) state.cmdSuggestDismissedText = null; // 文本已变 → 恢复联想
        const query = state.inputText.slice(1);
        const names = commandSuggestions(query).map((c) => c.name);
        // 不再截断 items（↑/↓ 可滚动到全部）：窗口 + 提示行在渲染层按 top/window 计算
        const cur = state.cmdSuggest;
        let next: CmdSuggestion | null;
        // 命中集合未变（如 /t → /th 都只剩 theme）→ 保留高亮/滚动位置；变了才重置
        if (cur && cur.items.length === names.length && cur.items.every((n, i) => n === names[i])) {
          cur.query = query;
          next = cur;
        } else {
          next = { query, items: names, top: 0, selected: 0, window: 0 };
        }
        if (next.items.length === 0) next = null; // 无匹配自动隐藏（互不影响输入）
        state.cmdSuggest = next;
      }
      state.mention = null; // / 命令文本不显示 @ 提及
    } else {
      state.cmdSuggest = null;
      // @ 提及：光标前最后一个 @ 后的文本作查询，列出当前目录候选（非 / 命令文本时）。
      // 与命令联想同机制：Esc 关闭后同文本保持隐藏；命中集合未变保留高亮。
      const cursor =
        typeof (tree.input as unknown as { cursorOffset?: unknown }).cursorOffset === 'number'
          ? (tree.input as unknown as { cursorOffset: number }).cursorOffset
          : state.inputText.length;
      const m = state.menu ? null : detectMention(state.inputText, cursor);
      if (m) {
        const key = `${m.atIndex}:${m.query}`;
        if (state.mentionDismissedKey === key) {
          state.mention = null; // Esc 关闭过且文本未变 → 保持隐藏
        } else {
          if (state.mentionDismissedKey !== null) state.mentionDismissedKey = null; // 文本已变 → 恢复提及
          const items = listMentionCandidates(state.cwd, m.query);
          // 不再截断 items（↑/↓ 可滚动到全部）：窗口 + 提示行在渲染层按 top/window 计算
          const cur = state.mention;
          let next: MentionSuggestion | null;
          // 同一 @ 位置且命中集合未变（如 @s → @sr 都只剩 src/）→ 保留高亮/滚动位置
          if (cur && cur.atIndex === m.atIndex && cur.items.length === items.length && cur.items.every((p, i) => p === items[i])) {
            cur.query = m.query;
            next = cur;
          } else {
            next = { query: m.query, atIndex: m.atIndex, items, top: 0, selected: 0, window: 0 };
          }
          if (next.items.length === 0) next = null; // 无候选自动隐藏（互不影响输入）
          state.mention = next;
        }
      } else {
        state.mention = null;
        if (!state.menu) state.mentionDismissedKey = null; // 提及结束（文本变化）→ 清空 Esc 记录
      }
    }
  }
  // 灰块外底行：左[文件夹全路径] …… 右[输入/输出 · 缓存 · 上下文用量]（左右与输入区对齐）
  // 左侧：全路径、无图标（loading 已移入模型行速率右侧，回答中也保持显示）；窄屏放不下
  // 全路径时退化为当前文件夹名（basename），再放不下头部截断。
  // 右侧：输入/输出 · 缓存（从模型行移入，dim 色）+ 上下文用量（迷你条 + 用量）。
  // 注意：宽度按本地字符串计算——TextRenderable.content 读回的不是 string。
  // hero（无对话 / /clear 后回到初始居中态）下整行隐藏（mount 已初始 visible=false，
  // 这里每帧按是否有对话刷新；有对话后恢复显示）。
  if (tree.metaRow) tree.metaRow.visible = state.lines.length > 0;
  const loadingNow = state.loading && state.loadingIndex >= 0;
  const en = state.language === 'en';
  const lastPrompt = state.lastPromptTokens || 0;
  const contextLimit = state.contextLimit || 0;
  const ctxUsage = formatContextUsage(lastPrompt, contextLimit);
  const ctxText = ctxUsage ? `${formatMiniBar(contextPercent(lastPrompt, contextLimit))} ${ctxUsage}` : '';
  const folderFull = `${state.cwd}${state.gitBranch ? ` (${state.gitBranch})` : ''}`;
  // 右侧段文本（空串 = 隐藏）：输入/输出 / 缓存（无缓存数据不显示）
  const hasIO = state.tokens.prompt > 0 || state.tokens.completion > 0;
  const ioText = hasIO
    ? (en
      ? `In ${formatCompact(state.tokens.prompt)} · Out ${formatCompact(state.tokens.completion)}`
      : `输入 ${formatCompact(state.tokens.prompt)} · 输出 ${formatCompact(state.tokens.completion)}`)
    : '';
  const cachePct = state.tokens.prompt > 0 ? Math.min(100, Math.round((state.stats.cached / state.tokens.prompt) * 100)) : 0;
  const cacheText = state.stats.cached > 0 ? (en ? `Cache ${cachePct}%` : `缓存 ${cachePct}%`) : '';
  // 宽度预算：左侧可用 = 行宽 - 根边距(2) - 行 margin(4) - 右侧段；文件夹最小 8 列，
  // 仍溢出时按 缓存→输入输出 顺序隐藏（上下文恒保留）
  const wCtx = ctxText ? visualWidth(ctxText) : 0;
  const wIO = visualWidth(ioText);
  const wCache = visualWidth(cacheText);
  let showIO = ioText !== '';
  let showCache = cacheText !== '';
  let rightW = (showIO ? wIO + 1 : 0) + (showCache ? wCache + 1 : 0) + (ctxText ? wCtx + 1 : 0);
  while ((showCache || showIO) && (width ?? 80) - 6 - rightW < 8) {
    if (showCache) { showCache = false; rightW -= wCache + 1; }
    else { showIO = false; rightW -= wIO + 1; }
  }
  const leftAvail = Math.max(8, (width ?? 80) - 6 - rightW);
  // 窄屏退化（用户要求）：全路径放不下时只显示当前文件夹名（basename + 分支）——
  // 头部截断的 `…/a/b/cd` 信息量低；basename 也放不下再头部截断
  const folderName = state.cwd.split('/').filter(Boolean).pop() ?? state.cwd;
  const folderBase = `${folderName}${state.gitBranch ? ` (${state.gitBranch})` : ''}`;
  const leftText =
    visualWidth(folderFull) <= leftAvail ? folderFull
    : visualWidth(folderBase) <= leftAvail ? folderBase
    : truncatePathHead(folderBase, leftAvail);
  if (tree.metaLeft) {
    tree.metaLeft.content = leftText;
    tree.metaLeft.fg = parseColor(theme.footerDim);
  }
  if (tree.footerIO) {
    tree.footerIO.content = ioText;
    tree.footerIO.visible = showIO;
  }
  if (tree.footerCache) {
    tree.footerCache.content = cacheText;
    tree.footerCache.visible = showCache;
  }
  if (tree.metaCtx) {
    tree.metaCtx.content = ctxText;
    tree.metaCtx.visible = ctxText !== '';
    if (ctxText !== '') {
      const pct = contextPercent(lastPrompt, contextLimit);
      const light = isLightTheme(theme);
      let color = theme.footerDim;
      if (pct >= 90) color = light ? '#dc2626' : '#f87171';
      else if (pct >= 70) color = light ? '#d97706' : '#fbbf24';
      tree.metaCtx.fg = parseColor(color);
    }
  }
  // 模型行（输入框下方，灰色块内）：模式/模型/级别/均值 + loading/esc 打断提示
  //（会话进行中显示在速率右侧，`· ⠹ esc interrupt`——`·` 分隔符仅 loading 时显示）
  const modeText = `${t(state.language, state.planMode ? 'footer.mode.plan' : 'footer.mode.build')} ·`;
  const modelText = `${state.model}${state.provider ? ` ${state.provider}` : ''}`;
  const effortText = state.reasoningEffort ? tf(state.language, 'footer.effort', { effort: state.reasoningEffort }) : '';
  if (tree.footerModel && tree.footerMode) {
    // 模式前缀按模式着色（Build 青 / Plan 洋红，避开思考级别色阶）
    tree.footerMode.content = modeText;
    tree.footerMode.fg = parseColor(state.planMode ? themeFor(state).modePlan : themeFor(state).modeBuild);
    tree.footerModel.content = modelText;
  }
  if (tree.footerEffort) {
    tree.footerEffort.content = effortText;
    tree.footerEffort.visible = effortText !== ''; // 空级别不占位（免得模型名后多出双空格 gap）
  }
  // 均值段文本（空串 = 隐藏）
  const avg = sessionAvgRate(state.stats, state.tokens, state.liveTokens > 0 || state.liveGenMs > 0
    ? { streamTokens: state.liveTokens, liveGenMs: state.liveGenMs }
    : null);
  const avgText = avg > 0 ? `· ${avg} tok/s` : '';
  // loading 段：`· ⠹ esc interrupt`（spinner 帧 accentBlue，其余 dim；整段仅会话进行中显示）
  const loadHint = t(state.language, 'footer.escInterrupt');
  const loadSpinner = SPINNER_FRAMES[Math.max(0, state.loadingIndex) % SPINNER_FRAMES.length];
  const loadText = `· ${loadSpinner} ${loadHint}`;
  // 宽度预算：灰块内容列可用 ≈ 视口 - 根内边距(2) - 蓝线(1) - 内容列 padding(2) - 余量(1)；
  // 模型恒保留，超宽时按 均值→loading 顺序从右向左逐个隐藏
  const avail = Math.max(20, (width ?? 80) - 6);
  const wBase = visualWidth(modeText) + visualWidth(modelText) + visualWidth(effortText) + 3;
  const wAvg = visualWidth(avgText);
  const wLoad = visualWidth(loadText);
  let showAvg = avgText !== '';
  let showLoad = loadingNow;
  while ((showAvg || showLoad) && wBase + (showAvg ? wAvg + 1 : 0) + (showLoad ? wLoad + 1 : 0) > avail) {
    if (showAvg) showAvg = false;
    else showLoad = false;
  }
  if (tree.footerAvg) {
    tree.footerAvg.content = avgText;
    tree.footerAvg.visible = showAvg;
  }
  if (tree.footerLoad) {
    if (showLoad) {
      try {
        tree.footerLoad.content = new StyledText([
          { __isChunk: true as const, text: '· ', fg: parseColor(theme.footerDim), attributes: 0 },
          { __isChunk: true as const, text: loadSpinner, fg: parseColor(theme.accentBlue), attributes: 0 },
          { __isChunk: true as const, text: ` ${loadHint}`, fg: parseColor(theme.footerDim), attributes: 0 },
        ]);
      } catch (e) {
        logCrash('footer-load', e);
      }
      tree.footerLoad.visible = true;
    } else {
      tree.footerLoad.content = '';
      tree.footerLoad.visible = false;
    }
  }
  // 待发送消息区（输入框上方小视图）：每条一行「N queued · 文本」（对标 Claude Code
  // queued 样式——用户要求；queue=排队/steer=打断，i18n pending.item/pending.steerItem），
  // 选中行 `›` 前缀高亮。空列表隐藏（不占布局）；行数预算 = pendingRows（computeRows/
  // footerTop 同步减）。可点击：消息行 y → pending 下标存 pendingRects（点击**直接编辑**，
  // 见 startTui）——消息行位于灰色块正上方（todoRows 之下）。
  if (tree.queueBox) {
    tree.queueBox.visible = pendingCount > 0;
    // 主题切换（/theme）每帧跟随（与灰块/联想浮层同底）
    tree.queueBox.backgroundColor = theme.footerBg;
    tree.pendingRects.clear();
    let idx = 0;
    if (pendingCount > 0) {
      const lang = state.language;
      // command 面板同款左侧深灰竖线 ▍（同联想/命令面板 barChunk：bg 与面板同色）
      const barChunk = { __isChunk: true as const, text: ACCENT_BAR, fg: parseColor(theme.suggestBorder), bg: parseColor(theme.footerBg), attributes: 0 };
      for (let i = 0; i < pendingVisibleMsgs; i++) {
        const m = state.pending[i]!;
        const t = m.text.replace(/\s+/g, ' ').trim();
        const selected = i === state.pendingSelected;
        const label = tf(lang, m.mode === 'steer' ? 'pending.steerItem' : 'pending.item', { n: i + 1 });
        const body = t.length > 38 ? `${t.slice(0, 37)}…` : t;
        const cell = tree.queueCells[idx++]!;
        cell.visible = true;
        const lineFg = parseColor(selected ? theme.accentBlue : theme.footerText);
        try {
          // 行 = 竖线 ▍ + 1 空格 + 选中标记/序号 + 文本（透明处露出面板 footerBg 底；
          // 文本起始与输入区文字同列——灰块内是 蓝线1 + padding 1）
          cell.content = new StyledText([
            barChunk,
            { __isChunk: true as const, text: ` ${selected ? '›' : ' '} ${label}`, fg: lineFg, attributes: TextAttributes.BOLD },
            { __isChunk: true as const, text: ` · ${body}`, fg: lineFg, attributes: selected ? TextAttributes.BOLD : 0 },
          ]);
        } catch (e) {
          logCrash('pending-row', e);
        }
      }
      if (pendingCount > 4) {
        const c2 = tree.queueCells[idx++]!;
        c2.visible = true;
        c2.content = new StyledText([
          barChunk,
          { __isChunk: true as const, text: ` ${tf(state.language, 'pending.more', { n: pendingCount - 4 })}`, fg: parseColor(theme.footerDim), attributes: TextAttributes.DIM },
        ]);
      }
    }
    // 未用的池细胞必须隐藏——否则仍占布局行（7 个细胞占 7 行而非 5 行），
    // 总高度超出视口后 yoga 压缩灰色块/待发送区，出现行重叠与内容被裁（探针实测）
    for (; idx < tree.queueCells.length; idx++) {
      tree.queueCells[idx]!.content = '';
      tree.queueCells[idx]!.visible = false;
    }
  }
  // 运行中 delegate 面板（输入区上方 command 样式面板）：每条 delegate 一行
  // `→ 子代理 · 摘要`（点击展开/收起）；展开态在其下显示明细（💭 思考 / → 工具 /
  // ✓·✗ 结果，最多 10 条 + 省略提示）与 `⏹ 停止`（运行中）/`⏹ 已停止`（已停止）。
  // 行数预算 = delegateRows（delegatePanelRows——computeRows/footerTop 同步减）。
  // 点击命中：标题行 y → toggle（run 下标）；停止行 y → stop（render.ts 鼠标 handler）。
  if (tree.delegateBox) {
    tree.delegateBox.visible = state.delegateRuns.length > 0;
    tree.delegateBox.backgroundColor = theme.footerBg; // 主题切换每帧跟随
    tree.delegateRects.clear();
    let idx = 0;
    // 面板行内容宽 = 视口 - 根 paddingX(2)（bottomBlock stretch 全宽；行文本单行截断）
    const panelW = Math.max(20, (width ?? 80) - CONTENT_PAD);
    const barChunk = { __isChunk: true as const, text: ACCENT_BAR, fg: parseColor(theme.suggestBorder), bg: parseColor(theme.footerBg), attributes: 0 };
    for (let ri = 0; ri < state.delegateRuns.length; ri++) {
      const run = state.delegateRuns[ri]!;
      const cell = tree.delegateCells[idx++]!;
      cell.visible = true;
      // 标题行：`→ 子代理 · 摘要` + 状态（运行中 spinner 由全局 loading 帧驱动？——面板行保持静态文本）
      const statusFg = run.stopped ? theme.diffRem : run.stopRequested ? theme.footerDim : theme.accentBlue;
      const mark = run.expanded ? '▾' : '▸';
      try {
        const titleBody = fitAsk(run.title, Math.max(10, panelW - 24));
        cell.content = new StyledText([
          barChunk,
          { __isChunk: true as const, text: ` ${mark} ${titleBody}`, fg: parseColor(theme.footerText), attributes: TextAttributes.BOLD },
          { __isChunk: true as const, text: ` · ${run.status}`, fg: parseColor(statusFg), attributes: run.stopRequested ? 0 : TextAttributes.BOLD },
        ]);
      } catch (e) {
        logCrash('delegate-title', e);
      }
      // 展开明细（与 delegatePanelRows 预算严格一致：明细 ≤10 条 + 省略 1 + 停止/状态 1）
      if (run.expanded) {
        const shown = Math.min(10, run.items.length);
        for (let i = run.items.length - shown; i < run.items.length; i++) {
          const it = run.items[i]!;
          const c2 = tree.delegateCells[idx++]!;
          c2.visible = true;
          try {
            if (it.kind === 'think') {
              const text = fitAsk(`💭 ${it.text}`, Math.max(8, panelW - 6));
              c2.content = new StyledText([
                barChunk,
                { __isChunk: true as const, text: `  ${text}`, fg: parseColor(theme.footerDim), attributes: 0 },
              ]);
            } else if (it.kind === 'tool') {
              const text = fitAsk(`→ ${it.text}`, Math.max(8, panelW - 6));
              c2.content = new StyledText([
                barChunk,
                { __isChunk: true as const, text: `  ${text}`, fg: parseColor(theme.footerText), attributes: TextAttributes.BOLD },
              ]);
            } else {
              const ok = it.ok !== false;
              const text = fitAsk(`${ok ? '✓' : '✗'} ${it.text}`, Math.max(8, panelW - 6));
              c2.content = new StyledText([
                barChunk,
                { __isChunk: true as const, text: `  ${text}`, fg: parseColor(ok ? theme.footerDim : theme.diffRem), attributes: 0 },
              ]);
            }
          } catch (e) {
            logCrash('delegate-item', e);
          }
        }
        if (run.items.length > shown || run.dropped > 0) {
          const c3 = tree.delegateCells[idx++]!;
          c3.visible = true;
          const lang = state.language;
          const extra = run.dropped > 0 ? tf(lang, 'delegate.extraTruncated', { n: run.dropped }) : '';
          const hidden = run.items.length - shown;
          c3.content = new StyledText([
            barChunk,
            { __isChunk: true as const, text: `  ${tf(lang, 'delegate.earlierHidden', { n: hidden })}${extra}`, fg: parseColor(theme.footerDim), attributes: 0 },
          ]);
        }
        // 停止/已停止行（role 语义经文本标识——点击命中按行文本「⏹」判定；统一在
        // delegateRects 登记 stop，鼠标 handler 按 stopRequested 防重复）
        const c4 = tree.delegateCells[idx++]!;
        c4.visible = true;
        const stoppedTxt = run.stopped || run.stopRequested ? t(state.language, 'delegate.stoppedBtn') : t(state.language, 'delegate.stopBtn');
        c4.content = new StyledText([
          barChunk,
          { __isChunk: true as const, text: `  ${stoppedTxt}`, fg: parseColor(theme.diffRem), attributes: TextAttributes.BOLD },
        ]);
      }
    }
    // 未用细胞隐藏（防占布局行——同 queue/todo 池语义）
    for (; idx < tree.delegateCells.length; idx++) {
      tree.delegateCells[idx]!.content = '';
      tree.delegateCells[idx]!.visible = false;
    }
    // 命中区登记：delegateBox 在 bottomBlock 内（ask 下 / todo 上）——整块钉在视口底。
    // 行序（自下而上）：footer(灰块) ← queue ← todo ← delegate ← ask；queue 首行
    // y = wrapperTop（与 pendingRects 同式），delegate 首行 = wrapperTop - todoRows
    // - delegateRows。逐 run 登记：折叠 1 行；展开时明细行不可点、停止行可点
    //（run 未停止/未请求停止时）。
    if (state.delegateRuns.length > 0 && opts?.withInput) {
      const wrapperTop = (height ?? 24) - 7 - pendingRows - todoRows - delegateRows - state.inputLines - heroOffset;
      let y = wrapperTop - todoRows - delegateRows;
      for (let ri = 0; ri < state.delegateRuns.length; ri++) {
        const run = state.delegateRuns[ri]!;
        tree.delegateRects.set(y, { run: ri, kind: 'toggle' });
        y += 1;
        if (run.expanded) {
          const shown = Math.min(10, run.items.length);
          y += shown;
          if (run.items.length > shown || run.dropped > 0) y += 1;
          if (!run.stopped && !run.stopRequested) tree.delegateRects.set(y, { run: ri, kind: 'stop' });
          y += 1;
        }
      }
    }
  }
  // 任务清单小视图（待发送区上方）：每条一行「✓/▸/· 内容」——完成 dim、进行中
  // accent 加粗、待办 dim；最多 4 条 + 超出「还有 N 项」提示。空清单隐藏。纯显示
  //（不参与点击——todo 状态由模型维护）。
  if (tree.todoBox) {
    tree.todoBox.visible = todoCount > 0;
    // 主题切换（/theme）每帧跟随（同 queue 面板底）
    tree.todoBox.backgroundColor = theme.footerBg;
    let idx = 0;
    if (todoCount > 0) {
      const barChunk = { __isChunk: true as const, text: ACCENT_BAR, fg: parseColor(theme.suggestBorder), bg: parseColor(theme.footerBg), attributes: 0 };
      for (let i = 0; i < Math.min(4, todoCount); i++) {
        const item = state.todoList[i]!;
        const done = item.status === 'completed';
        const active = item.status === 'in_progress';
        const mark = done ? '✓' : active ? '▸' : '·';
        const text = item.content.length > 50 ? `${item.content.slice(0, 49)}…` : item.content;
        const cell = tree.todoCells[idx++]!;
        cell.visible = true;
        try {
          // 行 = 竖线 ▍ + 1 空格 + 状态标记（同 queue 面板风格，竖线连续贯通）
          cell.content = new StyledText([
            barChunk,
            { __isChunk: true as const, text: ` ${mark} `, fg: parseColor(active ? theme.accentBlue : theme.footerDim), attributes: active ? TextAttributes.BOLD : 0 },
            { __isChunk: true as const, text, fg: parseColor(active ? theme.footerText : theme.footerDim), attributes: 0 },
          ]);
        } catch (e) {
          logCrash('todo-row', e);
        }
      }
      if (todoCount > 4) {
        const c2 = tree.todoCells[idx++]!;
        c2.visible = true;
        c2.content = new StyledText([
          barChunk,
          { __isChunk: true as const, text: ` ${tf(state.language, 'todo.more', { n: todoCount - 4 })}`, fg: parseColor(theme.footerDim), attributes: TextAttributes.DIM },
        ]);
      }
    }
    for (; idx < tree.todoCells.length; idx++) {
      tree.todoCells[idx]!.content = '';
      tree.todoCells[idx]!.visible = false;
    }
  }
  // 状态栏可见性：hero 模式（未开始对话）隐藏「就绪」状态，让居中 hero 布局干净；
  // 正常交互模式需 10 行（灰色块 + 灰块外底行 + 状态栏 + 内边距），不足时隐藏状态栏；
  // 单任务模式仅需 4 行——状态栏 2 + 内边距 2）
  tree.status.visible = hero ? false : opts?.withInput ? height >= 11 : height >= 4;
  tree.status.content = state.status;

  // 联想/提及浮层（输入区同款风格）：扁平无边框 + 输入区同底色 + 左侧深灰竖线 ▍ +
  // 与输入区同宽（像输入区的上延）+ 标题行（Commands/esc）+
  // 选项行（名称左 + 描述空格分隔）+ 上下「还有 N 个」提示行。选中行除竖线外整行桃色高亮（深字）。
  // items 全量匹配，窗口 = picker.window 行；↑/↓ 可滚动到全部。面板底部**贴住**灰色块
  //（间距 0）。选择/点击逻辑只认 items 下标（标题/提示行映射 -1，不可选中）。
  const sug = state.cmdSuggest;
  const men = state.mention;
  const picker = sug ?? men; // 二选一：/ 命令联想优先；@ 提及仅在非 / 文本时出现
  let suggestTotal = 0;
  if (tree.suggestBox) {
    tree.suggestBox.backgroundColor = theme.footerBg; // 输入区同底（主题切换跟随）
    const visible = !!picker && picker.items.length > 0;
    tree.suggestBox.visible = visible;
    // 行结构（与 rowMap 对齐）：pad（顶部留白，标题不贴面板顶边）| head | hint? | item* | hint?
    type SugRow =
      | { kind: 'pad' }
      | { kind: 'head' }
      | { kind: 'hint'; top: boolean; n: number }
      | { kind: 'item'; itemIdx: number };
    let builtRows: SugRow[] = [];
    if (visible && picker) {
      // 灰色块顶部（0-based 屏幕行）= 视口 - 根底内边距(1) - 灰色块(inputLines+4，含圆角边框) - 待发送区(pendingRows) - todo(delegateRows)；hero 居中模式再减 heroOffset
      const footerTop = (height ?? 24) - 7 - pendingRows - delegateRows - state.inputLines - heroOffset;
      // 紧凑下拉：内部行（含提示行）≤ 8（小视口按剩余空间收缩）——面板不铺满整个内容区，
      // 而是悬停在输入框上方的一小片下拉（用户反馈菜单铺满全屏不像“输入框上方的菜单”）
      const interiorBudget = Math.max(3, Math.min(8, footerTop - 3));
      // 窗口 = 内部行 - 预留 2 行提示位（↑/↓ 各一）；至少 1 行
      const win = Math.min(picker.items.length, Math.max(1, interiorBudget - 2));
      // 选中项收敛到合法范围（文本过滤变短时 selected 可能越界）
      if (picker.selected < 0 || picker.selected >= picker.items.length) picker.selected = 0;
      // 滚动位置收敛到合法区间（文本过滤变短时 top 可能越界）；且选中项必须在窗口内
      // ——交互层 ↑/↓ 已维护，这里兜底外部状态变更（用户反馈“超过一屏无法翻页”的回归防线）
      let top = Math.min(picker.top, Math.max(0, picker.items.length - win));
      if (picker.selected < top) top = picker.selected;
      else if (picker.selected >= top + win) top = Math.max(0, Math.min(picker.items.length - win, picker.selected - win + 1));
      picker.top = top;
      picker.window = win; // 交互层（↑/↓ 滚动）读它
      const above = top; // 窗口上方还有的项数
      const below = Math.max(0, picker.items.length - (top + win)); // 窗口下方还有的项数
      // 组装行：顶部留白 + 标题 + [↑ 提示?] + 选项* + [↓ 提示?]（无分组头，用户要求移除 section 组标题）
      const rows: SugRow[] = [{ kind: 'pad' }, { kind: 'head' }];
      if (above > 0) rows.push({ kind: 'hint', top: true, n: above });
      for (let k = top; k < top + win; k++) {
        rows.push({ kind: 'item', itemIdx: k });
      }
      if (below > 0) rows.push({ kind: 'hint', top: false, n: below });
      // 内部行 → items 下标映射（-1 = 标题/提示行，不可选中/点击）
      const rowMap: number[] = rows.map((r) => (r.kind === 'item' ? r.itemIdx : -1));
      tree.suggestRowMap = rowMap;
      suggestTotal = rows.length;
      // 行装配：标题 / 选项（名称左 + 描述**空格分隔**，不右对齐）/ 提示
      const vw = width ?? 80;
      const lang = state.language;
      type SugLine =
        | { kind: 'head' }
        | { kind: 'hint'; text: string }
        | { kind: 'item'; left: string; right: string; itemIdx: number; selected: boolean };
      const lines: SugLine[] = [];
      for (const r of rows) {
        if (r.kind === 'head') {
          lines.push(r);
          continue;
        }
        if (r.kind === 'pad') {
          // 顶部留白行：空文本（hint 分支渲染为竖线 + 整行底色空白）
          lines.push({ kind: 'hint', text: '' });
          continue;
        }
        if (r.kind === 'hint') {
          lines.push({ kind: 'hint', text: tf(lang, 'suggest.hint', { arrow: r.top ? '↑' : '↓', n: r.n }) });
          continue;
        }
        const k = r.itemIdx;
        const selected = k === picker.selected;
        if (men) {
          // 精简无图标（用户要求）：目录自带尾 `/` 区分，文件裸路径
          const label = `${picker.items[k]!}`;
          lines.push({ kind: 'item', left: label, right: '', itemIdx: k, selected });
          continue;
        }
        const cmd = findCommand(picker.items[k]!);
        // 描述不预截断（DESC_COLS 32 列是「面板自适应定宽」时代的遗留）——渲染层按行
        // 剩余宽截断（truncTo line.right），面板全宽/hero 0.75 宽下简介可读到完整
        const desc = lang === 'en' && cmd?.descriptionEn ? cmd.descriptionEn : cmd?.description ?? '';
        lines.push({ kind: 'item', left: `/${picker.items[k]}`, right: desc, itemIdx: k, selected });
      }
      const headTitle = t(lang, men ? 'suggest.filesTitle' : 'suggest.commandsTitle');
      // 与输入区同宽同左：正常模式 footer 撑满（视口 - 根 padding 2）；hero 居中模式
      // footer 为可用宽 0.75 居中（mountTree hero 分支同公式）——下拉像输入区的上延。
      const availW = Math.max(24, vw - CONTENT_PAD);
      const heroFooter = hero && !!tree.footerBox;
      const footerW = heroFooter ? Math.max(32, Math.round(availW * 0.75)) : Math.max(16, vw - CONTENT_PAD);
      tree.suggestBox.width = footerW;
      // hero 水平居中与 yoga 同式：内容盒左 1 + round(剩余/2)（floor 半列差 1 → 与输入区错开）
      tree.suggestBox.left = heroFooter ? Math.max(1, 1 + Math.round((vw - 2 - footerW) / 2)) : 1;
      // 无边框 → 末行**贴住灰色块**（间距 0），顶部 ≥0
      tree.suggestBox.top = Math.max(0, footerTop - suggestTotal);
      // 可点击区域 = 面板全部行：行 i → 事件坐标 y = top + i
      tree.suggestRect = { top: tree.suggestBox.top, bottom: tree.suggestBox.top + suggestTotal - 1 };
      const padTo = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - visualWidth(s)));
      const truncTo = (s: string, w: number): string => {
        if (w < 2 || visualWidth(s) <= w) return s;
        const cut = fitCount(s, w - 1);
        return `${s.slice(0, Math.max(0, cut))}…`;
      };
      // 行宽恒为 footerW：首列深灰 ▍（同输入区蓝线写法，颜色换深灰）+ 1 列空格 + 内容铺满
      const barFg = parseColor(theme.suggestBorder);
      const barBg = parseColor(theme.footerBg);
      const restW = Math.max(8, footerW - 1); // ▍ 之后的内容列（空格 + 文本 + 填充）
      const barChunk = { __isChunk: true as const, text: ACCENT_BAR, fg: barFg, bg: barBg, attributes: 0 };
      for (let i = 0; i < tree.suggestCells.length; i++) {
        const cell = tree.suggestCells[i];
        const line = lines[i];
        if (!picker || !line) {
          cell.visible = false;
          continue;
        }
        cell.visible = true;
        try {
          if (line.kind === 'head') {
            // 标题左 + esc 右对齐（铺满整宽）
            const title = truncTo(headTitle, restW - 1 - 3);
            const headPad = padTo(title, restW - 1 - 3);
            cell.content = new StyledText([
              barChunk,
              { __isChunk: true as const, text: ` ${headPad}`, fg: parseColor(theme.suggestText), bg: barBg, attributes: TextAttributes.BOLD },
              { __isChunk: true as const, text: 'esc', fg: parseColor(theme.footerDim), bg: barBg, attributes: 0 },
            ]);
          } else if (line.kind === 'hint') {
            // 提示行：dim，不可选中/点击
            const body = truncTo(line.text, restW - 1);
            cell.content = new StyledText([
              barChunk,
              { __isChunk: true as const, text: ` ${padTo(body, restW - 1)}`, fg: parseColor(theme.suggestText), bg: barBg, attributes: TextAttributes.DIM },
            ]);
          } else {
            // 选项行：名称左（选中除竖线外整行桃底深字）+ 描述**空格分隔、不右对齐**
            // （用户要求：右侧文本和左侧命令用空格分割即可，不做列对齐）
            const selected = line.selected;
            const left = truncTo(line.left, Math.max(4, restW - 5));
            const rightAvail = Math.max(0, restW - 3 - visualWidth(left));
            const right = rightAvail >= 2 ? truncTo(line.right, rightAvail) : '';
            const body = ` ${left}  ${right}`;
            // 补齐到 restW（与标题/提示行同式铺满整行；旧式 restW-1-body 使短简介行差 1 列不满宽）
            const trail = ' '.repeat(Math.max(0, restW - visualWidth(body)));
            if (selected) {
              cell.content = new StyledText([
                barChunk,
                { __isChunk: true as const, text: `${body}${trail}`, fg: parseColor(theme.suggestSelFg), bg: parseColor(theme.suggestSelBg), attributes: 0 },
              ]);
            } else {
              cell.content = new StyledText([
                barChunk,
                { __isChunk: true as const, text: ` ${left}  `, fg: parseColor(theme.suggestText), bg: barBg, attributes: 0 },
                { __isChunk: true as const, text: `${right}${trail}`, fg: parseColor(theme.suggestText), bg: barBg, attributes: TextAttributes.DIM },
              ]);
            }
          }
        } catch (e) {
          logCrash('suggest-row', e);
        }
      }
      } else {
        tree.suggestRect = null;
        tree.suggestRowMap = [];
      }
    }

  // 命令面板浮层（/theme alert 等）：
  // 绝对定位、水平垂直居中、zIndex 高于内容；每帧按视口重算位置，行内容原地更新
  // （细胞池复用，不重建 TextRenderable）。
  if (tree.menuOverlay) {
    tree.menuOverlay.backgroundColor = theme.footerBg; // 输入区同底（主题切换跟随），不透明浮于对话流之上
    const menu = state.menu;
    if (!menu) {
      tree.menuOverlay.visible = false;
      tree.menuRowMap = [];
    } else {
      // 与输入区同宽同左、底边贴住灰色块（footerTop = 灰块顶，hero 居中模式按 heroOffset
      // 钳到居中灰块上缘）——像联想下拉一样是输入区的上延（用户要求：不居中显示、
      // 打开面板不得把输入区拉到底部）；超高时 menuMaxVisible 内部滚动
      const vwMenu = width ?? 80;
      const heroFooter = hero && !!tree.footerBox;
      const footerW = heroFooter
        ? Math.max(32, Math.round(Math.max(24, vwMenu - CONTENT_PAD) * 0.75))
        : Math.max(16, vwMenu - CONTENT_PAD);
      const panelW = Math.max(12, footerW - 1); // 卡片宽 = 输入区宽 - 左侧竖线 1 列
      // 窗口滚动预算：留白 1 + 标题 1 + 窗口 + 上下提示 ≤2 + 操作提示 1 ≤ footerTop - 1
      //（顶 ≥1、底贴灰块）→ 窗口 ≤ footerTop - 6；不滚动时更宽松
      const menuMaxVisible = Math.max(2, Math.min(12, footerTop - 6));
      const panelRows = menuPanelRows(menu, panelW, state.language, menuMaxVisible);
      tree.menuOverlay.visible = true;
      tree.menuOverlay.top = Math.max(1, footerTop - panelRows.length);
      tree.menuOverlay.left = heroFooter ? Math.max(1, 1 + Math.round((vwMenu - 2 - footerW) / 2)) : 1;
      tree.menuOverlay.width = panelW + 1; // 显式宽度（竖线 1 列 + 卡片 panelW）= 输入区同宽
      // 左侧深灰竖线：按面板行数同步（同输入区蓝线按 inputLines 同步）
      if (tree.menuBar) {
        tree.menuBar.height = panelRows.length;
        tree.menuBar.content = Array(panelRows.length).fill(ACCENT_BAR).join('\n');
        tree.menuBar.fg = parseColor(theme.suggestBorder);
        tree.menuBar.bg = parseColor(theme.footerBg);
      }
      // 菜单行 → 选项下标映射（点击命中用；标题 0 / 提示 / 底边 = -1）：
      // 直接取每行自带的 menuIdx（窗口滚动后行与下标不再连续，逐行标记最稳）；
      // 事件坐标 y = overlay.top + 1 + i（与联想浮层 suggestRect 同一坐标系：浮层顶边框占 1 行）
      const rowMap: number[] = [];
      for (const r of panelRows) rowMap.push(r.menuIdx ?? -1);
      tree.menuRowMap = rowMap;
      for (let i = 0; i < tree.menuCells.length; i++) {
        const cell = tree.menuCells[i];
        if (i >= panelRows.length) {
          cell.visible = false;
          continue;
        }
        cell.visible = true;
        try {
          applyRowToCell(cell, panelRows[i], theme);
        } catch (e) {
          logCrash('menu-row', e);
        }
      }
    }
  }

  // 命令输出面板浮层（所有 / 命令的独立窗口）：绝对定位、水平垂直居中；
  // 行内容原地更新（细胞池复用）。超高时 cmdPanelRows 折行 + 垂直滚动。
  if (tree.cmdPanelOverlay) {
    tree.cmdPanelOverlay.backgroundColor = theme.footerBg; // 输入区同底（主题切换跟随），不透明浮于对话流之上
    const panel = state.cmdPanel;
    if (!panel) {
      tree.cmdPanelOverlay.visible = false;
    } else {
      // 与输入区同宽同左、底边贴住灰色块（同菜单浮层；hero 居中模式保持 hero 不拉底）
      const vwPanel = width ?? 80;
      const heroFooter = hero && !!tree.footerBox;
      const footerW = heroFooter
        ? Math.max(32, Math.round(Math.max(24, vwPanel - CONTENT_PAD) * 0.75))
        : Math.max(16, vwPanel - CONTENT_PAD);
      const panelW = Math.max(12, footerW - 1); // 卡片宽 = 输入区宽 - 左侧竖线 1 列
      const panelRows = cmdPanelRows(panel, panelW, footerTop, state.language);
      tree.cmdPanelOverlay.visible = true;
      tree.cmdPanelOverlay.top = Math.max(1, footerTop - panelRows.length);
      tree.cmdPanelOverlay.left = heroFooter ? Math.max(1, 1 + Math.round((vwPanel - 2 - footerW) / 2)) : 1;
      tree.cmdPanelOverlay.width = panelW + 1; // 显式宽度（竖线 1 列 + 卡片 panelW）= 输入区同宽
      // 左侧深灰竖线：按面板行数同步
      if (tree.cmdPanelBar) {
        tree.cmdPanelBar.height = panelRows.length;
        tree.cmdPanelBar.content = Array(panelRows.length).fill(ACCENT_BAR).join('\n');
        tree.cmdPanelBar.fg = parseColor(theme.suggestBorder);
        tree.cmdPanelBar.bg = parseColor(theme.footerBg);
      }
      for (let i = 0; i < tree.cmdPanelCells.length; i++) {
        const cell = tree.cmdPanelCells[i];
        if (i >= panelRows.length) {
          cell.visible = false;
          continue;
        }
        cell.visible = true;
        try {
          applyRowToCell(cell, panelRows[i], theme);
        } catch (e) {
          logCrash('cmdpanel-row', e);
        }
      }
    }
  }

  // 轨迹面板（/trace 右侧栏）：绝对定位右缘浮层（top=1），逐行往下渲染，
  // 底边不超出视口太多（灰块在左下角，右侧面板无需避让它——灰块不遮面板行）。
  // 预算 = 视口高 - 8（留若干行给底部灰块 + 统计行 + 内边距）。hero 居中模式下
  // footerTop 较小（灰块上移），但面板高度不受影响——用全视口而非 footerTop 计算。
  // 展开时对话流宽度收缩在 computeRows（读 state.traceOpen）——内容右移重新折行，
  // 面板不盖内容。行级命中：内部行 i → 事件坐标 y = top + 1 + i（border 1 行）；
  // rowMap 记录 行 → traceRows 绝对下标（-1 = 标题/提示行，-2 = 详情页返回行）。
  // **两级页面**：列表页（traceDetail 为 null）点击行推入详情页；详情页
  //（traceDetail 非空）显示返回行 + 完整内容（点击返回行/Esc 回列表）。
  if (tree.traceBox) {
    const tOpen = state.traceOpen;
    tree.traceBox.visible = tOpen;
    if (tOpen && (height ?? 24) > 9) {
      tree.traceBox.backgroundColor = theme.suggestBg; // 主题可能切换（/theme 或检测晚到）
      tree.traceBox.borderColor = parseColor(theme.suggestBorder);
      const maxRows = Math.max(3, (height ?? 24) - 7);
      // 详情页（点击轨迹行推入）：返回行 + 行标题 + 完整内容（折行不截断）；
      // 内容超预算时窗口滚动（复用 traceScroll，底部对齐 + 顶部提示）
      const detail = state.traceDetail;
      let lines: ReturnType<typeof tracePanelLines>['lines'];
      let rowMap: ReturnType<typeof tracePanelLines>['rowMap'];
      if (detail) {
        const all = traceDetailLines(state, detail.rowIdx, TRACE_TEXT_COLS);
        const contentRows = Math.max(1, maxRows - 1); // 顶部提示位（滚动时）
        const maxScroll = Math.max(0, all.lines.length - contentRows);
        const scroll = Math.min(Math.max(0, state.traceScroll), maxScroll);
        const end = all.lines.length - scroll;
        const start = Math.max(0, end - contentRows);
        lines = [];
        rowMap = [];
        if (start > 0) {
          lines.push({ text: tf(state.language, 'trace.scrollUp', { n: start }), style: { dim: true } });
          rowMap.push(-1);
        }
        for (let i = start; i < end; i++) {
          lines.push(all.lines[i]);
          rowMap.push(all.rowMap[i]);
        }
      } else {
        ({ lines, rowMap } = tracePanelLines(state, footerTop, maxRows));
      }
      const panelRows = Math.min(lines.length, maxRows);
      tree.traceBox.top = 1;
      tree.traceBox.left = Math.max(1, (width ?? 80) - TRACE_W - 1); // 右缘贴内容区右边界（root paddingX 1）
      tree.traceLeft = Math.max(1, (width ?? 80) - TRACE_W - 1); // 面板边框盒起始列（屏幕 0-based 事件坐标）
      for (let i = 0; i < tree.traceCells.length; i++) {
        const cell = tree.traceCells[i];
        if (i >= panelRows) {
          cell.visible = false;
          continue;
        }
        cell.visible = true;
        try {
          const l = lines[i];
          applyRowToCell(cell, { text: l.text, style: l.style }, theme);
        } catch (e) {
          logCrash('trace-row', e);
        }
      }
      tree.traceRect = { top: tree.traceBox.top + 1, bottom: tree.traceBox.top + panelRows };
      tree.traceRowMap = rowMap.slice(0, panelRows);
    } else {
      tree.traceRect = null;
      tree.traceRowMap = [];
    }
  }

  // 右上角 toast（Alert notification）：短暂显示自动消失，不占对话流、不阻塞输入。
  // 绝对定位右上角（top=1、右缘=1）；宽度按文本显示宽重算（clamp 到视口内，长文截断）；
  // 类型着色：success 绿 / error 红 / info 默认；主题切换（/theme 或检测晚到）底色跟随刷新。
  if (tree.toastBox && tree.toastCell) {
    const toast = state.toast;
    if (!toast || Date.now() >= toast.expiresAt) {
      if (toast) state.toast = null; // 过期：repaintTree 兜底清除（pushToast 定时器也会清）
      tree.toastBox.visible = false;
    } else {
      tree.toastBox.backgroundColor = theme.suggestBg;
      tree.toastBox.borderColor = parseColor(theme.suggestBorder);
      // 内容 = 类型图标 + 文本（文本已带 ✓/✕ 前缀则不再叠加——拖选复制 pushToast 的
      // 文案自带「✓ 已复制」；命令/错误提示不带则这里补图标）；按显示宽算浮层宽（paddingX 2 + 边框 2）
      const hasIcon = /^[✓✕]\s/.test(toast.text);
      const icon = !hasIcon ? (toast.type === 'success' ? '✓ ' : toast.type === 'error' ? '✕ ' : '') : '';
      const full = icon + toast.text;
      const avail = Math.max(8, (width ?? 80) - 4); // 视口 - 右缘 1 - 根 padding 1 - 边框余量
      const textW = visualWidth(full);
      const w = Math.min(textW, avail);
      const shown = textW > avail ? full.slice(0, Math.max(0, fitCount(full, avail - 1))) + '…' : full;
      // 浮层宽度由内容自适应（同 traceBox：OpenTUI 由子文本决定宽，显式 width 会压缩内部）
      tree.toastBox.top = 1;
      tree.toastBox.left = Math.max(1, (width ?? 80) - (w + 2) - 1); // 右缘贴视口右边界
      tree.toastCell.visible = true;
      tree.toastCell.content = shown;
      // 成功用 diffAdd 绿（✓ 语义色；不随 modeBuild 青——模式色只属于模型行前缀与 $ 提示符）
      const fg = toast.type === 'success' ? theme.diffAdd : toast.type === 'error' ? theme.cardErrDim : theme.suggestText;
      tree.toastCell.fg = parseColor(fg);
      tree.toastBox.visible = true;
    }
  }

  const rows = computeRows(state, { height, width }, opts);
  tree.lastRows = rows; // 供拖选字符级定位（x → 行内列 → 字符）与 up 时提取选区文本
  const anchor = tree.status; // 内容行始终插在状态栏之前（联想列表是独立浮层，不在内容流里）
  while (tree.cells.length < rows.length) {
    // 池增长：新建细胞插到状态栏前（一次原生分配；此后原位更新不再分配）
    const cell = new TextRenderable(ctx, { content: '', wrapMode: 'none' });
    tree.cells.push(cell);
    tree.root.insertBefore(cell, anchor);
  }
  // 刷新卡片/思考/审批命中区域。**坐标语义（探针实测）**：根 Box 有 paddingY:1，
  // 内容行 i 渲染在屏幕帧第 i+1 行（0-based 帧行）；终端上报 SGR wireY = 1-based
  // 行号，OpenTUI 解析后事件 y = wireY - 1 = 帧行。因此**事件 y = i + 1**——
  // rect 必须按事件坐标登记（旧实现用 i，与真实事件 y 差 1：单行收起模块
  //（+ thinking / tokens 汇总）唯一一行永远点不中，需点别处触发重绘后恰巧命中）。
  tree.cardRects.clear();
  tree.thinkingRects.clear();
  tree.tokensRects.clear();
  tree.fileRects.clear();
  tree.approvalRect = null;
  for (let i = 0; i < tree.cells.length; i++) {
    const cell = tree.cells[i];
    if (i >= rows.length) {
      cell.visible = false; // 行数减少：隐藏多余细胞，不销毁
      continue;
    }
    cell.visible = true;
    try {
      // 拖选高亮：选区命中的行按选中列范围重绘底色/文字色（markRowSelected 克隆重建 chunks）
      let r = rows[i];
      if (tree.sel && i >= 0 && i < rows.length) r = selecRow(rows, i, tree.sel, theme) ?? r;
      applyRowToCell(cell, r, theme);
    } catch (e) {
      // 单行失败保留旧内容，不让整帧挂掉；连续相同错误只记一次（防刷爆日志）
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== lastRowError) {
        lastRowError = msg;
        logCrash('repaint-row', e);
      }
    }
    const y = i + 1; // 内容行 i → 事件 y（根 paddingY:1 下移一行，见上注释）
    const cardId = rows[i].cardId;
    if (cardId !== undefined) {
      const rect = tree.cardRects.get(cardId);
      if (rect) rect.bottom = y;
      else tree.cardRects.set(cardId, { top: y, bottom: y });
    }
    const thinkingIdx = rows[i].thinkingIdx;
    if (thinkingIdx !== undefined) tree.thinkingRects.set(y, thinkingIdx);
    const tokensIdx = rows[i].tokensIdx;
    if (tokensIdx !== undefined) tree.tokensRects.set(y, tokensIdx);
    // 本地文件链接：行内列 c → 事件 x = 1 + c（根 paddingX:1，与 y = i + 1 同坐标系）
    const fileLinks = rows[i].fileLinks;
    if (fileLinks && fileLinks.length > 0) tree.fileRects.set(y, fileLinks);
    if (rows[i].approvalId !== undefined) {
      if (tree.approvalRect) tree.approvalRect.bottom = y;
      else tree.approvalRect = { top: y, bottom: y };
    }
  }
  // 待发送消息行的点击区域：底部固定块（ask + delegate + todo + 待发送区 + 灰色块）被 marginTop:auto 钉在视口
  // 底部，位置是**确定**的（与内容长度/滚动无关）——底部块顶 = 视口 - 根底内边距(1)
  // - delegate 面板(delegateRows) - 任务清单(todoRows) - 待发送区(pendingRows) - 灰色块(inputLines+4)。
  // 每条消息一行（无标题行）：消息 i 在 y = wrapperTop + i。
  if (pendingCount > 0 && opts?.withInput) {
    tree.pendingRects.clear();
    // hero 居中模式下底部块随根居中上移 heroOffset，命中区同步换算
    const wrapperTop = (height ?? 24) - 7 - pendingRows - todoRows - delegateRows - state.inputLines - heroOffset;
    for (let i = 0; i < pendingVisibleMsgs; i++) tree.pendingRects.set(wrapperTop + i, i);
  }
  // ask_user 提问面板（输入区上方）：**扁平面板 + 独立自定义输入**——? 问题（单选/多选，
  // cyan 加粗同命令面板标题）+ 每行 `[x] A) 选项` + 自定义行（面板**自己独立的输入缓冲**
  // `ask.custom`，打字进面板不进主输入框——用户要求；光标 ▏ 提示输入位置）+ `✓ 确认（Enter）`
  // 提交行 + 提示行。顶部留白 1 行（同命令面板）。高亮行 `›` 前缀。
  if (tree.askBox) {
    const a = state.ask;
    tree.askBox.visible = !!a && !!opts?.withInput;
    tree.askRects.clear();
    if (a && opts?.withInput) {
      tree.askBox.backgroundColor = theme.footerBg; // 主题切换（/theme）每帧跟随（同命令面板底色）
      const lang = state.language;
      const aRows: { text: string; style: { dim?: boolean; bold?: boolean; fg?: string } }[] = [];
      aRows.push({ text: ' ', style: {} }); // 顶部留白 1 行（同命令面板——空文本高度 0，单空格占位）
      const modeTag = a.multiple ? t(lang, 'ask.multiple') : t(lang, 'ask.single');
      aRows.push({ text: `? ${fitAsk(a.question, Math.max(10, (width ?? 80) - 12))}（${modeTag}）`, style: { fg: 'cyan', bold: true } });
      const optCols = Math.max(10, (width ?? 80) - 8);
      for (let i = 0; i < a.options.length; i++) {
        const on = a.selected.has(i);
        const cur = a.cursor === i;
        const label = `${String.fromCharCode(65 + i)}) ${fitAsk(a.options[i]!, optCols - 5)}`;
        aRows.push({
          text: `${cur ? '›' : ' '} [${on ? 'x' : ' '}] ${label}`,
          style: cur ? { fg: 'blue', bold: true } : on ? { bold: true } : {},
        });
      }
      const curCustom = a.cursor === a.options.length;
      const customOn = a.custom.trim().length > 0;
      // 独立输入行：有内容显示内容、无内容显示占位；光标在高亮行时追加 ▏（输入位置提示）
      const customText = a.custom ? fitAsk(a.custom, optCols - 7) : t(lang, 'ask.customPlaceholder');
      aRows.push({
        text: `${curCustom ? '›' : ' '} [${customOn ? 'x' : ' '}] ${t(lang, 'ask.custom')}：${customText}${curCustom ? '▏' : ''}`,
        style: curCustom ? { fg: 'blue', bold: true } : customOn ? { bold: true } : { dim: true },
      });
      aRows.push({ text: `✓ ${t(lang, 'ask.confirm')}（Enter）`, style: { fg: 'green', bold: true } });
      aRows.push({ text: t(lang, 'ask.hint'), style: { dim: true } });
      for (let i = 0; i < tree.askCells.length; i++) {
        const cell = tree.askCells[i];
        if (i >= aRows.length) {
          cell.visible = false;
          continue;
        }
        cell.visible = true;
        applyRowToCell(cell, aRows[i], theme);
      }
      // 面板底 = footer 顶 - todoRows - pendingRows - delegateRows（delegate/todo/待发送区在面板与灰色块之间）；
      // 顶 = 底 - 行数（hero 居中再减 heroOffset）
      const aBottom = (height ?? 24) - 6 - state.inputLines - todoRows - pendingRows - delegateRows - heroOffset;
      const aTop = aBottom - aRows.length;
      // 行 y → 类型：顶部留白行后，问题行下标 1、选项行下标 2+i、自定义行 2+n、确认行 3+n
      for (let i = 0; i < a.options.length; i++) {
        tree.askRects.set(aTop + 2 + i, { kind: 'opt', idx: i });
      }
      tree.askRects.set(aTop + 2 + a.options.length, { kind: 'custom' });
      tree.askRects.set(aTop + 3 + a.options.length, { kind: 'confirm' });
    }
  }
}

/**
 * 把一行按选区换算成选中列范围并应用高亮（markRowSelected）。
 * 选区用行下标 + 显示列（相对行首）；起点/终点行只选部分列，中间行整行高亮。
 * 行不在选区范围内 → null（原样渲染）。
 */
function selecRow(rows: Row[], i: number, sel: TuiSelection, theme: TuiTheme): Row | null {
  // 归一化：把 anchor/focus 整理成 [start, end]（行优先排序）
  const a = { row: sel.aRow, col: sel.aCol };
  const f = { row: sel.fRow, col: sel.fCol };
  const s = a.row < f.row || (a.row === f.row && a.col <= f.col) ? a : f;
  const e = a.row < f.row || (a.row === f.row && a.col <= f.col) ? f : a;
  if (i < s.row || i > e.row) return null;
  const row = rows[i];
  const aCol = i === s.row ? s.col : 0;
  const bCol = i === e.row ? e.col : row.text.length * 4; // 中间行取到底（超宽可被 colToChar 截断）
  return markRowSelected(row, aCol, bCol, theme);
}

/**
 * 把文本写进系统剪贴板：先尝试 OSC52（写 `\x1b]52;c;<base64>\x07`，主流终端都支持，
 * 零外部依赖），再回退到平台剪贴板工具（macOS pbcopy / Linux xclip·wl-copy；
 * Windows 用 PowerShell Set-Clipboard）。任一成功即可；全部失败静默（拖选不打断）。
 */
function copyTextToClipboard(text: string): void {
  if (!text) return;
  try {
    process.stdout.write(`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`);
  } catch {
    // OSC52 失败（非 TTY/被吞）→ 回退子进程
  }
  try {
    if (process.platform === 'darwin') execFileSync('pbcopy', [], { input: text });
    else if (process.platform === 'linux') {
      // 优先 wl-copy（Wayland），没有再用 xclip
      try {
        execFileSync('wl-copy', [], { input: text });
      } catch {
        execFileSync('xclip', ['-selection', 'clipboard'], { input: text });
      }
    } else if (process.platform === 'win32') {
      execFileSync('powershell', ['-NoProfile', '-Command', 'Set-Clipboard'], { input: text });
    }
  } catch {
    // 无剪贴板工具（如最小容器）→ 拖选功能不中断，仅复制失效
  }
}

/** OpenTUI 鼠标事件的结构化子集（滚轮滚动 + 点击展开卡片用） */
interface MouseEventLike {
  type?: string;
  scroll?: { direction?: string; delta?: number };
  /** 坐标：0-based 事件坐标（无边框布局；内容行 i 位于 y = i） */
  x?: number;
  y?: number;
  /** 按钮：0 = 左键（MouseButton.LEFT） */
  button?: number;
}

/**
 * 根 Box 鼠标事件处理器（startTui 挂载；导出供快照用同一真实代码路径测试）：
 * 滚轮上/下 → 滚动意图（每格约 3 行），与键盘滚动同一套机制；只在 scroll 类型事件时
 * 消费，点击/移动保持默认行为（不干扰输入框聚焦）。同方向连续滚轮累加步长——
 * 帧执行期间到达的多格并入同一意图，由尾沿补帧一次性消费，快速连滚不丢格。
 * 左键点击优先级：① 菜单浮层选项行（选中并确认，等同数字键+Enter）② 审批卡片
 * ③ 命令联想/@ 提及浮层 ④ 待发送消息选中 ⑤ 思考/token 模块展开收起 ⑥ 工具卡片。
 * 浮层打开时点击不穿透到下层内容（避免误触被遮挡的工具卡片）。
 * 坐标语义：MouseEvent.y 为 0-based（实测 SGR y 减 1）；repaintTree 已把
 * 每个可见卡片/思考行按事件坐标登记（内容行 i → y = i）。
 */
export function handleTuiMouseEvent(
  e: MouseEventLike,
  tree: TuiTree,
  state: TuiState,
  width: number,
  paint: () => Promise<void>,
  session?: { paint?: () => Promise<unknown> } | null,
  autoCloseDelayMs = 1500,
  /** 点击本地文件链接时的回调（startTui 注入：挂起 TUI → $EDITOR 打开 → 恢复 + 重绘）；未注入则命中链接不消费 */
  onOpenFile?: (path: string) => void,
): void {
  // —— 拖选复制（字符级精选取中，见 AGENTS.md）——
  // 状态机：down（左键落在内容行）→ 建立选区起点 tree.sel；drag → 移动焦点行/列；
  // up → 若发生了真正拖动（selectionMoved）则提取选区文本写系统剪贴板并清空选区，
  // 否则（纯点击）清空不复制。渲染层 repaintTree 读 tree.sel 给命中行画 selBg 高亮。
  // 坐标换算：内容行 i 的事件 y = i + 1；行内显示列 c 的事件 x = c + 1（根 paddingX:1）。
  // 菜单/审批/联想等浮层打开时拖选被下方守卫整体忽略（不穿透，保持原有点击行为）。
  if (tree.sel) {
    // up：拖动结束 → 有位移则复制，否则只是点击。无论哪种都清除选区
    if (e.type === 'up' && e.button === 0) {
      const sel = tree.sel;
      tree.sel = null;
      if (selectionMoved(sel) && typeof e.x !== 'undefined' && typeof e.y !== 'undefined') {
        const text = selectionText(tree.lastRows, sel);
        if (text) {
          copyTextToClipboard(text);
          // 复制成功 → 右上角 toast（✓ 已复制；立即显示，paint 在下方统一触发）
          pushToast(state, t(state.language, 'toast.copied'), 'success');
        }
      }
      void paint();
      return;
    }
    // drag：更新焦点行/列（跟随鼠标拖动，字符级）
    if (e.type === 'drag' && typeof e.x === 'number' && typeof e.y === 'number') {
      tree.sel.fRow = Math.max(0, e.y - 1);
      tree.sel.fCol = Math.max(0, e.x - 1);
      void paint();
      return;
    }
  }
  // 左键按下且未在浮层上（此时无选区）：若落在内容行，开始拖选
  if (e.type === 'down' && e.button === 0 && typeof e.x === 'number' && typeof e.y === 'number') {
    if (
      !state.menu &&
      !state.cmdPanel &&
      e.y >= 1 &&
      e.y <= tree.lastRows.length
    ) {
      tree.sel = { aRow: e.y - 1, aCol: Math.max(0, e.x - 1), fRow: e.y - 1, fCol: Math.max(0, e.x - 1) };
    }
  }
  // 菜单浮层（/theme /permission /settings language 等）：点击选项行 = 选中并确认
  // （等同数字键 + Enter，用户反馈「点击也没有可选择的语言选项」——此前菜单鼠标被整体忽略）。
  // 面板内其它区域点击忽略；都不穿透到下层内容。
  // 坐标：menuOverlay **无 border**（行 0 即标题行直接渲染在 top）——行 i → y = top + i，
  // panelIdx = e.y − top（注意与联想浮层不同：suggestBox 有 border，内部行从 top+1 起）。
  // 之前误套 suggestBox 的 −1 偏移：真实终端按屏幕位置点击命中偏下 1 行
  // （点「语言」打开的是「状态行」操作页——用户反馈实锤，探针按公式算坐标未暴露）。
  // 放在 cmdPanel 守卫之前：菜单确认后 pushCmdLine 会打开命令输出面板，若面板还开着
  // （测试/边界态），重新打开的菜单点击仍应优先命中菜单，而不是被面板守卫整体吞掉。
  if (state.menu) {
    if (e.type === 'down' && e.button === 0 && typeof e.y === 'number' && tree.menuOverlay) {
      const overlayTop = (tree.menuOverlay.top ?? 0) as number;
      const panelIdx = e.y - overlayTop;
      const optIdx = panelIdx >= 0 && panelIdx < tree.menuRowMap.length ? tree.menuRowMap[panelIdx] : -1;
      if (optIdx >= 0) {
        state.menu.selectedIndex = optIdx;
        confirmMenu(state);
        // 确认提示进面板后短暂停留自动收起（与键盘路径一致——键盘由 interactive 菜单
        // 分支调度；鼠标点选此前漏调度，「切换语言提示始终显示不消失」的根因）
        scheduleCmdPanelAutoClose(state, session, autoCloseDelayMs);
        void paint();
      }
    }
    return;
  }
  // 命令输出面板浮层打开时忽略鼠标（滚动/点击都不穿透到下层内容，避免误点工具卡片）
  if (state.cmdPanel) return;
  // 滚轮：滚动意图（见上）
  if (e.type === 'scroll' && e.scroll) {
    const dir = e.scroll.direction;
    if (dir !== 'up' && dir !== 'down') return;
    const action = dir === 'up' ? 'line-up' : 'line-down';
    const lines = Math.min(6, Math.max(1, Math.round(e.scroll.delta ?? 1) * 3));
    const prev = state.scrollIntent;
    state.scrollIntent =
      prev && prev.action === action ? { action, lines: (prev.lines ?? 1) + lines } : { action, lines };
    void paint();
    return;
  }
  // 左键点击：
  // ① 工具调用审批卡片（安全护栏）：点击左侧批准、右侧拒绝（y 命中审批卡区域）；
  // ② 命令联想浮层：点击某项 → 填入该命令（等同 Tab，可继续编辑后 Enter 执行）；
  //    浮层区域内的点击不穿透到下层内容（避免误触被遮挡的工具卡片）；
  // ③ 思考折叠态：点击某条折叠摘要 → 单独展开该条思考（再次点击收起）；
  // ④ token 统计模块：点击展开/收起汇总明细；
  // ⑤ 命中工具卡片 → 切换展开/收起。
  if (e.type === 'down' && e.button === 0 && typeof e.y === 'number') {
    // 审批卡片优先级最高：命中即按点击列批准/拒绝（左半批准、右半拒绝）
    if (hitTestApproval(state, tree.approvalRect, e.y)) {
      const allow = typeof e.x === 'number' && e.x < width / 2;
      state.approvalResolve?.(allow);
      void paint();
      return;
    }
    // ask_user 提问面板：竖向勾选列表——点击选项行 = 勾选/取消（单选互斥）、
    // 自定义行 = 光标移过去（输入框键入内容）、确认行 = 提交；面板区域优先于内容
    if (state.ask) {
      const rowOpt = tree.askRects.get(e.y);
      if (rowOpt) {
        if (rowOpt.kind === 'opt' && rowOpt.idx !== undefined) {
          if (state.ask.multiple) {
            if (state.ask.selected.has(rowOpt.idx)) state.ask.selected.delete(rowOpt.idx);
            else state.ask.selected.add(rowOpt.idx);
          } else {
            state.ask.selected.clear();
            state.ask.selected.add(rowOpt.idx);
          }
          state.ask.cursor = rowOpt.idx;
        } else if (rowOpt.kind === 'custom') {
          state.ask.cursor = state.ask.options.length;
        } else if (rowOpt.kind === 'confirm') {
          submitAsk(state); // 自定义内容在面板独立缓冲里，主输入框无需清理
        }
        void paint();
        return;
      }
    }
    // 轨迹面板（/trace 右侧栏）：x ≥ traceLeft 且 y 命中面板内部行。
    // 详情页：点击返回行（rowMap -2）→ 回列表；内容行无操作。
    // 列表页：点击轨迹行 → **推入详情页**（rowIdx 快照）；标题/提示行不触发。
    if (
      state.traceOpen &&
      tree.traceRect &&
      typeof e.x === 'number' &&
      e.x >= tree.traceLeft &&
      e.y >= tree.traceRect.top &&
      e.y <= tree.traceRect.bottom
    ) {
      const panelIdx = e.y - tree.traceRect.top;
      const rowIdx = tree.traceRowMap[panelIdx];
      if (state.traceDetail) {
        // 详情页：返回行恒为面板第 1 行（traceDetailLines 固定结构）——直接按
        // panelIdx 判断，不依赖 traceRowMap（点击推入详情页后 paint 异步刷新前，
        // 同帧第二次点击读到的还是列表页的旧 rowMap——快照同帧点击暴露）
        if (panelIdx === 0) {
          state.traceDetail = null; // 点击返回行：回列表页
          state.traceScroll = 0;
        }
      } else if (rowIdx !== undefined && rowIdx >= 0) {
        state.traceSelected = rowIdx;
        state.traceDetail = { rowIdx }; // 推入详情页
        state.traceScroll = 0;
      }
      void paint();
      return;
    }
    // 命令联想 / @ 提及浮层：点击某项 → 填入（命令填 /cmd ；提及按文件/目录插入）。
    // 行 → items 下标经 tree.suggestRowMap 映射（-1 = ↑/↓ 提示行，点击忽略）
    const picker = state.cmdSuggest ?? state.mention;
    if (picker && tree.suggestRect && tree.input) {
      const { top, bottom } = tree.suggestRect;
      if (e.y >= top && e.y <= bottom) {
        const idx = e.y - top;
        const itemIdx = tree.suggestRowMap[idx];
        const sel = itemIdx !== undefined && itemIdx >= 0 ? picker.items[itemIdx] : undefined;
        if (sel) {
          if (state.cmdSuggest) {
            tree.input.setText(`/${sel} `); // 尾空格让联想自动隐藏（与 Tab 同语义）
            state.cmdSuggest = null;
          } else if (state.mention) {
            insertMention(tree.input, state.mention, itemIdx); // 目录保留 / 继续浏览；文件结束提及
          }
        }
        void paint();
        return;
      }
    }
    // 待发送消息区：点击某条消息 → **直接编辑**（对标 Claude Code queued 点击编辑——
    // 用户要求；与 Enter 编辑同路径：文本取回输入框、从列表移除，改完重新提交即再入列）
    if (state.pending.length > 0) {
      const pIdx = tree.pendingRects.get(e.y);
      if (pIdx !== undefined) {
        const text = editPending(state, pIdx);
        if (text !== null) {
          tree.input?.setText(text);
          state.pendingSelected = -1;
        }
        void paint();
        return;
      }
    }
    // 本地文件链接（对话流中行内代码里的真实文件路径，下划线提示）：命中 →
    // 外部编辑器打开。x 映射：根 paddingX:1 → 行内列 c 的事件 x = 1 + c（与
    // repaintTree 的 fileRects 登记同坐标系；0-based 终端列）。链接在 answer 行，
    // 与思考/token/卡片不重叠，放优先级链最前（更具体的命中优先）。
    const links = tree.fileRects.get(e.y);
    if (links && onOpenFile && typeof e.x === 'number') {
      const col = e.x - 1;
      for (const l of links) {
        if (col >= l.col && col < l.col + l.width) {
          onOpenFile(l.path);
          void paint();
          return;
        }
      }
    }
    // ④ 思考模块 / token 统计模块：点击切换展开/收起；
    // ⑤ 命中工具卡片 → 切换展开/收起。
    // ⑥ 运行中 delegate 面板（输入区上方 command 样式）：标题行 toggle 展开/收起；
    //    ⏹ 停止行 → 标记 stopRequested（防重复）+ state.stopSubagent(run.seq) 触发停止。
    const dAct = tree.delegateRects.get(e.y);
    if (dAct) {
      const run = state.delegateRuns[dAct.run];
      if (run) {
        if (dAct.kind === 'toggle') {
          run.expanded = !run.expanded;
        } else if (!run.stopped && !run.stopRequested) {
          run.stopRequested = true;
          run.status = t(state.language, 'delegate.stopping');
          state.stopSubagent?.(run.seq);
        }
      }
      void paint();
      return;
    }
    if (hitTestThinking(state, tree.thinkingRects, e.y)) void paint();
    else if (hitTestTokens(state, tree.tokensRects, e.y)) void paint();
    else if (hitTestCard(state, tree.cardRects, e.y)) void paint();
  }
}

/**
 * Ctrl+C 按键决策（导出供快照/探针复用同一真实代码路径；startTui 注册）：
 * 输入框有内容 → 清空输入框并返回 'clear'（不退出，shell readline 习惯）；
 * 输入框为空或不存在（单任务模式）→ 返回 'exit'（调用方负责 destroy 退出进程）；
 * 非 Ctrl+C 按键 → null（不消费）。
 */
export function handleCtrlCKey(key: TuiKey, input: TextareaRenderable | null): 'clear' | 'exit' | null {
  if (!(key.ctrl && key.name === 'c')) return null;
  if (input && input.plainText !== '') {
    input.setText('');
    return 'clear';
  }
  return 'exit';
}

/**
 * ask_user 提问面板按键（导出供快照复用同一真实代码路径；startTui 注册）：
 * 竖向勾选列表交互——↑/↓ 移动高亮、**空格勾选/取消**（光标在选项行；自定义行空格 =
 * 输入空格）、**Enter 确认提交**（勾选选项 + 自定义内容）、Backspace 删除自定义末字符、
 * Esc 取消（置 askKeyJustConsumed——interactive 据此跳过取消运行）。
 * 可打印字符进面板**独立的自定义输入缓冲**（ask.custom，不进主输入框——用户要求）；
 * 提交结果含自定义内容。
 */
export function onAskKeyPress(
  key: TuiKey,
  state: TuiState,
  tree: TuiTree,
  paint: () => void
): void {
  const ask = state.ask;
  if (!ask) return;
  const n = key.name ?? '';
  // ↑/↓：移动高亮光标（0..options.length，末位 = 自定义行）
  if (n === 'up' || n === 'down') {
    ask.cursor = n === 'up' ? Math.max(0, ask.cursor - 1) : Math.min(ask.options.length, ask.cursor + 1);
    key.preventDefault();
    paint();
    return;
  }
  // Enter：确认提交（勾选项 + 自定义内容；无任何选择时不提交）——主输入框不参与
  //（自定义内容在面板独立缓冲里，无需清主输入框——用户要求独立输入）
  if (n === 'return' || n === 'kpenter' || n === 'linefeed') {
    submitAsk(state);
    key.preventDefault();
    paint();
    return;
  }
  // Backspace/Delete：删除自定义输入末字符（独立输入缓冲）
  if (n === 'backspace' || n === 'delete') {
    if (ask.custom.length > 0) ask.custom = ask.custom.slice(0, -1);
    key.preventDefault();
    paint();
    return;
  }
  // 空格：光标在选项行 = 勾选/取消（单选互斥）；光标在自定义行 = 输入空格
  if (n === 'space') {
    if (ask.cursor < ask.options.length) {
      if (ask.multiple) {
        if (ask.selected.has(ask.cursor)) ask.selected.delete(ask.cursor);
        else ask.selected.add(ask.cursor);
      } else {
        // 单选：再按空格取消当前勾选（toggle）；否则互斥替换
        if (ask.selected.has(ask.cursor)) ask.selected.delete(ask.cursor);
        else {
          ask.selected.clear();
          ask.selected.add(ask.cursor);
        }
      }
      key.preventDefault();
      paint();
      return;
    }
    ask.custom += ' '; // 自定义行：空格进输入缓冲
    key.preventDefault();
    paint();
    return;
  }
  if (n === 'escape' || n === 'esc') {
    // Esc 记录「已被 ask 消费」：interactive 的 Esc=取消运行分支据此跳过取消
    //（取消提问 ≠ 取消对话——模型收到「用户取消」自行决定继续）
    state.askKeyJustConsumed = true;
    state.askResolve?.(null);
    key.preventDefault();
    paint();
    return;
  }
  // 可打印字符（含粘贴多字符）：进面板独立的自定义输入缓冲（不进主输入框——
  // 用户要求 ask 自带独立输入框）；Ctrl/Meta 组合键不放行不消费
  const seq = key.sequence ?? '';
  if (seq.length > 0 && !key.ctrl && !key.meta && !key.super && !key.option) {
    ask.custom += seq;
    key.preventDefault();
    paint();
  }
}

/**
 * 组装并提交 ask 面板结果（Enter / 确认行点击共用）：勾选选项（按序）+ 自定义内容
 *（有内容）→ resolve；无任何勾选/内容时不提交（面板保持，提示用户先选择）。
 */
export function submitAsk(state: TuiState): void {
  const ask = state.ask;
  if (!ask) return;
  const picked: string[] = [];
  for (const i of [...ask.selected].sort((a, b) => a - b)) picked.push(ask.options[i]!);
  const custom = ask.custom.trim();
  if (custom) picked.push(custom);
  if (picked.length === 0) return; // 未选择任何内容 → 不提交（Enter 无操作）
  state.askResolve?.({
    choice: picked.join('、'),
    custom: custom.length > 0,
    choices: picked,
  });
}

/** 创建 TUI 会话：建树 + 首帧，返回 paint/stop/input/onKeyPress */
export async function startTui(state: TuiState, opts?: { withInput?: boolean }): Promise<TuiSession> {
  // exitOnCtrlC 关闭：Ctrl+C 不再直接退出，由下方 onCtrlC 接管——输入框有内容时
  // 清空输入框（readline 语义），输入框为空/单任务模式才退出进程（destroy 恢复终端）
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const ctx = renderer as unknown as RenderContext; // CliRenderer 实现了 RenderContext
  // 跟踪 onKeyPress/主题订阅：stop() 时统一清理，避免订阅泄漏
  const keyUnsubs = new Set<() => void>();
  // 工具审批卡片按键（安全护栏）：y/Enter 批准、n/Esc 拒绝。
  // 必须在能力协商（waitForThemeMode）之前注册——实测 OpenTUI 在协商/paint 完成后
  // 才注册的 keypress 全局监听收不到按键（事件派发已与监听注册脱节）
  const onApprovalKey = (key: TuiKey): void => {
    if (!state.approval) return;
    if (key.name === 'y' || key.name === 'return' || key.name === 'kpenter' || key.name === 'linefeed') {
      state.approvalResolve?.(true);
    } else if (key.name === 'n' || key.name === 'escape' || key.name === 'esc') {
      // Esc 记录「已被审批消费」：interactive 的 Esc=取消运行分支据此跳过取消
      // （拒绝审批 ≠ 取消对话；审批 handler 先于 interactive 订阅执行）
      state.approvalKeyJustConsumed = key.name === 'escape' || key.name === 'esc';
      state.approvalResolve?.(false);
    }
    key.preventDefault(); // 消费按键不进入输入框（运行中输入框已 blur；并行审批串行排队）
    void paint();
  };
  const unsubApproval = () => {
    renderer.keyInput.off('keypress', onApprovalKey);
  };
  keyUnsubs.add(unsubApproval);
  renderer.keyInput.on('keypress', onApprovalKey);
  // ask_user 提问面板按键（输入区上方选项）：A-D 字母选对应选项、Esc 取消。
  // 与审批同注册时机（能力协商前）+ preventDefault——运行中输入框保持聚焦，
  // 字母键不拦截会直接打进输入框（自定义输入场景 Enter 提交走 onSubmit 分流）。
  const onAskKey = (key: TuiKey): void => onAskKeyPress(key, state, tree, () => void paint());
  const unsubAsk = () => {
    renderer.keyInput.off('keypress', onAskKey);
  };
  keyUnsubs.add(unsubAsk);
  renderer.keyInput.on('keypress', onAskKey);
  // Ctrl+C：不直接退出进程（原 exitOnCtrlC 语义改由这里接管）——输入框有内容时
  // 清空输入框（shell readline 习惯，清空后仍可继续输入/发送），输入框为空或
  // 单任务模式（无输入框）才退出。注册在能力协商前（与审批同因：OpenTUI 协商后
  // 注册的 keypress 监听收不到按键）。
  const onCtrlC = (key: TuiKey): void => {
    const r = handleCtrlCKey(key, tree.input);
    if (!r) return;
    key.preventDefault(); // 消费按键：不让输入框/其它 handler 处理 ctrl+c
    if (r === 'clear') {
      void paint(); // 清空输入框后重绘（自动增高复位、联想/提及同步隐藏）
      return;
    }
    // 退出：destroy 恢复终端（退出备用屏）并移除监听后进程自然退出（与 exitOnCtrlC 相同）。
    // 终端恢复后打印会话恢复提示（omni -s <id> 可继续本次会话）——必须在 destroy 之后：
    // 提示写在主屏，若还停在备用屏会画进看不见的屏幕（用户要求 Ctrl+C 退出时给出恢复命令）。
    stopped = true; // 先置位：destroy 会使渲染树失效，迟到的 paint 直接 no-op
    const hint = state.restoreHint;
    process.nextTick(() => {
      try {
        (renderer as unknown as { destroy(): void }).destroy();
      } catch (err) {
        logCrash('destroy-on-ctrl-c', err);
      }
      if (hint) process.stdout.write(`\n${dim(tf(state.language, 'meta.resumeHint', { hint }))}\n`);
    });
  };
  const unsubCtrlC = () => {
    renderer.keyInput.off('keypress', onCtrlC);
  };
  keyUnsubs.add(unsubCtrlC);
  renderer.keyInput.on('keypress', onCtrlC);
  // 主题检测：OpenTUI 通过 OSC 10/11 查询终端背景色并按亮度推断亮/暗。
  // 结果存 detectedTheme（themeMode=system 时取色用）；超时/不支持保持默认深色。
  try {
    const mode = await renderer.waitForThemeMode(400);
    if (mode === 'light' || mode === 'dark') state.detectedTheme = mode;
  } catch {
    // 主题查询失败 → detectedTheme 保持默认深色
  }
  const tree = mountTree(ctx, state, opts);

  // 重绘串行化 + 尾沿合并：OpenTUI 渲染器不允许并发 loop()（原生侧非线程安全，
  // 并发调用是闪退高危候选），而流式节流/按键/滚轮/flush 的 paint 可能重叠。
  // 策略：一帧执行期间到达的新调用只置 paintQueued，当前帧结束后补跑一帧——
  // 保证「先写 scrollIntent 再 paint」的意图一定被补帧消费（否则意图滞留、
  // 滚轮/连按会被静默丢弃）；flush 等待批次排空，避免与 stop 竞争。
  // 单次失败写崩溃日志后继续，不让整个 TUI 拖崩。
  let paintRunning = false;
  let paintQueued = false;
  let stopped = false; // stop() 后置位：任何迟到的 paint（节流定时器/按键回调）直接 no-op，
  // 不再触碰已销毁的渲染树——否则 repaintTree 在已 destroy 的输入框上设 textColor 会
  // 反复抛「EditBuffer is destroyed」（崩溃日志里 5 连刷的 paint 错误）
  let paintSettled: Promise<void> = Promise.resolve();
  const paint = async (): Promise<void> => {
    if (stopped) return;
    if (paintRunning) {
      paintQueued = true; // 有帧在跑：请求补一帧（消费最新 state），并等当前批次结束
      await paintSettled;
      return;
    }
    paintRunning = true;
    const run = (async () => {
      try {
        do {
          paintQueued = false;
          try {
            repaintTree(ctx, tree, state, opts);
            // 显式画一帧（与测试渲染器 renderOnce 内部一致；CLI 渲染器同样可用）
            await (renderer as unknown as { loop(): Promise<void> }).loop();
          } catch (e) {
            logCrash('paint', e);
          }
        } while (paintQueued); // 执行期间又有请求 → 补一帧，直到无人请求
      } finally {
        paintRunning = false;
      }
    })();
    paintSettled = run.catch(() => {});
    await paintSettled;
  };

  // 鼠标事件：滚轮滚动 + 点击（菜单/联想/待发送/思考/token/卡片），逻辑见 handleTuiMouseEvent
  // （模块级导出函数：快照可复用同一真实代码路径）。在根 Box 上挂处理器（实例属性
  // 遮蔽原型 onMouseEvent 方法，属刻意为之——OpenTUI 把鼠标事件沿渲染树冒泡到根）。
  (tree.root as unknown as { onMouseEvent?: (e: MouseEventLike) => void }).onMouseEvent = (e) => {
    // 本地文件链接点击（对话流行内代码路径）：挂起 TUI（恢复终端/退出 raw mode）→
    // $EDITOR 打开（stdio inherit，用户读完退出）→ 恢复 TUI + 重绘。编辑器启动失败
    // 时在对话流提示（如 $EDITOR 未设置且无 vi）；suspend/resume 异常写崩溃日志不打断
    const openFile = (file: string): void => {
      try {
        renderer.suspend();
      } catch (err) {
        logCrash('suspend-for-editor', err);
      }
      const ok = openInEditor(file);
      if (!ok) {
        pushLine(state, { kind: 'warn', text: tf(state.language, 'meta.editorOpenFailed', { file }) });
      }
      try {
        renderer.resume();
      } catch (err) {
        logCrash('resume-after-editor', err);
      }
      void paint(); // 恢复后整帧重绘（编辑器期间流式内容也一并补上）
    };
    handleTuiMouseEvent(e, tree, state, (ctx as { width?: number }).width ?? 80, paint, { paint }, 1500, openFile);
  };

  await paint();
  // 主题检测可能晚于首帧完成（OSC 查询异步返回）：收到 theme_mode 事件时
  // 更新 detectedTheme 并重绘（repaintTree 每帧按最新主题取色；system 模式自动跟随）
  const onThemeMode = (mode: unknown): void => {
    if (mode === 'light' || mode === 'dark') {
      state.detectedTheme = mode;
      void paint();
    }
  };
  renderer.on('theme_mode', onThemeMode as () => void);
  const unsubTheme = () => {
    renderer.off('theme_mode', onThemeMode as () => void);
  };
  keyUnsubs.add(unsubTheme);
  return {
    paint,
    stop: async () => {
      stopped = true; // 先置位：晚到的 paint 不再触碰渲染树（见 paint 顶部守卫）
      for (const unsub of keyUnsubs) unsub();
      keyUnsubs.clear();
      renderer.stop();
      // 恢复终端（退出备用屏 + 退出 raw mode）：renderer.stop() 只停渲染循环、不写
      // `?1049l`——/exit 正常退出路径若不 destroy，备用屏残留、退出后的提示画进看不见
      // 的屏幕（pty 实测抓到）。destroy() 才恢复终端（Ctrl+C 路径一直用 destroy 退出）。
      try {
        (renderer as unknown as { destroy(): void }).destroy();
      } catch (err) {
        logCrash('destroy-after-stop', err);
      }
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

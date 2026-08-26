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
 *   ⏳ 待发送（3 · ⚡ 1 打断）  ← 待发送小视图（灰块正上方，钉底）：· queue / ⚡ steer
 *     · 排队消息 / ⚡ 打断消息      ↑/↓ 选中 · ←/→ 排序 · Enter 编辑 · Del 删除
 *   ╭──────────────────────────────╮ ← 灰色块（16px 圆角；输入框 + 模型行）
 *   ▍ 输入消息，Enter 发送…         │ 多行输入框（▍ 蓝色细线贴左缘、竖跨整块）
 *   ▍ ⠙ esc Build · grok-4.5 demo · medium │ 模型行（loading+esc 最左；模式/模型/组/级别）
 *   ╰──────────────────────────────╯
 *         8 轮 · 65 步| LLM 20m32s · 工具调用 8.6s| …  ← 统计行（灰块下方，居中）
 *
 * 灰色块（输入框 + 模型行，淡灰色背景，四边 16px 圆角）与对话流区分；
 * 左侧**蓝色细线（▍，与对话流用户消息同款）**贴左缘、**竖跨整个灰色背景**（含上下
 * 圆角边框行，用户要求：高度 = 边框 2 + 输入 inputLines + 间距 1 + 模型 1 = inputLines+4，
 * 显式 height 钉住 + marginTop/Bottom:-1 溢出到边框行，不撑大灰块）；高度低（paddingY 0，
 * 输入框与模型行之间留 1 行间距，灰块 = 圆角边框 2 + 输入 inputLines + 间距 1 + 模型 1 = inputLines+4）。
 * 模型行（**左对齐**——用户要求从右侧移到左侧显示）显示当前模型 + 思考强度（思考强度用稍淡颜色）。
 * 运行中提交分流：Enter = queue（追加待发送列表末尾）；Cmd/Ctrl/Super/Option+Enter = steer
 *（插入最前，打断当前回合优先执行）；Esc 取消当前对话。待发送小视图显示在**灰色块正上方**
 *（与灰块一起钉在视口底部，位置确定不随内容浮动），每条带 mode 徽标（·/⚡）；
 * 可 ↑/↓ 选中、←/→ 排序、Enter 编辑、Backspace/Delete 删除、Esc/继续输入退出。
 * 发送/取消按钮已移除（TUI 无点击交互）。
 * footer 统计行在灰色块下方（不在灰色背景里，水平居中，整行统计：轮次/步数/LLM 与
 * 工具耗时/首 token/速率/缓存命中/输入输出，超宽按段从右截断）。
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
import { openInEditor } from '../agent/report.js';
import { commandSuggestions, confirmMenu, findCommand, scheduleCmdPanelAutoClose } from './commands.js';
import { logCrash } from './crashlog.js';
import { dim } from '../ui.js';
import { t, tf } from './i18n.js';
import { detectMention, insertMention, listMentionCandidates } from './mention.js';
import { TRACE_TEXT_COLS, TRACE_W, traceDetailLines, tracePanelLines } from './trace.js';
import { ACCENT_BAR, buildFooterStats, CONTENT_PAD, estimateInputLines, fitCount, fitFooterStats } from './layout.js';
import { effortColor, isLightTheme, themeColor, themeFor, type TuiTheme } from './theme.js';
import { SPINNER_FRAMES, pushLine, type CmdSuggestion, type MentionSuggestion, type TuiState } from './state.js';
import { visualWidth } from './width.js';
import {
  cmdPanelRows,
  computeRows,
  hitTestApproval,
  hitTestCard,
  hitTestThinking,
  hitTestTokens,
  menuPanelRows,
  settingsPanelRows,
  type CardRect,
  type Row,
  type RowStyle,
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
 * hero 横幅：figlet Standard 字体的「Omni」ASCII 大字（纯 ASCII，判宽与 OpenTUI
 * 渲染一致——不用含 █/╗ 等块字符的字体，避免个别终端按全角渲染导致错位）。
 * 每行 26 列等宽（可整体居中）；渲染时按行号错相彩虹色（bannerHue 驱动）。
 */
const OMNI_BANNER = [
  '   ___                  _ ',
  '  / _ \\ _ __ ___  _ __ (_)',
  ' | | | | \'_ ` _ \\| \'_ \\| |',
  ' | |_| | | | | | | | | | |',
  '  \\___/|_| |_| |_|_| |_|_|',
];

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
  /** 横幅文字行（OMNI_BANNER 每行一个 TextRenderable；彩虹色单独设 fg，alignSelf 居中） */
  omniCells: TextRenderable[];
  /** 底部固定块（ask + 待发送区 + 灰色块）：hero 模式去 marginTop:auto 让根 justifyContent 居中 */
  bottomBlock: BoxRenderable | null;
  /** 灰色块（输入行 + 模型行，交互模式非 null；单次任务模式为 null） */
  footerBox: BoxRenderable | null;
  /** 统计行容器（灰色块下方，居中；hero 模式隐藏——未开始对话不显示」0 轮 · 0 步」空统计） */
  infoRow: BoxRenderable | null;
  /** 灰色块左侧蓝色细线（▍，与对话流用户消息同款）：紧贴左缘、竖跨整个灰色背景（含上下边框行） */
  blueLine: TextRenderable | null;
  input: TextareaRenderable | null;
  /** 模型行 / 思考强度 / 统计行（repaintTree 每次刷新内容） */
  footerModel: TextRenderable | null;
  /** 思考级别（`· medium`，按级别强度着色 effortColor；未设置思考级别时为空） */
  footerEffort: TextRenderable | null;
  footerTokens: TextRenderable | null;
  /** loading（模型行内、模型文本右面；会话进行中转，Esc/会话结束消失） */
  footerLoading: TextRenderable | null;
  /** loading 右侧的「esc」取消提示（淡色；跟随 loading 显示/隐藏） */
  footerEsc: TextRenderable | null;
  /** 待发送消息区（输入框上方小视图：显示 queue/steer 消息，回合结束后按序发送；可选中/排序/删除/编辑） */
  queueBox: BoxRenderable | null;
  queueCells: TextRenderable[];
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
  /** 菜单浮层内部行 → 选项下标映射（-1 = 标题/提示/底边行，不可点击；鼠标点击命中用） */
  menuRowMap: number[];
  /** 命令输出面板浮层（所有 / 命令的独立窗口：绝对定位居中，不占用内容流/不参与滚动） */
  cmdPanelOverlay: BoxRenderable | null;
  cmdPanelCells: TextRenderable[];
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
  let footerEffort: TextRenderable | null = null;
  let footerTokens: TextRenderable | null = null;
  let footerLoading: TextRenderable | null = null;
  let footerEsc: TextRenderable | null = null;
  let queueBox: BoxRenderable | null = null;
  const queueCells: TextRenderable[] = [];
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

    // 模型行（输入框下方，灰色块内，**左对齐**）：**loading + esc 提示在最左侧**
    // （用户要求「有对话信息时，在最左侧显示 loading + esc 提示」——原来在思考级别
    // 右侧），随后是模式 + 模型 + provider + 思考级别：`Build/Plan · 模型名 组 · 级别`
    //（模式前缀：/plan 计划模式显示 Plan，普通 Build；级别按强度着色）。
    // 发送/取消按钮已移除（TUI 无点击交互，改用 Esc 取消命令 + Enter 排队 + Cmd/Ctrl+Enter steer）
    const modelRow = new BoxRenderable(ctx, {
      flexDirection: 'row',
      justifyContent: 'flex-start',
      alignItems: 'center',
      gap: 1,
    });
    // loading（会话进行中转圈 state.loading + loadingIndex；Esc/会话结束消失）——
    // **最左侧**（用户要求）：对话进行中在模型行最左端显示，紧贴灰块左缘的蓝色细线之后
    footerLoading = new TextRenderable(ctx, {
      content: '',
      wrapMode: 'none',
    });
    footerLoading.fg = parseColor(theme.accentBlue); // 蓝色转圈，与左侧蓝色细线同色系
    // loading 右侧「esc」取消提示（淡色小字；跟随 loading 显示/隐藏）
    footerEsc = new TextRenderable(ctx, {
      content: '',
      wrapMode: 'none',
      attributes: createTextAttributes({ dim: true }),
    });
    footerEsc.fg = parseColor(theme.footerDim);
    modelRow.add(footerLoading);
    modelRow.add(footerEsc);
    // 模型文本（模式 + 模型名 + provider 组名）：`Build · mock demo`
    footerModel = new TextRenderable(ctx, { content: '', wrapMode: 'none' });
    footerModel.fg = parseColor(theme.footerText);
    modelRow.add(footerModel);
    // 思考级别（` · medium`，按级别强度着色 effortColor；未设置思考级别时为空）
    footerEffort = new TextRenderable(ctx, { content: '', wrapMode: 'none' });
    footerEffort.fg = parseColor(theme.footerDim);
    modelRow.add(footerEffort);
    contentCol.add(modelRow);

    footerBox.add(contentCol);
  }

  // 子节点顺序：内容行（动态）→ 状态栏 → 灰色块（marginTop:auto 钉底）→ 统计行。
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

  // Omni 标题（hero 模式——未开始对话时居中显示在输入区上方）：5 行 ASCII 大字横幅，
  // 每行独立 TextRenderable（彩虹色单独设 fg，alignSelf:center 在根列布局中水平居中）；
  // 正常模式隐藏不占布局。颜色由 repaintTree 按 bannerHue 逐帧刷新（彩虹流动动画）。
  const omniTitle = new BoxRenderable(ctx, {
    flexDirection: 'column',
    alignSelf: 'stretch',
    marginBottom: 1,
    visible: false,
  });
  const omniCells: TextRenderable[] = [];
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
  // 整体背景 + 圆角边框（rounded），悬停在输入框（灰色块）上方，不占内容流、
  // 不挤动对话（用户要求独立界面、非当前对话流）。非模态：不拦截输入，用户可继续
  // 打字（列表按最新文本过滤，无匹配自动隐藏）；↑/↓ 高亮、Tab/Enter 填入、
  // 鼠标点击某项填入。位置（top/left）由 repaintTree 每帧按灰色块位置重算（与菜单浮层同理）。
  const suggestBox = new BoxRenderable(ctx, {
    position: 'absolute',
    zIndex: 9, // 低于 /theme 面板浮层（10），高于内容流
    flexDirection: 'column',
    visible: false,
    // 整体背景 + 圆角边框（rounded 圆角方框）：/ 命令联想与 @ 提及共用此浮层
    backgroundColor: theme.suggestBg,
    border: true,
    borderStyle: 'rounded',
    borderColor: theme.suggestBorder,
    paddingX: 1,
  });
  root.add(suggestBox);
  const suggestCells: TextRenderable[] = [];
  for (let i = 0; i < 12; i++) {
    const c = new TextRenderable(ctx, { content: '', wrapMode: 'none' });
    suggestBox.add(c);
    suggestCells.push(c);
  }

  // 命令面板浮层（/theme alert）：绝对定位居中（top/left 每帧重算），zIndex 高于内容；
  // 独立于会话流——菜单不占内容行、不参与滚动（用户要求「额外显示一个 alert」）。
  // **面板底色**：菜单/设置面板的圆角边框是行文本（╭─╮），行本身无背景——透明会
  // 透出对话流文字（用户反馈 command/设置界面与对话流文本重合看不清），整体填主题面板底色。
  const menuOverlay = new BoxRenderable(ctx, {
    position: 'absolute',
    zIndex: 10,
    visible: false,
    backgroundColor: theme.suggestBg,
  });
  root.add(menuOverlay);
  // 细胞池预分配**充足**行数：窗口滚动后菜单面板行数 = 标题 1 + 窗口（≤12）+
  // 上下提示 ≤2 + 操作提示 1 + 底边 1 ≤ 17；60 行覆盖超高视口（与 cmdPanel 同策略）。
  // 池不足时超出部分不渲染 = 面板「展示不全」（用户实测反馈：/session 面板有提示行
  // 但选项/底边被裁）——快照只断言纯函数行数、从未验证 pool 容量，回归靠这个注释防。
  const menuCells: TextRenderable[] = [];
  for (let i = 0; i < 60; i++) {
    const c = new TextRenderable(ctx, { content: '', wrapMode: 'none' });
    menuOverlay.add(c);
    menuCells.push(c);
  }

  // 命令输出面板浮层（所有 / 命令的独立窗口）：绝对定位居中（top/left 每帧重算），
  // 与 /theme 菜单浮层同级（zIndex 10，二者不同时打开）。细胞池预分配充足行数
  // （可见主体行 ≤ 视口-6，60 行覆盖超高视口；不参与内容流/滚动）。
  // **面板底色**：输出行（cardContentLine）无独立背景，透明会透出对话流文字
  // （用户反馈 command 界面与对话流文本重合看不清）——整体填主题面板底色。
  const cmdPanelOverlay = new BoxRenderable(ctx, {
    position: 'absolute',
    zIndex: 10,
    visible: false,
    backgroundColor: theme.suggestBg,
  });
  root.add(cmdPanelOverlay);
  const cmdPanelCells: TextRenderable[] = [];
  for (let i = 0; i < 60; i++) {
    const c = new TextRenderable(ctx, { content: '', wrapMode: 'none' });
    cmdPanelOverlay.add(c);
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

  // 待发送消息区：灰色块（输入框）正上方——运行中 Enter 提交的消息在此显示（标题 + 最多 4 条，
  // 每条带 queue/steer 徽标），不参与内容区滚动；回合结束后 interactive 按序消费。
  // 行数随 pending 长度变化（标题 1 + 最多 4 条 + 超出时「还有 N 条」1 行）。
  queueBox = new BoxRenderable(ctx, {
    flexDirection: 'column',
    paddingX: 1,
    gap: 0,
    visible: false,
  });
  for (let i = 0; i < 7; i++) {
    const c = new TextRenderable(ctx, { content: '', wrapMode: 'none' });
    queueBox.add(c);
    queueCells.push(c);
  }

  // ask_user 提问面板（输入区上方、待发送区上方）：问题 + 选项行 + 操作提示。
  // 圆角方框 + 主题面板底色（同联想/轨迹浮层设计语言）；行数 = 标题 1 + 问题 1 +
  // ceil(选项/3) 选项行 + 提示 1（最多 6 个选项 → 6 行）；预算同步（computeRows）。
  askBox = new BoxRenderable(ctx, {
    flexDirection: 'column',
    paddingX: 1,
    gap: 0,
    visible: false,
    backgroundColor: theme.suggestBg,
    border: true,
    borderStyle: 'rounded',
    borderColor: theme.suggestBorder,
  });
  for (let i = 0; i < 8; i++) {
    const c = new TextRenderable(ctx, { content: '', wrapMode: 'none' });
    askBox.add(c);
    askCells.push(c);
  }

  // 底部固定块：**待发送消息区 + 灰色块** 一起钉在视口底部（marginTop:auto 吸收
  // 自由空间——待发送区永远紧贴输入框上方，不随内容浮动；点击命中区域因此确定）。
  // 空待发送时 queueBox 不可见（不占布局），底部块只剩灰色块，行为与之前一致。
  const bottomBlock = new BoxRenderable(ctx, {
    flexDirection: 'column',
    marginTop: 'auto',
  });
  if (askBox) bottomBlock.add(askBox);
  if (queueBox) bottomBlock.add(queueBox);
  if (footerBox) bottomBlock.add(footerBox);
  root.add(bottomBlock);
  // token 统计行：在灰色块下方（不在灰色背景里），**水平居中**（用户要求；路径已移除）。
  // marginTop:1 与输入区域（灰色块）之间留 1 行间距（用户要求）
  const infoRow = new BoxRenderable(ctx, { flexDirection: 'row', justifyContent: 'center', marginTop: 1 });
  footerTokens = new TextRenderable(ctx, {
    content: '',
    wrapMode: 'none',
    attributes: createTextAttributes({ dim: true }),
  });
  footerTokens.fg = parseColor(theme.footerDim);
  infoRow.add(footerTokens);
  if (opts?.withInput) root.add(infoRow);

  const tree: TuiTree = {
    root,
    cells: [],
    status,
    omniTitle,
    omniCells,
    bottomBlock,
    footerBox,
    infoRow,
    blueLine,
    input,
    footerModel,
    footerEffort,
    footerTokens,
    footerLoading,
    footerEsc,
    queueBox,
    queueCells,
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
    menuRowMap: [],
    cmdPanelOverlay,
    cmdPanelCells,
    traceBox,
    traceCells,
    traceRect: null,
    traceRowMap: [],
    traceLeft: 0,
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
  if (tree.footerTokens) tree.footerTokens.fg = parseColor(theme.footerDim);
  // 待发送消息区（输入框上方小视图）行数预算：标题 1 + 最多 4 条消息 + 超出时「还有 N 条」1 行。
  // 由 computeRows / footerTop（联想浮层）共用——预算同步收缩，灰色块永远完整可见。
  const pendingCount = state.pending.length;
  const pendingVisibleMsgs = Math.min(4, pendingCount);
  const pendingRows = pendingCount > 0 ? 1 + pendingVisibleMsgs + (pendingCount > 4 ? 1 : 0) : 0;
  // 灰色块顶部（0-based 屏幕行；统计行与灰块间距 1 行）。联想/菜单/命令面板浮层共用：
  // 浮层底边钳制在此行上方——永不遮住输入区。inputLines 刷新后（下方 if 块内）重新赋值。
  let footerTop = (height ?? 24) - 7 - pendingRows - 1;
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
  // 底部输入区 + 其下的统计行**垂直居中**（不再是钉在视口底部），输入区上方显示
  // 5 行 ASCII 大字「Omni」横幅（彩虹色流动动画，bannerHue 驱动）。
  // 实现：根 justifyContent 改为 center、底部固定块去掉 marginTop:auto
  // （否则 auto 边距吸收全部自由空间、justifyContent 失效），横幅显示、状态栏隐藏
  // （「模型 X · 就绪」在居中 hero 布局下是冗余的——模型已在灰块内模型行展示）。
  // 菜单/设置/命令面板/ask 打开时退出 hero（浮层定位与快照断言都按底部钉住布局）；
  // 首条消息进入（lines 非空）后逐帧自动恢复到底部钉住布局。
  const hero =
    !!opts?.withInput &&
    state.lines.length === 0 &&
    !state.menu &&
    !state.settingsPanel &&
    !state.cmdPanel &&
    !state.ask;
  let heroOffset = 0; // hero 模式下灰色块相对「底部钉住」位置上移的行数（浮层/命中区按此换算）
  if (hero && tree.omniTitle && tree.bottomBlock) {
    // 居中组（自上而下）：横幅(OMNI_BANNER 5 行) + 横幅下间距(1) + 底部固定块[灰色块
    // inputLines+4 + 待发送区 pendingRows + ask 面板]。**统计行在 hero 下隐藏**
    // （未开始对话无统计可看——0 轮 · 0 步 对用户无意义，居中布局更干净）。
    const inputLines = Math.max(1, state.inputLines);
    const askRows = state.ask ? state.ask.options.length + 4 : 0;
    const groupH = OMNI_BANNER.length + 1 + pendingRows + askRows + (inputLines + 4);
    const groupTop = Math.max(1, Math.floor(((height ?? 24) - groupH) / 2));
    // 灰色块顶 = 组顶 + 横幅(5) + 横幅间距(1)；底部钉住时的灰块顶 = height - 7 - pendingRows - inputLines
    const grayTopCentered = groupTop + OMNI_BANNER.length + 1;
    const grayTopBottom = (height ?? 24) - 7 - pendingRows - inputLines;
    heroOffset = Math.max(0, grayTopBottom - grayTopCentered);
    tree.root.justifyContent = 'center';
    tree.bottomBlock.marginTop = 0; // 去掉 auto：让根 justifyContent 平分上下空间
    if (tree.infoRow) tree.infoRow.visible = false; // hero：隐藏统计行（含其 1 行上间距）
    tree.omniTitle.visible = true;
    // 彩虹流动：每行按行号错相（竖向渐变），bannerHue 逐帧旋转 → 颜色沿横幅流动。
    // 亮色主题压暗（浅底上高亮色对比不足）；深色主题提亮。
    const isLight = isLightTheme(theme);
    for (let i = 0; i < tree.omniCells.length; i++) {
      const hue = (state.bannerHue + i * 28) % 360;
      tree.omniCells[i]!.fg = parseColor(hslToHex(hue, 0.8, isLight ? 0.4 : 0.62));
    }
    (tree.status as { visible?: boolean }).visible = false; // hero 下隐藏「就绪」状态栏
    footerTop -= heroOffset; // 浮层/菜单/命令面板/ask 全部按居中后的灰块顶钳制
  } else {
    if (tree.omniTitle) tree.omniTitle.visible = false;
    if (tree.bottomBlock) tree.bottomBlock.marginTop = 'auto';
    if (tree.infoRow) tree.infoRow.visible = true; // 退出 hero：恢复统计行
    tree.root.justifyContent = 'flex-start';
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
    // → 最大内部行数 ≤ footerTop - 3（footerTop = 视口 - 根底内边距(1) - 统计行(1) - 待发送区(pendingRows) - 灰色块(inputLines+4，含圆角边框) - 统计行间距(1)）
    footerTop = (height ?? 24) - 7 - pendingRows - state.inputLines - heroOffset; // 灰色块顶部（0-based 屏幕行；统计行与灰块间距 1 行）；hero 居中模式再减 heroOffset
    if (!state.menu && !state.settingsPanel && state.inputText.startsWith('/')) {
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
      const m = state.menu || state.settingsPanel ? null : detectMention(state.inputText, cursor);
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
  // 模型行（输入框下方，灰色块内，左对齐）：`Build/Plan · 模型名 组名 · 思考级别`
  // ——模式前缀（/plan 计划模式 = Plan，普通 = Build）+ 模型名 + provider 组名 +
  // 思考级别（淡色；按强度着色在下方 footerEffort 单独设置）。loading/esc 已排最左。
  if (tree.footerModel) {
    const lang = state.language;
    const mode = t(lang, state.planMode ? 'footer.mode.plan' : 'footer.mode.build');
    const provider = state.provider ? ` ${state.provider}` : '';
    tree.footerModel.content = tf(lang, 'footer.model', { mode, model: state.model, provider });
  }
  if (tree.footerEffort) {
    tree.footerEffort.content = state.reasoningEffort ? tf(state.language, 'footer.effort', { effort: state.reasoningEffort }) : '';
  }
  // 待发送消息区（输入框上方小视图）：标题行「⏳ 待发送（N · ⚡M 打断）」+ 每条消息带
  // queue/steer 徽标（· 普通排队 / ⚡ 打断优先）+ 选中高亮（› 青色加粗）。
  // 空列表隐藏（不占布局）；行数预算 = pendingRows（computeRows/footerTop 同步减）。
  // 可点击：消息行 y → pending 下标存 pendingRects（鼠标点击选中，见 startTui）——
  // 消息行位于灰色块正上方（footerTop - visibleMsgs .. footerTop - 1）。
  if (tree.queueBox) {
    tree.queueBox.visible = pendingCount > 0;
    tree.pendingRects.clear();
    let idx = 0;
    if (pendingCount > 0) {
      const steerCount = state.pending.filter((m) => m.mode === 'steer').length;
      const c = tree.queueCells[idx++]!;
      c.visible = true;
      const lang = state.language;
      c.content = tf(lang, 'pending.title', {
        q: pendingCount,
        s: steerCount > 0 ? tf(lang, 'pending.steer', { s: steerCount }) : '',
      });
      for (let i = 0; i < pendingVisibleMsgs; i++) {
        const m = state.pending[i]!;
        const t = m.text.replace(/\s+/g, ' ').trim();
        const selected = i === state.pendingSelected;
        const badge = m.mode === 'steer' ? '⚡' : '·';
        const body = `${selected ? '› ' : '  '}${badge} ${t.length > 38 ? `${t.slice(0, 37)}…` : t}`;
        const cell = tree.queueCells[idx++]!;
        cell.visible = true;
        try {
          cell.content = new StyledText([
            {
              __isChunk: true as const,
              text: body,
              fg: parseColor(selected ? theme.accentBlue : theme.footerDim),
              attributes: selected ? TextAttributes.BOLD : 0,
            },
          ]);
        } catch (e) {
          logCrash('pending-row', e);
        }
      }
      if (pendingCount > 4) {
        const c2 = tree.queueCells[idx++]!;
        c2.visible = true;
        c2.content = tf(state.language, 'pending.more', { n: pendingCount - 4 });
      }
    }
    // 未用的池细胞必须隐藏——否则仍占布局行（7 个细胞占 7 行而非 5 行），
    // 总高度超出视口后 yoga 压缩灰色块/待发送区，出现行重叠与内容被裁（探针实测）
    for (; idx < tree.queueCells.length; idx++) {
      tree.queueCells[idx]!.content = '';
      tree.queueCells[idx]!.visible = false;
    }
  }
  if (tree.footerTokens) {
    // footer 统计行（用户要求的格式）：轮次/步数/LLM 与工具耗时/首 token/速率/缓存命中/输入输出；
    // 超宽时按段从右截断（fitFooterStats）。**居中显示在输入区域下方**
    // hero 模式下 infoRow 整体隐藏（见 hero 块），这里只负责正常模式的内容
    const inner = Math.max(1, (width ?? 80) - CONTENT_PAD - 2);
    tree.footerTokens.content = fitFooterStats(buildFooterStats(state), inner);
  }
  // loading（模型行内、模型文本右面）：会话进行中显示旋转帧，
  // Esc/会话结束（state.loading=false）清空；右侧「esc」提示跟随显示/隐藏
  if (tree.footerLoading) {
    tree.footerLoading.content =
      state.loading && state.loadingIndex >= 0 ? SPINNER_FRAMES[state.loadingIndex % SPINNER_FRAMES.length] : '';
  }
  if (tree.footerEsc) {
    tree.footerEsc.content = state.loading ? 'esc' : '';
  }
  // 状态栏可见性：hero 模式（未开始对话）隐藏「就绪」状态，让居中 hero 布局干净；
  // 正常交互模式需 11 行（灰色块 + 统计行 + 状态栏 + 内边距），不足时隐藏状态栏；
  // 单任务模式仅需 4 行——状态栏 2 + 内边距 2）
  tree.status.visible = hero ? false : opts?.withInput ? height >= 11 : height >= 4;
  tree.status.content = state.status;

  // 联想/提及列表内容（/ 命令联想：› /theme 描述；@ 提及：📁/📄 + 路径）。
  // 独立浮层：圆角方框（整体背景 + rounded 圆角），**紧凑下拉**——items 全量匹配，
  // 窗口 = picker.window 行 + 上下各一条「↑/↓ 还有 N 个」提示行（↑/↓ 可滚动到全部，
  // 不再截断成「… 还有 N 个」不可达）；面板底部边框悬停在灰色块上方 1 行。
  // 底色/边框/文字色按主题，选中项强调蓝加粗。
  const sug = state.cmdSuggest;
  const men = state.mention;
  const picker = sug ?? men; // 二选一：/ 命令联想优先；@ 提及仅在非 / 文本时出现
  let suggestTotal = 0;
  if (tree.suggestBox) {
    tree.suggestBox.backgroundColor = theme.suggestBg; // 主题可能切换（/theme 或检测晚到）
    tree.suggestBox.borderColor = parseColor(theme.suggestBorder);
    const visible = !!picker && picker.items.length > 0;
    tree.suggestBox.visible = visible;
    if (visible && picker) {
      // 灰色块顶部（0-based 屏幕行）= 视口 - 根底内边距(1) - 统计行(1) - 统计行间距(1) - 灰色块(inputLines+4，含圆角边框) - 待发送区(pendingRows)；hero 居中模式再减 heroOffset
      const footerTop = (height ?? 24) - 7 - pendingRows - state.inputLines - heroOffset;
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
      // 内部行 → items 下标映射（-1 = 提示行，不可选中/点击）：[↑ 提示?] + 窗口项 + [↓ 提示?]
      const rowMap: number[] = [];
      if (above > 0) rowMap.push(-1);
      for (let k = top; k < top + win; k++) rowMap.push(k);
      if (below > 0) rowMap.push(-1);
      tree.suggestRowMap = rowMap;
      suggestTotal = rowMap.length;
      // 圆角方框：内部行 + 上下边框 2 → 底部边框悬停在灰色块上方 1 行、顶部 ≥1；
      // 左对齐输入框文字列（left 2 + paddingX 1 = 输入文字 x=3）
      tree.suggestBox.top = Math.max(1, footerTop - suggestTotal - 2);
      tree.suggestBox.left = 2;
      // 可点击区域 = 面板内部行（不含边框）：行 i → 事件坐标 y = top + 1 + i
      tree.suggestRect = { top: tree.suggestBox.top + 1, bottom: tree.suggestBox.top + suggestTotal };
    } else {
      tree.suggestRect = null;
      tree.suggestRowMap = [];
    }
  }
  for (let i = 0; i < tree.suggestCells.length; i++) {
    const cell = tree.suggestCells[i];
    if (!picker || i >= suggestTotal) {
      cell.visible = false;
      continue;
    }
    const itemIdx = tree.suggestRowMap[i];
    // 提示行：窗口上方/下方还有 N 个（dim，不可选中/点击；↑/↓ 滚动到全部）
    if (itemIdx < 0) {
      const isTop = i === 0;
      const n = isTop ? picker.top : Math.max(0, picker.items.length - (picker.top + picker.window));
      cell.visible = true;
      try {
        cell.content = new StyledText([
          {
            __isChunk: true as const,
            text: tf(state.language, 'suggest.hint', { arrow: isTop ? '↑' : '↓', n }),
            fg: parseColor(theme.suggestText),
            attributes: 0,
          },
        ]);
      } catch (e) {
        logCrash('suggest-hint', e);
      }
      continue;
    }
    cell.visible = true;
    const selected = itemIdx === picker.selected;
    // 命令联想：/名称 描述（按界面语言取 description/descriptionEn）；@ 提及：📁 目录 / 📄 文件 + 路径（目录以 / 结尾，可继续进入）
    const body = men
      ? `${picker.items[itemIdx].endsWith('/') ? '📁 ' : '📄 '}${picker.items[itemIdx]}`
      : (() => {
          const cmd = findCommand(picker.items[itemIdx]);
          const lang = state.language;
          const desc = lang === 'en' && cmd?.descriptionEn ? cmd.descriptionEn : cmd?.description ?? '';
          return `/${picker.items[itemIdx]}  ${desc}`;
        })();
    const cut = fitCount(body, (width ?? 80) - CONTENT_PAD);
    const text = `${selected ? '› ' : '  '}${cut >= body.length ? body : `${body.slice(0, cut)}…`}`;
    try {
      cell.content = new StyledText([
        {
          __isChunk: true as const,
          text,
          fg: parseColor(selected ? theme.accentBlue : theme.suggestText),
          attributes: selected ? TextAttributes.BOLD : 0,
        },
      ]);
    } catch (e) {
      logCrash('suggest-row', e);
    }
  }

  // 命令面板浮层（/theme alert）与状态行设置面板（/settings statusline）共用：
  // 绝对定位、水平垂直居中、zIndex 高于内容；每帧按视口重算位置，行内容原地更新
  // （细胞池复用，不重建 TextRenderable）。二者互斥（不同时打开）。
  if (tree.menuOverlay) {
    tree.menuOverlay.backgroundColor = theme.suggestBg; // 主题可能切换（/theme 或检测晚到），面板底色跟随刷新
    const menu = state.menu;
    const settings = state.settingsPanel;
    if (!menu && !settings) {
      tree.menuOverlay.visible = false;
      tree.menuRowMap = [];
    } else {
      const panelW = Math.min(Math.max(20, (width ?? 80) - CONTENT_PAD), 44);
      // 窗口滚动预算：面板总高（标题 1 + 窗口 + 上下提示 ≤2 + 操作提示 1 + 底边 1）≤ footerTop - 2
      // （footerTop = 灰色块顶部——面板永不遮住输入区）；上限 12 行（联想浮层 8 行更紧凑）
      const menuMaxVisible = Math.max(2, Math.min(12, footerTop - 7));
      const panelRows = menu
        ? menuPanelRows(menu, panelW, state.language, menuMaxVisible)
        : settingsPanelRows(settings!, panelW, state.language);
      tree.menuOverlay.visible = true;
      // 底边钳制在灰色块上方（同 cmdPanel 面板）：内容少时居中，多时贴灰块上缘
      const centeredTopMenu = Math.max(1, Math.floor(((height ?? 24) - panelRows.length) / 2));
      tree.menuOverlay.top = Math.min(centeredTopMenu, Math.max(1, footerTop - panelRows.length - 1));
      tree.menuOverlay.left = Math.max(1, Math.floor(((width ?? 80) - panelW) / 2));
      // 菜单行 → 选项下标映射（点击命中用；标题 0 / 提示 / 底边 = -1）：
      // 直接取每行自带的 menuIdx（窗口滚动后行与下标不再连续，逐行标记最稳）；
      // 事件坐标 y = overlay.top + 1 + i（与联想浮层 suggestRect 同一坐标系：浮层顶边框占 1 行）
      const rowMap: number[] = [];
      if (menu) {
        for (const r of panelRows) rowMap.push(r.menuIdx ?? -1);
      }
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
    tree.cmdPanelOverlay.backgroundColor = theme.suggestBg; // 主题可能切换（/theme 或检测晚到），面板底色跟随刷新
    const panel = state.cmdPanel;
    if (!panel) {
      tree.cmdPanelOverlay.visible = false;
    } else {
      const panelW = Math.min(Math.max(20, (width ?? 80) - CONTENT_PAD), 72);
      const panelRows = cmdPanelRows(panel, panelW, footerTop, state.language);
      tree.cmdPanelOverlay.visible = true;
      // 面板底边钳制在灰色块上方（footerTop = 灰块顶）：内容少时保持居中，内容多时
      // 贴灰块上缘向上生长——面板永不遮住输入区（此前居中定位会压住输入行/placeholder，
      // 用户「输入提示看不见」的根因；快照场景 43 n) 段帧级实锤）
      const centeredTop43 = Math.max(1, Math.floor(((height ?? 24) - panelRows.length) / 2));
      tree.cmdPanelOverlay.top = Math.min(centeredTop43, Math.max(1, footerTop - panelRows.length - 1));
      tree.cmdPanelOverlay.left = Math.max(1, Math.floor(((width ?? 80) - panelW) / 2));
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

  const rows = computeRows(state, { height, width }, opts);
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
  //（+ thinking / ⚡ 汇总）唯一一行永远点不中，需点别处触发重绘后恰巧命中）。
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
      applyRowToCell(cell, rows[i], theme);
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
  // 待发送消息行的点击区域：底部固定块（待发送区 + 灰色块）被 marginTop:auto 钉在视口
  // 底部，位置是**确定**的（与内容长度/滚动无关）——底部块顶 = 视口 - 根底内边距(1)
  // - 统计行间距(1) - 统计行(1) - 待发送区(pendingRows) - 灰色块(inputLines+4)。
  // 标题行在底部块顶，消息行从 +1 开始：消息 i 在 y = wrapperTop + 1 + i。
  if (pendingCount > 0 && opts?.withInput) {
    tree.pendingRects.clear();
    // hero 居中模式下底部块随根居中上移 heroOffset，命中区同步换算
    const wrapperTop = (height ?? 24) - 7 - pendingRows - state.inputLines - heroOffset;
    for (let i = 0; i < pendingVisibleMsgs; i++) tree.pendingRects.set(wrapperTop + 1 + i, i);
  }
  // ask_user 提问面板（输入区上方）：**竖向勾选列表**——❓ 问题（单选/多选）+ 每行
  // 一个 `[x] A) 选项` + 自定义行（`[ ] 自定义：内容`，有内容自动勾选）+ `✓ 确认（Enter）`
  // 提交行 + 提示行（空间不足时提示行被截，确认行恒保留）。高亮行 `›` 前缀。
  // 输入框内容每帧同步为自定义内容（打字 = 自定义输入，字母/数字不拦截——勾选用空格）。
  if (tree.askBox) {
    const a = state.ask;
    tree.askBox.visible = !!a && !!opts?.withInput;
    tree.askRects.clear();
    if (a && opts?.withInput) {
      tree.askBox.backgroundColor = theme.suggestBg; // 主题可能切换（/theme 或检测晚到）
      tree.askBox.borderColor = parseColor(theme.suggestBorder);
      const lang = state.language;
      // 输入框内容实时同步为自定义输入（打字进输入框 = 自定义答案；提交时一并返回）
      if (tree.input) a.custom = tree.input.plainText;
      const aRows: { text: string; style: { dim?: boolean; bold?: boolean; fg?: string } }[] = [];
      const modeTag = a.multiple ? t(lang, 'ask.multiple') : t(lang, 'ask.single');
      aRows.push({ text: `❓ ${fitAsk(a.question, Math.max(10, (width ?? 80) - 12))}（${modeTag}）`, style: { bold: true } });
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
      const customText = a.custom.trim() ? fitAsk(a.custom.trim(), optCols - 7) : t(lang, 'ask.customPlaceholder');
      aRows.push({
        text: `${curCustom ? '›' : ' '} [${customOn ? 'x' : ' '}] ${t(lang, 'ask.custom')}：${customText}`,
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
      // 面板底 = footer 顶 - pendingRows（待发送区在面板与灰色块之间）；顶 = 底 - 行数（hero 居中再减 heroOffset）
      const aBottom = (height ?? 24) - 6 - state.inputLines - pendingRows - heroOffset;
      const aTop = aBottom - aRows.length;
      // 行 y → 类型：1 起选项行（面板内下标 1+i）、自定义行（下标 1+options.length）、
      // 确认行（下标 2+options.length）
      for (let i = 0; i < a.options.length; i++) {
        tree.askRects.set(aTop + 1 + i, { kind: 'opt', idx: i });
      }
      tree.askRects.set(aTop + 1 + a.options.length, { kind: 'custom' });
      tree.askRects.set(aTop + 2 + a.options.length, { kind: 'confirm' });
    }
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
  // 命令输出面板 / 状态行设置面板浮层打开时忽略鼠标（滚动/点击都不穿透到下层内容，避免误点工具卡片）
  if (state.settingsPanel || state.cmdPanel) return;
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
          submitAsk(state);
          tree.input?.setText(''); // 自定义内容已进结果，清空输入框
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
    // 待发送消息区：点击某条消息 → 选中该条（进入选择态后可 ↑/↓ 移动高亮、
    // ←/→ 排序、Enter 编辑、Backspace/Delete 删除、Esc 退出）
    if (state.pending.length > 0) {
      const pIdx = tree.pendingRects.get(e.y);
      if (pIdx !== undefined) {
        state.pendingSelected = pIdx;
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
 * 竖向勾选列表交互——↑/↓ 移动高亮、**空格勾选/取消**（单选互斥；输入框有内容时
 * 空格放行给输入框——打字优先）、**Enter 确认提交**（勾选选项 + 自定义内容）、
 * Esc 取消（置 askKeyJustConsumed——interactive 据此跳过取消运行）。
 * 字母/数字键恒放行给输入框（= 自定义输入，无选项键冲突）；提交结果含自定义内容。
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
  // Enter：确认提交（勾选项 + 自定义内容；无任何选择时不提交）
  if (n === 'return' || n === 'kpenter' || n === 'linefeed') {
    submitAsk(state);
    tree?.input?.setText(''); // 自定义内容已进结果，清空输入框（下一轮输入干净）
    key.preventDefault();
    paint();
    return;
  }
  // 空格：勾选/取消当前高亮选项（输入框有内容 = 正在输入自定义 → 放行给输入框）
  if (n === 'space') {
    if (!(tree?.input && tree.input.plainText.length > 0) && ask.cursor < ask.options.length) {
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
    }
    return;
  }
  if (n === 'escape' || n === 'esc') {
    // Esc 记录「已被 ask 消费」：interactive 的 Esc=取消运行分支据此跳过取消
    //（取消提问 ≠ 取消对话——模型收到「用户取消」自行决定继续）
    state.askKeyJustConsumed = true;
    state.askResolve?.(null);
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
      if (hint) process.stdout.write(`\n${dim(`💬 恢复此会话：${hint}`)}\n`);
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
        pushLine(state, { kind: 'warn', text: `无法启动编辑器打开 ${file}（设置 $EDITOR）` });
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

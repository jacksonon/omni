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
 *   ▍ 模型 grok-4.5 · 思考 medium  │ 模型+思考强度（淡；左对齐）
 *   ╰──────────────────────────────╯
 *         8 轮 · 65 步| LLM 20m32s · 工具调用 8.6s| …  ← 统计行（灰块下方，居中）
 *
 * 灰色块（输入框 + 模型行，淡灰色背景，四边 16px 圆角）与对话流区分；
 * 左侧**蓝色细线（▍，与对话流用户消息同款）**贴左缘、**竖跨整个灰色背景**（含上下
 * 圆角边框行，用户要求：高度 = 边框 2 + 输入 inputLines + 间距 1 + 模型 1 = inputLines+4，
 * 显式 height 钉住 + marginTop/Bottom:-1 溢出到边框行，不撑大灰块）；高度低（paddingY 0，
 * 灰块 = 圆角边框 2 + 输入 inputLines + 间距 1 + 模型 1 = inputLines+4）。模型行（**左对齐**
 * ——用户要求从右侧移到左侧显示）显示当前模型 + 思考强度（思考强度用稍淡颜色）。
 * 运行中提交分流：Enter = queue（追加待发送列表末尾）；Cmd/Ctrl/Super/Option+Enter = steer
 *（插入最前，打断当前回合优先执行）；/stop 停止当前对话。待发送小视图显示在**灰色块正上方**
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
import { commandSuggestions, findCommand } from './commands.js';
import { logCrash } from './crashlog.js';
import { detectMention, insertMention, listMentionCandidates } from './mention.js';
import { ACCENT_BAR, buildFooterStats, CONTENT_PAD, estimateInputLines, fitCount, fitFooterStats } from './layout.js';
import { isLightTheme, themeColor, themeFor, type TuiTheme } from './theme.js';
import { SPINNER_FRAMES, type CmdSuggestion, type MentionSuggestion, type TuiState } from './state.js';
import { visualWidth } from './width.js';
import {
  cmdPanelRows,
  computeRows,
  hitTestApproval,
  hitTestCard,
  hitTestThinking,
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
  menuPanelRows,
  rowStyle,
  type CardRect,
  type Row,
  type RowStyle,
} from './rows.js';
export { themeColor, themeFor, isLightTheme, type TuiTheme } from './theme.js';

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
  /** 灰色块（输入行 + 模型行，交互模式非 null；单次任务模式为 null） */
  footerBox: BoxRenderable | null;
  /** 灰色块左侧蓝色细线（▍，与对话流用户消息同款）：紧贴左缘、竖跨整个灰色背景（含上下边框行） */
  blueLine: TextRenderable | null;
  input: TextareaRenderable | null;
  /** 模型行 / 思考强度 / 统计行（repaintTree 每次刷新内容） */
  footerModel: TextRenderable | null;
  /** 思考强度（`· 思考 medium`，淡色；未设置思考级别时为空） */
  footerEffort: TextRenderable | null;
  footerTokens: TextRenderable | null;
  /** 输入区域右侧 loading（灰色块内右缘，与模型行对齐；会话进行中转，Esc/会话结束消失） */
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
  /** 命令输出面板浮层（所有 / 命令的独立窗口：绝对定位居中，不占用内容流/不参与滚动） */
  cmdPanelOverlay: BoxRenderable | null;
  cmdPanelCells: TextRenderable[];
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
    // 圆角边框 2 + 输入 + 间距 + 模型行）由 repaintTree 每次重绘按最新 inputLines
    // 同步；marginTop/Bottom -1 使 margin-box 与内容列同高不撑大灰块，同时渲染起点
    // 上移 1 行盖住顶边框、向下溢到底边框——**竖跨整个灰色背景**（用户要求）。
    // bg 与灰块同色，折行/增高时连续
    blueLine = new TextRenderable(ctx, { content: '', wrapMode: 'none', marginLeft: -1, marginTop: -1, marginBottom: -1 });
    blueLine.fg = parseColor(theme.accentBlue);
    blueLine.bg = parseColor(theme.footerBg);
    footerBox.add(blueLine);

    // 内容列：paddingX 1 让输入文字与圆角边框保持 1 列间距（细线让 1 列）；
    // **paddingY 0**（用户要求输入区域高度变低：灰块从 inputLines+6 降为 inputLines+4，
    // 去掉上下 padding 2 行——圆角边框本身已提供上下视觉边界）；
    // gap:1 在输入框与模型行之间留 1 行间距（用户要求，细线连续穿过间距）
    const contentCol = new BoxRenderable(ctx, {
      flexDirection: 'column',
      flexGrow: 1,
      gap: 1,
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
      placeholder: '输入消息，Enter 发送；Shift+Enter 换行',
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

    // 模型行（输入框下方，灰色块内，**左对齐**——用户要求从右侧移到左侧显示）：
    // 模型 + 思考强度（淡色）。发送/取消按钮已移除（TUI 无点击交互，改用 /stop
    // 命令 + Enter 排队 + Cmd/Ctrl+Enter steer）
    const modelRow = new BoxRenderable(ctx, {
      flexDirection: 'row',
      justifyContent: 'flex-start',
      alignItems: 'center',
      gap: 1,
    });
    footerModel = new TextRenderable(ctx, { content: '', wrapMode: 'none' });
    footerModel.fg = parseColor(theme.footerText);
    footerEffort = new TextRenderable(ctx, { content: '', wrapMode: 'none' });
    footerEffort.fg = parseColor(theme.footerDim); // 思考强度用稍淡的颜色
    modelRow.add(footerModel);
    modelRow.add(footerEffort);
    contentCol.add(modelRow);

    // **右侧 loading**（用户要求「显示在输入区域右侧，和模型 id 那一行对齐」）：
    // 灰色块内右缘（contentCol 之后），marginTop:auto 吸收上方空间把它推到灰块
    // 最内底行——即模型行（contentCol 底部一行）同一行；会话进行中转圈
    //（state.loading + loadingIndex），Esc/会话结束 stopLoading 消失。
    footerLoading = new TextRenderable(ctx, {
      content: '',
      wrapMode: 'none',
      marginLeft: 1,
      marginTop: 'auto',
    });
    footerLoading.fg = parseColor(theme.accentBlue); // 蓝色转圈，与左侧蓝色细线同色系
    // loading 右侧「esc」取消提示（用户要求「loading 按钮右侧增加 esc 文本」）：
    // 淡色小字，同款 marginTop auto 与模型行对齐；跟随 loading 显示/隐藏
    footerEsc = new TextRenderable(ctx, {
      content: '',
      wrapMode: 'none',
      marginLeft: 1,
      marginTop: 'auto',
      attributes: createTextAttributes({ dim: true }),
    });
    footerEsc.fg = parseColor(theme.footerDim);
    footerBox.add(contentCol);
    footerBox.add(footerLoading); // 在 contentCol 之后 → 灰块右缘
    footerBox.add(footerEsc); // loading 右侧
  }

  // 子节点顺序：内容行（动态）→ 状态栏 → 灰色块（marginTop:auto 钉底）→ 统计行
  const status = new TextRenderable(ctx, {
    content: '',
    attributes: createTextAttributes({ dim: true }),
    wrapMode: 'none',
  });
  root.add(status);

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
  const menuOverlay = new BoxRenderable(ctx, { position: 'absolute', zIndex: 10, visible: false });
  root.add(menuOverlay);
  const menuCells: TextRenderable[] = [];
  for (let i = 0; i < 8; i++) {
    const c = new TextRenderable(ctx, { content: '', wrapMode: 'none' });
    menuOverlay.add(c);
    menuCells.push(c);
  }

  // 命令输出面板浮层（所有 / 命令的独立窗口）：绝对定位居中（top/left 每帧重算），
  // 与 /theme 菜单浮层同级（zIndex 10，二者不同时打开）。细胞池预分配充足行数
  // （可见主体行 ≤ 视口-6，60 行覆盖超高视口；不参与内容流/滚动）。
  const cmdPanelOverlay = new BoxRenderable(ctx, { position: 'absolute', zIndex: 10, visible: false });
  root.add(cmdPanelOverlay);
  const cmdPanelCells: TextRenderable[] = [];
  for (let i = 0; i < 60; i++) {
    const c = new TextRenderable(ctx, { content: '', wrapMode: 'none' });
    cmdPanelOverlay.add(c);
    cmdPanelCells.push(c);
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

  // 底部固定块：**待发送消息区 + 灰色块** 一起钉在视口底部（marginTop:auto 吸收
  // 自由空间——待发送区永远紧贴输入框上方，不随内容浮动；点击命中区域因此确定）。
  // 空待发送时 queueBox 不可见（不占布局），底部块只剩灰色块，行为与之前一致。
  const bottomBlock = new BoxRenderable(ctx, {
    flexDirection: 'column',
    marginTop: 'auto',
  });
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
    footerBox,
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
    approvalRect: null,
    suggestBox,
    suggestCells,
    suggestRect: null,
    suggestRowMap: [],
    menuOverlay,
    menuCells,
    cmdPanelOverlay,
    cmdPanelCells,
  };
  repaintTree(ctx, tree, state, opts);
  return tree;
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
    tree.input.backgroundColor = theme.inputBg;
  }
  if (tree.footerModel) tree.footerModel.fg = parseColor(theme.footerText);
  if (tree.footerEffort) tree.footerEffort.fg = parseColor(theme.footerDim);
  if (tree.footerTokens) tree.footerTokens.fg = parseColor(theme.footerDim);
  // 待发送消息区（输入框上方小视图）行数预算：标题 1 + 最多 4 条消息 + 超出时「还有 N 条」1 行。
  // 由 computeRows / footerTop（联想浮层）共用——预算同步收缩，灰色块永远完整可见。
  const pendingCount = state.pending.length;
  const pendingVisibleMsgs = Math.min(4, pendingCount);
  const pendingRows = pendingCount > 0 ? 1 + pendingVisibleMsgs + (pendingCount > 4 ? 1 : 0) : 0;
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
  // 蓝色细线：按最新 inputLines 同步——内容 = 圆角边框 2 + 内部（输入 + 间距 + 模型）
  // = inputLines + 4 行；显式 height 钉到 inputLines + 4，marginTop/Bottom -1 使
  // **margin-box = inputLines + 2 与内容列同高（不撑大灰块）**，渲染起点上移 1 行
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
    // → 最大内部行数 ≤ footerTop - 3（footerTop = 视口 - 根底内边距(1) - 统计行(1) - 待发送区(pendingRows) - 灰色块（圆角边框 2 行））
    const footerTop = (height ?? 24) - 7 - pendingRows - state.inputLines; // 灰色块顶部（0-based 屏幕行；统计行与灰块间距 1 行）
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
  // 模型行（输入框下方，灰色块内，左对齐）：模型 + 思考强度（淡色；用户要求移到左侧）
  // 计划模式（/plan）：模型行追加常驻指示「· 计划模式」——用户随时知道自己处于只读调研态
  if (tree.footerModel) {
    tree.footerModel.content = state.planMode ? `模型 ${state.model} · 计划模式` : `模型 ${state.model}`;
  }
  if (tree.footerEffort) {
    tree.footerEffort.content = state.reasoningEffort ? `· 思考 ${state.reasoningEffort}` : '';
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
      c.content = `⏳ 待发送（${pendingCount}${steerCount > 0 ? ` · ⚡ ${steerCount} 打断` : ''}）`;
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
        c2.content = `  · 还有 ${pendingCount - 4} 条…`;
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
    const inner = Math.max(1, (width ?? 80) - CONTENT_PAD - 2);
    tree.footerTokens.content = fitFooterStats(buildFooterStats(state), inner);
  }
  // 右侧 loading（灰色块内右缘、与模型行对齐）：会话进行中显示旋转帧，
  // Esc/会话结束（state.loading=false）清空；右侧「esc」提示跟随显示/隐藏
  if (tree.footerLoading) {
    tree.footerLoading.content =
      state.loading && state.loadingIndex >= 0 ? SPINNER_FRAMES[state.loadingIndex % SPINNER_FRAMES.length] : '';
  }
  if (tree.footerEsc) {
    tree.footerEsc.content = state.loading ? 'esc' : '';
  }
  // 视口过小时隐藏状态栏，优先保证底部完整可见
  //（交互模式需 11 行：灰色块 7（圆角边框 2 + paddingY 2 + 输入 1 + 间距 1 + 模型 1）+ 统计行 1 + 状态栏 1 + 内边距 2；单任务模式仅需 3 行）
  tree.status.visible = opts?.withInput ? height >= 9 : height >= 3;
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
      // 灰色块顶部（0-based 屏幕行）= 视口 - 根底内边距(1) - 统计行(1) - 灰色块(inputLines+4，含圆角边框) - 待发送区(pendingRows)
      const footerTop = (height ?? 24) - 7 - pendingRows - state.inputLines;
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
            text: `  ${isTop ? '↑' : '↓'} 还有 ${n} 个（↑/↓ 滚动）`,
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
    // 命令联想：/名称 描述；@ 提及：📁 目录 / 📄 文件 + 路径（目录以 / 结尾，可继续进入）
    const body = men
      ? `${picker.items[itemIdx].endsWith('/') ? '📁 ' : '📄 '}${picker.items[itemIdx]}`
      : `/${picker.items[itemIdx]}  ${findCommand(picker.items[itemIdx])?.description ?? ''}`;
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
    const menu = state.menu;
    const settings = state.settingsPanel;
    if (!menu && !settings) {
      tree.menuOverlay.visible = false;
    } else {
      const panelW = Math.min(Math.max(20, (width ?? 80) - CONTENT_PAD), 44);
      const panelRows = menu ? menuPanelRows(menu, panelW) : settingsPanelRows(settings!, panelW);
      tree.menuOverlay.visible = true;
      tree.menuOverlay.top = Math.max(1, Math.floor(((height ?? 24) - panelRows.length) / 2));
      tree.menuOverlay.left = Math.max(1, Math.floor(((width ?? 80) - panelW) / 2));
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
    const panel = state.cmdPanel;
    if (!panel) {
      tree.cmdPanelOverlay.visible = false;
    } else {
      const panelW = Math.min(Math.max(20, (width ?? 80) - CONTENT_PAD), 72);
      const panelRows = cmdPanelRows(panel, panelW, height ?? 24);
      tree.cmdPanelOverlay.visible = true;
      tree.cmdPanelOverlay.top = Math.max(1, Math.floor(((height ?? 24) - panelRows.length) / 2));
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

  const rows = computeRows(state, { height, width }, opts);
  const anchor = tree.status; // 内容行始终插在状态栏之前（联想列表是独立浮层，不在内容流里）
  while (tree.cells.length < rows.length) {
    // 池增长：新建细胞插到状态栏前（一次原生分配；此后原位更新不再分配）
    const cell = new TextRenderable(ctx, { content: '', wrapMode: 'none' });
    tree.cells.push(cell);
    tree.root.insertBefore(cell, anchor);
  }
  // 刷新卡片/思考/审批命中区域：内容行 i 的鼠标事件坐标 y = i（0-based；无边框，屏幕行 1+i 减 1）。
  // 供点击 handler 把点击坐标映射回卡片/思考行/审批卡（见 startTui、CardRect、hitTestThinking 注释）。
  tree.cardRects.clear();
  tree.thinkingRects.clear();
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
    const cardId = rows[i].cardId;
    if (cardId !== undefined) {
      const y = i;
      const rect = tree.cardRects.get(cardId);
      if (rect) rect.bottom = y;
      else tree.cardRects.set(cardId, { top: y, bottom: y });
    }
    const thinkingIdx = rows[i].thinkingIdx;
    if (thinkingIdx !== undefined) tree.thinkingRects.set(i, thinkingIdx);
    if (rows[i].approvalId !== undefined) {
      if (tree.approvalRect) tree.approvalRect.bottom = i;
      else tree.approvalRect = { top: i, bottom: i };
    }
  }
  // 待发送消息行的点击区域：底部固定块（待发送区 + 灰色块）被 marginTop:auto 钉在视口
  // 底部，位置是**确定**的（与内容长度/滚动无关）——底部块顶 = 视口 - 根底内边距(1)
  // - 统计行间距(1) - 统计行(1) - 待发送区(pendingRows) - 灰色块(inputLines+4)。
  // 标题行在底部块顶，消息行从 +1 开始：消息 i 在 y = wrapperTop + 1 + i。
  if (pendingCount > 0 && opts?.withInput) {
    tree.pendingRects.clear();
    const wrapperTop = (height ?? 24) - 7 - pendingRows - state.inputLines;
    for (let i = 0; i < pendingVisibleMsgs; i++) tree.pendingRects.set(wrapperTop + 1 + i, i);
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

/** 创建 TUI 会话：建树 + 首帧，返回 paint/stop/input/onKeyPress */
export async function startTui(state: TuiState, opts?: { withInput?: boolean }): Promise<TuiSession> {
  const renderer = await createCliRenderer({ exitOnCtrlC: true });
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

  // 鼠标滚轮滚动：OpenTUI 上报 SGR 滚轮事件（\e[<64/65;x;yM）并沿渲染树冒泡到根 Box。
  // 在根 Box 上挂处理器（实例属性遮蔽原型 onMouseEvent 方法，属刻意为之）：
  // 滚轮上/下 → 滚动意图（每格约 3 行），与键盘滚动同一套机制；只在 scroll 类型事件时
  // 消费，点击/移动保持默认行为（不干扰输入框聚焦）。同方向连续滚轮累加步长——
  // 帧执行期间到达的多格并入同一意图，由尾沿补帧一次性消费，快速连滚不丢格。
  (tree.root as unknown as { onMouseEvent?: (e: MouseEventLike) => void }).onMouseEvent = (e) => {
    // 菜单 / 设置面板 / 命令输出面板浮层打开时忽略鼠标（滚动/点击都不穿透到下层内容，避免误点工具卡片）
    if (state.menu || state.settingsPanel || state.cmdPanel) return;
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
    // ④ 命中工具卡片 → 切换展开/收起。
    // 坐标语义：MouseEvent.y 为 0-based（实测 SGR y 减 1）；repaintTree 已把
    // 每个可见卡片/思考行按事件坐标登记（内容行 i → y = i）。
    if (e.type === 'down' && e.button === 0 && typeof e.y === 'number') {
      // 审批卡片优先级最高：命中即按点击列批准/拒绝（左半批准、右半拒绝）
      if (hitTestApproval(state, tree.approvalRect, e.y)) {
        const allow = typeof e.x === 'number' && e.x < ((ctx as { width?: number }).width ?? 80) / 2;
        state.approvalResolve?.(allow);
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
      if (hitTestThinking(state, tree.thinkingRects, e.y)) void paint();
      else if (hitTestCard(state, tree.cardRects, e.y)) void paint();
    }
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

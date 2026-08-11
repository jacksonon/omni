/**
 * TUI 状态：Agent 运行过程的可变状态（纯对象，无响应式依赖）。
 *
 * 由 TuiOutput 写入，render 层在每次 paint 时读取并重建渲染树。
 * 模型：一列"段落"（TuiLine），paint 时按 \n 拆成多行。
 */
import type { TokenUsage } from '../output/types.js';

/** spinner 动画帧（braille 点阵） */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * 终端主题设置（/theme 命令可切换）：
 *   · system = 跟随系统（默认，按终端背景亮度自动检测）
 *   · light / dark = 手动强制
 */
export type TuiThemeMode = 'system' | 'light' | 'dark';

export type TuiLineKind =
  | 'thinking' // 💭 思考（浅色）
  | 'answer' // 最终回答（默认色）
  | 'user' // 用户消息（白字灰底 + 蓝色细线，无 ❯ 前缀）
  | 'meta' // 元信息（浅色）
  | 'warn' // 警告（黄色）
  | 'task' // 任务标题（青色加粗）
  | 'tool'; // 工具调用卡片（可点击展开/收起）

/** 工具卡片状态：执行中 / 成功 / 失败 */
export type ToolStatus = 'running' | 'ok' | 'err';

/**
 * 工具调用卡片数据（kind === 'tool' 时由 TuiLine.card 携带）。
 * 渲染成圆角方框：标题 + 摘要 + 状态；完成后默认收起，点击展开输出。
 */
export interface ToolCard {
  id: number;
  name: string;
  /** 人类可读摘要（如 `$ echo mock-ok`） */
  summary: string;
  status: ToolStatus;
  /** 输出预览行（previewOutput 前 5 行） */
  output: string[];
  /** 是否展开显示输出 */
  expanded: boolean;
  /** 工具返回的字符数（收起态执行缩略行显示） */
  chars?: number;
}

export interface TuiLine {
  kind: TuiLineKind;
  text: string;
  /** kind === 'tool' 时携带卡片数据 */
  card?: ToolCard;
}

/** 内容区滚动意图（一次性，由 computeRows 在下次重绘时消费） */
export type ScrollAction = 'line-up' | 'line-down' | 'page-up' | 'page-down' | 'top' | 'bottom';

/** 滚动意图；lines 为逐行滚动步长（鼠标滚轮一格约 3 行） */
export interface ScrollIntent {
  action: ScrollAction;
  lines?: number;
}

/** 命令面板（/theme 等）：圆角方框 + 可选项，↑/↓ 或数字选择、Enter 确认、Esc 取消 */
export interface TuiMenu {
  /** 面板 id（选择后按 id 分发处理） */
  id: string;
  /** 面板标题（如「主题」） */
  title: string;
  options: { label: string; value: string }[];
  /** 当前高亮的选项下标（› 光标） */
  selectedIndex: number;
  /** 当前生效的值（✓ 标记） */
  currentValue: string;
}

/**
 * 斜杠命令联想列表（输入框内容以 / 开头时显示在输入框上方）。
 *
 * 非模态：用户可继续输入（列表按最新文本过滤，无匹配自动隐藏）；
 * ↑/↓ 移动高亮、Tab 填入命令、Enter 直接执行高亮命令、Esc 关闭。
 * 由 repaintTree 在 paint 时按输入框最新文本刷新（互不影响输入）。
 */
export interface CmdSuggestion {
  /** / 后面的已输入部分（用于过滤） */
  query: string;
  /** 匹配的命令名（name 与 aliases） */
  items: string[];
  /** 当前高亮下标 */
  selected: number;
}

export interface TuiState {
  lines: TuiLine[];
  status: string;
  model: string;
  version: string;
  /** 内容区滚动位置：null = 跟随最新（自动）；数字 = 视口首行索引（上滚状态） */
  scrollTop: number | null;
  /** 待消费的滚动意图（按键/滚轮 → computeRows 消费，避免滚动数学散落在事件层） */
  scrollIntent: ScrollIntent | null;
  /**
   * 输入框当前内容行数（1-5，多行编辑自动增高）。repaintTree 每次从
   * 输入框的 lineCount 实时同步；computeRows 用它精确计算内容区预算——
   * 输入框变高时内容区相应减少，状态栏/输入框永远不会被挤出去。
   */
  /** spinner 帧索引（-1 = 不显示） */
  spinnerIndex: number;
  /** 是否正在流式生成回答（显示光标在末尾） */
  generating: boolean;
  /**
   * 是否展开显示全部思考过程（/thinking 命令切换；默认 true = 当前行为——
   * 思考实时完整保留在屏幕）。false = 每个思考段落折叠成一行摘要。
   * 会话级状态（/clear 不清除），buildBody 渲染时读取。
   */
  thinkingExpanded: boolean;
  /**
   * 折叠态（thinkingExpanded=false）下**单独展开**的思考行下标集合：
   * 点击某条折叠摘要可只展开该条（再次点击收起；与工具卡片同交互）。
   * 下标 = state.lines 中的索引（流式 appendLine 只追加不插入，下标稳定）；
   * /thinking 切换或 /clear 清空。
   */
  expandedThinking: Set<number>;
  inputLines: number;
  /** 当前工作目录（footer 左下角显示，超长中段省略） */
  cwd: string;
  /**
   * 会话标题（首轮对话结束后由模型自动概括生成，设为**终端窗口/标签页标题**
   * （setTerminalTitle，OSC 0），不显示在信息流里；null = 尚未生成/生成失败）。
   * 会话级状态，/clear 不清除；渲染层不读它，仅 interactive.ts 作「生成一次」的守卫。
   */
  sessionTitle: string | null;
  /** 会话累计 token 用量（footer 右下角显示，来自每次响应的 usage） */
  tokens: TokenUsage;
  /**
   * 终端主题设置（system/light/dark，/theme 可切换）：
   * system 时按 detectedTheme（终端实测）取色。
   */
  themeMode: TuiThemeMode;
  /** 终端实测主题（OpenTUI 按背景亮度检测，OSC 查询；system 模式用） */
  detectedTheme: 'dark' | 'light';
  /** 当前打开的命令面板（null = 无面板；打开时键盘事件由面板消费） */
  menu: TuiMenu | null;
  /** 命令联想列表（null = 不显示；paint 时按输入框文本刷新） */
  cmdSuggest: CmdSuggestion | null;
  /** 输入框当前文本（repaintTree 同步，buildBody/联想共用） */
  inputText: string;
  /**
   * 用户按 Esc 关闭联想时的输入框文本（非 null = 保持隐藏）。
   * 文本一旦变化（继续输入/删除）→ 联想恢复；同文本重绘不复活列表。
   * 避免 repaintTree 每次按 inputText 重新生成列表导致 Esc 失效。
   */
  cmdSuggestDismissedText: string | null;
}

export function createTuiState(): TuiState {
  return {
    lines: [],
    status: '',
    model: '',
    version: '',
    scrollTop: null,
    scrollIntent: null,
    spinnerIndex: -1,
    generating: false,
    thinkingExpanded: true,
    expandedThinking: new Set(),
    inputLines: 1,
    cwd: process.cwd(),
    sessionTitle: null,
    tokens: { prompt: 0, completion: 0, total: 0 },
    themeMode: 'system',
    detectedTheme: 'dark',
    menu: null,
    cmdSuggest: null,
    inputText: '',
    cmdSuggestDismissedText: null,
  };
}

/** 追加一个段落 */
export function pushLine(state: TuiState, line: TuiLine): void {
  state.lines.push(line);
}

/** 若最后一段 kind 相同则追加文本，否则新起一段（用于流式内容累积） */
export function appendLine(state: TuiState, kind: TuiLineKind, text: string): void {
  const last = state.lines[state.lines.length - 1];
  if (last && last.kind === kind) {
    last.text += text;
  } else {
    state.lines.push({ kind, text });
  }
}

/** 清空全部内容行（/clear 命令） */
export function clearLines(state: TuiState): void {
  state.lines.length = 0;
  state.scrollTop = null;
  state.scrollIntent = null;
  state.expandedThinking.clear(); // 行下标失效，单独展开标记一并清空
}

/**
 * Agent 层共享类型。
 */
import type { ContextOptions } from './context.js';
import type { EventRecorder } from './events.js';
import type { HookRunner } from '../hooks/index.js';
import type { ApprovalRequest, PermissionTier } from '../safety/index.js';
import type { Tool } from '../tools/index.js';
import type { AskResult } from '../tools/ask.js';
import type { UndoStack } from '../tools/undo.js';

export interface RunOptions {
  tools: Tool[];
  /** 是否把模型的思考与工具调用过程实时打印到终端 */
  stream?: boolean;
  /** 最大循环步数，防止死循环 */
  maxSteps?: number;
  /** 是否在终端展示思考过程（默认 true；关闭后仍会捕获并落盘 .omni/last-thinking.md） */
  showThinking?: boolean;
  /** 安全护栏：权限分级（缺省 full = 直通，兼容旧调用） */
  permission?: PermissionTier;
  /** 工作区信任（attachRuntime 设置；false = 未信任目录，只读降级 + 跳过项目级配置） */
  trusted?: boolean;
  /** TodoWrite 任务清单（P1：模型维护结构化 todo；todo_write 工具更新，/status 查看） */
  todoList?: { content: string; status: 'in_progress' | 'completed' | 'pending' }[];
  /** OS 级沙箱档位（attachRuntime 注入；run_command 包装用，/status 展示） */
  sandbox?: import('../safety/sandbox.js').SandboxMode;
  /** 安全护栏：是否写审计日志 */
  auditLog?: boolean;
  /**
   * 安全护栏：工具审批回调（console readline / TUI 审批卡片；由入口注入）。
   * 缺省 = 拒绝（fail-safe）——未接入审批 UI 的环境不会静默放行危险操作。
   */
  requestApproval?: (req: ApprovalRequest) => Promise<boolean> | boolean;
  /**
   * 向用户提问（ask_user 工具回调；console readline / TUI 选项面板；由入口注入）。
   * 返回 null = 用户取消（Esc / 非交互无法询问）——模型据此自行决定继续。
   */
  askUser?: (question: string, options: string[]) => Promise<AskResult | null>;
  /** 上下文管理：相关文件预载 + 长对话摘要压缩（由入口按配置注入；缺省 = 关闭） */
  context?: ContextOptions;
  /**
   * 计划模式（/plan 切换）：只对模型暴露只读工具（read_file/list_directory/search_code），
   * 并在系统提示词追加只读说明——模型只调研、输出实施计划，不直接修改。
   */
  planMode?: boolean;
  /**
   * 会话持久化文件（JSONL 落盘路径；交互模式由入口创建，每轮对话结束追加消息，
   * 退出时刷新 meta。CLI/TUI 交互循环读取，单任务模式不落盘）。
   */
  sessionPath?: string;
  /**
   * /undo 撤销栈（入口 attachRuntime 创建并包装 write_file 工具）：写操作前快照，
   * 交互模式 /undo 命令 pop 恢复；主循环与子代理共用包装后的工具表。
   */
  undoStack?: UndoStack;
  /**
   * 共用 Safety 闸门实例（attachRuntime 注入，delegate 子代理用它）：
   * /permission 运行时切换档位时同步 setTier，让子代理与主循环权限一致。
   */
  safetyGate?: import('../safety/index.js').Safety;
  /**
   * 模型思考级别（reasoning_effort，OpenAI 系 low/medium/high）。
   * /variants 命令切换；loop 请求带该参数（网关不认时自动回退不带）。
   */
  reasoningEffort?: string;
  /**
   * 取消信号（交互模式每轮创建，Esc / 运行中 Ctrl+Enter（steer）触发）：
   * 中断当前流式响应。流中断后优雅结束本轮（已输出内容保留，半截 assistant 消息
   * 不入上下文）；steer 打断时 loop 经 takeInterrupt 取走消息后**换新信号继续
   * 本回合**（rearmAbort），交互层 cancelRun 始终 abort 最新信号。
   */
  abortSignal?: AbortSignal;
  /**
   * 运行中打断（steer，Cmd/Ctrl+Enter）消息槽：交互层（TUI interactive）在运行中按
   * 修饰键+Enter 时把消息写进槽并 abort 当前流；loop 在流中断（AbortError）后经
   * takeInterrupt 取走消息、push 进 messages（作为当前轮的新 user 消息）并在
   * **同一轮内继续**——模型直接回答打断消息，不结束本轮（轮数不增）。
   * interruptPending 为只读探测（判断 abort 是打断还是取消：Esc 取消时
   * 槽为空 → 优雅结束本轮）。回合自然结束时槽中残留的消息由交互层转入待发送
   * 列表（steer 插最前，下一轮发送）——不丢失。console 端不设置（无打断入口）。
   */
  interruptPending?: () => boolean;
  takeInterrupt?: () => string | null;
  /**
   * 换新取消信号回调（interactive 实现）：loop 消费打断消息后调用——旧信号已 abort，
   * 不复位则同一轮内后续的 LLM 请求立刻抛 AbortError；换新后继续的本回合仍可被
   * Esc 取消（交互层 cancelRun 指向最新控制器）。
   */
  rearmAbort?: () => void;
  /**
   * 轨迹事件记录器（/trace 数据源）：loop 在轮生命周期/LLM 请求/工具调用/压缩
   * 等关键节点直驱写入（不依赖 Output——单任务模式也记录）。交互入口
   * （prepareSessionPersistence）创建并注入；每轮对话结束经 persistTurn flush
   * 进会话文件（`{"t":"ev"}` 行）。恢复会话时 open 载入历史事件续号。
   */
  events?: EventRecorder;
  /** /variants 支持的思考级别选项（来自配置 reasoningEffortOptions） */
  reasoningEffortOptions?: string[];
  /** 子代理最大循环步数（/agents 展示用；attachRuntime 注入） */
  maxSubagentSteps?: number;
  /**
   * 可用模型端点列表（顶层 model + config `models`；/model 切换用）。
   * attachRuntime 从 cfg 展开注入；interactive 按名字找到目标端点重建 client。
   */
  models?: { name: string; baseURL?: string; apiKey?: string; userAgent?: string; reasoningEffortOptions?: string[]; reasoningEffort?: string }[];
  /**
   * 当前模型运行时引用（主循环与 delegate 子代理共用）：
   * /model 切换时重建 client 并更新此引用 → 子代理与主循环模型一致。
   */
  modelRuntime?: import('../client.js').ModelRuntime;
  /**
   * 非 MCP 的基础工具链（静态 + delegate；/mcp 重连时以此为基底重建 runOpts.tools）。
   * attachRuntime 注入。
   */
  baseTools?: Tool[];
  /**
   * MCP 服务器配置（/mcp 命令列出/重连/增删用；attachRuntime 从 cfg 注入）。
   */
  mcpServers?: Record<string, import('../tools/mcp.js').McpServerConfig>;
  /**
   * MCP 服务器发现句柄（工具 + 资源 + 提示词 + instructions）：
   * attachRuntime 发现后注入，/mcp 命令据此列出 resources/prompts，重连时更新。
   */
  mcpHandles?: import('../tools/mcp.js').McpServerHandle[];
  /**
   * Hooks 生命周期自动化运行器（入口 attachRuntime 按配置创建）：
   * loop 在工具调用前（PreToolUse）/后（PostToolUse）、回合结束（Stop）触发；
   * 交互层在用户提交时（UserPromptSubmit）触发；Notification 会话完成 fire-and-forget。
   * 缺省 undefined = 未配置 hooks（全部 no-op）。
   */
  hooks?: HookRunner;
  /**
   * 完整配置对象（/status /context /doctor /config 等命令读取字段；attachRuntime 注入）。
   */
  cfg?: import('../config/index.js').OmniConfig;
  /**
   * 附加系统提示段（headless exec `--output-schema` 用：要求模型以 JSON 输出）。
   * loop 拼进每个 system 提示（与 SessionStart 注入同位置，不污染消息历史）。
   */
  systemNote?: string;
  /**
   * architect/editor 模型路由（第六节 P1）：
   * · architect —— /plan 计划模式使用的强推理模型（缺省 = 当前模型）
   * · editor   —— 执行模式使用的轻量模型（缺省 = 当前模型）
   * loop 每轮按 planMode 选模型名（同一客户端/端点下发——不同端点模型的路由
   * 需重建 client，超出 MVP，见 /model 多端点）；delegate 子代理同规则。
   * 来自配置 architect / editor 字段；attachRuntime 注入。
   */
  architectModel?: string;
  editorModel?: string;
  /**
   * 已发现的子代理定义（.agents/subagents/*.md；delegate 的 agent 参数选用）。
   * attachRuntime 注入。
   */
  subagents?: import('./subagent-defs.js').SubagentDef[];
  /**
   * 子代理最大嵌套深度（第六节 P1：子代理可再委托，5 层上限；默认 5）。
   * attachRuntime 注入；delegate 工具按深度决定是否给子代理再挂 delegate。
   */
  maxSubagentDepth?: number;
}

/**
 * 子代理进度事件（第六节 P1 可视化）：delegate 子代理生命周期——
 * start（开始）/ step（内部每步 LLM 请求）/ end（完成，含结果摘要）。
 * 由 runSubagent 直驱，经 delegate 工具闭包分发：
 *  · Output.onSubagentEvent（TUI 更新 delegate 卡片 live 状态 / console 打印 dim 行）
 *  · EventRecorder（/trace 面板嵌套树——subagent/start·step·end 轨迹事件）
 * 嵌套子代理的 parentId 关联父代理 id，depth 表达层级（0 = 主代理直接委托）。
 */
export interface SubagentEvent {
  type: 'start' | 'step' | 'end';
  /** 子代理实例 id（每次调用递增，进程内唯一） */
  id: string;
  /** 父代理 id（null = 主代理直接委托） */
  parentId: string | null;
  /** 嵌套深度（0 = 主代理直接委托；每层 +1） */
  depth: number;
  /** 子代理名（delegate 的 agent 参数选用的定义名；缺省 'delegate'） */
  name: string;
  /** 委托任务（start 事件携带） */
  task?: string;
  /** step 事件：当前步数 / 步数上限 */
  step?: number;
  maxSteps?: number;
  /** step 事件（工具执行前补发）：当前正在执行的工具名（思考/请求中无此字段） */
  tool?: string;
  /** end 事件：成功 / 失败 */
  status?: 'ok' | 'err';
  /** end 事件：结论文本摘要 */
  summary?: string;
  /** end 事件：实际步数 / 耗时 ms */
  steps?: number;
  durationMs?: number;
}

/** 思考块展示（仅 TTY）。思考内容实时显示后保留在屏幕上，不再折叠。 */
export interface ThinkingDisplay {
  readonly shown: boolean;
  /**
   * 开始思考区（可选）：收到消息/新一轮请求开始（onRound）时**立即创建 thinking 模块**
   *（loading + thinking + 实时耗时）——不等首个流式 chunk（用户要求）。TUI 实现；
   * console/NOOP 无此需求可省略。
   */
  start?(): void;
  /** 追加一段思考内容（逐字符实时显示，遇到 \n 或超过终端宽度时换行） */
  write(piece: string): void;
  /** 结束思考区：若最后一行未换行则补一个换行，让后续正文/步骤日志从新行开始 */
  finish(): void;
}

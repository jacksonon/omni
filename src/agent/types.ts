/**
 * Agent 层共享类型。
 */
import type { ContextOptions } from './context.js';
import type { ApprovalRequest, PermissionTier } from '../safety/index.js';
import type { Tool } from '../tools/index.js';
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
  /** 安全护栏：是否写审计日志 */
  auditLog?: boolean;
  /**
   * 安全护栏：工具审批回调（console readline / TUI 审批卡片；由入口注入）。
   * 缺省 = 拒绝（fail-safe）——未接入审批 UI 的环境不会静默放行危险操作。
   */
  requestApproval?: (req: ApprovalRequest) => Promise<boolean> | boolean;
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
   * 取消信号（交互模式每轮创建，/stop / Esc / 运行中 Ctrl+Enter（steer）触发）：
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
   * interruptPending 为只读探测（判断 abort 是打断还是取消：/stop、Esc 取消时
   * 槽为空 → 优雅结束本轮）。回合自然结束时槽中残留的消息由交互层转入待发送
   * 列表（steer 插最前，下一轮发送）——不丢失。console 端不设置（无打断入口）。
   */
  interruptPending?: () => boolean;
  takeInterrupt?: () => string | null;
  /**
   * 换新取消信号回调（interactive 实现）：loop 消费打断消息后调用——旧信号已 abort，
   * 不复位则同一轮内后续的 LLM 请求立刻抛 AbortError；换新后继续的本回合仍可被
   * Esc / /stop 取消（交互层 cancelRun 指向最新控制器）。
   */
  rearmAbort?: () => void;
  /** /variants 支持的思考级别选项（来自配置 reasoningEffortOptions） */
  reasoningEffortOptions?: string[];
  /** 子代理最大循环步数（/agents 展示用；attachRuntime 注入） */
  maxSubagentSteps?: number;
  /**
   * 可用模型端点列表（顶层 model + config `models`；/model 切换用）。
   * attachRuntime 从 cfg 展开注入；interactive 按名字找到目标端点重建 client。
   */
  models?: { name: string; baseURL?: string; apiKey?: string; userAgent?: string }[];
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
   * MCP 服务器配置（/mcp 命令列出/重连用；attachRuntime 从 cfg 注入）。
   */
  mcpServers?: Record<string, import('../tools/mcp.js').McpServerConfig>;
  /**
   * 完整配置对象（/status /context /doctor /config 等命令读取字段；attachRuntime 注入）。
   */
  cfg?: import('../config/index.js').OmniConfig;
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

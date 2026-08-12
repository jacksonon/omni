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
}

/** 思考块展示（仅 TTY）。思考内容实时显示后保留在屏幕上，不再折叠。 */
export interface ThinkingDisplay {
  readonly shown: boolean;
  /** 追加一段思考内容（逐字符实时显示，遇到 \n 或超过终端宽度时换行） */
  write(piece: string): void;
  /** 结束思考区：若最后一行未换行则补一个换行，让后续正文/步骤日志从新行开始 */
  finish(): void;
}

/**
 * 工具接口定义。
 * 独立成文件：工具实现文件只需从这里 import type，避免与注册表（index.ts）形成循环导入。
 */

/** per-tool 审批模式（MCP server 级 defaultToolsApprovalMode 烘焙到工具上；缺省跟随全局权限档位） */
export type ToolApprovalMode = 'auto' | 'prompt' | 'writes' | 'approve';

/**
 * 工具执行上下文（1.0 P0-6 worktree 隔离引入）：cwd = 本次调用的工作目录。
 * 主循环传 process.cwd()；worktree 子代理传其独立工作树路径——路径解析/命令执行
 * 都落在 worktree 里，与主工作区互不干扰。缺省 undefined = 进程 cwd（兼容旧调用/测试）。
 */
export interface ToolContext {
  cwd?: string;
  /**
   * run_command 实时输出回调（每凑到一行 stdout/stderr 触发一次；live streaming 用）。
   * 缺省 = 走 buffer 模式（与旧实现一致，命令结束后一次性返回）。
   * 仅 run_command 工具会读取，其它工具忽略。
   */
  onCommandOutput?: (line: string, isError: boolean) => void;
}

export interface Tool {
  /** 工具名（模型调用时使用，小写下划线命名） */
  name: string;
  /** 给模型看的说明书：什么时候用、怎么用 */
  description: string;
  /** JSON Schema 格式的参数定义 */
  parameters: Record<string, unknown>;
  /** 实际执行逻辑，返回给模型的文本结果 */
  execute(args: Record<string, unknown>, ctx?: ToolContext): Promise<string>;
  /** per-tool 审批模式覆盖（MCP 工具标记；'auto' = 跟随全局 permission 档位） */
  approvalMode?: ToolApprovalMode;
  /** 只读标记（writes 审批模式判定用：true = 非写操作不询问；MCP 工具无法证明只读时视为可写） */
  readOnly?: boolean;
}

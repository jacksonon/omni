/**
 * 工具接口定义。
 * 独立成文件：工具实现文件只需从这里 import type，避免与注册表（index.ts）形成循环导入。
 */

/** per-tool 审批模式（MCP server 级 defaultToolsApprovalMode 烘焙到工具上；缺省跟随全局权限档位） */
export type ToolApprovalMode = 'auto' | 'prompt' | 'writes' | 'approve';

export interface Tool {
  /** 工具名（模型调用时使用，小写下划线命名） */
  name: string;
  /** 给模型看的说明书：什么时候用、怎么用 */
  description: string;
  /** JSON Schema 格式的参数定义 */
  parameters: Record<string, unknown>;
  /** 实际执行逻辑，返回给模型的文本结果 */
  execute(args: Record<string, unknown>): Promise<string>;
  /** per-tool 审批模式覆盖（MCP 工具标记；'auto' = 跟随全局 permission 档位） */
  approvalMode?: ToolApprovalMode;
  /** 只读标记（writes 审批模式判定用：true = 非写操作不询问；MCP 工具无法证明只读时视为可写） */
  readOnly?: boolean;
}

/**
 * 工具接口定义。
 * 独立成文件：工具实现文件只需从这里 import type，避免与注册表（index.ts）形成循环导入。
 */
export interface Tool {
  /** 工具名（模型调用时使用，小写下划线命名） */
  name: string;
  /** 给模型看的说明书：什么时候用、怎么用 */
  description: string;
  /** JSON Schema 格式的参数定义 */
  parameters: Record<string, unknown>;
  /** 实际执行逻辑，返回给模型的文本结果 */
  execute(args: Record<string, unknown>): Promise<string>;
}

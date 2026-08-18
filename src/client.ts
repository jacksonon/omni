/**
 * OpenAI 客户端工厂：按「模型端点配置」创建客户端。
 *
 * /model 命令切换模型时，不同模型可能对应不同端点（baseURL/apiKey/userAgent）——
 * 不能复用 prepareRun 的旧客户端，这里按目标模型的端点重建（配置见 config 的
 * `models` 字段；缺省字段回退到顶层 baseURL/apiKey/userAgent）。
 */
import OpenAI from 'openai';

/** 一个模型端点配置（config `models` 里每个条目的形态） */
export interface ModelEndpoint {
  /** 模型名（如 deepseek-chat / glm-4-flash；/model 命令按名字切换） */
  name: string;
  /** OpenAI 兼容 API 地址（缺省回退顶层 baseURL） */
  baseURL?: string;
  /** API Key（缺省回退顶层 apiKey） */
  apiKey?: string;
  /** 自定义 User-Agent（部分网关 WAF 需要；缺省回退顶层 userAgent） */
  userAgent?: string;
  /** 该模型 /variants 支持的思考级别选项（per-model variants；缺省回退顶层 reasoningEffortOptions） */
  reasoningEffortOptions?: string[];
  /** 该模型的当前思考级别（per-model variants；缺省回退顶层 reasoningEffort） */
  reasoningEffort?: string;
}

/** 按端点配置创建 OpenAI 客户端（timeout/maxRetries 与主入口一致） */
export function createClient(endpoint: ModelEndpoint, fallbackApiKey: string): OpenAI {
  return new OpenAI({
    apiKey: endpoint.apiKey ?? fallbackApiKey,
    baseURL: endpoint.baseURL,
    timeout: 60_000,
    maxRetries: 1,
    ...(endpoint.userAgent ? { defaultHeaders: { 'user-agent': endpoint.userAgent } } : {}),
  });
}

/** 当前模型运行时引用：主循环与子代理（delegate）共用同一引用，/model 切换后两处同步 */
export interface ModelRuntime {
  client: OpenAI;
  model: string;
}

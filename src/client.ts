/**
 * OpenAI 客户端工厂：按「模型端点配置」创建客户端。
 *
 * /model 命令切换模型时，不同模型可能对应不同端点（baseURL/apiKey/userAgent）——
 * 不能复用 prepareRun 的旧客户端，这里按目标模型的端点重建（配置见 config 的
 * `models` / `providers` 字段；缺省字段回退到顶层 baseURL/apiKey/userAgent）。
 *
 * 1.0 模型层重构（TODO 七 7.1，对标 opencode providers / models.dev）：
 * · **provider 复用**——同组多模型共享一个客户端实例（getClientCached 按
 *   baseURL+apiKey+userAgent+headers 缓存；同 provider 下切模型不再重建连接池）；
 * · **模型元数据**——limit（上下文/输出上限）、modalities（输入/输出类型数组）、
 *   capabilities（tools/reasoning/temperature 能力标记）随端点携带，
 *   loop 据此下发 max_tokens、做压缩触发占比与多模态前置校验；
 * · **命名 variants**——{ id, reasoningEffort?, body?, headers? } 请求叠加层，
 *   deep-merge 到该模型的请求配置上（未知 variant 报错而非静默回落）；
 * · **跨端点路由**——resolveModelRoute 按模型名反查端点，architect/editor 配在
 *   不同网关也能路由（ModelRuntime 已支持重建，缺的是这层解析）。
 */
import OpenAI from 'openai';

/** 模型 token 上限（输入上下文窗口 / 输出 max_tokens） */
export interface ModelLimit {
  /** 输入上限（上下文窗口，token 数）——summarizeContext 按占比触发压缩用 */
  context?: number;
  /** 输出上限（token 数）——loop 请求带 max_tokens ≤ limit.output */
  output?: number;
}

/** 模型输入/输出类型数组（text / image / pdf / audio） */
export interface ModelModalities {
  input?: string[];
  output?: string[];
}

/** 模型能力标记 */
export interface ModelCapabilities {
  tools?: boolean;
  reasoning?: boolean;
  temperature?: boolean;
}

/**
 * 命名 variants（1.0 P0-3）：一个具名的「请求叠加层」——deep-merge 到该模型的
 * 请求配置上。例：fast = effort low；deep = effort high + 更大 token budget。
 * 字符串形式的 reasoningEffortOptions 保留为简写（等价 { reasoningEffort } 叠加层）。
 */
export interface NamedVariant {
  /** 展示描述（/variants 面板/列表） */
  description?: string;
  /** 该 variant 的思考级别（叠加进请求 reasoning_effort） */
  reasoningEffort?: string;
  /** deep-merge 进请求体的额外字段（如 max_tokens / top_p / 自定义网关参数） */
  body?: Record<string, unknown>;
  /** 追加进请求头 */
  headers?: Record<string, string>;
}

/** 一个模型端点配置（config `models` / `providers.*.models` 条目展开后的形态） */
export interface ModelEndpoint {
  /** 模型名（如 deepseek-chat / glm-4-flash；/model 命令按名字切换） */
  name: string;
  /** 所属 provider 名（config providers 分组展开时记录；顶层扁平条目无） */
  provider?: string;
  /** OpenAI 兼容 API 地址（缺省回退顶层 baseURL） */
  baseURL?: string;
  /** API Key（缺省回退顶层 apiKey；支持 {env:VAR} 引用——loadConfig 已替换为真实值） */
  apiKey?: string;
  /** 自定义 User-Agent（部分网关 WAF 需要；缺省回退顶层 userAgent） */
  userAgent?: string;
  /** 额外请求头（provider 级或模型级） */
  headers?: Record<string, string>;
  /** 该模型 /variants 支持的思考级别选项（缺省回退顶层 reasoningEffortOptions） */
  reasoningEffortOptions?: string[];
  /** 该模型的当前思考级别（缺省回退顶层 reasoningEffort） */
  reasoningEffort?: string;
  /** 当前选中的命名 variant（/variants <id> 切换；loop 请求叠加其 body/headers） */
  variant?: string;
  /** 命名 variants 表（id → 叠加层定义） */
  variants?: Record<string, NamedVariant>;
  /** 发给 API 的真实模型名（目录友好名 ≠ API 模型名时的别名；缺省 = name） */
  apiModel?: string;
  /** 展示名（/model 面板/下拉显示；缺省 = name） */
  displayName?: string;
  /** token 上限画像 */
  limit?: ModelLimit;
  /** 输入/输出类型数组（vision 模型标 input 含 image） */
  modalities?: ModelModalities;
  /** 能力标记 */
  capabilities?: ModelCapabilities;
  /** disabled = 不出现在 /model 列表与面板（保留配置但不暴露） */
  disabled?: boolean;
}

/** 未声明元数据时的兜底假设（opencode 方案：tools ✓ · text+image 输入 · text 输出） */
export const MODEL_DEFAULTS: Required<{ modalities: ModelModalities; capabilities: ModelCapabilities }> = {
  modalities: { input: ['text', 'image'], output: ['text'] },
  capabilities: { tools: true },
};

/** 取发给 API 的真实模型名（apiModel 别名优先） */
export function apiModelName(ep: ModelEndpoint | undefined, fallback: string): string {
  return ep?.apiModel?.trim() || ep?.name || fallback;
}

/* ------------------------------------------------------------------
 * 客户端缓存（provider 复用）：同一 baseURL+apiKey+userAgent+headers 只建一个
 * OpenAI 实例——providers 分组下同组多模型切换共享连接池；/model 跨组切换才重建。
 * 缓存进程级（弱上限 32 个，LRU 粗略淘汰最旧）。
 * ------------------------------------------------------------------ */
const clientCache = new Map<string, OpenAI>();
const CLIENT_CACHE_MAX = 32;

function cacheKeyOf(endpoint: Pick<ModelEndpoint, 'baseURL' | 'apiKey' | 'userAgent' | 'headers'>, fallbackApiKey: string): string {
  return JSON.stringify([endpoint.baseURL ?? '', endpoint.apiKey ?? fallbackApiKey, endpoint.userAgent ?? '', endpoint.headers ?? {}]);
}

/** 按端点创建（或命中缓存的）OpenAI 客户端 */
export function getClient(endpoint: ModelEndpoint, fallbackApiKey: string): OpenAI {
  const key = cacheKeyOf(endpoint, fallbackApiKey);
  const hit = clientCache.get(key);
  if (hit) return hit;
  const created = createClient(endpoint, fallbackApiKey);
  if (clientCache.size >= CLIENT_CACHE_MAX) {
    const oldest = clientCache.keys().next().value;
    if (oldest !== undefined) clientCache.delete(oldest);
  }
  clientCache.set(key, created);
  return created;
}

/** 测试辅助：清空客户端缓存 */
export function _resetClientCache(): void {
  clientCache.clear();
}

/** 按端点配置创建 OpenAI 客户端（timeout/maxRetries 与主入口一致） */
export function createClient(endpoint: ModelEndpoint, fallbackApiKey: string): OpenAI {
  return new OpenAI({
    apiKey: endpoint.apiKey ?? fallbackApiKey,
    baseURL: endpoint.baseURL,
    timeout: 60_000,
    maxRetries: 1,
    ...(endpoint.userAgent || endpoint.headers
      ? {
          defaultHeaders: {
            ...(endpoint.userAgent ? { 'user-agent': endpoint.userAgent } : {}),
            ...(endpoint.headers ?? {}),
          },
        }
      : {}),
  });
}

/** 当前模型运行时引用：主循环与子代理（delegate）共用同一引用，/model 切换后两处同步 */
export interface ModelRuntime {
  client: OpenAI;
  model: string;
}

/* ------------------------------------------------------------------
 * 跨端点模型路由（1.0 P0-3）：按模型名从 runOpts.models 反查端点——
 * architect/editor 配在不同网关时返回该端点的客户端（缓存复用）；
 * 同端点/找不到时回退传入的默认运行时。
 * ------------------------------------------------------------------ */
export interface ModelRoute {
  client: OpenAI;
  /** 发给 API 的模型名（apiModel 别名优先） */
  model: string;
  /** 命中的端点（可能 undefined = 用默认运行时） */
  endpoint?: ModelEndpoint;
}

export function findEndpointByName(
  endpoints: ModelEndpoint[] | undefined,
  name: string
): ModelEndpoint | undefined {
  if (!endpoints || !name) return undefined;
  return (
    endpoints.find((m) => m.name === name && !m.disabled) ??
    // 兼容按 apiModel 别名查找
    endpoints.find((m) => m.apiModel === name && !m.disabled)
  );
}

/**
 * 解析一轮请求的路由：目标模型名（architect/editor 路由后）→ 端点反查 →
 * 不同端点换缓存客户端；disabled / 找不到 → 回退默认 client+model。
 */
export function resolveModelRoute(
  opts: { models?: ModelEndpoint[]; fallbackApiKey?: string },
  targetModel: string,
  defaultClient: OpenAI,
  defaultModel: string
): ModelRoute {
  const ep = findEndpointByName(opts.models, targetModel);
  if (!ep) return { client: defaultClient, model: targetModel };
  // 端点的 baseURL/key 与默认运行时一致（含都是 undefined 的回退场景）→ 直接复用
  return {
    client: getClient(ep, opts.fallbackApiKey ?? ep.apiKey ?? ''),
    model: apiModelName(ep, targetModel),
    endpoint: ep,
  };
}

/* ------------------------------------------------------------------
 * 模型发现（1.0 P1）：GET {baseURL}/models —— OpenAI 兼容协议通用能力
 * （Ollama/LM Studio/vLLM/各类网关都支持）。返回模型 id 列表；失败抛错由调用方提示。
 * ------------------------------------------------------------------ */
export async function discoverModels(endpoint: Pick<ModelEndpoint, 'baseURL' | 'apiKey'>): Promise<string[]> {
  const base = (endpoint.baseURL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  const url = base.endsWith('/v1') || /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      headers: endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {},
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    return (data.data ?? [])
      .map((m) => String(m.id ?? ''))
      .filter(Boolean)
      .sort();
  } finally {
    clearTimeout(timer);
  }
}

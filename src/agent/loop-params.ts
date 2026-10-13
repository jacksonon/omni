/**
 * Agent 主循环的请求参数构建（从 loop.ts 抽出，纯函数）：
 * 命名 variants 叠加层、能力驱动流式参数组装、缓存 token 提取。
 */
import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ModelEndpoint } from '../client.js';
import { buildToolSchemas } from './loop-prompts.js';

/** deep-merge（命名 variants 的 body 叠加）：对象递归合并，其余类型直接覆盖 */
function deepMerge<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown> | undefined): T {
  if (!patch) return base;
  for (const [k, v] of Object.entries(patch)) {
    const cur = base[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      (base as Record<string, unknown>)[k] = v;
    }
  }
  return base;
}

/** 解析命名 variants 叠加层（1.0 P0-3）：未知/未选返回空叠加（切换入口负责报错） */
function resolveVariantOverlay(
  endpoint: ModelEndpoint | undefined,
  activeVariant: string | undefined
): { reasoningEffort?: string; body?: Record<string, unknown>; headers?: Record<string, string> } {
  if (!activeVariant) return {};
  const v = endpoint?.variants?.[activeVariant];
  return v ? { reasoningEffort: v.reasoningEffort, body: v.body, headers: v.headers } : {};
}

/** 从 usage 中提取 cached tokens（兼容 OpenAI, DeepSeek, Anthropic 等多厂商字段） */
export function extractCachedTokens(usage: OpenAI.Completions.CompletionUsage | null | undefined): number {
  if (!usage) return 0;
  const u = usage as OpenAI.Completions.CompletionUsage & {
    prompt_tokens_details?: { cached_tokens?: number };
    prompt_cache_hit_tokens?: number;
    cache_read_input_tokens?: number;
    cached_tokens?: number;
  };
  return (
    u.prompt_tokens_details?.cached_tokens ??
    u.prompt_cache_hit_tokens ??
    u.cache_read_input_tokens ??
    u.cached_tokens ??
    0
  );
}

/**
 * 组装一轮流式请求参数（1.0 P0-3 能力驱动构建）：
 * · max_tokens ≤ limit.output（元数据声明时才下发——长回答不再被网关默认值截断）；
 * · 命名 variants 叠加层：{ reasoningEffort?, body?, headers? } deep-merge 进请求；
 * · reasoning_effort（/variants 思考级别；variant 自带时覆盖）；
 * · Anthropic Prompt Caching（Claude 系列显式 cache_control 断点标记）。
 */
export function buildStreamParams(
  endpoint: ModelEndpoint | undefined,
  model: string,
  messages: ChatCompletionMessageParam[],
  tools: ReturnType<typeof buildToolSchemas>,
  extra: { includeUsage?: boolean; signal?: AbortSignal; reasoningEffort?: string; activeVariant?: string; disableCacheControl?: boolean }
): { params: Record<string, unknown>; headers: Record<string, string> | undefined; options: { headers?: Record<string, string>; signal?: AbortSignal } } {
  const overlay = resolveVariantOverlay(endpoint, extra.activeVariant);
  // P2 能力驱动请求构建：capabilities 元数据**事前**决定是否携带参数——
  // reasoning=false → 不带 reasoning_effort（即便配置了，也避免白付一次失败往返）；
  // tools=false → 传空工具表（模型无工具调用能力时网关不报错）
  const canReason = endpoint?.capabilities?.reasoning !== false;
  const canTools = endpoint?.capabilities?.tools !== false;

  let requestTools = canTools ? tools : [];
  let requestMessages = messages;

  // Anthropic 显式 Prompt Caching 适配：Claude 模型下发 cache_control 断点
  const isClaude =
    !extra.disableCacheControl &&
    (model.toLowerCase().includes('claude') ||
      Boolean(endpoint?.baseURL?.includes('anthropic')) ||
      Boolean((endpoint?.headers as Record<string, string> | undefined)?.['anthropic-version']));

  if (isClaude) {
    if (requestTools.length > 0) {
      requestTools = requestTools.map((t, idx) =>
        idx === requestTools.length - 1
          ? { ...t, cache_control: { type: 'ephemeral' } }
          : t
      );
    }
    // 断点打到头部连续 system 消息的最后一条：首轮 system 之后，全局/项目记忆、
    // repomap、技能清单、预载文件、MCP instructions 全是 system role 且首轮一次注入、
    // 会话内稳定——整个静态前缀进同一个缓存块（之前只标 system[0]，后面几十 KB
    // 脚手架每步重算）。动态对话从首条非 system 消息开始，不在断点覆盖内。
    let lastStaticIdx = -1;
    for (let i = 0; i < requestMessages.length; i++) {
      if (requestMessages[i]?.role === 'system') lastStaticIdx = i;
      else break;
    }
    if (lastStaticIdx >= 0) {
      requestMessages = requestMessages.map((m, idx) => {
        if (idx === lastStaticIdx) {
          return { ...(m as unknown as Record<string, unknown>), cache_control: { type: 'ephemeral' } } as unknown as ChatCompletionMessageParam;
        }
        return m;
      });
    }
  }

  const params: Record<string, unknown> = {
    model,
    messages: requestMessages,
    tools: requestTools,
    stream: true,
  };
  if (extra.includeUsage) params.stream_options = { include_usage: true };
  // none = 关思考、auto = 模型默认档——两者都不随请求下发 reasoning_effort 参数
  //（数据源自动档引入后这两个开关值会出现在 /variants 档位里；网关不认枚举会拒绝）
  const rawEffort = canReason ? (overlay.reasoningEffort ?? extra.reasoningEffort) : undefined;
  const effort = rawEffort && rawEffort !== 'none' && rawEffort !== 'auto' ? rawEffort : undefined;
  if (effort) {
    params.reasoning_effort = effort as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming['reasoning_effort'];
  }
  if (endpoint?.limit?.output) params.max_tokens = Math.max(1, Math.floor(endpoint.limit.output));
  deepMerge(params, overlay.body);
  // signal / headers 走 SDK 的 RequestOptions 第二参（不进请求体）
  const requestOptions = {
    ...(Object.keys({ ...(endpoint?.headers ?? {}), ...(overlay.headers ?? {}) }).length
      ? { headers: { ...(endpoint?.headers ?? {}), ...(overlay.headers ?? {}) } }
      : {}),
    ...(extra.signal ? { signal: extra.signal } : {}),
  };
  return {
    params,
    headers: Object.keys(requestOptions).length ? (requestOptions.headers as Record<string, string> | undefined) : undefined,
    options: requestOptions as { headers?: Record<string, string>; signal?: AbortSignal },
  };
}
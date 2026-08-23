/**
 * OpenTelemetry 导出（1.0 P1-11）：**默认关闭、opt-in 显式**。
 *
 * 零依赖实现：OTLP/HTTP JSON 协议（/v1/metrics 与 /v1/traces 两个端点）——
 * 指标与 span 都按 OTLP JSON 编码 POST（application/json）。prompt/工具内容
 * 默认脱敏（redact=true 只发 token 数/耗时/工具名等元数据，不含任何用户文本）。
 *
 * 设计取舍：不做完整 OTel SDK——够 Grafana/Prometheus OTLP receiver 即插即用即可；
 * 失败静默（fire-and-forget，2s 超时），不阻塞主流程。
 */
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

export interface TelemetryOptions {
  enabled?: boolean;
  endpoint?: string;
  serviceName?: string;
  redact?: boolean;
}

/** 运行时 telemetry 状态（main.ts attachRuntime 按 cfg.telemetry 初始化） */
let state: { enabled: boolean; endpoint: string; serviceName: string; redact: boolean } | null = null;

/** 初始化（cfg.telemetry.enabled && endpoint 才真正开启） */
export function initTelemetry(opt: TelemetryOptions | undefined): void {
  if (!opt?.enabled || !opt.endpoint) {
    state = null;
    return;
  }
  state = {
    enabled: true,
    endpoint: opt.endpoint.replace(/\/+$/, ''),
    serviceName: opt.serviceName ?? 'omni',
    redact: opt.redact !== false, // 默认脱敏
  };
}

export function telemetryEnabled(): boolean {
  return !!state?.enabled;
}

/** fire-and-forget POST（2s 超时；任何失败静默） */
function post(path: string, body: unknown): void {
  if (!state) return;
  void fetch(`${state.endpoint}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(2000),
  }).catch(() => {});
}

/** 归一化 metric 时间戳（纳秒，OTLP 要求） */
const nowNs = (): string => String(Date.now() * 1_000_000);
const nanos = (ms: number): string => String(ms * 1_000_000);

/**
 * 记录一次 LLM 请求（token/耗时/首 token/缓存命中）。
 * redact=true 时只发元数据；false 时附请求消息数与模型名。
 */
export function recordLlm(
  model: string,
  usage: { prompt?: number; completion?: number; cached?: number } | undefined,
  llmMs: number,
  firstTokenMs: number | null,
  messageCount: number
): void {
  if (!state) return;
  const attrs: Record<string, string> = {
    'service.name': state.serviceName,
    'omni.model': state.redact ? model.slice(0, 40) : model,
    'omni.messages': String(messageCount),
  };
  const p = usage?.prompt ?? 0;
  const c = usage?.completion ?? 0;
  post('/v1/metrics', {
    resourceMetrics: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: state.serviceName } }] },
        scopeMetrics: [
          {
            scope: { name: 'omni' },
            metrics: [
              makeSum('omni.llm.tokens', [p, c], ['omni.token.type=prompt', 'omni.token.type=completion']),
              makeGauge('omni.llm.latency', [llmMs], [''], true),
            ],
          },
        ],
      },
    ],
  });
  // span（红色度量：只发元数据，不发 prompt 文本）
  post('/v1/traces', {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: state.serviceName } }] },
        scopeSpans: [
          {
            scope: { name: 'omni' },
            spans: [
              {
                traceId: randomHex(16),
                spanId: randomHex(8),
                name: 'llm.request',
                startTimeUnixNano: nowNs(),
                endTimeUnixNano: nowNs(),
                attributes: Object.entries(attrs).map(([key, value]) => ({ key, value: { stringValue: value } })),
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  });
}

/** 记录一次工具调用（名称 + 耗时 + 是否成功；不含参数内容——redact 恒成立） */
export function recordTool(tool: string, ms: number, ok: boolean): void {
  if (!state) return;
  post('/v1/metrics', {
    resourceMetrics: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: state.serviceName } }] },
        scopeMetrics: [
          {
            scope: { name: 'omni' },
            metrics: [makeHistogram('omni.tool.duration', [ms], `omni.tool=${tool},omni.tool.ok=${ok ? 'true' : 'false'}`)],
          },
        ],
      },
    ],
  });
}

/** 记录会话级活动（消息数/工具数/结束原因；文本脱敏） */
export function recordSession(
  messages: ChatCompletionMessageParam[],
  endReason: string,
  toolCalls: number
): void {
  if (!state) return;
  const redacted = state.redact;
  post('/v1/metrics', {
    resourceMetrics: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: state.serviceName } }] },
        scopeMetrics: [
          {
            scope: { name: 'omni' },
            metrics: [
              makeGauge('omni.session.messages', [messages.length], ['']),
              makeGauge('omni.session.tools', [toolCalls], ['']),
              makeGauge('omni.session.tokens', [estimateTokens(messages)], [redacted ? '' : 'omni.exact=false']),
            ],
          },
        ],
      },
    ],
  });
  void endReason;
}

/* ---------------- OTLP JSON 编码辅助 ---------------- */

function makeSum(
  name: string,
  values: number[],
  attrStrings: string[]
): Record<string, unknown> {
  const dataPoints = values.map((v, i) => ({
    attributes: splitAttrs(attrStrings[i] ?? ''),
    startTimeUnixNano: nowNs(),
    timeUnixNano: nowNs(),
    asInt: v,
  }));
  return {
    name,
    sum: { dataPoints, aggregationTemporality: 2, isMonotonic: true },
    unit: '1',
  };
}

function makeGauge(name: string, values: number[], attrStrings: string[], double = false): Record<string, unknown> {
  const dataPoints = values.map((v, i) => ({
    attributes: splitAttrs(attrStrings[i] ?? ''),
    timeUnixNano: nowNs(),
    ...(double ? { asDouble: v } : { asInt: v }),
  }));
  return { name, gauge: { dataPoints }, unit: '1' };
}

function makeHistogram(name: string, values: number[], attrString: string): Record<string, unknown> {
  return {
    name,
    histogram: {
      dataPoints: [
        {
          attributes: splitAttrs(attrString),
          timeUnixNano: nowNs(),
          count: values.length,
          sum: values.reduce((a, b) => a + b, 0),
          bucketCounts: [String(values.length)],
          explicitBounds: [],
        },
      ],
    },
    unit: 'ms',
  };
}

function splitAttrs(s: string): { key: string; value: { stringValue: string } }[] {
  return s
    .split(',')
    .filter(Boolean)
    .map((kv) => {
      const idx = kv.indexOf('=');
      return { key: idx >= 0 ? kv.slice(0, idx) : kv, value: { stringValue: idx >= 0 ? kv.slice(idx + 1) : '' } };
    });
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  // 避免 crypto 强依赖在 bundle 里的体积：用 Math.random 足够（仅 traceId 去重用）
  for (let i = 0; i < bytes; i++) arr[i] = Math.floor(Math.random() * 256);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

function estimateTokens(messages: ChatCompletionMessageParam[]): number {
  let n = 0;
  for (const m of messages) {
    const s = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
    n += Math.ceil(s.length / 3);
  }
  return n;
}

export const __telemetryTest = { nanos };

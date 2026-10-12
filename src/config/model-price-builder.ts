/**
 * 模型单价快照构建纯逻辑（数据源：OpenRouter 公开模型表 https://openrouter.ai/api/v1/models）。
 *
 * 两个消费方共用同一份实现：
 *   1. `scripts/build-model-price-snapshot.ts`（npm run prices:snapshot）
 *      —— 开发者更新**仓库内置快照** src/config/model-price-snapshot.ts 并提交；
 *   2. 运行时 `refreshModelPriceSnapshot()`（src/config/model-pricing.ts）
 *      —— 用户在线重建并写入**用户数据目录** ~/.config/omni/model-price-snapshot.json，
 *        当前进程热替换内存表立即生效，下次启动自动覆盖内置。
 *
 * 归一化：{ p: 输入 $/1M, o: 输出 $/1M, c: context, m: max_output, intel: 智能指数 }
 * （pricing 字符串 $/token × 1e6；缺失字段缺省不写；键为原始 qualified id 小写）。
 * 本文件不引用快照源文件（生成器在快照缺失时也能跑，避免鸡生蛋问题）。
 */
export const OPENROUTER_MODELS_URL = process.env.OPENROUTER_MODELS_URL ?? 'https://openrouter.ai/api/v1/models';

/** 单个模型的单价快照条目（缺失字段缺省不写） */
export interface ModelPriceEntry {
  /** 输入单价（$/1M tokens） */
  p?: number;
  /** 输出单价（$/1M tokens） */
  o?: number;
  /** 缓存命中单价（$/1M tokens，源 input_cache_read） */
  cr?: number;
  /** 上下文窗口（token 数） */
  c?: number;
  /** 最大输出（token 数） */
  m?: number;
  /** 智能指数（artificial_analysis.intelligence_index） */
  intel?: number;
}

/** 快照表：小写键 → 条目（保序，键字母序输出保证 diff 稳定） */
export type PriceTable = Map<string, ModelPriceEntry>;

/** 在线拉取 OpenRouter 公开模型表（免费 no-key；失败抛错由调用方提示） */
export async function fetchOpenRouterData(url: string = OPENROUTER_MODELS_URL): Promise<{ data: unknown[] }> {
  const res = await fetch(url, { headers: { 'user-agent': 'omni-snapshot-builder/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { data?: unknown };
  if (!body || !Array.isArray(body.data)) throw new Error('响应缺少 data 数组');
  return { data: body.data };
}

/** $/token（字符串数字）→ $/1M tokens；非法/负值返回 undefined */
function perMillion(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 1e6 * 1e6) / 1e6;
}

/** 正整数读取（context / max_output 用；非法返回 undefined） */
function positiveInt(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n);
}

/** 智能指数读取（benchmarks.artificial_analysis.intelligence_index；缺失返回 undefined） */
function intelligenceIndexOf(raw: Record<string, unknown>): number | undefined {
  const b = raw['benchmarks'];
  if (!b || typeof b !== 'object') return undefined;
  const bb = b as Record<string, unknown>;
  // 键名容错：snake / kebab / camel（实测为 artificial_analysis）
  const aa: unknown =
    bb['artificial_analysis'] ?? bb['artificial-analysis'] ?? bb['artificialAnalysis'];
  if (!aa || typeof aa !== 'object') return undefined;
  const v = (aa as Record<string, unknown>)['intelligence_index'] ?? (aa as Record<string, unknown>)['intelligenceIndex'];
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** 单个 OpenRouter 模型 → 快照条目（全字段缺失返回 null） */
function toPriceEntry(model: unknown): ModelPriceEntry | null {
  if (!model || typeof model !== 'object') return null;
  const m = model as Record<string, unknown>;
  const pricing = (m['pricing'] ?? {}) as Record<string, unknown>;
  const top = (m['top_provider'] ?? {}) as Record<string, unknown>;
  const entry: ModelPriceEntry = {};
  const p = perMillion(pricing['prompt']);
  const o = perMillion(pricing['completion']);
  const cr = perMillion(pricing['input_cache_read']);
  const c = positiveInt(m['context_length']);
  const max = positiveInt(top['max_completion_tokens']);
  const intel = intelligenceIndexOf(m);
  if (p !== undefined) entry.p = p;
  if (o !== undefined) entry.o = o;
  if (cr !== undefined) entry.cr = cr;
  if (c !== undefined) entry.c = c;
  if (max !== undefined) entry.m = max;
  if (intel !== undefined) entry.intel = intel;
  return Object.keys(entry).length > 0 ? entry : null;
}

/** 由 OpenRouter {data:[…]} 构建快照表（键 = 原始 qualified id 小写；id 缺失/重复首个为准） */
export function buildPriceTable(api: { data: unknown[] }): PriceTable {
  const table: PriceTable = new Map();
  for (const model of api.data) {
    const entry = toPriceEntry(model);
    if (!entry) continue;
    const id = (model as Record<string, unknown> | null)?.['id'];
    const key = typeof id === 'string' && id.trim() ? id.trim().toLowerCase() : '';
    if (!key || table.has(key)) continue;
    table.set(key, entry);
  }
  return table;
}

/** 序列化为仓库内置 TS 源文件文本（带生成头注释；键字母序稳定 diff） */
export function serializePriceTs(
  table: PriceTable,
  meta: { sourceUrl: string; generatedAt: string }
): string {
  const sorted = [...table.keys()].sort();
  const lines = sorted.map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(table.get(k))},`);
  return `/**
 * ⚠️ 该文件由 scripts/build-model-price-snapshot.ts 自动生成 —— 不要手改。
 *
 * 数据源：${meta.sourceUrl}（公开模型表 · 免费 no-key）
 * 生成时间：${meta.generatedAt}
 * 规模：${sorted.length} 个模型（OpenRouter 全量；键为原始 qualified id 小写）
 *
 * 用途（无网络、纯同步查表，启动/面板/offscreen 均安全）：
 *   · p = 输入单价（$/1M tokens） → headless 成本估算
 *   · o = 输出单价（$/1M tokens） → headless 成本估算
 *   · cr = 缓存命中单价（$/1M tokens，源 input_cache_read） → 缓存成本按此计
 *   · c = 上下文窗口（token 数）  → 备用参考（主窗口数据源仍是 models.dev 快照）
 *   · m = 最大输出（token 数）    → 参考
 *   · intel = 智能指数（artificial_analysis.intelligence_index） → /model 与 /status 展示
 *
 * 显式配置（endpoint.price / 环境变量）永远优先于本表；未配置才查表补缺
 * （见 src/config/model-pricing.ts 与 src/exec.ts 成本估算）。
 * 更新方式：npm run prices:snapshot（内置快照）或运行时 refreshModelPriceSnapshot
 * （用户级，写 ~/.config/omni/model-price-snapshot.json）。
 */

/** 单个模型的单价快照条目（缺失字段缺省不写） */
export interface ModelPriceEntry {
  /** 输入单价（$/1M tokens） */
  p?: number;
  /** 输出单价（$/1M tokens） */
  o?: number;
  /** 缓存命中单价（$/1M tokens，源 input_cache_read） */
  cr?: number;
  /** 上下文窗口（token 数） */
  c?: number;
  /** 最大输出（token 数） */
  m?: number;
  /** 智能指数（artificial_analysis.intelligence_index） */
  intel?: number;
}

/** 快照元信息（来源与生成时间，/status 可观测性展示用） */
export const MODEL_PRICE_META = {
  sourceUrl: '${meta.sourceUrl}',
  generatedAt: '${meta.generatedAt}',
} as const;

export default {
${lines.join('\n')}
} as Record<string, ModelPriceEntry>;
`;
}

/** 用户级快照文件的磁盘结构（refresh 写入；启动时同步读取覆盖内置） */
export interface PriceJsonFile {
  sourceUrl: string;
  generatedAt: string;
  models: Record<string, ModelPriceEntry>;
}

/** 序列化为用户级 JSON 文件内容（写 ~/.config/omni/model-price-snapshot.json） */
export function serializePriceJson(
  table: PriceTable,
  meta: { sourceUrl: string; generatedAt: string }
): string {
  const sorted: Record<string, ModelPriceEntry> = {};
  for (const k of [...table.keys()].sort()) sorted[k] = table.get(k)!;
  const file: PriceJsonFile = { sourceUrl: meta.sourceUrl, generatedAt: meta.generatedAt, models: sorted };
  return JSON.stringify(file);
}

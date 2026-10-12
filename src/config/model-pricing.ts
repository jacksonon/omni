/**
 * 模型单价与智能评分查表（数据源：OpenRouter 公开模型表的离线快照）。
 *
 * 模式照抄 src/config/model-context.ts：
 *   · 静态数据 + 纯同步查表（无网络，任何入口安全引用）；
 *   · 显式配置（endpoint.price / 环境变量）优先，查表只补缺（见 src/exec.ts）；
 *   · 三级匹配（精确 → 裸 id → 后缀）；
 *   · 用户级快照（~/.config/omni/model-price-snapshot.json）覆盖内置 + 热替换。
 *
 * 查不到/无该字段 → 返回 undefined，展示位直接省略，绝不抛错。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildPriceTable,
  fetchOpenRouterData,
  OPENROUTER_MODELS_URL,
  serializePriceJson,
  type ModelPriceEntry,
  type PriceJsonFile,
} from './model-price-builder.js';
import SNAPSHOT, { MODEL_PRICE_META } from './model-price-snapshot.js';

export { MODEL_PRICE_META };
export type { ModelPriceEntry, PriceJsonFile };
export { OPENROUTER_MODELS_URL };

/** 用户级快照文件（存在即覆盖内置快照；启动时同步读取） */
export function userPriceSnapshotFile(): string {
  const home = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(home, 'omni', 'model-price-snapshot.json');
}

/** 快照表：小写键 → 条目（保序 = 快照文件字母序 → 冲突时结果确定）。
 * 可变：refreshModelPriceSnapshot 热替换（用户级更新优先于内置，不重启即生效）。 */
let TABLE: ReadonlyMap<string, ModelPriceEntry> = new Map(Object.entries(SNAPSHOT));

/** 用户级覆盖的元信息（null = 未覆盖，用内置快照） */
let userMeta: { sourceUrl?: string; generatedAt?: string } | null = null;

// 启动加载：用户数据目录存在单价快照 JSON → 覆盖内置；损坏/缺失静默回退内置。
try {
  const file = userPriceSnapshotFile();
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as PriceJsonFile;
    if (parsed && typeof parsed.models === 'object' && Object.keys(parsed.models).length > 0) {
      TABLE = new Map(Object.entries(parsed.models));
      userMeta = { sourceUrl: parsed.sourceUrl, generatedAt: parsed.generatedAt };
    }
  }
} catch {
  /* 用户文件缺失/损坏 → 保持内置快照 */
}

export type ModelPriceMatchType = 'exact' | 'bare' | 'suffix';

export interface ModelPriceMatch {
  /** 命中的表键（如 openai/gpt-4o） */
  key: string;
  matchType: ModelPriceMatchType;
  entry: ModelPriceEntry;
}

function lower(s: unknown): string {
  return String(s ?? '').trim().toLowerCase();
}

/**
 * 三级匹配查找。任何模型名（含 "<网关>/<模型>" 形态）都可安全传入；
 * 未命中返回 null —— 调用方按各自兜底策略处理。
 */
export function lookupModelPriceMatch(model?: string | null): ModelPriceMatch | null {
  const m = lower(model);
  if (!m) return null;
  // ① 精确：小写全串
  const direct = TABLE.get(m);
  if (direct) return { key: m, matchType: 'exact', entry: direct };
  // 输入末段：网关前缀剥掉后的裸 id —— 后面两级都基于它
  const lastSeg = m.split('/').pop() ?? '';
  if (!lastSeg) return null;
  // ② 裸 id：剥掉 xxx/ 前缀后命中的是无前缀键
  const bare = TABLE.get(lastSeg);
  if (bare && lastSeg !== m) return { key: lastSeg, matchType: 'bare', entry: bare };
  // ③ 后缀：输入末段 == 表内 qualified 键的 model 段
  for (const [k, entry] of TABLE.entries()) {
    if (k.endsWith(`/${lastSeg}`)) return { key: k, matchType: 'suffix', entry };
  }
  return null;
}

/** 模型单价（$/1M tokens；缺失 side 为 undefined；全缺/未命中返回 undefined） */
export interface ModelPrice {
  input?: number;
  output?: number;
  cacheRead?: number;
}

export function lookupModelPrice(model?: string | null): ModelPrice | undefined {
  const hit = lookupModelPriceMatch(model);
  if (!hit) return undefined;
  const { p, o, cr } = hit.entry;
  if (p === undefined && o === undefined && cr === undefined) return undefined;
  return {
    ...(p !== undefined ? { input: p } : {}),
    ...(o !== undefined ? { output: o } : {}),
    ...(cr !== undefined ? { cacheRead: cr } : {}),
  };
}

/** 单价来源（四级优先级：显式配置 > 环境变量 > OpenRouter 快照 > 内置默认） */
export type PriceSource = 'config' | 'env' | 'snapshot' | 'default';

/** resolveModelPrice 的单价输入（显式配置端 + 快照别名） */
export interface PriceResolveOpts {
  /** 当前模型的端点单价（config providers/model price，最高优先级） */
  endpointPrice?: { input?: number; output?: number; cacheRead?: number };
  /** 发给 API 的真实模型名（快照查表时与展示名依次试） */
  apiModel?: string;
  /** 缓存命中 token 数（成本按缓存单价计；缺省 0） */
  cachedTokens?: number;
}

/** 解析后的单价（$/1M tokens；两侧恒有值，缺失已逐级回退） */
export interface ResolvedModelPrice {
  input: number;
  output: number;
  /** 缓存命中单价（缺省回退输入单价） */
  cacheRead: number;
  /** 四级来源（各侧来源不一致时取最低优先级的一侧） */
  source: PriceSource;
}

/** 输入/输出单价内置默认（$/1M tokens；四级都缺失时的最终兜底） */
export const DEFAULT_INPUT_PRICE_PER_M = 1;
export const DEFAULT_OUTPUT_PRICE_PER_M = 2;

/** 环境变量单价读取（live 取 process.env；未设置/非法 → undefined，走下一级） */
function envPricePerM(name: 'OMNI_INPUT_PRICE_PER_M' | 'OMNI_OUTPUT_PRICE_PER_M' | 'OMNI_CACHE_PRICE_PER_M'): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** 单侧来源判定（调用方已按优先级取到值，这里只标注该值来自哪一级） */
function sideSource(ep?: number, env?: number, snap?: number): PriceSource {
  if (ep !== undefined) return 'config';
  if (env !== undefined) return 'env';
  if (snap !== undefined) return 'snapshot';
  return 'default';
}

const SOURCE_RANK: Record<PriceSource, number> = { config: 3, env: 2, snapshot: 1, default: 0 };

/**
 * 统一单价解析（四级优先级，逐侧独立回退）：
 * endpointPrice（显式 config）> OMNI_INPUT/OUTPUT_PRICE_PER_M（环境变量）>
 * OpenRouter 快照查表（model 与 apiModel 依次试）> 内置默认 1/2。
 * 纯同步、无网络，任何入口可安全引用；永不抛错。
 */
export function resolveModelPrice(model?: string | null, opts?: PriceResolveOpts): ResolvedModelPrice {
  const snap = lookupModelPrice(model) ?? (opts?.apiModel ? lookupModelPrice(opts.apiModel) : undefined);
  const envIn = envPricePerM('OMNI_INPUT_PRICE_PER_M');
  const envOut = envPricePerM('OMNI_OUTPUT_PRICE_PER_M');
  const envCache = envPricePerM('OMNI_CACHE_PRICE_PER_M');
  const ep = opts?.endpointPrice;
  const input = ep?.input ?? envIn ?? snap?.input ?? DEFAULT_INPUT_PRICE_PER_M;
  const output = ep?.output ?? envOut ?? snap?.output ?? DEFAULT_OUTPUT_PRICE_PER_M;
  // 缓存单价：同四级回退，最终缺省回输入单价（未知缓存折扣时按原价计，不少算）
  const cacheRead = ep?.cacheRead ?? envCache ?? snap?.cacheRead ?? input;
  const inSrc = sideSource(ep?.input, envIn, snap?.input);
  const outSrc = sideSource(ep?.output, envOut, snap?.output);
  const cacheSrc = sideSource(ep?.cacheRead, envCache, snap?.cacheRead);
  const srcs = [inSrc, outSrc, cacheSrc].sort((a, b) => SOURCE_RANK[a] - SOURCE_RANK[b]);
  return { input, output, cacheRead, source: srcs[0]! };
}

/**
 * 统一成本估算：resolveModelPrice 解析单价后按 token 量计价。
 * cachedTokens（经 opts 传入）按缓存单价计，不再混入输入原价；
 * token 非数值/负数按 0 计；缓存量钳到 ≤ prompt；永不抛错。
 */
export function estimateCost(
  prompt: number,
  completion: number,
  model?: string | null,
  opts?: PriceResolveOpts
): { costUsd: number; source: PriceSource; prices: { input: number; output: number; cacheRead: number } } {
  const r = resolveModelPrice(model, opts);
  const p = typeof prompt === 'number' && Number.isFinite(prompt) ? Math.max(0, prompt) : 0;
  const c = typeof completion === 'number' && Number.isFinite(completion) ? Math.max(0, completion) : 0;
  const rawCache = opts?.cachedTokens;
  const cached = typeof rawCache === 'number' && Number.isFinite(rawCache) ? Math.min(Math.max(0, rawCache), p) : 0;
  const costUsd = ((p - cached) / 1e6) * r.input + (cached / 1e6) * r.cacheRead + (c / 1e6) * r.output;
  return { costUsd, source: r.source, prices: { input: r.input, output: r.output, cacheRead: r.cacheRead } };
}

/** 模型智能指数（OpenRouter artificial_analysis.intelligence_index；无则 undefined，不抛错） */
export function describeModelIntelligence(model?: string | null): number | undefined {
  const hit = lookupModelPriceMatch(model);
  const v = hit?.entry.intel;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export interface ModelPriceSnapshotInfo {
  /** 当前生效来源：用户级更新优先，否则内置快照 */
  source: 'user' | 'builtin';
  /** 条数 */
  count: number;
  /** 生成时间 ISO */
  generatedAt: string;
  /** 距今天数（≤0 = 当天） */
  ageDays: number;
  /** 数据源 URL */
  sourceUrl: string;
  /** 用户级快照文件路径（内置来源时为空串） */
  userFile: string;
}

/** 当前生效快照的状态（纯同步，不联网） */
export function priceSnapshotInfo(): ModelPriceSnapshotInfo {
  const generatedAt = userMeta?.generatedAt ?? MODEL_PRICE_META.generatedAt;
  const ageMs = Date.now() - new Date(generatedAt).getTime();
  return {
    source: userMeta ? 'user' : 'builtin',
    count: TABLE.size,
    generatedAt,
    ageDays: Math.max(0, Math.floor(ageMs / 86_400_000)),
    sourceUrl: userMeta?.sourceUrl ?? MODEL_PRICE_META.sourceUrl,
    userFile: userMeta ? userPriceSnapshotFile() : '',
  };
}

/**
 * 在线拉取 OpenRouter → 重建快照 → 写用户数据目录 JSON →
 * **热替换内存表**（当前进程的后续查表立即用新表，无需重启）。
 * 网络失败返回 { ok:false }，旧表原样保留——默认不自动更新。
 */
export async function refreshModelPriceSnapshot(): Promise<
  { ok: true; info: ModelPriceSnapshotInfo; file: string } | { ok: false; error: string }
> {
  try {
    const api = await fetchOpenRouterData();
    const table = buildPriceTable(api);
    if (table.size === 0) return { ok: false, error: '拉取结果为空（0 条目），保留旧表' };
    const generatedAt = new Date().toISOString();
    const file = userPriceSnapshotFile();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, serializePriceJson(table, { sourceUrl: OPENROUTER_MODELS_URL, generatedAt }), 'utf8');
    TABLE = new Map(table);
    userMeta = { sourceUrl: OPENROUTER_MODELS_URL, generatedAt };
    return { ok: true, info: priceSnapshotInfo(), file };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

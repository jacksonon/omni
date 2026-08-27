/**
 * 模型能力自动识别（数据源查表，1.0 P1）。
 *
 * 数据源：models.dev api.json 的离线快照（scripts/build-model-context-snapshot.mjs
 * 生成 src/config/model-context-snapshot.ts，进 repo 可离线）。
 *
 * 设计原则（与压缩预算 / variants 自动档共用一套）：
 *   1. 静态数据 + 纯同步查表：无网络、无重依赖，任何入口都能安全引用；
 *   2. 用户手动选择 > 查表猜测：显式配置的 limit / reasoningEffortOptions 永远优先，
 *      查表只补缺，绝不覆盖；
 *   3. 查不到就保守回退：宁缺毋滥——不误压、不乱给档位能力，MISS 路径都有可读兜底；
 *   4. 数据刷新：npm run models:snapshot 重跑即更新快照（新厂商加白名单一行）。
 *
 * 三级匹配（自上而下，命中即返回）：
 *   ① 精确 —— 输入小写全串命中表键（如 z-ai/glm-5.3、deepseek-chat）
 *   ② 裸 id —— 剥掉网关前缀后命中无前缀键（my-gateway/deepseek-v4-flash）
 *   ③ 后缀 —— 输入末段 == 表内 qualified 键的 model 段（glm-5.3 → zai/glm-5.3）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildSnapshotTable,
  fetchModelsDevData,
  MODELS_DEV_URL,
  serializeSnapshotJson,
  type SnapshotJsonFile,
} from './model-context-builder.js';
import SNAPSHOT, { MODEL_CONTEXT_META, type ModelSnapshotEntry } from './model-context-snapshot.js';

export { MODEL_CONTEXT_META };

/** 用户级快照文件（/models refresh 写入；启动时存在则覆盖内置快照） */
export function userSnapshotFile(): string {
  const home = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(home, 'omni', 'model-context-snapshot.json');
}

/** 查表未命中时的上下文窗口兜底值（256k；仅作展示分母，绝不用来触发强压缩） */
export const DEFAULT_FALLBACK_CONTEXT = 262_144;

/** 思考级别滑条池（Omni 支持的全部级别，含开关语义的 none/auto） */
export const SLIDER_EFFORT_POOL = ['none', 'auto', 'low', 'medium', 'high', 'xhigh', 'max'];

/** 未配置 reasoningEffortOptions 且查表也未命中时回退的历史默认档位 */
export const LEGACY_DEFAULT_EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** 快照表（key 小写）；Map 保序 = 快照文件字母序 → 冲突时结果确定。
 *  可变：/models refresh 热替换（用户级更新优先于内置，不重启即生效）。 */
let TABLE: ReadonlyMap<string, ModelSnapshotEntry> = new Map(Object.entries(SNAPSHOT));

/** 用户级覆盖的元信息（null = 未覆盖，用内置快照） */
let userMeta: { sourceUrl?: string; generatedAt?: string } | null = null;

// 启动加载：用户数据目录存在模型快照 JSON → 覆盖内置（/models refresh 写的）。
// 损坏/缺失静默回退内置——快照是元数据，绝不因读取失败阻塞启动。
try {
  const file = userSnapshotFile();
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as SnapshotJsonFile;
    if (parsed && typeof parsed.models === 'object' && Object.keys(parsed.models).length > 0) {
      TABLE = new Map(Object.entries(parsed.models));
      userMeta = { sourceUrl: parsed.sourceUrl, generatedAt: parsed.generatedAt };
    }
  }
} catch {
  /* 用户文件缺失/损坏 → 保持内置快照 */
}

export type ModelContextMatchType = 'exact' | 'bare' | 'suffix';

export interface ModelContextMatch {
  /** 命中的表键（如 glm-5.3 / moonshotai/kimi-k3） */
  key: string;
  matchType: ModelContextMatchType;
  entry: ModelSnapshotEntry;
}

function lower(s: unknown): string {
  return String(s ?? '').trim().toLowerCase();
}

/**
 * 三级匹配查找。任何模型名（含 "<网关>/<模型>" 形态）都可安全传入；
 * 未命中返回 null —— 调用方按各自兜底策略处理。
 */
export function lookupModelContext(model?: string | null): ModelContextMatch | null {
  const m = lower(model);
  if (!m) return null;
  // ① 精确：小写全串
  const direct = TABLE.get(m);
  if (direct) return { key: m, matchType: 'exact', entry: direct };
  // 输入末段：网关前缀剥掉后的裸 id（无前缀名则等于全串）——后面两級都基于它
  const lastSeg = m.split('/').pop() ?? '';
  if (!lastSeg) return null;
  // ② 裸 id：剥掉 xxx/ 前缀后命中的是无前缀键
  const bare = TABLE.get(lastSeg);
  if (bare && lastSeg !== m) return { key: lastSeg, matchType: 'bare', entry: bare };
  // ③ 后缀：输入末段 == 表内 provider/model 键的 model 段
  //   （覆盖两种形态：my-gw/glm-5.3 与裸输入 deepseek-chat → deepseek/deepseek-chat）
  for (const [k, entry] of TABLE.entries()) {
    if (k.endsWith(`/${lastSeg}`)) return { key: k, matchType: 'suffix', entry };
  }
  return null;
}

/** 模型的上下文窗口 token 上限；未识别返回 undefined（由调用方决定展示/行为兜底） */
export function lookupModelContextWindow(model?: string | null): number | undefined {
  const hit = lookupModelContext(model);
  const c = hit?.entry.c;
  return typeof c === 'number' && c >= MIN_VALID_CONTEXT ? c : undefined;
}

const MIN_VALID_CONTEXT = 4096;

/**
 * DeepSeek 特判（历史结论保留）：DeepSeek 家族经 reasoning_content 字段回传思考、
 * 工具调用链路上不认 reasoning_effort 强度参数 → 只保留 开/关 两档。
 * 匹配覆盖 deepseek 官方与 deepseek-ai/ 托管变体。
 */
function isDeepSeekFamily(key: string): boolean {
  return /(^|\/)(deepseek|deepseek-ai)\b/.test(key);
}

/**
 * 由快照推导该模型的思考级别选项（用于 /variants 面板自动档）：
 * · effort 型 → values ∩ 滑条池（映射到 Omni 认识的档位子集，前置 none/auto 开关档）
 * · toggle / budget_tokens / 无 ro / r=false → 只有 none / auto（仅有开关或不可调强度）
 * · 未命中表 → undefined（调用方回退 LEGACY_DEFAULT_EFFORT_OPTIONS）
 */
export function deriveReasoningLevels(model?: string | null): string[] | undefined {
  const hit = lookupModelContext(model);
  if (!hit) return undefined;
  const { key, entry } = hit;
  if (!isDeepSeekFamily(key)) {
    const eff = entry.ro?.find((o) => o.t === 'effort' && Array.isArray(o.v) && o.v.length > 0);
    if (eff?.v?.length) {
      const chosen = new Set<string>(['none', 'auto', ...SLIDER_EFFORT_POOL.filter((l) => eff.v!.includes(l))]);
      return SLIDER_EFFORT_POOL.filter((l) => chosen.has(l));
    }
  }
  return ['none', 'auto'];
}

/**
 * 解析某模型的 /variants 档位选项（端点展开统一入口）：
 * 显式配置（per-model 或顶层 reasoningEffortOptions）> 查表推导 > 历史默认五档。
 * names 依次尝试（[目录友好名, apiModel 真实名]，任一命中即可）。
 */
export function resolveReasoningEffortOptions(
  explicit: readonly string[] | undefined,
  ...names: (string | undefined)[]
): string[] {
  if (Array.isArray(explicit) && explicit.length > 0) return [...explicit];
  for (const n of names) {
    const derived = deriveReasoningLevels(n);
    if (derived) return derived;
  }
  return [...LEGACY_DEFAULT_EFFORT_OPTIONS];
}

/** token 数人性化显示：1048576 → 1M、204800 → 200k、8192 → 8192 */
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : Math.round(m * 10) / 10}M`;
  }
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}

/** limit 补缺：手动 limit.context 存在则原样返回；缺失时查表填充（只填 context，output 不猜） */
export function autoFillLimit(
  limit: { context?: number; output?: number } | undefined,
  ...names: (string | undefined)[]
): { context?: number; output?: number } | undefined {
  if (limit?.context && limit.context > 0) return limit;
  for (const n of names) {
    const c = lookupModelContextWindow(n);
    if (c) return { ...(limit ?? {}), context: c };
  }
  return limit;
}

export interface ContextWindowInfo {
  /** 生效窗口值（token 数） */
  value: number;
  /** 来源：手动配置 > 数据源自动识别 > 未识别兜底 */
  source: 'manual' | 'auto' | 'fallback';
  /** 来源中文说明（/status 直接拼行用） */
  label: string;
  /** 数据源命中的表键（自动识别时可观测） */
  matchedKey?: string;
}

/** 描述当前生效的上下文窗口（/status /context 展示；兜底 256k 只作分母显示） */
export function describeModelContextWindow(
  manualLimit: number | undefined,
  ...names: (string | undefined)[]
): ContextWindowInfo {
  if (typeof manualLimit === 'number' && manualLimit > 0) {
    return { value: manualLimit, source: 'manual', label: '手动配置' };
  }
  for (const n of names) {
    const hit = lookupModelContext(n);
    const c = hit?.entry.c;
    if (hit && typeof c === 'number' && c >= MIN_VALID_CONTEXT) {
      return { value: c, source: 'auto', label: `models.dev 自动识别${hit.matchType !== 'exact' ? `（${hit.matchType}）` : ''}`, matchedKey: hit.key };
    }
  }
  return { value: DEFAULT_FALLBACK_CONTEXT, source: 'fallback', label: `未识别，按 ${formatTokenCount(DEFAULT_FALLBACK_CONTEXT)} 兜底展示` };
}

export interface ModelCapabilities {
  /** 查表是否命中（false = 未识别，effortOptions 为历史默认五档） */
  found: boolean;
  /** 上下文窗口 token 上限（查表命中；未识别 undefined） */
  context: number | undefined;
  /** 思考级别档位（查表推导；未识别回退历史五档，恒非空） */
  effortOptions: string[];
}

/**
 * 查询单个模型的上下文窗口与思考级别档位（查表；未命中回退保守值）。
 * web 设置「模型配置」能力表联动、providerDiscover 响应共用——
 * 保证前端下拉永不空白、context 可自动补缺。
 */
export function resolveModelCapabilities(model?: string | null): ModelCapabilities {
  return {
    found: lookupModelContext(model) !== null,
    context: lookupModelContextWindow(model),
    effortOptions: deriveReasoningLevels(model) ?? [...LEGACY_DEFAULT_EFFORT_OPTIONS],
  };
}

/* ---------------- 快照状态与在线刷新（/models 命令，CLI/TUI/Web 三端共用） ---------------- */

export interface ModelSnapshotInfo {
  /** 当前生效来源：用户级更新（/models refresh 写过）优先，否则内置快照 */
  source: 'user' | 'builtin';
  /** 条数 */
  count: number;
  /** 生成时间 ISO（用户更新 = 刷新时刻；内置 = 打包进 repo 的时刻） */
  generatedAt: string;
  /** 距今天数（≤0 = 当天） */
  ageDays: number;
  /** 数据源 URL */
  sourceUrl: string;
  /** 用户级快照文件路径（内置来源时为空串） */
  userFile: string;
}

/** 当前生效快照的状态（/models 无参展示；纯同步，不联网） */
export function snapshotInfo(): ModelSnapshotInfo {
  const generatedAt = userMeta?.generatedAt ?? MODEL_CONTEXT_META.generatedAt;
  const ageMs = Date.now() - new Date(generatedAt).getTime();
  return {
    source: userMeta ? 'user' : 'builtin',
    count: TABLE.size,
    generatedAt,
    ageDays: Math.max(0, Math.floor(ageMs / 86_400_000)),
    sourceUrl: userMeta?.sourceUrl ?? MODEL_CONTEXT_META.sourceUrl,
    userFile: userMeta ? userSnapshotFile() : '',
  };
}

/**
 * /models refresh：在线拉取 models.dev → 重建快照 → 写用户数据目录 JSON →
 * **热替换内存表**（当前进程的后续查表立即用新表，无需重启）。
 * 网络失败返回 { ok:false }，旧表（含用户文件）原样保留——默认不自动更新。
 */
export async function refreshModelContextSnapshot(): Promise<
  { ok: true; info: ModelSnapshotInfo; file: string } | { ok: false; error: string }
> {
  try {
    const api = await fetchModelsDevData();
    const table = buildSnapshotTable(api);
    const generatedAt = new Date().toISOString();
    const file = userSnapshotFile();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, serializeSnapshotJson(table, { sourceUrl: MODELS_DEV_URL, generatedAt }), 'utf8');
    // 热替换：内存表 + 元信息一次更新（查表/推导全部读 TABLE，立即生效）
    TABLE = new Map(table);
    userMeta = { sourceUrl: MODELS_DEV_URL, generatedAt };
    return { ok: true, info: snapshotInfo(), file };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

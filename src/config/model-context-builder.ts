/**
 * 模型快照构建纯逻辑（数据源：models.dev api.json）。
 *
 * 两个消费方共用同一份实现：
 *   1. `scripts/build-model-context-snapshot.ts`（npm run models:snapshot）
 *      —— 开发者更新**仓库内置快照** src/config/model-context-snapshot.ts 并提交；
 *   2. 运行时 `/models refresh` 命令（CLI / TUI / Web 三端）
 *      —— 用户在线重建并写入**用户数据目录** ~/.config/omni/model-context-snapshot.json，
 *        当前进程热替换内存表立即生效，下次启动自动覆盖内置。
 *
 * 过滤与归一化（与旧版 scripts/build-model-context-snapshot.mjs 语义一致）：
 *   · 只保留白名单厂商（官方厂商优先级序 + 常用聚合网关），控制体积；
 *   · 只保留「支持文本输入且 context ≥ 4096」的模型（剔除 embedding/TTS/图像类）；
 *   · 键三级写入，优先级从高到低：官方厂商 qualified（provider/model）> 聚合平台
 *     自带斜杠 id > 官方裸 id 补缺——qualified 条目优先、裸 id 只补缺、绝不互相覆盖。
 *   · 值形态 { c: 窗口, r?: 推理支持, ro?: [{t:'effort'|'toggle'|'budget_tokens', v?}] }
 */
export const MODELS_DEV_URL = process.env.MODELS_DEV_URL ?? 'https://models.dev/api.json';
export const SNAPSHOT_MIN_CONTEXT = 4096;

/** 官方厂商白名单（顺序即「裸 id 补缺」的优先级） */
export const OFFICIAL_PROVIDERS = [
  'zai', // Z.ai（GLM 新主站，如 zai/glm-5.3）
  'zhipuai', // 智谱开放平台（glm 系列）
  'deepseek', // DeepSeek
  'moonshotai', // 月之暗面 Kimi
  'moonshotai-cn',
  'alibaba', // 通义 Qwen
  'alibaba-cn',
  'anthropic', // Claude
  'openai', // GPT / o 系
  'google', // Gemini
  'xai', // Grok
  'mistral',
  'minimax',
  'minimax-cn',
  'stepfun', // 阶跃星辰
  'stepfun-ai',
  'volcengine', // 豆包 Seed
  'cohere',
];

/** 聚合平台/托管商白名单（自带 vendor/ 斜杠 id 或网关自有 id） */
export const AGGREGATOR_PROVIDERS = [
  'openrouter',
  'groq',
  'cerebras',
  'nvidia',
  'siliconflow',
  'siliconflow-cn',
  'fireworks-ai',
  'togetherai',
  'ollama',
  'lmstudio',
];

export interface SnapshotModelEntry {
  c?: number;
  r?: boolean;
  ro?: Array<{ t: string; v?: string[] }>;
}

/** 快照表：小写键 → 条目（保序，键字母序输出保证 diff 稳定） */
export type SnapshotTable = Map<string, SnapshotModelEntry>;

/** 在线拉取 models.dev api.json（失败抛错由调用方提示——设计上快照可离线，绝不静默降级成空表） */
export async function fetchModelsDevData(url: string = MODELS_DEV_URL): Promise<Record<string, unknown>> {
  const res = await fetch(url, { headers: { 'user-agent': 'omni-snapshot-builder/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/** reasoning_options → 紧凑 ro 数组：effort 带 v（字符串档位），toggle/budget_tokens 只留类型 */
function normalizeReasoningOptions(raw: unknown): SnapshotModelEntry['ro'] {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: NonNullable<SnapshotModelEntry['ro']> = [];
  for (const o of raw) {
    if (!o || typeof o !== 'object') continue;
    const e = o as Record<string, unknown>;
    if (e.type === 'effort' && Array.isArray(e.values)) {
      const v: string[] = [];
      for (const x of e.values) {
        if (typeof x === 'string' && x.trim() && !v.includes(x.trim())) v.push(x.trim());
      }
      // 单独一个 none 等价开关型，收敛成 toggle 保持一致语义
      if (v.length === 1 && v[0] === 'none') out.push({ t: 'toggle' });
      else if (v.length > 0) out.push({ t: 'effort', v });
    } else if (e.type === 'toggle') {
      out.push({ t: 'toggle' });
    } else if (e.type === 'budget_tokens') {
      out.push({ t: 'budget_tokens' });
    }
  }
  return out.length > 0 ? out : undefined;
}

/** 单个模型 → 快照条目（不满足过滤条件返回 null） */
function toEntry(model: unknown): SnapshotModelEntry | null {
  if (!model || typeof model !== 'object') return null;
  const m = model as Record<string, unknown>;
  const inputMods = Array.isArray((m.modalities as Record<string, unknown> | undefined)?.input)
    ? ((m.modalities as Record<string, unknown>).input as string[])
    : ['text'];
  if (!inputMods.includes('text')) return null; // embedding/TTS/图像生成类剔除
  const ctx = Number(
    (m.limit as Record<string, unknown> | undefined)?.context ?? (m as Record<string, unknown>).context_window ?? 0
  );
  if (!Number.isFinite(ctx) || ctx < SNAPSHOT_MIN_CONTEXT) return null;
  const ro = normalizeReasoningOptions(m.reasoning_options);
  const entry: SnapshotModelEntry = { c: Math.round(ctx) };
  if (m.reasoning === true || (ro !== undefined && ro.length > 0)) entry.r = true;
  if (ro !== undefined) entry.ro = ro;
  return entry;
}

/**
 * 由 api.json 构建快照表（三级写入：官方 qualified > 聚合斜杠 id > 官方裸 id 补缺）。
 * providers 缺失/结构异常时静默跳过（该厂商数据不完整宁可缺，不产出错误条目）。
 */
export function buildSnapshotTable(api: Record<string, unknown>): SnapshotTable {
  const table: SnapshotTable = new Map();

  // 第一遍：聚合平台 —— id 自带斜杠时直接作键（tier 2，可被官方 qualified 覆盖）
  for (const pid of AGGREGATOR_PROVIDERS) {
    const models = (api[pid] as Record<string, unknown> | undefined)?.models;
    if (!models || typeof models !== 'object') continue;
    for (const [mid, m] of Object.entries(models as Record<string, unknown>)) {
      const entry = toEntry(m);
      if (entry) table.set(mid.toLowerCase(), entry);
    }
  }

  // 第二遍：官方厂商 qualified 键（tier 1，覆盖同名聚合条目）；同时收集裸 id 补缺池
  const bareCandidates: Array<[string, SnapshotModelEntry]> = [];
  for (const pid of OFFICIAL_PROVIDERS) {
    const models = (api[pid] as Record<string, unknown> | undefined)?.models;
    if (!models || typeof models !== 'object') continue;
    for (const [mid, m] of Object.entries(models as Record<string, unknown>)) {
      const entry = toEntry(m);
      if (!entry) continue;
      table.set(`${pid}/${mid}`.toLowerCase(), entry);
      const lastSeg = mid.split('/').pop()?.toLowerCase() ?? '';
      if (lastSeg && mid === lastSeg) bareCandidates.push([lastSeg, entry]);
    }
  }

  // 第三遍：裸 id 只补缺，绝不覆盖任何已有条目
  for (const [bare, entry] of bareCandidates) {
    if (!table.has(bare)) table.set(bare, entry);
  }
  return table;
}

/** 快照条目总数（含 qualified 与裸 id 键） */
export function snapshotTableSize(table: SnapshotTable): number {
  return table.size;
}

/** 序列化为仓库内置 TS 源文件文本（带生成头注释；键字母序稳定 diff） */
export function serializeSnapshotTs(
  table: SnapshotTable,
  meta: { sourceUrl: string; generatedAt: string }
): string {
  const sorted = [...table.keys()].sort();
  const lines = sorted.map((k) => {
    const entry = table.get(k)!;
    return `  ${JSON.stringify(k)}: ${JSON.stringify(entry)},`;
  });
  return `/**
 * ⚠️ 该文件由 scripts/build-model-context-snapshot.ts 自动生成 —— 不要手改。
 *
 * 数据源：${meta.sourceUrl}（MIT · 社区维护 · 免费 no-key，OpenCode 同源）
 * 生成时间：${meta.generatedAt}
 * 规模：${sorted.length} 个模型（过滤后；白名单 ${OFFICIAL_PROVIDERS.length + AGGREGATOR_PROVIDERS.length} 家厂商）
 *
 * 用途（无网络、纯同步查表，启动/面板/offscreen 均安全）：
 *   · c = 上下文窗口 token 上限 → 压缩预算自动档 / /status /context 展示
 *   · r = 支持推理输出          → 思考能力判定兜底
 *   · ro = 思考档位形态         → /variants 自动档位推导（effort 带 values）
 *
 * 用户显式配置永远优先于本表；未配置才查表补缺（见 src/config/model-context.ts）。
 * 更新方式：npm run models:snapshot（内置快照）或运行时 /models refresh（用户级，写 ~/.config/omni/）。
 */

/** 单个模型的快照条目 */
export interface ModelSnapshotEntry {
  /** 上下文窗口（token 数） */
  c?: number;
  /** 是否支持推理输出 */
  r?: boolean;
  /** 思考档位形态：effort（带档位值）/ toggle（开关）/ budget_tokens（预算式） */
  ro?: Array<{ t: string; v?: string[] }>;
}

/** 快照元信息（来源与生成时间，/status 可观测性展示用） */
export const MODEL_CONTEXT_META = {
  sourceUrl: '${meta.sourceUrl}',
  generatedAt: '${meta.generatedAt}',
} as const;

export default {
${lines.join('\n')}
} as Record<string, ModelSnapshotEntry>;
`;
}

/** 用户级快照文件的磁盘结构（/models refresh 写入；启动时同步读取覆盖内置） */
export interface SnapshotJsonFile {
  sourceUrl: string;
  generatedAt: string;
  models: Record<string, SnapshotModelEntry>;
}

/** 序列化为用户级 JSON 文件内容（/models refresh 写入 ~/.config/omni/model-context-snapshot.json） */
export function serializeSnapshotJson(
  table: SnapshotTable,
  meta: { sourceUrl: string; generatedAt: string }
): string {
  const sorted: Record<string, SnapshotModelEntry> = {};
  for (const k of [...table.keys()].sort()) sorted[k] = table.get(k)!;
  const file: SnapshotJsonFile = { sourceUrl: meta.sourceUrl, generatedAt: meta.generatedAt, models: sorted };
  return JSON.stringify(file);
}

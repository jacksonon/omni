/**
 * /model add 的模型解析与配置持久化。
 *
 * 用法：/model add <名称> [--base-url <url>] [--api-key <key>] [--user-agent <ua>]
 *   · 缺省字段回退顶层配置（baseURL/apiKey/userAgent），与 config `models` 的语义一致；
 *   · 持久化：把新模型追加到配置文件 models 字段（纯 JSON 文件自动改写；
 *     带注释的 JSONC 不自动改，避免破坏注释，提示手动添加）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { OmniConfig } from './index.js';
import { parseJsonc } from './jsonc.js';
import type { McpServerConfig, ToolApprovalMode } from '../tools/mcp.js';

/** /model add 解析结果：ok=true 时携带模型名与端点字段（缺省字段不在结果里，调用方回退顶层） */
export type ModelAddArgs =
  | { ok: true; name: string; baseURL?: string; apiKey?: string; userAgent?: string }
  | { ok: false; error: string };

/**
 * 解析 /model add 的参数（name 之后的原始文本）：
 *   第一个 token 是模型名，其后为 --base-url / --api-key / --user-agent 键值对。
 * 未知 flag / 缺值 / 缺模型名 → 返回 { ok: false, error }。
 */
export function parseModelAddArgs(raw: string): ModelAddArgs {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { ok: false, error: '用法：/model add <名称> [--base-url <url>] [--api-key <key>] [--user-agent <ua>]' };
  }
  const name = tokens[0];
  if (name.startsWith('--') || name.startsWith('-')) {
    return { ok: false, error: `缺少模型名（/model add <名称> ...，收到「${name}」）` };
  }
  const rest = tokens.slice(1);
  const out: { baseURL?: string; apiKey?: string; userAgent?: string } = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i].toLowerCase();
    const val = rest[i + 1];
    if (flag === '--base-url' || flag === '--baseurl') {
      if (!val || val.startsWith('--')) return { ok: false, error: `--base-url 缺少值` };
      out.baseURL = val;
      i++;
    } else if (flag === '--api-key' || flag === '--apikey') {
      if (!val || val.startsWith('--')) return { ok: false, error: `--api-key 缺少值` };
      out.apiKey = val;
      i++;
    } else if (flag === '--user-agent' || flag === '--useragent') {
      if (!val || val.startsWith('--')) return { ok: false, error: `--user-agent 缺少值` };
      out.userAgent = val;
      i++;
    } else {
      return { ok: false, error: `未知参数「${rest[i]}」（支持 --base-url / --api-key / --user-agent）` };
    }
  }
  return { ok: true, name, ...out };
}

/** 持久化结果：ok=true 时 file 为写入的文件路径；ok=false 时 message 说明原因与手动添加方式 */
export interface PersistModelResult {
  ok: boolean;
  file: string | null;
  message: string;
}

/** 配置文件的读取结果：成功时 obj 为可改写的纯 JSON 对象、file 为写入路径 */
type LoadConfigResult =
  | { ok: true; obj: Record<string, unknown>; file: string }
  | { ok: false; file: null; message: string };

/**
 * 定位并解析配置文件（供 /model add、/settings statusline 等持久化共用）。
 *
 * 目标文件（按优先级）：自定义配置（OMNI_CONFIG / --config）> 项目配置（cwd 向上）> 全局配置；
 * 都不存在时新建 ./omni.json。目标取自 cfg.sources 里**最后一个**文件路径（sources 按
 * 低→高优先级排列，环境变量/CLI 标签不是文件路径会被过滤）。
 *
 * 只读**纯 JSON**（JSON.parse 成功 = 无注释/无尾逗号）——带注释的 JSONC 不自动改，
 * 返回提示让用户手动添加（程序化改写会破坏注释）。
 */
function loadConfigObject(cfg: OmniConfig): LoadConfigResult {
  const fileSources = (cfg.sources ?? []).filter(
    (s) => /\.(json|jsonc)$/i.test(s) && existsSync(s) && !s.startsWith('环境变量')
  );
  const target = fileSources.length > 0 ? fileSources[fileSources.length - 1] : null;
  const file = target ?? path.join(process.cwd(), 'omni.json'); // 无配置 → 新建项目配置

  let parsed: unknown;
  if (target) {
    const text = readFileSync(target, 'utf8');
    try {
      parsed = JSON.parse(text);
    } catch {
      // JSONC（注释/尾逗号）或格式异常：不自动改写（否则破坏注释），提示手动添加
      return {
        ok: false,
        file: null,
        message: `「${target}」带注释（JSONC），未自动修改——请手动在配置文件添加对应字段`,
      };
    }
  } else {
    parsed = {}; // 新建
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, file: null, message: '配置文件格式异常（顶层不是对象），未自动修改——请手动添加字段' };
  }
  return { ok: true, obj: parsed as Record<string, unknown>, file };
}

/**
 * 把模型端点写入配置文件（/model add 持久化）。
 * 端点只认 providers 分组（旧版扁平 models 表已移除）：`/model add <名称>` 建立一个
 * 以模型名命名的单模型 provider 分组（`providers.<名称>.models.<名称>`），端点字段归
 * provider 级；模型级只留空对象（缺省字段继承 provider，不烘焙进配置文件）。
 */
export function persistModelToConfig(
  name: string,
  endpoint: { baseURL?: string; apiKey?: string; userAgent?: string },
  cfg: OmniConfig
): PersistModelResult {
  const res = loadConfigObject(cfg);
  if (!res.ok) {
    return {
      ok: false,
      file: null,
      message: `${res.message}（providers 字段手动添加："${name}": { "baseURL": "...", "apiKey": "...", "models": { "${name}": {} } }）`,
    };
  }
  const cfgObj = res.obj;
  const providers = providersOf(cfgObj);
  const p = (providers[name] && typeof providers[name] === 'object' && !Array.isArray(providers[name])
    ? { ...(providers[name] as Record<string, unknown>) }
    : {}) as Record<string, unknown>;
  if (endpoint.baseURL) p.baseURL = endpoint.baseURL;
  if (endpoint.apiKey) p.apiKey = endpoint.apiKey;
  if (endpoint.userAgent) p.userAgent = endpoint.userAgent;
  const models = (p.models && typeof p.models === 'object' && !Array.isArray(p.models)
    ? (p.models as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  models[name] = {}; // 模型级不写端点（继承 provider）；元数据字段由设置面板/手动编辑
  p.models = models;
  providers[name] = p;
  cfgObj.providers = providers;
  try {
    writeFileSync(res.file, `${JSON.stringify(cfgObj, null, 2)}\n`);
  } catch (err) {
    return {
      ok: false,
      file: null,
      message: `写入配置失败：${(err as Error)?.message ?? err}（可手动在配置文件 providers 字段添加）`,
    };
  }
  return { ok: true, file: res.file, message: `已写入 ${res.file}（下次会话自动加载；可再 /model <名称> 切换）` };
}

/**
 * 把状态行段顺序 + 对齐方式写入配置文件的 statusline / statuslineAlign 字段
 * （/settings statusline Enter 保存持久化）。应用已即时生效（state.statusline /
 * state.statuslineAlign 更新），这里只落盘供下次会话加载。
 */
export function persistStatuslineToConfig(
  order: string[],
  cfg: OmniConfig,
  align?: 'left' | 'center' | 'right'
): PersistModelResult {
  const res = loadConfigObject(cfg);
  if (!res.ok) {
    return { ok: false, file: null, message: `${res.message}（statusline 字段手动添加：${JSON.stringify(order)}）` };
  }
  res.obj.statusline = order;
  if (align) res.obj.statuslineAlign = align; // 对齐方式随段配置一起落盘
  try {
    writeFileSync(res.file, `${JSON.stringify(res.obj, null, 2)}\n`);
  } catch (err) {
    return {
      ok: false,
      file: null,
      message: `写入配置失败：${(err as Error)?.message ?? err}（statusline 字段手动添加：${JSON.stringify(order)}）`,
    };
  }
  return { ok: true, file: res.file, message: `已保存状态行配置 → ${res.file}（重启后同样生效）` };
}

/**
 * 把界面语言写入配置文件的 language 字段（/settings 语言面板 Enter 保存持久化）。
 * 应用已即时生效（state.language 更新，界面 chrome 按新语言重绘），这里只落盘供下次会话加载。
 */
export function persistLanguageToConfig(lang: string, cfg: OmniConfig): PersistModelResult {  const res = loadConfigObject(cfg);
  if (!res.ok) {
    return { ok: false, file: null, message: `${res.message}（language 字段手动添加："${lang}"）` };
  }
  res.obj.language = lang;
  try {
    writeFileSync(res.file, `${JSON.stringify(res.obj, null, 2)}\n`);
  } catch (err) {
    return {
      ok: false,
      file: null,
      message: `写入配置失败：${(err as Error)?.message ?? err}（language 字段手动添加："${lang}"）`,
    };
  }
  return { ok: true, file: res.file, message: `已保存语言配置 → ${res.file}（重启后同样生效）` };
}

/**
 * 把 Web 界面主题写入**全局配置**的 webTheme 字段（设置面板「主题」tab 切换持久化）。
 * 运行时已即时生效（前端按主题切换 CSS 类），这里只落盘供下次启动 web 自动应用。
 * 与 webWorkspace 一致写全局配置（~/.config/omni/omni.json），不依赖项目级配置。
 */
export function persistWebThemeToConfig(theme: 'light' | 'dark' | 'system', _cfg: OmniConfig): PersistModelResult {
  const file = globalConfigFile();
  let obj: Record<string, unknown> = {};
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8');
    if (text.trim()) {
      try {
        obj = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return {
          ok: false, file: null,
          message: `「${file}」带注释（JSONC），未自动修改——请手动添加 "webTheme": "${theme}"`,
        };
      }
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, file: null, message: `全局配置格式异常，未自动修改——请手动添加 "webTheme": "${theme}"` };
  }
  obj.webTheme = theme;
  try {
    writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
  } catch (err) {
    return { ok: false, file: null, message: `写入全局配置失败：${(err as Error)?.message ?? err}` };
  }
  return { ok: true, file, message: `已保存主题配置 → ${file}（重启后同样生效）` };
}

export function persistWebConcurrencyToConfig(val: number, _cfg: OmniConfig): PersistModelResult {
  const file = globalConfigFile();
  let obj: Record<string, unknown> = {};
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8');
    if (text.trim()) {
      try { obj = JSON.parse(text) as Record<string, unknown>; }
      catch { return { ok: false, file: null, message: `「${file}」带注释（JSONC），未自动修改——请手动添加 "webConcurrency": ${val}` }; }
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, file: null, message: `全局配置格式异常，未自动修改——请手动添加 "webConcurrency": ${val}` };
  }
  obj.webConcurrency = val;
  try { writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`); }
  catch (err) { return { ok: false, file: null, message: `写入全局配置失败：${(err as Error)?.message ?? err}` }; }
  return { ok: true, file, message: `已保存并行会话上限 → ${file}` };
}

/* ---------------- Providers 分组持久化（设置 → 模型配置：一个端点配置多个模型） ----------------
 * 全部写**全局配置**（~/.config/omni/omni.json，XDG-aware，机器级偏好跨项目生效）。
 * 沿用「纯 JSON 才自动改、JSONC 拒绝」模式。
 * 端点/密钥只认 providers 分组（旧版扁平 models 表已移除）。 */

export interface ProviderConfigPatch {
  provider: string;
  baseURL?: string;
  apiKey?: string;
  userAgent?: string;
}

export interface ProviderModelPatch {
  provider: string;
  modelName: string;
  apiModel?: string;
  displayName?: string;
  reasoningEffortOptions?: string[];
  reasoningEffort?: string;
  contextLimit?: number;
  variants?: unknown;
  /** 覆盖 provider 级端点（D8 继承/覆盖开关）；缺省 = 继承（移除模型级覆盖字段） */
  overrideBaseURL?: string;
  overrideApiKey?: string;
}

/** 读取全局配置为可改写的纯 JSON 对象（JSONC 拒绝自动改——程序化改写会破坏注释） */
function loadGlobalConfigObject(
  file: string,
  fieldDesc: string
): { ok: true; obj: Record<string, unknown> } | { ok: false; file: null; message: string } {
  let obj: Record<string, unknown> = {};
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8');
    if (text.trim()) {
      try {
        obj = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return { ok: false, file: null, message: `「${file}」带注释（JSONC），未自动修改——请手动配置${fieldDesc}` };
      }
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, file: null, message: `全局配置格式异常，未自动修改——请手动配置${fieldDesc}` };
  }
  return { ok: true, obj };
}

/** 写回全局配置 JSON（自动建目录），返回统一结果 */
function persistGlobalJson(file: string, obj: Record<string, unknown>, fieldDesc: string): PersistModelResult {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
  } catch (err) {
    return { ok: false, file: null, message: `写入全局配置失败：${(err as Error)?.message ?? err}（可手动配置${fieldDesc}）` };
  }
  return { ok: true, file, message: `已保存 → ${file}（重启后同样生效）` };
}

function providersOf(obj: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return obj.providers && typeof obj.providers === 'object' && !Array.isArray(obj.providers)
    ? (obj.providers as Record<string, Record<string, unknown>>)
    : {};
}

/**
 * 新建/更新 provider（provider 级共享 baseURL/apiKey/userAgent）。
 * 合并已有字段：缺省字段保留旧值；provider 名即 key（改名 = 删除后重建）。
 */
export function persistProviderConfigToGlobal(patch: ProviderConfigPatch, _cfg: OmniConfig): PersistModelResult {
  const provider = patch.provider.trim();
  if (!provider) return { ok: false, file: null, message: '缺少 provider 名称' };
  const file = globalConfigFile();
  const load = loadGlobalConfigObject(file, ` providers.${provider}`);
  if (!load.ok) return load;
  const providers = providersOf(load.obj);
  const cur = (providers[provider] && typeof providers[provider] === 'object' && !Array.isArray(providers[provider])
    ? { ...(providers[provider] as Record<string, unknown>) }
    : {}) as Record<string, unknown>;
  if (patch.baseURL !== undefined) cur.baseURL = patch.baseURL;
  if (patch.apiKey !== undefined) cur.apiKey = patch.apiKey;
  if (patch.userAgent !== undefined) cur.userAgent = patch.userAgent;
  providers[provider] = cur;
  load.obj.providers = providers;
  return persistGlobalJson(file, load.obj, ` providers.${provider}`);
}

/**
 * 新增/更新组内模型。模型级字段（apiModel/displayName/级别/上下文/variants）合并写入；
 * overrideBaseURL/overrideApiKey 提供 = 覆盖 provider 级端点，缺省 = 继承（移除覆盖字段）。
 */
export function persistProviderModelToGlobal(patch: ProviderModelPatch, _cfg: OmniConfig): PersistModelResult {
  const provider = patch.provider.trim();
  const modelName = patch.modelName.trim();
  if (!provider) return { ok: false, file: null, message: '缺少 provider 名称' };
  if (!modelName) return { ok: false, file: null, message: '缺少模型名' };
  const file = globalConfigFile();
  const load = loadGlobalConfigObject(file, ` providers.${provider}.models`);
  if (!load.ok) return load;
  const providers = providersOf(load.obj);
  const p = (providers[provider] && typeof providers[provider] === 'object' && !Array.isArray(providers[provider])
    ? { ...(providers[provider] as Record<string, unknown>) }
    : {}) as Record<string, unknown>;
  const models = (p.models && typeof p.models === 'object' && !Array.isArray(p.models)
    ? (p.models as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const entry = (models[modelName] && typeof models[modelName] === 'object' && !Array.isArray(models[modelName])
    ? { ...(models[modelName] as Record<string, unknown>) }
    : {}) as Record<string, unknown>;
  if (patch.apiModel !== undefined) entry.apiModel = patch.apiModel;
  if (patch.displayName !== undefined) entry.displayName = patch.displayName;
  if (patch.reasoningEffortOptions !== undefined) entry.reasoningEffortOptions = patch.reasoningEffortOptions;
  if (patch.reasoningEffort !== undefined) entry.reasoningEffort = patch.reasoningEffort;
  if (patch.variants !== undefined) entry.variants = patch.variants;
  if (patch.contextLimit !== undefined) {
    const limit = entry.limit && typeof entry.limit === 'object' && !Array.isArray(entry.limit)
      ? { ...(entry.limit as Record<string, unknown>) }
      : {};
    limit.context = patch.contextLimit;
    entry.limit = limit;
  }
  if (patch.overrideBaseURL !== undefined) entry.baseURL = patch.overrideBaseURL;
  else delete entry.baseURL; // 继承：移除模型级覆盖
  if (patch.overrideApiKey !== undefined) entry.apiKey = patch.overrideApiKey;
  else delete entry.apiKey;
  models[modelName] = entry;
  p.models = models;
  providers[provider] = p;
  load.obj.providers = providers;
  return persistGlobalJson(file, load.obj, ` providers.${provider}.models.${modelName}`);
}

/** 删除整个 provider（组内模型一并移除） */
export function removeProviderFromGlobal(provider: string, _cfg: OmniConfig): PersistModelResult {
  const name = provider.trim();
  if (!name) return { ok: false, file: null, message: '缺少 provider 名称' };
  const file = globalConfigFile();
  const load = loadGlobalConfigObject(file, ' providers 字段');
  if (!load.ok) return load;
  const providers = providersOf(load.obj);
  if (!(name in providers)) return { ok: false, file: null, message: `配置里没有 provider「${name}」` };
  const next = { ...providers };
  delete next[name];
  if (Object.keys(next).length > 0) load.obj.providers = next;
  else delete load.obj.providers;
  return persistGlobalJson(file, load.obj, ' providers 字段');
}

/** 删除组内单个模型（删空后保留空 provider 壳，UI 提示是否继续删 provider） */
export function removeProviderModelFromGlobal(provider: string, modelName: string, _cfg: OmniConfig): PersistModelResult {
  const pname = provider.trim();
  const mid = modelName.trim();
  if (!pname || !mid) return { ok: false, file: null, message: '缺少 provider 或模型名' };
  const file = globalConfigFile();
  const load = loadGlobalConfigObject(file, ' providers 字段');
  if (!load.ok) return load;
  const providers = providersOf(load.obj);
  const p = providers[pname];
  if (!p || typeof p !== 'object') return { ok: false, file: null, message: `配置里没有 provider「${pname}」` };
  const models = (p.models && typeof p.models === 'object' && !Array.isArray(p.models)
    ? { ...(p.models as Record<string, unknown>) }
    : {}) as Record<string, unknown>;
  if (!(mid in models)) return { ok: false, file: null, message: `provider「${pname}」里没有模型「${mid}」` };
  delete models[mid];
  if (Object.keys(models).length > 0) p.models = models;
  else delete p.models;
  providers[pname] = p;
  load.obj.providers = providers;
  return persistGlobalJson(file, load.obj, ' providers 字段');
}

/**
 * 把默认模型名写入**全局配置**顶层 model 字段（Web 设置面板「设为默认」——面板只写全局，
 * 不依赖 loadConfigObject 的层叠目标，避免无配置文件时落到 cwd）。
 */
export function persistModelDefaultToGlobal(model: string): PersistModelResult {
  const name = model.trim();
  if (!name) return { ok: false, file: null, message: '缺少模型名' };
  const file = globalConfigFile();
  const load = loadGlobalConfigObject(file, ' model 字段');
  if (!load.ok) return load;
  load.obj.model = name;
  return persistGlobalJson(file, load.obj, ' model 字段');
}

/**
 * 把默认模型名写入配置文件顶层 model 字段（/model <名称> 切换 / 面板确认持久化）。
 * 运行时已即时生效（interactive 重建 client + 更新 modelRuntime），这里只落盘供下次会话加载。
 */
export function persistModelDefaultToConfig(model: string, cfg: OmniConfig): PersistModelResult {
  const res = loadConfigObject(cfg);
  if (!res.ok) {
    return { ok: false, file: null, message: `${res.message}（model 字段手动添加："${model}"）` };
  }
  res.obj.model = model;
  try {
    writeFileSync(res.file, `${JSON.stringify(res.obj, null, 2)}\n`);
  } catch (err) {
    return {
      ok: false,
      file: null,
      message: `写入配置失败：${(err as Error)?.message ?? err}（model 字段手动添加："${model}"）`,
    };
  }
  return { ok: true, file: res.file, message: `已保存默认模型 → ${res.file}（下次启动默认使用 ${model}）` };
}

/**
 * 在配置文件的 providers 分组里定位模型（per-model 持久化用）：
 * · 模型名含 `/`（`provider/mid` 形态）→ 直接定位该组；
 * · 否则在全部组里按 mid 查找（模型名即组内 id）。
 * 找不到返回 null（模型不在 providers 里 → 只能写顶层全局字段）。
 */
function locateProviderModel(
  obj: Record<string, unknown>,
  modelName: string
): { provider: string; mid: string } | null {
  const providers = providersOf(obj);
  if (modelName.includes('/')) {
    const [p, m] = modelName.split('/');
    const g = providers[p];
    if (g && typeof g === 'object' && g.models && typeof g.models === 'object' && (g.models as Record<string, unknown>)[m]) {
      return { provider: p, mid: m };
    }
    return null;
  }
  for (const [p, g] of Object.entries(providers)) {
    if (g && typeof g === 'object' && g.models && typeof g.models === 'object') {
      if (modelName in (g.models as Record<string, unknown>)) return { provider: p, mid: modelName };
    }
  }
  return null;
}

/**
 * 把思考级别写入配置文件（/variants 面板确认持久化）。
 * 现在思考级别是 **per-model**（第一百四十次后）：当前模型在配置文件 providers 分组里
 * → 写入 providers.<组>.models.<模型>.reasoningEffort（该模型专属，切换回其他模型不影响）；
 * 否则写入顶层 reasoningEffort（全局默认，所有未配置专属级别的模型共用）。
 * 运行时已即时生效（interactive 每轮同步进 runOpts.reasoningEffort），这里只落盘供下次会话加载。
 */
export function persistReasoningEffortToConfig(
  effort: string,
  cfg: OmniConfig,
  modelName?: string
): PersistModelResult {
  const res = loadConfigObject(cfg);
  if (!res.ok) {
    return {
      ok: false,
      file: null,
      message: `${res.message}（reasoningEffort 字段手动添加${modelName ? `：providers 组内模型 reasoningEffort` : ''} = "${effort}"）`,
    };
  }
  const cfgObj = res.obj;
  const loc = modelName ? locateProviderModel(cfgObj, modelName) : null;
  if (loc) {
    // per-model：模型在 providers 分组里 → 写组内模型专属级别
    const g = cfgObj.providers as Record<string, Record<string, unknown>>;
    const group = g[loc.provider] as Record<string, unknown>;
    const models = group.models as Record<string, unknown>;
    const entry = (models[loc.mid] && typeof models[loc.mid] === 'object' && !Array.isArray(models[loc.mid])
      ? { ...(models[loc.mid] as Record<string, unknown>) }
      : {}) as Record<string, unknown>;
    entry.reasoningEffort = effort;
    models[loc.mid] = entry;
    group.models = models;
  } else {
    // 全局默认：模型不在 providers 分组（或未指定模型）→ 顶层 reasoningEffort
    cfgObj.reasoningEffort = effort;
  }
  try {
    writeFileSync(res.file, `${JSON.stringify(cfgObj, null, 2)}\n`);
  } catch (err) {
    return {
      ok: false,
      file: null,
      message: `写入配置失败：${(err as Error)?.message ?? err}（reasoningEffort 字段手动添加${modelName ? `：providers 组内模型 reasoningEffort` : ''} = "${effort}"）`,
    };
  }
  return {
    ok: true,
    file: res.file,
    message: `已保存思考级别 → ${res.file}（重启后同样生效${loc ? `；仅对模型 ${loc.mid} 生效` : '；全局默认'}）`,
  };
}

/**
 * 把命名 variant 选择写入配置文件（1.0 P0-3，/variants <id> 切换命名叠加层后持久化）：
 * 写 providers.<组>.models.<模型>.variant（仅该模型生效）；variantId = null 表示清除（回到基础级别）。
 * 命名 variant 是 per-model 概念——模型不在 providers 分组时报错提示先在配置里定义 variants。
 */
export function persistVariantToConfig(
  variantId: string | null,
  cfg: OmniConfig,
  modelName?: string
): PersistModelResult {
  const res = loadConfigObject(cfg);
  if (!res.ok) {
    return {
      ok: false,
      file: null,
      message: `${res.message}（variant 字段手动添加${modelName ? `：providers 组内模型 variant` : ''}${variantId ? ` = "${variantId}"` : '（删除该字段）'}）`,
    };
  }
  const cfgObj = res.obj;
  const loc = modelName ? locateProviderModel(cfgObj, modelName) : null;
  if (!loc) {
    return {
      ok: false,
      file: res.file,
      message: `命名 variant 仅支持配置文件 providers 分组里的模型（当前模型 ${modelName ?? ''} 不在任何分组）——请先在 providers."<组>".models."${modelName ?? ''}".variants 定义。`,
    };
  }
  const g = cfgObj.providers as Record<string, Record<string, unknown>>;
  const group = g[loc.provider] as Record<string, unknown>;
  const models = group.models as Record<string, unknown>;
  const entry = (models[loc.mid] && typeof models[loc.mid] === 'object' && !Array.isArray(models[loc.mid])
    ? { ...(models[loc.mid] as Record<string, unknown>) }
    : {}) as Record<string, unknown>;
  if (variantId) entry.variant = variantId;
  else delete entry.variant;
  models[loc.mid] = entry;
  group.models = models;
  try {
    writeFileSync(res.file, `${JSON.stringify(cfgObj, null, 2)}\n`);
  } catch (err) {
    return { ok: false, file: null, message: `写入配置失败：${(err as Error)?.message ?? err}` };
  }
  return {
    ok: true,
    file: res.file,
    message: `已保存命名变体 → ${res.file}（仅对模型 ${loc.mid} 生效${variantId ? '' : '，已清除'}）`,
  };
}

/* ---------------- Web / Electron 工作目录持久化 ---------------- */

/**
 * 全局配置文件路径（$XDG_CONFIG_HOME/omni/ 或 ~/.config/omni/ 下）。
 * 工作目录是机器级偏好，**只写全局配置**——不能进项目配置（切换工作区后
 * "项目"就变了，写进新目录的项目配置会形成循环）。已存在 omni.jsonc 时返回它
 * （读取兼容；写入会因 JSONC 注释拒绝自动改并提示手动添加）。
 */
function globalConfigFile(): string {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const dir = path.join(configHome, 'omni');
  const json = path.join(dir, 'omni.json');
  if (existsSync(json)) return json;
  const jsonc = path.join(dir, 'omni.jsonc');
  if (existsSync(jsonc)) return jsonc;
  return json; // 都不存在 → 新建 omni.json
}

/**
 * 把 MCP server 写入**全局**配置的 mcpServers 字段（1.0 P1-6 预设用——预设是
 * 机器级能力，不进项目配置）。JSONC 文件拒绝自动改（提示手动）；同名覆盖。
 */
export function persistMcpServerToGlobal(name: string, serverCfg: McpServerConfig): PersistModelResult {
  const file = globalConfigFile();
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = parseJsonc(readFileSync(file, 'utf8'));
    obj = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch (err) {
    return { ok: false, file, message: `全局配置不是纯 JSON（${(err as Error)?.message ?? '解析失败'}）——请手动把 ${name} 加进 mcpServers 字段。` };
  }
  if (!obj || typeof obj !== 'object') obj = {};
  const servers = (obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)
    ? (obj.mcpServers as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  servers[name] = serverCfg;
  obj.mcpServers = servers;
  try {
    writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
  } catch (err) {
    return { ok: false, file, message: `写入全局配置失败：${(err as Error)?.message ?? err}` };
  }
  return { ok: true, file, message: `已写入全局配置 mcpServers.${name} → ${file}` };
}

/** 读取持久化的 Web/Electron 工作目录（webWorkspace 字段；无/非法返回 null） */
export function readPersistedWebWorkspace(): string | null {
  try {
    const file = globalConfigFile();
    if (!existsSync(file)) return null;
    const data = parseJsonc(readFileSync(file, 'utf8')) as Record<string, unknown> | null;
    const v = data?.webWorkspace;
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

/**
 * 从全局配置的 webWorkspaces 清单移除一个工作区（界面「移除工作区」时调用）。
 * 若被移除的是当前记录的 webWorkspace，则顺带指向剩余清单的第一项（无则删字段）。
 * 返回移除后的完整清单（调用方同步内存态）。
 */
export function removeWebWorkspaceFromConfig(dir: string): PersistModelResult & { workspaces: string[] } {
  const empty: string[] = [];
  const file = globalConfigFile();
  if (!existsSync(file)) return { ok: false, file: null, message: '全局配置不存在', workspaces: empty };
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return { ok: false, file: null, message: `「${file}」为 JSONC 或格式异常，未自动修改——请手动编辑 webWorkspaces 字段`, workspaces: empty };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, file: null, message: '全局配置格式异常', workspaces: empty };
  }
  const list = Array.isArray(obj.webWorkspaces)
    ? (obj.webWorkspaces as unknown[]).filter((x): x is string => typeof x === 'string' && !!x.trim())
    : [];
  const next = list.filter((x) => x !== dir);
  obj.webWorkspaces = next;
  if (obj.webWorkspace === dir) {
    if (next.length > 0) obj.webWorkspace = next[0];
    else delete obj.webWorkspace;
  }
  try {
    writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
  } catch (err) {
    return { ok: false, file: null, message: `写入配置失败：${(err as Error)?.message ?? err}`, workspaces: list };
  }
  return { ok: true, file, message: `已移除工作区 ${dir}`, workspaces: next };
}

/**
 * 把 Web/Electron 工作目录写入**全局配置**的 webWorkspace 字段（界面切换时调用），
 * 并同步维护 webWorkspaces 已知工作区列表（去重、最新在前、上限 20）——
 * 侧栏分组据此渲染。运行时已即时生效，这里只落盘。
 */
export function persistWebWorkspaceToConfig(dir: string): PersistModelResult {
  const file = globalConfigFile();
  let obj: Record<string, unknown> = {};
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8');
    if (text.trim()) {
      try {
        obj = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return {
          ok: false,
          file: null,
          message: `「${file}」带注释（JSONC），未自动修改——请手动添加 "webWorkspace": "${dir}"`,
        };
      }
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, file: null, message: `全局配置格式异常（顶层不是对象），未自动修改——请手动添加 "webWorkspace": "${dir}"` };
  }
  obj.webWorkspace = dir;
  // 维护已知工作区列表：旧列表（缺省时从当前 webWorkspace 播种）+ 新目录置顶
  const prev = Array.isArray(obj.webWorkspaces)
    ? (obj.webWorkspaces as unknown[]).filter((x): x is string => typeof x === 'string' && !!x.trim())
    : typeof obj.webWorkspace === 'string' && obj.webWorkspace.trim()
      ? [obj.webWorkspace.trim()]
      : [];
  obj.webWorkspaces = [dir, ...prev.filter((x) => x !== dir)].slice(0, 20);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
  } catch (err) {
    return { ok: false, file: null, message: `写入配置失败：${(err as Error)?.message ?? err}（可手动添加 "webWorkspace": "${dir}"）` };
  }
  return { ok: true, file, message: `已保存工作目录 → ${file}（下次启动自动应用）` };
}

/* ---------------- MCP 服务器增删持久化（/mcp add|remove） ---------------- */

/** /mcp add 解析结果 */
export type McpAddArgs =
  | { ok: true; name: string; cfg: McpServerConfig }
  | { ok: false; error: string };

/**
 * 解析 /mcp add 的参数：
 *   /mcp add <名称> <command> [args...]                stdio 服务器（command + args）
 *   /mcp add <名称> --url <url> [--approval <mode>]    streamable HTTP 服务器
 *   [--approval auto|prompt|writes|approve]            默认审批模式
 *   [--enabled-tools a,b,c] / [--disabled-tools a,b,c] 白黑名单
 */
export function parseMcpAddArgs(raw: string): McpAddArgs {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return {
      ok: false,
      error: '用法：/mcp add <名称> <command> [args...]（stdio）| /mcp add <名称> --url <url>（HTTP）[--approval <mode>] [--enabled-tools a,b] [--disabled-tools a,b]',
    };
  }
  const name = tokens[0];
  if (name.startsWith('--')) {
    return { ok: false, error: `缺少服务器名称（/mcp add <名称> ...，收到「${name}」）` };
  }
  const rest = tokens.slice(1);
  const cfg: McpServerConfig = {};
  const args: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === '--url') {
      const v = rest[i + 1];
      if (!v || v.startsWith('--')) return { ok: false, error: '--url 缺少值' };
      cfg.url = v;
      i++;
    } else if (tok === '--approval' || tok === '--approval-mode') {
      const v = rest[i + 1];
      if (!v || !['auto', 'prompt', 'writes', 'approve'].includes(v)) {
        return { ok: false, error: `--approval 值非法（支持 auto/prompt/writes/approve，收到「${v ?? ''}」）` };
      }
      cfg.defaultToolsApprovalMode = v as ToolApprovalMode;
      i++;
    } else if (tok === '--enabled-tools' || tok === '--enabled') {
      const v = rest[i + 1];
      if (!v) return { ok: false, error: '--enabled-tools 缺少值（逗号分隔）' };
      cfg.enabledTools = v.split(',').map((s) => s.trim()).filter(Boolean);
      i++;
    } else if (tok === '--disabled-tools' || tok === '--disabled') {
      const v = rest[i + 1];
      if (!v) return { ok: false, error: '--disabled-tools 缺少值（逗号分隔）' };
      cfg.disabledTools = v.split(',').map((s) => s.trim()).filter(Boolean);
      i++;
    } else if (tok.startsWith('--')) {
      return { ok: false, error: `未知参数「${tok}」（支持 --url / --approval / --enabled-tools / --disabled-tools）` };
    } else {
      // 非 flag：第一个是 command，其后是 args
      if (!cfg.command) cfg.command = tok;
      else args.push(tok);
    }
  }
  if (cfg.command && cfg.url) {
    return { ok: false, error: 'command 与 --url 不能同时指定（stdio 与 HTTP 二选一）' };
  }
  if (!cfg.command && !cfg.url) {
    return { ok: false, error: '缺少启动命令（/mcp add <名称> <command> ...）或 --url（HTTP 端点）' };
  }
  if (args.length > 0) cfg.args = args;
  return { ok: true, name, cfg };
}

/**
 * 把 MCP 服务器写入配置文件的 mcpServers 字段（/mcp add 持久化）。
 * 运行时已连接并注入工具链，这里只落盘供下次会话自动加载。
 */
export function persistMcpServerToConfig(name: string, cfg: McpServerConfig, omniCfg: OmniConfig): PersistModelResult {
  const res = loadConfigObject(omniCfg);
  if (!res.ok) {
    return {
      ok: false,
      file: null,
      message: `${res.message}（mcpServers 字段手动添加："${name}": ${JSON.stringify(cfg)}）`,
    };
  }
  const servers =
    res.obj.mcpServers && typeof res.obj.mcpServers === 'object' && !Array.isArray(res.obj.mcpServers)
      ? (res.obj.mcpServers as Record<string, unknown>)
      : {};
  servers[name] = cfg;
  res.obj.mcpServers = servers;
  try {
    writeFileSync(res.file, `${JSON.stringify(res.obj, null, 2)}\n`);
  } catch (err) {
    return {
      ok: false,
      file: null,
      message: `写入配置失败：${(err as Error)?.message ?? err}（可手动在配置文件 mcpServers 字段添加）`,
    };
  }
  return { ok: true, file: res.file, message: `已保存 MCP 服务器「${name}」→ ${res.file}（下次会话自动加载）` };
}

/**
 * 从配置文件的 mcpServers 字段移除一个服务器（/mcp remove 持久化）。
 * 运行时已断开连接并移除工具，这里只落盘供下次会话不加载。
 */
export function removeMcpServerFromConfig(name: string, omniCfg: OmniConfig): PersistModelResult {
  const res = loadConfigObject(omniCfg);
  if (!res.ok) {
    return {
      ok: false,
      file: null,
      message: `${res.message}（请手动在配置文件 mcpServers 字段删除「${name}」条目）`,
    };
  }
  const servers = res.obj.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers) || !(name in (servers as Record<string, unknown>))) {
    return { ok: false, file: null, message: `配置里没有 MCP 服务器「${name}」` };
  }
  const next = { ...(servers as Record<string, unknown>) };
  delete next[name];
  if (Object.keys(next).length > 0) res.obj.mcpServers = next;
  else delete res.obj.mcpServers;
  try {
    writeFileSync(res.file, `${JSON.stringify(res.obj, null, 2)}\n`);
  } catch (err) {
    return {
      ok: false,
      file: null,
      message: `写入配置失败：${(err as Error)?.message ?? err}（可手动在配置文件 mcpServers 字段删除「${name}」）`,
    };
  }
  return { ok: true, file: res.file, message: `已从配置移除 MCP 服务器「${name}」→ ${res.file}` };
}

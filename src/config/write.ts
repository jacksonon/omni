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
 * 把模型端点写入配置文件的 models 字段（/model add 持久化）。
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
      message: `${res.message}（models 字段手动添加："${name}": { "baseURL": "...", "apiKey": "..." }）`,
    };
  }
  const cfgObj = res.obj;
  const models =
    cfgObj.models && typeof cfgObj.models === 'object' && !Array.isArray(cfgObj.models)
      ? (cfgObj.models as Record<string, unknown>)
      : {};
  models[name] = {
    ...(endpoint.baseURL ? { baseURL: endpoint.baseURL } : {}),
    ...(endpoint.apiKey ? { apiKey: endpoint.apiKey } : {}),
    ...(endpoint.userAgent ? { userAgent: endpoint.userAgent } : {}),
  };
  cfgObj.models = models;
  try {
    writeFileSync(res.file, `${JSON.stringify(cfgObj, null, 2)}\n`);
  } catch (err) {
    return {
      ok: false,
      file: null,
      message: `写入配置失败：${(err as Error)?.message ?? err}（可手动在配置文件 models 字段添加）`,
    };
  }
  return { ok: true, file: res.file, message: `已写入 ${res.file}（下次会话自动加载；可再 /model <名称> 切换）` };
}

/**
 * 把状态行段顺序写入配置文件的 statusline 字段（/settings statusline Enter 保存持久化）。
 * 应用已即时生效（state.statusline 更新），这里只落盘供下次会话加载。
 */
export function persistStatuslineToConfig(order: string[], cfg: OmniConfig): PersistModelResult {
  const res = loadConfigObject(cfg);
  if (!res.ok) {
    return { ok: false, file: null, message: `${res.message}（statusline 字段手动添加：${JSON.stringify(order)}）` };
  }
  res.obj.statusline = order;
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
export function persistLanguageToConfig(lang: string, cfg: OmniConfig): PersistModelResult {
  const res = loadConfigObject(cfg);
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
 * 把思考级别写入配置文件（/variants 面板确认持久化）。
 * 现在思考级别是 **per-model**（第一百四十次后）：当前模型在配置文件 models 表里有
 * 专属条目 → 写入 models.<模型名>.reasoningEffort（该模型专属，切换回其他模型不影响）；
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
      message: `${res.message}（reasoningEffort 字段手动添加${modelName ? `：models."${modelName}".reasoningEffort` : ''} = "${effort}"）`,
    };
  }
  const cfgObj = res.obj;
  const models =
    cfgObj.models && typeof cfgObj.models === 'object' && !Array.isArray(cfgObj.models)
      ? (cfgObj.models as Record<string, unknown>)
      : null;
  const modelEntry = modelName ? models?.[modelName] : undefined;
  if (modelName && modelEntry && typeof modelEntry === 'object') {
    // per-model：当前模型在 models 表有专属条目（自定义端点模型）→ 写模型专属级别
    (modelEntry as Record<string, unknown>).reasoningEffort = effort;
  } else {
    // 全局默认：models 表没有该模型条目（或未指定模型）→ 顶层 reasoningEffort
    cfgObj.reasoningEffort = effort;
  }
  try {
    writeFileSync(res.file, `${JSON.stringify(cfgObj, null, 2)}\n`);
  } catch (err) {
    return {
      ok: false,
      file: null,
      message: `写入配置失败：${(err as Error)?.message ?? err}（reasoningEffort 字段手动添加${modelName ? `：models."${modelName}".reasoningEffort` : ''} = "${effort}"）`,
    };
  }
  return {
    ok: true,
    file: res.file,
    message: `已保存思考级别 → ${res.file}（重启后同样生效${modelName && modelEntry && typeof modelEntry === 'object' ? `；仅对模型 ${modelName} 生效` : '；全局默认'}）`,
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
 * 把 Web/Electron 工作目录写入**全局配置**的 webWorkspace 字段（界面切换时调用）。
 * 运行时已即时生效（chdir + 重建运行时），这里只落盘供下次启动应用。
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
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
  } catch (err) {
    return { ok: false, file: null, message: `写入配置失败：${(err as Error)?.message ?? err}（可手动添加 "webWorkspace": "${dir}"）` };
  }
  return { ok: true, file, message: `已保存工作目录 → ${file}（下次启动自动应用）` };
}

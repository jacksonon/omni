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

/**
 * 把命名 variant 选择写入配置文件（1.0 P0-3，/variants <id> 切换命名叠加层后持久化）：
 * 写 models."<模型>".variant（仅该模型生效）；variantId = null 表示清除（回到基础级别）。
 * 命名 variant 是 per-model 概念——没有 models 条目时报错提示先在配置里定义 variants。
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
      message: `${res.message}（variant 字段手动添加${modelName ? `：models."${modelName}".variant` : ''}${variantId ? ` = "${variantId}"` : '（删除该字段）'}）`,
    };
  }
  const cfgObj = res.obj;
  const models =
    cfgObj.models && typeof cfgObj.models === 'object' && !Array.isArray(cfgObj.models)
      ? (cfgObj.models as Record<string, unknown>)
      : null;
  const modelEntry = modelName ? models?.[modelName] : undefined;
  if (!modelName || !modelEntry || typeof modelEntry !== 'object') {
    return {
      ok: false,
      file: res.file,
      message: `命名 variant 仅支持配置文件 models 表里的模型（当前模型 ${modelName ?? ''} 无条目）——请先在 models."${modelName ?? ''}".variants 定义。`,
    };
  }
  if (variantId) (modelEntry as Record<string, unknown>).variant = variantId;
  else delete (modelEntry as Record<string, unknown>).variant;
  try {
    writeFileSync(res.file, `${JSON.stringify(cfgObj, null, 2)}\n`);
  } catch (err) {
    return { ok: false, file: null, message: `写入配置失败：${(err as Error)?.message ?? err}` };
  }
  return {
    ok: true,
    file: res.file,
    message: `已保存命名变体 → ${res.file}（仅对模型 ${modelName} 生效${variantId ? '' : '，已清除'}）`,
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

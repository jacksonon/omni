/**
 * 插件系统（2026-09 PLG）：把 skills / subagents / hooks / MCP servers 打成一个
 * 可安装包（`plugin.json` 清单），放在 `~/.config/omni/plugins/<name>/` 下按需启用。
 *
 * 对标 Claude Code plugins / Codex Agent Plugins / Copilot /plugin 的生命周期：
 *   · install —— 本地目录复制 / git 仓库克隆到插件根，写入全局配置 `plugins` 清单；
 *   · list    —— 已安装 + 是否启用 + 内容摘要；
 *   · remove  —— 删除目录 + 从启用清单移除。
 *
 * 安全：安装只复制文件（不执行）；加载阶段 hooks/MCP 会执行命令——安装时展示清单，
 * CLI 需确认（--yes 跳过）；子代理/技能目录必须在插件根内（拒绝 `..` 逃逸）。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { HooksConfig } from '../hooks/index.js';
import type { McpServerConfig } from '../tools/mcp.js';

/** 插件清单（plugin.json） */
export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  author?: string;
  /** 技能目录（相对插件根；缺省自动探测 skills/ 与 .agents/skills） */
  skills?: string[];
  /** 子代理定义目录（相对插件根；缺省自动探测 .agents/subagents/ 与 agents/） */
  agents?: string[];
  /** 生命周期 hooks（与 config hooks 同格式；与用户配置合并，用户配置优先） */
  hooks?: HooksConfig;
  /** MCP 服务器（与 config mcpServers 同格式；同名时用户配置优先） */
  mcpServers?: Record<string, McpServerConfig>;
}

export interface LoadedPlugin {
  /** 插件目录（绝对路径） */
  dir: string;
  manifest: PluginManifest;
}

/** 插件根目录（XDG-aware）：~/.config/omni/plugins */
export function pluginsRootDir(): string {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'omni', 'plugins');
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 校验插件名（防路径穿越/特殊字符） */
export function validPluginName(name: string): boolean {
  return NAME_RE.test(name) && !name.includes('..');
}

/** 读取单个插件目录的清单（无 plugin.json / 非法返回 null） */
export function readPlugin(dir: string): LoadedPlugin | null {
  const file = path.join(dir, 'plugin.json');
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!validPluginName(name)) return null;
    const manifest: PluginManifest = {
      name,
      ...(typeof raw.version === 'string' ? { version: raw.version } : {}),
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
      ...(typeof raw.author === 'string' ? { author: raw.author } : {}),
      ...(Array.isArray(raw.skills) ? { skills: raw.skills.filter((x): x is string => typeof x === 'string') } : {}),
      ...(Array.isArray(raw.agents) ? { agents: raw.agents.filter((x): x is string => typeof x === 'string') } : {}),
      ...(raw.hooks && typeof raw.hooks === 'object' && !Array.isArray(raw.hooks) ? { hooks: raw.hooks as HooksConfig } : {}),
      ...(raw.mcpServers && typeof raw.mcpServers === 'object' && !Array.isArray(raw.mcpServers)
        ? { mcpServers: raw.mcpServers as Record<string, McpServerConfig> }
        : {}),
    };
    return { dir, manifest };
  } catch {
    return null;
  }
}

/** 已安装插件列表（扫描插件根；按目录名排序） */
export function listInstalledPlugins(): LoadedPlugin[] {
  const root = pluginsRootDir();
  if (!existsSync(root)) return [];
  const out: LoadedPlugin[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = readPlugin(path.join(root, e.name));
    if (p) out.push(p);
  }
  return out.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

/**
 * 启用的插件名（模块缓存优先；未初始化时回退读全局配置 plugins 字段——
 * 技能/子代理发现可能在 attachRuntime 之前被调用）。
 */
let enabledCache: string[] | null = null;
export function setEnabledPlugins(names: string[] | undefined): void {
  enabledCache = names ? [...names] : [];
}
export function enabledPluginNames(): string[] {
  if (enabledCache) return enabledCache;
  try {
    const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    for (const f of ['omni.json', 'omni.jsonc']) {
      const file = path.join(configHome, 'omni', f);
      if (!existsSync(file)) continue;
      // JSONC 容错：剥注释与尾逗号（轻量，不 import 配置模块避免循环依赖）
      const text = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')
        .replace(/,\s*([}\]])/g, '$1');
      const obj = JSON.parse(text) as { plugins?: unknown };
      if (Array.isArray(obj.plugins)) {
        return obj.plugins.filter((x): x is string => typeof x === 'string');
      }
      return [];
    }
  } catch {
    // 配置不可读 → 视为无插件
  }
  return [];
}

/** 已启用插件（按启用清单顺序；不存在/非法自动跳过） */
export function enabledPlugins(): LoadedPlugin[] {
  const root = pluginsRootDir();
  const out: LoadedPlugin[] = [];
  for (const name of enabledPluginNames()) {
    if (!validPluginName(name)) continue;
    const p = readPlugin(path.join(root, name));
    if (p) out.push(p);
  }
  return out;
}

/** 插件技能目录（存在才返回；相对路径必须在插件根内） */
export function pluginSkillDirs(): string[] {
  const out: string[] = [];
  for (const p of enabledPlugins()) {
    const declared = p.manifest.skills ?? [];
    const candidates = declared.length > 0 ? declared : ['skills', '.agents/skills'];
    for (const rel of candidates) {
      const abs = safeJoin(p.dir, rel);
      if (abs && existsSync(abs) && statSync(abs).isDirectory()) out.push(abs);
    }
  }
  return out;
}

/** 插件子代理定义目录 */
export function pluginAgentDirs(): string[] {
  const out: string[] = [];
  for (const p of enabledPlugins()) {
    const declared = p.manifest.agents ?? [];
    const candidates = declared.length > 0 ? declared : ['.agents/subagents', 'agents'];
    for (const rel of candidates) {
      const abs = safeJoin(p.dir, rel);
      if (abs && existsSync(abs) && statSync(abs).isDirectory()) out.push(abs);
    }
  }
  return out;
}

/** 插件 hooks 合并（按启用顺序，后面的插件覆盖同 matcher；用户配置在调用方再覆盖） */
export function pluginHooks(): HooksConfig {
  const out: HooksConfig = {};
  for (const p of enabledPlugins()) {
    for (const [event, defs] of Object.entries(p.manifest.hooks ?? {})) {
      if (!Array.isArray(defs)) continue;
      const key = event as keyof HooksConfig;
      out[key] = [...(out[key] ?? []), ...defs] as never;
    }
  }
  return out;
}

/** 插件 MCP 服务器合并（同名后者覆盖；用户配置在调用方再覆盖） */
export function pluginMcpServers(): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const p of enabledPlugins()) {
    Object.assign(out, p.manifest.mcpServers ?? {});
  }
  return out;
}

/** 相对路径安全拼接：拒绝绝对路径与 `..` 逃逸（目录必须在插件根内） */
export function safeJoin(root: string, rel: string): string | null {
  if (!rel || path.isAbsolute(rel)) return null;
  const abs = path.resolve(root, rel);
  const normalizedRoot = path.resolve(root);
  if (abs !== normalizedRoot && !abs.startsWith(normalizedRoot + path.sep)) return null;
  return abs;
}

/** 插件内容摘要（安装确认/列表展示） */
export function describePlugin(p: LoadedPlugin): string {
  const m = p.manifest;
  const parts: string[] = [];
  const skills = pluginSkillDirsFor(p).length;
  const agents = pluginAgentDirsFor(p).length;
  if (skills) parts.push(`${skills} 个技能目录`);
  if (agents) parts.push(`${agents} 个子代理目录`);
  if (m.hooks && Object.keys(m.hooks).length) parts.push(`hooks（${Object.keys(m.hooks).join('/')}）`);
  if (m.mcpServers && Object.keys(m.mcpServers).length) parts.push(`MCP（${Object.keys(m.mcpServers).join('/')}）`);
  return `${m.name}${m.version ? `@${m.version}` : ''}${m.description ? ` — ${m.description}` : ''}${parts.length ? `（${parts.join(' · ')}）` : ''}`;
}

function pluginSkillDirsFor(p: LoadedPlugin): string[] {
  const declared = p.manifest.skills ?? [];
  const candidates = declared.length > 0 ? declared : ['skills', '.agents/skills'];
  return candidates.map((r) => safeJoin(p.dir, r)).filter((x): x is string => !!x && existsSync(x));
}

function pluginAgentDirsFor(p: LoadedPlugin): string[] {
  const declared = p.manifest.agents ?? [];
  const candidates = declared.length > 0 ? declared : ['.agents/subagents', 'agents'];
  return candidates.map((r) => safeJoin(p.dir, r)).filter((x): x is string => !!x && existsSync(x));
}

export interface PluginInstallResult {
  ok: boolean;
  name?: string;
  message: string;
}

/**
 * 安装插件：
 *  · 本地目录路径 → 递归复制到插件根；
 *  · git URL（http(s)://…、git@…、以 .git 结尾）→ `git clone --depth 1`；
 *  · npm 包名 → `npm pack` 拉取后解压？暂不支持（提示用 git/本地路径）。
 * 目标已存在时默认拒绝（force 覆盖）。安装只复制文件，不执行任何命令。
 */
export function installPlugin(source: string, opts: { force?: boolean } = {}): PluginInstallResult {
  const src = source.trim();
  if (!src) return { ok: false, message: '用法：omni plugin install <本地路径|git URL> [--force]' };
  const root = pluginsRootDir();
  mkdirSync(root, { recursive: true });

  const isGit = /^(https?:\/\/|git@).+/.test(src) || src.endsWith('.git');
  let stagingDir: string | null = null;
  try {
    if (isGit) {
      stagingDir = path.join(root, `.staging-${Date.now().toString(36)}`);
      execFileSync('git', ['clone', '--depth', '1', src, stagingDir], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
    } else {
      const abs = path.resolve(src);
      if (!existsSync(abs) || !statSync(abs).isDirectory()) {
        return { ok: false, message: `本地插件目录不存在：${abs}` };
      }
      stagingDir = abs;
    }
    const loaded = readPlugin(stagingDir);
    if (!loaded) {
      if (isGit && stagingDir) rmSync(stagingDir, { recursive: true, force: true });
      return { ok: false, message: `不是有效插件：缺少合法的 plugin.json（需 name 字段，限字母/数字/._-）` };
    }
    const target = path.join(root, loaded.manifest.name);
    if (existsSync(target)) {
      if (!opts.force) {
        if (isGit && stagingDir) rmSync(stagingDir, { recursive: true, force: true });
        return { ok: false, name: loaded.manifest.name, message: `插件「${loaded.manifest.name}」已存在（--force 覆盖）` };
      }
      rmSync(target, { recursive: true, force: true });
    }
    if (isGit && stagingDir) {
      cpSync(stagingDir, target, { recursive: true });
      rmSync(stagingDir, { recursive: true, force: true });
    } else {
      cpSync(stagingDir, target, { recursive: true, filter: (s) => !s.includes(`${path.sep}.git${path.sep}`) && !s.endsWith(`${path.sep}.git`) });
    }
    return { ok: true, name: loaded.manifest.name, message: `已安装插件「${describePlugin(loaded)}」→ ${target}` };
  } catch (err) {
    if (isGit && stagingDir) rmSync(stagingDir, { recursive: true, force: true });
    return { ok: false, message: `安装失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

/** 卸载插件：删除目录（从启用清单移除由调用方负责持久化） */
export function removePlugin(name: string): PluginInstallResult {
  if (!validPluginName(name)) return { ok: false, message: `非法插件名：${name}` };
  const dir = path.join(pluginsRootDir(), name);
  if (!existsSync(dir)) return { ok: false, message: `插件未安装：${name}` };
  try {
    rmSync(dir, { recursive: true, force: true });
    return { ok: true, name, message: `已删除插件「${name}」` };
  } catch (err) {
    return { ok: false, name, message: `删除失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

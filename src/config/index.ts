/**
 * 配置加载（参考 opencode 的配置体系）。
 *
 * 分层合并，优先级从低到高：
 *   默认值 → 全局配置(~/.config/omni/omni.json) → 项目配置(omni.json/omni.jsonc，cwd 向上找)
 *   → 自定义配置(OMNI_CONFIG / --config) → 环境变量 → CLI 参数
 *
 * 配置文件支持 JSON 与 JSONC（带注释、容忍尾逗号）。
 */
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PermissionTier } from '../safety/index.js';
import type { McpServerConfig } from '../tools/mcp.js';
import { parseJsonc } from './jsonc.js';
import { findInDir, findProjectConfig } from './discover.js';

export interface OmniConfig {
  model: string;
  baseURL?: string;
  apiKey?: string;
  maxSteps: number;
  /** 自定义 User-Agent（部分网关的 WAF 会拦截 SDK 默认 UA，可配置浏览器 UA 绕过） */
  userAgent?: string;
  /** 是否在终端展示思考过程（默认 true；关闭后仍会落盘 .omni/last-thinking.md） */
  showThinking: boolean;
  /**
   * 安全护栏权限分级：full（直通，危险命令硬拦截）/ safe（危险命令询问）/ ask（全部询问）/ read（只读）。
   * 默认 safe——危险命令不再直接拦截，改为询问用户。
   */
  permission: PermissionTier;
  /** 是否写审计日志（~/.config/omni/audit.log；默认 true） */
  auditLog: boolean;
  /** 是否加载项目记忆 AGENTS.md（跨会话共享；默认 true） */
  agentsFile: boolean;
  /** 是否加载全局记忆 ~/.config/omni/AGENTS.md（跨项目共享；默认 true） */
  globalAgentsFile: boolean;
  /** 会话结束时把新表达的偏好自动追加进全局记忆（默认 true） */
  autoMemory: boolean;
  /** 长对话摘要压缩：消息数超过该值触发（0 = 关闭；默认 40） */
  summarizeAt: number;
  /** 压缩时保留最近多少条消息原文（默认 8） */
  summarizeWindow: number;
  /** 是否预载任务文本中出现的相关文件（默认 true） */
  preloadFiles: boolean;
  /** 最多预载文件数（默认 5） */
  preloadMaxFiles: number;
  /** 单文件预载字节上限（默认 30KB） */
  preloadMaxBytes: number;
  /** 是否启用子代理（delegate 工具；默认 true） */
  allowSubagents: boolean;
  /** 子代理最大循环步数（默认 10） */
  maxSubagentSteps: number;
  /** MCP 服务器（外部工具生态）：{ 名称: { command, args?, env? } } */
  mcpServers?: Record<string, McpServerConfig>;
  /** 生效的配置来源（按优先级排列，用于 banner 展示与调试） */
  sources: string[];
}

/** 来自 CLI 的覆盖项 */
export interface ConfigOverrides {
  /** --config <path> */
  configPath?: string;
  /** --model <name> */
  model?: string;
}

// 轮次上限默认 50：典型任务（探索 ~3 + 修改 ~4 + 验证 ~2 + 修复迭代 ~4）在 15 次内
// 完成，20 对复杂任务偏紧；50 只作防死循环兜底，多数任务远用不满
const DEFAULTS = {
  model: 'gpt-4o-mini',
  maxSteps: 50,
  showThinking: true,
  permission: 'safe' as PermissionTier,
  auditLog: true,
  agentsFile: true,
  globalAgentsFile: true,
  autoMemory: true,
  summarizeAt: 40,
  summarizeWindow: 8,
  preloadFiles: true,
  preloadMaxFiles: 5,
  preloadMaxBytes: 30 * 1024,
  allowSubagents: true,
  maxSubagentSteps: 10,
};

function readJson(file: string): Record<string, unknown> | null {
  try {
    const data = parseJsonc(readFileSync(file, 'utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
    return null;
  } catch (err) {
    console.error(`⚠️ 配置文件解析失败（${file}）：${err instanceof Error ? err.message : err}`);
    return null;
  }
}

function addSource(sources: string[], s: string): void {
  if (!sources.includes(s)) sources.push(s);
}

function apply(cfg: OmniConfig, data: Record<string, unknown> | null, label: string, sources: string[]): void {
  if (!data) return;
  if (typeof data.model === 'string') cfg.model = data.model;
  if (typeof data.baseURL === 'string') cfg.baseURL = data.baseURL;
  if (typeof data.apiKey === 'string') cfg.apiKey = data.apiKey;
  if (typeof data.userAgent === 'string') cfg.userAgent = data.userAgent;
  if (typeof data.maxSteps === 'number' && Number.isFinite(data.maxSteps)) {
    cfg.maxSteps = Math.max(1, Math.floor(data.maxSteps));
  }
  if (typeof data.showThinking === 'boolean') cfg.showThinking = data.showThinking;
  if (['full', 'safe', 'ask', 'read'].includes(String(data.permission))) {
    cfg.permission = data.permission as PermissionTier;
  }
  if (typeof data.auditLog === 'boolean') cfg.auditLog = data.auditLog;
  if (typeof data.agentsFile === 'boolean') cfg.agentsFile = data.agentsFile;
  if (typeof data.globalAgentsFile === 'boolean') cfg.globalAgentsFile = data.globalAgentsFile;
  if (typeof data.autoMemory === 'boolean') cfg.autoMemory = data.autoMemory;
  if (typeof data.summarizeAt === 'number' && Number.isFinite(data.summarizeAt)) {
    cfg.summarizeAt = Math.max(0, Math.floor(data.summarizeAt));
  }
  if (typeof data.summarizeWindow === 'number' && Number.isFinite(data.summarizeWindow)) {
    cfg.summarizeWindow = Math.max(2, Math.floor(data.summarizeWindow));
  }
  if (typeof data.preloadFiles === 'boolean') cfg.preloadFiles = data.preloadFiles;
  if (typeof data.preloadMaxFiles === 'number' && Number.isFinite(data.preloadMaxFiles)) {
    cfg.preloadMaxFiles = Math.max(0, Math.floor(data.preloadMaxFiles));
  }
  if (typeof data.preloadMaxBytes === 'number' && Number.isFinite(data.preloadMaxBytes)) {
    cfg.preloadMaxBytes = Math.max(1024, Math.floor(data.preloadMaxBytes));
  }
  if (typeof data.allowSubagents === 'boolean') cfg.allowSubagents = data.allowSubagents;
  if (typeof data.maxSubagentSteps === 'number' && Number.isFinite(data.maxSubagentSteps)) {
    cfg.maxSubagentSteps = Math.max(1, Math.floor(data.maxSubagentSteps));
  }
  if (data.mcpServers && typeof data.mcpServers === 'object' && !Array.isArray(data.mcpServers)) {
    const servers: Record<string, McpServerConfig> = {};
    for (const [name, v] of Object.entries(data.mcpServers as Record<string, unknown>)) {
      if (v && typeof v === 'object' && typeof (v as McpServerConfig).command === 'string') {
        servers[name] = {
          command: (v as McpServerConfig).command,
          args: Array.isArray((v as McpServerConfig).args) ? (v as McpServerConfig).args : undefined,
          env: (v as McpServerConfig).env && typeof (v as McpServerConfig).env === 'object'
            ? (v as McpServerConfig).env
            : undefined,
        };
      }
    }
    if (Object.keys(servers).length > 0) cfg.mcpServers = servers;
  }
  addSource(sources, label);
}

/** 加载并合并全部配置层，返回最终配置 */
export function loadConfig(overrides: ConfigOverrides = {}): OmniConfig {
  const cfg: OmniConfig = { ...DEFAULTS, sources: [] };
  const sources = cfg.sources;

  // 1) 全局配置：$XDG_CONFIG_HOME/omni/ 或 ~/.config/omni/
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const globalFile = findInDir(path.join(configHome, 'omni'));
  if (globalFile) apply(cfg, readJson(globalFile), globalFile, sources);

  // 2) 项目配置：cwd 向上找
  const projectFile = findProjectConfig(process.cwd());
  if (projectFile) apply(cfg, readJson(projectFile), projectFile, sources);

  // 3) 自定义配置：--config 优先于 OMNI_CONFIG
  const customFile = overrides.configPath || process.env.OMNI_CONFIG;
  if (customFile) {
    const p = path.resolve(customFile);
    if (existsSync(p)) {
      apply(cfg, readJson(p), p, sources);
    } else {
      console.error(`⚠️ 自定义配置文件不存在：${p}`);
    }
  }

  // 4) 环境变量
  if (process.env.OMNI_API_KEY) {
    cfg.apiKey = process.env.OMNI_API_KEY;
    addSource(sources, '环境变量 OMNI_API_KEY');
  }
  if (process.env.OMNI_BASE_URL) {
    cfg.baseURL = process.env.OMNI_BASE_URL;
    addSource(sources, '环境变量 OMNI_BASE_URL');
  }
  if (process.env.OMNI_MODEL) {
    cfg.model = process.env.OMNI_MODEL;
    addSource(sources, '环境变量 OMNI_MODEL');
  }
  if (process.env.OMNI_MAX_STEPS) {
    const n = Number(process.env.OMNI_MAX_STEPS);
    if (Number.isFinite(n) && n >= 1) cfg.maxSteps = Math.floor(n);
    addSource(sources, '环境变量 OMNI_MAX_STEPS');
  }
  if (process.env.OMNI_SHOW_THINKING) {
    cfg.showThinking = !['0', 'false', 'no', 'off'].includes(process.env.OMNI_SHOW_THINKING.toLowerCase());
    addSource(sources, '环境变量 OMNI_SHOW_THINKING');
  }
  if (process.env.OMNI_PERMISSION) {
    const p = process.env.OMNI_PERMISSION.toLowerCase();
    if (['full', 'safe', 'ask', 'read'].includes(p)) {
      cfg.permission = p as PermissionTier;
      addSource(sources, '环境变量 OMNI_PERMISSION');
    }
  }

  // 5) CLI 参数
  if (overrides.model) {
    cfg.model = overrides.model;
    addSource(sources, 'CLI --model');
  }

  // 兼容：未设置 OMNI_API_KEY 时读 OPENAI_API_KEY
  if (!cfg.apiKey && process.env.OPENAI_API_KEY) {
    cfg.apiKey = process.env.OPENAI_API_KEY;
    addSource(sources, '环境变量 OPENAI_API_KEY');
  }

  return cfg;
}

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

const DEFAULTS = { model: 'gpt-4o-mini', maxSteps: 20, showThinking: true };

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

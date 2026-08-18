/**
 * 子代理定义（Subagent Definitions）：`.agents/subagents/*.md`（对标 Claude Code 的
 * `~/.claude/agents/*.md` JSON 方案）——用 YAML frontmatter 声明「命名子代理」的
 * 配置实体，模型在 delegate 工具里按 `agent` 参数选用。
 *
 * 格式：
 *   ```md
 *   ---
 *   name: code-reviewer
 *   description: 审查代码改动（只读，不修改）
 *   model: gpt-5            # 可选：per-agent 模型（缺省 = 主代理当前模型）
 *   permission: read        # 可选：read/safe/ask/full（缺省 = 主代理当前权限档位）
 *   tools: read_file,search_code,list_directory   # 可选：工具白名单（缺省 = 全部）
 *   skills: git-release     # 可选：预载技能名（加载 SKILL.md 全文注入子代理提示词）
 *   maxSteps: 15            # 可选：步数上限（缺省 = 主代理 maxSubagentSteps）
 *   ---
 *   （正文 = 子代理的角色说明 / 工作准则，与系统提示拼接）
 *   ```
 *
 * 发现规则（与技能/记忆一致）：从 cwd 向上（git 根 / home 为边界）扫
 * `.agents/subagents/`、`.opencode/agents/`、`.claude/agents/`，再补全局
 * `~/.config/omni/subagents/`、`~/.claude/agents/`（项目同名优先）。
 * name 须与文件名（去 .md）一致；缺 description 的目录跳过。
 */
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PermissionTier } from '../safety/index.js';

/** 子代理定义（.agents/subagents/*.md 解析结果） */
export interface SubagentDef {
  /** 子代理名（frontmatter name，须与文件名一致；delegate 的 agent 参数用它） */
  name: string;
  /** 一句话描述（模型选用子代理的依据；delegate 工具描述里列出） */
  description: string;
  /** 可选：per-agent 模型（缺省 = 主代理当前模型） */
  model?: string;
  /** 可选：per-agent 权限档位（缺省 = 主代理当前档位） */
  permission?: PermissionTier;
  /** 可选：工具白名单（缺省 = 全部可用工具） */
  tools?: string[];
  /** 可选：预载技能名列表（SKILL.md 全文注入子代理提示词） */
  skills?: string[];
  /** 可选：步数上限（缺省 = 主代理 maxSubagentSteps） */
  maxSteps?: number;
  /** 正文指令（与系统提示拼接，定义子代理的行为准则） */
  instructions: string;
  /** 定义文件绝对路径 */
  path: string;
}

/** 合法权限档位 */
const TIERS: PermissionTier[] = ['read', 'safe', 'ask', 'full'];

/** 解析 YAML frontmatter（`---` 包裹的 `key: value` 行；name/description 必填，其余可选） */
export function parseSubagentFrontmatter(
  content: string
): {
  name?: string;
  description?: string;
  model?: string;
  permission?: PermissionTier;
  tools?: string[];
  skills?: string[];
  maxSteps?: number;
} {
  if (!content.startsWith('---')) return {};
  const end = content.indexOf('\n---', 3);
  if (end < 0) return {};
  const fm = content.slice(3, end);
  const fields: Record<string, string> = {};
  for (const line of fm.split('\n')) {
    const m = line.match(/^\s*([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (m) fields[m[1].toLowerCase()] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  const list = (v?: string): string[] | undefined => {
    if (!v) return undefined;
    const arr = v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return arr.length > 0 ? arr : undefined;
  };
  const steps = fields.maxsteps ? Number(fields.maxsteps) : undefined;
  return {
    name: fields.name,
    description: fields.description,
    model: fields.model,
    permission: TIERS.includes(fields.permission as PermissionTier)
      ? (fields.permission as PermissionTier)
      : undefined,
    tools: list(fields.tools),
    skills: list(fields.skills),
    maxSteps: steps && Number.isFinite(steps) && steps >= 1 ? Math.floor(steps) : undefined,
  };
}

/** 读取一个子代理定义文件 → SubagentDef（frontmatter 不合法则返回 null） */
async function readSubagentDef(file: string, nameFromFile: string): Promise<SubagentDef | null> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  const fm = parseSubagentFrontmatter(raw);
  const name = fm.name ?? nameFromFile;
  // name 与文件名一致（frontmatter 缺省回退文件名）；缺 description 跳过
  if (!name || name !== nameFromFile || !fm.description) return null;
  // 正文 = frontmatter 之后的全部内容
  const bodyStart = raw.startsWith('---') ? raw.indexOf('\n---', 3) + 4 : 0;
  const instructions = raw.slice(bodyStart).trim();
  return {
    name,
    description: fm.description,
    model: fm.model,
    permission: fm.permission,
    tools: fm.tools,
    skills: fm.skills,
    maxSteps: fm.maxSteps,
    instructions,
    path: file,
  };
}

/** 收集一个目录下的子代理定义（同名已存在则跳过——项目优先） */
async function collectFrom(base: string, byName: Map<string, SubagentDef>): Promise<void> {
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return; // 目录不存在 / 不可读 → 静默跳过
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const nameFromFile = e.name.slice(0, -3);
    if (byName.has(nameFromFile)) continue;
    const def = await readSubagentDef(path.join(base, e.name), nameFromFile);
    if (def) byName.set(def.name, def);
  }
}

/** 全局配置目录（尊重 XDG_CONFIG_HOME，与全局记忆/配置同源） */
export function subagentConfigHome(): string {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

/** 项目级子代理目录（每层向上都检查） */
const PROJECT_AGENT_DIRS = ['.agents', '.opencode', '.claude'];

/**
 * 发现已定义子代理：从 cwd 向上（git 根 / home 为边界）扫项目级目录，
 * 再补全局目录（项目同名覆盖全局）。返回按名称去重后的定义列表。
 */
export async function discoverSubagents(cwd = process.cwd()): Promise<SubagentDef[]> {
  const byName = new Map<string, SubagentDef>();
  let dir = path.resolve(cwd);
  const home = os.homedir();
  for (;;) {
    for (const sub of PROJECT_AGENT_DIRS) {
      await collectFrom(path.join(dir, sub, 'subagents'), byName);
    }
    if (existsSync(path.join(dir, '.git'))) break; // git 根为边界，不再向上
    const parent = path.dirname(dir);
    if (parent === dir || dir === home) break;
    dir = parent;
  }
  // 全局级：用户级子代理（最后收集 → 同名不覆盖项目）
  const globals = [
    path.join(subagentConfigHome(), 'omni', 'subagents'),
    path.join(os.homedir(), '.claude', 'agents'),
  ];
  for (const g of globals) await collectFrom(g, byName);
  return [...byName.values()];
}

/** 按名查找子代理定义；未找到返回 undefined */
export function findSubagentDef(defs: SubagentDef[] | undefined, name: string): SubagentDef | undefined {
  return defs?.find((d) => d.name === name);
}

/**
 * 技能（Skill）系统：发现 SKILL.md + 按需加载 + 网络检索/安装 + frontmatter 扩展 + 渐进披露。
 *
 * opencode 的做法（https://opencode.ai/docs/skills/）：
 * · 技能 = 一个目录下的 SKILL.md（YAML frontmatter：name + description 必填）；
 * · 发现：项目 `.opencode/skills/`、`.claude/skills/`、`.agents/skills/`（从 cwd 向上到 git 根）
 *   + 全局 `~/.config/opencode/skills/`、`~/.claude/skills/`、`~/.agents/skills/`；
 * · 加载：模型通过 skill 工具按 name 读取完整 SKILL.md 内容（按需，不常驻上下文）；
 * · 生态：`npx skills find <词>` 网络检索 skills.sh、`npx skills add <owner/repo> --skill <名> -y` 安装。
 *
 * omni 扩展（第十节）：
 * · frontmatter 扩展：disable-model-invocation（仅手动）/ user-invocable / context: fork（子代理执行）
 *   / agent（指定子代理）/ background（后台运行）——对齐 agentskills.io 开放标准。
 * · 清单渐进披露：最多 15 条，超出提示"还有 N 个"。
 * · 安装即时生效：/skill add 后重新 discover + 刷新注入清单（本会话模型可见）。
 * · 安装来源标记：`/skill add --global` 安装到全局目录；列表显示来源。
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { RunOptions } from './types.js';
import type { Tool } from '../tools/types.js';

/** 技能清单 system 消息前缀（同内容重复判断 / 会话落盘过滤用） */
export const SKILL_PREFIX = '[已发现技能';

/** 单技能内容加载上限（**字节**）：超长只载头部，避免撑爆上下文 */
export const SKILL_MAX_BYTES = 40 * 1024;

/** 清单渐进披露上限（超出截断 + 提示剩余数量） */
export const SKILL_LIST_MAX = 15;

/** opencode 的技能名规则：小写字母数字 + 单连字符分隔 */
const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** 项目级技能目录（每层向上都检查） */
const PROJECT_SKILL_DIRS = ['.opencode', '.claude', '.agents'];

export interface SkillInfo {
  /** 技能名（SKILL.md frontmatter name，须与目录名一致） */
  name: string;
  /** 技能描述（frontmatter description，模型选技能的依据） */
  description: string;
  /** SKILL.md 绝对路径 */
  path: string;
  /** 是否来自全局目录（项目技能优先，同名只保留项目的一个） */
  global: boolean;
  /** 来源（安装来源，如 owner/repo@skill；缺省空） */
  source?: string;
  // ── frontmatter 扩展字段（第十节 P1）──
  /** disable-model-invocation：仅手动触发，不列入自动清单 */
  disableModelInvocation?: boolean;
  /** user-invocable：用户可手动触发（仅标记，不影响行为） */
  userInvocable?: boolean;
  /** context: fork —— 技能在子代理上下文运行，结果回传 */
  context?: 'fork';
  /** agent —— 指定子代理名（context: fork 时生效） */
  agent?: string;
  /** background —— 后台运行（context: fork 时生效） */
  background?: boolean;
}

/** 解析 SKILL.md 开头的 YAML frontmatter（全部字段，扩展字段也解析） */
export function parseSkillFrontmatter(content: string): Record<string, unknown> {
  if (!content.startsWith('---')) return {};
  const end = content.indexOf('\n---', 3);
  if (end < 0) return {};
  const fm = content.slice(3, end);
  const fields: Record<string, unknown> = {};
  for (const line of fm.split('\n')) {
    const m = line.match(/^\s*([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (m) {
      const key = m[1].toLowerCase();
      const val = m[2].trim().replace(/^["']|["']$/g, '');
      // 布尔转换
      if (val === 'true' || val === 'yes') fields[key] = true;
      else if (val === 'false' || val === 'no') fields[key] = false;
      else fields[key] = val;
    }
  }
  return fields;
}

/** 从 frontmatter 提取 SkillInfo 字段 */
function skillInfoFromFm(fm: Record<string, unknown>): {
  name?: string; description?: string;
  disableModelInvocation?: boolean; userInvocable?: boolean;
  context?: 'fork'; agent?: string; background?: boolean;
} {
  return {
    name: typeof fm.name === 'string' ? fm.name : undefined,
    description: typeof fm.description === 'string' ? fm.description : undefined,
    disableModelInvocation: fm['disable-model-invocation'] === true,
    userInvocable: fm['user-invocable'] === true,
    context: fm.context === 'fork' ? 'fork' : undefined,
    agent: typeof fm.agent === 'string' ? fm.agent : undefined,
    background: fm.background === true,
  };
}

/** 读取一个技能目录下的 SKILL.md → SkillInfo（frontmatter 不合法则返回 null） */
async function readSkillInfo(
  skillDir: string,
  dirName: string,
  global: boolean
): Promise<SkillInfo | null> {
  const md = path.join(skillDir, 'SKILL.md');
  let raw: string;
  try {
    raw = await readFile(md, 'utf8');
  } catch {
    return null;
  }
  const fm = parseSkillFrontmatter(raw);
  const { name, description, ...ext } = skillInfoFromFm(fm);
  const validName = name && SKILL_NAME_RE.test(name) && name === dirName;
  if (!validName || !description) return null;
  return { name, description, path: md, global, ...ext };
}

/** 收集一个技能目录（如 .agents/skills）下的全部技能；同名已存在（项目优先）则跳过 */
async function collectFrom(
  base: string,
  global: boolean,
  byName: Map<string, SkillInfo>
): Promise<void> {
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return; // 目录不存在 / 不可读 → 静默跳过
  }
  for (const e of entries) {
    if (!e.isDirectory() || byName.has(e.name)) continue;
    const info = await readSkillInfo(path.join(base, e.name), e.name, global);
    if (info) byName.set(info.name, info);
  }
}

/** 全局配置目录（尊重 XDG_CONFIG_HOME，与全局记忆/配置同源） */
export function skillConfigHome(): string {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

/** 全局技能安装目录（/skill add --global 写入） */
export function globalSkillDir(): string {
  return path.join(skillConfigHome(), 'omni', 'skills');
}

/**
 * 发现已安装技能：从 cwd 向上（git 根 / home 为边界）扫项目级目录，
 * 再补全局目录（项目同名覆盖全局）。返回按名称去重后的技能列表。
 */
export async function discoverSkills(cwd = process.cwd()): Promise<SkillInfo[]> {
  const byName = new Map<string, SkillInfo>();
  // 项目级：从 cwd 向上，每层检查 .opencode/.claude/.agents/skills（近的优先）
  let dir = path.resolve(cwd);
  const home = os.homedir();
  for (;;) {
    for (const sub of PROJECT_SKILL_DIRS) {
      await collectFrom(path.join(dir, sub, 'skills'), false, byName);
    }
    if (existsSync(path.join(dir, '.git'))) break; // git 根为边界，不再向上
    const parent = path.dirname(dir);
    if (parent === dir || dir === home) break;
    dir = parent;
  }
  // 全局级：用户级技能（最后收集 → 同名不覆盖项目）
  const globals = [
    path.join(skillConfigHome(), 'opencode', 'skills'),
    path.join(skillConfigHome(), 'omni', 'skills'),
    path.join(os.homedir(), '.claude', 'skills'),
    path.join(os.homedir(), '.agents', 'skills'),
  ];
  for (const g of globals) await collectFrom(g, true, byName);
  return [...byName.values()];
}

/** 按名加载技能完整内容（SKILL.md；按字节上限截断）；未找到返回 null */
export async function loadSkillContent(
  name: string,
  cwd = process.cwd()
): Promise<string | null> {
  const skills = await discoverSkills(cwd);
  const s = skills.find((x) => x.name === name);
  if (!s) return null;
  try {
    const raw = await readFile(s.path, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') <= SKILL_MAX_BYTES) return raw;
    let cut = raw.length;
    while (cut > 0 && Buffer.byteLength(raw.slice(0, cut), 'utf8') > SKILL_MAX_BYTES) cut--;
    return `${raw.slice(0, cut)}\n\n…[技能内容过长已截断；需要完整内容请用 read_file 定向读取]`;
  } catch {
    return null;
  }
}

/** 技能清单 → system 消息（只列 name+description + 渐进披露截断 + 过滤 disable-model-invocation） */
export function skillMessage(skills: SkillInfo[]): ChatCompletionMessageParam {
  const visible = skills.filter((s) => !s.disableModelInvocation);
  const total = visible.length;
  const listed = visible.slice(0, SKILL_LIST_MAX);
  const body = listed.map((s) => {
    let line = `- ${s.name}：${s.description}`;
    if (s.context === 'fork') line += '（子代理执行）';
    if (s.source) line += `［${s.source}］`;
    return line;
  }).join('\n');
  const extra = total > SKILL_LIST_MAX ? `\n\n…还有 ${total - SKILL_LIST_MAX} 个技能未列出（/skill 查看全部；模型可直接尝试调用未列出的技能名）` : '';
  return {
    role: 'system',
    content: `${SKILL_PREFIX}，需要时用 skill 工具按 name 加载完整内容]\n${body}${extra}`,
  };
}

/**
 * 刷新当前会话的技能注入清单（/skill add 安装后调用，本会话即时生效）：
 * 重新 discover 技能 → 替换/追加 skillMessage 到 messages 首部。
 * 返回新安装的技能名列表（供提示用）。
 */
export function refreshSkillInjections(
  messages: ChatCompletionMessageParam[],
  skills: SkillInfo[]
): string[] {
  const msg = skillMessage(skills);
  const prefix = SKILL_PREFIX;
  const idx = messages.findIndex(
    (m) => typeof m.content === 'string' && m.content.startsWith(prefix)
  );
  if (idx >= 0) messages[idx] = msg;
  else messages.unshift(msg);
  return skills.map((s) => s.name);
}

// ── 创建带上下文的 skill 工具（支持 context: fork 子代理执行）──

/**
 * 创建带运行时上下文的 skill 工具（attachRuntime 调用，替换静态 skillTool）：
 * 支持 frontmatter 扩展字段：
 * · context: fork —— 技能在子代理上下文运行，结果回传（delegate 工具）
 * · agent —— 指定子代理名
 * · background —— 后台运行
 * · disable-model-invocation / user-invocable —— 标记（不影响 execute 行为）
 */
export function createSkillTool(runOpts: RunOptions): Tool {
  return {
    name: 'skill',
    description:
      '加载一个已安装技能（Agent Skill）的完整 SKILL.md 指令内容。' +
      '技能清单（name + description）在系统消息的 [已发现技能] 段里；' +
      '当任务需要某项专门技能（如 git-release、react-best-practices）时按 name 加载它，' +
      '按其中给出的步骤执行。技能只读，不修改文件。' +
      '如果技能标注为「子代理执行」，工具会自动在子代理中运行。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能名（如 git-release；来自 [已发现技能] 清单）' },
      },
      required: ['name'],
    },
    async execute(args) {
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      if (!name) return '错误：缺少技能名 name';
      const skills = await discoverSkills();
      const info = skills.find((s) => s.name === name);
      if (!info) return `错误：未找到技能「${name}」。可用技能见系统消息的技能清单（/skill 命令可查看全部）。`;
      const content = await loadSkillContent(name);
      if (!content) return `错误：未找到技能「${name}」。`;

      // context: fork —— 子代理上下文执行
      if (info.context === 'fork') {
        const delegateTool = runOpts.tools?.find((t) => t.name === 'delegate');
        if (!delegateTool) {
          // 无 delegate 工具（子代理关闭）→ 降级返回内容让模型自行执行
          return `[技能 ${name} 配置为子代理执行，但当前环境无子代理能力，降级为直接返回内容]\n\n${content}`;
        }
        const task = `请执行技能「${name}」，严格遵循以下指令：\n\n${content}`;
        const agent = info.agent ?? 'general';
        return delegateTool.execute({ task, agent, ...(info.background ? { background: true } : {}) });
      }

      // 普通模式：返回内容让模型自行执行
      return content;
    },
  };
}

// ── npx skills CLI ──────────────────────────────────────────

/** 剥离 ANSI 颜色码（npx 输出可能带色） */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

/**
 * 运行 npx skills 子命令（网络检索/安装），捕获输出（不继承 stdio——
 * TUI 全屏模式下子进程输出会污染渲染）。spawn 用参数数组传递，无 shell 注入风险。
 */
export async function runSkillsCli(
  args: string[],
  timeoutMs = 120_000
): Promise<{ ok: boolean; output: string }> {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  return new Promise((resolve) => {
    const child = spawn(npx, ['-y', 'skills', ...args], { timeout: timeoutMs, windowsHide: true });
    let out = '';
    const onData = (c: Buffer): void => {
      out += c.toString();
      if (out.length > 2 * 1024 * 1024) out = out.slice(0, 2 * 1024 * 1024); // 截断防撑爆
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err) => resolve({ ok: false, output: stripAnsi(String(err.message ?? err)) }));
    child.on('close', (code) => resolve({ ok: code === 0, output: stripAnsi(out.trim()) }));
  });
}

/**
 * 解析 `npx skills find <query>` 输出中的结果行（`owner/repo@skill 安装数`）。
 * 过滤噪音（npx 下载提示 / "Install with…" 提示行 / tip）。
 */
export function parseSkillFindResults(output: string): string[] {
  return output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[\w.-]+\/[\w.-]+@[\w.-]+/.test(l));
}
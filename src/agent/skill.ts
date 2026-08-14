/**
 * 技能（Skill）系统：发现 SKILL.md + 按需加载 + 网络检索/安装（对标 opencode 的 skills 实现）。
 *
 * opencode 的做法（https://opencode.ai/docs/skills/）：
 * · 技能 = 一个目录下的 SKILL.md（YAML frontmatter：name + description 必填，其余字段忽略）；
 * · 发现：项目 `.opencode/skills/`、`.claude/skills/`、`.agents/skills/`（从 cwd 向上到 git 根）
 *   + 全局 `~/.config/opencode/skills/`、`~/.claude/skills/`、`~/.agents/skills/`；
 * · 加载：模型通过 skill 工具按 name 读取完整 SKILL.md 内容（按需，不常驻上下文）；
 * · 生态：`npx skills find <词>` 网络检索 skills.sh、`npx skills add <owner/repo> --skill <名> -y` 安装。
 *
 * omni 的对应实现：
 * · 发现：同样扫 `.opencode/skills/`、`.claude/skills/`、`.agents/skills/`（+ 全局
 *   `~/.config/opencode/skills/`、`~/.config/omni/skills/`、`~/.claude/skills/`、`~/.agents/skills/`），
 *   解析 frontmatter 的 name/description；名字不符合 opencode 规则（`^[a-z0-9]+(-[a-z0-9]+)*$`
 *   且与目录名一致）或缺 description 的目录跳过；
 * · 加载：skill 工具按名返回 SKILL.md 内容（系统消息只列出 name+description 清单，不常驻全文）；
 * · 注入：prepareContext 首轮把已发现技能清单作为 system 消息注入（config `skills` 开关）；
 * · 命令：/skill 列出 · /skill find <词> 网络检索 · /skill add <repo> [--skill <名>] 安装。
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

/** 技能清单 system 消息前缀（同内容重复判断 / 会话落盘过滤用） */
export const SKILL_PREFIX = '[已发现技能';

/** 单技能内容加载上限（**字节**）：超长只载头部，避免撑爆上下文 */
export const SKILL_MAX_BYTES = 40 * 1024;

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
}

/** 解析 SKILL.md 开头的 YAML frontmatter（只认 name/description，其余字段忽略） */
export function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  if (!content.startsWith('---')) return {};
  const end = content.indexOf('\n---', 3);
  if (end < 0) return {};
  const fm = content.slice(3, end);
  const fields: Record<string, string> = {};
  for (const line of fm.split('\n')) {
    const m = line.match(/^\s*([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (m) fields[m[1].toLowerCase()] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return { name: fields.name, description: fields.description };
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
  const { name, description } = parseSkillFrontmatter(raw);
  const validName = name && SKILL_NAME_RE.test(name) && name === dirName;
  if (!validName || !description) return null;
  return { name, description, path: md, global };
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

/** 技能清单 → system 消息（只列 name+description，模型需要时用 skill 工具加载全文） */
export function skillMessage(skills: SkillInfo[]): ChatCompletionMessageParam {
  const body = skills.map((s) => `- ${s.name}：${s.description}`).join('\n');
  return {
    role: 'system',
    content: `${SKILL_PREFIX}，需要时用 skill 工具按 name 加载完整内容]\n${body}`,
  };
}

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

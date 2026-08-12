/**
 * /init：扫描项目结构 → 让 LLM 生成 AGENTS.md（记忆文件）。
 *
 * 两条路径：
 *   · **项目级**（/init）：定位项目根（git 根，无则 cwd）→ 收集结构快照（顶层列表
 *     + 关键清单文件内容，带字节上限）→ LLM 撰写 AGENTS.md → 写入项目根；
 *   · **全局级**（/init --global）：扫描全局配置目录与运行环境 → LLM 撰写用户
 *     跨项目偏好（回复语言/代码风格/常用工具/工作方式）→ 写入 ~/.config/omni/AGENTS.md。
 *
 * 安全：已存在目标文件时**不覆盖**（提示先删除/重命名），防止误毁手写记忆。
 * 失败静默返回 null（不打扰对话），由命令层提示用户。
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type OpenAI from 'openai';
import { AGENTS_FILE, globalMemoryDir, globalMemoryPath } from './memory.js';

/** /init 系统提示：mock server 用 messages[0] 前缀识别该请求（见 scripts/mock-server.mjs） */
export const INIT_SYSTEM_PROMPT =
  '你是项目文档工程师。根据下面的项目结构快照，为该项目撰写一份 AGENTS.md——' +
  '给 AI 编程 Agent 看的项目指南（也是项目跨会话共享的记忆文件）。内容应包括（按需取舍）：' +
  '项目是什么与技术栈、常用命令（构建/测试/运行）、目录结构与架构要点、' +
  '对 AI Agent 的协作规范（如：改代码前先读相关文件、遵守现有风格）。' +
  '要求：Markdown 格式、中文撰写、简洁实用，不要编造不存在的命令或文件。' +
  '直接输出 AGENTS.md 的完整内容，不要用代码块包裹。';

/** /init --global 系统提示：mock server 用 messages[0] 前缀识别该请求 */
export const INIT_GLOBAL_SYSTEM_PROMPT =
  '你是用户偏好整理员。根据下面的用户环境信息，为 omni 撰写一份**全局记忆文件**（AGENTS.md）——' +
  '记录用户跨项目的通用偏好与习惯：回复语言、代码风格偏好、常用工具与命令、工作方式、' +
  '以及希望所有项目所有会话都遵循的约定。要求：Markdown 格式、中文撰写、简洁精炼（30 行以内）、' +
  '不要编造用户未表达过的偏好（不确定的用模板占位提示用户自行填写）。' +
  '直接输出 AGENTS.md 的完整内容，不要用代码块包裹。';

/** 快照中读取的关键清单文件（存在才读，各自带上限） */
const KEY_FILES = [
  'package.json',
  'tsconfig.json',
  'README.md',
  'Cargo.toml',
  'go.mod',
  'requirements.txt',
  'pyproject.toml',
  'Makefile',
  '.gitignore',
];
const SNAPSHOT_MAX = 30 * 1024; // 快照总字节上限
const KEY_FILE_MAX = 6 * 1024; // 单清单文件字节上限

/** 项目根：最近的 git 根；无 git 时退回 cwd */
export function findProjectRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return startDir;
    dir = parent;
  }
}

/** 收集项目结构快照：顶层列表 + 关键清单文件内容（字节上限内） */
export async function collectProjectSnapshot(root: string): Promise<string> {
  const lines: string[] = [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const top = entries
    .filter((e) => !e.name.startsWith('.'))
    .slice(0, 60)
    .map((e) => `${e.isDirectory() ? '[dir]' : '[file]'} ${e.name}`)
    .join('\n');
  lines.push(`项目根：${root}\n\n## 顶层内容\n${top}`);
  let used = lines.join('\n').length;
  for (const f of KEY_FILES) {
    if (used >= SNAPSHOT_MAX) break;
    const p = path.join(root, f);
    try {
      const st = await stat(p);
      if (!st.isFile() || st.size > KEY_FILE_MAX) continue;
      const content = await readFile(p, 'utf8');
      const budget = SNAPSHOT_MAX - used;
      const part = content.slice(0, budget);
      lines.push(`\n## ${f}\n\`\`\`\n${part}\n\`\`\``);
      used += part.length;
    } catch {
      // 不存在/不可读 → 跳过
    }
  }
  return lines.join('\n').slice(0, SNAPSHOT_MAX);
}

/** 清洗模型输出：去 ``` 代码块包裹与首尾空白 */
export function cleanInitContent(raw: string): string {
  let t = raw.trim();
  const fence = /^```[a-z]*\s*\n([\s\S]*?)\n```\s*$/i;
  const m = t.match(fence);
  if (m) t = m[1].trim();
  return t;
}

/** 生成 AGENTS.md 内容；任何失败返回 null（不打扰对话） */
export async function generateAgentsFile(
  client: OpenAI,
  model: string,
  root: string
): Promise<string | null> {
  const snapshot = await collectProjectSnapshot(root);
  try {
    // 流式请求（与主循环一致，兼容 mock server 与各家网关）；收集 content 增量
    const stream = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: INIT_SYSTEM_PROMPT },
        { role: 'user', content: snapshot },
      ],
      max_tokens: 2000,
      stream: true,
    });
    let text = '';
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta?.content ?? '';
    }
    const content = cleanInitContent(text);
    return content || null;
  } catch {
    return null;
  }
}

/** 写入 AGENTS.md；已存在不覆盖（返回 ok=false 与目标路径，由命令层提示） */
export async function writeAgentsFile(
  root: string,
  content: string
): Promise<{ ok: boolean; path: string }> {
  const target = path.join(root, AGENTS_FILE);
  if (existsSync(target)) return { ok: false, path: target };
  await writeFile(target, content, 'utf8');
  return { ok: true, path: target };
}

/** 全局环境快照：全局配置目录内容 + 配置/环境信息（供 /init --global 参考） */
export async function collectGlobalSnapshot(): Promise<string> {
  const dir = globalMemoryDir();
  const lines: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const names = entries
    .filter((e) => !e.name.startsWith('.'))
    .map((e) => `${e.isDirectory() ? '[dir]' : '[file]'} ${e.name}`)
    .slice(0, 40);
  lines.push(`全局配置目录：${dir}\n\n目录内容：\n${names.join('\n') || '（空）'}`);
  // 现有全局配置（omni.json/omni.jsonc）内容：生成偏好时可参考用户已设置的模型/权限等
  for (const f of ['omni.json', 'omni.jsonc']) {
    try {
      const p = path.join(dir, f);
      const st = await stat(p);
      if (!st.isFile() || st.size > 6 * 1024) continue;
      const content = await readFile(p, 'utf8');
      lines.push(`\n## ${f}\n\`\`\`\n${content.slice(0, 4000)}\n\`\`\``);
    } catch {
      // 不存在/不可读 → 跳过
    }
  }
  lines.push(`\n## 运行环境\nOS: ${os.platform()} ${os.arch()} · 主目录: ${os.homedir()}`);
  return lines.join('\n').slice(0, 12 * 1024);
}

/** 生成全局记忆内容；任何失败返回 null */
export async function generateGlobalAgentsFile(
  client: OpenAI,
  model: string
): Promise<string | null> {
  const snapshot = await collectGlobalSnapshot();
  try {
    const stream = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: INIT_GLOBAL_SYSTEM_PROMPT },
        { role: 'user', content: snapshot },
      ],
      max_tokens: 1500,
      stream: true,
    });
    let text = '';
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta?.content ?? '';
    }
    const content = cleanInitContent(text);
    return content || null;
  } catch {
    return null;
  }
}

/** 写入全局记忆；已存在不覆盖（自动创建目录） */
export async function writeGlobalAgentsFile(
  content: string
): Promise<{ ok: boolean; path: string }> {
  const target = globalMemoryPath();
  if (existsSync(target)) return { ok: false, path: target };
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
  return { ok: true, path: target };
}

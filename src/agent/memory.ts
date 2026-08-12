/**
 * 记忆系统：全局记忆（用户级）+ 项目记忆（AGENTS.md）两层，跨会话共享。
 *
 * 分层（与配置体系一致：全局在前、项目在后，越靠后对 LLM 权重越高 → 项目可覆盖/细化全局）：
 *   1. **全局记忆** `~/.config/omni/AGENTS.md`（尊重 XDG_CONFIG_HOME，与全局配置同目录）：
 *      你的跨项目习惯——回复语言、代码风格偏好、常用工具与命令、工作方式。
 *      所有项目所有会话都加载；交互模式 `/init --global` 主动生成；
 *      会话结束时把新表达的偏好自动追加（autoMemory）。
 *   2. **项目记忆** `<项目根>/AGENTS.md`：这个项目的约定——目录结构、架构、协作规范。
 *      从 cwd 向上找最近的（git 根与 home 为边界）；`/init` 生成。
 *
 * 加载顺序（prepareContext 注入）：SYSTEM_PROMPT → 全局记忆 → 项目记忆 → 预载文件 → 用户消息。
 * 上限：每层 40KB 字节截断（CJK 每字 3 字节，超长只载头部 + 提示 read_file 定向读取）。
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

/** 记忆文件名（业界约定） */
export const AGENTS_FILE = 'AGENTS.md';

/** 项目记忆消息内容前缀（同内容重复判断 / 调试识别用） */
export const MEMORY_PREFIX = '[项目记忆 AGENTS.md';

/** 全局记忆消息内容前缀 */
export const GLOBAL_MEMORY_PREFIX = '[全局记忆 AGENTS.md';

/** 单层加载上限（**字节**，非字符——CJK 每字 3 字节）：超长记忆文件只载头部，避免撑爆上下文 */
export const MEMORY_MAX_BYTES = 40 * 1024;

/** 全局记忆文件总大小上限（字节）：自动追加会裁剪旧段落，防止无限膨胀 */
export const GLOBAL_FILE_MAX_BYTES = 60 * 1024;

/** 全局记忆目录：尊重 XDG_CONFIG_HOME（与全局配置 ~/.config/omni/omni.json 同目录） */
export function globalMemoryDir(): string {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'omni');
}

/** 全局记忆文件路径 */
export function globalMemoryPath(): string {
  return path.join(globalMemoryDir(), AGENTS_FILE);
}

/** 从 startDir 向上找最近的 AGENTS.md；git 根与 home 为边界（与配置发现一致） */
export function findAgentsFile(startDir: string): string | null {
  let dir = path.resolve(startDir);
  const home = os.homedir();
  for (;;) {
    const p = path.join(dir, AGENTS_FILE);
    if (existsSync(p)) return p;
    if (existsSync(path.join(dir, '.git'))) return null; // git 根为边界，不再向上
    const parent = path.dirname(dir);
    if (parent === dir || dir === home) return null;
    dir = parent;
  }
}

/** 读取单个记忆文件内容：按字节上限截断（不切 UTF-8 多字节字符）；不可读返回 null */
async function readMemoryFile(file: string): Promise<{ path: string; content: string } | null> {
  try {
    const st = await stat(file);
    if (!st.isFile()) return null;
    const raw = await readFile(file, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') <= MEMORY_MAX_BYTES) return { path: file, content: raw };
    let cut = raw.length;
    while (cut > 0 && Buffer.byteLength(raw.slice(0, cut), 'utf8') > MEMORY_MAX_BYTES) cut--;
    return {
      path: file,
      content: `${raw.slice(0, cut)}\n\n…[记忆文件过长已截断；需要完整内容请用 read_file 定向读取]`,
    };
  } catch {
    return null;
  }
}

/** 读取项目记忆：最近的 AGENTS.md；无文件返回 null */
export async function loadProjectMemory(
  cwd = process.cwd()
): Promise<{ path: string; content: string } | null> {
  const file = findAgentsFile(cwd);
  if (!file) return null;
  return readMemoryFile(file);
}

/** 读取全局记忆：~/.config/omni/AGENTS.md；无文件返回 null */
export async function loadGlobalMemory(): Promise<{ path: string; content: string } | null> {
  const file = globalMemoryPath();
  if (!existsSync(file)) return null;
  return readMemoryFile(file);
}

/** AGENTS.md → system 消息（注入 messages 首部；循环的 SYSTEM_PROMPT 仍放在最前） */
export function memoryMessage(mem: { path: string; content: string }): ChatCompletionMessageParam {
  return {
    role: 'system',
    content: `${MEMORY_PREFIX}：${mem.path}]\n${mem.content}`,
  };
}

/** 全局记忆 → system 消息 */
export function globalMemoryMessage(mem: { path: string; content: string }): ChatCompletionMessageParam {
  return {
    role: 'system',
    content: `${GLOBAL_MEMORY_PREFIX}：${mem.path}]\n${mem.content}`,
  };
}

// ── 会话结束自动写入（autoMemory）──────────────────────────────

/** 记忆提取系统提示：mock server 用 messages[0] 前缀识别该请求 */
export const MEMORY_EXTRACT_SYSTEM_PROMPT =
  '你是记忆整理员。从下面的对话中提取用户表达的、值得长期记住的**新偏好或习惯**（如：' +
  '回复语言、代码风格、常用工具/命令偏好、工作方式）。忽略一次性任务指令与临时请求。' +
  '如果没有新的持久偏好，只输出「无」。有则用 Markdown 列表（- 开头）逐条列出，' +
  '直接输出内容本身，不要任何前缀解释。';

/** 自动追加段落的标题标记（用于裁剪旧段落：只保留最近的段落） */
const AUTO_SECTION_MARK = '## 会话记忆（';

// ── 偏好去重 / 矛盾合并 ─────────────────────────────────────────

/**
 * 规范化条目文本（去 - 前缀 / 标点 / 折叠空白 / 小写）→ 用于哈希与近似比较。
 * 导出供测试与调用方复用。
 */
export function normalizeMemoryItem(text: string): string {
  return text
    .replace(/^[-•*]\s*/, '')
    .replace(/[，。、；：！？!?,.;:()（）『』「」"'“”‘’«»]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * 条目主题关键词：取条目在第一个分隔符（：/，/空格等）前的短语（对**原始文本**提取——
 * 分隔符必须先于标点剥离存在）。
 * 同主题不同内容 = 矛盾 → 用新条目替换旧条目（防止「回复语言：中文」vs「回复语言：English」并存）。
 */
export function topicKey(text: string): string {
  const raw = text.replace(/^[-•*]\s*/, '').trim();
  const m = raw.match(/^(.{1,24}?)[：:，,;；\s]/);
  return normalizeMemoryItem(m ? m[1] : raw).slice(0, 24);
}

/** 提取 Markdown 条目（- / • / * 开头的行）；无条目时把整段按一个条目处理 */
export function extractMemoryItems(text: string): string[] {
  const items = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[-•*]\s+\S/.test(l));
  if (items.length === 0) {
    const t = text.trim();
    return t ? [t] : [];
  }
  return items;
}

/**
 * 去重 + 矛盾合并（纯函数）：
 * · known —— 已有条目映射（规范化文本 → 原始文本）；
 * · items —— 本次会话提取到的新条目；
 * · 返回 { fresh, replaced }：fresh = 需要追加的新条目；replaced = old→new 冲突替换对。
 *
 * 规则：
 *   1. 规范化后完全相等 → 重复，跳过；
 *   2. 互相包含（较长的 ≥6 字）→ 近似重复，跳过；
 *   3. 主题关键词相同但内容不同 → 矛盾，用新条目替换旧条目（原位替换，不新增）。
 */
export function dedupMemoryItems(
  known: Map<string, string>,
  items: string[]
): { fresh: string[]; replaced: Map<string, string> } {
  const fresh: string[] = [];
  const replaced = new Map<string, string>();
  for (const item of items) {
    const norm = normalizeMemoryItem(item);
    if (!norm) continue;
    let dup = false;
    let conflictOld: string | null = null;
    const tk = topicKey(item);
    for (const [k, orig] of known) {
      if (k === norm) {
        dup = true;
        break;
      }
      // 近似重复：较短条目被较长条目包含（或反之），长度门槛避免误伤短词
      const longer = k.length > norm.length ? k : norm;
      const shorter = k.length > norm.length ? norm : k;
      if (longer.length >= 6 && longer.includes(shorter)) {
        dup = true;
        break;
      }
      // 同主题不同内容 → 矛盾（主题词取自**原始条目**，分隔符语义才成立；
      // 仅当主题词足够长，避免「- 用中文」这类短主题误替换）
      if (conflictOld === null && tk.length >= 2 && topicKey(orig) === tk && k !== norm) {
        conflictOld = orig;
      }
    }
    if (dup) continue;
    if (conflictOld) {
      replaced.set(conflictOld, item);
      // 移除旧键：同批后续条目不再与已替换的旧条目比较（避免残留旧条目参与去重判定）
      for (const [k2, o2] of known) {
        if (o2 === conflictOld) {
          known.delete(k2);
          break;
        }
      }
      known.set(norm, item); // 替换后以新为准
    } else {
      fresh.push(item);
      known.set(norm, item);
    }
  }
  return { fresh, replaced };
}

/**
 * 从最近的对话中提取用户新表达的持久偏好（轻量 LLM 调用）。
 * 返回 Markdown 条目或 null（无新偏好 / 失败，静默）。
 */
export async function extractSessionMemory(
  client: OpenAI,
  model: string,
  messages: ChatCompletionMessageParam[]
): Promise<string | null> {
  // 只取最近几轮用户/助手正文（过滤 tool 结果与空内容——工具输出是执行噪音，不喂给偏好提取）
  const recent = messages
    .slice(-10)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => {
      const c = typeof m.content === 'string' ? m.content : '';
      if (!c) return null;
      return `${m.role === 'user' ? '用户' : '助手'}：${c.slice(0, 500)}`;
    })
    .filter((s): s is string => !!s)
    .join('\n')
    .slice(0, 3000);
  if (!recent) return null;
  try {
    const stream = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: MEMORY_EXTRACT_SYSTEM_PROMPT },
        { role: 'user', content: recent },
      ],
      max_tokens: 300,
      stream: true,
    });
    let text = '';
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta?.content ?? '';
    }
    const t = text.trim();
    // 空 / 无新偏好（「无」「无。」等；不误伤「无需确认直接执行」这类真实条目）
    if (!t || /^无[。.！!]?\s*$/.test(t)) return null;
    return t;
  } catch {
    return null;
  }
}

/**
 * 把条目合并进全局记忆文件（自动创建目录/文件）：
 * · **去重**：与已有条目（手写头部 + 历史段落）规范化相同 / 近似相同 → 跳过；
 * · **矛盾合并**：同主题但内容冲突 → 原位替换旧条目（不新增、不堆积）；
 * · 全部是重复 / 已替换时返回 false（没有新内容可写）；
 * · 超限时裁剪最旧自动段落（保留手写头部与最近段落）。
 */
export async function appendGlobalMemory(entry: string): Promise<boolean> {
  try {
    const file = globalMemoryPath();
    await mkdir(path.dirname(file), { recursive: true });
    let existing = '';
    try {
      existing = await readFile(file, 'utf8');
    } catch {
      // 文件不存在 → 从空开始
    }
    // 拆分为手写头部 + 自动段落列表（段落后按日期倒序追加，最早的在前）
    const firstIdx = existing.indexOf(AUTO_SECTION_MARK);
    const header = firstIdx < 0 ? existing.trimEnd() : existing.slice(0, firstIdx).trimEnd();
    const sections: string[] = [];
    if (firstIdx >= 0) {
      const rest = existing.slice(firstIdx);
      let pos = 0;
      for (;;) {
        const next = rest.indexOf(AUTO_SECTION_MARK, pos + 1);
        if (next < 0) {
          sections.push(rest.slice(pos));
          break;
        }
        sections.push(rest.slice(pos, next));
        pos = next;
      }
    }
    // 已知条目：手写头部 + 所有历史段落里的 - 条目
    const known = new Map<string, string>();
    for (const item of extractMemoryItems([header, ...sections].join('\n'))) {
      const norm = normalizeMemoryItem(item);
      if (norm) known.set(norm, item);
    }
    const items = extractMemoryItems(entry);
    const { fresh, replaced } = dedupMemoryItems(known, items);
    if (fresh.length === 0 && replaced.size === 0) return false; // 全重复，无新内容
    // 矛盾替换：在头部/历史段落里原位替换旧条目文本
    const applyReplace = (text: string): string => {
      let t = text;
      for (const [old, neu] of replaced) {
        t = t.split(old).join(neu);
      }
      return t;
    };
    const parts: string[] = [];
    const newHeader = applyReplace(header);
    if (newHeader) parts.push(newHeader);
    parts.push(...sections.map(applyReplace).filter((s) => s.trim()));
    if (fresh.length > 0) {
      const date = new Date().toISOString().slice(0, 10);
      parts.push(`${AUTO_SECTION_MARK}${date}）\n\n${fresh.join('\n')}\n\n`);
    }
    let next = parts.join('\n\n').trimEnd() + '\n';
    // 超限：从最早段落开始裁剪（保留手写头部与最近段落）
    while (Buffer.byteLength(next, 'utf8') > GLOBAL_FILE_MAX_BYTES) {
      const idx = next.indexOf(AUTO_SECTION_MARK);
      if (idx < 0) break; // 没有段落可裁
      const end = next.indexOf(AUTO_SECTION_MARK, idx + 1);
      if (end < 0) break; // 只剩一段，保留
      next = next.slice(0, idx) + next.slice(end);
    }
    await writeFile(file, next, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 会话结束自动写入全局记忆（交互模式退出 / 单任务完成时由调用方触发）：
 * 提取新偏好 → 非空则追加。静默失败，不打扰。
 */
export async function maybeWriteGlobalMemory(
  client: OpenAI,
  model: string,
  messages: ChatCompletionMessageParam[]
): Promise<void> {
  const entry = await extractSessionMemory(client, model, messages);
  if (!entry) return;
  await appendGlobalMemory(entry);
}

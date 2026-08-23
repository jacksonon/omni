/**
 * 记忆系统：全局记忆（用户级）+ 项目记忆（AGENTS.md）两层，跨会话共享。
 *
 * 分层（与配置体系一致：全局在前、项目在后，越靠后对 LLM 权重越高 → 项目可覆盖/细化全局）：
 *   1. **全局记忆** `~/.config/omni/AGENTS.md`（尊重 XDG_CONFIG_HOME，与全局配置同目录）：
 *      你的跨项目习惯——回复语言、代码风格偏好、常用工具与命令、工作方式。
 *      所有项目所有会话都加载；交互模式 `/init --global` 主动生成；
 *      会话结束时把新表达的偏好自动追加（autoMemory）。
 *   2. **项目记忆** AGENTS.md：这个项目的约定——目录结构、架构、协作规范。
 *      **嵌套加载**：从 cwd 向上收集**所有层级**的 AGENTS.md（git 根与 home 为边界）——
 *      每个目录一层，`<项目根>/AGENTS.md`（整体约定）+ 子目录 `AGENTS.md`（局部约定）；
 *      越靠近 cwd 的层级权重越高（注入时排在更后面、贴近用户消息，可覆盖/细化外层）；
 *      同层内靠 `write_file`/`/init` 生成（已存在不覆盖）。
 *
 * 加载顺序（prepareContext 注入）：
 *   SYSTEM_PROMPT → 全局记忆 → 项目记忆（最外层 → … → 最内层） → 预载文件 → 用户消息。
 * 上限：每层 40KB 字节截断（CJK 每字 3 字节，超长只载头部 + 提示 read_file 定向读取）。
 */
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

/** 记忆文件名（业界约定） */
export const AGENTS_FILE = 'AGENTS.md';/** 覆盖层文件名：同目录内存在时**替代** AGENTS.md（Codex 方案，个人/工具链分支用） */
export const OVERRIDE_FILE = 'AGENTS.override.md';

/** fallback 文件名：目录无 AGENTS.md 时的兜底（如 TEAM_GUIDE.md） */
export const FALLBACK_FILES = ['TEAM_GUIDE.md', 'GUIDE.md'];

/** 项目记忆合计上限（**字节**）：嵌套多层级叠加时从最外层开始裁，防撑爆上下文（Codex 32KB） */
export const PROJECT_MEMORY_TOTAL_MAX_BYTES = 32 * 1024;

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

/** 单个目录内优先选择的记忆文件（override > AGENTS.md > fallback）；无则返回 null */
function memoryFileInDir(dir: string): string | null {
  const override = path.join(dir, OVERRIDE_FILE);
  if (existsSync(override)) return override;
  const agents = path.join(dir, AGENTS_FILE);
  if (existsSync(agents)) return agents;
  for (const fb of FALLBACK_FILES) {
    const p = path.join(dir, fb);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * 从 startDir 向上收集**所有层级**的记忆文件（嵌套支持）：
 * git 根与 home 为边界（与配置发现一致）——每个目录检查一次（override > AGENTS.md > fallback），
 * 收集后若该目录是 git 根（含 .git）则停止向上，否则继续到 home 边界。
 * 返回从内到外（startDir 最近 → 最远）的文件路径数组；空 = 无项目记忆。
 */
export function findAgentsFiles(startDir: string): string[] {
  const files: string[] = [];
  let dir = path.resolve(startDir);
  const home = os.homedir();
  for (;;) {
    const p = memoryFileInDir(dir);
    if (p) files.push(p);
    if (existsSync(path.join(dir, '.git'))) break; // git 根（含）为边界，不再向上
    const parent = path.dirname(dir);
    if (parent === dir || dir === home) break;
    dir = parent;
  }
  return files;
}

/** 从 startDir 向上找最近的 AGENTS.md（取嵌套发现的第一个；git 根与 home 为边界） */
export function findAgentsFile(startDir: string): string | null {
  return findAgentsFiles(startDir)[0] ?? null;
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

/**
 * 读取项目记忆：**所有层级**的记忆文件（从内到外；各层独立按字节上限截断）。
 * 加上**合计上限**：嵌套多层级叠加超 PROJECT_MEMORY_TOTAL_MAX_BYTES 时从最外层（权重最低）开始裁。
 * 返回空数组 = 无项目记忆。
 */
export async function loadProjectMemory(
  cwd = process.cwd()
): Promise<{ path: string; content: string }[]> {
  const out: { path: string; content: string }[] = [];
  for (const file of findAgentsFiles(cwd)) {
    const mem = await readMemoryFile(file);
    if (mem) out.push(mem);
  }
  // 合计上限：从外层（数组末尾）开始裁，保内层（贴近 cwd、权重高）
  let total = 0;
  for (const m of out) total += Buffer.byteLength(m.content, 'utf8');
  while (total > PROJECT_MEMORY_TOTAL_MAX_BYTES && out.length > 1) {
    const dropped = out.pop()!;
    total -= Buffer.byteLength(dropped.content, 'utf8');
  }
  return out;
}

/**
 * 读取全局记忆（1.0 P1-2 结构化）：遗留 ~/.config/omni/AGENTS.md（只读兼容）+
 * memory/MEMORY.md 索引（新写入都在结构化布局）——两段拼接注入。
 * 无任何文件返回 null。
 */
export async function loadGlobalMemory(): Promise<{ path: string; content: string } | null> {
  const parts: string[] = [];
  let label = '';
  const legacy = globalMemoryPath();
  if (existsSync(legacy)) {
    const mem = await readMemoryFile(legacy);
    if (mem) {
      parts.push(mem.content);
      label = legacy;
    }
  }
  const { memoryIndexFile, memoryTopicsDir } = await import('./memory-topics.js');
  const idxFile = memoryIndexFile();
  if (existsSync(idxFile)) {
    try {
      const raw = await readFile(idxFile, 'utf8');
      if (raw.trim()) {
        parts.push(raw);
        if (!label) label = idxFile;
      }
    } catch {
      // 读失败忽略
    }
  } else if (!label && existsSync(memoryTopicsDir())) {
    // 只有 topics 没有 index（极端）→ 以目录为标签
    label = memoryTopicsDir();
  }
  if (parts.length === 0) return null;
  return { path: label || idxFile, content: parts.join('\n\n') };
}

/** AGENTS.md → system 消息（注入 messages 首部；循环的 SYSTEM_PROMPT 仍放在最前）。
 *  嵌套多层级时每个文件各生成一条（各自带路径标注 + 独立截断），模型可 read_file 定向读取完整内容。 */
export function memoryMessage(mem: { path: string; content: string }): ChatCompletionMessageParam {
  return {
    role: 'system',
    content: `${MEMORY_PREFIX}：${mem.path}]\n${mem.content}`,
  };
}

/** 记忆工具使用提示（渐进披露）：告诉模型超长记忆可按需用 memory_search / memory_read 读取 */
export const MEMORY_TOOLS_HINT =
  '记忆系统提示：如果上述记忆/AGENTS.md 内容被截断或需要查找某个具体约定/偏好，' +
  '可用 memory_search 工具按关键词搜索全部记忆，或用 memory_read 工具按路径读取完整记忆文件。';

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
 * · **TTL**：超 MEMORY_TTL_DAYS 天（默认 90）的自动段落移入归档（保留头部与近期段落）；
 * · 全部是重复 / 已替换时返回 false（没有新内容可写）；
 * · 超限时裁剪最旧自动段落（保留手写头部与最近段落）。
 */

/** 自动记忆段落 TTL（天）：超过则移入归档段，避免长期无效偏好堆积 */
export const MEMORY_TTL_DAYS = 90;

/** 归档段落标记（TTL 过期段落移入，可手动查看） */
const ARCHIVE_MARK = '## 记忆归档（过期）';

/** 解析 `## 会话记忆（YYYY-MM-DD）` 段落日期；无法解析返回 null */
function parseSectionDate(section: string): Date | null {
  const m = section.match(/## 会话记忆（(\d{4})-(\d{2})-(\d{2})）/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * TTL 裁剪：把超期的自动段落从 sections 移到 archived（返回新 sections + archived 数组）。
 * 保留最近 MEMORY_TTL_DAYS 天内的段落；无日期标记的段落保留（未知期限不误删）。
 */
export function applyMemoryTTL(sections: string[]): { kept: string[]; expired: string[] } {
  const cutoff = Date.now() - MEMORY_TTL_DAYS * 24 * 60 * 60 * 1000;
  const kept: string[] = [];
  const expired: string[] = [];
  for (const s of sections) {
    const d = parseSectionDate(s);
    if (d && d.getTime() < cutoff) expired.push(s);
    else kept.push(s);
  }
  return { kept, expired };
}

export async function appendGlobalMemory(entry: string): Promise<boolean> {
  // 1.0 P1-2 记忆结构化升级：**新写入全部进结构化布局**（memory/MEMORY.md 索引 +
  // memory/topics/<主题>.md）；遗留 AGENTS.md 只读保留。已知条目 = 遗留文件 +
  // 现有主题条目合并计算（规范化相等 / 长包含去重——防重复学习），矛盾替换在
  // 结构化布局里退化为「追加修正条目」（旧值留在历史里可追溯）。
  try {
    const { listTopics, writeTopicEntry } = await import('./memory-topics.js');
    const known = new Map<string, string>();
    const legacyRaw = existsSync(globalMemoryPath()) ? await readFile(globalMemoryPath(), 'utf8').catch(() => '') : '';
    for (const item of extractMemoryItems(legacyRaw)) {
      const norm = normalizeMemoryItem(item);
      if (norm) known.set(norm, item);
    }
    for (const t of await listTopics()) {
      for (const line of t.content.split('\n')) {
        const l = line.replace(/^-\s*/, '').trim();
        if (!l) continue;
        const norm = normalizeMemoryItem(l);
        if (norm && !known.has(norm)) known.set(norm, l);
      }
    }
    const items = extractMemoryItems(entry);
    const { fresh, replaced } = dedupMemoryItems(known, items);
    // 结构化布局：fresh = 新条目；replaced = 同主题矛盾（旧值→新值）——新值作为修正条目追加进主题文件
    const toWrite = [...fresh, ...replaced.values()];
    if (toWrite.length === 0) return false; // 全重复，无新内容
    let wrote = false;
    for (const item of toWrite) {
      // writeTopicEntry 会自己加 `- ` 前缀，去掉条目自带的以防双短横
      const clean = item.replace(/^-\s*/, '').trim();
      const ok = await writeTopicEntry(topicKey(item), clean).catch(() => false);
      wrote = wrote || ok;
    }
    return wrote;
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

// ── 项目级会话自动写入（P0）──────────────────────────────────

/** 项目记忆提取系统提示：mock server 用 messages[0] 前缀识别（"你是项目记忆整理员"） */
export const PROJECT_MEMORY_EXTRACT_SYSTEM_PROMPT =
  '你是项目记忆整理员。从下面的对话中提取本项目的**持久事实与约定**（如：构建/测试/运行命令、' +
  '目录结构与架构决定、关键实现细节、团队协作规范）。忽略一次性任务指令与临时请求。' +
  '如果没有新的持久信息，只输出「无」。有则用 Markdown 列表（- 开头）逐条列出，' +
  '直接输出内容本身，不要任何前缀解释。';

/** 待确认的项目记忆片段文件（.omni/memory-pending.md，生成后由用户确认再应用） */
export function projectMemoryPendingPath(cwd = process.cwd()): string {
  return path.join(cwd, '.omni', 'memory-pending.md');
}

/**
 * 从最近的对话中提取本项目的持久事实/约定（轻量 LLM 调用）。
 * 返回 Markdown 条目或 null（无新信息 / 失败，静默）。
 */
export async function extractProjectMemory(
  client: OpenAI,
  model: string,
  messages: ChatCompletionMessageParam[]
): Promise<string | null> {
  const recent = messages
    .slice(-15)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => {
      const c = typeof m.content === 'string' ? m.content : '';
      if (!c) return null;
      return `${m.role === 'user' ? '用户' : '助手'}：${c.slice(0, 500)}`;
    })
    .filter((s): s is string => !!s)
    .join('\n')
    .slice(0, 4000);
  if (!recent) return null;
  try {
    const stream = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: PROJECT_MEMORY_EXTRACT_SYSTEM_PROMPT },
        { role: 'user', content: recent },
      ],
      max_tokens: 400,
      stream: true,
    });
    let text = '';
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta?.content ?? '';
    }
    const t = text.trim();
    if (!t || /^无[。.！!]?\s*$/.test(t)) return null;
    return t;
  } catch {
    return null;
  }
}

/**
 * 会话结束把本项目的持久事实生成「待提交片段」（P0）：
 * 提取项目记忆 → 写入 .omni/memory-pending.md（**不直接改项目 AGENTS.md**，
 * git 跟踪文件需用户确认；/memory-apply 应用）。静默失败。
 * 返回是否写入了片段。
 */
export async function maybeWriteProjectMemory(
  client: OpenAI,
  model: string,
  messages: ChatCompletionMessageParam[],
  cwd = process.cwd()
): Promise<boolean> {
  try {
    const entry = await extractProjectMemory(client, model, messages);
    if (!entry) return false;
    const target = projectMemoryPendingPath(cwd);
    await mkdir(path.dirname(target), { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const body =
      `## 项目记忆待提交（${date}）\n\n` +
      `> 由本次会话自动提取，未直接修改 AGENTS.md。确认后用 /memory-apply 应用（追加到项目根 AGENTS.md）。\n\n` +
      `${entry}\n`;
    // 追加（多次会话累积）
    let existing = '';
    try {
      existing = await readFile(target, 'utf8');
    } catch {
      // 不存在 → 从空开始
    }
    await writeFile(target, existing ? `${existing.trimEnd()}\n\n${body}` : body, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 应用待提交的项目记忆片段：把 .omni/memory-pending.md 内容追加到项目根 AGENTS.md，
 * 然后删除片段文件。返回 { ok, message }。
 */
export async function applyProjectMemoryPending(cwd = process.cwd()): Promise<{ ok: boolean; message: string }> {
  const pending = projectMemoryPendingPath(cwd);
  try {
    if (!existsSync(pending)) {
      return { ok: false, message: '没有待提交的项目记忆片段（.omni/memory-pending.md 不存在）' };
    }
    const raw = await readFile(pending, 'utf8');
    if (!raw.trim()) return { ok: false, message: '待提交片段为空' };
    // 定位项目根（git 根；无则 cwd）与根 AGENTS.md
    const root = path.resolve(cwd);
    const target = path.join(root, AGENTS_FILE);
    let existing = '';
    try {
      existing = await readFile(target, 'utf8');
    } catch {
      // 无 AGENTS.md → 新建
    }
    const sep = existing.trimEnd() ? '\n\n' : '';
    const content = existing.trimEnd() + sep + raw.trimEnd() + '\n';
    await writeFile(target, content, 'utf8');
    await rm(pending, { force: true });
    return { ok: true, message: `已应用项目记忆 → ${target}（片段文件已清除）` };
  } catch (err) {
    return { ok: false, message: `应用失败：${err instanceof Error ? err.message : err}` };
  }
}

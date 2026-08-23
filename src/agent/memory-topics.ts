/**
 * 记忆结构化升级（1.0 P1-2，对标 Claude Code auto memory）：
 *
 * 全局记忆从「单个 AGENTS.md 大文件」升级为 **MEMORY.md 索引 + topics/*.md 主题文件**：
 *
 *   ~/.config/omni/memory/MEMORY.md        ← 索引（常驻注入：每行一条 `- 主题：摘要 · 路径`）
 *   ~/.config/omni/memory/topics/<slug>.md ← 主题文件（frontmatter: topic/date/globs/archived + 条目正文）
 *
 * 渐进披露：索引常驻上下文，模型用 memory_search / memory_read 按需读主题全文；
 * **globs 条件注入**（Amp 方案）：主题 frontmatter 声明 `globs: "src/**"`，
 * 任务文本命中该模式时把主题内容**直接内联**进上下文（不用等模型主动查）。
 * 兼容：旧版 ~/.config/omni/AGENTS.md 继续加载（只读遗留），新写入全部进结构化布局。
 */
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile, appendFile, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/** 结构化记忆根目录 */
export function memoryTopicsRoot(): string {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'omni', 'memory');
}

/** MEMORY.md 索引路径 */
export function memoryIndexFile(): string {
  return path.join(memoryTopicsRoot(), 'MEMORY.md');
}

/** topics/ 目录 */
export function memoryTopicsDir(): string {
  return path.join(memoryTopicsRoot(), 'topics');
}

/* ---------------- glob → RegExp（轻量实现，支持 ** / * / ?） ---------------- */

export function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
        if (pattern[i + 1] === '/') i++; // `**/` 也匹配零层目录
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`(?:^|[^\\w./-])${re}(?:$|[^\\w/-])`, 'i');
}

/* ---------------- 主题文件解析 ---------------- */

export interface MemoryTopic {
  file: string;
  topic: string;
  date: string;
  globs?: string;
  archived?: boolean;
  content: string;
}

/** 解析一个主题文件的 frontmatter + 正文；损坏返回 null */
export async function parseTopicFile(file: string): Promise<MemoryTopic | null> {
  try {
    const raw = await readFile(file, 'utf8');
    const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
    if (!m) return null;
    const meta: Record<string, string> = {};
    for (const line of m[1]!.split('\n')) {
      const kv = /^(\w+):\s*(.*)$/.exec(line.trim());
      if (kv) meta[kv[1]!.toLowerCase()] = kv[2]!.trim();
    }
    return {
      file,
      topic: meta['topic'] ?? path.basename(file, '.md'),
      date: meta['date'] ?? '',
      globs: meta['globs'] || undefined,
      archived: meta['archived'] === 'true',
      content: (m[2] ?? '').trim(),
    };
  } catch {
    return null;
  }
}

/** 列出全部主题文件（按文件名排序；不存在的目录返回空） */
export async function listTopics(): Promise<MemoryTopic[]> {
  const dir = memoryTopicsDir();
  if (!existsSync(dir)) return [];
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
    const out: MemoryTopic[] = [];
    for (const f of files) {
      const t = await parseTopicFile(path.join(dir, f));
      if (t) out.push(t);
    }
    return out;
  } catch {
    return [];
  }
}

/** 标题 → 文件名 slug（非字母数字折成 -；截 48 字符） */
function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'topic'
  );
}

/**
 * 写入一条记忆到主题文件（autoMemory 新写入的唯一入口）：
 * · 按 title 定位/创建 topics/<slug>.md（同主题追加、去重——规范化后逐条比对）；
 * · 更新 MEMORY.md 索引行（`- <topic>：<首条目摘要> · topics/<file>`）；
 * · globs 可选（Amp 条件注入）；重复条目返回 false 不写盘。
 */
export async function writeTopicEntry(
  title: string,
  entry: string,
  globs?: string
): Promise<boolean> {
  await mkdir(memoryTopicsDir(), { recursive: true });
  const norm = entry.trim().toLowerCase().replace(/^-\s*/, '');
  const existing = await listTopics();
  const today = new Date().toISOString().slice(0, 10);
  // 同主题定位：slug 相同即同一文件
  const wantSlug = `${slugify(title)}.md`;
  const hit = existing.find((t) => path.basename(t.file) === wantSlug);
  if (hit) {
    // 去重：规范化相等或长包含（与全局记忆 append 同语义）
    for (const line of hit.content.split('\n')) {
      const l = line.trim().toLowerCase().replace(/^-\s*/, '');
      if (!l) continue;
      if (l === norm || (norm.length >= 6 && l.includes(norm)) || (l.length >= 6 && norm.includes(l))) {
        return false;
      }
    }
    const updated = `${hit.content.replace(/\s*$/, '')}\n- ${entry.trim()}\n`;
    await writeFile(hit.file, `---\ntopic: ${hit.topic}\ndate: ${today}${hit.globs ? `\nglobs: ${JSON.stringify(hit.globs)}` : ''}\n---\n\n${updated}`, 'utf8');
    await rebuildIndex();
    return true;
  }
  const file = path.join(memoryTopicsDir(), wantSlug);
  await writeFile(
    file,
    `---\ntopic: ${title}\ndate: ${today}${globs ? `\nglobs: ${JSON.stringify(globs)}` : ''}\n---\n\n- ${entry.trim()}\n`,
    'utf8'
  );
  await rebuildIndex();
  return true;
}

/** 重建 MEMORY.md 索引（每主题一行：未归档在前，按日期倒序） */
export async function rebuildIndex(): Promise<void> {
  const topics = await listTopics();
  const lines: string[] = ['# Omni 记忆索引', '', '> 详细条目在 topics/ 下；模型可用 memory_search / memory_read 按需读取。', ''];
  const active = topics.filter((t) => !t.archived);
  const archived = topics.filter((t) => t.archived);
  if (active.length > 0) {
    lines.push('## 主题');
    for (const t of active) {
      const first = t.content.split('\n').find((l) => l.trim())?.trim() ?? '';
      lines.push(`- ${t.topic}：${first.slice(0, 80)} · ${path.basename(t.file)}${t.globs ? `（命中 ${t.globs} 时自动加载）` : ''}`);
    }
    lines.push('');
  }
  if (archived.length > 0) {
    lines.push('## 记忆归档（过期）');
    for (const t of archived) lines.push(`- ${t.topic} · ${path.basename(t.file)}`);
    lines.push('');
  }
  await mkdir(memoryTopicsRoot(), { recursive: true });
  await writeFile(memoryIndexFile(), lines.join('\n'), 'utf8');
}

/**
 * globs 条件注入（Amp 方案）：任务文本里出现的「文件样 token」命中某主题的
 * glob 模式 → 返回该主题全文（最多 max 个、每个 ≤ maxBytes 字节）。
 */
export async function topicsMatchingTask(
  taskText: string | undefined,
  max = 3,
  maxBytes = 4 * 1024
): Promise<{ topic: string; file: string; content: string }[]> {
  if (!taskText) return [];
  const topics = (await listTopics()).filter((t) => !t.archived && t.globs);
  if (topics.length === 0) return [];
  // 任务文本切成候选 token（含路径样式的段），glob 对整串也试一次
  const tokens = [taskText, ...taskText.split(/[\s"'`(){};,]+/)].filter(Boolean);
  const out: { topic: string; file: string; content: string }[] = [];
  for (const t of topics) {
    const patterns = t.globs!.split(/[,\s]+/).filter(Boolean);
    const matched = patterns.some((p) => {
      const re = globToRegExp(p);
      return tokens.some((tok) => re.test(tok));
    });
    if (!matched) continue;
    const content = t.content.length > maxBytes ? `${t.content.slice(0, maxBytes)}\n…[已截断]` : t.content;
    out.push({ topic: t.topic, file: t.file, content });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * TTL 归档（topics 版）：date 超过 ttlDays 天的主题标记 archived=true 并重建索引。
 * 与 AGENTS.md 的 applyMemoryTTL 平行——两代布局都保持「过期不删除、仅归档」。
 */
export async function applyTopicsTTL(ttlDays = 90): Promise<number> {
  const topics = await listTopics();
  let changed = 0;
  for (const t of topics) {
    if (t.archived || !t.date) continue;
    const d = new Date(t.date);
    if (Number.isNaN(d.getTime())) continue;
    if (Date.now() - d.getTime() > ttlDays * 24 * 3600 * 1000) {
      const raw = await readFile(t.file, 'utf8');
      // 在 frontmatter 第一行后插入 archived: true（保持 meta 合法；parseTopicFile 才能读到）
      await writeFile(t.file, raw.replace(/^---\n/, '---\narchived: true\n'), 'utf8').catch(() => {});
      changed++;
    }
  }
  if (changed > 0) await rebuildIndex();
  void rename; // 预留（未来归档移目录用）
  return changed;
}

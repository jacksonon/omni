/**
 * 记忆渐进披露工具（P0，Claude Code MEMORY.md 方案）：
 * 记忆/AGENTS.md 只常驻索引（name+description 或截断摘要），
 * 模型需要详细条目时用这两个工具按需读取：
 *
 * · memory_search —— 按关键词搜索全部记忆文件（项目 + 全局），返回命中条目（路径 + 行号 + 内容摘要）
 * · memory_read   —— 按路径读取某个记忆文件的完整内容（受 MEMORY_MAX_BYTES 截断，提示 read_file 定向读取）
 */
import { readFile, stat } from 'node:fs/promises';
import type { Tool } from './types.js';
import { findAgentsFiles, globalMemoryPath, MEMORY_MAX_BYTES } from '../agent/memory.js';
import { existsSync } from 'node:fs';

/** 读取记忆文件完整内容（截断到 MEMORY_MAX_BYTES） */
async function readMemoryRaw(file: string): Promise<string | null> {
  try {
    const st = await stat(file);
    if (!st.isFile()) return null;
    const raw = await readFile(file, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') <= MEMORY_MAX_BYTES) return raw;
    let cut = raw.length;
    while (cut > 0 && Buffer.byteLength(raw.slice(0, cut), 'utf8') > MEMORY_MAX_BYTES) cut--;
    return `${raw.slice(0, cut)}\n\n…[记忆文件过长已截断；需要完整内容请用 read_file 定向读取]`;
  } catch {
    return null;
  }
}

/** 记忆搜索：遍历项目 + 全局记忆文件，返回命中行（每行带路径，按命中数/位置排序——轻量"语义"近似） */
export async function searchMemory(
  query: string,
  cwd = process.cwd()
): Promise<{ file: string; line: number; text: string }[]> {
  const files = new Set<string>();
  for (const f of findAgentsFiles(cwd)) files.add(f);
  if (existsSync(globalMemoryPath())) files.add(globalMemoryPath());
  // 结构化主题文件（1.0 P1-2）：memory/topics/*.md 也参与检索
  try {
    const { listTopics } = await import('../agent/memory-topics.js');
    for (const t of await listTopics()) files.add(t.file);
  } catch {
    // 模块加载失败忽略（旧 bundle 兼容）
  }
  // 多关键词（空白分隔）：全部命中才计入（近似语义：AND 检索）
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits: { file: string; line: number; text: string }[] = [];
  for (const f of files) {
    const raw = await readMemoryRaw(f);
    if (!raw) continue;
    raw.split('\n').forEach((line, i) => {
      const lc = line.toLowerCase();
      if (terms.every((t) => lc.includes(t))) {
        const t = line.trim();
        if (t) hits.push({ file: f, line: i + 1, text: t.slice(0, 200) });
      }
    });
  }
  // 排序：命中行数多的文件靠前（近似相关度），再按路径
  const countByFile = new Map<string, number>();
  for (const h of hits) countByFile.set(h.file, (countByFile.get(h.file) ?? 0) + 1);
  return hits.sort((a, b) => {
    const ca = countByFile.get(a.file) ?? 0;
    const cb = countByFile.get(b.file) ?? 0;
    return cb - ca || a.file.localeCompare(b.file);
  });
}

/** memory_search 工具定义 */
export const memorySearchTool: Tool = {
  name: 'memory_search',
  description:
    '在全部记忆文件（项目 AGENTS.md 各层级 + 全局记忆）中按关键词搜索，返回命中条目（路径 + 行号 + 内容摘要）。' +
    '当任务需要回忆项目约定/架构/协作规范或用户偏好，但记忆索引里只有摘要时使用。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词（如 "构建命令"、"测试"、"回复语言"）' },
    },
    required: ['query'],
  },
  async execute(args) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) return '错误：缺少搜索关键词 query';
    const hits = await searchMemory(query);
    if (hits.length === 0) return `记忆中没有匹配「${query}」的条目。`;
    const byFile = new Map<string, { file: string; lines: string[] }>();
    for (const h of hits) {
      const key = h.file;
      const entry = byFile.get(key) ?? { file: key, lines: [] };
      if (entry.lines.length < 30) entry.lines.push(`  行 ${h.line}: ${h.text}`);
      byFile.set(key, entry);
    }
    const parts: string[] = [];
    for (const [file, entry] of byFile) {
      parts.push(`### ${file}\n${entry.lines.join('\n')}`);
    }
    return `记忆搜索「${query}」命中 ${hits.length} 处：\n\n${parts.join('\n\n')}`;
  },
};

/** memory_read 工具定义：按路径读取记忆文件完整内容 */
export const memoryReadTool: Tool = {
  name: 'memory_read',
  description:
    '按路径读取记忆文件（项目 AGENTS.md / AGENTS.override.md / 全局记忆）的完整内容。' +
    '记忆索引里只含摘要，需要完整约定/指令时用 read_file 之外的这个工具（自动定位记忆目录，超长截断）。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '记忆文件路径（来自记忆索引的路径标注，如 /path/to/AGENTS.md）' },
    },
    required: ['path'],
  },
  async execute(args) {
    const p = typeof args.path === 'string' ? args.path.trim() : '';
    if (!p) return '错误：缺少记忆文件路径 path';
    const raw = await readMemoryRaw(p);
    if (raw === null) return `记忆文件「${p}」不存在或不可读。`;
    return `### ${p}\n${raw}`;
  },
};

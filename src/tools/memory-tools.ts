/**
 * 记忆渐进披露工具（P0，Claude Code MEMORY.md 方案）：
 * 记忆/AGENTS.md 只常驻索引（name+description 或截断摘要），
 * 模型需要详细条目时用这两个工具按需读取：
 *
 * · memory_search —— 按关键词搜索全部记忆文件（项目 + 全局），返回命中条目（路径 + 行号 + 内容摘要）
 * · memory_read   —— 按路径读取某个记忆文件的完整内容（受 MEMORY_MAX_BYTES 截断，提示 read_file 定向读取）
 * · memory_update —— 保存主题/来源/适用基线，显式复核后更新；受写权限约束。
 */
import { readFile, stat, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Tool } from './types.js';
import { findAgentsFiles, globalMemoryPath, MEMORY_MAX_BYTES } from '../agent/memory.js';
import { existsSync } from 'node:fs';
import { truncateUtf8ByBytes } from './util.js';
import { listTopics, memoryIndexFile, memoryTopicsDir, memoryTopicSlug, rebuildIndex, renderMemoryIndex, serializeMemoryTopic, type MemoryTopic } from '../agent/memory-topics.js';
import { captureMemoryBaseline, checkMemoryFreshness, memoryFreshnessNotice } from '../agent/memory-freshness.js';
import { redactText } from '../agent/redact.js';

/** 读取记忆文件完整内容（截断到 MEMORY_MAX_BYTES） */
async function readMemoryRaw(file: string): Promise<string | null> {
  try {
    const st = await stat(file);
    if (!st.isFile()) return null;
    const raw = await readFile(file, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') <= MEMORY_MAX_BYTES) return raw;
    return `${truncateUtf8ByBytes(raw, MEMORY_MAX_BYTES)}\n\n…[记忆文件过长已截断；需要完整内容请用 read_file 定向读取]`;
  } catch {
    return null;
  }
}

/** 记忆搜索：遍历项目 + 全局记忆文件，返回命中行（每行带路径，按命中数/位置排序——轻量"语义"近似） */
export async function searchMemory(
  query: string,
  cwd = process.cwd()
): Promise<{ file: string; line: number; text: string; freshness?: string }[]> {
  const files = new Set<string>();
  const topics = await listTopics();
  for (const f of findAgentsFiles(cwd)) files.add(f);
  if (existsSync(globalMemoryPath())) files.add(globalMemoryPath());
  // 结构化主题文件：检索正文，元数据通过独立适用性说明返回。
  for (const t of topics) files.add(t.file);
  // 多关键词（空白分隔）：全部命中才计入（近似语义：AND 检索）
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits: { file: string; line: number; text: string; freshness?: string }[] = [];
  for (const f of files) {
    const raw = await readMemoryRaw(f);
    if (!raw) continue;
    const topic = topics.find((t) => t.file === f);
    const freshness = topic ? memoryFreshnessNotice(await checkMemoryFreshness(topic.freshness, cwd, topic.freshnessInvalid), topic.freshness) : undefined;
    const bodyStart = topic ? (raw.match(/^---\n[\s\S]*?\n---\n?/)?.[0].split('\n').length ?? 1) - 1 : 0;
    raw.split('\n').forEach((line, i) => {
      if (i < bodyStart) return; // 不把哈希、JSON 元数据当作经验搜索结果。
      const lc = line.toLowerCase();
      if (terms.every((t) => lc.includes(t))) {
        const t = line.trim();
        if (t) hits.push({ file: f, line: i + 1, text: t.slice(0, 200), ...(freshness ? { freshness } : {}) });
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
    '当任务需要回忆项目约定/架构/协作规范或用户偏好，但记忆索引里只有摘要时使用。主题附来源和适用性状态；待复核内容仅作历史线索，须先验证，不能当当前事实。',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词（如 "构建命令"、"测试"、"回复语言"）' },
    },
    required: ['query'],
  },
  async execute(args, ctx) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) return '错误：缺少搜索关键词 query';
    const hits = await searchMemory(query, ctx?.cwd);
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
      const notice = hits.find((h) => h.file === file)?.freshness;
      parts.push(`### ${file}\n${notice ? `${notice}\n` : ''}${entry.lines.join('\n')}`);
    }
    return `记忆搜索「${query}」命中 ${hits.length} 处：\n\n${parts.join('\n\n')}`;
  },
};

/** memory_read 工具定义：按路径读取记忆文件完整内容 */
export const memoryReadTool: Tool = {
  name: 'memory_read',
  description:
    '按路径读取记忆文件（项目 AGENTS.md / AGENTS.override.md / 全局记忆）的完整内容。' +
    '记忆索引里只含摘要，需要完整约定/指令时用这个工具（超长截断）。主题同时检查关联文件/依赖声明；待复核内容只能作为历史线索。需要记录来源、关联或明确复核后更新基线时用 memory_update。',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '记忆文件路径（来自记忆索引的路径标注，如 /path/to/AGENTS.md）' },
    },
    required: ['path'],
  },
  async execute(args, ctx) {
    const p = typeof args.path === 'string' ? args.path.trim() : '';
    if (!p) return '错误：缺少记忆文件路径 path';
    const resolved = path.resolve(ctx?.cwd || process.cwd(), p);
    if (resolved === path.resolve(memoryIndexFile())) return `### ${p}\n${await renderMemoryIndex(ctx?.cwd)}`;
    const raw = await readMemoryRaw(resolved);
    if (raw === null) return `记忆文件「${p}」不存在或不可读。`;
    const canonical = await realpath(resolved).catch(() => resolved);
    const topics = await listTopics();
    let topic = topics.find((t) => path.resolve(t.file) === resolved);
    if (!topic) {
      for (const candidate of topics) {
        if (await realpath(candidate.file).catch(() => '') === canonical) { topic = candidate; break; }
      }
    }
    const notice = topic ? memoryFreshnessNotice(await checkMemoryFreshness(topic.freshness, ctx?.cwd, topic.freshnessInvalid), topic.freshness) : '';
    return `### ${p}\n${notice ? `${notice}\n\n` : ''}${raw}`;
  },
};

/** 主题写入入口：只关联显式文件，不自动给跨项目用户偏好添加易过期依赖。 */
export const memoryUpdateTool: Tool = {
  name: 'memory_update',
  approvalMode: 'auto',
  readOnly: false,
  description: '保存或修订结构化记忆主题，记录来源并关联当前工作区的文件 SHA-256 / package.json 依赖声明。' +
    '创建用 topic+content，可选 files/dependencies/globs；修订已有主题用 path（memory_search/read 返回的路径）或同一 topic，content 替换整篇正文。' +
    '文件或依赖变化后记忆会标待复核。只有已根据当前代码/测试或用户明确确认适用性后，才能 action=confirm、confirm=true 并提供 verification 说明以刷新基线；不要仅因变化自动确认。' +
    '不运行任何历史命令；基线未变化不等于内容正确。依赖版本是 manifest 中的声明范围；自动关联同级现存 npm/pnpm/yarn/bun 锁文件（哈希），不推断安装后的实际版本。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['save', 'confirm'], description: 'save 保存/修订；confirm 明确复核后更新已有主题基线' },
      topic: { type: 'string', description: '新主题标题或已有主题标题' },
      path: { type: 'string', description: '已有 topics/*.md 的完整路径（可代替 topic）' },
      content: { type: 'string', description: '主题完整 Markdown 正文；修订时替换旧正文，不是追加' },
      globs: { type: 'string', description: '可选，任务涉及这些路径时自动注入，如 src/**' },
      files: { type: 'array', items: { type: 'string' }, description: '显式关联的工作区相对文件路径，最多共 24 项，不跟踪整个目录' },
      dependencies: { type: 'array', items: { type: 'object', properties: {
        manifest: { type: 'string', description: 'package.json 格式清单的工作区相对路径，默认 package.json' },
        name: { type: 'string', description: '依赖名称，如 openai' },
      }, required: ['name'] }, description: '关联依赖声明版本（与 files 合计最多 24 项）' },
      source: { type: 'string', description: '来源会话、文件或用户说明；缺省记录当前会话路径' },
      confirm: { type: 'boolean', description: '必须明确为 true 才允许重建已有基线' },
      verification: { type: 'string', description: '复核依据：当前测试/代码检查结果或用户明确确认；更新已有基线时必填' },
    },
    required: ['action'],
  },
  async execute(args, ctx) {
    try {
      if (args.action !== 'save' && args.action !== 'confirm') throw new Error('action 必须为 save 或 confirm');
      const cwd = ctx?.cwd || process.cwd();
      const topics = await listTopics();
      const title = typeof args.topic === 'string' ? args.topic.trim() : '';
      const requestedPath = typeof args.path === 'string' ? path.resolve(cwd, args.path) : '';
      const existing = requestedPath ? topics.find((t) => path.resolve(t.file) === requestedPath)
        : title ? topics.find((t) => path.basename(t.file) === `${memoryTopicSlug(title)}.md`) : undefined;
      if (requestedPath && !existing) throw new Error('path 必须指向现有记忆主题，不能写任意文件');
      if (title.length > 200) throw new Error('主题标题最多 200 字符');
      const content = typeof args.content === 'string' ? args.content.trim() : existing?.content;
      if ((!existing && !title) || !content || Buffer.byteLength(content) > MEMORY_MAX_BYTES) throw new Error('创建主题需 topic 和非空 content（最多 40 KiB）');
      if (args.action === 'confirm' && !existing) throw new Error('confirm 只用于已有主题');
      if (args.files !== undefined && (!Array.isArray(args.files) || !args.files.every((f) => typeof f === 'string'))) throw new Error('files 必须是相对路径字符串数组');
      if (args.dependencies !== undefined && (!Array.isArray(args.dependencies) || !args.dependencies.every((d) => d && typeof d === 'object' && typeof d.name === 'string' && (d.manifest === undefined || typeof d.manifest === 'string')))) throw new Error('dependencies 必须含 name 和可选 manifest');
      const refresh = args.action === 'confirm' || args.files !== undefined || args.dependencies !== undefined;
      const verification = typeof args.verification === 'string' ? args.verification.trim() : '';
      if (existing && refresh && (args.confirm !== true || !verification)) throw new Error('更新已有基线需 confirm=true 和非空 verification；先验证当前适用性');
      const topic: MemoryTopic = existing ? { ...existing, content: redactText(content) } : {
        file: path.join(memoryTopicsDir(), `${memoryTopicSlug(title)}.md`), topic: title,
        date: new Date().toISOString().slice(0, 10), content: redactText(content),
      };
      if (args.globs !== undefined) {
        if (typeof args.globs !== 'string' || args.globs.length > 1000) throw new Error('globs 必须为 1000 字符内的字符串');
        topic.globs = args.globs;
      }
      if (!existing || refresh) {
        const files = args.files as string[] | undefined ?? existing?.freshness?.files.map((f) => f.path) ?? [];
        const dependencies = args.dependencies !== undefined
          ? (args.dependencies as { manifest?: string; name: string }[]).map((d) => ({ manifest: d.manifest || 'package.json', name: d.name }))
          : existing?.freshness?.dependencies.map(({ manifest, name }) => ({ manifest, name })) ?? [];
        const source = typeof args.source === 'string' ? args.source : existing?.freshness?.source || ctx?.sessionPath;
        topic.freshness = await captureMemoryBaseline(cwd, files, dependencies, source ? redactText(source) : undefined, verification ? redactText(verification) : undefined);
        topic.freshnessInvalid = false;
      } else if (topic.freshness && typeof args.source === 'string') {
        // 修订出处不意味着重新确认适用性，不改变关联文件基线或记录时间。
        topic.freshness = { ...topic.freshness, source: redactText(args.source).slice(0, 1000) };
      }
      topic.date = new Date().toISOString().slice(0, 10);
      await mkdir(memoryTopicsDir(), { recursive: true });
      // listTopics 排除符号链接；现存文件及目录仍校验真实位置，拒绝链接替换。
      const dir = await realpath(memoryTopicsDir());
      if (existing && path.dirname(await realpath(existing.file)) !== dir) throw new Error('主题文件位于记忆目录外');
      if (!existing && existsSync(topic.file)) throw new Error('主题文件已存在但不可作为普通主题写入');
      await writeFile(topic.file, serializeMemoryTopic(topic), 'utf8');
      await rebuildIndex();
      return `已${args.action === 'confirm' ? '记录复核并更新基线' : '保存记忆主题'}：${topic.file}\n` +
        memoryFreshnessNotice(await checkMemoryFreshness(topic.freshness, cwd, topic.freshnessInvalid), topic.freshness);
    } catch (error) {
      return `错误：${error instanceof Error ? error.message : String(error)}`;
    }
  },
};

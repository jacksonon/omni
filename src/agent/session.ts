/**
 * 会话持久化：把交互对话落盘为 JSONL，支持跨进程恢复（--continue / --resume）。
 *
 * 文件位置：~/.config/omni/sessions/<时间戳>-<项目slug>.jsonl（尊重 XDG_CONFIG_HOME）。
 * 格式（每行一个 JSON）：
 *   {"t":"meta","id":...,"project":...,"model":...,"created":...,"updated":...}
 *   {"t":"m","m":{role,content,...}}   —— 完整 ChatCompletionMessageParam，可原样回读
 *
 * 写入时机（由交互循环调用）：每轮对话结束后追加该轮新增的消息（增量 append，
 * 崩溃也不丢已完成的轮次）；退出时刷新 meta（updated 时间戳，用于「最近会话」排序）。
 *
 * 过滤：注入上下文的环境脚手架（[项目记忆 / [全局记忆 / [已按任务预载 的 system 消息）
 * 不落盘——它们随文件/配置变化，下次恢复时由 prepareContext 按最新内容重新注入。
 */
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

/** 不落盘的上下文脚手架前缀（恢复时 prepareContext 会按最新文件重新注入） */
const SKIP_PREFIXES = ['[项目记忆', '[全局记忆', '[已按任务预载', '[已发现技能', '[项目结构地图'];

/** 会话 meta（文件首行） */
export interface SessionMeta {
  id: string;
  /** 创建时的 cwd（会话按项目隔离：--continue 只恢复当前项目） */
  project: string;
  model: string;
  created: number;
  updated: number;
  /** 会话标题（/rename 设置；恢复时还原为终端窗口标题） */
  title?: string;
}

/** 列表项 = meta + 文件路径 + 消息数 */
export interface SessionInfo extends SessionMeta {
  path: string;
  /** 消息条数（meta 行之外的行数） */
  messages: number;
}

/** 会话目录：尊重 XDG_CONFIG_HOME（与全局记忆/全局配置同体系） */
export function sessionsDir(): string {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'omni', 'sessions');
}

/** 从项目路径生成文件名 slug（去路径分隔符，保留可读性） */
function projectSlug(project: string): string {
  const base = path.basename(project) || 'root';
  return base.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 40) || 'session';
}

/** 生成会话 id（时间戳 + 随机后缀，作为文件名主干的唯一标识） */
export function newSessionId(project: string): string {
  const ts = new Date().toISOString().replace(/[-:T]/g, '').replace(/\..+$/, '');
  const rand = Math.random().toString(36).slice(2, 6);
  return `${ts}-${projectSlug(project)}-${rand}`;
}

/** 创建会话文件（写 meta 首行），返回文件路径；失败返回 null（不打扰对话） */
export async function createSession(
  meta: Pick<SessionMeta, 'project' | 'model'>
): Promise<string | null> {
  try {
    const dir = sessionsDir();
    await mkdir(dir, { recursive: true });
    const id = newSessionId(meta.project);
    const now = Date.now();
    const full: SessionMeta = { ...meta, id, created: now, updated: now };
    const file = path.join(dir, `${id}.jsonl`);
    await writeFile(file, JSON.stringify({ t: 'meta', ...full }) + '\n', 'utf8');
    return file;
  } catch {
    return null;
  }
}

/** 是否应该落盘（过滤上下文脚手架 system 消息） */
export function isPersistable(m: ChatCompletionMessageParam): boolean {
  const c = m.content;
  if (typeof c !== 'string') return true; // tool_calls / 数组内容照常落盘
  return !SKIP_PREFIXES.some((p) => c.startsWith(p));
}

/** 过滤出可落盘的消息列表 */
export function persistableMessages(msgs: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  return msgs.filter(isPersistable);
}

/** 追加消息（JSONL 增量写入）；消息里脚手架消息被过滤；失败静默 */
export async function appendSessionMessages(
  file: string,
  msgs: ChatCompletionMessageParam[]
): Promise<boolean> {
  try {
    const lines = persistableMessages(msgs)
      .map((m) => JSON.stringify({ t: 'm', m }))
      .join('\n');
    if (!lines) return false;
    await appendFile(file, lines.endsWith('\n') ? lines : lines + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 会话结束：刷新 meta 的 updated 时间戳（重写首行，其余行不动） */
export async function finalizeSession(file: string): Promise<void> {
  try {
    if (!existsSync(file)) return;
    const raw = await readFile(file, 'utf8');
    const nl = raw.indexOf('\n');
    if (nl < 0) return;
    const first = raw.slice(0, nl);
    let meta: SessionMeta | null = null;
    try {
      const parsed = JSON.parse(first);
      if (parsed && parsed.t === 'meta') {
        meta = {
          id: parsed.id,
          project: parsed.project,
          model: parsed.model,
          created: parsed.created,
          updated: parsed.updated,
          ...(typeof parsed.title === 'string' ? { title: parsed.title } : {}),
        };
      }
    } catch {
      return; // 首行损坏 → 不重写
    }
    if (!meta) return;
    meta.updated = Date.now();
    await writeFile(file, JSON.stringify({ t: 'meta', ...meta }) + '\n' + raw.slice(nl + 1), 'utf8');
  } catch {
    // 静默失败
  }
}

/** 更新会话标题（重写 meta 首行，保留其余字段与消息；/rename 命令用） */
export async function updateSessionTitle(file: string, title: string): Promise<void> {
  try {
    if (!existsSync(file)) return;
    const raw = await readFile(file, 'utf8');
    const nl = raw.indexOf('\n');
    if (nl < 0) return;
    const first = raw.slice(0, nl);
    const parsed = JSON.parse(first);
    if (!parsed || parsed.t !== 'meta') return;
    parsed.title = title;
    await writeFile(file, JSON.stringify(parsed) + '\n' + raw.slice(nl + 1), 'utf8');
  } catch {
    // 静默失败
  }
}

/** 读取会话文件：返回 meta + 消息（不包含脚手架注入消息）；损坏/不存在返回 null */
export async function loadSession(
  file: string
): Promise<{ meta: SessionMeta; messages: ChatCompletionMessageParam[] } | null> {
  try {
    if (!existsSync(file)) return null;
    const raw = await readFile(file, 'utf8');
    const messages: ChatCompletionMessageParam[] = [];
    let meta: SessionMeta | null = null;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // 损坏行跳过
      }
      if (parsed.t === 'meta') {
        meta = {
          id: parsed.id,
          project: parsed.project,
          model: parsed.model,
          created: parsed.created,
          updated: parsed.updated,
          ...(typeof parsed.title === 'string' ? { title: parsed.title } : {}),
        };
      } else if (parsed.t === 'm' && parsed.m && typeof parsed.m === 'object') {
        const m = parsed.m as ChatCompletionMessageParam;
        if (isPersistable(m)) messages.push(m);
      }
    }
    if (!meta) return null;
    return { meta, messages };
  } catch {
    return null;
  }
}

/** 列出全部会话（按 updated 倒序：最近的在最前）；空目录/失败返回 [] */
export async function listSessions(project?: string): Promise<SessionInfo[]> {
  try {
    const dir = sessionsDir();
    if (!existsSync(dir)) return [];
    const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
    const out: SessionInfo[] = [];
    for (const f of files) {
      const loaded = await loadSession(path.join(dir, f));
      if (!loaded) continue;
      if (project && path.resolve(loaded.meta.project) !== path.resolve(project)) continue;
      out.push({
        ...loaded.meta,
        path: path.join(dir, f),
        messages: loaded.messages.length,
      });
    }
    return out.sort((a, b) => b.updated - a.updated);
  } catch {
    return [];
  }
}

/**
 * 若会话文件只有 meta 行（0 条消息——通常是进入交互模式时自动创建的占位文件），
 * 删除它。用于 /resume、/session 恢复其它会话后清理被替换的空占位会话，
 * 避免会话列表里残留孤儿。有消息的文件绝不删除。
 */
export async function removeEmptySession(file: string): Promise<void> {
  try {
    if (!existsSync(file)) return;
    const loaded = await loadSession(file);
    if (loaded && loaded.messages.length === 0) await rm(file, { force: true });
  } catch {
    // 静默失败（不打扰对话）
  }
}

/** 从会话文件路径取会话 id（文件名主干，如 `20260812-...-abcd`） */
export function sessionIdFromPath(file: string): string {
  return path.basename(file).replace(/\.jsonl$/, '');
}

/**
 * write_file 改前内容 sidecar（`{"t":"wfile",...}` 行，与 `ev` 事件行同机制）：
 * 实时 diff 只活在显示通道（loop 的 onToolResult detail），重载会话后历史只剩
 * tool args（path+content）——改前 original 丢失，Web 历史的左右对比只剩右半。
 * 此处按 tool callId 把 original 落盘，历史渲染按 callId 挂接恢复左半。
 * （edit_file 的 old/new 已在 args 里，重载安全，不用记。）
 * 新建文件（original=null）也记一条：历史据此确信"是新建"而非"记录缺失"。
 */
export interface WriteDiffRecord {
  /** assistant tool_calls 的 call id（历史挂接键；同文件多次写入各记各的） */
  callId: string;
  path: string;
  /** 写入前全文；null = 新建文件；超大文件跳过（不记） */
  original: string | null;
}

/** 改前全文落盘上限（字符；超限跳过——历史左半缺失时前端降级显示） */
export const WRITE_DIFF_MAX_CHARS = 100 * 1024;

/** 追加一条改前记录（fire-and-forget 用；失败静默） */
export async function appendWriteDiff(file: string, rec: WriteDiffRecord): Promise<boolean> {
  try {
    if (!rec.callId) return false;
    if (typeof rec.original === 'string' && rec.original.length > WRITE_DIFF_MAX_CHARS) return false;
    await appendFile(file, JSON.stringify({ t: 'wfile', ...rec }) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 读回全部改前记录（callId → 记录；同 callId 多条取最后一条） */
export async function loadWriteDiffs(file: string): Promise<Record<string, { path: string; original: string | null }>> {
  const out: Record<string, { path: string; original: string | null }> = {};
  try {
    if (!existsSync(file)) return out;
    const raw = await readFile(file, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        parsed && parsed.t === 'wfile' &&
        typeof parsed.callId === 'string' &&
        (typeof parsed.original === 'string' || parsed.original === null)
      ) {
        out[parsed.callId] = { path: typeof parsed.path === 'string' ? parsed.path : '', original: parsed.original };
      }
    }
  } catch {
    // 静默（历史降级显示）
  }
  return out;
}

/** 最近一个会话（当前项目；无则 null） */
export async function latestSession(project: string): Promise<SessionInfo | null> {
  const list = await listSessions(project);
  return list[0] ?? null;
}

/**
 * 按完整 id 精确查找会话文件路径（id = 文件名主干，如 `20260812-...-abcd`）。
 * 只做精确匹配（-r/--resume 等要求完整 id）；交互命令的模糊匹配用 findSessionCandidates。
 */
export async function findSessionById(id: string): Promise<string | null> {
  const list = await listSessions();
  const hit = list.find((s) => s.id === id);
  return hit?.path ?? null;
}

/**
 * 查找会话候选：精确 id 优先，其次前缀匹配（用户只记得开头/后缀时也能恢复）。
 * 返回全部命中（按 updated 倒序，最近在前）——调用方处理歧义（多个命中时列出候选），
 * 而不是静默选一个（否则短前缀会继续到错误的会话，e2e 抓到）。
 */
export async function findSessionCandidates(id: string): Promise<SessionInfo[]> {
  const list = await listSessions();
  const exact = list.filter((s) => s.id === id);
  if (exact.length > 0) return exact;
  return list.filter((s) => s.id.startsWith(id)).sort((a, b) => b.updated - a.updated);
}

/** 把会话信息格式化成可读行（-l/--list-sessions 展示） */
export function formatSessionInfo(s: SessionInfo): string {
  const d = new Date(s.updated);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const time = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${time}  ${s.messages} 条消息  ${s.project}  [${s.id}]`;
}

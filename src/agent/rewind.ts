/**
 * 会话检查点（/rewind，对标 Claude Code checkpoints / Cursor / Roo shadow-git）：
 *
 * 与 /undo 的区别 = **按用户回合打点、可回滚到任意历史时刻、快照持久化**——
 * 每轮用户消息提交后（runAgent 前）把工作区「已跟踪且已修改」文件的当前内容
 * 快照进 `.omni/checkpoints/<会话id>/<序号>.json`；/rewind 列出检查点、选择恢复
 * （三模式：code-only 只回滚文件 / conversation-only 只回滚对话 / both 双向回滚）。
 *
 * 设计取舍：**纯文件方案**（不引 shadow git / 依赖 git 仓库）——快照即数据，
 * 恢复 = 逆序写回；无 git 目录也能用；排除清单（node_modules/dist/.env/.omni 等）
 * 防止快照爆炸；单文件超 CHECKPOINT_FILE_MAX_BYTES 跳过（与 UndoStack 同策略）。
 * 快照存盘 → 会话恢复（--continue / /resume）后从磁盘重读，仍可 /rewind（关键特性）。
 *
 * P0 三模式（第一百×××次补齐）：
 *   · 检查点额外记录 `msgCount`（打点时刻可落盘消息数）——对话回滚截断到该长度；
 *   · 恢复前 diff 预览（文件 Δ + 对话截断条数）+ 模式确认；
 *   · 滚动上限：单会话最多 CHECKPOINT_MAX_COUNT 个 + 超 CHECKPOINT_MAX_AGE_MS 自动过期。
 */
import { mkdir, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { sessionIdFromPath } from './session.js';

const execAsync = promisify(exec);

/** 单文件快照字节上限：超过则跳过该文件（防快照被大文件撑爆；与 UndoStack.SNAPSHOT_MAX_BYTES 同量级） */
export const CHECKPOINT_FILE_MAX_BYTES = 1024 * 1024;

/** 滚动上限：单会话最多保留检查点数（对标 Claude Code 100 个） */
export const CHECKPOINT_MAX_COUNT = 100;

/** 滚动上限：检查点保留时长（对标 Claude Code 30 天，毫秒） */
export const CHECKPOINT_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

/** /rewind 恢复模式：code = 只回滚文件（默认，兼容旧行为）/ chat = 只回滚对话 / both = 双向回滚 */
export type RewindMode = 'code' | 'chat' | 'both';

/** 检查点目录名（项目 cwd 下 .omni/checkpoints/，已被 .gitignore 的 .omni/ 覆盖） */
export const CHECKPOINTS_DIRNAME = '.omni/checkpoints';

/** 快照时排除的目录/文件名（任一段路径命中即跳过） */
const EXCLUDED_NAMES = new Set([
  'node_modules', 'dist', 'build', 'out', '.git', '.omni', '.worktrees',
  '.env', '.DS_Store', 'release', 'release-electron', 'coverage', '.next', '.cache',
]);

/** 一个被快照文件的状态 */
export interface CheckpointFile {
  /** 绝对路径 */
  path: string;
  /** 快照时文件是否存在（false = 当时不存在，恢复时删除） */
  existed: boolean;
  /** 快照时的完整内容（不存在则为 ''） */
  content: string;
}

/** 一个检查点 = 一次用户回合提交时的工作区快照 */
export interface Checkpoint {
  /** 检查点 id = 会话内序号（1-based，文件名即 <N>.json；裁剪后可不连续） */
  index: number;
  /** 快照时间戳（epoch ms） */
  time: number;
  /** 触发本回合的用户消息（截断存摘要） */
  userMessage: string;
  /** 快照文件列表 */
  files: CheckpointFile[];
  /**
   * 打点时刻可落盘消息数（persistableMessages 长度，含触发本轮的用户消息）。
   * 对话回滚（chat/both）时把会话截断到该长度；缺省（旧检查点）= 未知，只能 code 模式。
   */
  msgCount?: number;
}

/** 判断路径是否应排除（路径任一段命中排除清单；.env 按文件名精确匹配） */
export function isExcludedPath(abs: string, cwd: string): boolean {
  const rel = path.relative(cwd, abs);
  if (rel.startsWith('..')) return true; // cwd 之外不快照（检查点只管工作区）
  const segs = rel.split(path.sep);
  return segs.some((s) => EXCLUDED_NAMES.has(s));
}

/**
 * 列出当前工作区「已跟踪且已修改」的文件（git status --porcelain）。
 * 无 git / git 失败 → 空数组（检查点退化为空快照——仍打点记录回合，恢复为 no-op）。
 * 未跟踪文件（??）不快照：它们在会话前已存在与否无法从 git 判定「会话前状态」，
 * 且 /undo 已覆盖新建文件场景；这里只管「会话改了已有文件」的回滚。
 */
export async function modifiedTrackedFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync('git status --porcelain', { cwd, timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    const out: string[] = [];
    for (const line of stdout.split('\n')) {
      if (line.length < 4) continue;
      const status = line.slice(0, 2);
      const file = line.slice(3).trim();
      if (!file) continue;
      // 只取「已跟踪的修改」（M/A/D/R 与未暂存组合）；?? 未跟踪 / !! 忽略文件跳过
      if (status.trim() === '??' || status.includes('!')) continue;
      // 重命名 "R  old -> new"：取新路径（old 已不存在，快照它无意义）
      const target = file.includes(' -> ') ? file.split(' -> ').pop()! : file;
      // git status 对含空格/中文路径会加引号，去掉
      const cleaned = target.replace(/^"(.*)"$/, '$1');
      out.push(path.resolve(cwd, cleaned));
    }
    return out;
  } catch {
    return [];
  }
}

/** 快照目录：项目 cwd/.omni/checkpoints/<会话id>/ */
export function checkpointsDir(sessionPath: string | undefined, cwd = process.cwd()): string {
  const id = sessionPath ? sessionIdFromPath(sessionPath) : 'adhoc';
  return path.join(cwd, CHECKPOINTS_DIRNAME, id);
}

/**
 * 创建检查点：快照当前工作区修改文件 → 写 `<dir>/<N>.json`（N = 已有最大序号 + 1，
 * 裁剪后序号可不连续，避免复用冲突）。msgCount = 打点时刻可落盘消息数（对话回滚用，
 * 调用方传 persistableMessages(messages).length；不传则为旧式检查点，仅支持 code 模式）。
 * 写盘后执行滚动裁剪（超 100 个 / 超 30 天删除最旧）。返回检查点。
 */
export async function createCheckpoint(
  sessionPath: string | undefined,
  userMessage: string,
  cwd = process.cwd(),
  msgCount?: number
): Promise<Checkpoint> {
  const files: CheckpointFile[] = [];
  const tracked = await modifiedTrackedFiles(cwd);
  for (const abs of tracked) {
    if (isExcludedPath(abs, cwd)) continue;
    try {
      const st = await stat(abs);
      if (!st.isFile() || st.size > CHECKPOINT_FILE_MAX_BYTES) continue;
      files.push({ path: abs, existed: true, content: await readFile(abs, 'utf8') });
    } catch {
      // stat 成功但读取失败（权限等）→ 跳过该文件
    }
  }
  const dir = checkpointsDir(sessionPath, cwd);
  let index = 1;
  try {
    const existing = existsSync(dir) ? (await readdir(dir)).filter((f) => f.endsWith('.json')) : [];
    const nums = existing.map((f) => Number(f.slice(0, -5))).filter((n) => Number.isInteger(n));
    index = nums.length > 0 ? Math.max(...nums) + 1 : 1;
  } catch {
    // 列目录失败 → 从 1 开始（极端情况：覆盖写也不丢对话）
  }
  const cp: Checkpoint = {
    index,
    time: Date.now(),
    userMessage: userMessage.slice(0, 200),
    files,
    ...(typeof msgCount === 'number' ? { msgCount } : {}),
  };
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${index}.json`), JSON.stringify(cp), 'utf8');
  } catch {
    // 落盘失败静默（不打扰对话；内存态仍可用于本次 /rewind）
  }
  // 滚动裁剪（失败静默，不打扰对话）
  await pruneCheckpoints(sessionPath, cwd).catch(() => null);
  return cp;
}

/**
 * 滚动裁剪：删除超 30 天的过期检查点 + 超 100 个时删除最旧（按 time 升序）。
 * 返回删除的序号列表（供调试/测试；失败抛异常由调用方吞掉）。
 */
export async function pruneCheckpoints(
  sessionPath: string | undefined,
  cwd = process.cwd(),
  now = Date.now()
): Promise<number[]> {
  const dir = checkpointsDir(sessionPath, cwd);
  if (!existsSync(dir)) return [];
  const names = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  if (names.length === 0) return [];
  const items: { file: string; index: number; time: number }[] = [];
  for (const f of names) {
    try {
      const parsed = JSON.parse(await readFile(path.join(dir, f), 'utf8')) as Checkpoint;
      if (parsed && typeof parsed.index === 'number' && typeof parsed.time === 'number') {
        items.push({ file: f, index: parsed.index, time: parsed.time });
      }
    } catch {
      // 损坏文件直接删除（占位不占数）
      try { await unlink(path.join(dir, f)); } catch { /* 忽略 */ }
    }
  }
  const removed: number[] = [];
  // 1) 超期（30 天）
  const expired = items.filter((i) => now - i.time > CHECKPOINT_MAX_AGE_MS);
  for (const e of expired) {
    try {
      await unlink(path.join(dir, e.file));
      removed.push(e.index);
    } catch { /* 忽略 */ }
  }
  let kept = items.filter((i) => !removed.includes(i.index)).sort((a, b) => a.time - b.time || a.index - b.index);
  // 2) 超数（100 个）：删最旧
  while (kept.length > CHECKPOINT_MAX_COUNT) {
    const oldest = kept.shift()!;
    try {
      await unlink(path.join(dir, oldest.file));
      removed.push(oldest.index);
    } catch { /* 忽略 */ }
  }
  return removed;
}

/** /rewind 参数解析结果 */
export interface ParsedRewindArgs {
  ok: boolean;
  /** 检查点序号（ok 时有效） */
  index: number;
  /** 恢复模式（缺省 code，兼容旧行为） */
  mode: RewindMode;
  /** --yes/-y 跳过确认（非交互/脚本用） */
  yes: boolean;
  error?: string;
}

/**
 * 解析 /rewind 参数：`<N> [--code|--chat|--both] [--yes]`。
 * 兼容写法：--code-only / --conversation / --conversation-only / chat / both / code 裸词。
 */
export function parseRewindArgs(raw: string): ParsedRewindArgs {
  const toks = raw.trim().split(/\s+/).filter(Boolean);
  if (toks.length === 0) return { ok: false, index: NaN, mode: 'code', yes: false, error: 'empty' };
  const n = Number(toks[0]);
  if (!Number.isInteger(n)) return { ok: false, index: NaN, mode: 'code', yes: false, error: 'bad-index' };
  let mode: RewindMode = 'code';
  let yes = false;
  for (const t of toks.slice(1)) {
    const v = t.toLowerCase();
    if (v === '--yes' || v === '-y' || v === '--confirm=false' || v === '-f') { yes = true; continue; }
    if (v === '--code' || v === '--code-only' || v === 'code' || v === 'code-only') { mode = 'code'; continue; }
    if (v === '--chat' || v === '--conversation' || v === '--conversation-only' || v === '--chat-only' ||
        v === 'chat' || v === 'conversation' || v === 'conversation-only') { mode = 'chat'; continue; }
    if (v === '--both' || v === 'both' || v === '--all') { mode = 'both'; continue; }
    return { ok: false, index: n, mode, yes, error: `未知参数 ${t}（用法：/rewind <序号> [--code|--chat|--both] [--yes]）` };
  }
  return { ok: true, index: n, mode, yes };
}

/** 恢复模式人类可读名（三端统一文案） */
export function rewindModeLabel(mode: RewindMode): string {
  return mode === 'code' ? '仅代码' : mode === 'chat' ? '仅对话' : '代码+对话';
}

/**
 * 把内存消息截断到前 keepCount 条可落盘消息（保留全部脚手架 system + 截断后补救）。
 * 安全边界：若截断点落在 assistant tool_calls 之后（其 tool 结果被丢弃），回退丢掉该
 * assistant（避免悬空 tool_calls 下轮发给 API 报错）。返回丢弃的可落盘条数。
 */
export function truncateMessagesToCount(
  messages: { role: string; tool_calls?: unknown; content?: unknown }[],
  keepCount: number
): { dropped: number } {
  let seen = 0;
  let cut = messages.length;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as unknown as Record<string, unknown>;
    const c = m['content'];
    const persistable = typeof c !== 'string' ? true : !isScaffoldContent(c as string);
    if (!persistable) continue;
    seen++;
    if (seen > keepCount) { cut = i; break; }
  }
  if (cut >= messages.length) return { dropped: 0 };
  // 安全回退：截断点紧随 tool_calls assistant → 把该 assistant 也丢掉
  const prev = messages[cut - 1] as unknown as Record<string, unknown> | undefined;
  let safeCut = cut;
  if (prev && prev['role'] === 'assistant' && (prev as { tool_calls?: unknown }).tool_calls) {
    safeCut = cut - 1;
  }
  const droppedPersistable = countPersistable(messages.slice(safeCut));
  messages.length = safeCut;
  return { dropped: droppedPersistable };
}

/** 脚手架前缀判断（与 session.ts SKIP_PREFIXES 同源，避免循环导入） */
function isScaffoldContent(c: string): boolean {
  return c.startsWith('[项目记忆') || c.startsWith('[全局记忆') || c.startsWith('[已按任务预载') ||
    c.startsWith('[已发现技能') || c.startsWith('[项目结构地图');
}

function countPersistable(msgs: { content?: unknown }[]): number {
  let n = 0;
  for (const m of msgs) {
    const c = (m as Record<string, unknown>)['content'] ?? (m as { content?: unknown }).content;
    if (typeof c !== 'string' || !isScaffoldContent(c)) n++;
  }
  return n;
}

/**
 * 构建恢复前预览行（文件 Δ + 对话截断数，三端复用同一文案）。
 * diff = checkpointDiffStats 结果；curPersist = 当前可落盘消息数。
 */
export function buildRewindPreview(
  cp: Checkpoint,
  diff: { add: number; rem: number; files: string[] },
  curPersist: number,
  mode: RewindMode
): string[] {
  const lines: string[] = [];
  lines.push(`检查点 #${cp.index} · ${cp.userMessage.replace(/\s+/g, ' ').slice(0, 60) || '（无文本）'} · ${new Date(cp.time).toLocaleString()}`);
  lines.push(`模式：${rewindModeLabel(mode)}（/rewind ${cp.index} --${mode === 'code' ? 'code' : mode} --yes 直接执行）`);
  if (mode === 'code' || mode === 'both') {
    if (diff.add === 0 && diff.rem === 0) lines.push(`文件：与当前一致（${cp.files.length} 个快照文件，无需回滚）`);
    else {
      lines.push(`文件：将回滚 ${cp.files.length} 个文件（与当前差 Δ +${diff.add} −${diff.rem} 行）：`);
      for (const f of diff.files.slice(0, 10)) lines.push(`· ${f}`);
      if (diff.files.length > 10) lines.push(`… 还有 ${diff.files.length - 10} 个文件`);
    }
  } else {
    lines.push(`文件：保持不动（仅对话模式）`);
  }
  if (mode === 'chat' || mode === 'both') {
    if (typeof cp.msgCount !== 'number') {
      lines.push(`对话：该检查点无对话快照（旧版打点），仅支持 --code；用 --code 回滚文件`);
    } else {
      const drop = Math.max(0, curPersist - cp.msgCount);
      lines.push(drop > 0 ? `对话：将截断 ${drop} 条（${curPersist} → ${cp.msgCount}），截断后不可恢复` : `对话：已在该位置（无需截断）`);
    }
  } else {
    lines.push(`对话：保持不动（仅代码模式）`);
  }
  return lines;
}

/**
 * 执行回滚（三端共用）：
 *   code → 只写回文件；chat → 只截断对话（含会话文件）；both → 双向。
 * messages 原地截断；会话文件截断经 truncateSessionFile 落盘（失败不抛，由调用方提示）。
 * 返回 { fileResults, dropped }。
 */
export async function executeRewind(
  sessionPath: string | undefined,
  messages: { role: string; content?: unknown; tool_calls?: unknown }[],
  target: Checkpoint,
  mode: RewindMode
): Promise<{ fileResults: string[]; dropped: number }> {
  let fileResults: string[] = [];
  if (mode === 'code' || mode === 'both') {
    fileResults = await restoreCheckpoint(target);
  }
  let dropped = 0;
  if (mode === 'chat' || mode === 'both') {
    if (typeof target.msgCount === 'number') {
      const r = truncateMessagesToCount(messages as never[], target.msgCount);
      dropped = r.dropped;
      if (sessionPath) {
        const { truncateSessionFile } = await import('./session.js');
        await truncateSessionFile(sessionPath, target.msgCount).catch(() => null);
      }
    }
  }
  return { fileResults, dropped };
}

/** 读取某会话的全部检查点（按序号升序）；目录缺失/损坏行跳过 */
export async function loadCheckpoints(sessionPath: string | undefined, cwd = process.cwd()): Promise<Checkpoint[]> {
  const dir = checkpointsDir(sessionPath, cwd);
  if (!existsSync(dir)) return [];
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)));
    const out: Checkpoint[] = [];
    for (const f of files) {
      try {
        const parsed = JSON.parse(await readFile(path.join(dir, f), 'utf8')) as Checkpoint;
        if (parsed && typeof parsed.index === 'number' && Array.isArray(parsed.files)) out.push(parsed);
      } catch {
        // 损坏行跳过
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** 读取单个检查点（/rewind <N>）；不存在返回 null */
export async function loadCheckpoint(
  sessionPath: string | undefined,
  index: number,
  cwd = process.cwd()
): Promise<Checkpoint | null> {
  const all = await loadCheckpoints(sessionPath, cwd);
  return all.find((c) => c.index === index) ?? null;
}

/** 恢复一个快照文件：存在 → 写回内容；不存在 → 删除（新建文件回滚）。返回人类可读结果 */
export async function restoreCheckpointFile(f: CheckpointFile): Promise<string> {
  const label = path.relative(process.cwd(), f.path) || f.path;
  if (f.existed) {
    await mkdir(path.dirname(f.path), { recursive: true });
    await writeFile(f.path, f.content, 'utf8');
    return `已恢复 ${label}`;
  }
  try {
    await unlink(f.path);
    return `已删除 ${label}`;
  } catch {
    return `${label} 已不存在（无需处理）`;
  }
}

/**
 * 恢复检查点：把快照的全部文件写回快照时状态。
 * **只回滚文件，不动对话历史**（模型经调用方注入的 system 提示知晓回滚）。
 * 返回逐文件结果（供命令层展示）。
 */
export async function restoreCheckpoint(cp: Checkpoint): Promise<string[]> {
  const results: string[] = [];
  for (const f of cp.files) {
    try {
      results.push(await restoreCheckpointFile(f));
    } catch (err) {
      results.push(`恢复失败 ${path.basename(f.path)}：${err instanceof Error ? err.message : err}`);
    }
  }
  return results;
}

/** 检查点摘要行（/rewind 列表用）：`#N · 用户消息摘要 · 时间` */
export function checkpointSummaryLine(cp: Checkpoint, now = Date.now()): string {
  const d = new Date(cp.time);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const time = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const ago = Math.max(0, Math.round((now - cp.time) / 60000));
  const agoLabel = ago < 1 ? '刚刚' : ago < 60 ? `${ago} 分钟前` : `${Math.round(ago / 60)} 小时前`;
  const msg = cp.userMessage.replace(/\s+/g, ' ').slice(0, 50);
  return `#${cp.index} · ${msg || '（无文本）'} · ${time}（${agoLabel}）· ${cp.files.length} 个文件`;
}

/**
 * 检查点与当前工作区的差异统计（可视化 P1）：对快照的每个文件，
 * 比较当前内容与快照内容，输出 `+A −B 行` 汇总（复用 format.ts 的行级 LCS）。
 * 返回 { add, rem, files } —— files 为有差异的文件相对路径列表。
 */
export async function checkpointDiffStats(
  cp: Checkpoint,
  cwd = process.cwd()
): Promise<{ add: number; rem: number; files: string[] }> {
  const { countDiffLines } = await import('../output/format.js');
  let add = 0;
  let rem = 0;
  const files: string[] = [];
  for (const f of cp.files) {
    let cur: string | null = null;
    try {
      cur = await readFile(f.path, 'utf8');
    } catch {
      cur = null; // 文件已不存在 = 相对快照全删
    }
    const snapshot = f.existed ? f.content : '';
    if (cur === snapshot) continue; // 与快照一致（已恢复过/未被改动）
    const st = countDiffLines(snapshot, cur ?? '');
    add += st.add;
    rem += st.rem;
    files.push(path.relative(cwd, f.path) || f.path);
  }
  return { add, rem, files };
}

/** 删除某会话的全部检查点（会话删除时清理；失败静默） */
export async function removeCheckpoints(sessionPath: string | undefined, cwd = process.cwd()): Promise<void> {
  try {
    await rm(checkpointsDir(sessionPath, cwd), { recursive: true, force: true });
  } catch {
    // 静默
  }
}

/**
 * 自动 git commit（第五节 P2 git 集成深化，Aider 原子提交）：
 * 工作区有未提交改动时 `git add -A` + `git commit`（消息 = 用户消息摘要）。
 * 非 git 仓库 / 无改动 / 无 user.email 配置 → 返回 null（静默跳过）；
 * 成功返回 commit 摘要行。由交互循环在每轮 persistTurn 后调用（config autoCommit）。
 */
export async function autoGitCommit(userMessage: string, cwd = process.cwd()): Promise<string | null> {
  try {
    const { stdout: status } = await execAsync('git status --porcelain', { cwd, timeout: 5000, maxBuffer: 1024 * 1024 });
    if (!status.trim()) return null; // 无改动
    await execAsync('git add -A', { cwd, timeout: 10_000 });
    // 消息：用户消息首行摘要（截 72 字符；空消息回退固定文案）
    const firstLine = userMessage.replace(/\s+/g, ' ').trim().slice(0, 72) || 'omni 自动提交';
    const escaped = firstLine.replace(/"/g, '\\"');
    const { stdout } = await execAsync(`git commit -m "${escaped}"`, { cwd, timeout: 10_000 });
    const hash = stdout.match(/\[.*? ([0-9a-f]+)\]/)?.[1] ?? '';
    return `已自动提交 ${hash ? `${hash} ` : ''}：${firstLine}`;
  } catch {
    // 非 git 仓库 / 无 user.email / hook 拒绝等 → 静默跳过
    return null;
  }
}

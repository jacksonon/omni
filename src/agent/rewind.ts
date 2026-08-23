/**
 * 会话检查点（/rewind，对标 Claude Code checkpoints / Cursor / Roo shadow-git）：
 *
 * 与 /undo 的区别 = **按用户回合打点、可回滚到任意历史时刻、快照持久化**——
 * 每轮用户消息提交后（runAgent 前）把工作区「已跟踪且已修改」文件的当前内容
 * 快照进 `.omni/checkpoints/<会话id>/<序号>.json`；/rewind 列出检查点、选择恢复
 * （文件回滚，对话历史保留——模型经注入的 system 提示知晓回滚事实）。
 *
 * 设计取舍：**纯文件方案**（不引 shadow git / 依赖 git 仓库）——快照即数据，
 * 恢复 = 逆序写回；无 git 目录也能用；排除清单（node_modules/dist/.env/.omni 等）
 * 防止快照爆炸；单文件超 CHECKPOINT_FILE_MAX_BYTES 跳过（与 UndoStack 同策略）。
 * 快照存盘 → 会话恢复（--continue / /resume）后从磁盘重读，仍可 /rewind（关键特性）。
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
  /** 检查点 id = 会话内序号（1-based，文件名即 <N>.json） */
  index: number;
  /** 快照时间戳（epoch ms） */
  time: number;
  /** 触发本回合的用户消息（截断存摘要） */
  userMessage: string;
  /** 快照文件列表 */
  files: CheckpointFile[];
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
 * 创建检查点：快照当前工作区修改文件 → 写 `<dir>/<N>.json`（N = 已有数量 + 1）。
 * 返回检查点（失败/无会话文件时仍返回内存态检查点——不打扰对话，仅不持久化）。
 */
export async function createCheckpoint(
  sessionPath: string | undefined,
  userMessage: string,
  cwd = process.cwd()
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
    index = existing.length + 1;
  } catch {
    // 列目录失败 → 从 1 开始（极端情况：覆盖写也不丢对话）
  }
  const cp: Checkpoint = { index, time: Date.now(), userMessage: userMessage.slice(0, 200), files };
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${index}.json`), JSON.stringify(cp), 'utf8');
  } catch {
    // 落盘失败静默（不打扰对话；内存态仍可用于本次 /rewind）
  }
  return cp;
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

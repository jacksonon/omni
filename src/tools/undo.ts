/**
 * /undo：撤销本次会话对文件的修改。
 *
 * 机制：**写操作前快照**——入口层（main.ts attachRuntime）用 withUndoSnapshot
 * 包装 write_file 工具：每次执行前先把目标文件的当前内容（或「不存在」标记）记录进
 * UndoStack，然后才真正写入。主循环与子代理共用同一份被包装的工具表，因此子代理的
 * 写入同样被记录。
 *
 * /undo 命令（TUI/CLI 交互）：从栈里 pop 最近一次快照并恢复——
 * · 快照前文件存在 → 原样写回（内容即会话开始前的状态）；
 * · 快照前文件不存在 → 删除本次新建的文件；
 * · /undo all → 逆序恢复全部快照（回到会话开始前的文件状态）。
 *
 * 边界：只跟踪 write_file（run_command 的副作用无法可靠预知）；单文件超过
 * SNAPSHOT_MAX_BYTES 的快照跳过（该文件不支持撤销）；撤销栈是**内存态**
 * （--continue 恢复的会话撤销栈为空，从新会话开始记录）。
 */
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolvePath } from './util.js';
import type { Tool } from './types.js';

/** 单文件快照字节上限：超过则跳过该文件的撤销记录（防止内存被大文件撑爆） */
export const SNAPSHOT_MAX_BYTES = 1024 * 1024;

/** 一条撤销快照：某次 write_file 执行前的文件状态 */
export interface UndoEntry {
  /** 目标文件绝对路径 */
  path: string;
  /** 快照时文件是否存在（false = 本次会话新建，撤销时删除） */
  existed: boolean;
  /** 快照时的完整内容（不存在则为 ''） */
  content: string;
  /** 快照时间戳 */
  at: number;
}

/** 撤销栈：会话级，写操作前 push，/undo 时 pop；/redo 恢复最近一次撤销 */
export class UndoStack {
  private entries: UndoEntry[] = [];
  /** redo 栈：/undo 时捕获「撤销前」的文件状态（即本次写入后的状态），/redo pop 恢复 */
  private redoEntries: UndoEntry[] = [];

  get size(): number {
    return this.entries.length;
  }

  /** redo 栈大小（/redo 命令判断是否有可重做） */
  get redoSize(): number {
    return this.redoEntries.length;
  }

  /**
   * 捕获文件当前状态（redo 候选）：存在 → 记录内容；不存在（ENOENT）→ 记录「新建」标记。
   * 大文件/目录/权限错误 → null（该文件不支持 redo）。
   */
  private async captureCurrent(filePath: string): Promise<UndoEntry | null> {
    try {
      const st = await stat(filePath);
      if (!st.isFile() || st.size > SNAPSHOT_MAX_BYTES) return null;
      return { path: filePath, existed: true, content: await readFile(filePath, 'utf8'), at: Date.now() };
    } catch (e: any) {
      if (e?.code === 'ENOENT') return { path: filePath, existed: false, content: '', at: Date.now() };
      return null;
    }
  }

  /** 当前栈内容（只读视图，测试/调试用） */
  snapshotList(): readonly UndoEntry[] {
    return this.entries;
  }

  /**
   * 最近一次写入某文件的快照（write_file diff 展示用：取「写入前」内容；
   * 无记录返回 null）。路径相对 cwd 解析，与 snapshotWrite 同一规范化。
   */
  latestFor(filePath: string): UndoEntry | null {
    const abs = resolvePath(filePath);
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].path === abs) return this.entries[i];
    }
    return null;
  }

  /**
   * 记录一次写操作前的快照（path 相对 cwd 解析）。
   * 返回 false = 未记录（文件过大 / 是目录 / 读取失败——该文件不支持撤销）。
   * 注意：只有 ENOENT（确实不存在）才记录「新建」；权限错误/目录等其它 stat
   * 失败不记录，避免产生误导性的撤销条目（review 抓到的边界）。
   */
  async snapshotWrite(filePath: string, cwd?: string): Promise<boolean> {
    this.clearRedo(); // 新写入使 redo 历史失效（见 clearRedo 注释）
    const abs = resolvePath(filePath, cwd);
    let st: Awaited<ReturnType<typeof stat>> | null = null;
    try {
      st = await stat(abs);
    } catch (e: any) {
      if (e?.code !== 'ENOENT') return false;
    }
    if (st) {
      if (!st.isFile() || st.size > SNAPSHOT_MAX_BYTES) return false;
      try {
        const content = await readFile(abs, 'utf8');
        this.entries.push({ path: abs, existed: true, content, at: Date.now() });
        return true;
      } catch {
        return false; // 读取失败（权限等）→ 不记录
      }
    }
    // 文件确实不存在 → 记录「新建」快照（撤销时删除）
    this.entries.push({ path: abs, existed: false, content: '', at: Date.now() });
    return true;
  }

  /**
   * 记录一次写操作时清空 redo 栈——新的写入使「重做上次撤销」失去意义
   * （否则 /undo 后继续写文件，/redo 会把新写入覆盖掉）。
   */
  private clearRedo(): void {
    this.redoEntries.length = 0;
  }

  /**
   * pop 最近一次快照供 /undo，同时把「撤销前」状态（当前文件内容）捕获进 redo 栈
   * （/redo 恢复为撤销前的状态 = 本次写入后的内容）。返回快照（无则 null）。
   */
  async popForUndo(): Promise<UndoEntry | null> {
    const e = this.entries.pop();
    if (!e) return null;
    const cur = await this.captureCurrent(e.path);
    if (cur) this.redoEntries.push(cur);
    return e;
  }

  /**
   * pop 全部快照供 /undo all（**逆序**：最新的在前），同时逐个捕获 redo 候选
   * （顺序与撤销相反，/redo all 时按原写入顺序恢复）。
   */
  async popAllForUndo(): Promise<UndoEntry[]> {
    const entries = this.entries.splice(0);
    const redo: UndoEntry[] = [];
    for (const e of entries) {
      const cur = await this.captureCurrent(e.path);
      if (cur) redo.push(cur);
    }
    // entries 为写入顺序（旧→新）；popAllForUndo 返回逆序（新→旧）供撤销；
    // redo 栈 push 逆序后的结果（新→旧），/redo all 时再 pop 得到旧→新恢复顺序
    this.redoEntries.push(...redo.reverse());
    return entries.reverse();
  }

  /** /redo：pop 最近一次撤销前的状态（无则 null） */
  redo(): UndoEntry | null {
    return this.redoEntries.pop() ?? null;
  }

  /** /redo all：pop 全部 redo 候选（逆序 = 恢复最早一次撤销开始） */
  redoAll(): UndoEntry[] {
    return this.redoEntries.splice(0).reverse();
  }

  /** pop 最近一次快照（同步版，兼容旧调用/测试；不做 redo 捕获） */
  pop(): UndoEntry | null {
    return this.entries.pop() ?? null;
  }

  /** pop 全部快照（**逆序**：最新的在前——恢复时先回滚最近写入，同一文件多次写入回到最原始状态） */
  popAll(): UndoEntry[] {
    return this.entries.splice(0).reverse();
  }
}

/** 恢复一次撤销：文件存在 → 写回快照内容；不存在 → 删除本次新建。返回人类可读结果 */
export async function applyUndo(entry: UndoEntry): Promise<string> {
  const label = path.relative(process.cwd(), entry.path) || entry.path;
  if (entry.existed) {
    await mkdir(path.dirname(entry.path), { recursive: true });
    await writeFile(entry.path, entry.content, 'utf8');
    return `已恢复 ${label}`;
  }
  // 新建文件：仅当确实存在才删除（写失败/被后续操作处理过时可能不存在）——
  // 如实提示，不谎报「已删除」（review 抓到的边界）
  try {
    await unlink(entry.path);
    return `已删除本次新建的文件 ${label}`;
  } catch {
    return `已撤销记录（文件 ${label} 不存在，无需处理）`;
  }
}

/**
 * 包装工具：write_file 执行前先快照（/undo 的数据来源）；其它工具原样返回。
 * 包装发生在入口层（attachRuntime），主循环与子代理共用的都是包装后的工具表。
 */
export function withUndoSnapshot(tool: Tool, stack: UndoStack): Tool {
  if (tool.name !== 'write_file') return tool;
  return {
    ...tool,
    async execute(args, ctx) {
      // 快照与写入按同一 cwd 解析（worktree 子代理场景快照独立工作树内的文件）
      await stack.snapshotWrite(String(args.path ?? ''), ctx?.cwd);
      return tool.execute(args, ctx);
    },
  };
}

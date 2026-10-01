/**
 * 子代理线程注册表（Agent View / 子代理任务中心，1.0 完整版）。
 *
 * 把本次会话里跑过的每一个子代理（delegate 委托、编排 worker、goal worker）
 * 变成**可寻址、可钻取、可续跑**的线程记录：
 *   · 运行中 + 已完成都保留（不再随卡片消失被丢弃）；
 *   · transcript 保存完整 messages（钻取查看 + 续跑的核心）；
 *   · resume 闭包由创建方注入（捕获工具/闸门/模型等运行上下文）——UI 对已完成
 *     子代理发追问时，带原上下文继续跑（对标 Claude Code 打开 transcript 发 follow-up
 *     / resume subagents，Codex 的 open agent thread + steer）。
 *
 * 存储：挂在 runOpts.subagentRegistry 上的会话级对象（与 runOpts.team 同源，不落盘
 * 于内存；可选经 persistSubagent 落进会话 JSONL 供 /resume 回灌）。
 */
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { SubagentEvent } from './types.js';

/** 子代理线程状态 */
export type SubagentStatus = 'running' | 'ok' | 'err' | 'stopped';

/** 明细条目（钻取视图展示；think 思考 / tool 工具调用 / result 结果预览） */
export interface SubagentDetailItem {
  kind: 'think' | 'tool' | 'result';
  text: string;
  /** tool 条目工具名（着色用） */
  name?: string;
  /** result 条目是否成功 */
  ok?: boolean;
}

/** 单条子代理明细上限（超出丢最早——防超长子代理把内存/面板撑爆） */
export const SUBAGENT_DETAIL_MAX = 200;

/**
 * 子代理线程记录（Agent View 的"一行"）。
 * 由 runSubagent 在运行中实时维护，创建方（delegate/orchestrate）补 resume/stop 闭包。
 */
export interface SubagentRecord {
  /** 实例 id（进程内唯一，形如 sub1；嵌套逐层递增） */
  id: string;
  /** 父代理 id（null = 主代理直接委托） */
  parentId: string | null;
  /** 嵌套深度（0 = 主代理直接委托） */
  depth: number;
  /** 显示名（定义子代理名 / delegate / stepN / goal-worker） */
  name: string;
  /** 命名的子代理定义名（agent 参数；缺省 undefined = 通用） */
  agent?: string;
  /** 实际使用的模型名 */
  model?: string;
  /** 实际使用的思考级别（reasoning_effort） */
  effort?: string;
  /** 委托任务描述（start 事件携带） */
  task: string;
  status: SubagentStatus;
  /** 已执行步数 */
  steps: number;
  /** 步数上限 */
  maxSteps: number;
  startedAt: number;
  endedAt?: number;
  /** 主循环工具配对序号（UI 停止路由 key；编排 worker 为 null） */
  seq?: number | null;
  /** 工作目录（worktree 隔离时为独立工作树路径） */
  cwd?: string;
  /** 关联的 worktree 分支名（收尾提示用） */
  worktreeBranch?: string;
  /** 完整消息历史（钻取 + 续跑的唯一真相源） */
  transcript: ChatCompletionMessageParam[];
  /** 进度明细（按到达顺序；最多 SUBAGENT_DETAIL_MAX 条） */
  items: SubagentDetailItem[];
  /** 被截断丢弃的明细条数 */
  dropped: number;
  /** 最终结论（完成/停止后写入） */
  result?: string;
  /** 是否续跑过（UI 标注） */
  resumed?: boolean;
  /** 运行中取消控制器（停止句柄；无 seq 也保留） */
  controller?: AbortController;
}

/** 注册条目：记录 + 运行上下文闭包（创建方注入） */
export interface RegisteredSubagent {
  record: SubagentRecord;
  /** 续跑回调（带原 transcript + 一条 user 追问继续跑；创建方捕获运行上下文） */
  resume?: (followUp: string) => Promise<string>;
  /** 停止回调（运行中才有效；等价 abort） */
  stop?: () => void;
}

/**
 * 会话级子代理注册表（挂 runOpts.subagentRegistry）。
 * 纯对象 + Map，无框架依赖；onChange 供 UI 可选刷新。
 */
export class SubagentRegistry {
  private map = new Map<string, RegisteredSubagent>();
  /** 变更监听（UI 实时刷新用；可选） */
  onChange?: () => void;
  /** 结束持久化回调（ensureRegistry 按 runOpts.sessionPath 注入；追加会话 JSONL `t:"sub"` 行） */
  persist?: (rec: SubagentRecord) => void;

  register(entry: RegisteredSubagent): void {
    this.map.set(entry.record.id, entry);
    this.onChange?.();
  }

  get(id: string): RegisteredSubagent | undefined {
    return this.map.get(id);
  }

  /** 全部记录（按开始时间升序——展示与嵌套树构造都按时间） */
  records(): SubagentRecord[] {
    return [...this.map.values()].map((e) => e.record).sort((a, b) => a.startedAt - b.startedAt);
  }

  /** 运行中的记录 */
  running(): SubagentRecord[] {
    return this.records().filter((r) => r.status === 'running');
  }

  /** 记录数 */
  get size(): number {
    return this.map.size;
  }

  /** 通知变更（runSubagent 更新记录后调用，让面板在我们不主动重绘时也能刷新） */
  touch(): void {
    this.onChange?.();
  }

  /** 一条子代理结束（完成/失败/停止）：持久化 + 通知 UI。 */
  recordDone(rec: SubagentRecord): void {
    this.persist?.(rec);
    this.onChange?.();
  }

  /**
   * 回灌持久化记录（会话恢复后用；只读视图——无 resume 闭包 → 不可续跑）。
   * 入参为会话 JSONL 反序列化结果（弱类型边界）；只补内存里还没有的 id（本会话新跑的优先）。
   */
  hydrate(recs: Array<Record<string, any>>): void {
    for (const r of recs) {
      if (this.map.has(r.id)) continue;
      const record: SubagentRecord = {
        id: r.id,
        parentId: r.parentId ?? null,
        depth: r.depth ?? 0,
        name: r.name ?? 'delegate',
        ...(r.agent ? { agent: r.agent } : {}),
        ...(r.model ? { model: r.model } : {}),
        ...(r.effort ? { effort: r.effort } : {}),
        task: r.task ?? '',
        status: r.status ?? 'ok',
        steps: r.steps ?? 0,
        maxSteps: r.maxSteps ?? 0,
        startedAt: r.startedAt ?? Date.now(),
        ...(r.endedAt ? { endedAt: r.endedAt } : {}),
        seq: r.seq ?? null,
        ...(r.cwd ? { cwd: r.cwd } : {}),
        ...(r.worktreeBranch ? { worktreeBranch: r.worktreeBranch } : {}),
        transcript: [],
        items: r.items ?? [],
        dropped: r.dropped ?? 0,
        ...(r.result ? { result: r.result } : {}),
        ...(r.resumed ? { resumed: true } : {}),
      };
      this.map.set(record.id, { record });
    }
    this.onChange?.();
  }

  /**
   * 续跑一个已完成的子代理线程：带原 transcript + 一条追问继续跑。
   * 无 resume 闭包（旧记录/已清理）时返回 null 由调用方提示。
   */
  async resume(id: string, followUp: string): Promise<string | null> {
    const entry = this.map.get(id);
    if (!entry?.resume) return null;
    return entry.resume(followUp);
  }

  /** 停止一个运行中的子代理（优先 stop 闭包，其次 record.controller.abort） */
  stop(id: string): boolean {
    const entry = this.map.get(id);
    if (!entry || entry.record.status !== 'running') return false;
    if (entry.stop) {
      entry.stop();
      return true;
    }
    if (entry.record.controller) {
      entry.record.controller.abort();
      return true;
    }
    return false;
  }

  /** 清空（/new 新会话时重置，旧记录不跨会话） */
  clear(): void {
    this.map.clear();
    this.onChange?.();
  }
}

/** 确保 runOpts.subagentRegistry 存在并返回（主循环/工具/UI 共用同一实例） */
export function ensureRegistry(
  runOpts: { subagentRegistry?: SubagentRegistry; sessionPath?: string } | undefined
): SubagentRegistry {
  if (!runOpts) return new SubagentRegistry();
  if (!runOpts.subagentRegistry) {
    const reg = new SubagentRegistry();
    // 会话落盘：子代理结束时追加 `{"t":"sub"}` 行（fire-and-forget；失败静默）
    if (runOpts.sessionPath) {
      const file = runOpts.sessionPath;
      reg.persist = (rec) => {
        void import('./session.js')
          .then(({ appendSubagentRecord }) => appendSubagentRecord(file, rec))
          .catch(() => {});
      };
    }
    runOpts.subagentRegistry = reg;
  }
  return runOpts.subagentRegistry;
}

/**
 * 从会话文件回灌持久化的子代理记录（/tasks 打开时调用；本会话已跑过则不覆盖）。
 * 恢复会话后任务中心仍可查看历史子代理（只读——无运行上下文故不可续跑）。
 */
export async function hydrateRegistryFromSession(
  runOpts: { subagentRegistry?: SubagentRegistry; sessionPath?: string } | undefined
): Promise<void> {
  if (!runOpts?.sessionPath) return;
  const reg = ensureRegistry(runOpts);
  if (reg.size > 0) return; // 本会话已有内存记录 → 不回灌
  try {
    const { loadSubagentRecords } = await import('./session.js');
    const recs = await loadSubagentRecords(runOpts.sessionPath);
    if (recs.length > 0) reg.hydrate(recs);
  } catch {
    // 静默（历史降级）
  }
}

/** 状态展示图标 */
export function subagentStatusIcon(status: SubagentStatus): string {
  switch (status) {
    case 'running':
      return '⠋';
    case 'ok':
      return '✓';
    case 'err':
      return '✗';
    case 'stopped':
      return '⏹';
  }
}

/** 状态展示文案（中/英由调用方选择；此处中文） */
export function subagentStatusLabel(status: SubagentStatus): string {
  switch (status) {
    case 'running':
      return '运行中';
    case 'ok':
      return '完成';
    case 'err':
      return '失败';
    case 'stopped':
      return '已停止';
  }
}

/** 秒级耗时（一位小数；未结束用当前时间） */
export function subagentDuration(rec: SubagentRecord): string {
  const end = rec.endedAt ?? Date.now();
  return `${((end - rec.startedAt) / 1000).toFixed(1)}s`;
}

/**
 * 任务中心行（三端共用文案）：`⠋ 名 · model · effort · 3/10 · 12.3s`。
 * model/effort 缺省不带该段（对标 Claude Code /tasks 的模型标注）。
 */
export function formatSubagentLine(rec: SubagentRecord, opts: { indent?: number } = {}): string {
  const indent = '  '.repeat(opts.indent ?? rec.depth);
  const icon = subagentStatusIcon(rec.status);
  const model = rec.model ? ` · ${rec.model}` : '';
  const effort = rec.effort && rec.effort !== 'none' && rec.effort !== 'auto' ? ` · ${rec.effort}` : '';
  const steps =
    rec.status === 'running' ? ` · ${rec.steps}/${rec.maxSteps}` : rec.steps > 0 ? ` · ${rec.steps} 步` : '';
  const dur = ` · ${subagentDuration(rec)}`;
  const wt = rec.worktreeBranch ? ` · wt:${rec.worktreeBranch}` : '';
  return `${indent}${icon} ${rec.name}${model}${effort}${steps}${dur}${wt}`;
}

/** 明细事件 → 钻取条目（runSubagent 内部维护 items 时共用） */
export function detailItemFromEvent(ev: SubagentEvent): SubagentDetailItem | null {
  if (ev.type === 'think' && ev.text) return { kind: 'think', text: ev.text };
  if (ev.type === 'toolStart' && ev.text) return { kind: 'tool', text: ev.argsPreview || ev.text, name: ev.text };
  if (ev.type === 'toolEnd' && ev.text) {
    return { kind: 'tool', text: (ev.outputPreview ?? []).join('\n'), name: ev.text, ok: ev.toolOk !== false };
  }
  return null;
}

/**
 * Team 协作原语（2026-09 DYN：agent teams 完整版基础）：
 *  · 共享任务列表（TeamBoard.tasks）——主代理与所有子代理共用同一看板；
 *  · SendMessage（TeamBoard.messages）——子代理 ↔ 主代理消息队列，运行中投递；
 *  · 动态工作流计划解析（parseWorkflowPlan）——模型产出结构化计划、引擎按依赖执行。
 *
 * 存储：挂在 runOpts.team 上的进程内对象（会话级），不落盘（计划与消息是运行态）。
 */
import type { RunOptions } from './types.js';

export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface TeamTask {
  id: string;
  title: string;
  status: TeamTaskStatus;
  owner?: string;
  note?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TeamMessage {
  id: number;
  from: string;
  to: string; // 'main' 或 agent id
  text: string;
  time: number;
  /** 已投递（避免重复注入） */
  delivered?: boolean;
}

export class TeamBoard {
  tasks: TeamTask[] = [];
  messages: TeamMessage[] = [];
  private seq = 0;
  private taskSeq = 0;
  /** 变更监听（UI 实时刷新用；可选） */
  onChange?: () => void;

  addTask(title: string, note?: string): TeamTask {
    const t: TeamTask = {
      id: `t${++this.taskSeq}`,
      title: title.trim().slice(0, 200),
      status: 'pending',
      ...(note ? { note: note.slice(0, 500) } : {}),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.tasks.push(t);
    this.onChange?.();
    return t;
  }

  findTask(idOrTitle: string): TeamTask | undefined {
    const key = idOrTitle.trim();
    return this.tasks.find((t) => t.id === key) ?? this.tasks.find((t) => t.title === key);
  }

  updateTask(idOrTitle: string, patch: Partial<Pick<TeamTask, 'status' | 'owner' | 'note' | 'title'>>): TeamTask | null {
    const t = this.findTask(idOrTitle);
    if (!t) return null;
    if (patch.status) t.status = patch.status;
    if (patch.owner !== undefined) t.owner = patch.owner;
    if (patch.note !== undefined) t.note = patch.note.slice(0, 500);
    if (patch.title) t.title = patch.title.slice(0, 200);
    t.updatedAt = Date.now();
    this.onChange?.();
    return t;
  }

  send(from: string, to: string, text: string): TeamMessage {
    const m: TeamMessage = { id: ++this.seq, from, to: to.trim() || 'main', text: text.slice(0, 4000), time: Date.now() };
    this.messages.push(m);
    if (this.messages.length > 500) this.messages.splice(0, this.messages.length - 500);
    this.onChange?.();
    return m;
  }

  /** 取走发给 to 的未投递消息（投递后标记，防重复注入） */
  takeMessages(to: string): TeamMessage[] {
    const out = this.messages.filter((m) => !m.delivered && (m.to === to || m.to === '*'));
    for (const m of out) m.delivered = true;
    return out;
  }

  /** 未投递消息数（等待主循环/子代理 drain） */
  pendingCount(to: string): number {
    return this.messages.filter((m) => !m.delivered && (m.to === to || m.to === '*')).length;
  }

  summaryLines(): string[] {
    const lines: string[] = [];
    const icon = (s: TeamTaskStatus): string => (s === 'completed' ? '✓' : s === 'failed' ? '✗' : s === 'in_progress' ? '▸' : '·');
    for (const t of this.tasks) {
      lines.push(`${icon(t.status)} [${t.id}] ${t.title}${t.owner ? ` · @${t.owner}` : ''}${t.note ? ` · ${t.note.split('\n')[0]}` : ''}`);
    }
    return lines;
  }
}

/** 确保 runOpts.team 存在并返回（主循环与工具共用同一实例） */
export function ensureTeam(runOpts: RunOptions | undefined): TeamBoard {
  if (!runOpts) return new TeamBoard();
  if (!runOpts.team) runOpts.team = new TeamBoard();
  return runOpts.team;
}

/* ---------------- 动态工作流计划（模型产出 → 引擎执行） ---------------- */

export interface WorkflowStep {
  /** 步骤标题（短，用于任务板与日志） */
  title: string;
  /** 完整任务描述（发给 worker 子代理） */
  task: string;
  /** 依赖的前序步骤下标（0-based；等待其完成后结果注入本步 prompt） */
  dependsOn?: number[];
  /** 可选：指定子代理定义名 */
  agent?: string;
}

/**
 * 解析模型产出的工作流计划（纯函数，容错：围栏/散文包裹的 JSON 对象）：
 * `{ steps: [{ title, task, dependsOn?, agent? }] }`；非法/空返回 null（调用方回退固定 pipeline）。
 * 清洗规则：最多 12 步；任务文本非空；依赖必须是更小下标（防环）。
 */
export function parseWorkflowPlan(text: string): WorkflowStep[] | null {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const rawSteps = (obj as { steps?: unknown }).steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) return null;
  const steps: WorkflowStep[] = [];
  for (const raw of rawSteps.slice(0, 12)) {
    const o = raw as { title?: unknown; task?: unknown; dependsOn?: unknown; agent?: unknown };
    const title = typeof o?.title === 'string' ? o.title.trim() : '';
    const task = typeof o?.task === 'string' ? o.task.trim() : '';
    if (!task) continue;
    const idx = steps.length;
    const deps = Array.isArray(o.dependsOn)
      ? [...new Set(o.dependsOn.filter((x): x is number => Number.isInteger(x) && x >= 0 && x < idx))]
      : [];
    steps.push({
      title: title || `步骤 ${idx + 1}`,
      task,
      ...(deps.length > 0 ? { dependsOn: deps } : {}),
      ...(typeof o.agent === 'string' && o.agent.trim() ? { agent: o.agent.trim() } : {}),
    });
  }
  return steps.length > 0 ? steps : null;
}

/** 按依赖把步骤分层（同层可并行；依赖保证在同层之前）。返回执行批次下标数组 */
export function planBatches(steps: WorkflowStep[]): number[][] {
  const done = new Set<number>();
  const batches: number[][] = [];
  let guard = 0;
  while (done.size < steps.length && guard++ < steps.length + 1) {
    const batch: number[] = [];
    for (let i = 0; i < steps.length; i++) {
      if (done.has(i)) continue;
      const deps = steps[i].dependsOn ?? [];
      if (deps.every((d) => done.has(d))) batch.push(i);
    }
    if (batch.length === 0) break; // 环（解析已防；保险）
    for (const i of batch) done.add(i);
    batches.push(batch);
  }
  return batches;
}

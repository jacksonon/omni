/** 宠物只是运行事件的有界投影；不保存工具参数、正文或思考内容。 */
export type PetPhase = 'idle' | 'thinking' | 'working' | 'answering' | 'needs-input' | 'ready' | 'blocked';
export interface PetTask {
  sessionId: string;
  title: string;
  phase: PetPhase;
  running: boolean;
  unread: boolean;
  pending: number;
  updatedAt: number;
  revision: number;
  source?: 'shared' | 'local';
  cwd?: string;
  url?: string;
}
interface Entry extends PetTask {
  stage: PetPhase;
  tools: Set<string>;
  interactions: Set<string>;
}
const PRIORITY: Record<PetPhase, number> = { 'needs-input': 6, blocked: 5, ready: 4, working: 3, answering: 3, thinking: 3, idle: 0 };
export function selectPetTask(tasks: PetTask[], sessionId?: string): PetTask | undefined {
  if (sessionId) return tasks.find(t => t.sessionId === sessionId);
  return [...tasks].sort((a, b) => (b.unread || b.running || b.pending ? PRIORITY[b.phase] : 0)
    - (a.unread || a.running || a.pending ? PRIORITY[a.phase] : 0) || b.updatedAt - a.updatedAt)[0];
}
export class PetState {
  private entries = new Map<string, Entry>();
  apply(type: string, data: Record<string, unknown>, now = Date.now()): boolean {
    const id = typeof data.sessionId === 'string' ? data.sessionId : '';
    if (!id) return false;
    if (type === 'session.deleted') return this.entries.delete(id);
    const recognized = ['user.message', 'turn.step', 'tool.start', 'tool.result', 'answer.chunk', 'run.end',
      'approval.request', 'approval.resolved', 'ask.request', 'ask.resolved', 'title'];
    if (!recognized.includes(type)) return false;
    let e = this.entries.get(id);
    if (!e) {
      e = { sessionId: id, title: 'Omni 任务', phase: 'idle', stage: 'idle', running: false, unread: false,
        pending: 0, updatedAt: now, revision: 0, tools: new Set(), interactions: new Set() };
      this.entries.set(id, e);
    }
    const before = JSON.stringify(this.task(e));
    if (type === 'user.message') {
      e.title = String(data.text ?? '').split('\n')[0]!.trim().slice(0, 100) || e.title;
      e.tools.clear(); e.interactions.clear(); e.unread = false; e.running = true; e.stage = 'thinking';
    } else if (type === 'turn.step') {
      if (!e.running) { e.tools.clear(); e.interactions.clear(); }
      e.running = true; e.unread = false; e.stage = 'thinking';
    } else if (type === 'tool.start') {
      e.running = true; e.tools.add(String(data.seq ?? 0)); e.stage = 'working';
    } else if (type === 'tool.result') {
      e.tools.delete(String(data.seq ?? 0));
      if (!e.tools.size && e.stage === 'working') e.stage = 'thinking';
    } else if (type === 'answer.chunk') {
      e.running = true; e.stage = 'answering';
    } else if (type.endsWith('.request')) {
      e.interactions.add(String(data.approvalId ?? data.askId ?? 'unknown'));
    } else if (type.endsWith('.resolved')) {
      e.interactions.delete(String(data.approvalId ?? data.askId ?? 'unknown'));
    } else if (type === 'run.end') {
      e.running = false; e.tools.clear(); e.interactions.clear();
      e.stage = data.reason === 'completed' ? 'ready' : ['error', 'max-steps'].includes(String(data.reason)) ? 'blocked' : 'idle';
      e.unread = e.stage === 'ready' || e.stage === 'blocked';
    } else if (type === 'title') e.title = String(data.title ?? e.title).slice(0, 100);
    e.pending = e.interactions.size;
    e.phase = e.pending ? 'needs-input' : e.tools.size ? 'working' : e.stage;
    const changed = before !== JSON.stringify(this.task(e));
    if (changed) { e.updatedAt = now; e.revision++; }
    // 只丢弃最旧的非运行记录，不淘汰仍在等待审批的任务。
    if (this.entries.size > 200) {
      const old = [...this.entries.values()].filter(t => !t.running && !t.pending).sort((a, b) => a.updatedAt - b.updatedAt);
      for (const task of old) { if (this.entries.size <= 200) break; this.entries.delete(task.sessionId); }
    }
    return changed;
  }
  read(id: string, revision?: number): boolean {
    const e = this.entries.get(id);
    if (!e || !e.unread || (revision !== undefined && revision !== e.revision)) return false;
    e.unread = false; e.revision++; return true;
  }
  snapshot(): PetTask[] { return [...this.entries.values()].map(e => this.task(e)); }
  private task(e: Entry): PetTask {
    const { sessionId, title, phase, running, unread, pending, updatedAt, revision } = e;
    return { sessionId, title, phase, running, unread, pending, updatedAt, revision };
  }
}

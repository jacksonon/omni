/** --local 只报告轻量状态给已有 broker；网络失败不会影响任务或终端输出。 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { readServerRecord } from '../server/discovery.js';
import { redactText } from '../agent/redact.js';
import type { Output } from '../output/types.js';
import type { RunOptions } from '../agent/types.js';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { PetState, type PetTask, type PetPhase } from './state.js';

export interface LocalPetTask extends PetTask { pid: number; resumeId?: string }
export class PresenceStore {
  private entries = new Map<string, { task: LocalPetTask; expires: number }>();
  update(input: Record<string, unknown>, now = Date.now()): void {
    if (typeof input.sessionId !== 'string' || !/^local-[a-f0-9-]{36}$/.test(input.sessionId)
      || !Number.isSafeInteger(input.pid) || Number(input.pid) < 1
      || !['idle', 'thinking', 'working', 'answering', 'needs-input', 'ready', 'blocked'].includes(String(input.phase))
      || !Number.isSafeInteger(input.revision) || Number(input.revision) < 0) throw new Error('独立任务状态无效');
    const previous = this.entries.get(input.sessionId);
    if (previous && previous.task.revision > Number(input.revision)) return;
    const task: LocalPetTask = { sessionId: input.sessionId, pid: Number(input.pid), source: 'local',
      title: redactText(String(input.title || '独立终端任务')).slice(0, 100), cwd: String(input.cwd || ''),
      phase: input.phase as PetPhase, running: input.running === true, unread: input.unread === true,
      pending: Math.min(100, Math.max(0, Number(input.pending) || 0)), updatedAt: now, revision: Number(input.revision),
      ...(typeof input.resumeId === 'string' && /^[a-zA-Z0-9_-]+$/.test(input.resumeId) ? { resumeId: input.resumeId } : {}) };
    // 已读取的同一结束水位不能被重复心跳重新标为未读。
    if (previous?.task.revision === task.revision && !previous.task.unread) task.unread = false;
    this.entries.set(task.sessionId, { task, expires: now + (task.running ? 15_000 : 15 * 60_000) });
    this.snapshot(now);
    while (this.entries.size > 200) this.entries.delete(this.entries.keys().next().value!);
  }
  snapshot(now = Date.now()): LocalPetTask[] {
    for (const [id, e] of this.entries) if (e.expires < now) this.entries.delete(id);
    return [...this.entries.values()].map(e => ({ ...e.task }));
  }
  read(id: string, revision: number): void {
    const entry = this.entries.get(id);
    if (entry?.task.revision === revision) entry.task.unread = false;
  }
}
type Report = (type: string, data?: Record<string, unknown>) => void;
const reports = new AsyncLocalStorage<Report>();
export async function withPetInteraction<T>(kind: 'approval' | 'ask', action: () => T | Promise<T>): Promise<T> {
  const report = reports.getStore(), id = randomUUID();
  report?.(`${kind}.request`, { [kind === 'ask' ? 'askId' : 'approvalId']: id });
  try { return await action(); }
  finally { report?.(`${kind}.resolved`, { [kind === 'ask' ? 'askId' : 'approvalId']: id }); }
}
export async function withLocalPet<T>(opts: RunOptions, output: Output, messages: ChatCompletionMessageParam[], action: (out: Output) => Promise<T>): Promise<T> {
  if (process.env.OMNI_INTERNAL_WORKER === '1' || process.env.OMNI_PET === 'off' || output.petStateManaged || reports.getStore()) return action(output);
  const record = readServerRecord();
  if (!record) return action(output);
  const id = `local-${randomUUID()}`, state = new PetState();
  const initialEventCount = opts.events?.events.length ?? 0;
  const user = [...messages].reverse().find(m => m.role === 'user');
  const title = redactText(typeof user?.content === 'string' ? user.content : '独立终端任务').slice(0, 100);
  state.apply('user.message', { sessionId: id, text: title });
  let pending: LocalPetTask | undefined, sending: Promise<void> | undefined, failed = false;
  const resumeId = opts.sessionPath?.split(/[\\/]/).pop()?.replace(/\.jsonl$/, '');
  function flush(): Promise<void> {
    if (sending) return sending;
    sending = (async () => {
      while (pending) {
        const task = pending; pending = undefined;
        try {
          await fetch(`http://127.0.0.1:${record!.port}/_omni/pet/presence`, { method: 'POST',
            headers: { authorization: `Bearer ${record!.token}`, 'content-type': 'application/json' },
            body: JSON.stringify(task), signal: AbortSignal.timeout(400) });
        } catch { /* 状态广播尽力而为。 */ }
      }
    })().finally(() => { sending = undefined; });
    return sending;
  }
  const send = () => {
    const task = state.snapshot()[0];
    if (task) { pending = { ...task, pid: process.pid, cwd: process.cwd(), source: 'local', ...(resumeId ? { resumeId } : {}) }; void flush(); }
  };
  const report: Report = (type, data = {}) => { if (state.apply(type, { ...data, sessionId: id })) send(); };
  send(); const heartbeat = setInterval(send, 5000); heartbeat.unref();
  const proxy = new Proxy(output, { get(target, key) {
    const fn = Reflect.get(target, key);
    if (typeof fn !== 'function') return fn;
    return (...args: any[]) => {
      if (key === 'onRound') report('turn.step');
      if (key === 'onAnswer') report('answer.chunk');
      if (key === 'onToolStep') report('tool.start', { seq: args[5] });
      if (key === 'onToolResult') report('tool.result', { seq: args[4] });
      if (key === 'onRequestFailed') failed = true;
      return fn.apply(target, args);
    };
  } });
  try { return await reports.run(report, () => action(proxy)); }
  catch (error) { failed = true; throw error; }
  finally {
    clearInterval(heartbeat);
    const end = (opts.events?.events ?? []).slice(initialEventCount).reverse().find(e => e.k === 'turn/end');
    report('run.end', { reason: end?.k === 'turn/end' ? end.reason : opts.abortSignal?.aborted ? 'aborted' : failed ? 'error' : 'completed' });
    await flush();
  }
}

import { createHash } from 'node:crypto';

/** 相同请求即使在上一次 HTTP 响应丢失后重试，也只执行一次。运行中的槽不驱逐。 */
export class RequestLedger<T> {
  private entries = new Map<string, { hash: string; at: number; done: boolean; value: Promise<T> }>();
  constructor(private readonly limit = 2048, private readonly ttlMs = 24 * 60 * 60 * 1000) {}

  run(key: string, body: unknown, action: () => Promise<T>): Promise<T> {
    const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const now = Date.now();
    for (const [id, e] of this.entries) if (e.done && now - e.at > this.ttlMs) this.entries.delete(id);
    const old = this.entries.get(key);
    if (old) {
      if (old.hash !== hash) return Promise.reject(new Error('requestId 已被另一条不同消息使用'));
      return old.value;
    }
    if (this.entries.size >= this.limit) {
      const oldestDone = [...this.entries].find(([, e]) => e.done);
      if (oldestDone) this.entries.delete(oldestDone[0]);
      else return Promise.reject(new Error('请求过多，请稍后重试'));
    }
    const entry = { hash, at: now, done: false, value: Promise.resolve().then(action) };
    this.entries.set(key, entry);
    void entry.value.then(() => { entry.done = true; }, () => { this.entries.delete(key); });
    return entry.value;
  }
}

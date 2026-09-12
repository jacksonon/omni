/**
 * 子代理并发信号量（2026-09 DYN：并发预算治理）。
 *
 * delegate 子代理（前台 + 后台）共享一个信号量：超过上限时排队等待而不是失败，
 * 避免一次 fan-out 把网关打爆。主循环每回合从 runOpts.subagentSemaphore 取用。
 */
export class SubagentSemaphore {
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(public readonly limit: number) {}

  get activeCount(): number {
    return this.active;
  }

  get waitingCount(): number {
    return this.waiters.length;
  }

  /** 获取一个槽位；返回释放函数（幂等） */
  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
    } else {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
      // 被唤醒时槽位已由 release 转移给当前等待者（active 不变）
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        // 直接把槽位让给下一个等待者（active 保持）
        next();
      } else {
        this.active = Math.max(0, this.active - 1);
      }
    };
  }
}

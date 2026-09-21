/**
 * Serializes persistence work in FIFO order.
 *
 * Callers must capture an immutable save payload before calling `enqueue`.
 * The queue intentionally receives only a task, so it cannot protect a task
 * that closes over state which is later mutated by the UI.
 */
export class SaveQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private latestFailure: unknown;
  private hasFailure = false;
  private idleWaiters: Array<{ resolve: () => void; reject: (reason: unknown) => void }> = [];

  enqueue(task: () => Promise<void>): Promise<void> {
    this.pending += 1;

    let resolveCaller!: () => void;
    let rejectCaller!: (reason: unknown) => void;
    const callerResult = new Promise<void>((resolve, reject) => {
      resolveCaller = resolve;
      rejectCaller = reject;
    });

    const run = async () => {
      try {
        await task();
        resolveCaller();
      } catch (error) {
        this.latestFailure = error;
        this.hasFailure = true;
        rejectCaller(error);
      } finally {
        this.pending -= 1;
        this.resolveIdleWaiters();
      }
    };

    // `run` catches task failures, so the internal tail always settles fulfilled.
    this.tail = this.tail.then(run, run);
    return callerResult;
  }

  idle(): Promise<void> {
    if (this.pending === 0) {
      return this.consumeIdleResult();
    }

    return new Promise<void>((resolve, reject) => {
      this.idleWaiters.push({ resolve, reject });
    });
  }

  private resolveIdleWaiters(): void {
    if (this.pending !== 0 || this.idleWaiters.length === 0) {
      return;
    }

    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    const failure = this.consumeFailure();
    for (const waiter of waiters) {
      if (failure.hasFailure) {
        waiter.reject(failure.reason);
      } else {
        waiter.resolve();
      }
    }
  }

  private consumeIdleResult(): Promise<void> {
    const failure = this.consumeFailure();
    return failure.hasFailure ? Promise.reject(failure.reason) : Promise.resolve();
  }

  private consumeFailure(): { hasFailure: boolean; reason: unknown } {
    const failure = { hasFailure: this.hasFailure, reason: this.latestFailure };
    this.hasFailure = false;
    this.latestFailure = undefined;
    return failure;
  }
}

import { describe, expect, it } from "vitest";
import { SaveQueue } from "./persistence";

type Deferred<T = void> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T = void>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const flushTasks = () => new Promise<void>(resolve => queueMicrotask(resolve));

describe("SaveQueue", () => {
  it("runs saves in FIFO order even when the backend would finish B before A", async () => {
    const queue = new SaveQueue();
    const firstBackendCall = deferred();
    const secondBackendCall = deferred();
    const started: string[] = [];
    const completed: string[] = [];

    const first = queue.enqueue(async () => {
      started.push("A");
      await firstBackendCall.promise;
      completed.push("A");
    });
    const second = queue.enqueue(async () => {
      started.push("B");
      await secondBackendCall.promise;
      completed.push("B");
    });

    await flushTasks();
    expect(started).toEqual(["A"]);
    expect(completed).toEqual([]);

    // B's response is ready first, but its request cannot start until A settles.
    secondBackendCall.resolve();
    await flushTasks();
    expect(started).toEqual(["A"]);

    firstBackendCall.resolve();
    await first;
    await flushTasks();
    expect(started).toEqual(["A", "B"]);
    expect(completed).toEqual(["A"]);

    await expect(second).resolves.toBeUndefined();
    expect(completed).toEqual(["A", "B"]);
    await expect(queue.idle()).resolves.toBeUndefined();
  });

  it("requires callers to capture snapshots before enqueueing", async () => {
    const queue = new SaveQueue();
    const releaseFirstSave = deferred();
    const persisted: Array<{ text: string }> = [];
    const editorState = { text: "A" };

    const snapshotA = structuredClone(editorState);
    const first = queue.enqueue(async () => {
      await releaseFirstSave.promise;
      persisted.push(snapshotA);
    });

    editorState.text = "B";
    const snapshotB = structuredClone(editorState);
    const second = queue.enqueue(async () => {
      persisted.push(snapshotB);
    });
    editorState.text = "C";

    releaseFirstSave.resolve();
    await Promise.all([first, second]);
    expect(persisted).toEqual([{ text: "A" }, { text: "B" }]);
  });

  it("reports a failed idle cycle and allows a later retry to succeed", async () => {
    const queue = new SaveQueue();
    const saveError = new Error("disk unavailable");
    const releaseFailure = deferred();
    const failedSave = queue.enqueue(async () => {
      await releaseFailure.promise;
      throw saveError;
    });
    const retry = queue.enqueue(async () => undefined);
    const failedIdle = queue.idle();

    releaseFailure.resolve();
    await expect(failedSave).rejects.toBe(saveError);
    await expect(retry).resolves.toBeUndefined();
    await expect(failedIdle).rejects.toBe(saveError);

    await expect(queue.idle()).resolves.toBeUndefined();
  });
});

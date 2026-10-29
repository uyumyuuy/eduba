export function workerRpc(create: () => Worker) {
  let worker: Worker | undefined;
  let next = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  function rejectAll(error: unknown) {
    for (const request of pending.values()) request.reject(error);
    pending.clear(); worker?.terminate(); worker = undefined;
  }
  return <T>(command: string, args: object = {}): Promise<T> => {
    if (!worker) {
      worker = create();
      worker.onmessage = event => {
        const { id, result, error } = event.data;
        const request = pending.get(id);
        if (!request) return;
        pending.delete(id);
        if (error) request.reject(new Error(error)); else request.resolve(result);
      };
      worker.onerror = event => rejectAll(new Error(event.message || "Browser worker failed."));
      worker.onmessageerror = () => rejectAll(new Error("Could not read the browser worker response."));
    }
    const id = ++next;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: value => resolve(value as T), reject });
      try { worker!.postMessage({ id, command, args }); }
      catch (error) { pending.delete(id); reject(error); }
    });
  };
}

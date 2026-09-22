/**
 * Cooperative async mutexes used to serialize engine transitions. They protect
 * in-process critical sections only; durable safety comes from guarded SQL
 * updates inside transactions.
 */
export class AsyncMutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(fn, fn);
    // Keep the chain alive even when a caller rejects.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** True while no caller is queued or running. */
  get idle(): boolean {
    return this.tail === undefined;
  }
}

const MUTEX_SENTINEL = Symbol("keyed-mutex-entry");

export class KeyedMutex {
  private readonly locks = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const current = this.locks.get(key) ?? Promise.resolve(MUTEX_SENTINEL);
    const result = current.then(fn, fn);
    const guarded: Promise<unknown> = result.then(
      () => MUTEX_SENTINEL,
      () => MUTEX_SENTINEL,
    );
    this.locks.set(key, guarded);
    void guarded.then(() => {
      if (this.locks.get(key) === guarded) this.locks.delete(key);
    });
    return result;
  }

  get size(): number {
    return this.locks.size;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error,
): Promise<T> {
  if (ms <= 0 || !Number.isFinite(ms)) return promise;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(onTimeout()), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

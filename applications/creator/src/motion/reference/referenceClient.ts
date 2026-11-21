// The main-thread side of referenceWorker.ts: one worker for the Motion Creator's reference clips, jobs run
// side by side and answered by id, each with progress and a cancel (an AbortSignal). A worker that fails to
// load is dropped and the next job starts a fresh one.

import type { ReferenceJob, ReferenceWorkerIn, ReferenceWorkerOut } from './referenceWorker';

interface Pending { resolve: (r: unknown) => void; reject: (e: Error) => void; progress?: (done: number, total: number) => void; }

export class ReferenceClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  /** Run a job on a clip (`key`: its library id, so the worker reuses the parsed file). */
  run<R>(key: string, blob: Blob, job: ReferenceJob, opts: { signal?: AbortSignal; progress?: (done: number, total: number) => void } = {}): Promise<R> {
    const id = this.nextId++;
    return new Promise<R>((resolve, reject) => {
      if (opts.signal?.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
      this.pending.set(id, { resolve: r => resolve(r as R), reject, progress: opts.progress });
      opts.signal?.addEventListener('abort', () => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        this.worker?.postMessage({ id, job: 'cancel' } satisfies ReferenceWorkerIn);
        reject(new DOMException('Cancelled', 'AbortError'));
      }, { once: true });
      this.ensure().postMessage({ id, key, blob, ...job } as ReferenceWorkerIn);
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p.reject(new DOMException('Cancelled', 'AbortError'));
    this.pending.clear();
  }

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('./referenceWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<ReferenceWorkerOut>) => {
      const m = e.data, p = this.pending.get(m.id);
      if (!p) return;
      if (m.type === 'progress') { p.progress?.(m.done, m.total); return; }
      this.pending.delete(m.id);
      if (m.type === 'result') p.resolve(m.result); else p.reject(new Error(m.error));
    };
    w.onerror = e => {
      w.terminate();
      if (this.worker === w) this.worker = null;
      const err = new Error(e.message || 'The reference worker failed');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
    this.worker = w;
    return w;
  }
}

let shared: ReferenceClient | null = null;
/** The one client the Creator's panels share. */
export const referenceClient = () => (shared ??= new ReferenceClient());

export const isAbort = (e: unknown) => (e as { name?: string })?.name === 'AbortError';

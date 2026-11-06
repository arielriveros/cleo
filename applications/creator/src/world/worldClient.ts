// The main-thread side of worldWorker.ts. Previews are COALESCED: while one runs, a newer request
// replaces any waiting one (whose promise resolves null), so a slider drag queues at most one preview
// behind the running one. Exports run on a second worker, so a long full-resolution export never holds
// the live preview up; cancelling one terminates its worker.

import { GenerationCancelled, type ExportFile, type GenerateContext } from '../core/generator';
import type { WorldOutput } from './generateWorld';
import type { WorldDoc } from './worldDoc';
import type { PreviewResult, WorldWorkerIn, WorldWorkerOut } from './worldWorker';

const spawn = () => new Worker(new URL('./worldWorker.ts', import.meta.url), { type: 'module' });

interface Pending { msg: WorldWorkerIn; resolve: (r: PreviewResult | null) => void; reject: (e: Error) => void; onProgress?: (f: number, label: string) => void }

export class WorldClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private running: Pending | null = null;
  private waiting: Pending | null = null;

  /** The preview of `doc`; resolves null if a newer request superseded this one before it started. */
  preview(doc: WorldDoc, resolution: number, maskResolution: number, onProgress?: (f: number, label: string) => void): Promise<PreviewResult | null> {
    return new Promise((resolve, reject) => {
      const req: Pending = { msg: { kind: 'preview', id: this.nextId++, doc, resolution, maskResolution }, resolve, reject, onProgress };
      this.waiting?.resolve(null);
      this.waiting = req;
      this.pump();
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.running?.resolve(null);
    this.waiting?.resolve(null);
    this.running = this.waiting = null;
  }

  private pump(): void {
    if (this.running || !this.waiting) return;
    if (!this.worker) {
      this.worker = spawn();
      this.worker.onmessage = (e: MessageEvent<WorldWorkerOut>) => this.onMessage(e.data);
      this.worker.onerror = e => {
        const req = this.running;
        this.running = null;
        this.worker?.terminate();
        this.worker = null;
        req?.reject(new Error(e.message || 'The world worker failed'));
        this.pump();
      };
    }
    this.running = this.waiting;
    this.waiting = null;
    this.worker.postMessage(this.running!.msg);
  }

  private onMessage(out: WorldWorkerOut): void {
    const req = this.running;
    if (!req || req.msg.id !== out.id) return;
    if (out.kind === 'progress') { req.onProgress?.(out.fraction, out.label); return; }
    this.running = null;
    if (out.kind === 'preview') req.resolve(out.result);
    else if (out.kind === 'error') req.reject(new Error(out.error));
    this.pump();
  }
}

/**
 * Every export file for `doc` at full resolution, built on a worker of its own. `terrain` skips the
 * terrain stage (the main thread ran it with GPU erosion). Throws GenerationCancelled when `ctx` is.
 */
export function exportOnWorker(doc: WorldDoc, name: string, ctx: GenerateContext, terrain?: WorldOutput): Promise<{ files: ExportFile[]; pipeBackend: WorldOutput['pipeBackend'] }> {
  return new Promise((resolve, reject) => {
    const worker = spawn();
    const id = 1;
    const poll = setInterval(() => {
      if (!ctx.cancelled) return;
      clearInterval(poll);
      worker.terminate();
      reject(new GenerationCancelled());
    }, 100);
    const done = () => { clearInterval(poll); worker.terminate(); };
    worker.onmessage = (e: MessageEvent<WorldWorkerOut>) => {
      const out = e.data;
      if (out.kind === 'progress') { ctx.progress(out.fraction, out.label); return; }
      done();
      if (out.kind === 'export') resolve({ files: out.files, pipeBackend: terrain?.pipeBackend ?? out.pipeBackend });
      else if (out.kind === 'error') reject(new Error(out.error));
    };
    worker.onerror = e => { done(); reject(new Error(e.message || 'The world export worker failed')); };
    const msg: WorldWorkerIn = { kind: 'export', id, doc, name, terrain };
    worker.postMessage(msg);
  });
}

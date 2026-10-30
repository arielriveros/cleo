// The main-thread side of foliageWorker.ts. Builds are COALESCED: while one runs, a newer request
// replaces any waiting one (whose promise resolves null), so a slider drag queues at most one build
// behind the running one instead of one per pixel it passes.

import type { FoliageFiles, FoliageSummary, ImpostorBake, Overrides } from './buildFoliage';
import type { FoliageDoc } from './foliageParams';
import type { FoliageWorkerIn, FoliageWorkerOut } from './foliageWorker';

export interface FoliageBuild { summary: FoliageSummary; files: FoliageFiles; impostor: ImpostorBake | null; ms: number }

interface Request { msg: FoliageWorkerIn; resolve: (b: FoliageBuild | null) => void; reject: (e: Error) => void }

export class FoliageClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private running: Request | null = null;
  private waiting: Request | null = null;

  /** Build `doc`; resolves null if a newer request superseded this one before it started. */
  build(doc: FoliageDoc, overrides: Overrides, impostor = false): Promise<FoliageBuild | null> {
    return new Promise((resolve, reject) => {
      const req: Request = { msg: { id: this.nextId++, doc, overrides, impostor }, resolve, reject };
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
      this.worker = new Worker(new URL('./foliageWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<FoliageWorkerOut>) => this.onResult(e.data);
      this.worker.onerror = e => {
        const req = this.running;
        this.running = null;
        // A worker that failed to load is gone for good; the next build makes a fresh one.
        this.worker?.terminate();
        this.worker = null;
        req?.reject(new Error(e.message || 'The foliage worker failed'));
        this.pump();
      };
    }
    this.running = this.waiting;
    this.waiting = null;
    this.worker.postMessage(this.running!.msg);
  }

  private onResult(out: FoliageWorkerOut): void {
    const req = this.running;
    this.running = null;
    if (req && req.msg.id === out.id) {
      if (out.ok) req.resolve({ summary: out.summary, files: out.files, impostor: out.impostor, ms: out.ms });
      else req.reject(new Error(out.error));
    }
    this.pump();
  }
}

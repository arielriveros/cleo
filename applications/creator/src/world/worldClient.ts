// The main-thread side of worldWorker.ts. Requests are COALESCED per kind: while one runs, a newer
// request of a kind replaces any waiting one of that kind (whose promise resolves null), so a slider drag
// queues at most one of each kind (preview, sources, heights) behind the running one. All kinds share the worker,
// and with it the graph's node cache. Exports run on a worker of their own, so a long full-resolution
// export never holds the live preview up; cancelling one terminates its worker.

import { GenerationCancelled, type ExportFile, type GenerateContext } from '../core/generator';
import type { WorldOutput } from './generateWorld';
import type { Field, PortRef } from './graph/graphDoc';
import type { PaintPixels } from './paint';
import type { WorldDoc } from './worldDoc';
import type { PreviewResult, WorldWorkerIn, WorldWorkerOut } from './worldWorker';

const spawn = () => new Worker(new URL('./worldWorker.ts', import.meta.url), { type: 'module' });

type Kind = 'preview' | 'sources' | 'heights';
interface Pending {
  kind: Kind;
  msg: WorldWorkerIn;
  resolve: (r: unknown) => void;
  reject: (e: Error) => void;
  onProgress?: (f: number, label: string) => void;
}

export class WorldClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private running: Pending | null = null;
  private waiting: Partial<Record<Kind, Pending>> = {};

  /** The preview of `doc`; resolves null if a newer request superseded this one before it started. */
  preview(doc: WorldDoc, paint: PaintPixels, resolution: number, maskResolution: number, onProgress?: (f: number, label: string) => void): Promise<PreviewResult | null> {
    return this.request('preview', { kind: 'preview', id: this.nextId++, doc, paint, resolution, maskResolution }, onProgress) as Promise<PreviewResult | null>;
  }

  /** The outputs `ports` read at `resolution` (keyed `node:port`); null if superseded. */
  sources(doc: WorldDoc, paint: PaintPixels, resolution: number, ports: PortRef[]): Promise<Record<string, Field> | null> {
    return this.request('sources', { kind: 'sources', id: this.nextId++, doc, paint, resolution, ports }) as Promise<Record<string, Field> | null>;
  }

  /** Just the Output's heights at `resolution`, with `bypass` nodes off; null if superseded. */
  heights(doc: WorldDoc, paint: PaintPixels, resolution: number, bypass: string[]): Promise<Float32Array | null> {
    return this.request('heights', { kind: 'heights', id: this.nextId++, doc, paint, resolution, bypass }) as Promise<Float32Array | null>;
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.running?.resolve(null);
    for (const w of Object.values(this.waiting)) w?.resolve(null);
    this.running = null;
    this.waiting = {};
  }

  private request(kind: Kind, msg: WorldWorkerIn, onProgress?: (f: number, label: string) => void): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.waiting[kind]?.resolve(null);
      this.waiting[kind] = { kind, msg, resolve, reject, onProgress };
      this.pump();
    });
  }

  private pump(): void {
    if (this.running) return;
    // Sources first: a realtime drag is waiting on them, and they are usually cache hits.
    const next = this.waiting.sources ?? this.waiting.heights ?? this.waiting.preview;
    if (!next) return;
    delete this.waiting[next.kind];
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
    this.running = next;
    this.worker.postMessage(next.msg);
  }

  private onMessage(out: WorldWorkerOut): void {
    const req = this.running;
    if (!req || req.msg.id !== out.id) return;
    if (out.kind === 'progress') { req.onProgress?.(out.fraction, out.label); return; }
    this.running = null;
    if (out.kind === 'preview') req.resolve(out.result);
    else if (out.kind === 'sources') req.resolve(out.fields);
    else if (out.kind === 'heights') req.resolve(out.heights);
    else if (out.kind === 'error') req.reject(new Error(out.error));
    this.pump();
  }
}

/**
 * Every export file for `doc` at full resolution, built on a worker of its own. `terrain` skips the
 * terrain stage (the main thread ran it with GPU erosion). Throws GenerationCancelled when `ctx` is.
 */
export function exportOnWorker(doc: WorldDoc, paint: PaintPixels, name: string, ctx: GenerateContext, terrain?: WorldOutput): Promise<{ files: ExportFile[]; pipeBackend: WorldOutput['pipeBackend'] }> {
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
    const msg: WorldWorkerIn = { kind: 'export', id, doc, paint, name, terrain };
    worker.postMessage(msg);
  });
}

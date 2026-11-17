// The World's realtime preview: while one node is being edited, the landscape follows every frame rather
// than waiting for the debounced preview. With GPU compute the edited node and what it feeds run as
// kernels (graph/gpuExecutor.ts) from upstream outputs the worker sends once per drag; without it the
// worker re-evaluates just the heights at a low resolution (its node cache keeps the upstream free).
// Either way the settled preview -- full resolution, fields, surfaces, water -- replaces it when the edit
// pauses. One frame is in flight at a time; a newer edit replaces a waiting one.

import { RealtimeGpu, gpuRealtimeAvailable } from '../graph/gpuExecutor';
import { planRealtime, type RealtimePlan } from '../graph/realtime';
import type { PaintPixels } from '../paint';
import type { WorldClient } from '../worldClient';
import type { WorldDoc } from '../worldDoc';

/** Realtime grids: the GPU runs at the draft preview's 257², the CPU fallback at 129². */
export const REALTIME_RES_GPU = 257;
export const REALTIME_RES_CPU = 129;

export interface RealtimeState {
  /** A realtime edit is showing (until the settled preview lands). */
  active: boolean;
  backend: 'gpu' | 'cpu' | null;
  /** Nodes skipped until the preview settles (simulations, landforms after the edit). */
  bypassed: string[];
  /** Milliseconds the last frame took. */
  ms: number;
}

interface Request { doc: WorldDoc; paint: PaintPixels; plan: RealtimePlan; res: number; gen: number }

export class RealtimePreview {
  private gpu: RealtimeGpu | null = gpuRealtimeAvailable() ? new RealtimeGpu() : null;
  private busy = false;
  private next: Request | null = null;
  private gen = 0;
  private planKey = '';
  private failed = false;

  constructor(private client: WorldClient,
              private show: (heights: Float32Array, resolution: number, doc: WorldDoc) => void,
              private onState: (s: RealtimeState) => void) {}

  get backend(): 'gpu' | 'cpu' { return this.gpu && !this.failed ? 'gpu' : 'cpu'; }

  /** Show `doc` live, `root` being the node the edit touched. False when that edit cannot run live. */
  edit(doc: WorldDoc, paint: PaintPixels, root: string): boolean {
    const res = Math.min(this.backend === 'gpu' ? REALTIME_RES_GPU : REALTIME_RES_CPU, doc.settings.resolution);
    const frame = { resolution: res, size: doc.settings.size, heightScale: doc.settings.heightScale };
    let plan: RealtimePlan | null = null;
    try { plan = planRealtime(doc.graph, root, { frame, seed: doc.settings.seed, seaLevel: doc.settings.seaLevel, paintMeta: doc.paint }); } catch { plan = null; }
    if (!plan) return false;
    this.next = { doc, paint, plan, res, gen: this.gen };
    void this.pump();
    return true;
  }

  /** The settled preview arrived (or the edit was abandoned): frames still in flight are stale. */
  settle(): void {
    this.gen++;
    this.next = null;
    this.onState({ active: false, backend: null, bypassed: [], ms: 0 });
  }

  private async pump(): Promise<void> {
    if (this.busy || !this.next) return;
    const req = this.next;
    this.next = null;
    this.busy = true;
    const start = performance.now();
    try {
      let heights: Float32Array | null;
      if (this.gpu && !this.failed) {
        const key = JSON.stringify([req.plan.sourcesKey, req.plan.steps, req.res]);
        if (key !== this.planKey) {
          const sources = await this.client.sources(req.doc, req.paint, req.res, req.plan.sources);
          if (!sources || req.gen !== this.gen) return;
          this.gpu.load(req.plan, sources, req.res, req.doc.graph);
          this.planKey = key;
        }
        heights = await this.gpu.run(req.doc.graph, {
          frame: { resolution: req.res, size: req.doc.settings.size, heightScale: req.doc.settings.heightScale },
          seed: req.doc.settings.seed, seaLevel: req.doc.settings.seaLevel, paint: req.paint, paintMeta: req.doc.paint,
        });
      } else {
        heights = await this.client.heights(req.doc, req.paint, req.res, req.plan.bypassed);
      }
      if (heights && req.gen === this.gen) {
        this.show(heights, req.res, req.doc);
        this.onState({ active: true, backend: this.backend, bypassed: req.plan.bypassed, ms: performance.now() - start });
      }
    } catch (err) {
      // A device that cannot run the kernels: fall back to the worker for the rest of the session.
      if (this.gpu && !this.failed) {
        console.warn('[World] realtime GPU preview failed, using the CPU:', err);
        this.failed = true;
        this.planKey = '';
      }
    } finally {
      this.busy = false;
      void this.pump();
    }
  }

  /** CPU and GPU heights of `doc` edited at `root`, for the parity check (`?worldParity`). */
  async parity(doc: WorldDoc, paint: PaintPixels, root: string): Promise<{ max: number; p999: number; mean: number; n: number } | null> {
    if (!this.gpu) return null;
    const res = Math.min(REALTIME_RES_GPU, doc.settings.resolution);
    const frame = { resolution: res, size: doc.settings.size, heightScale: doc.settings.heightScale };
    const plan = planRealtime(doc.graph, root, { frame, seed: doc.settings.seed, seaLevel: doc.settings.seaLevel, paintMeta: doc.paint });
    if (!plan) return null;
    const probe = new RealtimeGpu();
    try {
      const sources = await this.client.sources(doc, paint, res, plan.sources);
      if (!sources) return null;
      probe.load(plan, sources, res, doc.graph);
      const gpu = await probe.run(doc.graph, { frame, seed: doc.settings.seed, seaLevel: doc.settings.seaLevel, paint, paintMeta: doc.paint });
      const cpu = await this.client.heights(doc, paint, res, plan.bypassed);
      if (!gpu || !cpu) return null;
      const errs = Array.from(gpu, (v, i) => Math.abs(v - cpu[i]) * doc.settings.heightScale).sort((a, b) => a - b);
      const mean = errs.reduce((s, v) => s + v, 0) / errs.length;
      return { max: errs[errs.length - 1], p999: errs[Math.floor(errs.length * 0.999)], mean, n: errs.length };
    } finally {
      probe.dispose();
    }
  }

  dispose(): void {
    this.gen++;
    this.next = null;
    this.gpu?.dispose();
    this.gpu = null;
  }
}

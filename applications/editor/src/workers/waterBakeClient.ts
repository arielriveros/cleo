// Run one water flow bake (workers/waterBakeWorker.ts) and hear its progress. Falls back to running it here,
// in slices, when a worker cannot be made. `cancel()` stops it; the promise then resolves to null.
import { ShallowWaterBake, type WaterBakeOutput, type WaterBakeSetup } from 'cleo';

export interface WaterBakeRun { result: Promise<WaterBakeOutput | null>; cancel: () => void; }

/** `onProgress`: how far the bake is toward its time limit (0..1), and the seconds of water simulated so far. */
export function runWaterBake(setup: WaterBakeSetup, onProgress: (fraction: number, seconds: number) => void): WaterBakeRun {
  let worker: Worker | null = null;
  try {
    // The only form Vite turns into a worker chunk (see workerClient.ts).
    worker = new Worker(new URL('./waterBakeWorker.ts', import.meta.url), { type: 'module' });
  } catch {
    worker = null;
  }
  if (!worker) return runHere(setup, onProgress);
  let settle: (output: WaterBakeOutput | null) => void = () => {};
  let fail: (e: Error) => void = () => {};
  const result = new Promise<WaterBakeOutput | null>((resolve, reject) => { settle = resolve; fail = reject; });
  const w = worker;
  w.onmessage = (event: MessageEvent<{ progress?: number; seconds?: number; output?: WaterBakeOutput; error?: string }>) => {
    const data = event.data;
    if (data.progress !== undefined) onProgress(data.progress, data.seconds ?? 0);
    else if (data.output) { w.terminate(); settle(data.output); }
    else if (data.error) { w.terminate(); fail(new Error(data.error)); }
  };
  // The worker never started (a bundling or loading failure): bake here instead.
  w.onerror = () => {
    w.terminate();
    const here = runHere(setup, onProgress);
    here.result.then(settle, fail);
    cancelHere = here.cancel;
  };
  let cancelHere: (() => void) | null = null;
  w.postMessage({ setup });
  return {
    result,
    cancel: () => { w.terminate(); cancelHere?.(); settle(null); },
  };
}

/** The same bake on this thread, in ~30 ms slices so the editor keeps drawing. */
function runHere(setup: WaterBakeSetup, onProgress: (fraction: number, seconds: number) => void): WaterBakeRun {
  let cancelled = false;
  const result = (async () => {
    const bake = new ShallowWaterBake(setup);
    while (!bake.done && !cancelled) {
      const t0 = performance.now();
      while (!bake.done && performance.now() - t0 < 30) bake.step(4);
      onProgress(bake.progress, bake.seconds);
      await new Promise(r => setTimeout(r, 0));
    }
    return cancelled ? null : bake.results();
  })();
  return { result, cancel: () => { cancelled = true; } };
}

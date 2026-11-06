// The main-thread side of surfaceWorker.ts. Unlike the foliage client (which coalesces builds of one
// document), every request here is wanted: a World shows several kinds at once. So requests queue in
// order on one lazily made worker, and a finished set is CACHED by (kind, size, seed) -- the maps never
// change for those, and a tint is the material's baseColor, never a regeneration -- so asking again, or
// asking while the same set is being built, shares one promise.

import type { SurfacePngs } from './encode';
import type { SurfaceKind } from './kinds';
import type { SurfaceWorkerIn, SurfaceWorkerOut } from './surfaceWorker';

export type { SurfacePngs } from './encode';

interface Pending { resolve: (p: SurfacePngs) => void; reject: (e: Error) => void; key: string }

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
const cache = new Map<string, Promise<SurfacePngs>>();

const keyOf = (kind: SurfaceKind, size: number, seed: number) => `${kind}:${size}:${seed}`;

function ensureWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('./surfaceWorker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (e: MessageEvent<SurfaceWorkerOut>) => {
    const out = e.data;
    const req = pending.get(out.id);
    if (!req) return;
    pending.delete(out.id);
    if (out.ok) req.resolve(out.pngs);
    else { cache.delete(req.key); req.reject(new Error(out.error)); }
  };
  w.onerror = e => {
    // A worker that failed to load is gone for good: fail what it held (and forget those sets, so a later
    // request retries on a fresh worker).
    const message = e.message || 'The surface worker failed';
    for (const req of pending.values()) { cache.delete(req.key); req.reject(new Error(message)); }
    pending.clear();
    w.terminate();
    if (worker === w) worker = null;
  };
  worker = w;
  return w;
}

/**
 * The PNG set of `kind` at `size`² from `seed`. The worker builds requests in the order they arrive; the
 * same (kind, size, seed) is built once and every caller shares it.
 */
export function requestSurface(kind: SurfaceKind, size: number, seed: number): Promise<SurfacePngs> {
  const key = keyOf(kind, size, seed);
  const hit = cache.get(key);
  if (hit) return hit;
  const promise = new Promise<SurfacePngs>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, key });
    ensureWorker().postMessage({ id, kind, size, seed } satisfies SurfaceWorkerIn);
  });
  cache.set(key, promise);
  return promise;
}

/** Drop the worker and the cache (tests, or leaving the World for good). */
export function disposeSurfaces(): void {
  worker?.terminate();
  worker = null;
  for (const req of pending.values()) req.reject(new Error('Surface generation was stopped'));
  pending.clear();
  cache.clear();
}

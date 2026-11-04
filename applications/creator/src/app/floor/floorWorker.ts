// Composites a floor's weather off the main thread (floorComposite.ts) and hands back PNG bytes the engine
// loads as ordinary textures (with mipmaps and repeat). The worker keeps the decoded sets, so a slider drag
// sends only the weather.
//
//   in   { id, base, set, snowSet, weather }   `set` / `snowSet`: FloorSet | null, `base`: where floors are served
//   out  { id, diff, nor, arm }                PNG bytes (ArrayBuffers, transferred) -- or { id, error }

import { compositeFloor, type FloorMaps, type FloorWeather } from './floorComposite';
import { synthesizeFloor } from './floorSynth';
import { loadFloorMaps, type FloorSet } from './floorSets';

export interface FloorWorkerIn { id: number; base: string; set: FloorSet; snowSet: FloorSet | null; weather: FloorWeather }
export type FloorWorkerOut = { id: number; size: number; diff: ArrayBuffer; nor: ArrayBuffer; arm: ArrayBuffer; disp: ArrayBuffer | null } | { id: number; error: string };

const cache = new Map<string, Promise<FloorMaps>>();
function maps(base: string, set: FloorSet): Promise<FloorMaps> {
  const key = base + set.id;
  let p = cache.get(key);
  if (!p) { p = loadFloorMaps(base, set); cache.set(key, p); p.catch(() => cache.delete(key)); }
  return p;
}

/** The set made non-repeating (twice its size), kept for the last set asked for: the weather only recomposites it. */
let synthesized: { key: string; maps: FloorMaps } | null = null;

async function png(size: number, rgba: Uint8ClampedArray): Promise<ArrayBuffer> {
  const canvas = new OffscreenCanvas(size, size);
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), size, size), 0, 0);
  return (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
}

self.onmessage = async (e: MessageEvent<FloorWorkerIn>) => {
  const { id, base, set, snowSet, weather } = e.data;
  try {
    const [m, s] = await Promise.all([maps(base, set), snowSet ? maps(base, snowSet).catch(() => null) : Promise.resolve(null)]);
    const key = base + set.id;
    if (synthesized?.key !== key) synthesized = { key, maps: synthesizeFloor(m) };
    const out = compositeFloor(synthesized.maps, s, weather);
    const [diff, nor, arm, disp] = await Promise.all([png(out.size, out.diff), png(out.size, out.nor), png(out.size, out.arm), out.disp ? png(out.size, out.disp) : Promise.resolve(null)]);
    (self as unknown as { postMessage(m: FloorWorkerOut, t: Transferable[]): void }).postMessage({ id, size: out.size, diff, nor, arm, disp }, disp ? [diff, nor, arm, disp] : [diff, nor, arm]);
  } catch (err) {
    (self as unknown as { postMessage(m: FloorWorkerOut): void }).postMessage({ id, error: String(err) });
  }
};

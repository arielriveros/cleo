// The live preview's CPU solver, off the main thread. Without compute (the WebGL2 backend, or the GPU
// solver switched off) a 48-voxel grid costs tens of milliseconds a step; here it costs the viewport
// nothing but the upload of each finished frame.
//
// Protocol (LiveFx in liveSim.ts is the other side):
//   in   { type: 'reset', dims, params }      start over on a new grid
//        { type: 'params', params }           change parameters in flight; the state is kept
//        { type: 'solid', mask }              the placed bodies' solid mask, or null
//        { type: 'wind', wind }               the stage's wind (voxel units), or null
//        { type: 'advance', frames, buffer }  simulate `frames` frames, then pack into `buffer`
//                                             (a transferred Float32Array's buffer, reused when big enough)
//   out  { type: 'frame', buffer, time, ms, fire }
//        the packed volume (transferred back), sim seconds, ms per frame, and the fire light: the
//        emission-weighted centre (0..1 per axis) and strength (0..1), as fxReduce.wgsl computes it
//
// Imports stay off the `cleo` barrel: a worker has no `window`, and the barrel pulls in modules that
// need one. fluidCpu and volumeRender reach only `cleo/particles/curves`, which is pure.

import { FluidCpu, type FluidDims, type SceneWind } from './fluidCpu';
import { normaliseFx, type FxParams } from './fxParams';
import { fireLightOf, lightVector, packVolumeCpu } from './volumeRender';
import { groundShadow } from './realism';

export type FluidWorkerIn =
  | { type: 'reset'; dims: FluidDims; params: FxParams }
  | { type: 'params'; params: FxParams }
  | { type: 'solid'; mask: Uint8Array | null }
  | { type: 'wind'; wind: SceneWind | null }
  | { type: 'advance'; frames: number; buffer: ArrayBuffer | null };

export type FluidWorkerOut = {
  type: 'frame'; buffer: ArrayBuffer; time: number; ms: number; fire: [number, number, number, number];
  /** The advected detail coordinates (copies), when detail is on. */
  detail: [Float32Array, Float32Array] | null;
  /** The ground shadow (realism.ts `groundShadow`), RGBA8. */
  shadow: Uint8Array;
};

let fluid: FluidCpu | null = null;
let params: FxParams | null = null;
let solid: Uint8Array | null = null;
let wind: SceneWind | null = null;

self.onmessage = (e: MessageEvent<FluidWorkerIn>) => {
  const msg = e.data;
  if (msg.type === 'reset') {
    fluid = new FluidCpu(msg.dims);
    fluid.solid = solid && solid.length === fluid.count ? solid : null;
    fluid.sceneWind = wind;
    params = normaliseFx(msg.params);
    return;
  }
  if (msg.type === 'params') { params = normaliseFx(msg.params); return; }
  if (msg.type === 'solid') {
    solid = msg.mask;
    if (fluid) fluid.solid = solid && solid.length === fluid.count ? solid : null;
    return;
  }
  if (msg.type === 'wind') {
    wind = msg.wind;
    if (fluid) fluid.sceneWind = wind;
    return;
  }
  if (!fluid || !params) return;
  const p = params;
  const start = performance.now();
  const dt = p.frameTime / Math.max(1, p.substeps);
  for (let f = 0; f < msg.frames; f++) for (let s = 0; s < p.substeps; s++) fluid.step(p, dt);
  const ms = (performance.now() - start) / Math.max(1, msg.frames);
  const floats = fluid.count * 4;
  const out = msg.buffer && msg.buffer.byteLength >= floats * 4 ? new Float32Array(msg.buffer, 0, floats) : new Float32Array(floats);
  packVolumeCpu(fluid, p, out);
  const detail: [Float32Array, Float32Array] | null = fluid.detailA && fluid.detailB ? [fluid.detailA.slice(), fluid.detailB.slice()] : null;
  const f = fluid;
  const shadow = groundShadow(f.dims, lightVector(p), p.absorption, (x, y, z) => f.sample(f.density, x, y, z));
  const reply: FluidWorkerOut = { type: 'frame', buffer: out.buffer as ArrayBuffer, time: fluid.time, ms, fire: fireLightOf(fluid, p), detail, shadow };
  (self as unknown as { postMessage(m: FluidWorkerOut, transfer: Transferable[]): void }).postMessage(reply, [out.buffer as ArrayBuffer]);
};

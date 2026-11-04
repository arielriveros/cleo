// The live preview's liquid solver, off the main thread: the particles (liquidCpu.ts), splatted into the
// preview grid and packed for the engine's FluidVolumeNode `liquid` shading, and the floor film drawn
// into the decal maps the stage lays on its ground.
//
// Protocol (LiveLiquid in liveLiquid.ts is the other side):
//   in   { type: 'reset', params, dims, voxelSize, window, windowed, wind, generation }
//                                                     start over: a new release from t = 0, splatted into
//                                                     `dims` voxels -- the whole region, or (`windowed`) a
//                                                     window kept over the drops, from `window`
//        { type: 'look', params }                     look-only parameters (the film's colours)
//        { type: 'bodies', bodies, origin }           the stage's bodies (and the region's low corner, world)
//        { type: 'wind', wind }                       the stage's wind, m/s, or null
//        { type: 'advance', frames, buffer }          simulate `frames` frames, then pack into `buffer`
//   out  { type: 'frame', buffer, window, time, ms, particles, film }
//        the packed volume (transferred back) and the window it covers, sim seconds, ms per frame, live particles, and
//        the changed part of the film's colour / normal / ORM maps with the decal's albedo share
// (The GPU solver keeps its film on the GPU, liquidFilmGpu.ts: this worker is the CPU path only.)
//
// Imports stay off the `cleo` barrel, as fluidWorker.ts's do.

import type { FluidDims } from './fluidCpu';
import { normaliseFx, type FxParams } from './fxParams';
import type { FxBody } from './fxScene';
import { LiquidCpu, type LiquidWind } from './liquidCpu';
import { LiquidFilm } from './liquidFilm';
import {
  dropBounds, filmExtent, filmFrame, filmMaps, packLiquidVolume, previewAlbedoOpacity, previewWindow, resampleFilm, splatLiquid, splatRadius,
  type FilmFrame, type LiquidGrid, type LiquidWindow,
} from './liquidRender';
import { bodyDistance } from './obstacles';

export type LiquidWorkerIn =
  | { type: 'reset'; params: FxParams; dims: FluidDims; voxelSize: number; window: LiquidWindow; windowed: boolean; wind?: LiquidWind | null; generation: number }
  | { type: 'look'; params: FxParams }
  | { type: 'bodies'; bodies: FxBody[]; origin: [number, number, number] }
  | { type: 'wind'; wind: LiquidWind | null }
  | { type: 'advance'; frames: number; buffer: ArrayBuffer | null }
  ;

/**
 * The film's maps for the preview's decal. The decal is one FIXED frame for the whole run -- everywhere the
 * liquid can reach on the floor (liquidCpu.ts `liquidDomain`, never the region, which only frames the drops),
 * `cols` x `rows` cells over `size` metres centred `center` from the floor's centre -- so its
 * textures are made once; each message carries only the part of it that changed (`rect`: x, z, width and
 * height in frame cells, row 0 at -z; the maps are `width` x `height`).
 */
export interface LiquidFilmFrame {
  color: Uint8Array; normal: Uint8Array; orm: Uint8Array;
  cols: number; rows: number; rect: [number, number, number, number];
  center: [number, number]; size: [number, number]; albedoOpacity: number;
}

export type LiquidWorkerOut = {
  type: 'frame'; buffer: ArrayBuffer; time: number; ms: number; particles: number;
  /** The part of the region the volume covers. */
  window: LiquidWindow;
  /** The reset this frame belongs to: a frame still in flight from before a restart is dropped. */
  generation: number;
  film: LiquidFilmFrame | null;
};

/** The preview decal's most cells a side: past it the stain is drawn at coarser cells (cheap to redraw and upload). */
const PREVIEW_FILM_SIDE = 1024;

let sim: LiquidCpu | null = null;
let params: FxParams | null = null;
let dims: FluidDims | null = null;
let voxelSize = 0.01;
let grid: LiquidGrid | null = null;
/** The window the volume covers, and whether it follows the drops (or is the whole region). */
let win: LiquidWindow | null = null;
let windowed = false;
let bodies: FxBody[] = [];
let origin: [number, number, number] = [0, 0, 0];
let wind: LiquidWind | null = null;
let frameCount = 0;
let generation = 0;

/** What the decal last showed: the rectangle of its frame (cells) drawn so far, so a change redraws the union. */
let drawn: [number, number, number, number] | null = null;

/** The decal's frame for this run: the liquid's whole reach on the floor (`liquidDomain`). */
let decalFrame: FilmFrame | null = null;

/** The film's maps where it changed since the last (or null when nothing is wet), with the preview's constant albedo share. */
function filmUpdate(p: FxParams, film: LiquidFilm): LiquidFilmFrame | null {
  const extent = filmExtent(film);
  if (!extent || !decalFrame) return null;
  const full = decalFrame;
  const c = full.cell;
  let x0 = Math.max(0, Math.floor((extent[0] - full.x0) / c) - 1), z0 = Math.max(0, Math.floor((extent[1] - full.z0) / c) - 1);
  let x1 = Math.min(full.cols, Math.ceil((extent[2] - full.x0) / c) + 1), z1 = Math.min(full.rows, Math.ceil((extent[3] - full.z0) / c) + 1);
  if (drawn) { x0 = Math.min(x0, drawn[0]); z0 = Math.min(z0, drawn[1]); x1 = Math.max(x1, drawn[0] + drawn[2]); z1 = Math.max(z1, drawn[1] + drawn[3]); }
  if (x1 <= x0 || z1 <= z0) return null;
  drawn = [x0, z0, x1 - x0, z1 - z0];
  const sub: FilmFrame = { x0: full.x0 + x0 * c, z0: full.z0 + z0 * c, cols: x1 - x0, rows: z1 - z0, cell: c };
  const albedoOpacity = previewAlbedoOpacity(p);
  const maps = filmMaps(p, resampleFilm(film, sub), sub, albedoOpacity);
  const size: [number, number] = [full.cols * c, full.rows * c];
  return { ...maps, cols: full.cols, rows: full.rows, rect: [x0, z0, x1 - x0, z1 - z0], size, center: [full.x0 + size[0] / 2, full.z0 + size[1] / 2], albedoOpacity };
}

/** The stage's bodies as one signed distance, in region space. */
function obstacle(): ((x: number, y: number, z: number) => number) | null {
  const live = bodies.filter(b => b.visible);
  if (!live.length) return null;
  return (x, y, z) => {
    let d = Infinity;
    const w: [number, number, number] = [x + origin[0], y + origin[1], z + origin[2]];
    for (const b of live) d = Math.min(d, bodyDistance(b, w));
    return d;
  };
}

self.onmessage = (e: MessageEvent<LiquidWorkerIn>) => {
  const msg = e.data;
  if (msg.type === 'reset') {
    params = normaliseFx(msg.params);
    dims = msg.dims;
    voxelSize = msg.voxelSize;
    win = msg.window;
    windowed = msg.windowed;
    if (msg.wind !== undefined) wind = msg.wind;
    sim = new LiquidCpu(params, { wind });
    decalFrame = sim.film ? filmFrame(sim.domain.pool, sim.film.cell, PREVIEW_FILM_SIDE) : null;
    sim.obstacle = obstacle();
    sim.film?.setObstacle(sim.obstacle);
    sim.sceneWind = wind;
    grid = null;
    drawn = null;
    frameCount = 0;
    generation = msg.generation;
    return;
  }
  if (msg.type === 'look') { params = normaliseFx(msg.params); drawn = null; return; }
  if (msg.type === 'bodies') {
    bodies = msg.bodies;
    origin = msg.origin;
    const o = obstacle();
    if (sim) { sim.obstacle = o; sim.film?.setObstacle(o); }
    return;
  }
  if (msg.type === 'wind') {
    wind = msg.wind;
    if (sim) sim.sceneWind = wind;
    return;
  }
  if (!sim || !params || !dims) return;
  const p = params;
  const start = performance.now();
  for (let f = 0; f < msg.frames; f++) sim.step(p, p.frameTime);
  // Over the drops as they are now: no lag to allow for, only the splat's reach.
  if (windowed) win = previewWindow(dropBounds(sim), splatRadius(p, win?.voxelSize ?? voxelSize) + 2 * voxelSize, dims, voxelSize, p.regionSize, win);
  const w = win ?? { origin: [0, 0, 0] as [number, number, number], dims, voxelSize };
  grid = splatLiquid(sim, p, w.dims, w.voxelSize, { origin: w.origin }, grid);
  const floats = grid.density.length * 4;
  const out = msg.buffer && msg.buffer.byteLength >= floats * 4 ? new Float32Array(msg.buffer, 0, floats) : new Float32Array(floats);
  packLiquidVolume(grid, out);
  const film = sim.film ? filmUpdate(p, sim.film) : null;
  const ms = (performance.now() - start) / Math.max(1, msg.frames);
  const reply: LiquidWorkerOut = { type: 'frame', buffer: out.buffer as ArrayBuffer, window: w, time: sim.time, ms, particles: sim.count, film, generation };
  const transfer: Transferable[] = [out.buffer as ArrayBuffer];
  if (film) transfer.push(film.color.buffer, film.normal.buffer, film.orm.buffer);
  (self as unknown as { postMessage(m: LiquidWorkerOut, transfer: Transferable[]): void }).postMessage(reply, transfer);
};

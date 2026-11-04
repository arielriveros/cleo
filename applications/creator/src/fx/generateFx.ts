// FX Creator's generate(): simulate, capture `frames` (+ the loop tail), pack the flipbook.
// The solver is behind `FluidBackend` so the GPU and CPU paths share the capture loop exactly.

import type { Texture } from 'cleo/graphics/texture';
import { encodePngRgba8 } from '../core/png';
import { SILENT_CONTEXT, sidecar, yieldToUi, GenerationCancelled, type ExportFile, type GenerateContext } from '../core/generator';
import { FluidCpu, fluidDims, type FluidDims, type SceneWind } from './fluidCpu';
import { atlasLayout, blitTile, fadeEdges, loopBlend, particleFlipbook, tilesetJson, type AtlasLayout } from './flipbook';
import { liquidVoxelSize, MAX_VOXELS, normaliseFx, tileDims, type FxParams } from './fxParams';
import { bakeFireLut, cropTile, renderTile, tileAspectOf, viewBasis, type RenderMode } from './volumeRender';
import { LiquidCpu } from './liquidCpu';
import {
  bakeWindow, dropBounds, filmAlbedoOpacity, filmExtent, filmFrame, filmMaps, renderLiquidTile, resampleFilm, splatLiquid, splatRadius, unionExtent,
  type LiquidGrid, type LiquidWindow,
} from './liquidRender';
import type { FilmSnapshot } from './liquidFilm';

/** One simulation, wherever it runs. */
export interface FluidBackend {
  readonly kind: 'gpu' | 'cpu';
  readonly dims: FluidDims;
  step(p: FxParams, dt: number): void | Promise<void>;
  /** The current state as a tile x tile RGBA8 image (straight alpha, row 0 at the top), in `mode`. */
  render(p: FxParams, tile: number, lut: Float32Array, mode?: RenderMode): Promise<Uint8Array>;
  /**
   * Write the current state into a FluidVolumeNode's compute-writable volume (R density, G temperature,
   * B light), without a readback. GPU backends only; the CPU path packs with `packVolumeCpu`.
   */
  packVolume?(p: FxParams, volume: Texture, occupancy?: Texture | null, detail?: [Texture, Texture] | null): void;
  /** The preview's placed bodies as a solid mask (one byte per voxel), or null for open air. */
  setSolid?(mask: Uint8Array | null): void;
  /**
   * The fire light as of the last pack with occupancy: emission-weighted centre (0..1 of the grid per
   * axis) and strength (0..1). Resolves a frame or more later; never awaited inside a frame.
   */
  fireLight?(): Promise<[number, number, number, number]>;
  /** The shadow the gas casts on a square of ground (`area` in grid voxels) into a storage texture. */
  groundShadow?(p: FxParams, texture: Texture, area: { x0: number; z0: number; size: number; res: number }): void;
  /** The preview stage's wind, or null. */
  setSceneWind?(wind: SceneWind | null): void;
  dispose(): void;
}

export function cpuBackend(dims: FluidDims): FluidBackend {
  const fluid = new FluidCpu(dims);
  return {
    kind: 'cpu',
    dims,
    step: (p, dt) => fluid.step(p, dt),
    async render(p, tile, lut, mode) {
      const out = new Uint8Array(tile * tile * 4);
      renderTile(fluid, p, out, tile, lut, mode);
      return out;
    },
    setSolid(mask) { fluid.solid = mask; },
    setSceneWind(wind) { fluid.sceneWind = wind; },
    dispose() { /* garbage */ },
  };
}

/**
 * The extra atlases a bake can make, beside the colour flipbook:
 *   sixWayPos / sixWayNeg  six-way lightmaps (Unity VFX Graph / Unreal convention): the smoke lit from the
 *                          right, top and back in RGB with alpha in A; from the left, bottom and front in
 *                          RGB with the fire's emission in A;
 *   motion                 screen-space flow, R/G = 0.5 + motion x `motionScale` (right, up), alpha in A;
 *   emission               the fire's light alone, for an additive layer;
 *   albedo / normal / orm  a liquid sprite's surface, for a lit particle the engine lights itself: unlit
 *                          base colour over the body's opacity, the tangent-space normal (OpenGL: R right,
 *                          G up, B out), and occlusion / roughness / metallic;
 *   decal*                 the floor decal (its own frame size and layout).
 */
export type FxOutputKind = 'color' | 'sixWayPos' | 'sixWayNeg' | 'motion' | 'emission' | 'albedo' | 'normal' | 'orm' | 'decal' | 'decalNormal' | 'decalOrm';

export const OUTPUT_LABELS: Record<FxOutputKind, string> = {
  color: 'Colour', sixWayPos: 'Six-way +', sixWayNeg: 'Six-way −', motion: 'Motion vectors', emission: 'Emission',
  albedo: 'Base colour', normal: 'Normals', orm: 'Roughness / metallic',
  decal: 'Floor decal', decalNormal: 'Decal normals', decalOrm: 'Decal roughness',
};

/** A liquid sprite's surface maps, beside its lit colour. */
export const SURFACE_KINDS: readonly FxOutputKind[] = ['albedo', 'normal', 'orm'];

/** The decal outputs: their own frame size and atlas layout, not the sprite's. */
export const DECAL_KINDS: readonly FxOutputKind[] = ['decal', 'decalNormal', 'decalOrm'];

/**
 * A liquid's floor decal: the film seen from above, frame by frame, on its own atlas. The last frame is
 * the settled pool; `final` holds it on its own, for a decal that does not animate.
 */
export interface FxDecalOutput {
  layout: AtlasLayout;
  /** Frames per second that play it at the simulation's own pace, from the effect's t = 0. */
  fps: number;
  /** The floor it covers, metres: the decal box's x and z size -- where the liquid lies, not the region. */
  size: [number, number];
  /** Its centre, metres from the centre of the region's floor (x, z): where the decal stands. */
  offset: [number, number];
  /** The decal's albedo share (DecalNode.albedoOpacity) its colours were solved for. */
  albedoOpacity: number;
  /** The settled frame's maps. */
  final: { color: Uint8Array; normal: Uint8Array; orm: Uint8Array };
}

export interface FxAtlas {
  /** The packed atlas, RGBA8, `layout.width` x `layout.height`. */
  atlas: Uint8Array;
  /** Each frame's tile, in order, after loop blending. */
  frames: Uint8Array[];
}

export interface FxOutput extends FxAtlas {
  layout: AtlasLayout;
  /** Every atlas this bake made, the colour one included (`atlas` / `frames` above). */
  outputs: Partial<Record<FxOutputKind, FxAtlas>>;
  backend: 'gpu' | 'cpu';
  /** The grid: a gas's region; a liquid's largest window over its drops. */
  dims: FluidDims;
  /** Flipbook playback rate that matches the simulation's own time. */
  fps: number;
  /** A liquid's floor decal, when the bake made one. */
  decal?: FxDecalOutput;
}

export interface GenerateFxOptions {
  /** Build the solver; defaults to the CPU one. The app passes the GPU factory when compute exists. */
  backend?: (dims: FluidDims) => FluidBackend;
  /** Called with each captured frame, for a live preview. */
  onFrame?: (index: number, tile: Uint8Array, width: number, height: number) => void;
}

export async function generateFx(raw: FxParams, ctx: GenerateContext = SILENT_CONTEXT, opts: GenerateFxOptions = {}): Promise<FxOutput> {
  const p = normaliseFx(raw);
  if (p.medium === 'liquid') return generateLiquid(p, ctx, opts);
  const dims = fluidDims(p);
  const sim = (opts.backend ?? cpuBackend)(dims);
  try {
    const lut = bakeFireLut(p);
    const tail = Math.min(p.loopBlend, p.frames);
    const captured = p.frames + tail;
    const total = p.warmup + captured;
    const dt = p.frameTime / Math.max(1, p.substeps);
    const kinds = bakeKinds(p);
    const captures = new Map<FxOutputKind, Uint8Array[]>(kinds.map(k => [k, []]));
    const frames = captures.get('color')!;
    // A tall or wide tile is the centre cut of a square render framed for it.
    const { width, height } = tileDims(p);
    const square = Math.max(width, height);
    // Motion vectors keep their coverage: a blend shader reads them where the colour still shows.
    const render = async (q: FxParams, mode?: RenderMode) => {
      const tile = cropTile(await sim.render(q, square, lut, mode), square, width, height);
      return mode === 'motion' ? tile : fadeEdges(tile, width, height, p.edgeFade);
    };
    for (let f = 0; f < total; f++) {
      for (let s = 0; s < p.substeps; s++) await sim.step(p, dt);
      if (f >= p.warmup) {
        const tile = await render(p);
        frames.push(tile);
        opts.onFrame?.(frames.length - 1, tile, width, height);
        await captureExtras(sim, p, render, captures);
      }
      ctx.progress((f + 1) / total, f < p.warmup ? 'Warming up' : `Frame ${f - p.warmup + 1} / ${captured}`);
      await yieldToUi();
      if (ctx.cancelled) throw new GenerationCancelled();
    }
    const layout = atlasLayout(p.frames, width, height);
    const outputs = packAtlases(captures, layout, p.frames, tail);
    const color = outputs.color!;
    return { layout, atlas: color.atlas, frames: color.frames, outputs, backend: sim.kind, dims, fps: Math.round(1 / p.frameTime) };
  } finally {
    sim.dispose();
  }
}

/** Each output's frames into its atlas, the loop tail cross-faded into the head first. */
function packAtlases(captures: Map<FxOutputKind, Uint8Array[]>, layout: AtlasLayout, frames: number, tail: number): Partial<Record<FxOutputKind, FxAtlas>> {
  const outputs: Partial<Record<FxOutputKind, FxAtlas>> = {};
  for (const [kind, all] of captures) {
    const head = all.slice(0, frames);
    if (tail > 0) loopBlend(head, all.slice(frames));
    const atlas = new Uint8Array(layout.width * layout.height * 4);
    head.forEach((t, i) => blitTile(atlas, layout, i, t));
    outputs[kind] = { atlas, frames: head };
  }
  return outputs;
}

/**
 * A liquid's bake: the particle solver from t = 0, the sprite frames captured as the gas's are (warm-up,
 * frames, loop tail), and -- for a solid floor with the decal on -- the film on the floor captured
 * `decalFrames` times evenly from t = 0 to `decalSettle` seconds after the last sprite frame, so the
 * decal's flipbook, played from the moment the effect starts, shows the liquid landing and settling.
 *
 * Each sprite frame splats the drops into a window over where they are, at the droplets' voxels
 * (`liquidVoxelSize`; coarser only when the drops spread past MAX_VOXELS of them), and draws it framed by
 * the region: the region's size is room, never definition.
 */
async function generateLiquid(p: FxParams, ctx: GenerateContext, opts: GenerateFxOptions): Promise<FxOutput> {
  const voxel = liquidVoxelSize(p);
  let dims: FluidDims = { nx: 2, ny: 2, nz: 2 };
  const pad = (v: number) => splatRadius(p, v) + 2 * v;
  const windowOf = (): LiquidWindow => {
    const bounds = dropBounds(sim);
    if (!bounds) return { origin: [0, 0, 0], dims: { nx: 2, ny: 2, nz: 2 }, voxelSize: voxel };
    const w = bakeWindow(bounds, pad(voxel), p.regionSize, voxel, MAX_VOXELS);
    // Coarser voxels splat wider: the pad grows with them.
    return w.voxelSize > voxel ? bakeWindow(bounds, pad(w.voxelSize), p.regionSize, w.voxelSize, MAX_VOXELS) : w;
  };
  const decalOn = p.bakeDecal && p.floorMode === 'solid';
  const sim = new LiquidCpu(p);
  const tail = Math.min(p.loopBlend, p.frames);
  const captured = p.frames + tail;
  const spriteFrames = p.warmup + captured;
  const decalFrames = decalOn ? Math.max(1, Math.round(p.decalFrames)) : 0;
  const decalSimFrames = decalOn ? Math.max(decalFrames, Math.ceil((p.warmup + p.frames) + Math.max(0, p.decalSettle) / p.frameTime)) : 0;
  const total = Math.max(spriteFrames, decalSimFrames);
  const surfaceKinds = p.bakeSurfaceMaps ? SURFACE_KINDS : [];
  const kinds: FxOutputKind[] = [...(p.bakeMotion ? ['color', 'motion'] as FxOutputKind[] : ['color'] as FxOutputKind[]), ...surfaceKinds];
  const captures = new Map<FxOutputKind, Uint8Array[]>(kinds.map(k => [k, []]));
  const frames = captures.get('color')!;
  const { width, height } = tileDims(p);
  const square = Math.max(width, height);
  const aspect = tileAspectOf(p);
  const snaps: FilmSnapshot[] = [];
  let grid: LiquidGrid | null = null;
  for (let f = 0; f < total; f++) {
    sim.step(p, p.frameTime);
    if (f >= p.warmup && f < spriteFrames) {
      const win = windowOf();
      if (win.dims.nx * win.dims.ny * win.dims.nz > dims.nx * dims.ny * dims.nz) dims = win.dims;
      grid = splatLiquid(sim, p, win.dims, win.voxelSize, { velocity: p.bakeMotion, origin: win.origin }, grid);
      const tile = new Uint8Array(square * square * 4);
      renderLiquidTile(grid, p, tile, square, aspect, 'color');
      const cut = fadeEdges(cropTile(tile, square, width, height), width, height, p.edgeFade);
      frames.push(cut);
      opts.onFrame?.(frames.length - 1, cut, width, height);
      if (p.bakeMotion) {
        const m = new Uint8Array(square * square * 4);
        renderLiquidTile(grid, p, m, square, aspect, 'motion');
        captures.get('motion')!.push(cropTile(m, square, width, height));
      }
      for (const kind of surfaceKinds) {
        const m = new Uint8Array(square * square * 4);
        renderLiquidTile(grid, p, m, square, aspect, kind as 'albedo' | 'normal' | 'orm');
        // The base colour fades at the edges as the colour tile does: it is what a lit particle draws.
        const tile = cropTile(m, square, width, height);
        captures.get(kind)!.push(kind === 'albedo' ? fadeEdges(tile, width, height, p.edgeFade) : tile);
      }
    }
    // The decal's k-th frame is the film after round((k + 1) / n of the decal's span) simulation frames.
    if (decalOn && sim.film) while (snaps.length < decalFrames && f + 1 >= Math.round(((snaps.length + 1) * decalSimFrames) / decalFrames)) snaps.push(sim.film.snapshot());
    ctx.progress((f + 1) / total, f < p.warmup ? 'Warming up' : f < spriteFrames ? `Frame ${f - p.warmup + 1} / ${captured}` : 'Settling on the floor');
    await yieldToUi();
    if (ctx.cancelled) throw new GenerationCancelled();
  }
  const layout = atlasLayout(p.frames, width, height);
  const outputs = packAtlases(captures, layout, p.frames, tail);
  let decal: FxDecalOutput | undefined;
  const extent = snaps.reduce<ReturnType<typeof filmExtent>>((e, s) => unionExtent(e, filmExtent(s)), null);
  if (decalOn && sim.film && snaps.length && extent) {
    // One frame for the whole flipbook: where the liquid lay at any moment, at the film's own cells (half a
    // droplet), coarsened only past `decalTileSize` a side -- the definition is the droplets', never the
    // region's.
    const frame = filmFrame(extent, sim.film.cell, Math.max(16, Math.round(p.decalTileSize)));
    const grids = snaps.map(s => resampleFilm(s, frame));
    const albedo = filmAlbedoOpacity(p, grids[grids.length - 1]);
    const decalLayout = atlasLayout(snaps.length, frame.cols, frame.rows);
    const maps = grids.map(g => filmMaps(p, g, frame, albedo));
    for (const [kind, key] of [['decal', 'color'], ['decalNormal', 'normal'], ['decalOrm', 'orm']] as const) {
      const atlas = new Uint8Array(decalLayout.width * decalLayout.height * 4);
      const list = maps.map(m => m[key]);
      list.forEach((t, i) => blitTile(atlas, decalLayout, i, t));
      outputs[kind] = { atlas, frames: list };
    }
    const last = maps[maps.length - 1];
    const size: [number, number] = [frame.cols * frame.cell, frame.rows * frame.cell];
    decal = {
      layout: decalLayout, size, offset: [frame.x0 + size[0] / 2, frame.z0 + size[1] / 2], albedoOpacity: albedo,
      fps: Math.round((snaps.length / (decalSimFrames * p.frameTime)) * 1000) / 1000,
      final: { color: last.color, normal: last.normal, orm: last.orm },
    };
  }
  const color = outputs.color!;
  return { layout, atlas: color.atlas, frames: color.frames, outputs, backend: 'cpu', dims, fps: Math.round(1 / p.frameTime), decal };
}

/** The outputs a bake of `p` makes, colour first. */
export function bakeKinds(p: Pick<FxParams, 'bakeSixWay' | 'bakeMotion' | 'bakeEmission'> & Partial<Pick<FxParams, 'medium' | 'bakeDecal' | 'floorMode' | 'bakeSurfaceMaps'>>): FxOutputKind[] {
  const kinds: FxOutputKind[] = ['color'];
  const liquid = p.medium === 'liquid';
  if (p.bakeSixWay && !liquid) kinds.push('sixWayPos', 'sixWayNeg');
  if (p.bakeMotion) kinds.push('motion');
  if (p.bakeEmission && !liquid) kinds.push('emission');
  if (liquid && p.bakeSurfaceMaps) kinds.push(...SURFACE_KINDS);
  if (liquid && p.bakeDecal && p.floorMode === 'solid') kinds.push(...DECAL_KINDS);
  return kinds;
}

/** `p` lit from `dir` (a unit vector toward the light, in grid space) instead of its own sun. */
export function litFrom(p: FxParams, dir: readonly number[]): FxParams {
  const el = Math.asin(Math.max(-1, Math.min(1, dir[1])));
  const yaw = Math.abs(dir[0]) + Math.abs(dir[2]) < 1e-9 ? 0 : Math.atan2(dir[0], dir[2]);
  return { ...p, lightYaw: (yaw * 180) / Math.PI, lightElevation: (el * 180) / Math.PI };
}

/** This frame's extra outputs, from the same simulation state as its colour tile. */
async function captureExtras(sim: FluidBackend, p: FxParams, render: (q: FxParams, mode?: RenderMode) => Promise<Uint8Array>,
                             captures: Map<FxOutputKind, Uint8Array[]>): Promise<void> {
  const { width, height } = tileDims(p);
  const size = width * height;
  const needEmission = captures.has('emission') || captures.has('sixWayNeg');
  const emission = needEmission ? await render(p, 'emission') : null;
  if (emission && captures.has('emission')) captures.get('emission')!.push(emission);
  if (captures.has('motion')) captures.get('motion')!.push(await render(p, 'motion'));
  if (captures.has('sixWayPos')) {
    // The six directions in the tile's own frame: right, top, back (away from the camera); and opposite.
    const b = viewBasis(sim.dims, p.view, p.yaw);
    const neg = (v: readonly number[]) => [-v[0], -v[1], -v[2]];
    const dirs = [b.right, b.up, b.dir, neg(b.right), neg(b.up), neg(b.dir)];
    const lit: Uint8Array[] = [];
    for (const d of dirs) lit.push(await render(litFrom(p, d), 'light'));
    const pos = new Uint8Array(size * 4), negT = new Uint8Array(size * 4);
    for (let i = 0; i < size; i++) {
      const k = i * 4;
      // The lit tiles are grey, so R carries each direction's light (straight, like the colour tile).
      pos[k] = lit[0][k]; pos[k + 1] = lit[1][k]; pos[k + 2] = lit[2][k]; pos[k + 3] = lit[0][k + 3];
      negT[k] = lit[3][k]; negT[k + 1] = lit[4][k]; negT[k + 2] = lit[5][k];
      negT[k + 3] = emission ? emission[k + 3] : 0;
    }
    captures.get('sixWayPos')!.push(pos);
    captures.get('sixWayNeg')!.push(negT);
  }
}

const OUTPUT_FILES: Record<Exclude<FxOutputKind, 'color'>, string> = {
  sixWayPos: '6way_pos', sixWayNeg: '6way_neg', motion: 'motion', emission: 'emission',
  albedo: 'albedo_flipbook', normal: 'normal_flipbook', orm: 'orm_flipbook',
  decal: 'decal_flipbook', decalNormal: 'decal_normal_flipbook', decalOrm: 'decal_orm_flipbook',
};

/** The atlas PNG, a `.tileset` for it, and the sidecar with the particle flipbook block to paste. */
export async function exportFx(out: FxOutput, params: FxParams, name = 'fx'): Promise<ExportFile[]> {
  const png = `${name}_flipbook.png`;
  const glows = params.medium !== 'liquid' && params.emission > 0;
  const tileset = tilesetJson(out.layout, `${name}-flipbook`, png, `${name} flipbook`, out.frames.length, glows ? 2 : 1);
  const files: ExportFile[] = [
    { name: png, mime: 'image/png', bytes: await encodePngRgba8(out.layout.width, out.layout.height, out.atlas) },
    { name: `${name}_flipbook.tileset`, mime: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(tileset, null, 2)) },
  ];
  const extras: Record<string, unknown> = {};
  for (const kind of Object.keys(OUTPUT_FILES) as (keyof typeof OUTPUT_FILES)[]) {
    const o = out.outputs?.[kind];
    if (!o) continue;
    const decal = DECAL_KINDS.includes(kind);
    if (decal && !out.decal) continue;
    const layout = decal ? out.decal!.layout : out.layout;
    const file = `${name}_${OUTPUT_FILES[kind]}.png`;
    files.push({ name: file, mime: 'image/png', bytes: await encodePngRgba8(layout.width, layout.height, o.atlas) });
    extras[kind] = file;
  }
  if (out.decal) {
    // The settled pool on its own (a decal that does not animate), beside the flipbook atlases.
    const d = out.decal, tw = d.layout.tileWidth, th = d.layout.tileHeight;
    const still = { color: `${name}_decal.png`, normal: `${name}_decal_normal.png`, orm: `${name}_decal_orm.png` };
    files.push({ name: still.color, mime: 'image/png', bytes: await encodePngRgba8(tw, th, d.final.color) });
    files.push({ name: still.normal, mime: 'image/png', bytes: await encodePngRgba8(tw, th, d.final.normal) });
    files.push({ name: still.orm, mime: 'image/png', bytes: await encodePngRgba8(tw, th, d.final.orm) });
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    extras.decal = {
      convention: 'A DecalNode projecting down its local -Y onto the floor, its centre at [offset[0], 0, offset[1]] from the centre of the effect\'s floor: size [size[0], any, size[1]] metres (where the liquid lies); base colour + coverage, tangent-space normal (x = +X, y = +Z), ORM (R AO, G roughness, B metallic). Flipbook cells left to right from the top row, played from the effect\'s start and held on the last.',
      size: [r3(d.size[0]), r3(d.size[1])],
      offset: [r3(d.offset[0]), r3(d.offset[1])],
      albedoOpacity: Math.round(d.albedoOpacity * 1000) / 1000,
      flipbook: { columns: d.layout.columns, rows: d.layout.rows, frames: out.outputs.decal?.frames.length ?? 0, fps: d.fps, loop: false, blend: true },
      tile: [tw, th],
      atlas: { color: extras.decal, normal: extras.decalNormal, orm: extras.decalOrm },
      still,
      roughness: params.liquidRoughness,
    };
    delete extras.decalNormal; delete extras.decalOrm;
  }
  if (extras.sixWayPos) {
    extras.sixWay = {
      convention: 'Unity VFX Graph six-way: positive map RGB = lit from right, top, back, A = alpha; negative map RGB = lit from left, bottom, front, A = emission',
      positive: extras.sixWayPos, negative: extras.sixWayNeg,
    };
    delete extras.sixWayPos; delete extras.sixWayNeg;
  }
  if (extras.albedo) {
    extras.surface = {
      convention: 'A lit particle\'s maps, cut into the same flipbook cells as the colour atlas: base colour (sRGB, like the colour atlas) with the body\'s opacity in A; tangent-space normal, OpenGL convention (R right, G up, B toward the viewer); ORM (R occlusion, G roughness, B metallic). Draw the base colour as the emitter texture, lit, with these as its normal and ORM maps.',
      albedo: extras.albedo, normal: extras.normal, orm: extras.orm,
      roughness: params.liquidRoughness, metallic: params.liquidMetallic,
    };
    delete extras.albedo; delete extras.normal; delete extras.orm;
  }
  if (extras.motion) {
    extras.motion = {
      file: extras.motion,
      encoding: 'R = 0.5 + right x scale, G = 0.5 + up x scale; motion in tile widths per frame',
      scale: params.motionScale,
    };
  }
  const meta = sidecar('fx', params, params.seed, {
    columns: out.layout.columns,
    rows: out.layout.rows,
    frames: out.frames.length,
    tileSize: out.layout.tile,
    tileWidth: out.layout.tileWidth,
    tileHeight: out.layout.tileHeight,
    medium: params.medium,
    fps: out.fps,
    voxels: out.dims,
    solver: out.backend,
    // Paste into a particle system's Render module (`flipbook`), with `textureId` set to the tileset.
    particleFlipbook: particleFlipbook(out.layout, out.frames.length, out.fps, params.loopBlend > 0),
    ...(Object.keys(extras).length ? { outputs: extras } : {}),
  });
  meta.name = `${name}.json`;
  files.push(meta);
  return files;
}

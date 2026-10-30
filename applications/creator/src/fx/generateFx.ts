// FX Creator's generate(): simulate, capture `frames` (+ the loop tail), pack the flipbook.
// The solver is behind `FluidBackend` so the GPU and CPU paths share the capture loop exactly.

import type { Texture } from 'cleo/graphics/texture';
import { encodePngRgba8 } from '../core/png';
import { SILENT_CONTEXT, sidecar, yieldToUi, GenerationCancelled, type ExportFile, type GenerateContext } from '../core/generator';
import { FluidCpu, fluidDims, type FluidDims, type SceneWind } from './fluidCpu';
import { atlasLayout, blitTile, loopBlend, particleFlipbook, tilesetJson, type AtlasLayout } from './flipbook';
import { normaliseFx, type FxParams } from './fxParams';
import { bakeFireLut, renderTile, viewBasis, type RenderMode } from './volumeRender';

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
 *   emission               the fire's light alone, for an additive layer.
 */
export type FxOutputKind = 'color' | 'sixWayPos' | 'sixWayNeg' | 'motion' | 'emission';

export const OUTPUT_LABELS: Record<FxOutputKind, string> = {
  color: 'Colour', sixWayPos: 'Six-way +', sixWayNeg: 'Six-way −', motion: 'Motion vectors', emission: 'Emission',
};

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
  dims: FluidDims;
  /** Flipbook playback rate that matches the simulation's own time. */
  fps: number;
}

export interface GenerateFxOptions {
  /** Build the solver; defaults to the CPU one. The app passes the GPU factory when compute exists. */
  backend?: (dims: FluidDims) => FluidBackend;
  /** Called with each captured frame, for a live preview. */
  onFrame?: (index: number, tile: Uint8Array, size: number) => void;
}

export async function generateFx(raw: FxParams, ctx: GenerateContext = SILENT_CONTEXT, opts: GenerateFxOptions = {}): Promise<FxOutput> {
  const p = normaliseFx(raw);
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
    for (let f = 0; f < total; f++) {
      for (let s = 0; s < p.substeps; s++) await sim.step(p, dt);
      if (f >= p.warmup) {
        const tile = await sim.render(p, p.tileSize, lut);
        frames.push(tile);
        opts.onFrame?.(frames.length - 1, tile, p.tileSize);
        await captureExtras(sim, p, lut, captures);
      }
      ctx.progress((f + 1) / total, f < p.warmup ? 'Warming up' : `Frame ${f - p.warmup + 1} / ${captured}`);
      await yieldToUi();
      if (ctx.cancelled) throw new GenerationCancelled();
    }
    const layout = atlasLayout(p.frames, p.tileSize);
    const outputs: Partial<Record<FxOutputKind, FxAtlas>> = {};
    for (const [kind, all] of captures) {
      const head = all.slice(0, p.frames);
      if (tail > 0) loopBlend(head, all.slice(p.frames));
      const atlas = new Uint8Array(layout.width * layout.height * 4);
      head.forEach((t, i) => blitTile(atlas, layout, i, t));
      outputs[kind] = { atlas, frames: head };
    }
    const color = outputs.color!;
    return { layout, atlas: color.atlas, frames: color.frames, outputs, backend: sim.kind, dims, fps: Math.round(1 / p.frameTime) };
  } finally {
    sim.dispose();
  }
}

/** The outputs a bake of `p` makes, colour first. */
export function bakeKinds(p: Pick<FxParams, 'bakeSixWay' | 'bakeMotion' | 'bakeEmission'>): FxOutputKind[] {
  const kinds: FxOutputKind[] = ['color'];
  if (p.bakeSixWay) kinds.push('sixWayPos', 'sixWayNeg');
  if (p.bakeMotion) kinds.push('motion');
  if (p.bakeEmission) kinds.push('emission');
  return kinds;
}

/** `p` lit from `dir` (a unit vector toward the light, in grid space) instead of its own sun. */
export function litFrom(p: FxParams, dir: readonly number[]): FxParams {
  const el = Math.asin(Math.max(-1, Math.min(1, dir[1])));
  const yaw = Math.abs(dir[0]) + Math.abs(dir[2]) < 1e-9 ? 0 : Math.atan2(dir[0], dir[2]);
  return { ...p, lightYaw: (yaw * 180) / Math.PI, lightElevation: (el * 180) / Math.PI };
}

/** This frame's extra outputs, from the same simulation state as its colour tile. */
async function captureExtras(sim: FluidBackend, p: FxParams, lut: Float32Array, captures: Map<FxOutputKind, Uint8Array[]>): Promise<void> {
  const size = p.tileSize;
  const needEmission = captures.has('emission') || captures.has('sixWayNeg');
  const emission = needEmission ? await sim.render(p, size, lut, 'emission') : null;
  if (emission && captures.has('emission')) captures.get('emission')!.push(emission);
  if (captures.has('motion')) captures.get('motion')!.push(await sim.render(p, size, lut, 'motion'));
  if (captures.has('sixWayPos')) {
    // The six directions in the tile's own frame: right, top, back (away from the camera); and opposite.
    const b = viewBasis(sim.dims, p.view, p.yaw);
    const neg = (v: readonly number[]) => [-v[0], -v[1], -v[2]];
    const dirs = [b.right, b.up, b.dir, neg(b.right), neg(b.up), neg(b.dir)];
    const lit: Uint8Array[] = [];
    for (const d of dirs) lit.push(await sim.render(litFrom(p, d), size, lut, 'light'));
    const pos = new Uint8Array(size * size * 4), negT = new Uint8Array(size * size * 4);
    for (let i = 0; i < size * size; i++) {
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
};

/** The atlas PNG, a `.tileset` for it, and the sidecar with the particle flipbook block to paste. */
export async function exportFx(out: FxOutput, params: FxParams, name = 'fx'): Promise<ExportFile[]> {
  const png = `${name}_flipbook.png`;
  const tileset = tilesetJson(out.layout, `${name}-flipbook`, png, `${name} flipbook`, out.frames.length, params.emission > 0 ? 2 : 1);
  const files: ExportFile[] = [
    { name: png, mime: 'image/png', bytes: await encodePngRgba8(out.layout.width, out.layout.height, out.atlas) },
    { name: `${name}_flipbook.tileset`, mime: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(tileset, null, 2)) },
  ];
  const extras: Record<string, unknown> = {};
  for (const kind of Object.keys(OUTPUT_FILES) as (keyof typeof OUTPUT_FILES)[]) {
    const o = out.outputs?.[kind];
    if (!o) continue;
    const file = `${name}_${OUTPUT_FILES[kind]}.png`;
    files.push({ name: file, mime: 'image/png', bytes: await encodePngRgba8(out.layout.width, out.layout.height, o.atlas) });
    extras[kind] = file;
  }
  if (extras.sixWayPos) {
    extras.sixWay = {
      convention: 'Unity VFX Graph six-way: positive map RGB = lit from right, top, back, A = alpha; negative map RGB = lit from left, bottom, front, A = emission',
      positive: extras.sixWayPos, negative: extras.sixWayNeg,
    };
    delete extras.sixWayPos; delete extras.sixWayNeg;
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

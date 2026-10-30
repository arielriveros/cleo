// FX Creator's generate(): simulate, capture `frames` (+ the loop tail), pack the flipbook.
// The solver is behind `FluidBackend` so the GPU and CPU paths share the capture loop exactly.

import type { Texture } from 'cleo/graphics/texture';
import { encodePngRgba8 } from '../core/png';
import { SILENT_CONTEXT, sidecar, yieldToUi, GenerationCancelled, type ExportFile, type GenerateContext } from '../core/generator';
import { FluidCpu, fluidDims, type FluidDims, type SceneWind } from './fluidCpu';
import { atlasLayout, blitTile, loopBlend, particleFlipbook, tilesetJson, type AtlasLayout } from './flipbook';
import { normaliseFx, type FxParams } from './fxParams';
import { bakeFireLut, renderTile } from './volumeRender';

/** One simulation, wherever it runs. */
export interface FluidBackend {
  readonly kind: 'gpu' | 'cpu';
  readonly dims: FluidDims;
  step(p: FxParams, dt: number): void | Promise<void>;
  /** The current state as a tile x tile RGBA8 image (straight alpha, row 0 at the top). */
  render(p: FxParams, tile: number, lut: Float32Array): Promise<Uint8Array>;
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
    async render(p, tile, lut) {
      const out = new Uint8Array(tile * tile * 4);
      renderTile(fluid, p, out, tile, lut);
      return out;
    },
    setSolid(mask) { fluid.solid = mask; },
    setSceneWind(wind) { fluid.sceneWind = wind; },
    dispose() { /* garbage */ },
  };
}

export interface FxOutput {
  layout: AtlasLayout;
  /** The packed atlas, RGBA8, `layout.width` x `layout.height`. */
  atlas: Uint8Array;
  /** Each frame's tile, in order, after loop blending. */
  frames: Uint8Array[];
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
    const frames: Uint8Array[] = [];
    for (let f = 0; f < total; f++) {
      for (let s = 0; s < p.substeps; s++) await sim.step(p, dt);
      if (f >= p.warmup) {
        const tile = await sim.render(p, p.tileSize, lut);
        frames.push(tile);
        opts.onFrame?.(frames.length - 1, tile, p.tileSize);
      }
      ctx.progress((f + 1) / total, f < p.warmup ? 'Warming up' : `Frame ${f - p.warmup + 1} / ${captured}`);
      await yieldToUi();
      if (ctx.cancelled) throw new GenerationCancelled();
    }
    const head = frames.slice(0, p.frames);
    if (tail > 0) loopBlend(head, frames.slice(p.frames));
    const layout = atlasLayout(p.frames, p.tileSize);
    const atlas = new Uint8Array(layout.width * layout.height * 4);
    head.forEach((t, i) => blitTile(atlas, layout, i, t));
    return { layout, atlas, frames: head, backend: sim.kind, dims, fps: Math.round(1 / p.frameTime) };
  } finally {
    sim.dispose();
  }
}

/** The atlas PNG, a `.tileset` for it, and the sidecar with the particle flipbook block to paste. */
export async function exportFx(out: FxOutput, params: FxParams, name = 'fx'): Promise<ExportFile[]> {
  const png = `${name}_flipbook.png`;
  const tileset = tilesetJson(out.layout, `${name}-flipbook`, png, `${name} flipbook`, out.frames.length, params.emission > 0 ? 2 : 1);
  const files: ExportFile[] = [
    { name: png, mime: 'image/png', bytes: await encodePngRgba8(out.layout.width, out.layout.height, out.atlas) },
    { name: `${name}_flipbook.tileset`, mime: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(tileset, null, 2)) },
  ];
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
  });
  meta.name = `${name}.json`;
  files.push(meta);
  return files;
}

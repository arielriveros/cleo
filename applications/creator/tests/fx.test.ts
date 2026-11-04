import { describe, it, expect } from 'vitest';
import { parseParticleSystem } from 'cleo/particles/particleSystemAsset';
import { fnv1a } from '../src/core/generator';
import { inflateIdat } from '../src/core/png';
import { FluidCpu, fluidDims, hash3 } from '../src/fx/fluidCpu';
import { atlasLayout, blitTile, loopBlend, tileOrigin } from '../src/fx/flipbook';
import { DEFAULT_FX, FX_PRESETS, normaliseFx, type FxParams } from '../src/fx/fxParams';
import { exportFx, generateFx } from '../src/fx/generateFx';
import { viewBasis } from '../src/fx/volumeRender';

// Small enough to run in a second, big enough for a flame to form.
const tiny = (p: Partial<FxParams> = {}): FxParams =>
  normaliseFx({ ...DEFAULT_FX, regionSize: [1.6, 2.4, 1.6], voxelSize: 0.1, frames: 4, warmup: 6, tileSize: 16, loopBlend: 2, pressureIterations: 20, ...p });

describe('fluid solver', () => {
  it('projection removes most of the divergence of a smooth source', () => {
    // A Gaussian blob pushing outward: divergent everywhere it is non-zero. (The collocated grid cannot
    // see a voxel-scale checkerboard, so the test field is smooth, as advected flow is.)
    const fluid = new FluidCpu({ nx: 24, ny: 24, nz: 24 });
    for (let z = 0; z < 24; z++) for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) {
      const i = fluid.index(x, y, z);
      const dx = x - 11.5, dy = y - 11.5, dz = z - 11.5;
      const g = Math.exp(-(dx * dx + dy * dy + dz * dz) / 8);
      fluid.u[i] = dx * g; fluid.v[i] = dy * g; fluid.w[i] = dz * g;
    }
    const before = fluid.meanDivergence();
    fluid.project(60);
    expect(fluid.meanDivergence()).toBeLessThan(before * 0.3);
  });

  it('emits, ignites and rises', () => {
    const p = tiny();
    const fluid = new FluidCpu(fluidDims(p));
    for (let i = 0; i < 12; i++) fluid.step(p, p.frameTime / p.substeps);
    const { nx, ny, nz } = fluid.dims;
    // Heat has risen above the emitter, and the fuel has burned into smoke.
    let hotAbove = 0;
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) for (let y = Math.floor(ny * 0.4); y < ny; y++)
      hotAbove += fluid.temperature[fluid.index(x, y, z)];
    expect(hotAbove).toBeGreaterThan(0);
    expect(fluid.density.some(d => d > 0)).toBe(true);
    expect(fluid.u.every(Number.isFinite) && fluid.v.every(Number.isFinite)).toBe(true);
  });

  it('hashes integer voxels the same way every time', () => {
    expect(hash3(1, 2, 3, 4)).toBe(hash3(1, 2, 3, 4));
    expect(hash3(1, 2, 3, 4)).not.toBe(hash3(1, 2, 3, 5));
    expect(hash3(5, 6, 7, 8)).toBeGreaterThanOrEqual(0);
    expect(hash3(5, 6, 7, 8)).toBeLessThan(1);
  });
});

describe('flipbook', () => {
  it('lays frames out in the squarest grid', () => {
    expect(atlasLayout(16, 64)).toMatchObject({ columns: 4, rows: 4, width: 256, height: 256 });
    expect(atlasLayout(10, 32)).toMatchObject({ columns: 4, rows: 3 });
    expect(tileOrigin(atlasLayout(10, 32), 5)).toEqual([32, 32]);
  });

  it('blits a tile into its own cell only', () => {
    const layout = atlasLayout(4, 2);
    const atlas = new Uint8Array(layout.width * layout.height * 4);
    blitTile(atlas, layout, 3, new Uint8Array(2 * 2 * 4).fill(9));
    const at = (x: number, y: number) => atlas[(y * layout.width + x) * 4];
    expect(at(2, 2)).toBe(9);
    expect(at(3, 3)).toBe(9);
    expect(at(0, 0)).toBe(0);
    expect(at(1, 3)).toBe(0);
  });

  it('cross-fades the tail into the head so the seam is continuous', () => {
    const solid = (v: number) => new Uint8Array([v, v, v, 255]);
    const head = [solid(0), solid(0), solid(0)];
    const tail = [solid(240), solid(240)];
    loopBlend(head, tail);
    // Frame 0 is mostly tail (continuing the last frame), frame 1 less so, frame 2 untouched.
    expect(head[0][0]).toBe(160);
    expect(head[1][0]).toBe(80);
    expect(head[2][0]).toBe(0);
  });

  it('frames the whole domain for every view', () => {
    const dims = { nx: 16, ny: 32, nz: 16 };
    for (const view of ['front', 'side', 'top', 'angle'] as const) {
      const b = viewBasis(dims, view, 45);
      expect(b.half).toBeGreaterThan(7.5);
      expect(Math.hypot(...b.dir)).toBeCloseTo(1, 6);
    }
  });
});

describe('FX generation', () => {
  it('is deterministic for a seed and changes with it', async () => {
    const a = await generateFx(tiny());
    const b = await generateFx(tiny());
    expect(fnv1a(a.atlas)).toBe(fnv1a(b.atlas));
    const c = await generateFx(tiny({ seed: 99 }));
    expect(fnv1a(c.atlas)).not.toBe(fnv1a(a.atlas));
  });

  it('renders something visible into every frame', async () => {
    const out = await generateFx(tiny());
    expect(out.frames).toHaveLength(4);
    for (const f of out.frames) {
      let alpha = 0;
      for (let i = 3; i < f.length; i += 4) alpha = Math.max(alpha, f[i]);
      expect(alpha).toBeGreaterThan(20);
    }
    expect(out.backend).toBe('cpu');
  });

  it('runs every preset', async () => {
    for (const preset of FX_PRESETS) {
      const out = await generateFx({ ...preset.params, voxelSize: Math.max(...preset.params.regionSize) / 12, frames: 2, warmup: 2, tileSize: 8, loopBlend: 0 });
      expect(out.atlas.length, preset.id).toBe(out.layout.width * out.layout.height * 4);
    }
  });

  it('exports an RGBA atlas, a tileset and a flipbook block the engine accepts', async () => {
    const params = tiny();
    const out = await generateFx(params);
    const files = await exportFx(out, params, 'campfire');
    expect(files.map(f => f.name)).toEqual(['campfire_flipbook.png', 'campfire_flipbook.tileset', 'campfire.json']);

    const png = await inflateIdat(files[0].bytes);
    expect([png.width, png.height, png.colorType]).toEqual([out.layout.width, out.layout.height, 6]);

    const tileset = JSON.parse(new TextDecoder().decode(files[1].bytes));
    expect(tileset).toMatchObject({ columns: 2, rows: 2, tileWidth: 16, tileHeight: 16, textureId: 'campfire_flipbook.png' });

    // The flipbook block round-trips through the engine's own particle-system parser untouched.
    const meta = JSON.parse(new TextDecoder().decode(files[2].bytes));
    const system = parseParticleSystem({
      emitters: [{ id: 'e', name: 'fire', render: { textureId: tileset.id, flipbook: meta.output.particleFlipbook } }],
    });
    expect(system.emitters[0].render.flipbook).toMatchObject({ columns: 2, rows: 2, frames: 4, mode: 'fps' });
  });
});

describe('live preview', () => {
  it('takes whole frames and carries the remainder', async () => {
    const { takeFrames } = await import('../src/fx/liveSim');
    let s = takeFrames(0, 0.03, 1 / 24);
    expect(s.frames).toBe(0);
    s = takeFrames(s.accumulator, 0.03, 1 / 24);
    expect(s.frames).toBe(1);
    expect(s.accumulator).toBeCloseTo(0.06 - 1 / 24, 6);
  });

  it('drops time debt past the per-tick cap instead of repaying it', async () => {
    const { takeFrames, MAX_FRAMES_PER_TICK } = await import('../src/fx/liveSim');
    const s = takeFrames(0, 1, 1 / 24);
    expect(s.frames).toBe(MAX_FRAMES_PER_TICK);
    expect(s.accumulator).toBe(0);
  });

  it('trades pressure iterations for speed only in the preview', async () => {
    const { previewParams } = await import('../src/fx/liveSim');
    const high = previewParams({ ...DEFAULT_FX, previewQuality: 'high' });
    const low = previewParams({ ...DEFAULT_FX, previewQuality: 'low' });
    // The preview always runs the warm-started SOR, which needs fewer iterations than the authored Jacobi.
    expect(high.pressureSolver).toBe('sor');
    expect(high.pressureIterations).toBeLessThanOrEqual(DEFAULT_FX.pressureIterations);
    expect(low.pressureIterations).toBeLessThan(high.pressureIterations);
    // Bakes use the authored value: generateFx never sees previewParams.
    expect(DEFAULT_FX.previewQuality).toBe('medium');
  });

  it('packs the CPU volume as density, temperature, light, fire glow with x fastest', async () => {
    const { packVolumeCpu } = await import('../src/fx/volumeRender');
    const p = tiny();
    const fluid = new FluidCpu(fluidDims(p));
    for (let i = 0; i < 6; i++) fluid.step(p, p.frameTime / p.substeps);
    const out = packVolumeCpu(fluid, p, new Float32Array(fluid.count * 4));
    const i = fluid.index(3, 5, 7);
    expect(out[i * 4]).toBe(fluid.density[i]);
    expect(out[i * 4 + 1]).toBe(fluid.temperature[i]);
    expect(out[i * 4 + 3]).toBe(0);   // fireGlow is 0 by default: no glow channel
    for (let k = 2; k < out.length; k += 4) {
      expect(out[k]).toBeGreaterThanOrEqual(0);
      expect(out[k]).toBeLessThanOrEqual(1);
    }
  });
});

describe('the region is room around a gas effect', () => {
  it('reads a format-1 save as the same effect in metres, once', () => {
    const v1 = { ...DEFAULT_FX, regionSize: [4.8, 7.2, 4.8], voxelSize: 0.1, emitterX: 0.25, emitterZ: 0.5, emitterHeight: 0.1, emitterRadius: 0.12, turbulenceScale: 4 } as Record<string, unknown>;
    delete v1.version; delete v1.emitterPosition; delete v1.turbulenceSize;
    const p = normaliseFx(v1 as unknown as FxParams);
    expect(p.version).toBe(3);
    // Where format 1 put it: on its grid's voxel centres (48 x 72 x 48 of 0.1 m), from the floor's centre.
    expect(p.emitterPosition[0]).toBeCloseTo((0.25 * 47 + 0.5) * 0.1 - 2.4, 9);
    expect(p.emitterPosition[1]).toBeCloseTo((0.1 * 71 + 0.5) * 0.1, 9);
    expect(p.emitterPosition[2]).toBeCloseTo((0.5 * 47 + 0.5) * 0.1 - 2.4, 9);
    expect(p.emitterRadius).toBeCloseTo(0.576, 9);
    expect(p.turbulenceSize).toBeCloseTo(1.2, 9);
    for (const k of ['emitterX', 'emitterZ', 'emitterHeight', 'turbulenceScale', 'sourceHeight']) expect(k in p, k).toBe(false);
    expect(normaliseFx(p)).toEqual(p);
    // A liquid's source: fractions of the region in metres, its height as it was.
    const l1 = { ...v1, medium: 'liquid', regionSize: [2, 1.3, 2], emitterX: 0.5, emitterZ: 0.2, sourceHeight: 1 };
    const l = normaliseFx(l1 as unknown as FxParams);
    expect(l.emitterPosition[0]).toBeCloseTo(0, 9);
    expect(l.emitterPosition[1]).toBeCloseTo(1, 9);
    expect(l.emitterPosition[2]).toBeCloseTo(-0.6, 9);
  });

  it('writes every preset in metres', () => {
    for (const preset of FX_PRESETS) {
      const raw = preset.params as unknown as Record<string, unknown>;
      expect(raw.version, preset.id).toBe(3);
      expect(Array.isArray(raw.emitterPosition), preset.id).toBe(true);
      for (const k of ['emitterX', 'emitterZ', 'emitterHeight', 'turbulenceScale', 'sourceHeight']) expect(raw[k], `${preset.id} ${k}`).toBeUndefined();
    }
  });

  /** A flame for 12 substeps; its density inside the original region's box, `shift` voxels in along x. */
  const flame = (p: FxParams, shift: number, w: number) => {
    const f = new FluidCpu(fluidDims(p));
    for (let i = 0; i < 12; i++) f.step(p, p.frameTime / p.substeps);
    let total = 0, cx = 0, cy = 0;
    for (let z = 0; z < f.dims.nz; z++) for (let y = 0; y < f.dims.ny; y++) for (let x = 0; x < w; x++) {
      const d = f.density[f.index(x + shift, y, z)];
      total += d; cx += x * d; cy += y * d;
    }
    return { f, total, cx: cx / total, cy: cy / total };
  };

  it('keeps the effect its size and place as the region grows on any side', () => {
    const base = tiny({ seed: 3, emitterPosition: [0, 0.35, 0], emitterRadius: 0.25 });
    const a = flame(base, 0, 16);
    // Grown 0.8 m on -X: the floor's centre moved 0.4 m toward -X, so the emitter is 0.4 m further +X of it.
    const minusX = flame(normaliseFx({ ...base, regionSize: [2.4, 2.4, 1.6], emitterPosition: [0.4, 0.35, 0] }), 8, 16);
    // On +X, and upward: the original box at the grid's start.
    const plusX = flame(normaliseFx({ ...base, regionSize: [2.4, 2.4, 1.6], emitterPosition: [-0.4, 0.35, 0] }), 0, 16);
    const up = flame(normaliseFx({ ...base, regionSize: [1.6, 3.6, 1.6] }), 0, 16);
    expect(a.total).toBeGreaterThan(1);
    for (const [name, b] of [['-X', minusX], ['+X', plusX], ['up', up]] as const) {
      expect(Math.abs(b.total - a.total) / a.total, name).toBeLessThan(0.15);
      expect(Math.abs(b.cx - a.cx), name).toBeLessThan(0.5);
      expect(Math.abs(b.cy - a.cy), name).toBeLessThan(0.5);
    }
  });

  it('lights the stage by how much burns, not by how big the region is', async () => {
    const { fireLightOf } = await import('../src/fx/volumeRender');
    const base = tiny({ seed: 3, emitterPosition: [0, 0.35, 0], emitterRadius: 0.25 });
    const small = fireLightOf(flame(base, 0, 16).f, base)[3];
    const big = normaliseFx({ ...base, regionSize: [3.2, 2.4, 3.2] });
    const large = fireLightOf(flame(big, 8, 16).f, big)[3];
    expect(small).toBeGreaterThan(0);
    expect(Math.abs(large - small) / small).toBeLessThan(0.15);
  });
});

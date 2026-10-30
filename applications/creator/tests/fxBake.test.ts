import { describe, it, expect } from 'vitest';
import { blackbodyRgb } from '../src/fx/blackbody';
import { FluidCpu, fluidDims } from '../src/fx/fluidCpu';
import { DEFAULT_FX, FX_SCHEMA, normaliseFx, type FxParams } from '../src/fx/fxParams';
import { BAKE_PRESETS } from '../src/fx/fxPresets';
import { exportFx, generateFx, litFrom } from '../src/fx/generateFx';
import { bakeFireLut, renderTile, viewBasis } from '../src/fx/volumeRender';

// The research pass: physical fire colour, the Nguyen temperature model, chromatic extinction, and the
// Bake tab's extra outputs (six-way lightmaps, motion vectors, emission).

const small = (p: Partial<FxParams> = {}): FxParams =>
  normaliseFx({ ...DEFAULT_FX, regionSize: [2, 2, 2], voxelSize: 0.1, pressureIterations: 12, ...p });

/** A ball of still smoke in the middle of the grid. */
const smokeBall = (p: FxParams) => {
  const f = new FluidCpu(fluidDims(p));
  const { nx, ny, nz } = f.dims;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const r = Math.hypot(x - (nx - 1) / 2, y - (ny - 1) / 2, z - (nz - 1) / 2);
    if (r < nx * 0.35) f.density[f.index(x, y, z)] = 1.5;
  }
  return f;
};
const lum = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

describe('physical blackbody', () => {
  it('reads white at the adapted white point and red when cool, brightening with temperature', () => {
    const white = blackbodyRgb(1800, 1800);
    expect(Math.abs(white[0] - white[2])).toBeLessThan(0.05);
    expect(lum(white)).toBeCloseTo(1, 1);
    const cool = blackbodyRgb(900, 1800);
    expect(cool[0]).toBeGreaterThan(cool[1] * 1.5);
    expect(cool[1]).toBeGreaterThan(cool[2]);
    let last = 0;
    for (let k = 800; k <= 1800; k += 100) { const l = lum(blackbodyRgb(k, 1800)); expect(l).toBeGreaterThan(last); last = l; }
  });

  it('bakes the LUT from it: dark red at the bottom, near-white at the top', () => {
    const lut = bakeFireLut({ ...DEFAULT_FX, fireColorMode: 'blackbody', blackbodyMin: 900, blackbodyMax: 1800 });
    expect(lut[0]).toBeGreaterThan(lut[2]);
    const top = [lut[255 * 4], lut[255 * 4 + 1], lut[255 * 4 + 2]];
    expect(Math.min(...top)).toBeGreaterThan(0.85);
  });
});

describe('Nguyen temperature model', () => {
  it('never heats past the maximum temperature', () => {
    const p = small({ maxTemperature: 1.2, heatRelease: 6, burnRate: 6, fuel: 4, heat: 0 });
    const f = new FluidCpu(fluidDims(p));
    for (let i = 0; i < 20; i++) f.step(p, p.frameTime / p.substeps);
    expect(Math.max(...Array.from(f.temperature))).toBeLessThanOrEqual(1.2 + 1e-4 + p.heat);
  });
});

describe('shading', () => {
  it('a white absorption colour renders exactly like scalar extinction', () => {
    const p = small();
    const f = smokeBall(p);
    const lut = bakeFireLut(p);
    const a = new Uint8Array(32 * 32 * 4), b = new Uint8Array(32 * 32 * 4);
    renderTile(f, { ...p, absorptionColor: [1, 1, 1, 1] }, a, 32, lut);
    renderTile(f, { ...p, absorptionColor: undefined as unknown as FxParams['absorptionColor'] }, b, 32, lut);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('a warm absorption colour lets red through thin smoke more than blue', () => {
    const p = small({ smokeColor: [1, 1, 1, 1], ambient: 1 });
    const f = smokeBall(p);
    const out = new Uint8Array(32 * 32 * 4);
    renderTile(f, { ...p, absorptionColor: [0.425, 0.36, 0.3, 1] }, out, 32, bakeFireLut(p));
    let r = 0, b = 0;
    for (let i = 0; i < 32 * 32; i++) if (out[i * 4 + 3] > 10) { r += out[i * 4]; b += out[i * 4 + 2]; }
    expect(r).toBeGreaterThan(b);
  });
});

describe('bake outputs', () => {
  it('a six-way light from the right lights the right half of the tile', () => {
    const p = small({ absorption: 3 });
    const f = smokeBall(p);
    const b = viewBasis(f.dims, p.view, p.yaw);
    const out = new Uint8Array(32 * 32 * 4);
    renderTile(f, litFrom(p, b.right), out, 32, bakeFireLut(p), 'light');
    let left = 0, right = 0;
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const k = (y * 32 + x) * 4;
      if (out[k + 3] < 10) continue;
      if (x < 16) left += out[k]; else right += out[k];
    }
    expect(right).toBeGreaterThan(left * 1.3);
  });

  it('motion vectors of rising smoke read upward', () => {
    const p = small();
    const f = smokeBall(p);
    f.v.fill(20);
    const out = new Uint8Array(32 * 32 * 4);
    renderTile(f, p, out, 32, bakeFireLut(p), 'motion');
    let g = 0, n = 0;
    for (let i = 0; i < 32 * 32; i++) if (out[i * 4 + 3] > 10) { g += out[i * 4 + 1]; n++; }
    expect(n).toBeGreaterThan(0);
    expect(g / n).toBeGreaterThan(140);
  });

  it('exports every output it baked, and notes the conventions in the sidecar', async () => {
    const p = small({ frames: 2, warmup: 1, loopBlend: 0, tileSize: 64, bakeSixWay: true, bakeMotion: true, bakeEmission: true });
    const out = await generateFx(p);
    expect(Object.keys(out.outputs).sort()).toEqual(['color', 'emission', 'motion', 'sixWayNeg', 'sixWayPos']);
    const files = await exportFx(out, p, 'fire');
    const names = files.map(f => f.name);
    for (const n of ['fire_flipbook.png', 'fire_6way_pos.png', 'fire_6way_neg.png', 'fire_motion.png', 'fire_emission.png']) expect(names).toContain(n);
    const meta = JSON.parse(new TextDecoder().decode(files.find(f => f.name === 'fire.json')!.bytes));
    expect(JSON.stringify(meta)).toContain('6way_pos');
    expect(JSON.stringify(meta)).toContain('motionScale');
  });

  it('bakes only the colour flipbook by default', async () => {
    const out = await generateFx(small({ frames: 1, warmup: 0, loopBlend: 0, tileSize: 64 }));
    expect(Object.keys(out.outputs)).toEqual(['color']);
  });
});

describe('the Bake tab', () => {
  it('holds the flipbook and output sections, and its presets touch only them', () => {
    const bake = FX_SCHEMA.filter(g => g.side === 'bake');
    expect(bake.map(g => g.title)).toEqual(['Flipbook', 'Outputs']);
    const keys = new Set(bake.flatMap(g => g.specs.map(s => s.key)));
    expect(keys.has('warmup')).toBe(true);
    for (const preset of BAKE_PRESETS) for (const k of Object.keys(preset.values)) expect(keys.has(k), `${preset.label}: ${k}`).toBe(true);
  });
});

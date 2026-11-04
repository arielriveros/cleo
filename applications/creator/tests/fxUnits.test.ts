import { describe, it, expect } from 'vitest';
import { FluidCpu, fluidDims } from '../src/fx/fluidCpu';
import { DEFAULT_FX, FX_PRESETS, FX_SCHEMA, normaliseFx, type FxParams } from '../src/fx/fxParams';
import { FX_UNITS, similarity, solverUnits } from '../src/fx/fxUnits';

// The parameters' units: SI in the saves, per voxel in the solver, and the similarity that makes an effect
// bigger or smaller without changing how it looks.

const numeric = (v: unknown) => typeof v === 'number' || (Array.isArray(v) && v.every(x => typeof x === 'number'));

describe('the unit table', () => {
  it('knows every numeric parameter', () => {
    for (const [key, value] of Object.entries(DEFAULT_FX)) {
      if (!numeric(value)) continue;
      expect(FX_UNITS[key], key).toBeDefined();
    }
    for (const spec of FX_SCHEMA.flatMap(g => g.specs)) {
      if (spec.kind === 'float' || spec.kind === 'int' || spec.kind === 'vec3' || spec.kind === 'range') expect(FX_UNITS[spec.key], spec.key).toBeDefined();
    }
  });
});

describe('format 3: the gas solver in SI', () => {
  it('reads a format-2 save as the same per-voxel solver it ran', () => {
    // Format 2: speeds and forces per voxel, vorticity scaled by v / 0.1 in the solver, diffusion x 60 per step.
    const v2 = { ...DEFAULT_FX, version: 2, regionSize: [3, 4, 3], voxelSize: 0.05, emitSpeed: 6, wind: 2, turbulence: 8, disturbance: 10,
      buoyancy: 14, weight: 1.5, vorticity: 0.35, diffusion: 0.01, settling: 0.2 } as FxParams;
    const p = normaliseFx(v2);
    expect(p.version).toBe(3);
    expect(p.emitSpeed).toBeCloseTo(0.3, 12);
    expect(p.buoyancy).toBeCloseTo(0.7, 12);
    const s = solverUnits(p);
    for (const k of ['emitSpeed', 'wind', 'turbulence', 'disturbance', 'buoyancy', 'weight'] as const) expect(s[k], k).toBeCloseTo(v2[k] as number, 12);
    // The solver's confinement epsilon: what format 2 multiplied by v / 0.1 inside it.
    expect(s.vorticity).toBeCloseTo(0.35 * 0.5, 12);
    expect(s.diffusion).toBeCloseTo(0.01, 12);
    // Settling and the rates were SI already.
    expect(s.settling).toBe(0.2);
    expect(s.cooling).toBe(v2.cooling);
    // Once.
    expect(normaliseFx(p)).toEqual(p);
  });
});

describe('similarity', () => {
  /** A flame with nothing on a fixed clock (emitter noise, blast, wind), so the similarity is exact. */
  const flame = normaliseFx({
    ...DEFAULT_FX, regionSize: [1.6, 2.4, 1.6], voxelSize: 0.1, emitterPosition: [0, 0.3, 0], emitterRadius: 0.3, turbulenceSize: 0.6,
    pressureIterations: 12, emitterNoise: 0, blast: 0, wind: 0, flicker: 2, disturbance: 1, disturbanceScale: 0.3, disturbanceInterval: 0.2,
    diffusion: 0.002, settling: 0.1,
  });

  it('scales every parameter by its unit', () => {
    const q = similarity(flame, 0.25);
    expect(q.regionSize[1]).toBeCloseTo(0.6, 12);
    expect(q.voxelSize).toBeCloseTo(0.025, 12);
    expect(q.emitSpeed).toBeCloseTo(flame.emitSpeed * 0.5, 12);
    expect(q.buoyancy).toBe(flame.buoyancy);
    expect(q.cooling).toBeCloseTo(flame.cooling * 2, 12);
    expect(q.frameTime).toBeCloseTo(flame.frameTime * 0.5, 12);
    expect(q.diffusion).toBeCloseTo(flame.diffusion * 0.125, 12);
    expect(q.fuel).toBe(flame.fuel);
    expect(fluidDims(q)).toEqual(fluidDims(flame));
  });

  it('runs the same simulation in voxel space, at any size', () => {
    const q = normaliseFx(similarity(flame, 0.25));
    const a = new FluidCpu(fluidDims(flame)), b = new FluidCpu(fluidDims(q));
    for (let i = 0; i < 16; i++) {
      a.step(flame, flame.frameTime / flame.substeps);
      b.step(q, q.frameTime / q.substeps);
    }
    let diff = 0, peak = 0;
    for (let i = 0; i < a.count; i++) {
      diff = Math.max(diff, Math.abs(a.density[i] - b.density[i]), Math.abs(a.temperature[i] - b.temperature[i]));
      peak = Math.max(peak, a.density[i], a.temperature[i]);
    }
    expect(peak).toBeGreaterThan(0.1);
    expect(diff / peak).toBeLessThan(1e-3);
  });
});

describe('the presets', () => {
  it('are format 3 and inside their sliders', () => {
    const specs = FX_SCHEMA.flatMap(g => g.specs);
    for (const preset of FX_PRESETS) {
      const raw = preset.params as unknown as Record<string, unknown>;
      expect(raw.version, preset.id).toBe(3);
      const p = normaliseFx(preset.params) as unknown as Record<string, unknown>;
      for (const spec of specs) {
        if (spec.kind !== 'float' && spec.kind !== 'int') continue;
        if (spec.when && !spec.when(p as never)) continue;
        const x = p[spec.key] as number;
        if (typeof x !== 'number') continue;
        if (spec.min !== undefined) expect(x, `${preset.id} ${spec.key}`).toBeGreaterThanOrEqual(spec.min);
        if (spec.max !== undefined) expect(x, `${preset.id} ${spec.key}`).toBeLessThanOrEqual(spec.max);
      }
    }
  });
});

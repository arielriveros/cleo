import { describe, it, expect } from 'vitest';
import { FluidCpu, emitterVoxels, fluidDims, removeNetForce } from '../src/fx/fluidCpu';
import { DEFAULT_FX, FX_PRESETS, normaliseFx, type FxParams } from '../src/fx/fxParams';
import { newBody, type FxBody } from '../src/fx/fxScene';
import { bodyDistance, voxelizeBodies } from '../src/fx/obstacles';
import { sceneWindOf, VOXEL_SIZE } from '../src/fx/liveSim';
import { DEFAULT_SCENE } from '../src/fx/fxScene';
import { bakeFireLut, phaseScale, sunScatter } from '../src/fx/volumeRender';

// The preview stage reaching the solver (bodies, wind) and the realism settings shared by every renderer.

const small = (p: Partial<FxParams> = {}): FxParams =>
  normaliseFx({ ...DEFAULT_FX, regionSize: [2, 3, 2], voxelSize: 0.1, frameTime: 1 / 24, pressureIterations: 20, ...p });

const sphere = (r: number, at: [number, number, number]): FxBody =>
  ({ id: 's', kind: 'sphere', position: at, yaw: 0, pitch: 0, size: [2 * r, 2 * r, 2 * r], visible: true });

describe('placed bodies', () => {
  it('voxelise to about their own volume, centred where they are', () => {
    const dims = { nx: 40, ny: 40, nz: 40 };
    const r = 1;   // metres = 10 voxels
    const mask = voxelizeBodies([sphere(r, [0, 2, 0])], dims, VOXEL_SIZE)!;
    const count = mask.reduce((a, v) => a + v, 0);
    const expected = (4 / 3) * Math.PI * (r / VOXEL_SIZE) ** 3;
    expect(Math.abs(count - expected) / expected).toBeLessThan(0.08);
    // Symmetric about the box's centre column in x.
    const at = (x: number, y: number, z: number) => mask[x + 40 * (y + 40 * z)];
    for (let y = 0; y < 40; y++) for (let z = 0; z < 40; z++) for (let x = 0; x < 20; x++) expect(at(x, y, z)).toBe(at(39 - x, y, z));
  });

  it('turns and stretches every kind by its own transform', () => {
    const wall: FxBody = { ...newBody('wall', [4, 4, 4]), position: [0, 0, 0], yaw: 90, pitch: 0, size: [0.2, 2, 4] };
    // Yawed 90 degrees, the 4 m depth now runs along x.
    expect(bodyDistance(wall, [1.9, 0, 0])).toBeLessThan(0);
    expect(bodyDistance(wall, [0, 0, 1.9])).toBeGreaterThan(0);
    const capsule: FxBody = { ...newBody('capsule', [4, 4, 4]), position: [0, 0, 0], yaw: 0, pitch: 0, size: [0.4, 2, 0.4] };
    expect(bodyDistance(capsule, [0, 0.95, 0])).toBeLessThan(0);
    expect(bodyDistance(capsule, [0, 1.05, 0])).toBeGreaterThan(0);
  });

  it('give no mask when none is visible, so the solver keeps its plain path', () => {
    expect(voxelizeBodies([{ ...sphere(1, [0, 1, 0]), visible: false }], { nx: 20, ny: 20, nz: 20 }, VOXEL_SIZE)).toBeNull();
  });

  it('keep the gas out and spread it underneath a lid', () => {
    const p = small();
    const dims = fluidDims(p);
    const lid: FxBody = { id: 'lid', kind: 'box', position: [0, dims.ny * VOXEL_SIZE * 0.45, 0], yaw: 0, pitch: 0, size: [dims.nx * VOXEL_SIZE * 0.5, 0.3, dims.nz * VOXEL_SIZE * 0.5], visible: true };
    const mask = voxelizeBodies([lid], dims, VOXEL_SIZE)!;
    const run = (solid: Uint8Array | null) => {
      const f = new FluidCpu(dims);
      f.solid = solid;
      for (let i = 0; i < 40; i++) f.step(p, p.frameTime / p.substeps);
      return f;
    };
    const open = run(null), covered = run(mask);
    let inside = 0;
    for (let i = 0; i < covered.count; i++) if (mask[i]) inside += covered.density[i] + covered.temperature[i];
    expect(inside).toBe(0);
    // Above the lid there is less gas than in open air: the lid holds it back.
    const above = (f: FluidCpu) => {
      let s = 0;
      for (let z = 0; z < dims.nz; z++) for (let y = Math.ceil(dims.ny * 0.6); y < dims.ny; y++) for (let x = 0; x < dims.nx; x++) s += f.density[f.index(x, y, z)];
      return s;
    };
    expect(above(covered)).toBeLessThan(above(open));
  });
});

describe('scene wind', () => {
  it('is converted to voxel units in the WindNode direction convention', () => {
    const w = sceneWindOf({ ...DEFAULT_SCENE, wind: true, windDirection: 90, windStrength: 2 })!;
    expect(w.vx).toBeCloseTo(0, 6);
    expect(w.vz).toBeCloseTo(-2 / VOXEL_SIZE, 6);
    expect(sceneWindOf({ ...DEFAULT_SCENE, wind: false })).toBeNull();
  });

  it('carries the plume downwind', () => {
    const p = small();
    const dims = fluidDims(p);
    const centroidX = (wind: boolean) => {
      const f = new FluidCpu(dims);
      f.sceneWind = wind ? { vx: 12, vz: 0, gustiness: 0, gustScale: 10, gustSpeed: 0 } : null;
      for (let i = 0; i < 30; i++) f.step(p, p.frameTime / p.substeps);
      let sx = 0, sw = 0;
      for (let z = 0; z < dims.nz; z++) for (let y = 0; y < dims.ny; y++) for (let x = 0; x < dims.nx; x++) { const d = f.density[f.index(x, y, z)]; sx += x * d; sw += d; }
      return sx / sw;
    };
    expect(centroidX(true)).toBeGreaterThan(centroidX(false) + 0.5);
  });
});

describe('no drift without wind', () => {
  /** The density-weighted centroid's x and z, voxels from the emitter's column. */
  const centroid = (f: FluidCpu, p: FxParams) => {
    const e = emitterVoxels(p, f.dims);
    let sx = 0, sz = 0, sw = 0;
    for (let z = 0; z < f.dims.nz; z++) for (let y = 0; y < f.dims.ny; y++) for (let x = 0; x < f.dims.nx; x++) {
      const i = f.index(x, y, z);
      const d = f.density[i] + f.temperature[i];
      sx += (x - e.x) * d; sz += (z - e.z) * d; sw += d;
    }
    return [sx / sw, sz / sw];
  };

  it('keeps a symmetric flame on its emitter: the solver itself has no side', () => {
    const p = small({ turbulence: 0, disturbance: 0, emitterNoise: 0 });
    const f = new FluidCpu(fluidDims(p));
    for (let i = 0; i < 120; i++) f.step(p, p.frameTime / p.substeps);
    const [x, z] = centroid(f, p);
    expect(Math.abs(x)).toBeLessThan(1e-3);
    expect(Math.abs(z)).toBeLessThan(1e-3);
  });

  it('lets the realistic campfire sway but not slide away', () => {
    // Coarse voxels (format 3: the detail only) to keep it quick. Before the fix its smoke was 0.25 m off
    // the fire after three seconds and still going; now it sways within a few centimetres.
    const preset = FX_PRESETS.find(q => q.id === 'campfire-hq')!.params;
    const p = normaliseFx({ ...preset, voxelSize: preset.voxelSize * 3 });
    const f = new FluidCpu(fluidDims(p));
    const dt = p.frameTime / p.substeps;
    for (let i = 0, n = Math.round(3 / dt); i < n; i++) f.step(p, dt);
    const [x, z] = centroid(f, p);
    expect(Math.hypot(x, z) * p.voxelSize).toBeLessThan(0.08);
  }, 60_000);

  it('takes the net push out of the random forcing, so it only stirs', () => {
    let s = 7;
    const rand = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
    const n = 5000;
    const fx = new Float32Array(n), fy = new Float32Array(n), fz = new Float32Array(n), w = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      w[i] = rand() < 0.3 ? rand() : 0;
      fx[i] = w[i] * (rand() * 2 - 0.6); fy[i] = w[i] * (rand() * 2 - 1); fz[i] = w[i] * (rand() * 2 - 1.3);
    }
    const before = fx.slice();
    removeNetForce(fx, fy, fz, w);
    const sum = (a: Float32Array) => a.reduce((t, x) => t + x, 0);
    const weight = sum(w);
    for (const a of [fx, fy, fz]) expect(Math.abs(sum(a)) / weight).toBeLessThan(1e-5);
    // Unweighted voxels are untouched; the rest keep their own swirl, less their share of the net push.
    for (let i = 0; i < n; i++) if (w[i] === 0) expect(fx[i]).toBe(before[i]);
  });
});

describe('solver options', () => {
  const blob = () => {
    const f = new FluidCpu({ nx: 20, ny: 20, nz: 20 });
    for (let z = 0; z < 20; z++) for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) {
      const i = f.index(x, y, z);
      const dx = x - 9.5, dy = y - 9.5, dz = z - 9.5;
      const g = Math.exp(-(dx * dx + dy * dy + dz * dz) / 8);
      f.u[i] = dx * g; f.v[i] = dy * g; f.w[i] = dz * g;
    }
    return f;
  };

  it('red-black SOR removes more divergence than Jacobi in the same iterations', () => {
    const jacobi = blob(); jacobi.project(12);
    const sor = blob(); sor.project(12, { sor: true });
    expect(sor.meanDivergence()).toBeLessThan(jacobi.meanDivergence());
  });

  it('combustion expansion pushes outward where fuel burns', () => {
    const p = small({ fuel: 2, heat: 2 });
    const spread = (expansion: number) => {
      const f = new FluidCpu(fluidDims(p));
      for (let i = 0; i < 6; i++) f.step({ ...p, expansion }, p.frameTime / p.substeps);
      return f.meanDivergence();
    };
    expect(spread(4)).toBeGreaterThan(spread(0));
  });

  it('MacCormack stays bounded and deterministic', () => {
    const p = small({ advection: 'maccormack', emitterNoise: 0.5 });
    const a = new FluidCpu(fluidDims(p)), b = new FluidCpu(fluidDims(p));
    for (let i = 0; i < 10; i++) { a.step(p, 0.02); b.step(p, 0.02); }
    expect(Array.from(a.density)).toEqual(Array.from(b.density));
    for (const v of a.density) expect(v).toBeGreaterThanOrEqual(0);
  });
});

describe('look', () => {
  it('blackbody fire gets brighter and bluer-white as it gets hotter', () => {
    const lut = bakeFireLut({ ...DEFAULT_FX, fireColorMode: 'blackbody' });
    const lum = (i: number) => 0.2126 * lut[i * 4] + 0.7152 * lut[i * 4 + 1] + 0.0722 * lut[i * 4 + 2];
    for (let i = 1; i < 256; i++) expect(lum(i)).toBeGreaterThanOrEqual(lum(i - 1) - 1e-6);
    // Cool end red-dominated, hot end closer to white.
    expect(lut[0] / Math.max(1e-6, lut[2])).toBeGreaterThan(lut[255 * 4] / Math.max(1e-6, lut[255 * 4 + 2]));
  });

  it('isotropic, single scattering changes nothing', () => {
    expect(phaseScale(0.3, 0)).toBe(1);
    expect(sunScatter(0.42, 0.7, 0, 1)).toBeCloseTo(0.42, 9);
    // Forward scattering brightens toward the light and dims away from it.
    expect(phaseScale(1, 0.5)).toBeGreaterThan(1);
    expect(phaseScale(-1, 0.5)).toBeLessThan(1);
  });
});

describe('the simulation region', () => {
  it('turns a pre-region save into the region it described', async () => {
    const { normaliseFx: norm } = await import('../src/fx/fxParams');
    const old = norm({ ...DEFAULT_FX, resolution: 40, heightRatio: 2 } as FxParams);
    expect(old.resolution).toBeUndefined();
    expect(old.voxelSize).toBeCloseTo(0.1, 9);
    expect(old.regionSize.map(v => +v.toFixed(6))).toEqual([4, 8, 4]);
    expect(fluidDims(old)).toEqual({ nx: 40, ny: 80, nz: 40 });
    // The defaults are the grid the FX Creator always had.
    expect(fluidDims(norm(DEFAULT_FX))).toEqual({ nx: 48, ny: 72, nz: 48 });
  });

  it('keeps the voxel size and grows the grid with the box, each axis on its own', () => {
    const d = fluidDims(normaliseFx({ ...DEFAULT_FX, regionSize: [6, 3, 1.5], voxelSize: 0.05 }));
    expect(d).toEqual({ nx: 120, ny: 60, nz: 30 });
  });

  it('raises the voxel size when the region would need too many voxels', async () => {
    const { MAX_VOXELS, voxelSizeRaised } = await import('../src/fx/fxParams');
    const raw = { ...DEFAULT_FX, regionSize: [20, 20, 20] as [number, number, number], voxelSize: 0.05 };
    const p = normaliseFx(raw);
    const d = fluidDims(p);
    expect(d.nx * d.ny * d.nz).toBeLessThanOrEqual(MAX_VOXELS * 1.02);
    expect(voxelSizeRaised(raw)).toBe(true);
    expect(voxelSizeRaised(DEFAULT_FX)).toBe(false);
  });

  it('puts the emitter where its position says, in metres from the centre of the floor', () => {
    const centroidX = (x: number) => {
      const p = small({ emitterPosition: [x, 0.4, 0], emitterRadius: 0.2, fuel: 0, heat: 0.5, smoke: 2 });
      const f = new FluidCpu(fluidDims(p));
      for (let i = 0; i < 8; i++) f.step(p, p.frameTime / p.substeps);
      let sx = 0, sw = 0;
      for (let i = 0, z = 0; z < f.dims.nz; z++) for (let y = 0; y < f.dims.ny; y++) for (let x = 0; x < f.dims.nx; x++, i++) { sx += x * f.density[i]; sw += f.density[i]; }
      // Metres from the floor's centre.
      return (sx / sw + 0.5) * p.voxelSize - (f.dims.nx * p.voxelSize) / 2;
    };
    expect(centroidX(-0.5)).toBeCloseTo(-0.5, 0);
    expect(centroidX(0.5)).toBeCloseTo(0.5, 0);
  });

  it('voxelises bodies against a moved region', () => {
    const dims = { nx: 20, ny: 20, nz: 20 };
    const v = 0.1;
    // Region floor centre at (5, 0, 0): a sphere there lands in the middle of the grid, not off its edge.
    const origin: [number, number, number] = [5 - 1, 0, -1];
    const mask = voxelizeBodies([sphere(0.3, [5, 1, 0])], dims, v, origin)!;
    expect(mask[10 + 20 * (10 + 20 * 10)]).toBe(1);
    expect(voxelizeBodies([sphere(0.3, [0, 1, 0])], dims, v, origin)).toBeNull();
  });
});

describe('presets', () => {
  it('all normalise and simulate a few steps without NaN', async () => {
    const { FX_PRESETS } = await import('../src/fx/fxParams');
    for (const preset of FX_PRESETS) {
      // Coarsened so the whole set runs quickly: the same region at about 14 voxels on its longest side.
      const p = normaliseFx({ ...preset.params, voxelSize: Math.max(...preset.params.regionSize) / 14 });
      const f = new FluidCpu(fluidDims(p));
      for (let i = 0; i < 4; i++) f.step(p, p.frameTime / p.substeps);
      for (const v of f.density) expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe('gizmo rotations', () => {
  it('read back turn and tilt beyond 90 degrees, with the roll dropped', async () => {
    const { turnTiltOf } = await import('../src/fx/ui/FxGizmos');
    const { quat } = await import('gl-matrix');
    for (const [pitch, yaw] of [[0, 0], [30, 120], [-45, -150], [60, 170], [10, 95]]) {
      const q = quat.fromEuler(quat.create(), pitch, yaw, 0);
      const r = turnTiltOf(q);
      expect(r.yaw).toBeCloseTo(yaw, 4);
      expect(r.pitch).toBeCloseTo(pitch, 4);
    }
  });
});

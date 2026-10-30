// FX Creator's gas solver, CPU reference (research doc B3 "Fire, smoke and explosions": a GPU Eulerian
// solver -- semi-Lagrangian advection with pressure projection, vorticity confinement to restore lost
// detail, a combustion model). fluidGpu.ts runs the same steps as WebGPU compute kernels; this is the
// WebGL2 fallback, the test reference, and the readable statement of the method.
//
// Method (Stam 1999 "Stable Fluids"; Fedkiw, Stam & Jensen 2001 "Visual Simulation of Smoke"; Nguyen,
// Fedkiw & Jensen 2002 for fuel/heat/smoke), on a collocated grid with unit voxels and velocities in
// voxels per second. One step:
//   1. sources     emitter fuel/heat/smoke/velocity, seeded turbulence, combustion, buoyancy, wind
//   2. vorticity   confinement force from the curl's gradient
//   3. advect      velocity and scalars, semi-Lagrangian, trilinear
//   4. project     divergence, Jacobi pressure solve, subtract the gradient
//   5. dissipate   cooling, smoke fade, velocity damping
// Walls are closed on the sides and floor (zero velocity), the top is open (scalars leave freely).
//
// Deterministic: fixed step order, the turbulence a hash of (seed, voxel, step), no Math.random.

import type { FxParams } from './fxParams';
import { detailPhase, stepFactors, type StepFactors } from './realism';

export interface FluidDims { nx: number; ny: number; nz: number }

/** The grid a region needs: its size over the voxel size, per axis, at least 8 (normalised parameters). */
export function fluidDims(p: Pick<FxParams, 'regionSize' | 'voxelSize'>): FluidDims {
  const v = Math.max(0.005, p.voxelSize);
  const n = (m: number) => Math.max(8, Math.round(m / v));
  return { nx: n(p.regionSize[0]), ny: n(p.regionSize[1]), nz: n(p.regionSize[2]) };
}

/** Integer hash -> 0..1, shared in spirit with the WGSL kernels' `hash3` (same constants). */
export function hash3(x: number, y: number, z: number, seed: number): number {
  let h = (Math.imul(x | 0, 0x8da6b343) ^ Math.imul(y | 0, 0xd8163841) ^ Math.imul(z | 0, 0xcb1ab31f) ^ Math.imul(seed | 0, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h / 4294967296;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Trilinear value noise in -1..1. */
export function valueNoise3(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = smooth(x - xi), fy = smooth(y - yi), fz = smooth(z - zi);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz, seed);
  const v = l(
    l(l(c(0, 0, 0), c(1, 0, 0), fx), l(c(0, 1, 0), c(1, 1, 0), fx), fy),
    l(l(c(0, 0, 1), c(1, 0, 1), fx), l(c(0, 1, 1), c(1, 1, 1), fx), fy),
    fz,
  );
  return v * 2 - 1;
}

/**
 * Wind from the preview stage (fxScene.ts), in voxel units: a steady push toward (vx, vz) that comes and
 * goes with a gust field scrolled along it. Preview only -- a bake never sets one.
 */
export interface SceneWind {
  vx: number;
  vz: number;
  /** 0..1: the share of the wind that rides on the gusts. */
  gustiness: number;
  /** Voxels between gust crests. */
  gustScale: number;
  /** Voxels per second the gusts travel. */
  gustSpeed: number;
}

/** Over-relaxation for the red-black solve; 1 is plain Gauss-Seidel. */
export const SOR_OMEGA = 1.6;

/** The gust factor at a voxel and time: 1 - gustiness + gustiness * (0..1 noise), as the GPU kernel. */
export function gustAt(w: SceneWind, x: number, y: number, z: number, time: number, seed: number): number {
  if (w.gustiness <= 0) return 1;
  const len = Math.hypot(w.vx, w.vz) || 1;
  const s = 1 / Math.max(0.5, w.gustScale);
  const shift = w.gustSpeed * time;
  const n = valueNoise3((x - (w.vx / len) * shift) * s, y * s * 0.5, (z - (w.vz / len) * shift) * s, seed + 11);
  return 1 - w.gustiness + w.gustiness * (0.5 + 0.5 * n);
}

export class FluidCpu {
  readonly dims: FluidDims;
  readonly count: number;
  u: Float32Array; v: Float32Array; w: Float32Array;
  density: Float32Array; temperature: Float32Array; fuel: Float32Array;
  private u2: Float32Array; private v2: Float32Array; private w2: Float32Array;
  private d2: Float32Array; private t2: Float32Array; private f2: Float32Array;
  private pressure: Float32Array; private pressure2: Float32Array; private divergence: Float32Array;
  private cx: Float32Array; private cy: Float32Array; private cz: Float32Array;
  private mags: Float64Array | null = null;
  /**
   * The divergence source per voxel this step -- combustion expansion (expansion x fuel burned per second)
   * plus the blast pulse. Allocated on first use; null when neither is on.
   */
  private burned: Float32Array | null = null;
  private sourceActive = false;
  /** The flame field: where fuel is burning now (0..1), advected, decaying over `flameLifetime`. */
  flame: Float32Array;
  private fl2: Float32Array;
  /** Scratch for the diffusion and shredding passes. */
  private scratch: Float32Array | null = null;
  /** Open boundaries this step: gas leaves through the sides as well as the top. */
  private open = false;
  /**
   * The advected detail coordinates (realism.ts DETAIL_PERIOD): two sets, xyz per half-resolution cell,
   * in full-resolution voxel units. Allocated when detail is on.
   */
  detailA: Float32Array | null = null;
  detailB: Float32Array | null = null;
  private detailScratch: Float32Array | null = null;
  /** The half-resolution grid the detail coordinates live on. */
  get detailDims(): FluidDims { return { nx: Math.ceil(this.dims.nx / 2), ny: Math.ceil(this.dims.ny / 2), nz: Math.ceil(this.dims.nz / 2) }; }
  /** MacCormack's scratch: the forward-advected scalars, re-advected backward. */
  private mcBack: Float32Array | null = null;
  /**
   * Solid voxels (1) from the preview's placed bodies; null is open air. The gas never enters a solid,
   * and flows around it (free-slip, Neumann pressure). Preview only -- a bake never sets one.
   */
  solid: Uint8Array | null = null;
  /** The preview stage's wind; null for none. */
  sceneWind: SceneWind | null = null;
  /** Simulated seconds so far. */
  time = 0;
  /** Steps taken so far (the turbulence's time coordinate). */
  steps = 0;

  constructor(dims: FluidDims) {
    this.dims = dims;
    this.count = dims.nx * dims.ny * dims.nz;
    const f = () => new Float32Array(this.count);
    this.u = f(); this.v = f(); this.w = f();
    this.density = f(); this.temperature = f(); this.fuel = f();
    this.u2 = f(); this.v2 = f(); this.w2 = f();
    this.d2 = f(); this.t2 = f(); this.f2 = f();
    this.pressure = f(); this.pressure2 = f(); this.divergence = f();
    this.cx = f(); this.cy = f(); this.cz = f();
    this.flame = f(); this.fl2 = f();
  }

  index(x: number, y: number, z: number): number {
    return x + this.dims.nx * (y + this.dims.ny * z);
  }

  /** Advance one step of `dt` seconds. */
  step(p: FxParams, dt: number): void {
    const k = stepFactors(p, this.time, dt);
    this.open = p.boundaries === 'open';
    this.sources(p, dt, k);
    if (p.vorticity > 0) this.confine(p, dt, k.vortScale);
    this.advect(dt, p.advection === 'maccormack', k.settle);
    if ((p.diffusion ?? 0) > 0) this.diffuse(p.diffusion, dt);
    if ((p.shredding ?? 0) > 0) this.shred(p.shredding, dt);
    if ((p.detailStrength ?? 0) > 0) this.advectDetail(dt);
    this.project(p.pressureIterations, { sor: p.pressureSolver === 'sor', source: this.sourceActive, open: this.open });
    this.dissipate(p, dt, k);
    if (this.solid) this.clearSolids();
    this.time += dt;
    this.steps++;
  }

  private sources(p: FxParams, dt: number, k: StepFactors = stepFactors(p, this.time, dt)): void {
    const { nx, ny, nz } = this.dims;
    const ex = (p.emitterX ?? 0.5) * (nx - 1), ez = (p.emitterZ ?? 0.5) * (nz - 1), ey = p.emitterHeight * (ny - 1);
    const radius = Math.max(1, p.emitterRadius * nx);
    const emitting = p.emitDuration <= 0 || this.time < p.emitDuration;
    const tScale = p.turbulenceScale / nx;
    const tz = this.steps * 0.05;
    const solid = this.solid;
    const wind = this.sceneWind;
    this.sourceActive = p.expansion > 0 || k.blast > 0;
    const burned = this.sourceActive ? (this.burned ??= new Float32Array(this.count)) : null;
    burned?.fill(0);
    const condense = (p.condensation ?? 0) > 0;
    const disturb = (p.disturbance ?? 0) > 0;
    const cell = k.disturbanceCell;
    const dSeed = (p.seed + 101 + k.disturbancePhase * 7919) | 0;
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const i = this.index(x, y, z);
      if (solid && solid[i]) continue;
      if (emitting) {
        const dx = x - ex, dy = y - ey, dz = z - ez;
        const inside = p.emitterShape === 'disc'
          ? Math.hypot(dx, dz) <= radius && Math.abs(dy) <= 1
          : Math.hypot(dx, dy, dz) <= radius;
        if (inside) {
          // Emitter noise: one time-varying factor per voxel on everything the emitter holds.
          const ek = (p.emitterNoise > 0
            ? Math.max(0, 1 + p.emitterNoise * valueNoise3(x * 0.35, y * 0.35 - this.time * 3, z * 0.35, p.seed + 7))
            : 1) * k.flicker;
          this.fuel[i] = Math.max(this.fuel[i], p.fuel * ek);
          this.temperature[i] = Math.max(this.temperature[i], p.heat * ek);
          // With condensation on, the emitter breathes out invisible vapour (held in the fuel slot: steam
          // burns nothing) and the visible density appears where it cools below the dew point.
          if (condense) this.fuel[i] += p.smoke * dt * ek;
          else this.density[i] += p.smoke * dt * ek;
          this.v[i] = Math.max(this.v[i], p.emitSpeed * ek);
          if (burned && k.blast > 0) burned[i] += k.blast;
        }
      }
      // Turbulence wherever there is something hot to stir.
      if (p.turbulence > 0 && this.temperature[i] > 0.02) {
        const k = p.turbulence * Math.min(1, this.temperature[i]) * dt;
        const sx = x * tScale, sy = y * tScale - tz, sz = z * tScale;
        this.u[i] += k * valueNoise3(sx, sy, sz, p.seed);
        this.v[i] += k * 0.5 * valueNoise3(sx + 31.4, sy, sz, p.seed + 1);
        this.w[i] += k * valueNoise3(sx, sy, sz + 17.7, p.seed + 2);
      }
      // Disturbance: one random kick per block, re-seeded every interval, where there is gas to move.
      if (disturb) {
        const amount = Math.min(1, this.temperature[i] + this.density[i]);
        if (amount > 0.01) {
          const bx = Math.floor(x / cell), by = Math.floor(y / cell), bz = Math.floor(z / cell);
          const s = p.disturbance * amount * dt;
          this.u[i] += s * (hash3(bx, by, bz, dSeed) * 2 - 1);
          this.v[i] += s * (hash3(bx, by, bz, dSeed + 1) * 2 - 1);
          this.w[i] += s * (hash3(bx, by, bz, dSeed + 2) * 2 - 1);
        }
      }
      if (condense) {
        // Vapour <-> visible droplets across the dew point.
        const t = this.temperature[i];
        if (t < p.dewPoint) {
          const r = Math.min(this.fuel[i], p.condensation * dt * this.fuel[i]);
          this.fuel[i] -= r; this.density[i] += r;
        } else {
          const r = Math.min(this.density[i], p.condensation * dt * this.density[i] * (t - p.dewPoint) / Math.max(0.05, p.dewPoint));
          this.density[i] -= r; this.fuel[i] += r;
        }
      } else if (this.fuel[i] > 0 && this.temperature[i] > p.ignition) {
        // Combustion: ignited fuel burns into heat and smoke, and marks the flame field.
        const burn = Math.min(this.fuel[i], p.burnRate * dt);
        this.fuel[i] -= burn;
        this.temperature[i] += burn * p.heatRelease;
        this.density[i] += burn * p.smokeYield;
        if (burned) burned[i] += p.expansion * burn / dt;
        this.flame[i] = Math.max(this.flame[i], burn / Math.max(1e-6, p.burnRate * dt));
      }
      // Buoyancy: hot gas rises, smoke is heavy. Wind is a steady push along +X.
      this.v[i] += (p.buoyancy * this.temperature[i] - p.weight * this.density[i]) * dt;
      if (p.wind !== 0 && this.temperature[i] + this.density[i] > 0.01) this.u[i] += (p.wind - this.u[i]) * Math.min(1, dt);
      // The stage's wind: the gas is dragged toward the (gusting) wind velocity, horizontally.
      if (wind && this.temperature[i] + this.density[i] > 0.01) {
        const g = gustAt(wind, x, y, z, this.time, p.seed);
        const k = Math.min(1, dt);
        this.u[i] += (wind.vx * g - this.u[i]) * k;
        this.w[i] += (wind.vz * g - this.w[i]) * k;
      }
    }
  }

  /** Vorticity confinement (Fedkiw et al. 2001): f = eps * (N x omega), N the normalised gradient of |omega|. */
  private confine(p: FxParams, dt: number, vortScale = 1): void {
    const { nx, ny, nz } = this.dims;
    const { u, v, w, cx, cy, cz } = this;
    const id = (x: number, y: number, z: number) => this.index(x, y, z);
    for (let z = 1; z < nz - 1; z++) for (let y = 1; y < ny - 1; y++) for (let x = 1; x < nx - 1; x++) {
      const i = id(x, y, z);
      cx[i] = ((w[id(x, y + 1, z)] - w[id(x, y - 1, z)]) - (v[id(x, y, z + 1)] - v[id(x, y, z - 1)])) * 0.5;
      cy[i] = ((u[id(x, y, z + 1)] - u[id(x, y, z - 1)]) - (w[id(x + 1, y, z)] - w[id(x - 1, y, z)])) * 0.5;
      cz[i] = ((v[id(x + 1, y, z)] - v[id(x - 1, y, z)]) - (u[id(x, y + 1, z)] - u[id(x, y - 1, z)])) * 0.5;
    }
    // |omega| once per voxel, not six times (each voxel is every neighbour's neighbour).
    // Float64, as the hypot values were when computed inline: storing them as f32 would round them.
    const mags = this.mags ??= new Float64Array(this.count);
    for (let j = 0; j < this.count; j++) mags[j] = Math.hypot(cx[j], cy[j], cz[j]);
    const mag = (j: number) => mags[j];
    const eps = p.vorticity * vortScale;
    for (let z = 2; z < nz - 2; z++) for (let y = 2; y < ny - 2; y++) for (let x = 2; x < nx - 2; x++) {
      const i = id(x, y, z);
      let gx = (mag(id(x + 1, y, z)) - mag(id(x - 1, y, z))) * 0.5;
      let gy = (mag(id(x, y + 1, z)) - mag(id(x, y - 1, z))) * 0.5;
      let gz = (mag(id(x, y, z + 1)) - mag(id(x, y, z - 1))) * 0.5;
      const len = Math.hypot(gx, gy, gz);
      if (len < 1e-6) continue;
      gx /= len; gy /= len; gz /= len;
      u[i] += eps * (gy * cz[i] - gz * cy[i]) * dt;
      v[i] += eps * (gz * cx[i] - gx * cz[i]) * dt;
      w[i] += eps * (gx * cy[i] - gy * cx[i]) * dt;
    }
  }

  /** Trilinear sample of `a` at a voxel-space point, clamped to the grid. */
  sample(a: Float32Array, x: number, y: number, z: number): number {
    const { nx, ny, nz } = this.dims;
    x = Math.min(nx - 1, Math.max(0, x)); y = Math.min(ny - 1, Math.max(0, y)); z = Math.min(nz - 1, Math.max(0, z));
    const x0 = Math.min(nx - 2, Math.floor(x)), y0 = Math.min(ny - 2, Math.floor(y)), z0 = Math.min(nz - 2, Math.floor(z));
    const fx = x - x0, fy = y - y0, fz = z - z0;
    const i = this.index(x0, y0, z0);
    const sx = 1, sy = nx, sz = nx * ny;
    const c00 = a[i] + (a[i + sx] - a[i]) * fx;
    const c10 = a[i + sy] + (a[i + sy + sx] - a[i + sy]) * fx;
    const c01 = a[i + sz] + (a[i + sz + sx] - a[i + sz]) * fx;
    const c11 = a[i + sz + sy] + (a[i + sz + sy + sx] - a[i + sz + sy]) * fx;
    const c0 = c00 + (c10 - c00) * fy, c1 = c01 + (c11 - c01) * fy;
    return c0 + (c1 - c0) * fz;
  }

  private advect(dt: number, maccormack = false, settle = 0): void {
    const { nx, ny, nz } = this.dims;
    const { u, v, w, density, temperature, fuel, flame, u2, v2, w2, d2, t2, f2, fl2 } = this;
    const open = this.open;
    const sy = nx, sz = nx * ny;
    // `sample` six times over, with the corner index and weights worked out once: all six fields are
    // read at the same backtraced point. Same arithmetic per field, so the result is bit-identical.
    const lerp3 = (a: Float32Array, i: number, fx: number, fy: number, fz: number) => {
      const c00 = a[i] + (a[i + 1] - a[i]) * fx;
      const c10 = a[i + sy] + (a[i + sy + 1] - a[i + sy]) * fx;
      const c01 = a[i + sz] + (a[i + sz + 1] - a[i + sz]) * fx;
      const c11 = a[i + sz + sy] + (a[i + sz + sy + 1] - a[i + sz + sy]) * fx;
      const c0 = c00 + (c10 - c00) * fy, c1 = c01 + (c11 - c01) * fy;
      return c0 + (c1 - c0) * fz;
    };
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const i = x + sy * y + sz * z;
      const bx = x - u[i] * dt, by = y - v[i] * dt, bz = z - w[i] * dt;
      const cx = Math.min(nx - 1, Math.max(0, bx)), cy = Math.min(ny - 1, Math.max(0, by)), cz = Math.min(nz - 1, Math.max(0, bz));
      const x0 = Math.min(nx - 2, Math.floor(cx)), y0 = Math.min(ny - 2, Math.floor(cy)), z0 = Math.min(nz - 2, Math.floor(cz));
      const fx = cx - x0, fy = cy - y0, fz = cz - z0;
      const j = x0 + sy * y0 + sz * z0;
      u2[i] = lerp3(u, j, fx, fy, fz);
      v2[i] = lerp3(v, j, fx, fy, fz);
      w2[i] = lerp3(w, j, fx, fy, fz);
      // Above the top the domain is open (and through the sides, with open boundaries): material
      // backtraced from outside it is fresh air.
      const outside = by > ny - 1 || (open && (bx < 0 || bx > nx - 1 || bz < 0 || bz > nz - 1));
      if (settle > 0 && !outside) {
        // Dust falls through the air: its own backtrace starts higher by the fall distance.
        const sy2 = Math.min(ny - 1, Math.max(0, by + settle * dt));
        const ys = Math.min(ny - 2, Math.floor(sy2));
        d2[i] = by + settle * dt > ny - 1 ? 0 : lerp3(density, x0 + sy * ys + sz * z0, fx, sy2 - ys, fz);
      } else {
        d2[i] = outside ? 0 : lerp3(density, j, fx, fy, fz);
      }
      t2[i] = outside ? 0 : lerp3(temperature, j, fx, fy, fz);
      f2[i] = outside ? 0 : lerp3(fuel, j, fx, fy, fz);
      fl2[i] = outside ? 0 : lerp3(flame, j, fx, fy, fz);
    }
    if (maccormack) {
      // MacCormack (Selle et al. 2008): advect the forward result back, halve the round-trip error into
      // a correction, and clamp to the backtrace's neighbourhood so it can never overshoot.
      const back = this.mcBack ??= new Float32Array(this.count);
      for (const [orig, fwd] of [[density, d2], [temperature, t2], [fuel, f2], [flame, fl2]] as const) {
        for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
          const i = x + sy * y + sz * z;
          const fx = Math.min(nx - 1, Math.max(0, x + u[i] * dt)), fy = Math.min(ny - 1, Math.max(0, y + v[i] * dt)), fz = Math.min(nz - 1, Math.max(0, z + w[i] * dt));
          const x0 = Math.min(nx - 2, Math.floor(fx)), y0 = Math.min(ny - 2, Math.floor(fy)), z0 = Math.min(nz - 2, Math.floor(fz));
          back[i] = lerp3(fwd, x0 + sy * y0 + sz * z0, fx - x0, fy - y0, fz - z0);
        }
        for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
          const i = x + sy * y + sz * z;
          const by = y - v[i] * dt;
          if (by > ny - 1) continue;   // open top: stays empty
          const cx = Math.min(nx - 1, Math.max(0, x - u[i] * dt)), cy = Math.min(ny - 1, Math.max(0, by)), cz = Math.min(nz - 1, Math.max(0, z - w[i] * dt));
          const x0 = Math.min(nx - 2, Math.floor(cx)), y0 = Math.min(ny - 2, Math.floor(cy)), z0 = Math.min(nz - 2, Math.floor(cz));
          const j = x0 + sy * y0 + sz * z0;
          let lo = Infinity, hi = -Infinity;
          for (const o of [0, 1, sy, sy + 1, sz, sz + 1, sz + sy, sz + sy + 1]) { const c = orig[j + o]; if (c < lo) lo = c; if (c > hi) hi = c; }
          const corrected = fwd[i] + 0.5 * (orig[i] - back[i]);
          fwd[i] = Math.min(hi, Math.max(lo, corrected));
        }
      }
    }
    [this.u, this.u2] = [this.u2, this.u];
    [this.v, this.v2] = [this.v2, this.v];
    [this.w, this.w2] = [this.w2, this.w];
    [this.density, this.d2] = [this.d2, this.density];
    [this.temperature, this.t2] = [this.t2, this.temperature];
    [this.fuel, this.f2] = [this.f2, this.fuel];
    [this.flame, this.fl2] = [this.fl2, this.flame];
    this.enforceWalls();
    if (this.solid) this.clearSolids();
  }

  /**
   * Carry both detail coordinate sets along the flow (semi-Lagrangian, at half resolution), and put each
   * back on the rest grid when its phase wraps -- set B half a period after set A.
   */
  private advectDetail(dt: number): void {
    const d = this.detailDims;
    const n = d.nx * d.ny * d.nz;
    const rest = (a: Float32Array) => {
      for (let z = 0, i = 0; z < d.nz; z++) for (let y = 0; y < d.ny; y++) for (let x = 0; x < d.nx; x++, i++) {
        a[i * 3] = x * 2; a[i * 3 + 1] = y * 2; a[i * 3 + 2] = z * 2;
      }
    };
    if (!this.detailA || this.detailA.length !== n * 3) {
      this.detailA = new Float32Array(n * 3); this.detailB = new Float32Array(n * 3); this.detailScratch = new Float32Array(n * 3);
      rest(this.detailA); rest(this.detailB);
    }
    const before = detailPhase(this.time), after = detailPhase(this.time + dt);
    const before2 = detailPhase(this.time + 1.5 / 2), after2 = detailPhase(this.time + dt + 1.5 / 2);
    for (const [set, wrapped] of [[this.detailA!, after < before], [this.detailB!, after2 < before2]] as const) {
      if (wrapped) { rest(set); continue; }
      const tmp = this.detailScratch!;
      const at = (x: number, y: number, z: number, c: number) => {
        // Trilinear over the half-resolution grid, clamped.
        const fx = Math.min(d.nx - 1, Math.max(0, x)), fy = Math.min(d.ny - 1, Math.max(0, y)), fz = Math.min(d.nz - 1, Math.max(0, z));
        const x0 = Math.min(Math.max(0, d.nx - 2), Math.floor(fx)), y0 = Math.min(Math.max(0, d.ny - 2), Math.floor(fy)), z0 = Math.min(Math.max(0, d.nz - 2), Math.floor(fz));
        const x1 = Math.min(d.nx - 1, x0 + 1), y1 = Math.min(d.ny - 1, y0 + 1), z1 = Math.min(d.nz - 1, z0 + 1);
        const tx = fx - x0, ty = fy - y0, tz = fz - z0;
        const g = (a: number, b: number, e: number) => set[(a + d.nx * (b + d.ny * e)) * 3 + c];
        const l = (a: number, b: number, t: number) => a + (b - a) * t;
        return l(l(l(g(x0, y0, z0), g(x1, y0, z0), tx), l(g(x0, y1, z0), g(x1, y1, z0), tx), ty),
                 l(l(g(x0, y0, z1), g(x1, y0, z1), tx), l(g(x0, y1, z1), g(x1, y1, z1), tx), ty), tz);
      };
      for (let z = 0, i = 0; z < d.nz; z++) for (let y = 0; y < d.ny; y++) for (let x = 0; x < d.nx; x++, i++) {
        const px = x * 2, py = y * 2, pz = z * 2;
        const bx = (px - this.sample(this.u, px, py, pz) * dt) / 2;
        const by = (py - this.sample(this.v, px, py, pz) * dt) / 2;
        const bz = (pz - this.sample(this.w, px, py, pz) * dt) / 2;
        tmp[i * 3] = at(bx, by, bz, 0); tmp[i * 3 + 1] = at(bx, by, bz, 1); tmp[i * 3 + 2] = at(bx, by, bz, 2);
      }
      set.set(tmp);
    }
  }

  /** Smoke and heat spreading into the air around them: one explicit Laplacian step, kept stable. */
  private diffuse(rate: number, dt: number): void {
    const { nx, ny, nz } = this.dims;
    const k = Math.min(1 / 6.5, rate * dt * 60);
    const tmp = this.scratch ??= new Float32Array(this.count);
    const sy = nx, sz = nx * ny;
    for (const a of [this.density, this.temperature]) {
      tmp.set(a);
      for (let z = 1; z < nz - 1; z++) for (let y = 1; y < ny - 1; y++) for (let x = 1; x < nx - 1; x++) {
        const i = x + sy * y + sz * z;
        a[i] = tmp[i] + k * (tmp[i - 1] + tmp[i + 1] + tmp[i - sy] + tmp[i + sy] + tmp[i - sz] + tmp[i + sz] - 6 * tmp[i]);
      }
    }
  }

  /**
   * Shredding: velocity along a hot edge is stretched -- the component tangent to the temperature
   * gradient grows with the gradient's strength -- so flames and wisps pull out into thin licks.
   */
  private shred(amount: number, dt: number): void {
    const { nx, ny, nz } = this.dims;
    const { u, v, w, temperature: t } = this;
    const sy = nx, sz = nx * ny;
    for (let z = 1; z < nz - 1; z++) for (let y = 1; y < ny - 1; y++) for (let x = 1; x < nx - 1; x++) {
      const i = x + sy * y + sz * z;
      const gx = (t[i + 1] - t[i - 1]) * 0.5, gy = (t[i + sy] - t[i - sy]) * 0.5, gz = (t[i + sz] - t[i - sz]) * 0.5;
      const g = Math.hypot(gx, gy, gz);
      if (g < 1e-4) continue;
      const nx_ = gx / g, ny_ = gy / g, nz_ = gz / g;
      const dot = u[i] * nx_ + v[i] * ny_ + w[i] * nz_;
      const s = Math.min(0.5, amount * g * dt * 10);
      u[i] += s * (u[i] - dot * nx_);
      v[i] += s * (v[i] - dot * ny_);
      w[i] += s * (w[i] - dot * nz_);
    }
  }

  /** Nothing lives inside a solid: no gas, no motion. */
  private clearSolids(): void {
    const solid = this.solid!;
    for (let i = 0; i < this.count; i++) {
      if (!solid[i]) continue;
      this.u[i] = 0; this.v[i] = 0; this.w[i] = 0;
      this.density[i] = 0; this.temperature[i] = 0; this.fuel[i] = 0; this.flame[i] = 0;
    }
  }

  /**
   * Closed sides and floor: no velocity in the boundary voxels. The top row keeps its upward flow. With
   * open boundaries only the floor is a wall: the sides let gas through like the top.
   */
  private enforceWalls(): void {
    const { nx, ny, nz } = this.dims;
    const open = this.open;
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      if (x > 0 && x < nx - 1 && z > 0 && z < nz - 1 && y > 0) continue;
      if (open && y > 0) continue;
      const i = this.index(x, y, z);
      this.u[i] = 0; this.w[i] = 0;
      if (y === 0) this.v[i] = 0;
    }
  }

  /**
   * Make the velocity field divergence-free -- or, with `expansion`, expand where fuel burned: solve
   * lap(p) = div(u) - S by Jacobi (or warm-started red-black SOR), then u -= grad(p).
   */
  project(iterations: number, opts: { sor?: boolean; source?: boolean; open?: boolean } = {}): void {
    if (this.solid || opts.sor || opts.source || opts.open) { this.projectGeneral(iterations, opts); return; }
    const { nx, ny, nz } = this.dims;
    const { u, v, w, divergence } = this;
    const at = (a: Float32Array, x: number, y: number, z: number) =>
      a[this.index(Math.min(nx - 1, Math.max(0, x)), Math.min(ny - 1, Math.max(0, y)), Math.min(nz - 1, Math.max(0, z)))];
    const sy = nx, sz = nx * ny;
    const inside = (x: number, y: number, z: number) => x > 0 && x < nx - 1 && y > 0 && y < ny - 1 && z > 0 && z < nz - 1;
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const i = x + sy * y + sz * z;
      divergence[i] = inside(x, y, z)
        ? (u[i + 1] - u[i - 1] + v[i + sy] - v[i - sy] + w[i + sz] - w[i - sz]) * 0.5
        : (at(u, x + 1, y, z) - at(u, x - 1, y, z) + at(v, x, y + 1, z) - at(v, x, y - 1, z) + at(w, x, y, z + 1) - at(w, x, y, z - 1)) * 0.5;
    }
    this.pressure.fill(0);
    // The hot loop of the whole solver (iterations x voxels x 6 reads). Interior voxels read their
    // neighbours by fixed strides; only the boundary shell pays for clamped reads. Same operands in the
    // same order as the clamped form, so the result is bit-identical (the golden hashes pin that).
    for (let it = 0; it < iterations; it++) {
      const p = this.pressure, q = this.pressure2;
      for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) {
        const row = sy * y + sz * z;
        const interiorRow = z > 0 && z < nz - 1 && y > 0 && y < ny - 1;
        for (let x = 0; x < nx; x++) {
          const i = row + x;
          if (interiorRow && x > 0 && x < nx - 1) {
            q[i] = (p[i - 1] + p[i + 1] + p[i - sy] + p[i + sy] + p[i - sz] + p[i + sz] - divergence[i]) / 6;
            continue;
          }
          // Neumann at the walls (clamped reads); Dirichlet p = 0 above the open top.
          const top = y + 1 >= ny ? 0 : at(p, x, y + 1, z);
          q[i] = (at(p, x - 1, y, z) + at(p, x + 1, y, z) + at(p, x, y - 1, z) + top
            + at(p, x, y, z - 1) + at(p, x, y, z + 1) - divergence[i]) / 6;
        }
      }
      this.pressure = q; this.pressure2 = p;
    }
    const p = this.pressure;
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const i = x + sy * y + sz * z;
      if (inside(x, y, z)) {
        u[i] -= (p[i + 1] - p[i - 1]) * 0.5;
        v[i] -= (p[i + sy] - p[i - sy]) * 0.5;
        w[i] -= (p[i + sz] - p[i - sz]) * 0.5;
        continue;
      }
      const top = y + 1 >= ny ? 0 : at(p, x, y + 1, z);
      u[i] -= (at(p, x + 1, y, z) - at(p, x - 1, y, z)) * 0.5;
      v[i] -= (top - at(p, x, y - 1, z)) * 0.5;
      w[i] -= (at(p, x, y, z + 1) - at(p, x, y, z - 1)) * 0.5;
    }
    this.enforceWalls();
  }

  /**
   * The projection with everything the fast path leaves out: solids (Neumann: a solid neighbour reads
   * the cell's own pressure, and no gradient is applied across a solid face), the combustion expansion
   * source, and the warm-started red-black SOR solve. Same discretisation as the fast path otherwise.
   */
  private projectGeneral(iterations: number, opts: { sor?: boolean; source?: boolean; open?: boolean }): void {
    const { nx, ny, nz } = this.dims;
    const { u, v, w, divergence } = this;
    const solid = this.solid;
    const sy = nx, sz = nx * ny;
    const isSolid = (j: number) => !!solid && solid[j] === 1;
    const clampI = (x: number, y: number, z: number) =>
      Math.min(nx - 1, Math.max(0, x)) + sy * Math.min(ny - 1, Math.max(0, y)) + sz * Math.min(nz - 1, Math.max(0, z));
    // Velocity of a neighbour for the divergence: a solid's is 0 (it does not move).
    const vel = (a: Float32Array, x: number, y: number, z: number) => { const j = clampI(x, y, z); return isSolid(j) ? 0 : a[j]; };
    const burned = opts.source ? this.burned : null;
    const open = !!opts.open;
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const i = x + sy * y + sz * z;
      if (isSolid(i)) { divergence[i] = 0; continue; }
      divergence[i] = (vel(u, x + 1, y, z) - vel(u, x - 1, y, z) + vel(v, x, y + 1, z) - vel(v, x, y - 1, z)
        + vel(w, x, y, z + 1) - vel(w, x, y, z - 1)) * 0.5 - (burned ? burned[i] : 0);
    }
    // Pressure of a neighbour: clamped at the walls, the cell's own across a solid face, 0 above the top.
    const pn = (p: Float32Array, i: number, x: number, y: number, z: number) => {
      if (y >= ny) return 0;
      // Open sides: outside is still air at ambient pressure (Dirichlet), like above the top.
      if (open && (x < 0 || x >= nx || z < 0 || z >= nz)) return 0;
      const j = clampI(x, y, z);
      return isSolid(j) ? p[i] : p[j];
    };
    const relax = (p: Float32Array, i: number, x: number, y: number, z: number) =>
      (pn(p, i, x - 1, y, z) + pn(p, i, x + 1, y, z) + pn(p, i, x, y - 1, z) + pn(p, i, x, y + 1, z)
        + pn(p, i, x, y, z - 1) + pn(p, i, x, y, z + 1) - divergence[i]) / 6;
    if (opts.sor) {
      // Warm start: last step's pressure is a far better first guess than zero. In place, red cells
      // then black, so each half reads the other's freshest values.
      const p = this.pressure;
      for (let it = 0; it < iterations; it++) for (let colour = 0; colour < 2; colour++) {
        for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = (y + z + colour) & 1; x < nx; x += 2) {
          const i = x + sy * y + sz * z;
          if (isSolid(i)) continue;
          p[i] += SOR_OMEGA * (relax(p, i, x, y, z) - p[i]);
        }
      }
    } else {
      this.pressure.fill(0);
      for (let it = 0; it < iterations; it++) {
        const p = this.pressure, q = this.pressure2;
        for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
          const i = x + sy * y + sz * z;
          q[i] = isSolid(i) ? 0 : relax(p, i, x, y, z);
        }
        this.pressure = q; this.pressure2 = p;
      }
    }
    const p = this.pressure;
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const i = x + sy * y + sz * z;
      if (isSolid(i)) { u[i] = 0; v[i] = 0; w[i] = 0; continue; }
      u[i] -= (pn(p, i, x + 1, y, z) - pn(p, i, x - 1, y, z)) * 0.5;
      v[i] -= (pn(p, i, x, y + 1, z) - pn(p, i, x, y - 1, z)) * 0.5;
      w[i] -= (pn(p, i, x, y, z + 1) - pn(p, i, x, y, z - 1)) * 0.5;
    }
    this.enforceWalls();
  }

  /** Mean |divergence| over the interior: what the tests check projection against. */
  meanDivergence(): number {
    const { nx, ny, nz } = this.dims;
    const { u, v, w } = this;
    let sum = 0, n = 0;
    for (let z = 1; z < nz - 1; z++) for (let y = 1; y < ny - 1; y++) for (let x = 1; x < nx - 1; x++) {
      sum += Math.abs((u[this.index(x + 1, y, z)] - u[this.index(x - 1, y, z)] + v[this.index(x, y + 1, z)] - v[this.index(x, y - 1, z)]
        + w[this.index(x, y, z + 1)] - w[this.index(x, y, z - 1)]) * 0.5);
      n++;
    }
    return sum / Math.max(1, n);
  }

  private dissipate(p: FxParams, dt: number, k: StepFactors = stepFactors(p, this.time, dt)): void {
    const cool = Math.max(0, 1 - p.cooling * dt);
    const fade = Math.max(0, 1 - p.smokeDissipation * dt);
    const damp = Math.max(0, 1 - p.velocityDamping * dt);
    for (let i = 0; i < this.count; i++) {
      this.temperature[i] *= cool;
      this.density[i] *= fade;
      this.u[i] *= damp; this.v[i] *= damp; this.w[i] *= damp;
    }
    // Radiative cooling: hot gas sheds heat as T^4, so the hottest parts cool fastest -- short flame tips.
    const c4 = p.coolingT4 ?? 0;
    if (c4 > 0) {
      const t = this.temperature;
      for (let i = 0; i < this.count; i++) { const x = t[i]; if (x > 0) t[i] = Math.max(0, x - c4 * x * x * x * x * dt); }
    }
    // The flame field fades out over its lifetime once the fuel at a point stops burning.
    if (k.flameKeep < 1) { const f = this.flame; for (let i = 0; i < this.count; i++) f[i] *= k.flameKeep; }
    // Ground drag: the bottom voxels lose horizontal speed, so ground-level gas spreads and settles.
    const drag = p.groundDrag ?? 0;
    if (drag > 0) {
      const { nx, ny, nz } = this.dims;
      const keep = Math.max(0, 1 - drag * dt);
      for (let z = 0; z < nz; z++) for (let y = 0; y < Math.min(3, ny); y++) for (let x = 0; x < nx; x++) {
        const i = this.index(x, y, z);
        this.u[i] *= keep; this.w[i] *= keep;
      }
    }
  }
}

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

export interface FluidDims { nx: number; ny: number; nz: number }

export function fluidDims(p: Pick<FxParams, 'resolution' | 'heightRatio'>): FluidDims {
  const n = Math.max(8, Math.round(p.resolution));
  return { nx: n, ny: Math.max(8, Math.round(n * p.heightRatio)), nz: n };
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

export class FluidCpu {
  readonly dims: FluidDims;
  readonly count: number;
  u: Float32Array; v: Float32Array; w: Float32Array;
  density: Float32Array; temperature: Float32Array; fuel: Float32Array;
  private u2: Float32Array; private v2: Float32Array; private w2: Float32Array;
  private d2: Float32Array; private t2: Float32Array; private f2: Float32Array;
  private pressure: Float32Array; private pressure2: Float32Array; private divergence: Float32Array;
  private cx: Float32Array; private cy: Float32Array; private cz: Float32Array;
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
  }

  index(x: number, y: number, z: number): number {
    return x + this.dims.nx * (y + this.dims.ny * z);
  }

  /** Advance one step of `dt` seconds. */
  step(p: FxParams, dt: number): void {
    this.sources(p, dt);
    if (p.vorticity > 0) this.confine(p, dt);
    this.advect(dt);
    this.project(p.pressureIterations);
    this.dissipate(p, dt);
    this.time += dt;
    this.steps++;
  }

  private sources(p: FxParams, dt: number): void {
    const { nx, ny, nz } = this.dims;
    const ex = (nx - 1) / 2, ez = (nz - 1) / 2, ey = p.emitterHeight * (ny - 1);
    const radius = Math.max(1, p.emitterRadius * nx);
    const emitting = p.emitDuration <= 0 || this.time < p.emitDuration;
    const tScale = p.turbulenceScale / nx;
    const tz = this.steps * 0.05;
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const i = this.index(x, y, z);
      if (emitting) {
        const dx = x - ex, dy = y - ey, dz = z - ez;
        const inside = p.emitterShape === 'disc'
          ? Math.hypot(dx, dz) <= radius && Math.abs(dy) <= 1
          : Math.hypot(dx, dy, dz) <= radius;
        if (inside) {
          this.fuel[i] = Math.max(this.fuel[i], p.fuel);
          this.temperature[i] = Math.max(this.temperature[i], p.heat);
          this.density[i] += p.smoke * dt;
          this.v[i] = Math.max(this.v[i], p.emitSpeed);
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
      // Combustion: ignited fuel burns into heat and smoke.
      if (this.fuel[i] > 0 && this.temperature[i] > p.ignition) {
        const burn = Math.min(this.fuel[i], p.burnRate * dt);
        this.fuel[i] -= burn;
        this.temperature[i] += burn * p.heatRelease;
        this.density[i] += burn * p.smokeYield;
      }
      // Buoyancy: hot gas rises, smoke is heavy. Wind is a steady push along +X.
      this.v[i] += (p.buoyancy * this.temperature[i] - p.weight * this.density[i]) * dt;
      if (p.wind !== 0 && this.temperature[i] + this.density[i] > 0.01) this.u[i] += (p.wind - this.u[i]) * Math.min(1, dt);
    }
  }

  /** Vorticity confinement (Fedkiw et al. 2001): f = eps * (N x omega), N the normalised gradient of |omega|. */
  private confine(p: FxParams, dt: number): void {
    const { nx, ny, nz } = this.dims;
    const { u, v, w, cx, cy, cz } = this;
    const id = (x: number, y: number, z: number) => this.index(x, y, z);
    for (let z = 1; z < nz - 1; z++) for (let y = 1; y < ny - 1; y++) for (let x = 1; x < nx - 1; x++) {
      const i = id(x, y, z);
      cx[i] = ((w[id(x, y + 1, z)] - w[id(x, y - 1, z)]) - (v[id(x, y, z + 1)] - v[id(x, y, z - 1)])) * 0.5;
      cy[i] = ((u[id(x, y, z + 1)] - u[id(x, y, z - 1)]) - (w[id(x + 1, y, z)] - w[id(x - 1, y, z)])) * 0.5;
      cz[i] = ((v[id(x + 1, y, z)] - v[id(x - 1, y, z)]) - (u[id(x, y + 1, z)] - u[id(x, y - 1, z)])) * 0.5;
    }
    const mag = (j: number) => Math.hypot(cx[j], cy[j], cz[j]);
    const eps = p.vorticity;
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

  private advect(dt: number): void {
    const { nx, ny, nz } = this.dims;
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const i = this.index(x, y, z);
      const bx = x - this.u[i] * dt, by = y - this.v[i] * dt, bz = z - this.w[i] * dt;
      this.u2[i] = this.sample(this.u, bx, by, bz);
      this.v2[i] = this.sample(this.v, bx, by, bz);
      this.w2[i] = this.sample(this.w, bx, by, bz);
      // Above the top the domain is open: material backtraced from outside it is empty air.
      const outside = by > ny - 1;
      this.d2[i] = outside ? 0 : this.sample(this.density, bx, by, bz);
      this.t2[i] = outside ? 0 : this.sample(this.temperature, bx, by, bz);
      this.f2[i] = outside ? 0 : this.sample(this.fuel, bx, by, bz);
    }
    [this.u, this.u2] = [this.u2, this.u];
    [this.v, this.v2] = [this.v2, this.v];
    [this.w, this.w2] = [this.w2, this.w];
    [this.density, this.d2] = [this.d2, this.density];
    [this.temperature, this.t2] = [this.t2, this.temperature];
    [this.fuel, this.f2] = [this.f2, this.fuel];
    this.enforceWalls();
  }

  /** Closed sides and floor: no velocity in the boundary voxels. The top row keeps its upward flow. */
  private enforceWalls(): void {
    const { nx, ny, nz } = this.dims;
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      if (x > 0 && x < nx - 1 && z > 0 && z < nz - 1 && y > 0) continue;
      const i = this.index(x, y, z);
      this.u[i] = 0; this.w[i] = 0;
      if (y === 0) this.v[i] = 0;
    }
  }

  /** Make the velocity field divergence-free: solve lap(p) = div(u) by Jacobi, then u -= grad(p). */
  project(iterations: number): void {
    const { nx, ny, nz } = this.dims;
    const { u, v, w, divergence } = this;
    const at = (a: Float32Array, x: number, y: number, z: number) =>
      a[this.index(Math.min(nx - 1, Math.max(0, x)), Math.min(ny - 1, Math.max(0, y)), Math.min(nz - 1, Math.max(0, z)))];
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      divergence[this.index(x, y, z)] =
        (at(u, x + 1, y, z) - at(u, x - 1, y, z) + at(v, x, y + 1, z) - at(v, x, y - 1, z) + at(w, x, y, z + 1) - at(w, x, y, z - 1)) * 0.5;
    }
    this.pressure.fill(0);
    for (let it = 0; it < iterations; it++) {
      const p = this.pressure, q = this.pressure2;
      for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        // Neumann at the walls (clamped reads); Dirichlet p = 0 above the open top.
        const top = y + 1 >= ny ? 0 : at(p, x, y + 1, z);
        q[this.index(x, y, z)] = (at(p, x - 1, y, z) + at(p, x + 1, y, z) + at(p, x, y - 1, z) + top
          + at(p, x, y, z - 1) + at(p, x, y, z + 1) - divergence[this.index(x, y, z)]) / 6;
      }
      this.pressure = q; this.pressure2 = p;
    }
    const p = this.pressure;
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const i = this.index(x, y, z);
      const top = y + 1 >= ny ? 0 : at(p, x, y + 1, z);
      u[i] -= (at(p, x + 1, y, z) - at(p, x - 1, y, z)) * 0.5;
      v[i] -= (top - at(p, x, y - 1, z)) * 0.5;
      w[i] -= (at(p, x, y, z + 1) - at(p, x, y, z - 1)) * 0.5;
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

  private dissipate(p: FxParams, dt: number): void {
    const cool = Math.max(0, 1 - p.cooling * dt);
    const fade = Math.max(0, 1 - p.smokeDissipation * dt);
    const damp = Math.max(0, 1 - p.velocityDamping * dt);
    for (let i = 0; i < this.count; i++) {
      this.temperature[i] *= cool;
      this.density[i] *= fade;
      this.u[i] *= damp; this.v[i] *= damp; this.w[i] *= damp;
    }
  }
}

// FX Creator's liquid solver, on the CPU: drops, sheets and streams of liquid as particles, relaxed
// toward a rest density every step -- Clavet, Beaudoin & Poulin 2005, "Particle-based Viscoelastic Fluid
// Simulation". Their double density relaxation is the whole fluid: a pressure from each particle's
// density pushes crowded neighbours apart, a near-pressure keeps pairs from clumping, and below the rest
// density (at a free surface) the pressure turns negative and pulls the surface together -- surface
// tension, which is what tears a sheet into threads and the threads into drops. Their pairwise impulses
// are the viscosity. Position-based, so it stays stable at the step sizes a flipbook bake can afford.
//
// Units are metres and seconds in REGION space: the region's low corner is the origin, its floor y = 0.
// One step (`step(p, dt)`, cut into substeps no particle crosses more than 0.4 of a neighbourhood in):
//   1. release    the source's particles (a burst at t = 0, or a jet's share of this substep)
//   2. forces     gravity, air drag (toward the stage's wind, if any)
//   3. viscosity  impulses along each approaching pair's axis
//   4. advance    x += v dt, the old positions kept
//   5. relax      double density relaxation, `liquidIterations` passes
//   6. collide    the preview's bodies; the floor (bounce, or deposit into the film / sink in); the region
//   7. velocity   v = (x - x_old) / dt
// What reaches a solid floor and stays is handed to the FILM (liquidFilm.ts), a height field that flows
// out over the floor and soaks in: the decal output.
//
// Deterministic: fixed order everywhere (the neighbour grid is a counting sort), randomness a hash of
// (seed, particle, event), no Math.random. Tests pin it.

import { hash3, valueNoise3 } from './fluidCpu';
import { particleCount, type FxParams } from './fxParams';
import { LiquidFilm } from './liquidFilm';

/** Signed distance (metres, negative inside) from the preview's bodies at a region-space point. */
export type LiquidObstacle = (x: number, y: number, z: number) => number;

/** The stage's wind in m/s, region axes. */
export interface LiquidWind { vx: number; vz: number }

/** Interaction radius over the rest spacing: a particle feels its neighbours out to this many droplets. */
export const KERNEL_RATIO = 2;
/**
 * Relaxation stiffness, as the share of a neighbourhood a unit of excess density moves a pair in one
 * REFERENCE substep (`h / SOUND_SPEED` seconds). Clavet's displacements go as dt^2 (they are pressure
 * accelerations), so a shorter substep moves less and the liquid behaves the same whatever the
 * substep count; a step is never longer than the reference, which keeps it stable.
 */
export const STIFFNESS = 0.2;
/** Near-pressure stiffness: what keeps two particles from sitting on each other. */
export const NEAR_STIFFNESS = 0.5;
/** m/s: sets the reference substep, h / this. */
const SOUND_SPEED = 10;
/** The rest spacing as a share of the interaction radius: near-pressure acts inside it. */
export const NEAR_Q = 1 / KERNEL_RATIO;
/** The pull of a free surface at full surface tension, as a share of the push of compression. */
export const COHESION = 0.12;
/** At most this share of a neighbourhood crossed per substep. */
const CFL = 0.4;
/** A drop landing slower than this (m/s) stays where it lands. */
export const STICK_SPEED = 0.45;
/** Bounces before a drop stays down whatever its speed. */
export const MAX_BOUNCES = 2;

/** The reference substep the stiffnesses are stated for, seconds: `h / SOUND_SPEED`. */
export function referenceStep(p: Pick<FxParams, 'dropletSize'>): number {
  return (p.dropletSize * KERNEL_RATIO) / SOUND_SPEED;
}

/**
 * The substep a liquid runs at: the frame's share, shortened until nothing outruns its neighbours, and
 * never past the reference step. From the parameters alone, so it is the same every frame -- and the
 * same for the CPU solver and the GPU one.
 */
export function liquidSubstep(p: FxParams, dt: number): number {
  const h = p.dropletSize * KERNEL_RATIO;
  const fall = Math.sqrt(2 * Math.max(0, p.gravity) * Math.max(p.regionSize[1], 0.1));
  const vmax = Math.max(0.5, p.sourceSpeed[1] * 1.15 + 0.5, fall);
  return Math.min(dt / Math.max(1, p.substeps), (CFL * h) / vmax, referenceStep(p));
}

/** One substep's newly released particles: ids, positions and velocities (xyz interleaved, region metres). */
export interface ReleaseBatch { count: number; ids: Uint32Array; pos: Float32Array; vel: Float32Array }

/**
 * The source: what it releases each substep, a burst all at once at t = 0 or a jet's share. Shared by
 * the CPU solver and the GPU one (which uploads each batch), so both start from the same drops.
 */
export class LiquidSource {
  /** Particles released so far (also the next id). */
  released = 0;
  private jetCarry = 0;

  constructor(private readonly spacing: number) {}

  /** The batch for the substep starting at `time`, at most `room` particles. */
  take(p: FxParams, time: number, dt: number, room: number): ReleaseBatch {
    const total = particleCount(p);
    let want = 0;
    if (p.sourceMode !== 'jet') {
      if (this.released === 0) want = total;
    } else if (!(p.jetDuration > 0 && time >= p.jetDuration)) {
      const duration = p.jetDuration > 0 ? p.jetDuration : 1;
      this.jetCarry += (total / duration) * dt;
      want = Math.floor(this.jetCarry);
      this.jetCarry -= want;
    }
    want = Math.max(0, Math.min(want, room));
    const batch: ReleaseBatch = { count: want, ids: new Uint32Array(want), pos: new Float32Array(want * 3), vel: new Float32Array(want * 3) };
    if (want === 0) return batch;
    const burst = p.sourceMode !== 'jet';
    const pts = burst ? burstPositions(p, want, this.spacing) : null;
    for (let k = 0; k < want; k++) {
      const id = this.released++;
      const pos = pts ? pts[k] : jetPosition(p, id, this.spacing);
      const v = releaseVelocity(p, id, pos, this.spacing, time);
      // A jet's drops spread along this substep's travel, so it is a stream rather than one layer per substep.
      const lead = burst ? 0 : hash3(id, 7, 0, p.seed) * dt;
      batch.ids[k] = id;
      batch.pos[k * 3] = pos.x + v[0] * lead; batch.pos[k * 3 + 1] = pos.y + v[1] * lead; batch.pos[k * 3 + 2] = pos.z + v[2] * lead;
      batch.vel[k * 3] = v[0]; batch.vel[k * 3 + 1] = v[1]; batch.vel[k * 3 + 2] = v[2];
    }
    // A burst leaves along its aim (a crown straight up and out): its noise is coherent, so a few hundred
    // drops sample only a few of its features and would otherwise lean wherever those happen to point.
    if (burst && p.sourceShape === 'ring') centreCrown(batch.vel, want);
    else if (burst) aimBatch(batch.vel, want, aimVector(p));
    return batch;
  }
}

/** A crown throws as much one way as the other: take out the batch's mean sideways velocity. */
function centreCrown(vel: Float32Array, count: number): void {
  let mx = 0, mz = 0;
  for (let k = 0; k < count; k++) { mx += vel[k * 3]; mz += vel[k * 3 + 2]; }
  mx /= Math.max(1, count); mz /= Math.max(1, count);
  for (let k = 0; k < count; k++) { vel[k * 3] -= mx; vel[k * 3 + 2] -= mz; }
}

/** Turn every velocity by the one rotation that takes their mean direction onto `aim`. */
function aimBatch(vel: Float32Array, count: number, aim: readonly number[]): void {
  let mx = 0, my = 0, mz = 0;
  for (let k = 0; k < count; k++) {
    const x = vel[k * 3], y = vel[k * 3 + 1], z = vel[k * 3 + 2];
    const l = Math.hypot(x, y, z);
    if (l > 1e-9) { mx += x / l; my += y / l; mz += z / l; }
  }
  const ml = Math.hypot(mx, my, mz);
  if (ml < 1e-9) return;
  mx /= ml; my /= ml; mz /= ml;
  // Rodrigues, about mean x aim.
  let kx = my * aim[2] - mz * aim[1], ky = mz * aim[0] - mx * aim[2], kz = mx * aim[1] - my * aim[0];
  const s = Math.hypot(kx, ky, kz), c = mx * aim[0] + my * aim[1] + mz * aim[2];
  if (s < 1e-7) return;
  kx /= s; ky /= s; kz /= s;
  const angle = Math.atan2(s, c), cs = Math.cos(angle), sn = Math.sin(angle);
  for (let k = 0; k < count; k++) {
    const x = vel[k * 3], y = vel[k * 3 + 1], z = vel[k * 3 + 2];
    const kv = kx * x + ky * y + kz * z;
    const cx = ky * z - kz * y, cy = kz * x - kx * z, cz = kx * y - ky * x;
    vel[k * 3] = x * cs + cx * sn + kx * kv * (1 - cs);
    vel[k * 3 + 1] = y * cs + cy * sn + ky * kv * (1 - cs);
    vel[k * 3 + 2] = z * cs + cz * sn + kz * kv * (1 - cs);
  }
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** The particle state and the step. Positions in metres, region space. */
export class LiquidCpu {
  readonly capacity: number;
  /** Live particles, packed into 0..count-1. */
  count = 0;
  x: Float32Array; y: Float32Array; z: Float32Array;
  vx: Float32Array; vy: Float32Array; vz: Float32Array;
  private ox: Float32Array; private oy: Float32Array; private oz: Float32Array;
  /** Release order, for the hash: stable through compaction. */
  id: Uint32Array;
  bounces: Uint8Array;
  private dead: Uint8Array;
  /** This substep's floor contact, and the velocity the particle hit it with. */
  private contact: Uint8Array;
  private hitV: Float32Array;
  // Neighbour grid (a hash of cells, counting-sorted) and the pair lists built from it.
  private cell: Int32Array;
  private bucketStart: Int32Array = new Int32Array(1);
  private bucketItems: Int32Array = new Int32Array(0);
  private bucketFill: Int32Array = new Int32Array(0);
  private hashOf: Uint32Array;
  private nStart: Int32Array;
  private nList: Int32Array = new Int32Array(1024);
  /** Particles released so far (also the next id). */
  get released(): number { return this.source.released; }
  private readonly source: LiquidSource;
  /** Volume (m^3) handed to the film, sunk into a water surface, or gone out of the region. */
  deposited = 0;
  absorbed = 0;
  escaped = 0;
  /** Simulated seconds and substeps so far. */
  time = 0;
  steps = 0;
  /** The region floor's film, when the floor is solid. */
  readonly film: LiquidFilm | null;
  /** The preview's bodies; null for none. Preview only -- a bake never sets one. */
  obstacle: LiquidObstacle | null = null;
  /** The preview stage's wind; null for none. */
  sceneWind: LiquidWind | null = null;
  /** Rest spacing (the droplet size) and the interaction radius, metres. */
  readonly spacing: number;
  readonly h: number;
  /** The density a particle has inside the liquid at rest (the lattice's, at `spacing`). */
  readonly restDensity: number;
  readonly region: [number, number, number];
  /** The particle volume, m^3: `spacing`^3. */
  readonly particleVolume: number;

  /** `filmCellSize`: the floor film's cells, metres (its own default: half a droplet). */
  constructor(p: FxParams, filmCellSize?: number) {
    this.spacing = p.dropletSize;
    this.source = new LiquidSource(this.spacing);
    this.h = this.spacing * KERNEL_RATIO;
    this.particleVolume = Math.pow(this.spacing, 3);
    this.region = [p.regionSize[0], p.regionSize[1], p.regionSize[2]];
    const total = particleCount(p);
    // A finite release is bounded by its volume; a pour that never stops by what can be alive at once.
    const continuous = p.sourceMode === 'jet' && !(p.jetDuration > 0);
    this.capacity = Math.max(16, continuous ? Math.min(60_000, total * 6) : total);
    const c = this.capacity;
    const f = () => new Float32Array(c);
    this.x = f(); this.y = f(); this.z = f();
    this.vx = f(); this.vy = f(); this.vz = f();
    this.ox = f(); this.oy = f(); this.oz = f();
    this.id = new Uint32Array(c);
    this.bounces = new Uint8Array(c);
    this.dead = new Uint8Array(c);
    this.contact = new Uint8Array(c);
    this.hitV = new Float32Array(c * 3);
    this.cell = new Int32Array(c * 3);
    this.hashOf = new Uint32Array(c);
    this.nStart = new Int32Array(c + 1);
    this.restDensity = latticeDensity();
    this.film = p.floorMode === 'solid' ? new LiquidFilm(p, filmCellSize) : null;
  }

  /** Every particle's volume plus the film's plus what left: what was released, for the tests. */
  totalVolume(): number {
    return this.count * this.particleVolume + this.deposited + this.absorbed + this.escaped;
  }

  /** Seconds the release lasts (0 for a burst; Infinity for a pour that never stops). */
  static releaseTime(p: FxParams): number {
    if (p.sourceMode !== 'jet') return 0;
    return p.jetDuration > 0 ? p.jetDuration : Infinity;
  }

  /** The reference substep the stiffnesses are stated for, seconds. */
  get referenceStep(): number { return this.h / SOUND_SPEED; }

  /** The substep this effect runs at (`liquidSubstep`). */
  substep(p: FxParams, dt: number): number { return liquidSubstep(p, dt); }

  /** Advance `dt` seconds. */
  step(p: FxParams, dt: number): void {
    const sub = this.substep(p, dt);
    const n = Math.max(1, Math.ceil(dt / sub - 1e-9));
    const sdt = dt / n;
    for (let s = 0; s < n; s++) this.substepOnce(p, sdt);
    this.film?.step(p, dt);
  }

  private substepOnce(p: FxParams, dt: number): void {
    this.release(p, dt);
    const n = this.count;
    if (n > 0) {
      this.forces(p, dt);
      this.buildNeighbours();
      this.viscosity(p, dt);
      for (let i = 0; i < n; i++) {
        this.ox[i] = this.x[i]; this.oy[i] = this.y[i]; this.oz[i] = this.z[i];
        this.x[i] += this.vx[i] * dt; this.y[i] += this.vy[i] * dt; this.z[i] += this.vz[i] * dt;
      }
      for (let k = 0; k < Math.max(1, Math.round(p.liquidIterations)); k++) this.relax(p, dt);
      this.collide(p, dt);
      this.settle(p, dt);
      this.compact();
    }
    this.time += dt;
    this.steps++;
  }

  // --- 1. release ------------------------------------------------------------------------------------

  private release(p: FxParams, dt: number): void {
    const b = this.source.take(p, this.time, dt, this.capacity - this.count);
    for (let k = 0; k < b.count; k++) {
      const i = this.count++;
      this.x[i] = b.pos[k * 3]; this.y[i] = b.pos[k * 3 + 1]; this.z[i] = b.pos[k * 3 + 2];
      this.vx[i] = b.vel[k * 3]; this.vy[i] = b.vel[k * 3 + 1]; this.vz[i] = b.vel[k * 3 + 2];
      this.id[i] = b.ids[k];
      this.bounces[i] = 0;
      this.dead[i] = 0;
    }
  }

  // --- 2. forces --------------------------------------------------------------------------------------

  private forces(p: FxParams, dt: number): void {
    const g = p.gravity * dt;
    const drag = Math.min(1, Math.max(0, p.airDrag) * dt);
    const wx = this.sceneWind?.vx ?? 0, wz = this.sceneWind?.vz ?? 0;
    for (let i = 0; i < this.count; i++) {
      this.vy[i] -= g;
      this.vx[i] += (wx - this.vx[i]) * drag;
      this.vy[i] -= this.vy[i] * drag;
      this.vz[i] += (wz - this.vz[i]) * drag;
    }
  }

  // --- neighbours -----------------------------------------------------------------------------------

  /** Every pair closer than `h`, per particle (both directions), from a counting-sorted cell hash. */
  private buildNeighbours(): void {
    const n = this.count, h = this.h;
    const size = nextPow2(Math.max(64, n * 2));
    const mask = size - 1;
    if (this.bucketStart.length < size + 1) this.bucketStart = new Int32Array(size + 1);
    else this.bucketStart.fill(0, 0, size + 1);
    if (this.bucketItems.length < n) this.bucketItems = new Int32Array(Math.max(n, this.capacity));
    const start = this.bucketStart, cell = this.cell, hashOf = this.hashOf;
    for (let i = 0; i < n; i++) {
      const cx = Math.floor(this.x[i] / h), cy = Math.floor(this.y[i] / h), cz = Math.floor(this.z[i] / h);
      cell[i * 3] = cx; cell[i * 3 + 1] = cy; cell[i * 3 + 2] = cz;
      const k = cellHash(cx, cy, cz) & mask;
      hashOf[i] = k;
      start[k + 1]++;
    }
    for (let k = 0; k < size; k++) start[k + 1] += start[k];
    if (this.bucketFill.length < size) this.bucketFill = new Int32Array(size);
    else this.bucketFill.fill(0, 0, size);
    const fill = this.bucketFill;
    for (let i = 0; i < n; i++) {
      const k = hashOf[i];
      this.bucketItems[start[k] + fill[k]++] = i;
    }
    // The pair lists, particle by particle in index order.
    const h2 = h * h;
    let count = 0;
    for (let i = 0; i < n; i++) {
      this.nStart[i] = count;
      const cx = cell[i * 3], cy = cell[i * 3 + 1], cz = cell[i * 3 + 2];
      const xi = this.x[i], yi = this.y[i], zi = this.z[i];
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const qx = cx + dx, qy = cy + dy, qz = cz + dz;
        const k = cellHash(qx, qy, qz) & mask;
        for (let s = start[k], e = start[k + 1]; s < e; s++) {
          const j = this.bucketItems[s];
          // A bucket can hold other cells' particles too (the hash collides): only this cell's count.
          if (j === i || cell[j * 3] !== qx || cell[j * 3 + 1] !== qy || cell[j * 3 + 2] !== qz) continue;
          const rx = this.x[j] - xi, ry = this.y[j] - yi, rz = this.z[j] - zi;
          if (rx * rx + ry * ry + rz * rz >= h2) continue;
          if (count >= this.nList.length) {
            const grown = new Int32Array(this.nList.length * 2);
            grown.set(this.nList);
            this.nList = grown;
          }
          this.nList[count++] = j;
        }
      }
    }
    this.nStart[n] = count;
  }

  // --- 3. viscosity -----------------------------------------------------------------------------------

  /** Clavet's pairwise impulses: approaching pairs lose some of their closing speed, linearly and quadratically. */
  private viscosity(p: FxParams, dt: number): void {
    const sigma = 120 * p.viscosity, beta = 0.6 + 2 * p.viscosity;
    if (sigma <= 0 && beta <= 0) return;
    const h = this.h;
    for (let i = 0; i < this.count; i++) {
      for (let s = this.nStart[i], e = this.nStart[i + 1]; s < e; s++) {
        const j = this.nList[s];
        if (j <= i) continue;
        const rx = this.x[j] - this.x[i], ry = this.y[j] - this.y[i], rz = this.z[j] - this.z[i];
        const r = Math.sqrt(rx * rx + ry * ry + rz * rz);
        if (r <= 1e-9 || r >= h) continue;
        const q = r / h;
        const ux = rx / r, uy = ry / r, uz = rz / r;
        const u = (this.vx[i] - this.vx[j]) * ux + (this.vy[i] - this.vy[j]) * uy + (this.vz[i] - this.vz[j]) * uz;
        if (u <= 0) continue;
        const imp = Math.min(u * 0.5, dt * (1 - q) * (sigma * u + beta * u * u)) * 0.5;
        this.vx[i] -= imp * ux; this.vy[i] -= imp * uy; this.vz[i] -= imp * uz;
        this.vx[j] += imp * ux; this.vy[j] += imp * uy; this.vz[j] += imp * uz;
      }
    }
  }

  // --- 5. relax -------------------------------------------------------------------------------------

  /**
   * One pass of double density relaxation, Gauss-Seidel in index order. Below the rest density the
   * pressure pulls instead of pushing, by `surfaceTension`: a free surface draws itself together.
   */
  private relax(p: FxParams, dt: number): void {
    const h = this.h, rho0 = this.restDensity;
    const tension = Math.max(0, Math.min(1, p.surfaceTension));
    const r = dt / this.referenceStep;
    const k = STIFFNESS * r * r, kNear = NEAR_STIFFNESS * r * r;
    for (let i = 0; i < this.count; i++) {
      const s0 = this.nStart[i], s1 = this.nStart[i + 1];
      if (s0 === s1) continue;
      const xi = this.x[i], yi = this.y[i], zi = this.z[i];
      let rho = 0, near = 0;
      for (let s = s0; s < s1; s++) {
        const j = this.nList[s];
        const rx = this.x[j] - xi, ry = this.y[j] - yi, rz = this.z[j] - zi;
        const q = Math.sqrt(rx * rx + ry * ry + rz * rz) / h;
        if (q >= 1) continue;
        const a = 1 - q;
        rho += a * a;
        // Near density counts only pairs closer than the rest spacing: it stops clumping without
        // pushing a resting surface apart, so the surface holds by tension, not by a balance of the two.
        if (q < NEAR_Q) { const b = 1 - q / NEAR_Q; near += b * b * b; }
      }
      let pressure = k * (rho - rho0);
      if (pressure < 0) pressure *= tension * tension * COHESION;
      const nearP = kNear * near;
      let dx = 0, dy = 0, dz = 0;
      for (let s = s0; s < s1; s++) {
        const j = this.nList[s];
        const rx = this.x[j] - xi, ry = this.y[j] - yi, rz = this.z[j] - zi;
        const r = Math.sqrt(rx * rx + ry * ry + rz * rz);
        if (r >= h || r <= 1e-12) continue;
        const a = 1 - r / h;
        const b = r / h < NEAR_Q ? 1 - r / (h * NEAR_Q) : 0;
        const d = (pressure * a + nearP * b * b) * h * 0.5 / r;
        const mx = rx * d, my = ry * d, mz = rz * d;
        this.x[j] += mx * 0.5; this.y[j] += my * 0.5; this.z[j] += mz * 0.5;
        dx -= mx * 0.5; dy -= my * 0.5; dz -= mz * 0.5;
      }
      this.x[i] += dx; this.y[i] += dy; this.z[i] += dz;
    }
  }

  // --- 6. collide -------------------------------------------------------------------------------------

  private collide(p: FxParams, dt: number): void {
    const r = this.spacing * 0.5;
    const [sx, sy, sz] = this.region;
    const obstacle = this.obstacle;
    for (let i = 0; i < this.count; i++) {
      this.contact[i] = 0;
      if (obstacle) {
        const d = obstacle(this.x[i], this.y[i], this.z[i]);
        if (d < r) {
          // Out along the distance gradient, to the surface plus a radius.
          const e = this.spacing * 0.25;
          const gx = obstacle(this.x[i] + e, this.y[i], this.z[i]) - obstacle(this.x[i] - e, this.y[i], this.z[i]);
          const gy = obstacle(this.x[i], this.y[i] + e, this.z[i]) - obstacle(this.x[i], this.y[i] - e, this.z[i]);
          const gz = obstacle(this.x[i], this.y[i], this.z[i] + e) - obstacle(this.x[i], this.y[i], this.z[i] - e);
          const gl = Math.hypot(gx, gy, gz);
          if (gl > 1e-9) {
            const push = (r - d) / gl;
            this.x[i] += gx * push; this.y[i] += gy * push; this.z[i] += gz * push;
          }
        }
      }
      if (p.floorMode === 'solid' && this.y[i] < r) {
        const k = i * 3;
        this.hitV[k] = (this.x[i] - this.ox[i]) / dt;
        this.hitV[k + 1] = (this.y[i] - this.oy[i]) / dt;
        this.hitV[k + 2] = (this.z[i] - this.oz[i]) / dt;
        this.y[i] = r;
        this.contact[i] = 1;
      } else if (p.floorMode === 'absorb' && this.y[i] < 0) {
        this.dead[i] = 1;
        this.absorbed += this.particleVolume;
        continue;
      }
      const below = p.floorMode === 'none' ? -0.5 * sy : -r;
      if (this.x[i] < 0 || this.x[i] > sx || this.z[i] < 0 || this.z[i] > sz || this.y[i] > sy || this.y[i] < below) {
        this.dead[i] = 1;
        this.escaped += this.particleVolume;
      }
    }
  }

  // --- 7. velocity, bounce, deposit -------------------------------------------------------------------

  private settle(p: FxParams, dt: number): void {
    const inv = 1 / dt;
    const film = this.film;
    const r = this.spacing * 0.5;
    for (let i = 0; i < this.count; i++) {
      if (this.dead[i]) continue;
      this.vx[i] = (this.x[i] - this.ox[i]) * inv;
      this.vy[i] = (this.y[i] - this.oy[i]) * inv;
      this.vz[i] = (this.z[i] - this.oz[i]) * inv;
      if (!this.contact[i]) {
        // Something already lying on the floor and nearly still has come to rest in the pool.
        if (film && this.y[i] < r * 1.6 && Math.hypot(this.vx[i], this.vy[i], this.vz[i]) < STICK_SPEED * 0.5) {
          film.deposit(this.x[i], this.z[i], this.particleVolume, 0, 0, this.id[i]);
          this.deposited += this.particleVolume;
          this.dead[i] = 1;
        }
        continue;
      }
      const k = i * 3;
      const hx = this.hitV[k], hy = this.hitV[k + 1], hz = this.hitV[k + 2];
      const speed = Math.hypot(hx, hy, hz);
      const sticks = hash3(this.id[i], this.bounces[i], 13, p.seed) < p.stickiness;
      if (film && (sticks || speed < STICK_SPEED || this.bounces[i] >= MAX_BOUNCES)) {
        film.deposit(this.x[i], this.z[i], this.particleVolume, hx, hz, this.id[i]);
        this.deposited += this.particleVolume;
        this.dead[i] = 1;
        continue;
      }
      // A bounce: the speed into the floor comes back by `floorBounce`, the speed along it loses `floorFriction`.
      const keep = 1 - Math.max(0, Math.min(1, p.floorFriction));
      this.vx[i] = hx * keep;
      this.vz[i] = hz * keep;
      this.vy[i] = Math.abs(hy) * Math.max(0, Math.min(1, p.floorBounce));
      this.bounces[i] = Math.min(255, this.bounces[i] + 1);
    }
  }

  /** Drop the dead, keeping the living in order. */
  private compact(): void {
    let w = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.dead[i]) continue;
      if (w !== i) {
        this.x[w] = this.x[i]; this.y[w] = this.y[i]; this.z[w] = this.z[i];
        this.vx[w] = this.vx[i]; this.vy[w] = this.vy[i]; this.vz[w] = this.vz[i];
        this.id[w] = this.id[i]; this.bounces[w] = this.bounces[i];
      }
      this.dead[w] = 0;
      w++;
    }
    this.count = w;
  }
}

// --- the source ---------------------------------------------------------------------------------------

interface P3 { x: number; y: number; z: number }

/** The aim as a unit vector: yaw around the vertical from +Z toward +X, pitch up from the horizontal. */
export function aimVector(p: Pick<FxParams, 'sourceYaw' | 'sourcePitch'>): [number, number, number] {
  const yaw = (p.sourceYaw * Math.PI) / 180, pitch = (p.sourcePitch * Math.PI) / 180;
  return [Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)];
}

/** The source's centre in region space (from the region's low corner), metres: `emitterPosition` is from the floor's centre. */
export function sourceCenter(p: Pick<FxParams, 'emitterPosition' | 'regionSize'>): P3 {
  const e = p.emitterPosition, r = p.regionSize;
  return { x: e[0] + r[0] / 2, y: Math.min(r[1], Math.max(0, e[1])), z: e[2] + r[2] / 2 };
}

/** Two unit vectors perpendicular to `d` and each other. */
function basis(d: readonly number[]): [[number, number, number], [number, number, number]] {
  const a = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let ux = a[1] * d[2] - a[2] * d[1], uy = a[2] * d[0] - a[0] * d[2], uz = a[0] * d[1] - a[1] * d[0];
  const l = Math.hypot(ux, uy, uz) || 1;
  ux /= l; uy /= l; uz /= l;
  return [[ux, uy, uz], [d[1] * uz - d[2] * uy, d[2] * ux - d[0] * uz, d[0] * uy - d[1] * ux]];
}

/**
 * `count` positions on a lattice of `spacing` filling the source's shape, nearest the centre first:
 * a ball (point, sphere), a slab across the aim (disc), a band round a ring (ring, with its core).
 * The lattice is the rest spacing, so a burst starts at rest density and nothing explodes.
 */
function burstPositions(p: FxParams, count: number, spacing: number): P3[] {
  const c = sourceCenter(p);
  const j = (id: number, axis: number) => (hash3(id, axis, 3, p.seed) - 0.5) * 0.2 * spacing;
  const out: P3[] = [];
  if (p.sourceShape === 'ring') {
    const core = Math.round(count * Math.max(0, Math.min(1, p.ringCore)));
    const band = count - core;
    const R = Math.max(spacing * 2, p.sourceRadius);
    // The band: rings of points round the circle, stacked up and out until there are enough.
    const around = Math.max(6, Math.floor((2 * Math.PI * R) / spacing));
    for (let k = 0; out.length < band; k++) {
      const layer = Math.floor(k / around), a = ((k % around) + (layer % 2) * 0.5) / around * 2 * Math.PI;
      const ring = R + (layer % 2) * spacing * 0.7;
      const id = out.length;
      out.push({ x: c.x + Math.sin(a) * ring + j(id, 0), y: c.y + Math.floor(layer / 2) * spacing + j(id, 1), z: c.z + Math.cos(a) * ring + j(id, 2) });
    }
    out.push(...ball(c, core, spacing, p.seed));
    return out;
  }
  if (p.sourceShape === 'disc') {
    const d = aimVector(p);
    const [u, v] = basis(d);
    const R = Math.max(spacing, p.sourceRadius);
    const pts: { s: number; q: P3 }[] = [];
    const n = Math.ceil(R / spacing);
    for (let layer = 0; pts.length < count * 1.2 + 8 || layer === 0; layer++) {
      for (let a = -n; a <= n; a++) for (let b = -n; b <= n; b++) {
        const ra = a * spacing, rb = b * spacing;
        if (ra * ra + rb * rb > R * R) continue;
        const w = -layer * spacing;
        pts.push({ s: layer * 1e3 + ra * ra + rb * rb, q: {
          x: c.x + u[0] * ra + v[0] * rb + d[0] * w, y: c.y + u[1] * ra + v[1] * rb + d[1] * w, z: c.z + u[2] * ra + v[2] * rb + d[2] * w,
        } });
      }
      if (layer > 4096) break;
    }
    pts.sort((x, y) => x.s - y.s);
    return pts.slice(0, count).map((e, id) => ({ x: e.q.x + j(id, 0), y: e.q.y + j(id, 1), z: e.q.z + j(id, 2) }));
  }
  return ball(c, count, spacing, p.seed);
}

/** `count` lattice points nearest `c`: a ball of liquid at rest spacing. */
function ball(c: P3, count: number, spacing: number, seed: number): P3[] {
  if (count <= 0) return [];
  const R = Math.cbrt((3 * count) / (4 * Math.PI)) + 1.5;
  const n = Math.ceil(R);
  const pts: { s: number; q: P3 }[] = [];
  for (let a = -n; a <= n; a++) for (let b = -n; b <= n; b++) for (let e = -n; e <= n; e++) {
    const s = a * a + b * b + e * e;
    // Ties broken by a fixed order, so the same count always takes the same points.
    pts.push({ s: s + ((a + n) * 4 + (b + n) * 2 + (e + n)) * 1e-9, q: { x: a, y: b, z: e } });
  }
  pts.sort((x, y) => x.s - y.s);
  return pts.slice(0, count).map((e, id) => ({
    x: c.x + (e.q.x + (hash3(id, 0, 5, seed) - 0.5) * 0.2) * spacing,
    y: c.y + (e.q.y + (hash3(id, 1, 5, seed) - 0.5) * 0.2) * spacing,
    z: c.z + (e.q.z + (hash3(id, 2, 5, seed) - 0.5) * 0.2) * spacing,
  }));
}

/** Where jet particle `id` is released: across the source's cross-section, at the source. */
function jetPosition(p: FxParams, id: number, spacing: number): P3 {
  const c = sourceCenter(p);
  const a = hash3(id, 1, 9, p.seed) * 2 * Math.PI, rr = Math.sqrt(hash3(id, 2, 9, p.seed));
  if (p.sourceShape === 'ring') {
    const core = hash3(id, 3, 9, p.seed) < p.ringCore;
    const R = core ? spacing * 2 : Math.max(spacing * 2, p.sourceRadius);
    const r = core ? R * rr : R + (rr - 0.5) * spacing * 2;
    return { x: c.x + Math.sin(a) * r, y: c.y, z: c.z + Math.cos(a) * r };
  }
  const d = aimVector(p);
  const [u, v] = basis(d);
  const R = p.sourceShape === 'point' ? spacing * 1.5 : Math.max(spacing, p.sourceRadius);
  const ra = Math.cos(a) * rr * R, rb = Math.sin(a) * rr * R;
  return { x: c.x + u[0] * ra + v[0] * rb, y: c.y + u[1] * ra + v[1] * rb, z: c.z + u[2] * ra + v[2] * rb };
}

/** Of a release variable, the share that is the particle's own; the rest is shared with its neighbours. */
const OWN_SHARE = 0.25;
/** The cone variables' scale: the noise sits mostly within +/-0.5, and the cone's edge is at 1. */
const CONE_GAIN = 1.8;

/**
 * Particle `id`'s release velocity: a speed between the range's ends, in a direction inside the spray
 * cone round the aim (or out of the ball's centre for a ball, out of the ring for a ring), plus the
 * break-up's noise. Speed and direction are mostly COHERENT -- noise over where the particle starts
 * (and, for a jet, how far the stream has come), features about five droplets across -- so neighbours
 * leave together as sheets and fingers that surface tension then beads, instead of a cloud of single drops.
 */
function releaseVelocity(p: FxParams, id: number, pos: P3, spacing: number, time: number): [number, number, number] {
  const c = sourceCenter(p);
  const aim0 = aimVector(p);
  const along = time * (p.sourceSpeed[0] + p.sourceSpeed[1]) * 0.5;
  const f = 1 / (5 * spacing);
  const nx = (pos.x + aim0[0] * along) * f, ny = (pos.y + aim0[1] * along) * f, nz = (pos.z + aim0[2] * along) * f;
  const shared = (k: number) => Math.min(1, Math.max(0, 0.5 + 0.8 * valueNoise3(nx, ny, nz, p.seed + 37 * k)));
  const pick = (k: number, salt: number) => shared(k) * (1 - OWN_SHARE) + hash3(id, salt, 11, p.seed) * OWN_SHARE;
  const speed = lerp(p.sourceSpeed[0], p.sourceSpeed[1], pick(1, 4));
  // Where in the cone: two zero-mean variables across it, mostly shared with the neighbours. Symmetric
  // about the aim, so the spray's mean stays on it whatever the seed or the noise's lean.
  const across = (k: number, salt: number) =>
    (valueNoise3(nx, ny, nz, p.seed + 37 * k) * (1 - OWN_SHARE) + (hash3(id, salt, 11, p.seed) * 2 - 1) * OWN_SHARE) * CONE_GAIN;
  const cone: [number, number] = [across(2, 5), across(3, 6)];
  let d = aimVector(p);
  const spread = Math.max(0, Math.min(180, p.sourceSpread));
  if (p.sourceShape === 'sphere') {
    // Out of the ball: radial at a full spread, along the aim at none.
    const ox = pos.x - c.x, oy = pos.y - c.y, oz = pos.z - c.z;
    const l = Math.hypot(ox, oy, oz);
    if (l > 1e-9) {
      const w = spread / 180;
      const m = [ox / l * w + d[0] * (1 - w), oy / l * w + d[1] * (1 - w), oz / l * w + d[2] * (1 - w)];
      const ml = Math.hypot(m[0], m[1], m[2]) || 1;
      d = [m[0] / ml, m[1] / ml, m[2] / ml];
    }
  } else if (p.sourceShape === 'ring') {
    const ox = pos.x - c.x, oz = pos.z - c.z;
    const l = Math.hypot(ox, oz);
    const core = l < Math.max(spacing * 2.5, p.sourceRadius * 0.5);
    if (core) d = [0, 1, 0];
    else {
      const pitch = (p.sourcePitch * Math.PI) / 180;
      d = [Math.cos(pitch) * ox / l, Math.sin(pitch), Math.cos(pitch) * oz / l];
    }
    if (core) return jitterCone([0, 1, 0], Math.min(spread, 8), cone).map(v => v * speed * 1.3) as [number, number, number];
  }
  // Inside the cone (the ball has already spread its directions out).
  const angle = p.sourceShape === 'sphere' ? Math.min(spread, 12) : p.sourceShape === 'ring' ? Math.min(spread, 25) : spread;
  const dir = jitterCone(d, angle, cone);
  const v: [number, number, number] = [dir[0] * speed, dir[1] * speed, dir[2] * speed];
  if (p.sourceBreakup > 0) {
    // Finer than the release's own variation: tears the sheets into fingers.
    const g = 1 / (2.5 * spacing);
    const k = p.sourceBreakup * speed * 0.35;
    v[0] += k * valueNoise3(nx * 2 + pos.x * g, ny * 2, nz * 2, p.seed + 101);
    v[1] += k * valueNoise3(nx * 2, ny * 2 + pos.y * g, nz * 2, p.seed + 202);
    v[2] += k * valueNoise3(nx * 2, ny * 2, nz * 2 + pos.z * g, p.seed + 303);
  }
  return v;
}

/**
 * A unit vector within `angleDeg` of `d`, from an offset (a, b) across the cone, each zero-mean in about
 * -1..1: the tilt grows with its length (out to the edge at 1), toward its direction. Symmetric in (a, b),
 * so directions made from zero-mean offsets average out on `d` -- which the polar form this replaced, fed
 * coherent noise rather than uniform numbers, did not: its spray leaned off the aim.
 */
function jitterCone(d: readonly number[], angleDeg: number, r: [number, number]): [number, number, number] {
  const len = Math.hypot(r[0], r[1]);
  if (angleDeg <= 0 || len < 1e-9) return [d[0], d[1], d[2]];
  const tilt = (Math.min(1, len) * Math.min(180, angleDeg) * Math.PI) / 180;
  const ct = Math.cos(tilt), st = Math.sin(tilt);
  const ca = r[0] / len, cb = r[1] / len;
  const [u, v] = basis(d);
  return [
    d[0] * ct + (u[0] * ca + v[0] * cb) * st,
    d[1] * ct + (u[1] * ca + v[1] * cb) * st,
    d[2] * ct + (u[2] * ca + v[2] * cb) * st,
  ];
}

// --- helpers ------------------------------------------------------------------------------------------

function nextPow2(v: number): number {
  let n = 1;
  while (n < v) n <<= 1;
  return n;
}

/** Teschner et al. 2003's spatial hash of a cell. */
function cellHash(x: number, y: number, z: number): number {
  return ((Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0);
}

/**
 * Σ (1 - r/h)^2 over a particle's neighbours inside a cubic lattice at the rest spacing: the density
 * the relaxation holds the liquid's interior at.
 */
export function latticeDensity(): number {
  const n = Math.ceil(KERNEL_RATIO);
  let rho = 0;
  for (let a = -n; a <= n; a++) for (let b = -n; b <= n; b++) for (let c = -n; c <= n; c++) {
    if (a === 0 && b === 0 && c === 0) continue;
    const q = Math.hypot(a, b, c) / KERNEL_RATIO;
    if (q < 1) rho += (1 - q) * (1 - q);
  }
  return rho;
}

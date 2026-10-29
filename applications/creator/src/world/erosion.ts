// World Creator's erosion passes, CPU versions (research doc B3 "Terrain": GPU erosion -- virtual-pipe
// hydraulic, thermal -- layered over the construction tree). The GPU virtual-pipe pass in
// pipeErosionGpu.ts runs the same equations; these are the reference, the WebGL2 path, and what the
// tests pin.
//
// Every pass works in CELL UNITS: a height of 1 is one grid spacing. The stack's heights are a fraction
// of the world's height scale, so each pass converts in (`h * heightScale / cellSize`) and back. That
// keeps the physical constants (talus angle, droplet capacity, pipe gravity) meaning the same thing at
// any world size. What does NOT carry over is iteration counts: water and droplets travel in cells, so
// the same settings erode a 2049 export more finely than a 257 preview.
//
// Everything here is deterministic: no Math.random, no time, a fixed iteration order. The only
// randomness, droplet spawn points, comes from the engine's seeded PRNG.

import { seededRandom } from 'cleo/terrain/sculpt';
import { yieldToUi, GenerationCancelled, type GenerateContext } from '../core/generator';

/** Physical frame for a height grid. */
export interface WorldFrame {
  resolution: number;
  /** World units across the map. */
  size: number;
  /** World units of a height of 1. */
  heightScale: number;
}

export const cellSize = (f: WorldFrame) => f.size / (f.resolution - 1);
const toCells = (f: WorldFrame) => f.heightScale / cellSize(f);

export interface ThermalParams {
  iterations: number;
  /** Angle of repose, degrees: slopes steeper than this slump. */
  talus: number;
  /** 0..1, how much of the excess moves per iteration. */
  rate: number;
}

export interface DropletParams {
  /** Droplets per 1000 cells (so density, not a count, is what the preset fixes). */
  density: number;
  inertia: number;
  capacity: number;
  minSlope: number;
  erosion: number;
  deposition: number;
  evaporation: number;
  gravity: number;
  lifetime: number;
  /** Erosion brush radius, cells. */
  radius: number;
  seed: number;
}

export interface PipeParams {
  iterations: number;
  /** Rain per iteration, cell units. */
  rain: number;
  evaporation: number;
  /** Sediment capacity constant. */
  capacity: number;
  /** Dissolving constant. */
  dissolve: number;
  /** Deposition constant. */
  deposit: number;
  /** Time step. */
  dt: number;
}

/** What the pipe model learned about water on the way, for the flow and wetness masks. */
export interface PipeMasks {
  /** Time-averaged water speed x depth (discharge), unnormalised. */
  flow: Float32Array;
  /** Water depth left standing at the end, cell units. */
  water: Float32Array;
}

/** Thermal erosion (Musgrave et al. 1989): material slumps from any slope steeper than the talus angle. */
export async function thermalErosion(h: Float32Array, f: WorldFrame, p: ThermalParams, ctx?: GenerateContext): Promise<void> {
  const res = f.resolution;
  const k = toCells(f);
  const talus = Math.tan((Math.max(0, Math.min(89, p.talus)) * Math.PI) / 180);
  const rate = Math.min(1, Math.max(0, p.rate)) * 0.5;
  const delta = new Float32Array(h.length);
  // 8-neighbourhood; diagonal drops are measured over sqrt(2) cells.
  const NB: [number, number, number][] = [[-1, 0, 1], [1, 0, 1], [0, -1, 1], [0, 1, 1], [-1, -1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [1, 1, Math.SQRT2]];
  const iterations = Math.max(0, Math.round(p.iterations));
  for (let it = 0; it < iterations; it++) {
    delta.fill(0);
    for (let r = 0; r < res; r++) for (let c = 0; c < res; c++) {
      const i = r * res + c;
      const hi = h[i] * k;
      let total = 0, maxDrop = 0;
      for (const [dc, dr, dist] of NB) {
        const cc = c + dc, rr = r + dr;
        if (cc < 0 || rr < 0 || cc >= res || rr >= res) continue;
        const drop = hi - h[rr * res + cc] * k - talus * dist;
        if (drop > 0) { total += drop; if (drop > maxDrop) maxDrop = drop; }
      }
      if (total <= 0) continue;
      const moved = rate * maxDrop;
      for (const [dc, dr, dist] of NB) {
        const cc = c + dc, rr = r + dr;
        if (cc < 0 || rr < 0 || cc >= res || rr >= res) continue;
        const j = rr * res + cc;
        const drop = hi - h[j] * k - talus * dist;
        if (drop > 0) {
          const share = (moved * drop) / total;
          delta[i] -= share;
          delta[j] += share;
        }
      }
    }
    for (let i = 0; i < h.length; i++) h[i] += delta[i] / k;
    if ((it & 7) === 7) await checkpoint(ctx, (it + 1) / iterations, 'Thermal erosion');
  }
}

/**
 * Droplet hydraulic erosion (Beyer 2015, "Implementation of a method for hydraulic erosion"): many
 * single droplets roll downhill, picking up sediment where they speed up and dropping it where they
 * slow, carving gullies and fans. Generalised here from the engine's brush-local version to the whole map.
 */
export async function dropletErosion(h: Float32Array, f: WorldFrame, p: DropletParams, ctx?: GenerateContext): Promise<void> {
  const res = f.resolution;
  const k = toCells(f);
  const cells = new Float32Array(h.length);
  for (let i = 0; i < h.length; i++) cells[i] = h[i] * k;

  // Erosion brush: weights over a disc of `radius` cells, normalised.
  const radius = Math.max(1, Math.round(p.radius));
  const brush: [number, number, number][] = [];
  let wsum = 0;
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
    const d = Math.hypot(dx, dy);
    if (d <= radius) { const w = 1 - d / radius; brush.push([dx, dy, w]); wsum += w; }
  }
  for (const b of brush) b[2] /= wsum;

  const rand = seededRandom(p.seed >>> 0);
  const drops = Math.round((p.density / 1000) * res * res);
  const heightGrad = (x: number, y: number) => {
    const c = Math.floor(x), r = Math.floor(y);
    const u = x - c, v = y - r;
    const i = r * res + c;
    const nw = cells[i], ne = cells[i + 1], sw = cells[i + res], se = cells[i + res + 1];
    return {
      height: nw * (1 - u) * (1 - v) + ne * u * (1 - v) + sw * (1 - u) * v + se * u * v,
      gx: (ne - nw) * (1 - v) + (se - sw) * v,
      gy: (sw - nw) * (1 - u) + (se - ne) * u,
    };
  };

  for (let n = 0; n < drops; n++) {
    let x = rand() * (res - 2), y = rand() * (res - 2);
    let dx = 0, dy = 0, speed = 1, water = 1, sediment = 0;
    for (let life = 0; life < p.lifetime; life++) {
      const c = Math.floor(x), r = Math.floor(y);
      const u = x - c, v = y - r;
      const g = heightGrad(x, y);
      dx = dx * p.inertia - g.gx * (1 - p.inertia);
      dy = dy * p.inertia - g.gy * (1 - p.inertia);
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) break;
      dx /= len; dy /= len;
      x += dx; y += dy;
      if (x < 0 || y < 0 || x >= res - 1 || y >= res - 1) break;
      const dh = heightGrad(x, y).height - g.height;
      const capacity = Math.max(-dh, p.minSlope) * speed * water * p.capacity;
      const i = r * res + c;
      if (sediment > capacity || dh > 0) {
        // Fill a pit up to the droplet's own height at most; otherwise drop a share of the excess.
        const amount = dh > 0 ? Math.min(dh, sediment) : (sediment - capacity) * p.deposition;
        sediment -= amount;
        cells[i] += amount * (1 - u) * (1 - v);
        cells[i + 1] += amount * u * (1 - v);
        cells[i + res] += amount * (1 - u) * v;
        cells[i + res + 1] += amount * u * v;
      } else {
        const amount = Math.min((capacity - sediment) * p.erosion, -dh);
        for (const [bx, by, w] of brush) {
          const cc = c + bx, rr = r + by;
          if (cc < 0 || rr < 0 || cc >= res || rr >= res) continue;
          const j = rr * res + cc;
          const take = amount * w;
          cells[j] -= take;
          sediment += take;
        }
      }
      speed = Math.sqrt(Math.max(0, speed * speed + dh * p.gravity));
      water *= 1 - p.evaporation;
    }
    if ((n & 4095) === 4095) await checkpoint(ctx, n / drops, 'Droplet erosion');
  }
  for (let i = 0; i < h.length; i++) h[i] = cells[i] / k;
}

/**
 * Virtual-pipe hydraulic erosion (Mei, Decaudin & Hu 2007, "Fast Hydraulic Erosion Simulation and
 * Visualization on GPU"): a shallow-water grid where each cell exchanges water with its four
 * neighbours through virtual pipes; flow speed drives a sediment capacity, and sediment is dissolved,
 * deposited and advected with the water. Produces the flow and wetness masks as a by-product.
 */
export async function pipeErosion(h: Float32Array, f: WorldFrame, p: PipeParams, ctx?: GenerateContext): Promise<PipeMasks> {
  const res = f.resolution;
  const N = res * res;
  const k = toCells(f);
  const st = createPipeState(h, res, k);
  const iterations = Math.max(0, Math.round(p.iterations));
  for (let it = 0; it < iterations; it++) {
    pipeStep(st, res, p);
    if ((it & 15) === 15) await checkpoint(ctx, (it + 1) / iterations, 'Hydraulic erosion');
  }
  for (let i = 0; i < N; i++) h[i] = st.b[i] / k;
  const flow = new Float32Array(N);
  if (iterations > 0) for (let i = 0; i < N; i++) flow[i] = st.flowSum[i] / iterations;
  return { flow, water: st.d };
}

/** The pipe model's state, exposed so the GPU path's tests can compare against one CPU step. */
export interface PipeState {
  b: Float32Array; d: Float32Array; s: Float32Array;
  fL: Float32Array; fR: Float32Array; fT: Float32Array; fB: Float32Array;
  u: Float32Array; v: Float32Array;
  scratch: Float32Array;
  flowSum: Float32Array;
}

export function createPipeState(h: Float32Array, res: number, cellsPerUnit: number): PipeState {
  const N = res * res;
  const b = new Float32Array(N);
  for (let i = 0; i < N; i++) b[i] = h[i] * cellsPerUnit;
  const z = () => new Float32Array(N);
  return { b, d: z(), s: z(), fL: z(), fR: z(), fT: z(), fB: z(), u: z(), v: z(), scratch: z(), flowSum: z() };
}

/** Gravity and pipe cross-section over length, folded into one constant (A * g / l with l = 1 cell). */
const PIPE_K = 9.81;
/** Sediment capacity needs SOME tilt even on flat ground, or standing water never erodes. */
const MIN_TILT = 0.05;
/** Bed removed per step, at most, per cell of water depth. */
const MAX_ERODE_PER_DEPTH = 0.5;

export function pipeStep(st: PipeState, res: number, p: PipeParams): void {
  const { b, d, s, fL, fR, fT, fB, u, v, scratch, flowSum } = st;
  const dt = p.dt;
  const N = res * res;
  // 1. Rain.
  for (let i = 0; i < N; i++) d[i] += p.rain * dt;
  // 2. Outflow flux through each virtual pipe, scaled so a cell never sends more water than it has.
  for (let r = 0; r < res; r++) for (let c = 0; c < res; c++) {
    const i = r * res + c;
    const H = b[i] + d[i];
    const out = (j: number, prev: number) => Math.max(0, prev + dt * PIPE_K * (H - b[j] - d[j]));
    fL[i] = c > 0 ? out(i - 1, fL[i]) : 0;
    fR[i] = c < res - 1 ? out(i + 1, fR[i]) : 0;
    fT[i] = r > 0 ? out(i - res, fT[i]) : 0;
    fB[i] = r < res - 1 ? out(i + res, fB[i]) : 0;
    const total = (fL[i] + fR[i] + fT[i] + fB[i]) * dt;
    if (total > d[i] && total > 0) {
      const K = d[i] / total;
      fL[i] *= K; fR[i] *= K; fT[i] *= K; fB[i] *= K;
    }
  }
  // 3. Water surface and velocity field.
  for (let r = 0; r < res; r++) for (let c = 0; c < res; c++) {
    const i = r * res + c;
    const inL = c > 0 ? fR[i - 1] : 0, inR = c < res - 1 ? fL[i + 1] : 0;
    const inT = r > 0 ? fB[i - res] : 0, inB = r < res - 1 ? fT[i + res] : 0;
    const dV = dt * (inL + inR + inT + inB - (fL[i] + fR[i] + fT[i] + fB[i]));
    const d1 = d[i];
    const d2 = Math.max(0, d1 + dV);
    scratch[i] = d2;
    const mean = (d1 + d2) * 0.5;
    const wx = (inL - fL[i] + fR[i] - inR) * 0.5;
    const wy = (inT - fT[i] + fB[i] - inB) * 0.5;
    // Clamped to one cell per step (the CFL limit of the sediment advection below): a film of water
    // racing down a steep flank otherwise reports a speed the grid cannot carry, and scours noise.
    const maxSpeed = 1 / dt;
    u[i] = mean > 1e-5 ? Math.max(-maxSpeed, Math.min(maxSpeed, wx / mean)) : 0;
    v[i] = mean > 1e-5 ? Math.max(-maxSpeed, Math.min(maxSpeed, wy / mean)) : 0;
  }
  d.set(scratch);
  // 4. Erosion and deposition against the local transport capacity. The tilt is read from a snapshot of
  //    the bed, so the result does not depend on visiting order (and matches the GPU kernel, which
  //    cannot see its neighbours' writes either).
  scratch.set(b);
  for (let r = 0; r < res; r++) for (let c = 0; c < res; c++) {
    const i = r * res + c;
    const gx = (scratch[r * res + Math.min(res - 1, c + 1)] - scratch[r * res + Math.max(0, c - 1)]) * 0.5;
    const gy = (scratch[Math.min(res - 1, r + 1) * res + c] - scratch[Math.max(0, r - 1) * res + c]) * 0.5;
    const sinTilt = Math.max(MIN_TILT, Math.sqrt(gx * gx + gy * gy) / Math.sqrt(1 + gx * gx + gy * gy));
    const speed = Math.hypot(u[i], v[i]);
    // Capacity scales with depth up to a cell, so a thin film does not scour like a river.
    const C = p.capacity * sinTilt * speed * Math.min(1, d[i]);
    if (C > s[i]) {
      // Never more than the water there can hold: erosion is a property of flowing water, not of slope.
      const take = Math.min(p.dissolve * (C - s[i]), d[i] * MAX_ERODE_PER_DEPTH);
      b[i] -= take; s[i] += take;
    } else {
      const drop = p.deposit * (s[i] - C);
      b[i] += drop; s[i] -= drop;
    }
    flowSum[i] += speed * d[i];
  }
  // 5. Sediment advection, semi-Lagrangian.
  for (let r = 0; r < res; r++) for (let c = 0; c < res; c++) {
    const i = r * res + c;
    const x = Math.min(res - 1, Math.max(0, c - u[i] * dt));
    const y = Math.min(res - 1, Math.max(0, r - v[i] * dt));
    scratch[i] = bilinear(s, res, x, y);
  }
  s.set(scratch);
  // 6. Evaporation.
  const keep = Math.max(0, 1 - p.evaporation * dt);
  for (let i = 0; i < N; i++) d[i] *= keep;
}

function bilinear(a: Float32Array, res: number, x: number, y: number): number {
  const c = Math.min(res - 2, Math.floor(x)), r = Math.min(res - 2, Math.floor(y));
  const tx = x - c, ty = y - r;
  const i = r * res + c;
  return (a[i] * (1 - tx) + a[i + 1] * tx) * (1 - ty) + (a[i + res] * (1 - tx) + a[i + res + 1] * tx) * ty;
}

async function checkpoint(ctx: GenerateContext | undefined, fraction: number, label: string): Promise<void> {
  if (!ctx) return;
  ctx.progress(fraction, label);
  await yieldToUi();
  if (ctx.cancelled) throw new GenerationCancelled();
}

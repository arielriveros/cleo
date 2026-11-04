// The GPU floor film (liquidFilmGpu.ts and its fxFilm*.wgsl kernels) step for step in TypeScript, over a
// LiquidFilm's own grid: so the tests can hold the GPU film to the CPU one (the bake's) on the same deposits.
// `legacyGpuStep` is the scheme the GPU ran before 2026-11-04 (Jacobi, a flux transfer limited to a quarter
// of the donor): kept to show why it was replaced. `gpuStep` is what the kernels run now.

import type { FxParams } from '../../src/fx/fxParams';
import { FILM_DRY, FILM_REF, FLOW_RATE, LiquidFilm, MOBILITY_CAP } from '../../src/fx/liquidFilm';
import { LiquidCpu } from '../../src/fx/liquidCpu';

/** A film's private parts, for the twin. */
interface FilmInternals { h: Float32Array; stain: Float32Array; pin: Float32Array; cols: number; rows: number; cell: number; gx0: number; gz0: number; cover(a: number, b: number, c: number, d: number): void; updatePinning(p: FxParams): void }
const inner = (f: LiquidFilm) => f as unknown as FilmInternals;

/** What happened to a run's film: each deposit, and each step. */
export type FilmEvent = { kind: 'deposit'; x: number; z: number; volume: number; vx: number; vz: number; id: number } | { kind: 'step'; dt: number };

/** Run `p` on the CPU for `seconds`, recording everything its film was handed. */
export function recordFilm(p: FxParams, seconds: number): { sim: LiquidCpu; events: FilmEvent[] } {
  const sim = new LiquidCpu(p);
  const film = sim.film!;
  const events: FilmEvent[] = [];
  const deposit = film.deposit.bind(film), step = film.step.bind(film);
  film.deposit = (x, z, volume, vx, vz, id) => { events.push({ kind: 'deposit', x, z, volume, vx, vz, id }); deposit(x, z, volume, vx, vz, id); };
  film.step = (q, dt) => { events.push({ kind: 'step', dt }); step(q, dt); };
  for (let t = 0; t < seconds; t += p.frameTime) sim.step(p, p.frameTime);
  return { sim, events };
}

/** Feed `events` to a fresh film, stepping it with `step` (the film's own when omitted). */
export function replayFilm(p: FxParams, events: FilmEvent[], step?: (film: LiquidFilm, p: FxParams, dt: number) => void): LiquidFilm {
  const film = new LiquidFilm(p);
  for (const e of events) {
    if (e.kind === 'deposit') film.deposit(e.x, e.z, e.volume, e.vx, e.vz, e.id);
    else if (step) step(film, p, e.dt);
    else film.step(p, e.dt);
  }
  return film;
}

/**
 * Make room around the wet cells, as the GPU's window has, and the rectangle a step works over: the wet box
 * and `reach` cells round it (window cells, x0, z0, x1, z1 inclusive), or null when all is dry. Outside it the
 * floor is dry with dry neighbours, which no step changes, so working over it alone gives the window's result.
 */
function roomAround(film: LiquidFilm, reach: number): [number, number, number, number] | null {
  let box = film.wetBox();
  if (!box) return null;
  const f = inner(film);
  f.cover(f.gx0 + box.x0 - reach, f.gz0 + box.z0 - reach, f.gx0 + box.x1 + reach, f.gz0 + box.z1 + reach);
  box = film.wetBox()!;
  return [Math.max(0, box.x0 - reach), Math.max(0, box.z0 - reach), Math.min(f.cols - 1, box.x1 + reach), Math.min(f.rows - 1, box.z1 + reach)];
}

/** k x the face between cells i and j at thicknesses hi, hj: fxFilmCommon.wgsl `face`. */
function face(pin: Float32Array, i: number, hi: number, j: number, hj: number, kRef: number, kMax: number): number {
  if (hi <= FILM_DRY) { if (hj <= FILM_DRY || hj <= pin[j]) return 0; }
  else if (hj <= FILM_DRY && hi <= pin[i]) return 0;
  const r = (hi + hj) * 0.5 / FILM_REF;
  return Math.min(kRef * r * r * r, kMax);
}

/** The GPU film's step before 2026-11-04: 20 Jacobi iterations, then a flux transfer from the last iterate (limited to a quarter of the donor per face, clamped at 0), then the soak. */
export function legacyGpuStep(film: LiquidFilm, p: FxParams, dt: number): void {
  const f = inner(film);
  f.updatePinning(p);
  const rect = roomAround(film, 24);
  if (!rect) return;
  const [x0, z0, x1, z1] = rect;
  const { cols, rows, cell, pin } = f;
  const h = f.h, n = cols * rows;
  const dRef = Math.max(0, p.flow) * FLOW_RATE, k = dt / (cell * cell);
  const kRef = k * dRef, kMax = k * dRef * MOBILITY_CAP;
  let cur = Float32Array.from(h), next = new Float32Array(n);
  for (let it = 0; it < 20; it++) {
    for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix <= x1; ix++) {
      const i = ix + cols * iz, hi = cur[i];
      const l = ix > 0 ? cur[i - 1] : hi, r = ix < cols - 1 ? cur[i + 1] : hi, u = iz > 0 ? cur[i - cols] : hi, d = iz < rows - 1 ? cur[i + cols] : hi;
      if (hi <= FILM_DRY && l <= FILM_DRY && r <= FILM_DRY && u <= FILM_DRY && d <= FILM_DRY) { next[i] = hi; continue; }
      let num = h[i], den = 1;
      const add = (j: number, hj: number) => { const m = face(pin, i, hi, j, hj, kRef, kMax); num += m * hj; den += m; };
      if (ix > 0) add(i - 1, l); if (ix < cols - 1) add(i + 1, r); if (iz > 0) add(i - cols, u); if (iz < rows - 1) add(i + cols, d);
      next[i] = num / den;
    }
    [cur, next] = [next, cur];
  }
  const star = cur, share = p.soak > 0 ? 1 - Math.exp(-p.soak * dt) : 0;
  const out = Float32Array.from(h);
  for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix <= x1; ix++) {
    const i = ix + cols * iz, si = star[i];
    let v = h[i];
    const inflow = (j: number) => { const sj = star[j]; const fl = face(pin, i, si, j, sj, kRef, kMax) * (sj - si); return Math.min(0.25 * sj, Math.max(-0.25 * si, fl)); };
    if (ix > 0) v += inflow(i - 1); if (ix < cols - 1) v += inflow(i + 1); if (iz > 0) v += inflow(i - cols); if (iz < rows - 1) v += inflow(i + cols);
    out[i] = Math.max(0, v);
  }
  for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix <= x1; ix++) { const i = ix + cols * iz; const s = out[i] * share; h[i] = out[i] - s; f.stain[i] += s; }
}

/**
 * The GPU film's step now, as the kernels run it (fxFilmMeasure / Total / Sweep / Scale): measure (the volume
 * and the thickest cell) -> the CPU's sweep count -> each sweep ZEBRA LINE Gauss-Seidel in place: the even rows
 * (global cell parity), each row in sequence along x -- one GPU thread a row -- then the odd rows, then the
 * same for the columns along z, every line forward on even sweeps and backward on odd ones (as the CPU
 * alternates), over the wet box and the CPU's reach round it (sweeps + 2 cells) -> measure -> the volume put
 * back by one rescale -> the soak. Lines within a colour never read
 * each other, so the GPU's result does not depend on thread order. Of the parallel orderings tried, it is the
 * one whose pools come out like the CPU's lexicographic sweeps (the bake's): as many separate pools, about the
 * same wet area.
 */
export function gpuStep(film: LiquidFilm, p: FxParams, dt: number): void {
  const f = inner(film);
  f.updatePinning(p);
  if (!roomAround(film, 26)) return;
  const box = film.wetBox()!;
  const { cols, rows, cell, pin, gx0, gz0 } = f;
  const h = f.h;
  const dRef = Math.max(0, p.flow) * FLOW_RATE;
  const share = p.soak > 0 ? 1 - Math.exp(-p.soak * dt) : 0;
  let rect = [box.x0, box.z0, box.x1, box.z1];
  const each = (fn: (i: number) => void) => { for (let iz = rect[1]; iz <= rect[3]; iz++) for (let ix = rect[0]; ix <= rect[2]; ix++) fn(ix + cols * iz); };
  if (dRef > 0) {
    const dMax = dRef * MOBILITY_CAP, k = dt / (cell * cell), kRef = k * dRef, kMax = k * dMax;
    let hMax = 0;
    each(i => { if (h[i] > hMax) hMax = h[i]; });
    const r = hMax / FILM_REF;
    const sweeps = Math.min(24, Math.max(2, Math.ceil(2 * Math.sqrt(k * Math.min(dMax, dRef * r * r * r)))));
    // The sweeps work over the wet box and as many cells round it as the front can move (the CPU's reach).
    const reach = sweeps + 2;
    rect = [Math.max(0, box.x0 - reach), Math.max(0, box.z0 - reach), Math.min(cols - 1, box.x1 + reach), Math.min(rows - 1, box.z1 + reach)];
    const [x0, z0, x1, z1] = rect;
    let before = 0;
    each(i => { before += h[i]; });
    const old = Float32Array.from(h);
    const update = (ix: number, iz: number) => {
      const i = ix + cols * iz, hi = h[i];
      const l = ix > 0 ? h[i - 1] : hi, rt = ix < cols - 1 ? h[i + 1] : hi, u = iz > 0 ? h[i - cols] : hi, d = iz < rows - 1 ? h[i + cols] : hi;
      if (hi <= FILM_DRY && l <= FILM_DRY && rt <= FILM_DRY && u <= FILM_DRY && d <= FILM_DRY) return;
      let num = old[i], den = 1;
      const add = (j: number, hj: number) => { const m = face(pin, i, hi, j, hj, kRef, kMax); num += m * hj; den += m; };
      if (ix > 0) add(i - 1, l); if (ix < cols - 1) add(i + 1, rt); if (iz > 0) add(i - cols, u); if (iz < rows - 1) add(i + cols, d);
      h[i] = num / den;
    };
    for (let s = 0; s < sweeps; s++) {
      const fwd = (s & 1) === 0;
      for (let colour = 0; colour < 2; colour++) for (let iz = z0; iz <= z1; iz++) {
        if (((gz0 + iz) & 1) !== colour) continue;
        for (let t = x0; t <= x1; t++) update(fwd ? t : x0 + x1 - t, iz);
      }
      for (let colour = 0; colour < 2; colour++) for (let ix = x0; ix <= x1; ix++) {
        if (((gx0 + ix) & 1) !== colour) continue;
        for (let t = z0; t <= z1; t++) update(ix, fwd ? t : z0 + z1 - t);
      }
    }
    let after = 0;
    each(i => { after += h[i]; });
    if (after > 0 && before > 0) { const scale = before / after; each(i => { h[i] *= scale; }); }
  }
  if (share > 0) for (let i = 0; i < h.length; i++) { if (h[i] <= 0) continue; const s = h[i] * share; h[i] -= s; f.stain[i] += s; }
}

/** The film's wet cells (wet or soaked): a mask over its window. */
export function wetMask(film: LiquidFilm): Uint8Array {
  const f = inner(film);
  const m = new Uint8Array(f.cols * f.rows);
  for (let i = 0; i < m.length; i++) m[i] = f.h[i] + f.stain[i] > FILM_DRY ? 1 : 0;
  return m;
}

/** Wet cells in global cells (gx, gz) -> 1, to compare films whose windows differ. */
export function wetCells(film: LiquidFilm): Set<number> {
  const f = inner(film), m = wetMask(film), out = new Set<number>();
  for (let iz = 0; iz < f.rows; iz++) for (let ix = 0; ix < f.cols; ix++) if (m[ix + f.cols * iz]) out.add((f.gx0 + ix + 100000) * 1048576 + (f.gz0 + iz + 100000));
  return out;
}

/** How many separate wet regions (4-connected) the film holds. */
export function wetRegions(film: LiquidFilm): number {
  const f = inner(film), m = wetMask(film), { cols, rows } = f;
  const seen = new Uint8Array(m.length);
  let regions = 0;
  const stack: number[] = [];
  for (let s = 0; s < m.length; s++) {
    if (!m[s] || seen[s]) continue;
    regions++;
    seen[s] = 1; stack.push(s);
    while (stack.length) {
      const i = stack.pop()!, ix = i % cols, iz = (i - ix) / cols;
      const visit = (j: number) => { if (m[j] && !seen[j]) { seen[j] = 1; stack.push(j); } };
      if (ix > 0) visit(i - 1); if (ix < cols - 1) visit(i + 1); if (iz > 0) visit(i - cols); if (iz < rows - 1) visit(i + cols);
    }
  }
  return regions;
}

/** Intersection over union of two films' wet cells. */
export function wetIoU(a: LiquidFilm, b: LiquidFilm): number {
  const A = wetCells(a), B = wetCells(b);
  let both = 0;
  for (const c of A) if (B.has(c)) both++;
  return both / Math.max(1, A.size + B.size - both);
}

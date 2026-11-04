// The liquid on the floor: a height field the drops land in, flows out and soaks in. It is what the FX
// Creator bakes into the floor DECAL (renderFilm).
//
// Its cells follow the DROPLETS, not the region: half a droplet across (`filmCell`), so a drop lands as
// a drop and an edge is as fine as the liquid -- in a 1 m region or a 10 m one. The grid is anchored on
// the centre of the region's floor and kept only where liquid has landed: a window of cells that grows
// (with a margin) as drops land or a pool spreads toward its edge, so its cost is the stain's, not the
// region's. A stain outgrowing MAX_SIDE cells a side doubles the cells (keeping what is there).
//
// Flow is the thin-film (lubrication) equation, dh/dt = div(D(h) grad h), with the mobility D growing as
// h^3 -- a thick puddle runs, a thin film barely creeps -- stepped SEMI-IMPLICITLY: backward Euler solved
// by Gauss-Seidel sweeps, the mobilities and the edge holds taken from the sweep's current state. Every
// update is a weighted mean of a cell and its neighbours, so it is stable at any cell size and never goes
// negative; the volume is restored exactly after the sweeps. Contact-line PINNING stops it: liquid only
// advances onto dry floor from a cell holding more than its edge-hold thickness, a threshold that varies
// across the floor with `edgeNoise`, so pools stop with ragged edges. Soaking moves wet height into
// `stain` (a matte, dried mark) at `soak` per second. Volume is conserved: what lands is always h + stain.
//
// Window cell (ix, iz) is global cell (gx0 + ix, gz0 + iz); global cell (0, 0) has its low corner at the
// centre of the region's floor. Row iz runs along +z, column ix along +x: a decal's image seen from above
// (decal uv (0.5 + x, 0.5 - z), its top row at -z), so a window of the film is a decal frame as it stands.

import { hash3, valueNoise3 } from './fluidCpu';
import type { FxParams } from './fxParams';

/** Below this thickness (m) a cell counts as dry. */
export const FILM_DRY = 2e-5;
/** The film thickness at which the mobility reaches the `flow` setting's reference rate, m. */
export const FILM_REF = 1.5e-3;
/** The mobility (m^2/s) at full `flow` and the reference thickness. */
export const FLOW_RATE = 0.03;
/** Mobility is capped at this multiple of the reference. */
export const MOBILITY_CAP = 4;
/** Most Gauss-Seidel sweeps a step: each lets the liquid's front move about a cell. */
const SWEEPS = 24;
/** Cells kept around what is wet when the window grows. */
const MARGIN = 24;
/** Most cells the window holds a side before its cells double. */
const MAX_SIDE = 2048;
/** The flow works in tiles of this many cells a side, skipping those where nothing moves. */
const TILE = 16;
/** A tile whose cells all changed less than this in a sweep (m) has settled for this step. */
const SETTLED = FILM_DRY * 0.1;

/** The film's cell side for `p`, metres: half a droplet. */
export function filmCell(p: Pick<FxParams, 'dropletSize'>): number {
  return Math.max(2.5e-4, p.dropletSize / 2);
}

/** A film's state at one moment: its window and both height fields (for a decal frame rendered later). */
export interface FilmSnapshot {
  h: Float32Array;
  stain: Float32Array;
  gx0: number;
  gz0: number;
  cols: number;
  rows: number;
  cell: number;
}

export class LiquidFilm implements FilmSnapshot {
  /** Cell side, metres. */
  cell: number;
  /** The window: its first global cell and its size in cells. */
  gx0 = 0;
  gz0 = 0;
  cols = 0;
  rows = 0;
  /** Wet thickness, metres, per window cell. */
  h = new Float32Array(0);
  /** Soaked-in (dried) liquid, metres of thickness, per window cell. */
  stain = new Float32Array(0);
  /** Each cell's edge-hold thickness, metres. */
  private pin = new Float32Array(0);
  /** Cells a body stands on: liquid does not flow into or out of them. Null for none. */
  private solid: Uint8Array | null = null;
  private obstacle: ((x: number, y: number, z: number) => number) | null = null;
  private pinFor = '';
  private readonly seed: number;
  /** Region space (from the region's low corner) of global cell (0, 0)'s low corner: the floor's centre. */
  private readonly ox: number;
  private readonly oz: number;
  private params: Pick<FxParams, 'pinning' | 'edgeNoise' | 'seed'>;

  constructor(p: FxParams, cell = filmCell(p)) {
    this.cell = cell;
    this.seed = p.seed;
    this.ox = p.regionSize[0] / 2;
    this.oz = p.regionSize[2] / 2;
    this.params = p;
  }

  /** The window's low corner in region space (x, z), metres. */
  get x0(): number { return this.ox + this.gx0 * this.cell; }
  get z0(): number { return this.oz + this.gz0 * this.cell; }

  /** Total liquid on the floor, wet and soaked, m^3. */
  volume(): number {
    let s = 0;
    for (let i = 0; i < this.h.length; i++) s += this.h[i] + this.stain[i];
    return s * this.cell * this.cell;
  }

  /** Make room for liquid landing anywhere in region box [x0, x1] x [z0, z1] metres: one growth for a whole batch of drops. */
  reserve(x0: number, z0: number, x1: number, z1: number): void {
    const [ga, gza] = this.globalCell(x0, z0), [gb, gzb] = this.globalCell(x1, z1);
    this.cover(ga, gza, gb, gzb);
  }

  /** The region-space (x, z) of window cell (ix, iz)'s centre. */
  cellCenter(ix: number, iz: number): [number, number] {
    return [this.x0 + (ix + 0.5) * this.cell, this.z0 + (iz + 0.5) * this.cell];
  }

  /** The global cell holding region point (x, z). */
  private globalCell(x: number, z: number): [number, number] {
    return [Math.floor((x - this.ox) / this.cell), Math.floor((z - this.oz) / this.cell)];
  }

  /**
   * A drop of `volume` m^3 landing at region (x, z) with horizontal velocity (vx, vz): a soft stamp,
   * stretched along the way it was moving and shifted forward (a fast drop smears), with a few small
   * satellite drops thrown ahead of a fast one. All of `volume` lands, wherever it is split.
   */
  deposit(x: number, z: number, volume: number, vx: number, vz: number, id: number): void {
    const speed = Math.hypot(vx, vz);
    const r0 = Math.max(this.cell * 1.2, Math.cbrt(volume) * 0.9);
    const stretch = 1 + Math.min(3, speed * 0.35);
    const ux = speed > 1e-6 ? vx / speed : 1, uz = speed > 1e-6 ? vz / speed : 0;
    const satellites = speed > 2 ? 1 + Math.floor(hash3(id, 1, 21, this.seed) * 2.5) : 0;
    const share = satellites > 0 ? 0.18 : 0;
    const main = volume * (1 - share);
    this.stamp(x + ux * r0 * (stretch - 1) * 0.5, z + uz * r0 * (stretch - 1) * 0.5, main, r0 * stretch, r0, ux, uz);
    for (let s = 0; s < satellites; s++) {
      const along = r0 * stretch * (1.4 + hash3(id, s, 23, this.seed) * 2.2);
      const side = (hash3(id, s, 29, this.seed) - 0.5) * r0 * 2;
      const rs = Math.max(this.cell * 0.8, r0 * 0.35);
      this.stamp(x + ux * along - uz * side, z + uz * along + ux * side, (volume * share) / satellites, rs, rs, ux, uz);
    }
  }

  /**
   * An elliptical paraboloid cap of `volume` (thickest in the middle, exactly nothing past its semi-axes `a`
   * along (ux, uz) and `b` across: no tails to leave a faint halo round every drop), normalised to land whole.
   */
  private stamp(x: number, z: number, volume: number, a: number, b: number, ux: number, uz: number): void {
    const reach = Math.max(a, b) * 1.05;
    const [ga, gza] = this.globalCell(x - reach, z - reach);
    const [gb, gzb] = this.globalCell(x + reach, z + reach);
    this.cover(ga, gza, gb, gzb);
    const c = this.cell, cols = this.cols;
    const ix0 = ga - this.gx0, ix1 = gb - this.gx0, iz0 = gza - this.gz0, iz1 = gzb - this.gz0;
    let sum = 0;
    const cx0 = this.x0 + 0.5 * c, cz0 = this.z0 + 0.5 * c;
    const w = (ix: number, iz: number) => {
      const dx = cx0 + ix * c - x, dz = cz0 + iz * c - z;
      const u = dx * ux + dz * uz, v = -dx * uz + dz * ux;
      return Math.max(0, 1 - (u * u) / (a * a) - (v * v) / (b * b));
    };
    for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) sum += w(ix, iz);
    if (sum <= 1e-12) {
      // Smaller than a cell: all of it into the nearest one.
      const [gx, gz] = this.globalCell(x, z);
      this.h[(gx - this.gx0) + cols * (gz - this.gz0)] += volume / (c * c);
      return;
    }
    const k = volume / (sum * c * c);
    for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) this.h[ix + cols * iz] += w(ix, iz) * k;
  }

  /**
   * Make the window hold global cells [ga..gb] x [gza..gzb], growing it with a margin (and, past
   * MAX_SIDE cells a side, doubling the cells) and carrying over what it holds.
   */
  private cover(ga: number, gza: number, gb: number, gzb: number): void {
    if (this.cols > 0 && ga >= this.gx0 && gza >= this.gz0 && gb < this.gx0 + this.cols && gzb < this.gz0 + this.rows) return;
    let x0 = this.cols > 0 ? Math.min(this.gx0, ga) : ga, z0 = this.cols > 0 ? Math.min(this.gz0, gza) : gza;
    let x1 = this.cols > 0 ? Math.max(this.gx0 + this.cols - 1, gb) : gb, z1 = this.cols > 0 ? Math.max(this.gz0 + this.rows - 1, gzb) : gzb;
    // Grown in proportion to what is there, so a spreading stain reallocates (and re-draws its edge noise)
    // a few times, not once per drop.
    const margin = Math.max(MARGIN, Math.ceil(0.25 * Math.max(this.cols, this.rows)));
    x0 -= margin; z0 -= margin; x1 += margin; z1 += margin;
    if (Math.max(x1 - x0 + 1, z1 - z0 + 1) > MAX_SIDE) {
      this.coarsen();
      const half = (g: number) => Math.floor(g / 2);
      this.cover(half(ga), half(gza), half(gb), half(gzb));
      return;
    }
    const cols = x1 - x0 + 1, rows = z1 - z0 + 1;
    const h = new Float32Array(cols * rows), stain = new Float32Array(cols * rows);
    for (let iz = 0; iz < this.rows; iz++) {
      const row = (this.gz0 + iz - z0) * cols + (this.gx0 - x0);
      h.set(this.h.subarray(iz * this.cols, (iz + 1) * this.cols), row);
      stain.set(this.stain.subarray(iz * this.cols, (iz + 1) * this.cols), row);
    }
    this.gx0 = x0; this.gz0 = z0; this.cols = cols; this.rows = rows;
    this.h = h; this.stain = stain;
    this.pin = new Float32Array(cols * rows);
    this.pinFor = '';
    this.updatePinning(this.params);
    this.buildSolid();
  }

  /** Double the cells (2 x 2 into 1, volume kept): a stain larger than the window may hold. */
  private coarsen(): void {
    const cols = Math.ceil(this.cols / 2) + 1, rows = Math.ceil(this.rows / 2) + 1;
    const gx0 = Math.floor(this.gx0 / 2), gz0 = Math.floor(this.gz0 / 2);
    const h = new Float32Array(cols * rows), stain = new Float32Array(cols * rows);
    for (let iz = 0; iz < this.rows; iz++) for (let ix = 0; ix < this.cols; ix++) {
      const j = (Math.floor((this.gx0 + ix) / 2) - gx0) + cols * (Math.floor((this.gz0 + iz) / 2) - gz0);
      h[j] += this.h[ix + this.cols * iz] / 4;
      stain[j] += this.stain[ix + this.cols * iz] / 4;
    }
    this.cell *= 2;
    this.gx0 = gx0; this.gz0 = gz0; this.cols = cols; this.rows = rows;
    this.h = h; this.stain = stain;
    this.pin = new Float32Array(cols * rows);
    this.pinFor = '';
    this.updatePinning(this.params);
    this.buildSolid();
  }

  /** The edge-hold threshold per cell, re-made when the setting, its noise or the window changes. */
  private updatePinning(p: Pick<FxParams, 'pinning' | 'edgeNoise' | 'seed'>): void {
    this.params = p;
    const key = `${p.pinning}:${p.edgeNoise}:${p.seed}`;
    if (key === this.pinFor) return;
    this.pinFor = key;
    // Features about 1.5 cm across in the world, two octaves: the floor's own texture deciding where an
    // edge stops. From global cells, so they stay put as the window grows.
    const f = this.cell / 0.015;
    for (let iz = 0; iz < this.rows; iz++) for (let ix = 0; ix < this.cols; ix++) {
      const gx = this.gx0 + ix, gz = this.gz0 + iz;
      const n = 0.65 * valueNoise3(gx * f, gz * f, 0.5, p.seed + 41) + 0.35 * valueNoise3(gx * f * 2.7, gz * f * 2.7, 1.5, p.seed + 43);
      this.pin[ix + this.cols * iz] = Math.max(0, (p.pinning / 1000) * (1 + Math.max(0, Math.min(1, p.edgeNoise)) * 1.2 * n));
    }
  }

  /**
   * The preview's bodies, as a signed distance in region space (negative inside): the cells whose floor a
   * body stands on are walled off, so a pool stops against a box or a wall. Null clears them.
   */
  setObstacle(distance: ((x: number, y: number, z: number) => number) | null): void {
    this.obstacle = distance;
    this.buildSolid();
  }

  private buildSolid(): void {
    const distance = this.obstacle;
    if (!distance || this.cols === 0) { this.solid = null; return; }
    const y = this.cell * 0.5;
    const solid = new Uint8Array(this.cols * this.rows);
    let any = false;
    for (let iz = 0; iz < this.rows; iz++) for (let ix = 0; ix < this.cols; ix++) {
      const [x, z] = this.cellCenter(ix, iz);
      if (distance(x, y, z) <= 0) { solid[ix + this.cols * iz] = 1; any = true; }
    }
    this.solid = any ? solid : null;
  }

  /** The window cells holding liquid (wet or soaked), or null when it is all dry. */
  wetBox(): { x0: number; z0: number; x1: number; z1: number } | null {
    let x0 = this.cols, x1 = -1, z0 = this.rows, z1 = -1;
    for (let iz = 0; iz < this.rows; iz++) for (let ix = 0; ix < this.cols; ix++) {
      const i = ix + this.cols * iz;
      if (this.h[i] <= FILM_DRY && this.stain[i] <= FILM_DRY) continue;
      if (ix < x0) x0 = ix; if (ix > x1) x1 = ix; if (iz < z0) z0 = iz; if (iz > z1) z1 = iz;
    }
    return x1 < 0 ? null : { x0, z0, x1, z1 };
  }

  /** Advance `dt` seconds: flow, then soak. */
  step(p: FxParams, dt: number): void {
    this.updatePinning(p);
    if (this.cols === 0) return;
    const dRef = Math.max(0, p.flow) * FLOW_RATE;
    if (dRef > 0) this.flow(dRef, dt);
    if (p.soak > 0) {
      const f = 1 - Math.exp(-p.soak * dt);
      const h = this.h;
      for (let i = 0; i < h.length; i++) {
        if (h[i] <= 0) continue;
        const d = h[i] * f;
        h[i] -= d;
        this.stain[i] += d;
      }
    }
  }

  /**
   * One backward-Euler step of the thin-film equation over the wet part of the window: Gauss-Seidel
   * sweeps of h_i = (h_i^old + k sum M_ij h_j) / (1 + k sum M_ij), each face's mobility M_ij from the
   * sweep's current thickness and closed where liquid would advance onto dry floor from a cell at or below
   * its edge hold (or into a body). A mean of non-negative values, so the film stays non-negative and
   * stable whatever the step; then the volume is put back exactly as it was.
   *
   * The sweeps go tile by tile, and only over tiles where something can still move: at first those
   * holding liquid and their neighbours, then those that changed in the last sweep and theirs. A
   * spatter's settled drops and the dry floor between them cost nothing.
   */
  private flow(dRef: number, dt: number): void {
    const dMax = dRef * MOBILITY_CAP;
    const cols = this.cols, rows = this.rows, h = this.h, pin = this.pin, solid = this.solid;
    const box = this.wetBox();
    if (!box) return;
    // As many sweeps as the liquid can travel cells this step (its diffusion length, sqrt(D dt) / cell,
    // twice: a sweep carries it one way): a thick pool many, a thin film that barely creeps two.
    let hMax = 0;
    for (let iz = box.z0; iz <= box.z1; iz++) for (let ix = box.x0; ix <= box.x1; ix++) hMax = Math.max(hMax, h[ix + cols * iz]);
    const mobility = (t: number) => { const r = t / FILM_REF; return Math.min(dMax, dRef * r * r * r); };
    const k = dt / (this.cell * this.cell);
    const sweeps = Math.min(SWEEPS, Math.max(2, Math.ceil(2 * Math.sqrt(k * mobility(hMax)))));
    // The front can move a cell a sweep: room for that, then grow the window if it gets near the edge.
    const reach = sweeps + 2;
    this.cover(this.gx0 + box.x0 - reach, this.gz0 + box.z0 - reach, this.gx0 + box.x1 + reach, this.gz0 + box.z1 + reach);
    if (this.h !== h) { this.flow(dRef, dt); return; }
    const x0 = Math.max(0, box.x0 - reach), x1 = Math.min(cols - 1, box.x1 + reach);
    const z0 = Math.max(0, box.z0 - reach), z1 = Math.min(rows - 1, box.z1 + reach);
    let before = 0;
    for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix <= x1; ix++) before += h[ix + cols * iz];
    const old = h.slice();
    const dry = FILM_DRY, inv = 1 / FILM_REF, kRef = k * dRef, kMax = k * dMax;
    /**
     * k x the face from cell i (thickness hi) to j: its mobility, 0 where liquid may not cross -- between
     * two dry cells, onto dry floor from a wet cell at or below its edge hold, or into a body.
     */
    const face = (i: number, hi: number, j: number): number => {
      const hj = h[j];
      if (hi <= dry) { if (hj <= dry || hj <= pin[j]) return 0; } else if (hj <= dry && hi <= pin[i]) return 0;
      if (solid !== null && (solid[i] | solid[j])) return 0;
      const r = (hi + hj) * 0.5 * inv;
      const km = kRef * r * r * r;
      return km < kMax ? km : kMax;
    };
    const tx0 = Math.floor(x0 / TILE), tz0 = Math.floor(z0 / TILE);
    const tw = Math.floor(x1 / TILE) - tx0 + 1, th = Math.floor(z1 / TILE) - tz0 + 1;
    let active: Uint8Array = new Uint8Array(tw * th);
    const change = new Float32Array(tw * th);
    /** `marks` with every marked tile's eight neighbours marked too. */
    const grow = (marks: Uint8Array): Uint8Array => {
      const out = new Uint8Array(tw * th);
      for (let tz = 0; tz < th; tz++) for (let tx = 0; tx < tw; tx++) {
        if (!marks[tx + tw * tz]) continue;
        for (let dz = Math.max(0, tz - 1); dz <= Math.min(th - 1, tz + 1); dz++)
          for (let dx = Math.max(0, tx - 1); dx <= Math.min(tw - 1, tx + 1); dx++) out[dx + tw * dz] = 1;
      }
      return out;
    };
    for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix <= x1; ix++) {
      if (h[ix + cols * iz] > FILM_DRY) active[Math.floor(ix / TILE) - tx0 + tw * (Math.floor(iz / TILE) - tz0)] = 1;
    }
    active = grow(active);
    for (let s = 0; s < sweeps; s++) {
      // Alternate the sweep direction: the front moves as freely one way as the other.
      const fwd = (s & 1) === 0;
      change.fill(0);
      for (let a = 0; a < th; a++) {
        const tz = fwd ? a : th - 1 - a;
        const cz0 = Math.max(z0, (tz0 + tz) * TILE), cz1 = Math.min(z1, (tz0 + tz) * TILE + TILE - 1);
        for (let b = 0; b < tw; b++) {
          const tx = fwd ? b : tw - 1 - b;
          if (!active[tx + tw * tz]) continue;
          const cx0 = Math.max(x0, (tx0 + tx) * TILE), cx1 = Math.min(x1, (tx0 + tx) * TILE + TILE - 1);
          let most = 0;
          for (let c = 0; c <= cz1 - cz0; c++) {
            const iz = fwd ? cz0 + c : cz1 - c;
            for (let d = 0; d <= cx1 - cx0; d++) {
              const ix = fwd ? cx0 + d : cx1 - d;
              const i = ix + cols * iz;
              const hi = h[i];
              // Dry with dry neighbours: nothing crosses any of its faces.
              if (hi <= dry && (ix === 0 || h[i - 1] <= dry) && (ix === cols - 1 || h[i + 1] <= dry)
                  && (iz === 0 || h[i - cols] <= dry) && (iz === rows - 1 || h[i + cols] <= dry)) continue;
              let num = old[i], den = 1, m = 0;
              if (ix > 0 && (m = face(i, hi, i - 1)) > 0) { num += m * h[i - 1]; den += m; }
              if (ix < cols - 1 && (m = face(i, hi, i + 1)) > 0) { num += m * h[i + 1]; den += m; }
              if (iz > 0 && (m = face(i, hi, i - cols)) > 0) { num += m * h[i - cols]; den += m; }
              if (iz < rows - 1 && (m = face(i, hi, i + cols)) > 0) { num += m * h[i + cols]; den += m; }
              const v = num / den;
              const dv = v > hi ? v - hi : hi - v;
              if (dv > most) most = dv;
              h[i] = v;
            }
          }
          change[tx + tw * tz] = most;
        }
      }
      // The next sweep: the tiles still moving, and their neighbours (what moved may move them).
      let moving = false;
      active.fill(0);
      for (let t = 0; t < change.length; t++) if (change[t] > SETTLED) { active[t] = 1; moving = true; }
      if (!moving) break;
      active = grow(active);
    }
    let after = 0;
    for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix <= x1; ix++) after += h[ix + cols * iz];
    if (after > 0 && before > 0) {
      const scale = before / after;
      for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix <= x1; ix++) h[ix + cols * iz] *= scale;
    }
  }

  /** A copy of the window and both thicknesses, for a decal frame rendered later. */
  snapshot(): FilmSnapshot {
    return { h: this.h.slice(), stain: this.stain.slice(), gx0: this.gx0, gz0: this.gz0, cols: this.cols, rows: this.rows, cell: this.cell };
  }
}

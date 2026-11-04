// A floor that does not read as a repeating tile: the set re-made at twice its size, each of CELLS x CELLS
// cells showing the set at a random offset and quarter-turn, the cells blended at their borders (stochastic
// texturing, after Heitz and Neyret). The blend keeps the set's contrast (a plain average of unrelated
// samples greys it), normals are turned with their cell, and the result still tiles: the cell grid wraps.
// One output pixel is one pixel of the set, so no filtering is needed. It covers two repeats of the set.

import type { FloorMaps } from './floorComposite';

/** Cells a synthesized floor is divided into a side. */
const CELLS = 4;

const smooth01 = (x: number) => { const t = x < 0 ? 0 : x > 1 ? 1 : x; return t * t * (3 - 2 * t); };

function hash(x: number, y: number, seed: number): number {
  let h = (Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841) ^ Math.imul(seed + 1, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

const ROLES = ['diff', 'nor', 'arm', 'disp'] as const;

export function synthesizeFloor(base: FloorMaps, seed = 5): FloorMaps {
  const n = base.size, m = n * 2;
  const out: FloorMaps = { size: m, diff: new Uint8ClampedArray(m * m * 4) };
  for (const r of ROLES) if (base[r]) out[r] = new Uint8ClampedArray(m * m * 4);
  // Each map's mean: the level the blend keeps its contrast around.
  const mean: Record<string, number[]> = {};
  for (const r of ROLES) {
    const a = base[r];
    if (!a) continue;
    const s = [0, 0, 0];
    for (let i = 0; i < n * n; i++) { s[0] += a[i * 4]; s[1] += a[i * 4 + 1]; s[2] += a[i * 4 + 2]; }
    mean[r] = s.map(v => v / (n * n));
  }
  // Per cell: an offset (whole pixels) and a quarter-turn count, from a hash that wraps with the grid.
  const cells: { ox: number; oy: number; k: number }[] = [];
  for (let j = 0; j < CELLS; j++) for (let i = 0; i < CELLS; i++) {
    cells.push({ ox: Math.floor(hash(i, j, seed) * n), oy: Math.floor(hash(j + 31, i + 17, seed) * n), k: Math.floor(hash(i + 7, j + 3, seed + 9) * 4) });
  }
  const at = (i: number, j: number) => cells[(((j % CELLS) + CELLS) % CELLS) * CELLS + (((i % CELLS) + CELLS) % CELLS)];
  const S = m / CELLS;
  const acc: Record<string, number[]> = {};
  for (const r of ROLES) acc[r] = [0, 0, 0];
  const w = [0, 0, 0, 0];
  for (let Y = 0; Y < m; Y++) for (let X = 0; X < m; X++) {
    // Blend between the four cells whose centres surround the pixel.
    const gx = (X + 0.5) / S - 0.5, gy = (Y + 0.5) / S - 0.5;
    const i0 = Math.floor(gx), j0 = Math.floor(gy);
    const tx = smooth01(gx - i0), ty = smooth01(gy - j0);
    w[0] = (1 - tx) * (1 - ty); w[1] = tx * (1 - ty); w[2] = (1 - tx) * ty; w[3] = tx * ty;
    const k = 1 / Math.sqrt(w[0] * w[0] + w[1] * w[1] + w[2] * w[2] + w[3] * w[3]);
    const o = (X + m * Y) * 4;
    for (const r of ROLES) { const t = acc[r]; t[0] = t[1] = t[2] = 0; }
    const x = X % n, y = Y % n;
    for (let q = 0; q < 4; q++) {
      if (w[q] <= 1e-4) continue;
      const c = at(i0 + (q & 1), j0 + (q >> 1));
      // The set's pixel this cell shows here: the output pixel turned by the cell's quarter-turn, then shifted.
      let bx: number, by: number;
      if (c.k === 0) { bx = x; by = y; } else if (c.k === 1) { bx = y; by = n - 1 - x; } else if (c.k === 2) { bx = n - 1 - x; by = n - 1 - y; } else { bx = n - 1 - y; by = x; }
      const idx = (((bx + c.ox) % n) + n * ((by + c.oy) % n)) * 4;
      for (const r of ROLES) {
        const a = base[r];
        if (!a) continue;
        let v0 = a[idx], v1 = a[idx + 1];
        const v2 = a[idx + 2];
        if (r === 'nor') {
          // The tangent-space xy turned with the cell (image y runs down, a normal's green up).
          const nx = v0 / 127.5 - 1, vy = -(v1 / 127.5 - 1);
          let rx = nx, ry = vy;
          if (c.k === 1) { rx = -vy; ry = nx; } else if (c.k === 2) { rx = -nx; ry = -vy; } else if (c.k === 3) { rx = vy; ry = -nx; }
          v0 = (rx + 1) * 127.5; v1 = (1 - ry) * 127.5;
        }
        const t = acc[r];
        t[0] += w[q] * v0; t[1] += w[q] * v1; t[2] += w[q] * v2;
      }
    }
    for (const r of ROLES) {
      const dst = out[r];
      if (!dst) continue;
      const a = acc[r];
      if (r === 'nor') {
        let nx = a[0] / 127.5 - 1, ny = a[1] / 127.5 - 1, nz = a[2] / 127.5 - 1;
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l; ny /= l; nz /= l;
        dst[o] = (nx + 1) * 127.5; dst[o + 1] = (ny + 1) * 127.5; dst[o + 2] = (nz + 1) * 127.5;
      } else {
        const mu = mean[r];
        for (let ch = 0; ch < 3; ch++) dst[o + ch] = mu[ch] + (a[ch] - mu[ch]) * k;
      }
      dst[o + 3] = 255;
    }
  }
  return out;
}

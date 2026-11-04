import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { floorSetName, scanFloorSets } from '../vite.floors';
import { compositeFloor, type FloorMaps } from '../src/app/floor/floorComposite';

describe('floor sets', () => {
  it('finds sets with a colour map, names them, and skips zips and empty folders', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'floors-'));
    const set = (id: string, files: string[]) => { mkdirSync(path.join(dir, id, 'textures'), { recursive: true }); for (const f of files) writeFileSync(path.join(dir, id, 'textures', f), ''); };
    set('rocky_trail_02_1k', ['rocky_trail_02_diff_1k.png', 'rocky_trail_02_nor_gl_1k.png', 'rocky_trail_02_arm_1k.png', 'rocky_trail_02_disp_1k.png', 'rocky_trail_02_rough_1k.png']);
    set('forest_leaves_02_1k', ['forest_leaves_02_diffuse_1k.png', 'forest_leaves_02_arm_1k.png']);
    set('nocolour_1k', ['nocolour_arm_1k.png']);
    mkdirSync(path.join(dir, 'wood_table_large_1k'));
    writeFileSync(path.join(dir, 'dirt_1k.zip'), '');
    const sets = scanFloorSets(dir);
    expect(sets.map(s => s.id)).toEqual(['forest_leaves_02_1k', 'rocky_trail_02_1k']);
    expect(sets[1]).toMatchObject({ name: 'Rocky trail 02', diff: 'textures/rocky_trail_02_diff_1k.png', nor: 'textures/rocky_trail_02_nor_gl_1k.png', disp: 'textures/rocky_trail_02_disp_1k.png' });
    expect(sets[0].diff).toBe('textures/forest_leaves_02_diffuse_1k.png');
    expect(sets[0].nor).toBeUndefined();
    expect(floorSetName('coast_sand_02_1k')).toBe('Coast sand 02');
    expect(scanFloorSets(path.join(dir, 'missing'))).toEqual([]);
  });
});

describe('floor weather', () => {
  const N = 32;
  const maps = (): FloorMaps => {
    const fill = (r: number, g: number, b: number) => { const a = new Uint8ClampedArray(N * N * 4); for (let i = 0; i < N * N; i++) a.set([r, g, b, 255], i * 4); return a; };
    const disp = new Uint8ClampedArray(N * N * 4);
    for (let i = 0; i < N * N; i++) { const h = (i % N) * 8; disp.set([h, h, h, 255], i * 4); }
    return { size: N, diff: fill(120, 100, 80), nor: fill(128, 128, 255), arm: fill(255, 200, 0), disp };
  };
  const mean = (a: Uint8ClampedArray, c: number) => { let s = 0; for (let i = c; i < a.length; i += 4) s += a[i]; return s / (a.length / 4); };

  it('returns the set untouched when dry and clear', () => {
    const m = maps();
    const out = compositeFloor(m, null, { wetness: 0, snow: 0 });
    expect(Array.from(out.diff)).toEqual(Array.from(m.diff));
    expect(Array.from(out.arm)).toEqual(Array.from(m.arm));
  });

  it('wets: darker, glossier, and puddles only in the low spots past half', () => {
    const m = maps();
    const damp = compositeFloor(m, null, { wetness: 0.4, snow: 0 });
    expect(mean(damp.diff, 0)).toBeLessThan(120);
    expect(mean(damp.arm, 1)).toBeLessThan(200);
    const flat = (o: ReturnType<typeof compositeFloor>, x: number) => o.nor[(x + N * 3) * 4];
    expect(flat(damp, 0)).toBe(128);
    const soaked = compositeFloor(m, null, { wetness: 1, snow: 0 });
    // The low columns (height 0) are puddles: nearly mirror rough; the high ones are not.
    expect(soaked.arm[(0 + N * 3) * 4 + 1]).toBeLessThan(25);
    expect(soaked.arm[((N - 1) + N * 3) * 4 + 1]).toBeGreaterThan(30);
  });

  it('snows: coverage grows with the slider and is complete at 1, flat white without a snow set', () => {
    const m = maps();
    const cover = (s: number) => mean(compositeFloor(m, null, { wetness: 0, snow: s }).diff, 0);
    expect(cover(0.3)).toBeGreaterThan(cover(0.05));
    expect(cover(0.7)).toBeGreaterThan(cover(0.3));
    const full = compositeFloor(m, null, { wetness: 0, snow: 1 });
    for (let i = 0; i < N * N; i++) expect(full.diff[i * 4]).toBeGreaterThan(220);
    // A snow set's colour is used when given.
    const blue: FloorMaps = { size: 4, diff: new Uint8ClampedArray(64).map((_, i) => (i % 4 === 2 ? 255 : i % 4 === 3 ? 255 : 100)) };
    const tinted = compositeFloor(m, blue, { wetness: 0, snow: 1 });
    expect(tinted.diff[0]).toBeLessThan(120);
  });
});

describe('floor tiling', () => {
  it('re-makes a set at twice its size that still tiles, keeping its contrast and its normals unit length', async () => {
    const { synthesizeFloor } = await import('../src/app/floor/floorSynth');
    const n = 16;
    const rnd = (i: number) => (Math.imul(i + 1, 2654435761) >>> 8) % 256;
    const fill = (f: (i: number, c: number) => number) => { const a = new Uint8ClampedArray(n * n * 4); for (let i = 0; i < n * n; i++) for (let c = 0; c < 4; c++) a[i * 4 + c] = c === 3 ? 255 : f(i, c); return a; };
    const base = { size: n, diff: fill(i => rnd(i)), nor: fill((_, c) => (c === 2 ? 255 : 128)), disp: fill(i => rnd(i + 99)) };
    const out = synthesizeFloor(base);
    expect(out.size).toBe(2 * n);
    const sd = (a: Uint8ClampedArray) => { let s = 0, q = 0; const k = a.length / 4; for (let i = 0; i < a.length; i += 4) { s += a[i]; q += a[i] * a[i]; } return Math.sqrt(q / k - (s / k) ** 2); };
    expect(sd(out.diff)).toBeGreaterThan(sd(base.diff) * 0.7);
    // Flat normals stay flat through the quarter-turns.
    for (let i = 0; i < out.nor!.length; i += 4) { expect(out.nor![i]).toBeGreaterThan(125); expect(out.nor![i]).toBeLessThan(131); }
    expect(out.disp).toBeDefined();
    // Not a plain repeat: the second half is not a copy of the first.
    let same = 0; const m = 2 * n;
    for (let y = 0; y < m; y++) for (let x = 0; x < n; x++) if (out.diff[(x + m * y) * 4] === out.diff[(x + n + m * y) * 4]) same++;
    expect(same).toBeLessThan(m * n * 0.2);
  });
});

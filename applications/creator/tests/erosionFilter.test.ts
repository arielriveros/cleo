import { describe, it, expect } from 'vitest';
import { easeOut, latticeHash2, latticeUnit2, perlinGrad2, powInv, smoothStart, windLatticeHash, windPerlinGrad } from 'cleo/core/math';
import { fnv1a } from '../src/core/generator';
import {
  applyErosionFilter, DEFAULT_EROSION_FILTER, erosionFilterPoint, phacelle, type ErosionFilterParams, type FilterInput,
} from '../src/world/erosionFilter';
import type { WorldFrame } from '../src/world/erosion';

/** A test terrain with exact gradients: a few octaves of seeded Perlin, normalised 0..1-ish. */
function terrain(res: number, scale = 3, seed = 5): FilterInput {
  const N = res * res;
  const h = new Float32Array(N), gx = new Float32Array(N), gy = new Float32Array(N);
  const o = [0, 0, 0];
  for (let r = 0; r < res; r++) for (let c = 0; c < res; c++) {
    const u = c / (res - 1), v = r / (res - 1);
    let s = 0, dx = 0, dy = 0, amp = 1, f = scale;
    for (let k = 0; k < 3; k++) {
      perlinGrad2(u * f, v * f, seed + k, o);
      s += o[0] * amp; dx += o[1] * amp * f; dy += o[2] * amp * f;
      amp *= 0.5; f *= 2;
    }
    const i = r * res + c;
    h[i] = 0.35 + s * 0.4; gx[i] = dx * 0.4; gy[i] = dy * 0.4;
  }
  return { h, gx, gy };
}

const frame = (resolution: number): WorldFrame => ({ resolution, size: 2048, heightScale: 600 });
const hash = (a: Float32Array) => fnv1a(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));

describe('seeded lattice noise (core/math)', () => {
  it('seed 0 is the wind noise, bit for bit', () => {
    for (const [x, y] of [[0, 0], [3, -7], [-120, 55]]) expect(latticeHash2(x, y, 0)).toBe(windLatticeHash(x, y));
    expect(perlinGrad2(1.3, -2.7, 0)).toEqual(windPerlinGrad(1.3, -2.7));
  });

  it('a seed changes the lattice', () => {
    expect(latticeHash2(4, 9, 1)).not.toBe(latticeHash2(4, 9, 0));
  });

  it('latticeUnit2 is in [-1, 1) on a 2^-23 grid (exact in f32)', () => {
    const o = [0, 0];
    for (let i = -20; i < 20; i++) {
      latticeUnit2(i, i * 3, 7, o);
      for (const v of o) {
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThan(1);
        expect(Math.fround(v)).toBe(v);
      }
    }
  });

  it('perlinGrad2 gradients match finite differences', () => {
    const o = [0, 0, 0], a = [0, 0, 0], b = [0, 0, 0];
    const e = 1e-5;
    for (const [x, y] of [[0.37, 0.81], [5.5, -3.2], [12.01, 7.99]]) {
      perlinGrad2(x, y, 3, o);
      const dx = (perlinGrad2(x + e, y, 3, a)[0] - perlinGrad2(x - e, y, 3, b)[0]) / (2 * e);
      const dy = (perlinGrad2(x, y + e, 3, a)[0] - perlinGrad2(x, y - e, 3, b)[0]) / (2 * e);
      expect(o[1]).toBeCloseTo(dx, 5);
      expect(o[2]).toBeCloseTo(dy, 5);
    }
  });

  it('shaping curves', () => {
    expect(easeOut(0)).toBe(0); expect(easeOut(1)).toBe(1); expect(easeOut(0.5)).toBe(0.75);
    expect(powInv(0.5, 1)).toBeCloseTo(0.5); expect(powInv(1, 3)).toBe(1); expect(powInv(0, 3)).toBe(0);
    expect(smoothStart(2, 1)).toBe(1.5); expect(smoothStart(0.5, 1)).toBe(0.125);
  });
});

describe('Phacelle noise', () => {
  it('is unit length where normalisation is full, and stripes run along the direction', () => {
    const out = new Float64Array(4);
    phacelle(3.3, 1.7, 1, 0, 1, 0.25, 1, 0, out);
    expect(Math.hypot(out[0], out[1])).toBeCloseTo(1, 6);
    // Side vector is perpendicular to the direction, scaled by freq * tau.
    expect(out[2]).toBeCloseTo(0, 12);
    expect(out[3]).toBeCloseTo(Math.PI * 2, 12);
  });
});

describe('erosion filter', () => {
  const p = DEFAULT_EROSION_FILTER;

  it('zero depth changes nothing', () => {
    const out = new Float64Array(5);
    erosionFilterPoint(100, 200, 0.3, -0.2, 0.2, 0, p.detail, p, 1, out);
    expect(out[0]).toBe(0);
    expect(out[3]).toBe(0);
  });

  it('the height change is bounded by the total octave depth', () => {
    const out = new Float64Array(5);
    let bound = 0, s = p.depth * p.spacing;
    for (let i = 0; i < p.octaves; i++) { bound += s; s *= p.gain; }
    for (let k = 0; k < 200; k++) {
      erosionFilterPoint(k * 37.1, k * 11.3, Math.sin(k) * 0.6, Math.cos(k * 1.3) * 0.6, Math.sin(k * 0.7), p.depth, p.detail, p, 3, out);
      expect(Math.abs(out[0])).toBeLessThanOrEqual(bound * (1 + 1e-9));
      expect(out[3]).toBeCloseTo(bound, 6);
      expect(out[4]).toBeGreaterThanOrEqual(-1 - 1e-9);
      expect(out[4]).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('is deterministic and seeded', async () => {
    const f = frame(65);
    const input = terrain(65);
    const a = await applyErosionFilter(input, f, p, 1);
    const b = await applyErosionFilter(input, f, p, 1);
    const c = await applyErosionFilter(input, f, p, 2);
    expect(hash(a.height)).toBe(hash(b.height));
    expect(hash(c.height)).not.toBe(hash(a.height));
    expect(a.height.every(Number.isFinite)).toBe(true);
    expect(a.ridges.every(v => v >= 0 && v <= 1)).toBe(true);
  });

  it('carves gullies into slopes and leaves flat ground almost alone', async () => {
    const f = frame(65);
    const flat: FilterInput = { h: new Float32Array(65 * 65).fill(0.35), gx: new Float32Array(65 * 65), gy: new Float32Array(65 * 65) };
    const flatOut = await applyErosionFilter(flat, f, { ...p, keepAltitude: 1 }, 1);
    const maxFlat = Math.max(...flatOut.delta.map(Math.abs));
    const sloped = await applyErosionFilter(terrain(65), f, p, 1);
    const maxSloped = Math.max(...sloped.delta.map(Math.abs));
    expect(maxFlat).toBeLessThan(1e-6);
    expect(maxSloped).toBeGreaterThan(5);
  });

  it('central differences stand in for missing gradients', async () => {
    const f = frame(129);
    const exact = terrain(129);
    const a = await applyErosionFilter(exact, f, p, 1);
    const b = await applyErosionFilter({ h: exact.h, gx: null, gy: null }, f, p, 1);
    let sum = 0;
    for (let i = 0; i < a.delta.length; i++) sum += Math.abs(a.delta[i] - b.delta[i]);
    const mean = sum / a.delta.length;
    let mag = 0;
    for (let i = 0; i < a.delta.length; i++) mag += Math.abs(a.delta[i]);
    expect(mean).toBeLessThan(0.25 * (mag / a.delta.length));
  });

  it('a strength mask of 0 switches it off locally', async () => {
    const f = frame(33);
    const input = terrain(33);
    const zero = new Float32Array(33 * 33);
    const out = await applyErosionFilter(input, f, p, 1, { strength: zero });
    expect(out.height.every((v, i) => v === input.h[i])).toBe(true);
  });

  it('is well conditioned: an f32-sized nudge of the input moves the output by a few millimetres at most', async () => {
    // Bounds what the GPU's f32 arithmetic can change against this f64 reference.
    const f = frame(65);
    const input = terrain(65);
    const nudged: FilterInput = { h: input.h.map(v => v * (1 + 2 ** -22)), gx: input.gx!.map(v => v * (1 + 2 ** -22)), gy: input.gy!.map(v => v * (1 - 2 ** -22)) };
    const a = await applyErosionFilter(input, f, p, 1);
    const b = await applyErosionFilter(nudged, f, p, 1);
    const errs = Array.from(a.delta, (v, i) => Math.abs(v - b.delta[i])).sort((x, y) => x - y);
    expect(errs[Math.floor(errs.length * 0.999)]).toBeLessThan(0.05);
  });

  it('pins the default look (golden hash)', async () => {
    const out = await applyErosionFilter(terrain(33), frame(33), p as ErosionFilterParams, 1);
    expect(hash(out.height)).toMatchInlineSnapshot(`"c387588f"`);
  });
});

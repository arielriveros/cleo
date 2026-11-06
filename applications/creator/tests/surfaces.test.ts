import { describe, expect, it } from 'vitest';
import { fnv1a } from '../src/core/generator';
import { inflateIdat } from '../src/core/png';
import type { Image } from '../src/core/texture/image';
import { encodeSurface } from '../src/surfaces/encode';
import { generateSurface } from '../src/surfaces/generate';
import { SURFACE_KINDS, surfaceKindInfo } from '../src/surfaces/kinds';

// The World Creator's generated surface materials (surfaces/): one tileable PBR set per terrain kind,
// preview only. What matters is that they tile, are deterministic, carry a full-range height for the
// stack's height blend, and are cheap enough to make on demand.

const MAPS = ['albedo', 'normal', 'orm', 'height'] as const;

/** Mean absolute RGB difference between two columns (x) or rows (y) of an image. */
function lineDiff(img: Image, a: number, b: number, axis: 'x' | 'y'): number {
  const { width: w, height: h, data } = img;
  const n = axis === 'x' ? h : w;
  let sum = 0;
  for (let k = 0; k < n; k++) {
    const ia = axis === 'x' ? (k * w + a) * 4 : (a * w + k) * 4;
    const ib = axis === 'x' ? (k * w + b) * 4 : (b * w + k) * 4;
    for (let c = 0; c < 3; c++) sum += Math.abs(data[ia + c] - data[ib + c]);
  }
  return sum / (n * 3);
}

/** The typical difference between neighbouring columns/rows inside the image. */
function typicalDiff(img: Image, axis: 'x' | 'y'): number {
  const n = axis === 'x' ? img.width : img.height;
  let sum = 0;
  for (let i = 0; i < n - 1; i++) sum += lineDiff(img, i, i + 1, axis);
  return sum / (n - 1);
}

describe('generated surface materials', () => {
  it('lists every kind once, with a colour, a tiling and a height-blend hint', () => {
    const ids = SURFACE_KINDS.map(k => k.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['grass', 'forest', 'dirt', 'mud', 'sand', 'gravel', 'pebbles', 'rock', 'cliff', 'snow']);
    for (const k of SURFACE_KINDS) {
      expect(k.color.every(c => c >= 0 && c <= 1)).toBe(true);
      expect(k.tiling).toBeGreaterThan(0);
      expect(k.heightBlend).toBeGreaterThanOrEqual(0);
      expect(k.heightBlend).toBeLessThanOrEqual(1);
    }
    expect(surfaceKindInfo('snow').label).toBe('Snow');
    expect(surfaceKindInfo('nope' as never).id).toBe('grass');
  });

  for (const kind of SURFACE_KINDS.map(k => k.id)) {
    describe(kind, () => {
      const maps = generateSurface(kind, 256, 7);

      it('is a deterministic function of the kind and the seed', () => {
        const again = generateSurface(kind, 256, 7);
        for (const m of MAPS) expect(fnv1a(again[m].data)).toBe(fnv1a(maps[m].data));
        expect(fnv1a(generateSurface(kind, 256, 8).height.data)).not.toBe(fnv1a(maps.height.data));
      });

      it('tiles: the wrap-around seam is no harder than any neighbouring pair of texels', () => {
        const last = maps.size - 1;
        for (const m of MAPS) for (const axis of ['x', 'y'] as const) {
          const seam = lineDiff(maps[m], last, 0, axis);
          const typical = typicalDiff(maps[m], axis);
          expect(seam, `${kind} ${m} ${axis}`).toBeLessThanOrEqual(typical * 1.6 + 1);
        }
      });

      it('carries a full-range height, unit normals, and an ORM with no metal', () => {
        let lo = 255, hi = 0;
        const n = maps.size * maps.size;
        for (let i = 0; i < n; i++) { const v = maps.height.data[i * 4]; if (v < lo) lo = v; if (v > hi) hi = v; }
        expect(hi - lo).toBeGreaterThanOrEqual(240);
        for (let i = 0; i < n; i++) {
          const o = i * 4;
          const x = maps.normal.data[o] / 127.5 - 1, y = maps.normal.data[o + 1] / 127.5 - 1, z = maps.normal.data[o + 2] / 127.5 - 1;
          const len = Math.hypot(x, y, z);
          if (len < 0.97 || len > 1.03 || z <= 0) throw new Error(`${kind}: normal ${i} is ${len.toFixed(3)} long, z ${z.toFixed(3)}`);
          if (maps.orm.data[o + 2] !== 0) throw new Error(`${kind}: metallic at ${i}`);
          if (maps.albedo.data[o + 3] !== 255) throw new Error(`${kind}: albedo not opaque at ${i}`);
        }
      });
    });
  }

  it('reads as its kind: the albedo mean matches the table colour', () => {
    const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    for (const k of SURFACE_KINDS) {
      const m = generateSurface(k.id, 128, 1).albedo;
      const sum = [0, 0, 0];
      for (let i = 0; i < 128 * 128; i++) for (let c = 0; c < 3; c++) sum[c] += lin(m.data[i * 4 + c]);
      sum.forEach((s, c) => expect(Math.abs(s / (128 * 128) - k.color[c]), `${k.id} channel ${c}`).toBeLessThan(0.03));
    }
  });

  it('makes every kind at 512² within a sane budget, and works from 256 to 1024', () => {
    for (const k of SURFACE_KINDS) {
      const start = performance.now();
      const m = generateSurface(k.id, 512, 3);
      expect(performance.now() - start, k.id).toBeLessThan(2000);
      expect(m.albedo.width).toBe(512);
    }
    const big = generateSurface('rock', 1024, 3);
    expect(big.height.width).toBe(1024);
    expect(big.normal.data.length).toBe(1024 * 1024 * 4);
  });

  it('encodes to four RGBA PNGs of the set size', async () => {
    const pngs = await encodeSurface('sand', 5, generateSurface('sand', 64, 5));
    expect(pngs).toMatchObject({ kind: 'sand', seed: 5, size: 64 });
    for (const m of MAPS) {
      const png = pngs[m];
      expect(Array.from(png.subarray(0, 4))).toEqual([137, 80, 78, 71]);
      const { width, height, colorType } = await inflateIdat(png);
      expect([width, height, colorType]).toEqual([64, 64, 6]);
    }
  });
});

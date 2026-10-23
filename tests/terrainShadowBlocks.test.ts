import { describe, expect, it } from 'vitest';
import { buildShadowBlock, shadowBlockSpans } from '../src/terrain/terrainShadowBlocks';

describe('shadowBlockSpans', () => {
    it('tiles the grid in blocks of chunks, row-major, with shorter edge blocks', () => {
        // 21 vertices = 20 quads; chunks of 4 quads, blocks of 2 chunks = 8 quads: 8 + 8 + 4 per axis.
        const spans = shadowBlockSpans(21, 4, 2);
        expect(spans.length).toBe(9);
        expect(spans[0]).toEqual({ c0: 0, r0: 0, c1: 8, r1: 8 });
        expect(spans[2]).toEqual({ c0: 16, r0: 0, c1: 20, r1: 8 });
        expect(spans[3]).toEqual({ c0: 0, r0: 8, c1: 8, r1: 16 });
        expect(spans[8]).toEqual({ c0: 16, r0: 16, c1: 20, r1: 20 });
    });
});

describe('buildShadowBlock', () => {
    const R = 9, element = 2, size = (R - 1) * element;
    const heights = Float32Array.from({ length: R * R }, (_, i) => (i % R) * 0.5 + Math.floor(i / R) * 0.25);

    it('samples every step, always including the far edge, at the chunks\' own local positions', () => {
        const block = buildShadowBlock(heights, R, element, size, { c0: 0, r0: 0, c1: 7, r1: 8 }, 3);
        // Columns 0, 3, 6, 7; rows 0, 3, 6, 8.
        expect(block.positions.length).toBe(4 * 4 * 3);
        const at = (i: number) => Array.from(block.positions.slice(i * 3, i * 3 + 3));
        expect(at(0)).toEqual([-size / 2, heights[0], -size / 2]);
        expect(at(3)).toEqual([-size / 2 + 7 * element, heights[7], -size / 2]);
        expect(at(15)).toEqual([-size / 2 + 7 * element, heights[8 * R + 7], -size / 2 + 8 * element]);
    });

    it('meets its neighbour on the shared edge exactly', () => {
        const a = buildShadowBlock(heights, R, element, size, { c0: 0, r0: 0, c1: 4, r1: 8 }, 2);
        const b = buildShadowBlock(heights, R, element, size, { c0: 4, r0: 0, c1: 8, r1: 8 }, 2);
        const colsA = 3, colsB = 3;
        for (let row = 0; row < 5; row++) {
            const ea = Array.from(a.positions.slice((row * colsA + colsA - 1) * 3, (row * colsA + colsA) * 3));
            const eb = Array.from(b.positions.slice(row * colsB * 3, (row * colsB + 1) * 3));
            expect(ea).toEqual(eb);
        }
    });

    it('winds every triangle up-facing, as the chunks do, so front-face culling treats both alike', () => {
        const block = buildShadowBlock(new Float32Array(R * R), R, element, size, { c0: 0, r0: 0, c1: 8, r1: 8 }, 4);
        const p = block.positions, idx = block.indices;
        expect(idx.length).toBe(2 * 2 * 6);
        for (let t = 0; t < idx.length; t += 3) {
            const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]].map(i => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]);
            const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            const ny = u[2] * v[0] - u[0] * v[2];
            expect(ny).toBeGreaterThan(0);
        }
    });

    it('reports its local bounds', () => {
        const block = buildShadowBlock(heights, R, element, size, { c0: 2, r0: 2, c1: 6, r1: 6 }, 2);
        expect(block.min).toEqual([-size / 2 + 4, heights[2 * R + 2], -size / 2 + 4]);
        expect(block.max).toEqual([-size / 2 + 12, heights[6 * R + 6], -size / 2 + 12]);
    });
});

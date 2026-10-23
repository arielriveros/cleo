import { describe, it, expect } from 'vitest';
import {
    frameBasis, frameBlend, frameDirection, frameUv, hemiOctDecode, hemiOctEncode, parseOctahedralInfo,
} from '../src/terrain/octahedralImpostor';
import type { V3 } from '../src/terrain/octahedralImpostor';

// The octahedral impostor's conventions are shared by the baker (editor) and the shader
// (chunks/octahedralImpostor.wgsl). A disagreement between the two does not error — it draws the wrong
// side of the tree — so the conventions are pinned here.

const norm = (v: V3): V3 => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; };
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe('hemi-octahedral mapping', () => {
    it('round-trips every upper-hemisphere direction', () => {
        for (let k = 0; k < 500; k++) {
            const a = (k * 2.399963) % (Math.PI * 2), e = Math.acos(1 - (k + 0.5) / 500);
            const d = norm([Math.sin(e) * Math.cos(a), Math.cos(e), Math.sin(e) * Math.sin(a)]);
            const [u, v] = hemiOctEncode(d);
            expect(u).toBeGreaterThanOrEqual(0); expect(u).toBeLessThanOrEqual(1);
            expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1);
            expect(dot(hemiOctDecode(u, v), d)).toBeGreaterThan(0.99999);
        }
    });

    it('puts the zenith at the centre of the grid', () => {
        expect(hemiOctEncode([0, 1, 0])).toEqual([0.5, 0.5]);
        expect(frameDirection(1, 1, 3)[1]).toBeCloseTo(1, 6);
    });
});

describe('frame blending', () => {
    it('weights sum to one, and a frame direction picks that frame alone', () => {
        const N = 8;
        for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
            const d = frameDirection(i, j, N);
            const { cells, weights } = frameBlend(d, N);
            expect(weights[0] + weights[1] + weights[2]).toBeCloseTo(1, 9);
            const best = weights.indexOf(Math.max(...weights));
            expect(weights[best]).toBeGreaterThan(0.999);
            expect(cells[best]).toEqual([i, j]);
        }
    });

    it('blends only neighbouring frames', () => {
        const { cells } = frameBlend(norm([0.3, 0.5, -0.8]), 8);
        for (const [x, y] of cells) for (const [x2, y2] of cells) {
            expect(Math.abs(x - x2)).toBeLessThanOrEqual(1);
            expect(Math.abs(y - y2)).toBeLessThanOrEqual(1);
        }
    });
});

describe('frame basis and projection', () => {
    it('is orthonormal and right-handed for every frame, the zenith included', () => {
        for (const d of [[0, 1, 0], [1, 0, 0], [0, 0, -1], norm([0.2, 0.9, 0.1])] as V3[]) {
            const { t, b } = frameBasis(d);
            expect(dot(t, t)).toBeCloseTo(1, 9); expect(dot(b, b)).toBeCloseTo(1, 9);
            expect(dot(t, b)).toBeCloseTo(0, 9); expect(dot(t, d)).toBeCloseTo(0, 9); expect(dot(b, d)).toBeCloseTo(0, 9);
            // t x b = d
            const c: V3 = [t[1] * b[2] - t[2] * b[1], t[2] * b[0] - t[0] * b[2], t[0] * b[1] - t[1] * b[0]];
            expect(dot(c, d)).toBeCloseTo(1, 9);
        }
    });

    it('keeps world up pointing up in a level frame', () => {
        expect(frameBasis([0, 0, 1]).b[1]).toBeCloseTo(1, 9);
    });

    it('maps the centre to the middle of the frame and the sphere edge to its border', () => {
        const c: V3 = [1, 2, 3], d: V3 = [0, 0, 1];
        expect(frameUv(c, c, 2, d)).toEqual([0.5, 0.5]);
        const { t, b } = frameBasis(d);
        const [u] = frameUv([c[0] + t[0] * 2, c[1] + t[1] * 2, c[2] + t[2] * 2], c, 2, d);
        const [, v] = frameUv([c[0] + b[0] * 2, c[1] + b[1] * 2, c[2] + b[2] * 2], c, 2, d);
        expect(u).toBeCloseTo(1, 9);
        expect(v).toBeCloseTo(1, 9);
    });
});

describe('parseOctahedralInfo', () => {
    it('reads a valid description and refuses broken ones', () => {
        expect(parseOctahedralInfo({ frames: 8, radius: 5, center: [0, 4, 0] })).toEqual({ frames: 8, radius: 5, center: [0, 4, 0] });
        expect(parseOctahedralInfo({ frames: 1, radius: 5, center: [0, 0, 0] })).toBeNull();
        expect(parseOctahedralInfo({ frames: 8, radius: 0, center: [0, 0, 0] })).toBeNull();
        expect(parseOctahedralInfo({ frames: 8, radius: 1, center: [0, 'x', 0] })).toBeNull();
        expect(parseOctahedralInfo(null)).toBeNull();
    });
});

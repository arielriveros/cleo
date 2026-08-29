import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The height-blended marched surface, and the identity that lets it ship without changing anything.
 *
 * Terrain used to intersect a LINEAR weighted average of its four layers, `1 - dot(h, wN)`. It now
 * intersects a height blend — `w_k * exp(heightBlend_k * h_k)`, renormalised — so where two layers
 * overlap the one standing higher takes the fragment rather than the two averaging into mud. Drobot
 * measured POM at half the cost under this operator, because the blended surface sits higher and the ray
 * terminates sooner, and argues it is simply what surfaces do ("in real life surfaces don't blend").
 *
 * The reason it is safe to land on existing content is an exact identity, not a tolerance: at
 * `heightBlend = 0`, `exp(0) = 1` leaves the weights untouched, and `wN` already sums to 1, so the
 * renormalise divides by exactly one. The new expression reduces to the old one bit for bit. Every
 * shipped terrain has `heightBlend` stored as 0 unless someone raised it, so nothing moves.
 *
 * That identity is the whole promise, so it is what this file tests. It would be very easy to write the
 * blend in a form that is *approximately* the old one — a `+ 1e-5` in the wrong place, a normalise that
 * divides by `dot(wN,1)` instead of `dot(hb,1)` — and the difference would be invisible in a screenshot
 * while silently altering every terrain in every existing project.
 */

const CHUNKS = join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl', 'chunks');
const src = () => readFileSync(join(CHUNKS, 'terrainLayers.wgsl'), 'utf-8').replace(/\/\/[^\n]*/g, '');

/** `blendedSurface` from the shader, in JS. */
const blendedSurface = (h: number[], wN: number[], hb: number[]): number => {
    const w = wN.map((wk, k) => wk * Math.exp(hb[k] * h[k]));
    const num = h.reduce((a, hk, k) => a + hk * w[k], 0);
    const den = Math.max(w.reduce((a, wk) => a + wk, 0), 1e-5);
    return 1 - num / den;
};

/** What the march intersected before: a plain linear weighted average. */
const linearSurface = (h: number[], wN: number[]): number =>
    1 - h.reduce((a, hk, k) => a + hk * wN[k], 0);

const CASES: [string, number[], number[]][] = [
    ['two layers, even', [0.3, 0.8, 0, 0], [0.5, 0.5, 0, 0]],
    ['two layers, uneven', [0.62, 0.14, 0, 0], [0.85, 0.15, 0, 0]],
    ['four layers', [0.1, 0.45, 0.72, 0.93], [0.25, 0.25, 0.25, 0.25]],
    ['one dominant', [0.5, 0.5, 0.5, 0.5], [0.97, 0.01, 0.01, 0.01]],
    ['a flat field', [0.5, 0.5, 0, 0], [0.5, 0.5, 0, 0]],
];

describe('at heightBlend 0 the marched surface is EXACTLY what it always was', () => {
    it.each(CASES)('%s', (_name, h, wN) => {
        expect(blendedSurface(h, wN, [0, 0, 0, 0])).toBe(linearSurface(h, wN));
    });

    it('holds for randomised normalised weight sets', () => {
        let seed = 12345;
        const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
        for (let i = 0; i < 200; i++) {
            const h = [rnd(), rnd(), rnd(), rnd()];
            const raw = [rnd(), rnd(), rnd(), rnd()];
            const sum = raw.reduce((a, b) => a + b, 0);
            const wN = raw.map(v => v / sum);
            expect(blendedSurface(h, wN, [0, 0, 0, 0])).toBeCloseTo(linearSurface(h, wN), 15);
        }
    });
});

describe('above zero it does what the operator is for', () => {
    it('raises the surface toward the taller layer', () => {
        // The whole point: the blended surface sits HIGHER, so the ray terminates sooner and the tall
        // layer wins the boundary. Surface is stored as depth-below-the-top, so higher means smaller.
        const h = [0.2, 0.9, 0, 0], wN = [0.5, 0.5, 0, 0];
        expect(blendedSurface(h, wN, [4, 4, 0, 0])).toBeLessThan(linearSurface(h, wN));
    });

    it('is monotone in the blend strength', () => {
        const h = [0.2, 0.9, 0, 0], wN = [0.5, 0.5, 0, 0];
        const at = (k: number) => blendedSurface(h, wN, [k, k, 0, 0]);
        expect(at(2)).toBeLessThan(at(0));
        expect(at(6)).toBeLessThan(at(2));
    });

    it('never leaves [0,1] — a surface outside it would break the ray parameterisation', () => {
        for (const [, h, wN] of CASES)
            for (const k of [0, 1, 4, 8]) {
                const s = blendedSurface(h, wN, [k, k, k, k]);
                expect(s).toBeGreaterThanOrEqual(0);
                expect(s).toBeLessThanOrEqual(1);
            }
    });

    it('a uniform field is unmoved by any blend strength', () => {
        // Every layer the same height: reweighting cannot change the answer, at any sharpness.
        for (const k of [0, 3, 9])
            expect(blendedSurface([0.4, 0.4, 0.4, 0.4], [0.25, 0.25, 0.25, 0.25], [k, k, k, k]))
                .toBeCloseTo(0.6, 15);
    });
});

describe('the shader matches this arithmetic', () => {
    it('normalises by the BLENDED weights, not the splat weights', () => {
        // Dividing by dot(wN, 1) — which is 1 — would skip the renormalise entirely and let the surface
        // drift outside [0,1] as soon as heightBlend went above 0.
        const body = src().match(/fn\s+blendedSurface[^{]*\{([\s\S]*?)\n\}/);
        expect(body, 'blendedSurface not found').not.toBeNull();
        expect(body![1]).toMatch(/dot\(hb,\s*vec4<f32>\(1\.0\)\)/);
        expect(body![1], 'weights are the splat times exp(heightBlend * h)').toMatch(/wN\s*\*\s*exp\(/);
    });

    it('the march and the self-shadow intersect the SAME surface', () => {
        // A self-shadow marching a different field than the view ray shadows a surface that is not the
        // one on screen. Both must go through blendedSurface.
        const s = src();
        for (const name of ['marchTerrain', 'terrainSelfShadow']) {
            const body = s.match(new RegExp('fn\\s+' + name + '[^{]*\\{([\\s\\S]*?)\\n\\}'));
            expect(body, `${name} not found`).not.toBeNull();
            expect(body![1], `${name} must use blendedSurface`).toMatch(/blendedSurface\(/);
        }
    });
});

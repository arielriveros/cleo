import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Geometric specular antialiasing, ported to JS so its SHAPE can be asserted without a GPU.
 *
 * A deliberate port of `filterSpecularRoughness` from
 * `src/graphics/shaders/wgsl/chunks/modelVarying.wgsl`. It is here because the one thing that is easy
 * to get wrong in this filter is also invisible in review: WHICH SPACE the kernel is added in.
 *
 * Filament's formulation adds the variance kernel to `alpha * alpha`, where `alpha` is
 * `perceptualRoughness ^ 2`. So the sum lives in `pr^4`, and the fourth root at the end takes it
 * straight back to perceptual. Add the same kernel to `pr` or to `alpha` instead and nothing throws,
 * nothing looks obviously broken in a still frame, and every matte surface in the scene quietly gets
 * blurrier than it should while every mirror gets barely touched — which is the exact opposite of what
 * the filter is for. The tests below pin the asymmetry that distinguishes the right space from the
 * wrong ones.
 */

const VARIANCE = 0.15;
const THRESHOLD = 0.25;

/** `filterSpecularRoughness`, in JS. `dN2` is `dot(du,du) + dot(dv,dv)`. */
function filterRoughness(perceptualRoughness: number, dN2: number): number {
    const kernel = Math.min(2 * VARIANCE * dN2, THRESHOLD);
    const alpha = perceptualRoughness * perceptualRoughness;
    return Math.sqrt(Math.sqrt(Math.min(Math.max(alpha * alpha + kernel, 0), 1)));
}

describe('specular antialiasing filter', () => {
    it('is the identity on a flat surface', () => {
        // No normal variance, no widening. Exactly, not approximately: `sqrt(sqrt(pr^4))` is `pr`.
        for (const pr of [0.045, 0.2, 0.5, 0.9, 1.0])
            expect(filterRoughness(pr, 0)).toBeCloseTo(pr, 12);
    });

    it('never sharpens', () => {
        for (const pr of [0.045, 0.25, 0.5, 0.9])
            for (const dN2 of [0, 1e-4, 1e-2, 0.5, 10])
                expect(filterRoughness(pr, dN2)).toBeGreaterThanOrEqual(pr - 1e-12);
    });

    it('acts on mirrors and leaves matte surfaces alone', () => {
        // THE POINT OF THE WHOLE FILTER, and the assertion that catches the wrong space. One kernel,
        // two surfaces: a smooth sphere's own curvature. The mirror is transformed out of recognition
        // and the matte surface barely moves, because what the kernel is compared against is `pr^4` —
        // 4.1e-6 at the roughness floor and 0.65 at 0.9.
        const dN2 = 1.4e-3;                        // a sphere ~60 px across
        const mirror = filterRoughness(0.045, dN2);
        const matte = filterRoughness(0.9, dN2);
        expect(mirror / 0.045).toBeGreaterThan(2.5);
        expect(matte / 0.9).toBeLessThan(1.001);
    });

    it('clamps the widening so a silhouette does not turn into a rim', () => {
        // At a silhouette the normal turns through most of a hemisphere inside one pixel and `dN2`
        // runs away. Without the threshold every object would be outlined in maximum roughness.
        // With it, the kernel stops at 0.25 and even a mirror lands at 0.707, not 1.0.
        expect(filterRoughness(0.045, 1e6)).toBeCloseTo(Math.sqrt(Math.sqrt(0.045 ** 4 + THRESHOLD)), 12);
        expect(filterRoughness(0.045, 1e6)).toBeLessThan(0.75);
    });

    it('is monotonic in the variance', () => {
        let prev = -1;
        for (const dN2 of [0, 1e-5, 1e-3, 1e-2, 0.1, 1, 100]) {
            const r = filterRoughness(0.3, dN2);
            expect(r).toBeGreaterThanOrEqual(prev);
            prev = r;
        }
    });
});

describe('the shader it was ported from', () => {
    const CHUNK = readFileSync(
        join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl', 'chunks', 'modelVarying.wgsl'), 'utf-8');

    it('adds the kernel to alpha squared, not to alpha or to the perceptual roughness', () => {
        expect(CHUNK).toContain('let alpha = perceptualRoughness * perceptualRoughness;');
        expect(CHUNK).toContain('clamp(alpha * alpha + kernel, 0.0, 1.0)');
        expect(CHUNK).toContain('sqrt(sqrt(');
    });

    it("keeps Filament's two constants", () => {
        expect(CHUNK).toContain('SPECULAR_AA_VARIANCE: f32 = 0.15');
        expect(CHUNK).toContain('SPECULAR_AA_THRESHOLD: f32 = 0.25');
    });

    it('takes its derivatives unconditionally', () => {
        // The toggle is a `select` on the RESULT, not a branch around the derivative. A derivative
        // under a branch carries the uniform-control-flow rule, and while a uniform-buffer condition
        // satisfies it, relying on that puts the module one refactor away from being rejected.
        const fn = CHUNK.slice(CHUNK.indexOf('fn filterSpecularRoughness'));
        const body = fn.slice(0, fn.indexOf('\n}'));
        expect(body.indexOf('dpdx(N)')).toBeLessThan(body.indexOf('select('));
        expect(body).not.toMatch(/if \([^)]*\) \{[^}]*dpd/);
    });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The parallax tangent frame's SIGN is measured, not assumed.
 *
 * `parallaxFrame` is Schuler's cotangent frame. Work its four lines through and they come out as
 *
 *     t = det * dP/du      b = det * dP/dv      det = dpdx(u)*dpdy(v) - dpdy(u)*dpdx(v)
 *
 * `det` is the Jacobian of uv with respect to SCREEN space, and its sign depends on which way the
 * framebuffer's y runs — a fact about the backend, not about the surface. The normaliser is an
 * `inverseSqrt`, strictly positive, so it fixes the length and can do nothing about that factor.
 *
 * A frame negated this way is still a perfectly valid right-handed orthonormal basis —
 * `(-T) x (-B) = T x B = n` — so nothing structural is wrong with it and nothing downstream can catch
 * it. What it would do is march the ray toward the camera instead of away from it, inverting how the
 * relief slides as the camera moves. This engine measures `det` positive today, so the correction is a
 * no-op; it exists so a y-convention change cannot silently invert every parallax surface.
 */

const CHUNKS = join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl', 'chunks');
const src = () => readFileSync(join(CHUNKS, 'parallax.wgsl'), 'utf-8').replace(/\/\/[^\n]*/g, '');

/** The shader's frame, in JS, for an axis-aligned chart with the given screen-space uv derivatives. */
const frame = (du1: [number, number], du2: [number, number], dp1: number[], dp2: number[]) => {
    const n = [0, 0, 1];
    const cross = (a: number[], b: number[]) =>
        [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const scale = (v: number[], k: number) => v.map(c => c * k);
    const add = (a: number[], b: number[]) => a.map((c, i) => c + b[i]);
    const dp2perp = cross(dp2, n), dp1perp = cross(n, dp1);
    const t = add(scale(dp2perp, du1[0]), scale(dp1perp, du2[0]));
    const b = add(scale(dp2perp, du1[1]), scale(dp1perp, du2[1]));
    const det = du1[0] * du2[1] - du2[0] * du1[1];
    const orient = det >= 0 ? 1 : -1;
    const inv = (1 / Math.sqrt(Math.max(t[0] ** 2 + t[1] ** 2 + t[2] ** 2,
                                        b[0] ** 2 + b[1] ** 2 + b[2] ** 2, 1e-12))) * orient;
    return { t: scale(t, inv), b: scale(b, inv), det };
};

describe('the frame recovers +dP/du whichever way screen y runs', () => {
    // A plane in world XY with u -> +X and v -> +Y, so the true dP/du is +X and dP/dv is +Y.
    it('y-UP screen (the convention the formula was published under)', () => {
        const f = frame([1, 0], [0, 1], [1, 0, 0], [0, 1, 0]);
        expect(f.det).toBeGreaterThan(0);
        expect(f.t[0]).toBeCloseTo(1, 12);   // +dP/du
        expect(f.b[1]).toBeCloseTo(1, 12);   // +dP/dv
    });

    it('y-DOWN screen — the case that would have inverted every parallax surface', () => {
        // Flipping the framebuffer's y negates both dpdy(fragPos) and dpdy(uv), hence det.
        const f = frame([1, 0], [0, -1], [1, 0, 0], [0, -1, 0]);
        expect(f.det).toBeLessThan(0);
        expect(f.t[0], 'must still be +dP/du after the sign correction').toBeCloseTo(1, 12);
        expect(f.b[1]).toBeCloseTo(1, 12);
    });

    it('without the correction the y-down frame is negated — the bug this guards', () => {
        // Same inputs, orientation deliberately not applied: both columns come out reversed.
        const dp2perp = [-1, 0, 0], dp1perp = [0, 1, 0];   // cross([0,-1,0],[0,0,1]), cross([0,0,1],[1,0,0])
        const t = [dp2perp[0] * 1 + dp1perp[0] * 0, dp2perp[1] * 1 + dp1perp[1] * 0, 0];
        expect(t[0]).toBeCloseTo(-1, 12);
    });
});

describe('parallaxFrame applies it', () => {
    it('computes a determinant from the uv derivatives and uses its sign', () => {
        const fn = src().match(/fn\s+parallaxFrame[^{]*\{([\s\S]*?)\n\}/);
        expect(fn, 'parallaxFrame not found').not.toBeNull();
        const body = fn![1];
        expect(body, 'the Jacobian determinant of uv wrt screen space')
            .toMatch(/du1\.x\s*\*\s*du2\.y\s*-\s*du2\.x\s*\*\s*du1\.y/);
        expect(body, 'its sign must reach the returned basis').toMatch(/select\(\s*-1\.0\s*,\s*1\.0/);
    });

    it('the sign multiplies the normaliser, which is otherwise unsigned', () => {
        const fn = src().match(/fn\s+parallaxFrame[^{]*\{([\s\S]*?)\n\}/);
        expect(fn![1]).toMatch(/inverseSqrt\([\s\S]*?\)\s*\*\s*orient/);
    });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The parallax march's secant refinement, guarded where nothing else could see it.
 *
 * This exists because of a bug that every gate in the repo passed. The refinement read
 *
 *     let w = clamp(after / max(after - before, 1e-5), 0.0, 1.0);
 *
 * and `after - before` is STRICTLY NEGATIVE on every exit path — the loop leaves once `ray >= surf`
 * (so `after <= 0`) and only continued while `ray < surf` (so `before > 0`). `max()` therefore
 * replaced the real denominator with `+1e-5`, `w` clamped to 0, and `mix(cur, prev, 0)` returned the
 * raw step. The refinement was dead code for every fragment, the hit was quantised to the march grid
 * and biased half a step too deep, and the surface crawled as the camera moved.
 *
 * `harness:mesh`, `harness:pass` and `harness:backenddiff` were all green throughout, and that is the
 * point worth remembering: a recorded baseline can only detect drift FROM the recording. It cannot
 * tell you the recording was already wrong. Only an invariant that does not depend on a stored image
 * can, which is what these are.
 */

const CHUNKS = join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl', 'chunks');
const read = (f: string) => readFileSync(join(CHUNKS, f), 'utf-8');

/** The two marches are twins; a fix applied to one and not the other is the likeliest regression. */
const MARCHES: [string, string][] = [
    ['parallax.wgsl', 'parallaxOcclusion'],
    ['terrainLayers.wgsl', 'marchTerrain'],
];

/** Strip line comments so prose about `max(...)` cannot satisfy or break a source assertion. */
const code = (src: string) => src.replace(/\/\/[^\n]*/g, '');

describe('the secant refinement is guarded on the side its denominator is actually on', () => {
    for (const [file, fn] of MARCHES) {
        it(`${file} (${fn}) divides by a negative-guarded denominator`, () => {
            const src = code(read(file));

            // The refinement line, whatever the local variable is called (`w` here, `t` there).
            const refine = src.match(/clamp\(\s*after\s*\/\s*(.+?),\s*0\.0,\s*1\.0\s*\)/s);
            expect(refine, `no secant refinement found in ${file}`).not.toBeNull();

            const denominator = refine![1];
            expect(
                denominator,
                `${file}: the denominator is (after - before), which is STRICTLY NEGATIVE whenever the ` +
                `march crossed the surface. Flooring it with max(..., +eps) does not guard a divide by ` +
                `zero — it replaces the value, pins the weight to 0 and disables the refinement ` +
                `entirely. Guard with min(..., -eps).`,
            ).toMatch(/min\(/);
            expect(denominator, `${file}: guard must clamp toward negative`).toMatch(/-\s*1e-/);
            expect(denominator, `${file}: max() on this denominator is the bug this test exists for`)
                .not.toMatch(/max\(/);
        });
    }

    it('both marches use the identical refinement, so a fix cannot land in only one', () => {
        const of = (file: string) =>
            code(read(file)).match(/clamp\(\s*after\s*\/\s*(.+?),\s*0\.0,\s*1\.0\s*\)/s)![1].replace(/\s+/g, '');
        expect(of('parallax.wgsl')).toBe(of('terrainLayers.wgsl'));
    });
});

describe('nothing in the march quantises on a camera-relative threshold', () => {
    /**
     * `vTan.z` is `h / sqrt(d^2 + h^2)` on flat ground, so ANY threshold on it is a ring centred under
     * the camera and rigidly attached to it. A `floor()` there is a value discontinuity — 23 of them,
     * one of which (`mix(32, 8, 0.5) == 20` exactly) landed on the same cosine where the ray ratio was
     * clamped, stacking a step on a crease at d = sqrt(3)*h. That was the visible seam.
     */
    it('parallaxSteps returns a continuous (unfloored) count', () => {
        const src = code(read('parallax.wgsl'));
        const fn = src.match(/fn\s+parallaxSteps[^{]*\{([^}]*)\}/);
        expect(fn, 'parallaxSteps not found').not.toBeNull();
        expect(
            fn![1],
            'parallaxSteps must stay fractional: floor() makes the sampling grid 1/steps jump at every ' +
            'integer crossing, and each crossing is a ring at a fixed distance in front of the camera.',
        ).not.toMatch(/floor\(/);
    });

    it('parallaxRay saturates smoothly instead of clamping the ratio with min()', () => {
        const src = code(read('parallax.wgsl'));
        const fn = src.match(/fn\s+parallaxRay[^{]*\{([\s\S]*?)\n\}/);
        expect(fn, 'parallaxRay not found').not.toBeNull();
        expect(
            fn![1],
            'min(1/vTan.z, POM_MAX_RATIO) creases where the branches meet (vTan.z = 0.5, i.e. ' +
            'd = sqrt(3) * camera height) — a slope discontinuity at a fixed distance ahead of the ' +
            'viewer. Saturate smoothly instead.',
        ).not.toMatch(/min\(/);
    });
});

describe('the secant step itself', () => {
    /**
     * The arithmetic the shader performs, in isolation. `after <= 0` (the sample that overshot) and
     * `before > 0` (the one before it); the weight is the fraction of the way BACK toward `prev`.
     */
    const weight = (after: number, before: number) => {
        const denom = Math.min(after - before, -1e-8);
        return Math.min(Math.max(after / denom, 0), 1);
    };

    it('lands strictly between the bracketing samples', () => {
        const w = weight(-0.25, 0.75);
        expect(w).toBeGreaterThan(0);
        expect(w).toBeLessThan(1);
    });

    it('recovers the exact crossing of a linear field', () => {
        // A surface crossed 30% of the way back from the overshooting sample toward the previous one.
        expect(weight(-0.3, 0.7)).toBeCloseTo(0.3, 12);
        expect(weight(-0.9, 0.1)).toBeCloseTo(0.9, 12);
    });

    it('keeps the overshooting sample when the crossing is exactly on it', () => {
        expect(weight(0, 1)).toBe(0);
    });

    it('is never zero for a genuine bracket — the shape of the original bug', () => {
        // Every one of these produced 0 under `max(after - before, 1e-5)`.
        for (const [after, before] of [[-0.1, 0.9], [-0.5, 0.5], [-0.01, 0.99], [-0.99, 0.01]]) {
            expect(weight(after, before), `bracket ${after}/${before} collapsed to the raw step`)
                .toBeGreaterThan(0);
        }
    });

    it('degenerates safely when there is no bracket at all', () => {
        expect(Number.isFinite(weight(0, 0))).toBe(true);
    });
});

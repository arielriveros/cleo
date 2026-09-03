import { describe, it, expect } from 'vitest';

/**
 * The cel band quantizer, in JS, so its shape can be asserted without a GPU.
 *
 * A deliberate port of `celQuantize` from `src/graphics/shaders/wgsl/chunks/celForward.wgsl`. It exists
 * for one reason: the DENOMINATOR is the easiest thing here to get wrong, and getting it wrong is
 * invisible both in code review and on screen.
 *
 * Dividing by the band count is what everyone writes first. It produces bands at 0, 1/3, 2/3 for a band
 * count of three — so a surface facing the light dead-on returns 0.667 of its diffuse colour, every cel
 * material reads as darker than the same albedo under Blinn-Phong or PBR, and nothing in the inspector
 * explains why. Dividing by the GAPS between the bands (`n - 1`) puts the last band at exactly 1.
 *
 * The result still looks like plausible cel shading either way, which is exactly why it needs a test
 * rather than an eye.
 *
 * The port was checked against the real thing rather than assumed to match it: the `celQuantize` naga
 * emits into the GLSL fragment shader was compiled and run on a GPU (ANGLE/D3D11) over a 256-sample
 * sweep of t, at eight combinations of `bands` and `bandSoftness`, and the largest disagreement with the
 * function below was 0.0021 — half of one 8-bit readback step. So a failure here is a failure of the
 * shader's arithmetic, not of the transcription.
 */

function smoothstep(e0: number, e1: number, x: number): number {
    const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
    return t * t * (3 - 2 * t);
}

/** Port of `celQuantize`. `bands` and `bandSoftness` are the material's two toon uniforms. */
function celQuantize(t: number, bands: number, bandSoftness: number): number {
    const n = Math.max(bands, 1);
    if (n <= 1) return 1;
    const x = Math.min(Math.max(t, 0), 1) * n;
    const index = Math.min(Math.floor(x), n - 1);
    const frac = x - Math.floor(x);
    const w = Math.max(Math.min(Math.max(bandSoftness, 0), 1) * 0.5, 1e-4);
    return Math.min(Math.max((index + smoothstep(1 - w, 1, frac)) / (n - 1), 0), 1);
}

/** The distinct output levels over a dense sweep, which is what the eye actually counts. */
function levels(bands: number, softness = 0): number[] {
    const seen = new Set<number>();
    for (let i = 0; i <= 2000; i++) seen.add(Number(celQuantize(i / 2000, bands, softness).toFixed(6)));
    return [...seen].sort((a, b) => a - b);
}

describe('the bands span the full 0..1 range', () => {
    it('three bands are 0, 0.5 and 1 — not 0, 1/3 and 2/3', () => {
        // The regression this file exists for. `/ n` instead of `/ (n - 1)` gives the second list, and
        // the top band never reaching 1 is what makes a cel material look dimmer than every other one.
        expect(levels(3)).toEqual([0, 0.5, 1]);
    });

    it('a surface facing the light returns full brightness at any band count', () => {
        for (const n of [2, 3, 4, 5, 8]) expect(celQuantize(1, n, 0), `bands=${n}`).toBe(1);
    });

    it('a surface facing away returns zero at any band count', () => {
        for (const n of [2, 3, 4, 5, 8]) expect(celQuantize(0, n, 0), `bands=${n}`).toBe(0);
    });

    it('produces exactly as many levels as bands', () => {
        for (const n of [2, 3, 4, 5, 8]) expect(levels(n).length, `bands=${n}`).toBe(n);
    });

    it('spaces them evenly', () => {
        for (const n of [2, 3, 4, 5, 8]) {
            const got = levels(n);
            for (let k = 0; k < n; k++) expect(got[k], `bands=${n} step=${k}`).toBeCloseTo(k / (n - 1), 5);
        }
    });
});

describe('the degenerate and boundary cases', () => {
    it('one band is fully lit, not black', () => {
        // A single step has no variation to show. Returning 0 would render the whole object unlit, which
        // reads as a broken shader; and `n - 1` is a division by zero that has to be handled before it.
        for (const t of [0, 0.5, 1]) expect(celQuantize(t, 1, 0)).toBe(1);
    });

    it('treats a zero or negative band count as one band', () => {
        // `bands` reaches the shader as an i32 from a uniform block that zero-initialises, so 0 is what
        // an unseeded material sends. It must not divide by -1 or return NaN.
        for (const n of [0, -3]) {
            expect(celQuantize(0.5, n, 0), `bands=${n}`).toBe(1);
            expect(Number.isFinite(celQuantize(0.5, n, 0))).toBe(true);
        }
    });

    it('never leaves 0..1, including at t = 1 where floor spills past the last band', () => {
        // `floor(1.0 * n)` is n, not n - 1: without the min() the top band index would be one past the
        // end and the result would exceed 1, blowing out to a white rim on every surface facing a light.
        for (const n of [1, 2, 3, 8])
            for (const t of [-0.5, 0, 0.5, 0.999999, 1, 1.5]) {
                const v = celQuantize(t, n, 0.3);
                expect(v, `bands=${n} t=${t}`).toBeGreaterThanOrEqual(0);
                expect(v, `bands=${n} t=${t}`).toBeLessThanOrEqual(1);
            }
    });

    it('is monotonic — more light never gets darker', () => {
        for (const n of [2, 3, 5, 8]) {
            let prev = -1;
            for (let i = 0; i <= 1000; i++) {
                const v = celQuantize(i / 1000, n, 0.25);
                expect(v, `bands=${n} at ${i}`).toBeGreaterThanOrEqual(prev);
                prev = v;
            }
        }
    });
});

describe('bandSoftness widens the edge without merging bands', () => {
    it('zero softness still steps, rather than dividing by zero', () => {
        // The 1e-4 floor: smoothstep with edge0 == edge1 is indeterminate, and 0 is the value the
        // inspector's slider reaches at its left stop.
        expect(levels(3, 0)).toEqual([0, 0.5, 1]);
    });

    it('keeps every band reachable at full softness', () => {
        // The width is capped at HALF a band precisely so the transition can never swallow the flat part
        // of the next one. At softness 1 the plateaus are at their narrowest and must still exist.
        const got = levels(3, 1);
        expect(got[0]).toBe(0);
        expect(got[got.length - 1]).toBe(1);
        for (const target of [0, 0.5, 1])
            expect(got.some(v => Math.abs(v - target) < 1e-6), `plateau ${target}`).toBe(true);
    });

    it('widens the transition as softness rises', () => {
        // The count of intermediate samples between plateaus is a direct proxy for edge width.
        const between = (s: number) => levels(3, s).filter(v => v > 1e-6 && v < 0.5 - 1e-6).length;
        expect(between(0.4)).toBeGreaterThan(between(0.1));
        expect(between(0.1)).toBeGreaterThan(between(0.0));
    });
});

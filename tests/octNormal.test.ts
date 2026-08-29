import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Octahedral normal encoding, ported to JS so the round trip can be checked without a GPU.
 *
 * A deliberate port of `octEncode` / `octDecode` from
 * `src/graphics/shaders/wgsl/chunks/octNormal.wgsl`. It is here because the tail fold is the one place
 * this mapping goes wrong, and it goes wrong QUIETLY: get the sign or the swizzle of `octWrap` wrong
 * and the encoding is still perfectly reversible over the +Z hemisphere, which is most of what a camera
 * sees. Only surfaces facing away from +Z come back mirrored, and a mirrored normal on a back-facing
 * part of a scene reads as "that corner is lit oddly", not as a bug.
 *
 * The GLSL copy in `systems/customShaders.ts` must agree with the WGSL one, or a custom deferred
 * material is lit as though it faced somewhere else. That is asserted here too, by text.
 */

function octWrap(x: number, y: number): [number, number] {
    return [(1 - Math.abs(y)) * (x >= 0 ? 1 : -1), (1 - Math.abs(x)) * (y >= 0 ? 1 : -1)];
}

function octEncode(n: [number, number, number]): [number, number] {
    const l1 = Math.max(Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2]), 1e-6);
    const p: [number, number] = [n[0] / l1, n[1] / l1];
    return n[2] >= 0 ? p : octWrap(p[0], p[1]);
}

function octDecode(e: [number, number]): [number, number, number] {
    let x = e[0], y = e[1];
    const z = 1 - Math.abs(x) - Math.abs(y);
    if (z < 0) { const w = octWrap(x, y); x = w[0]; y = w[1]; }
    const len = Math.hypot(x, y, z) || 1;
    return [x / len, y / len, z / len];
}

const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A deterministic spread over the sphere — a Fibonacci lattice, so no axis or octant is favoured. */
function sphereDirections(count: number): [number, number, number][] {
    const out: [number, number, number][] = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < count; i++) {
        const z = 1 - (2 * i + 1) / count;
        const r = Math.sqrt(Math.max(0, 1 - z * z));
        const a = golden * i;
        out.push([Math.cos(a) * r, Math.sin(a) * r, z]);
    }
    return out;
}

describe('octahedral normal encoding', () => {
    it('round-trips every direction on the sphere', () => {
        let worst = 1;
        for (const n of sphereDirections(4096)) worst = Math.min(worst, dot(n, octDecode(octEncode(n))));
        // Exact to floating point: the mapping is analytic and this test does not quantise. What it
        // catches is a wrong fold, which does not degrade the error — it flips the direction outright.
        expect(worst).toBeGreaterThan(1 - 1e-9);
    });

    it('round-trips the -Z hemisphere, which is where a wrong fold hides', () => {
        // Stated separately from the sweep above so a regression names the half it broke. Over +Z the
        // encoding is a plain projection and the fold never runs, so a broken `octWrap` passes there.
        let worst = 1;
        for (const n of sphereDirections(4096).filter(v => v[2] < -0.05))
            worst = Math.min(worst, dot(n, octDecode(octEncode(n))));
        expect(worst).toBeGreaterThan(1 - 1e-9);
    });

    it('survives 16-bit float quantisation, which is the target it is written to', () => {
        // gNormalRoughness is rgba16float. Half has a 10-bit mantissa, so a value in [-1, 1] lands on
        // a grid of about 2^-11 — the error that actually reaches the lighting pass.
        const half = (x: number) => Math.round(x * 2048) / 2048;
        let worstAngle = 0;
        for (const n of sphereDirections(2048)) {
            const e = octEncode(n);
            const back = octDecode([half(e[0]), half(e[1])]);
            worstAngle = Math.max(worstAngle, Math.acos(Math.min(1, dot(n, back))));
        }
        // Under a third of a degree across the whole sphere. Three raw components at the same precision
        // would not be better — this is why the channel was free to take rather than a compromise.
        expect(worstAngle * 180 / Math.PI).toBeLessThan(0.35);
    });

    it('decodes the cleared G-buffer to +Z, which is why the SSAO sentinel had to go', () => {
        // (0, 0) is a VALID direction under this mapping. Anything that used a zero normal to mean
        // "nothing was written here" is now wrong, and silently so.
        expect(octDecode([0, 0])).toEqual([0, 0, 1]);
    });

    it('encodes the axes where the writers assume they land', () => {
        // geometryFoliageBillboard writes +Y through the encoder rather than as a literal, because +Y
        // is NOT (0, 1) after the fold — it sits on the octahedron's equator, where z = 0.
        for (const axis of [[0, 1, 0], [0, -1, 0], [1, 0, 0], [0, 0, 1], [0, 0, -1]] as [number, number, number][])
            expect(dot(octDecode(octEncode(axis)), axis)).toBeGreaterThan(1 - 1e-9);
    });
});

describe('dielectric reflectance', () => {
    const dielectricF0 = (r: number) => 0.16 * r * r;

    it('puts the neutral default at the constant it replaced', () => {
        // The whole migration rests on this one number: 0.5 must be exactly 0.04, or every dielectric
        // in every existing project shifts the day this ships.
        expect(dielectricF0(0.5)).toBeCloseTo(0.04, 12);
    });

    it('spans the range real dielectrics occupy', () => {
        expect(dielectricF0(0)).toBe(0);
        expect(dielectricF0(1)).toBeCloseTo(0.16, 12);
        expect(dielectricF0(0.35)).toBeGreaterThan(0.018);   // water, ~0.02
        expect(dielectricF0(0.35)).toBeLessThan(0.022);
        expect(dielectricF0(0.7)).toBeGreaterThan(0.07);     // gemstone, ~0.08
    });
});

describe('the two copies of the encoder agree', () => {
    const WGSL = readFileSync(
        join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl', 'chunks', 'octNormal.wgsl'), 'utf-8');
    const GLSL = readFileSync(
        join(__dirname, '..', 'src', 'graphics', 'systems', 'customShaders.ts'), 'utf-8');

    it('the custom-material prelude carries a GLSL octEncode', () => {
        expect(GLSL).toContain('vec2 cleoOctEncode(vec3 n)');
        expect(GLSL).toContain('vec2 cleoOctWrap(vec2 v)');
    });

    it('both fold with (1 - abs(swapped)) * sign', () => {
        expect(WGSL).toContain('(1.0 - abs(vec2<f32>(v.y, v.x))) * signs');
        expect(GLSL).toContain('(1.0 - abs(v.yx)) * vec2(v.x >= 0.0 ? 1.0 : -1.0, v.y >= 0.0 ? 1.0 : -1.0)');
    });

    it('both branch on z >= 0 and both floor the L1 norm', () => {
        expect(WGSL).toContain('select(octWrap(p), p, n.z >= 0.0)');
        expect(GLSL).toContain('n.z >= 0.0 ? p : cleoOctWrap(p)');
        expect(WGSL).toContain('1e-6');
        expect(GLSL).toContain('1e-6');
    });

    it('the epilogue writes reflectance into the freed blue channel', () => {
        expect(GLSL).toContain('gNormalRoughness = vec4(cleoOctEncode(normalize(s.normal)), 0.5, s.roughness);');
    });
});

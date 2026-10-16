import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Curved silhouettes and the pixel depth offset for parallax occlusion mapping.
 *
 * `parallaxFrame` measures the surface's shape operator from screen derivatives of the shading normal
 * (`dn = S dp`), and `parallaxOcclusion` bends the ray by the curvature along it: depth below the curved
 * surface is `t - c t^2`. A convex ray past `c = 0.25` climbs back out of the relief layer, and one that
 * met nothing on the way is the silhouette the caller discards.
 *
 * The numeric cases run a JS twin of the shader's arithmetic; the source assertions are what tie that
 * twin to the WGSL, and the variant assertions are what keep frag_depth (which costs early-Z) out of
 * every program that does not march.
 */

const CHUNKS = join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl', 'chunks');
const read = (f: string) => readFileSync(join(CHUNKS, f), 'utf-8').replace(/\r\n/g, '\n');
/** Strip line comments so prose cannot satisfy or break a source assertion. */
const code = (src: string) => src.replace(/\/\/[^\n]*/g, '');
const fnBody = (src: string, name: string) => {
    const m = code(src).match(new RegExp(String.raw`fn\s+${name}\s*\([^{]*\{([\s\S]*?)\n\}`));
    expect(m, `${name} not found`).not.toBeNull();
    return m![1];
};

type V3 = [number, number, number];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => scale(a, 1 / Math.hypot(...a));

/** The shader's shape-operator solve, line for line (parallaxFrame). */
function shapeOperator(dp1: V3, dp2: V3, dn1: V3, dn2: V3, n: V3, tAxis: V3) {
    const e1 = norm(sub(tAxis, scale(n, dot(n, tAxis))));
    const e2 = cross(n, e1);
    const a1 = [dot(dp1, e1), dot(dp1, e2)], a2 = [dot(dp2, e1), dot(dp2, e2)];
    const m1 = [dot(dn1, e1), dot(dn1, e2)], m2 = [dot(dn2, e1), dot(dn2, e2)];
    const aDet = a1[0] * a2[1] - a2[0] * a1[1];
    if (!(Math.abs(aDet) > 1e-3 * Math.hypot(a1[0], a1[1]) * Math.hypot(a2[0], a2[1])))
        return { shape: [0, 0, 0] as V3, e1 };
    const inv = 1 / aDet;
    const sxx = (m1[0] * a2[1] - m2[0] * a1[1]) * inv;
    const sxy = (m2[0] * a1[0] - m1[0] * a2[0]) * inv;
    const syx = (m1[1] * a2[1] - m2[1] * a1[1]) * inv;
    const syy = (m2[1] * a1[0] - m1[1] * a2[0]) * inv;
    return { shape: [sxx, 0.5 * (sxy + syx), syy] as V3, e1 };
}

/** parallaxCurvature: the normal curvature along a world direction in the tangent plane. */
function curvatureAlong(shape: V3, e1: V3, n: V3, dir: V3) {
    const x = dot(dir, e1), y = dot(dir, cross(n, e1));
    return shape[0] * x * x + 2 * shape[1] * x * y + shape[2] * y * y;
}

/**
 * A point on a surface with screen derivatives that are SKEWED and ANISOTROPIC in its tangent plane —
 * what perspective does — at a 50-unit offset from the origin. `dnOf` maps a tangent displacement to
 * the change of the unit normal along it (the true shape operator).
 */
function sample(n: V3, dnOf: (dp: V3) => V3) {
    const t = norm(cross(n, Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
    const b = cross(n, t);
    const dp1 = add(scale(t, 0.013), scale(b, 0.004));
    const dp2 = add(scale(t, -0.002), scale(b, 0.021));
    return { dp1, dp2, dn1: dnOf(dp1), dn2: dnOf(dp2), t, b };
}

describe('the shape operator is recovered from screen derivatives', () => {
    it('a sphere reads 1/R in every direction', () => {
        for (const R of [0.5, 2, 40]) {
            const n = norm([0.3, 0.8, -0.5]);
            const { dp1, dp2, dn1, dn2, t, b } = sample(n, dp => scale(dp, 1 / R));
            const { shape, e1 } = shapeOperator(dp1, dp2, dn1, dn2, n, t);
            for (const dir of [t, b, norm(add(t, b)), norm(sub(scale(t, 0.3), b))])
                expect(curvatureAlong(shape, e1, n, dir), `R=${R}`).toBeCloseTo(1 / R, 6);
        }
    });

    it('a cylinder reads 1/R around it and 0 along its axis', () => {
        const R = 1.5, axis: V3 = [0, 0, 1];
        const n = norm([1, 0.4, 0]);
        // A cylinder's normal turns only with the displacement perpendicular to the axis.
        const { dp1, dp2, dn1, dn2, t } = sample(n, dp => scale(sub(dp, scale(axis, dot(dp, axis))), 1 / R));
        const { shape, e1 } = shapeOperator(dp1, dp2, dn1, dn2, n, t);
        expect(curvatureAlong(shape, e1, n, axis)).toBeCloseTo(0, 6);
        expect(curvatureAlong(shape, e1, n, cross(n, axis))).toBeCloseTo(1 / R, 6);
    });

    it('a plane reads exactly zero, so it takes the flat march', () => {
        const n = norm([0, 1, 0]);
        const { dp1, dp2, dn1, dn2, t } = sample(n, () => [0, 0, 0]);
        const { shape } = shapeOperator(dp1, dp2, dn1, dn2, n, t);
        expect(shape).toEqual([0, 0, 0]);
    });

    it('a seen-from-inside sphere is concave: the eye flip negates the operator', () => {
        // The shader multiplies dn by `eyeSide` with the normal; here that is the normal negated and dn
        // with it, which is what the inside of a double-sided sphere hands the frame.
        const R = 2, n = norm([0.3, 0.8, -0.5]);
        const { dp1, dp2, dn1, dn2, t } = sample(n, dp => scale(dp, 1 / R));
        const inside = shapeOperator(dp1, dp2, scale(dn1, -1), scale(dn2, -1), scale(n, -1), t);
        expect(curvatureAlong(inside.shape, inside.e1, scale(n, -1), t)).toBeCloseTo(-1 / R, 6);
    });

    it('collapsed derivatives give zero, never a blow-up', () => {
        const n = norm([0, 1, 0]);
        const dp: V3 = [0.01, 0, 0];
        const { shape } = shapeOperator(dp, scale(dp, 2), [0.1, 0, 0], [0.2, 0, 0], n, [1, 0, 0]);
        expect(shape).toEqual([0, 0, 0]);
    });
});

/** The march's hit test, in JS: a constant field at height `h` (surf = 1 - h). */
function march(c: number, h: number, steps: number) {
    const surf = 1 - h;
    const convex = c > 0.25;
    const tEnd = convex ? 1 / Math.max(c, 1e-8) : 2 / (1 + Math.sqrt(Math.max(1 - 4 * c, 0)));
    const dStep = tEnd / steps;
    let t = 0, ray = 0;
    for (let i = 0; i < 64; i++) {
        if (i >= steps || ray >= surf) break;
        t += dStep;
        ray = t - c * t * t;
    }
    return { t, ray, tEnd, miss: convex && ray < surf };
}

describe('the curved march', () => {
    it('reduces EXACTLY to the flat march at zero curvature', () => {
        for (const steps of [4, 7.5, 31, 64]) {
            const curved = march(0, 0.3, steps);
            let t = 0;
            for (let i = 0; i < 64; i++) { if (i >= steps || t >= 0.7) break; t += 1 / steps; }
            expect(curved.tEnd).toBe(1);
            expect(curved.t).toBe(t);
            expect(curved.ray).toBe(t);
        }
    });

    it('flat and concave rays always reach the floor, so they never miss', () => {
        for (const c of [-3, -0.5, 0, 0.1, 0.25]) {
            const m = march(c, 0, 64);
            expect(m.miss, `c=${c}`).toBe(false);
            expect(m.tEnd - c * m.tEnd * m.tEnd, `c=${c}: tEnd is the floor`).toBeCloseTo(1, 9);
        }
    });

    it('a convex ray past 0.25 climbs back out: its deepest point is 1/(4c)', () => {
        // A field whose surface sits at depth 0.5 is out of reach once 1/(4c) < 0.5, i.e. c > 0.5.
        expect(march(0.4, 0.5, 64).miss, 'apex 0.625 reaches it').toBe(false);
        expect(march(0.8, 0.5, 64).miss, 'apex 0.3125 does not').toBe(true);
        // ...while a surface at the very top is met immediately however convex the ray.
        expect(march(5, 1, 64).miss).toBe(false);
    });

    it('the shader carries the same arithmetic', () => {
        const body = fnBody(read('parallax.wgsl'), 'parallaxOcclusion');
        expect(body).toMatch(/ray = t - c \* t \* t;/);
        expect(body, 'the stable floor root').toMatch(/2\.0 \/ \(1\.0 \+ sqrt\(max\(1\.0 - 4\.0 \* c, 0\.0\)\)\)/);
        expect(body, 'a miss only where the ray can climb out').toMatch(/let miss = convex && ray < surf;/);
        expect(body, 'the convex threshold').toMatch(/let convex = c > 0\.25;/);
    });

    it('a convex surface lifts the graze fade instead of leaving an uncarved rim', () => {
        const body = fnBody(read('parallax.wgsl'), 'parallaxOcclusion');
        expect(body).toMatch(/max\(parallaxGrazeFade\(vTan\.z\), silhouette\)/);
    });
});

describe('parallaxFrame measures curvature where it may', () => {
    const body = () => fnBody(read('parallax.wgsl'), 'parallaxFrame');

    it('takes the normal derivatives beside the position derivatives, above every branch', () => {
        const b = body();
        const firstBranch = b.search(/\bif\s*\(/);
        for (const d of ['dpdx(fragPos)', 'dpdy(fragPos)', 'dpdx(nShade)', 'dpdy(nShade)']) {
            const at = b.indexOf(d);
            expect(at, `${d} missing`).toBeGreaterThanOrEqual(0);
            expect(at, `${d} must sit in uniform control flow`).toBeLessThan(firstBranch);
        }
    });

    it('guards the solve RELATIVELY, never with an absolute floor on a per-pixel quantity', () => {
        expect(body()).toMatch(/abs\(aDet\) > POM_SHAPE_MIN_SINE \* length\(a1\) \* length\(a2\)/);
    });
});

describe('the pixel depth offset', () => {
    it('only pushes depth back, as a delta on the rasterised depth', () => {
        const b = fnBody(read('parallax.wgsl'), 'parallaxDepth');
        expect(b).toMatch(/rasterDepth \+ max\(delta, 0\.0\)/);
    });

    for (const file of ['pbrGBuffer.wgsl', 'pbrForward.wgsl']) {
        it(`${file}: frag_depth exists only inside the CLEO_POM variant`, () => {
            const src = code(read(file));
            const outside = src.replace(/#if CLEO_POM\n[\s\S]*?#(else|endif)/g, '');
            expect(src).toMatch(/frag_depth/);
            expect(outside, 'frag_depth outside `#if CLEO_POM` costs early-Z on every PBR draw').not.toMatch(/frag_depth/);
            expect(src, 'the base program must not march').not.toMatch(/!defined\(CLEO_POM\)/);
        });

        it(`${file}: discards a curved-silhouette miss`, () => {
            expect(code(read(file))).toMatch(/if \(hit\.miss\) \{ discard; \}/);
        });

        it(`${file}: marches whenever a height map is present — no parallax flag`, () => {
            const src = code(read(file));
            expect(src).not.toMatch(/u_material\.parallax\b/);
            expect(src).toMatch(/u_material\.hasDisplacementMap != 0 && su\.mode != UV_TRIPLANAR/);
        });
    }
});

describe('the editor binds the parallax variant, not the base program', () => {
    it('Pom names resolve to their pom variant without the variant system too', () => {
        const src = readFileSync(join(__dirname, '..', 'src', 'graphics', 'renderer.ts'), 'utf-8');
        expect(src).toMatch(/name in EXTRA_LOGICAL_NAMES \? physicalFor\(name,/);
    });
});

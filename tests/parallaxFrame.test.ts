import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * `parallaxFrame` answers one question: how fast do u and v move per unit of world displacement?
 *
 * That is the RECIPROCAL (dual) basis of the uv chart, and `parallaxToTangent`'s three dot products are
 * its defining operation — not a transpose that happens to require orthonormality. Getting that
 * backwards is the history of this file, so the invariant every case here checks is the same one:
 * **the frame reproduces the analytic parallax offset**
 *
 *     offset_uv = -D * (v . T*, v . B*) / (v . n),   D = depth_uv * worldPerUv
 *
 * for a chart of any shape. Not "the columns are unit and perpendicular" — that was the assumption
 * that broke, and it holds only for a square chart.
 *
 * WHAT WENT WRONG, in order, because each fix exposed the next:
 *
 *  1. The frame crossed the chart against the INTERPOLATED normal, scaled both columns by one shared
 *     `max(|t|, |b|)`, and oriented to the eye ABOVE the cross products. Three defects, all invisible
 *     on a cube: a dual pair is only mutually perpendicular when the chart's axes are (measured, 30
 *     degree normal tilt: columns 82.1 degrees apart, second 0.961 long, round-trip off by 0.149); the
 *     eye flip negated the tangent columns too, so the march ran backwards near every silhouette; and
 *     the shared normaliser sheared anisotropic charts.
 *  2. Deriving a geometric normal from `cross(dpdx(fragPos), dpdy(fragPos))` made it WORSE — `fragPos`
 *     is a world position, so that cross product is a cancellation: off by 0.06 degrees at 20 units
 *     from the origin and 0.84 at 500, quantised, piecewise constant per 2x2 quad. Blocky noise on a
 *     flat cube face. Reverted.
 *  3. Taking the chart's handedness as a SIGN from the same cross product had the same disease — it
 *     goes to zero as the surface turns edge-on, so neighbouring quads marched in OPPOSITE directions.
 *     Reverted; inverting the chain rule recovers the axes with no handedness term at all.
 *  4. The orthonormal frame FORCED `B = cross(n, T)`. A uv chart is under no obligation to be square:
 *     31% of a photogrammetry scan's triangles are more than 10 degrees off it, 23.9 at p90. Forcing it
 *     ROTATES the offset by an amount that depends on where the view sits relative to the skew — 0.4
 *     degrees of error at one azimuth and 28.7 at another, on the same chart at the same view angle.
 *     Zooming looked right; orbiting did not. That is what the dual basis fixes.
 */

const CHUNKS = join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl', 'chunks');
const source = () => readFileSync(join(CHUNKS, 'parallax.wgsl'), 'utf-8').replace(/\/\/[^\n]*/g, '');

type V3 = [number, number, number];
type V2 = [number, number];

const cross = (a: V3, b: V3): V3 =>
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (v: V3, k: number): V3 => [v[0] * k, v[1] * k, v[2] * k];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (v: V3) => Math.sqrt(dot(v, v));
const unit = (v: V3): V3 => scale(v, 1 / norm(v));

/** One surface sample, in the terms the shader is handed. */
interface Sample {
    du1: V2; du2: V2;      // dpdx(uv), dpdy(uv)
    dp1: V3; dp2: V3;      // dpdx(fragPos), dpdy(fragPos)
    nShade: V3;            // tbn[2], the interpolated vertex normal
    toEye: V3;
}

interface Frame { t: V3; b: V3; n: V3; worldPerUv: number }

/** The shader's frame, in JS. Mirrors `parallaxFrame` line for line. */
const frame = (s: Sample): Frame => {
    const det = s.du1[0] * s.du2[1] - s.du2[0] * s.du1[1];
    const tu = sub(scale(s.dp1, s.du2[1]), scale(s.dp2, s.du1[1]));   // det * dP/du
    const bu = sub(scale(s.dp2, s.du1[0]), scale(s.dp1, s.du2[0]));   // det * dP/dv
    const worldPerUv = Math.sqrt(norm(tu) * norm(bu)) / Math.max(Math.abs(det), 1e-30);

    const nShade = unit(s.nShade);
    const n: V3 = dot(nShade, s.toEye) >= 0 ? nShade : scale(nShade, -1);

    const tp = sub(tu, scale(n, dot(n, tu)));
    const bp = sub(bu, scale(n, dot(n, bu)));
    const jac = dot(cross(tp, bp), n);
    if (Math.abs(jac) < 1e-30) return { t: [0, 0, 0], b: [0, 0, 0], n, worldPerUv };
    const k = (worldPerUv * det) / jac;
    return { t: scale(cross(bp, n), k), b: scale(cross(n, tp), k), n, worldPerUv };
};

/**
 * The version this replaced: the chart's u axis, with `B` forced perpendicular to it. Kept so every
 * case can state what it used to do rather than asserting a remembered number.
 */
const orthonormalFrame = (s: Sample): Frame => {
    const f = frame(s);
    const det = s.du1[0] * s.du2[1] - s.du2[0] * s.du1[1];
    const tu = sub(scale(s.dp1, s.du2[1]), scale(s.dp2, s.du1[1]));
    const bu = sub(scale(s.dp2, s.du1[0]), scale(s.dp1, s.du2[0]));
    const orient = det >= 0 ? 1 : -1;
    const tAxis = scale(tu, (1 / Math.sqrt(Math.max(dot(tu, tu), 1e-30))) * orient);
    const bAxis = scale(bu, (1 / Math.sqrt(Math.max(dot(bu, bu), 1e-30))) * orient);
    const n = f.n;
    const tProj = sub(tAxis, scale(n, dot(n, tAxis)));
    const T = scale(tProj, 1 / Math.sqrt(dot(tProj, tProj)));
    const bPerp = cross(n, T);
    return { t: T, b: scale(bPerp, dot(bPerp, bAxis) >= 0 ? 1 : -1), n, worldPerUv: f.worldPerUv };
};

/** The chart's true axes, recovered from the same derivatives the shader sees. */
const chart = (s: Sample) => {
    const det = s.du1[0] * s.du2[1] - s.du2[0] * s.du1[1];
    return {
        dPdu: scale(sub(scale(s.dp1, s.du2[1]), scale(s.dp2, s.du1[1])), 1 / det) as V3,
        dPdv: scale(sub(scale(s.dp2, s.du1[0]), scale(s.dp1, s.du2[0])), 1 / det) as V3,
        det,
    };
};

/**
 * GROUND TRUTH: the uv offset for walking down the view ray to world depth `D`, straight from the
 * reciprocal basis. No approximation, and no reference to how the shader builds anything.
 */
const analyticOffset = (s: Sample, depthUv: number): V2 => {
    const { dPdu, dPdv } = chart(s);
    const f = frame(s);
    const n = f.n;
    const J = dot(cross(dPdu, dPdv), n);
    const Ts = scale(cross(dPdv, n), 1 / J);
    const Bs = scale(cross(n, dPdu), 1 / J);
    const v = unit(s.toEye);
    const step = (depthUv * f.worldPerUv) / dot(v, n);
    const dp = scale(v, -step);
    return [dot(dp, Ts), dot(dp, Bs)];
};

/** What the shader actually produces: three dot products, then `vTan.xy / vTan.z * depth`. */
const shaderOffset = (f: Frame, s: Sample, depthUv: number): V2 => {
    const v = unit(s.toEye);
    const vt: V3 = [dot(v, f.t), dot(v, f.b), dot(v, f.n)];
    return [(-vt[0] / vt[2]) * depthUv, (-vt[1] / vt[2]) * depthUv];
};

const offsetError = (got: V2, want: V2) => {
    const c = (got[0] * want[0] + got[1] * want[1]) / (Math.hypot(...got) * Math.hypot(...want));
    return {
        deg: (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI,
        ratio: Math.hypot(...got) / Math.hypot(...want),
    };
};

/**
 * A flat patch in world XY. `skewDeg` tilts dP/dv away from perpendicular and `aniso` stretches it —
 * the two things a real uv unwrap does and a square chart does not.
 */
const patch = (o: Partial<Sample> & { uScale?: number; vScale?: number; skewDeg?: number;
                                      aniso?: number } = {}): Sample => {
    const phi = ((90 - (o.skewDeg ?? 0)) * Math.PI) / 180;
    const a = o.aniso ?? 1;
    return {
        du1: [1 / (o.uScale ?? 1), 0],
        du2: [0, 1 / (o.vScale ?? 1)],
        dp1: [1, 0, 0],
        dp2: [a * Math.cos(phi), a * Math.sin(phi), 0],
        nShade: [0, 0, 1],
        toEye: [0, 0, 1],
        ...o,
    };
};

/** A view direction `theta` from the normal, swept to `azimuth` around it. */
const view = (thetaDeg: number, azimuthDeg: number): V3 => {
    const t = (thetaDeg * Math.PI) / 180, a = (azimuthDeg * Math.PI) / 180;
    return [Math.sin(t) * Math.cos(a), Math.sin(t) * Math.sin(a), Math.cos(t)];
};

describe('the frame reproduces the analytic offset, for any chart', () => {
    const CHARTS: [string, Partial<Sample> & { skewDeg?: number; aniso?: number; uScale?: number;
                                               vScale?: number }][] = [
        ['square', {}],
        ['median skew 5, median aniso 1.09', { skewDeg: 5, aniso: 1.09 }],
        ['p75 skew 12.5', { skewDeg: 12.5, aniso: 1.2 }],
        ['p90 skew 24, p90 aniso 1.5', { skewDeg: 24, aniso: 1.5 }],
        ['p95 skew 34', { skewDeg: 34, aniso: 1.5 }],
        ['heavily skewed and stretched', { skewDeg: 55, aniso: 4 }],
        ['negative skew, the other way', { skewDeg: -30, aniso: 1.3 }],
        ['tiled 10x', { uScale: 10, vScale: 10 }],
        ['mirrored in v', { dp2: [0, -1, 0] as V3 }],
        ['tilted shading normal', { skewDeg: 18, nShade: unit([0.35, 0.2, 1]) as V3 }],
    ];

    for (const [why, o] of CHARTS)
        for (const [theta, az] of [[30, 0], [60, 30], [60, 75], [75, 200], [80, 130]]) {
            it(`${why} - view ${theta} deg, azimuth ${az} deg`, () => {
                const s = patch({ ...o, toEye: view(theta, az) });
                const err = offsetError(shaderOffset(frame(s), s, 0.05), analyticOffset(s, 0.05));
                // 1e-4 degrees, not 1e-6: `acos` is ill-conditioned near 1, so the last couple of
                // digits here are the arccosine's, not the frame's. The magnitude check below is the
                // tight one - it compares the vectors directly and holds to 9 places.
                expect(err.deg, 'direction').toBeLessThan(1e-4);
                expect(err.ratio, 'magnitude').toBeCloseTo(1, 9);
            });
        }
});

describe('the orthonormal frame this replaced, and exactly how it failed', () => {
    it('was exact on a SQUARE chart, which is why every primitive looked correct', () => {
        // Cube, plane, sphere: the defect could not express itself, so several rounds of work went
        // looking for it in the wrong place.
        for (const [theta, az] of [[30, 0], [60, 30], [60, 75], [80, 130]]) {
            const s = patch({ toEye: view(theta, az) });
            const err = offsetError(shaderOffset(orthonormalFrame(s), s, 0.05), analyticOffset(s, 0.05));
            expect(err.deg, `view ${theta}/${az}`).toBeLessThan(1e-6);
            expect(err.ratio).toBeCloseTo(1, 9);
        }
    });

    it('ROTATED the offset on a skewed chart, by an amount that depends on the AZIMUTH', () => {
        // The reported symptom, reproduced: zooming (which changes only the magnitude) looked right
        // while orbiting did not, because the error is a function of where the view sits relative to
        // the skew. Same chart, same angle from the normal, different way round.
        const o = { skewDeg: 24, aniso: 1.5 };
        const near = patch({ ...o, toEye: view(60, 30) });
        const far = patch({ ...o, toEye: view(60, 75) });
        const a = offsetError(shaderOffset(orthonormalFrame(near), near, 0.05), analyticOffset(near, 0.05));
        const b = offsetError(shaderOffset(orthonormalFrame(far), far, 0.05), analyticOffset(far, 0.05));
        expect(a.deg, 'one azimuth happens to be nearly right').toBeLessThan(2);
        expect(b.deg, 'another is 20+ degrees out, on the SAME surface').toBeGreaterThan(20);
        // ...and the dual is exact at both, which is the point.
        expect(offsetError(shaderOffset(frame(near), near, 0.05), analyticOffset(near, 0.05)).deg)
            .toBeLessThan(1e-6);
        expect(offsetError(shaderOffset(frame(far), far, 0.05), analyticOffset(far, 0.05)).deg)
            .toBeLessThan(1e-6);
    });

    it('and got the magnitude wrong too, growing with the skew', () => {
        for (const [skewDeg, aniso, atLeast] of [[12.5, 1.2, 1.02], [24, 1.5, 1.08], [34, 1.5, 1.15]]) {
            const s = patch({ skewDeg, aniso, toEye: view(60, 30) });
            const err = offsetError(shaderOffset(orthonormalFrame(s), s, 0.05), analyticOffset(s, 0.05));
            expect(err.ratio, `skew ${skewDeg}`).toBeGreaterThan(atLeast);
        }
    });
});

describe('the frame is a reciprocal basis, so it is NOT orthonormal - on purpose', () => {
    it('column 0 is perpendicular to dP/dv, and column 1 to dP/du', () => {
        // The defining property. On a square chart it coincides with "perpendicular to each other",
        // which is what let the wrong version look right for so long.
        const s = patch({ skewDeg: 30, aniso: 1.4 });
        const f = frame(s), c = chart(s);
        expect(dot(f.t, c.dPdv), 'the u-rate does not respond to moving along v').toBeCloseTo(0, 9);
        expect(dot(f.b, c.dPdu), 'nor the v-rate to moving along u').toBeCloseTo(0, 9);
        expect(dot(f.t, c.dPdu) / f.worldPerUv, 'one uv unit per dP/du').toBeCloseTo(1, 9);
        expect(dot(f.b, c.dPdv) / f.worldPerUv, 'one uv unit per dP/dv').toBeCloseTo(1, 9);
    });

    it('its columns are NOT perpendicular once the chart is skewed', () => {
        const f = frame(patch({ skewDeg: 30, aniso: 1.4 }));
        const c = Math.abs(dot(f.t, f.b)) / (norm(f.t) * norm(f.b));
        expect(c, 'forcing this to zero is the bug this file exists for').toBeGreaterThan(0.3);
    });

    it('but on a square chart it still is, so nothing already correct moved', () => {
        const f = frame(patch());
        expect(dot(f.t, f.b)).toBeCloseTo(0, 9);
        expect(norm(f.t)).toBeCloseTo(1, 9);
        expect(norm(f.b)).toBeCloseTo(1, 9);
    });
});

describe('the eye-facing flip moves the NORMAL and nothing else', () => {
    // A smoothed vertex normal can point away from the eye on a face that is still front-facing - a
    // visible band near every silhouette of a low-poly smooth mesh. It used to negate the chart columns
    // with it, marching the ray the opposite way inside that band.
    const facing = patch({ toEye: [0, 0, 1] });
    const turned = patch({ toEye: unit([0.35, 0, -1]) });

    it('the chart columns are unchanged and only the normal flips', () => {
        expect(dot(facing.nShade, turned.toEye), 'the fixture really has it turned away').toBeLessThan(0);
        const a = frame(facing), b = frame(turned);
        for (let i = 0; i < 3; i++) {
            expect(b.t[i]).toBeCloseTo(a.t[i], 12);
            expect(b.b[i]).toBeCloseTo(a.b[i], 12);
            expect(b.n[i]).toBeCloseTo(-a.n[i], 12);
        }
    });
});

describe('the chart world scale, which is what makes a depth mean anything', () => {
    /**
     * `dispScale` was UV-only, and a uv depth is meaningless until you know what a uv unit is worth. A
     * tiling material puts one repeat inside a few centimetres; an atlas-mapped scan puts one repeat
     * around the WHOLE OBJECT. Measured on the branch that prompted this: 47.97 world units per uv
     * unit, so the 0.05 default asked for 2.4 units of relief on a branch 12.7 units thick.
     */
    it('is 1 where one uv unit is one world unit', () => {
        expect(frame(patch()).worldPerUv).toBeCloseTo(1, 9);
    });

    it('scales with the chart, not with the geometry', () => {
        expect(frame(patch({ uScale: 10, vScale: 10 })).worldPerUv).toBeCloseTo(10, 6);
        expect(frame(patch({ uScale: 0.25, vScale: 0.25 })).worldPerUv).toBeCloseTo(0.25, 6);
    });

    it('is the geometric mean on an anisotropic chart', () => {
        expect(frame(patch({ uScale: 10 })).worldPerUv).toBeCloseTo(Math.sqrt(10), 6);
    });

    it('does not depend on the screen, the normal, or the handedness', () => {
        const want = frame(patch()).worldPerUv;
        for (const [why, s] of [
            ['y-DOWN screen', patch({ du2: [0, -1], dp2: [0, -1, 0] })],
            ['mirrored chart', patch({ dp2: [0, -1, 0] })],
            ['tilted shading normal', patch({ nShade: unit([0.4, 0.3, 1]) })],
        ] as [string, Sample][]) expect(frame(s).worldPerUv, why).toBeCloseTo(want, 6);
    });

    it('a world depth becomes the uv depth the march wants', () => {
        const toUv = (depth: number, worldPerUv: number) => depth / Math.max(worldPerUv, 1e-6);
        expect(toUv(0.3, 1)).toBeCloseTo(0.3, 9);
        expect(toUv(0.3, 47.97)).toBeCloseTo(0.006254, 6);
    });
});

describe('degenerate inputs yield no offset rather than a NaN', () => {
    it('a fragment with no uv gradient gets zero chart columns', () => {
        const f = frame(patch({ du1: [0, 0], du2: [0, 0] }));
        expect(norm(f.t)).toBe(0);
        expect(norm(f.b)).toBe(0);
        expect(f.n.every(Number.isFinite), 'the normal is still usable').toBe(true);
    });

    it('a collapsed derivative quad is finite', () => {
        const f = frame(patch({ dp1: [0, 0, 0], dp2: [0, 0, 0] }));
        expect(f.t.every(Number.isFinite)).toBe(true);
        expect(f.b.every(Number.isFinite)).toBe(true);
    });

    it('a SMALL but perfectly ordinary chart is not mistaken for a degenerate one', () => {
        // `|tu|` is `|det| * |dP/du|` and `det` is a per-PIXEL Jacobian, so `dot(tu, tu)` sits around
        // 1e-12 on ordinary geometry at an ordinary distance. A guard anywhere near that reads it as
        // "no texture mapping" and switches the effect off on small and distant surfaces.
        const tiny = 1e-6;
        // An off-axis view: head-on the offset is exactly zero and its DIRECTION is undefined, which
        // is a property of parallax rather than of the frame.
        const s = patch({ du1: [tiny, 0], du2: [0, tiny], dp1: [tiny, 0, 0], dp2: [0, tiny, 0],
                          toEye: view(60, 35) });
        const err = offsetError(shaderOffset(frame(s), s, 0.05), analyticOffset(s, 0.05));
        expect(err.deg).toBeLessThan(1e-4);
        expect(err.ratio).toBeCloseTo(1, 9);
        expect(frame(s).worldPerUv).toBeCloseTo(1, 4);
    });
});

describe('parallaxFrame applies it', () => {
    const body = () => {
        const fn = source().match(/fn\s+parallaxFrame[^{]*\{([\s\S]*?)\n\}/);
        expect(fn, 'parallaxFrame not found').not.toBeNull();
        return fn![1];
    };

    it('recovers the chart axes by inverting the chain rule', () => {
        const b = body();
        expect(b, 'det * dP/du').toMatch(/dp1 \* du2\.y - dp2 \* du1\.y/);
        expect(b, 'det * dP/dv').toMatch(/dp2 \* du1\.x - dp1 \* du2\.x/);
    });

    it('builds the RECIPROCAL basis, and does not normalise the columns', () => {
        const b = body();
        expect(b, 'column 0 is perpendicular to dP/dv').toMatch(/cross\(bp, n\) \* k/);
        expect(b, 'column 1 is perpendicular to dP/du').toMatch(/cross\(n, tp\) \* k/);
        expect(b, 'scaled by the signed chart area, which carries the handedness')
            .toMatch(/jac = dot\(cross\(tp, bp\), n\)/);
        expect(b, 'forcing the second column perpendicular to the first is the shear this replaced')
            .not.toMatch(/cross\(n, T\)/);
    });

    it('never takes a cross product of the position derivatives', () => {
        // `dpdx(fragPos)` is a difference of two nearly equal large world numbers, so a cross product
        // of two of them can land orders of magnitude below its own terms: as a DIRECTION it was blocky
        // per-2x2-quad noise on a flat cube face, and as a SIGN it flipped between neighbouring quads
        // and marched them in opposite directions. Both reverted. The derivatives may only enter
        // linearly, as they do in `tu`/`bu`.
        const b = body();
        for (const args of [...b.matchAll(/cross\(([^)]*)\)/g)].map(m => m[1]))
            expect(args, `cross(${args}) mixes the position derivatives`).not.toMatch(/dp1|dp2/);
    });

    it('reads only the NORMAL out of the vertex basis', () => {
        // `tbn[1]` means opposite things on a mesh and on terrain (modelVarying negates the bitangent
        // for the green-down decode; terrain pushes [0,0,-1] to cancel that), and the vertex bitangent
        // is `cross(N, T) * w` - perpendicular by construction, so it carries no skew to correct with.
        const b = body();
        expect(b, 'the normal').toMatch(/normalize\(tbn\[2\]\)/);
        expect(b, 'and nothing else from the varyings').not.toMatch(/tbn\[0\]|tbn\[1\]/);
    });

    it('orients only the returned normal by the eye, below the chart', () => {
        const b = body();
        const flip = b.indexOf('dot(nShade, toEye)');
        const chartAt = Math.max(b.indexOf('let tu'), b.indexOf('let bu'));
        expect(flip, 'the eye flip is present').toBeGreaterThan(-1);
        expect(flip, 'it must sit BELOW the chart, or it negates the columns too')
            .toBeGreaterThan(chartAt);
    });

    it('measures the chart world scale, and guards it as an exact-zero case', () => {
        const b = body();
        expect(b, 'the geometric mean of the two axes over |det|')
            .toMatch(/worldPerUv = sqrt\(length\(tu\) \* length\(bu\)\) \/ max\(abs\(det\), 1e-30\)/);
        expect(b, 'a floor anywhere near a real per-pixel Jacobian would switch it off on small surfaces')
            .not.toMatch(/max\(abs\(det\), 1e-(?:[0-9]|1[0-9])\)/);
        // The product of the two SQUARED lengths is ~1e-24 on ordinary geometry, so flooring THAT at
        // 1e-30 replaces real values rather than guarding zero. Measured: a chart that should have
        // reported 1 reported 31623.
        expect(b, 'never floor the product of the squared lengths')
            .not.toMatch(/dot\(tu, tu\) \* dot\(bu, bu\)/);
    });

    it('the depth is converted by that scale, not assumed to be uv', () => {
        const src = source();
        expect(src, 'one helper, so the two chunks cannot disagree about the unit')
            .toMatch(/fn parallaxDepthUv\(depth: f32, worldPerUv: f32, inWorld: bool\)/);
        expect(src, 'a world depth is divided by the chart scale')
            .toMatch(/select\(depth, depth \/ max\(worldPerUv, 1e-6\), inWorld\)/);
    });

    it('the degenerate test is on the chart area, and is an exact-zero guard', () => {
        expect(body()).toMatch(/abs\(jac\) < 1e-30/);
    });
});

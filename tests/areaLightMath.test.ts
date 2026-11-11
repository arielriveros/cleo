import { describe, expect, it } from 'vitest';
import {
    areaPolygon, cross, dot, ltcFrame, ltcIntegrate, ltcLookup, ltcSpecular, normalize, IDENTITY3,
    type AreaEmitter, type V3,
} from '../src/graphics/areaLightMath';
import { AreaLight, LIGHT_UNIT, PointLight, REFERENCE_ILLUMINANCE } from '../src/graphics/lighting';

/** A 2 x 1 m panel 3 m up, facing down. */
const panel = (over: Partial<AreaEmitter> = {}): AreaEmitter => ({
    center: [0, 3, 0], normal: [0, -1, 0], tangent: [1, 0, 0], halfWidth: 1, halfHeight: 0.5,
    shape: 'rect', twoSided: false, ...over,
});

/** Brute force over the emitter's surface: sum f(l, dOmega) over an n x n grid of patches (a disk masks its square). */
function overEmitter(e: AreaEmitter, P: V3, n: number, f: (l: V3, dOmega: number) => number): number {
    const b = cross(e.normal, e.tangent);
    const hw = e.halfWidth, hh = e.shape === 'disk' ? e.halfWidth : e.halfHeight;
    const dA = (2 * hw / n) * (2 * hh / n);
    let sum = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const u = -hw + (i + 0.5) * 2 * hw / n, v = -hh + (j + 0.5) * 2 * hh / n;
        if (e.shape === 'disk' && u * u + v * v > hw * hw) continue;
        const q: V3 = [e.center[0] + e.tangent[0] * u + b[0] * v, e.center[1] + e.tangent[1] * u + b[1] * v,
                       e.center[2] + e.tangent[2] * u + b[2] * v];
        const d: V3 = [q[0] - P[0], q[1] - P[1], q[2] - P[2]];
        const d2 = dot(d, d);
        const l = normalize(d);
        const cosE = -dot(l, e.normal);
        const emitting = e.twoSided ? Math.abs(cosE) : Math.max(0, cosE);
        if (emitting <= 0) continue;
        sum += f(l, emitting * dA / d2);
    }
    return sum;
}

/** The exact Lambertian form factor (1/pi) integral of cos over the emitter, by brute force. */
function formFactorBrute(e: AreaEmitter, P: V3, N: V3): number {
    return overEmitter(e, P, 400, (l, dOmega) => Math.max(0, dot(N, l)) * dOmega) / Math.PI;
}

describe('area light form factor (the diffuse integral)', () => {
    const N: V3 = [0, 1, 0];
    it('matches brute force straight under the panel, off to the side and tilted', () => {
        const cases: [V3, V3][] = [
            [[0, 0, 0], N], [[2.5, 0, 1], N], [[0, 0, 4], N], [[0, 1, 0], normalize([1, 1, 0])], [[1, 2.5, 0], N],
        ];
        for (const [P, n] of cases) {
            const brute = formFactorBrute(panel(), P, n);
            const ltc = ltcIntegrate(panel(), P, ltcFrame(n, n), IDENTITY3);
            expect(ltc).toBeGreaterThan(0);
            expect(Math.abs(ltc - brute) / brute).toBeLessThan(0.01);
        }
    });

    it('is the inverse square law far away: FF -> A cos cos / (pi d^2)', () => {
        const P: V3 = [0, -30, 0];
        const expected = 2 * 1 / (Math.PI * 33 * 33);
        expect(ltcIntegrate(panel(), P, ltcFrame(N, N), IDENTITY3) / expected).toBeCloseTo(1, 2);
    });

    it('a disk is shaded as an octagon of its area', () => {
        const disk = panel({ shape: 'disk', halfWidth: 0.6 });
        expect(Math.abs(polygonArea(areaPolygon(disk)) - Math.PI * 0.36) / (Math.PI * 0.36)).toBeLessThan(1e-3);
        for (const P of [[0, 0, 0], [1.5, 0, 0.5]] as V3[]) {
            const brute = formFactorBrute(disk, P, N);
            expect(Math.abs(ltcIntegrate(disk, P, ltcFrame(N, N), IDENTITY3) - brute) / brute).toBeLessThan(0.02);
        }
    });

    it('lights nothing behind a one-sided panel, and both sides of a two-sided one alike', () => {
        const above: V3 = [0, 5, 0], down: V3 = [0, -1, 0];
        expect(ltcIntegrate(panel(), above, ltcFrame(down, down), IDENTITY3)).toBe(0);
        const two = panel({ twoSided: true });
        const below = ltcIntegrate(two, [0, 1, 0], ltcFrame(N, N), IDENTITY3);
        const over = ltcIntegrate(two, [0, 5, 0], ltcFrame(down, down), IDENTITY3);
        expect(over).toBeGreaterThan(0);
        expect(over / below).toBeCloseTo(1, 6);
    });

    it('clips at the receiver horizon within a few percent (a panel straddling a wall)', () => {
        // A receiver whose plane cuts the panel in two: half of it is behind the receiver.
        const P: V3 = [0, 2, 0], n: V3 = [1, 0, 0];
        const brute = formFactorBrute(panel(), P, n);
        const ltc = ltcIntegrate(panel(), P, ltcFrame(n, n), IDENTITY3);
        expect(brute).toBeGreaterThan(0.01);
        expect(Math.abs(ltc - brute) / brute).toBeLessThan(0.01);
    });
});

function polygonArea(poly: V3[]): number {
    let a: V3 = [0, 0, 0];
    for (let i = 0; i < poly.length; i++) {
        const c = cross(poly[i], poly[(i + 1) % poly.length]);
        a = [a[0] + c[0], a[1] + c[1], a[2] + c[2]];
    }
    return Math.hypot(a[0], a[1], a[2]) / 2;
}

describe('area light specular (the LTC fit)', () => {
    /** Brute-force GGX (height-correlated Smith, F = 1) over the emitter, as pbrLighting.wgsl evaluates a lobe. */
    function ggxBrute(e: AreaEmitter, P: V3, N: V3, V: V3, perceptual: number): number {
        const alpha = perceptual * perceptual, a2 = alpha * alpha;
        const NoV = Math.max(dot(N, V), 1e-4);
        return overEmitter(e, P, 500, (l, dOmega) => {
            const NoL = dot(N, l);
            if (NoL <= 0) return 0;
            const h = normalize([l[0] + V[0], l[1] + V[1], l[2] + V[2]]);
            const NoH = Math.max(0, dot(N, h));
            const f = (NoH * a2 - NoH) * NoH + 1;
            const D = a2 / (Math.PI * f * f);
            const vis = 0.5 / (NoL * Math.sqrt(NoV * NoV * (1 - a2) + a2) + NoV * Math.sqrt(NoL * NoL * (1 - a2) + a2));
            return D * vis * NoL * dOmega;
        });
    }

    it('reads the tables the way they were fitted (x roughness, y view angle)', () => {
        // Seen head on, the inverse transform is diag(1, 1, z), z growing with roughness: a narrow lobe
        // pulls the polygon toward the pole, the roughest leaves it almost alone.
        const smooth = ltcLookup(0, 0.05, 1), rough = ltcLookup(0, 1, 1);
        expect(smooth[0]).toBeCloseTo(1, 2);
        expect(smooth[3]).toBeLessThan(0.05);
        expect(rough[3]).toBeGreaterThan(0.9);
        const t2 = ltcLookup(1, 0.5, 0.7);
        expect(t2[0]).toBeGreaterThan(0.5);
        expect(t2[0]).toBeLessThan(1.05);
    });

    it('matches a brute-force GGX integral over the panel for rough and glossy floors', () => {
        const N: V3 = [0, 1, 0];
        const P: V3 = [0, 0, 1.5];
        // The eye where the mirror direction meets the panel's centre (the highlight), then lower, where
        // the panel sits in the lobe's tail.
        for (const [eye, tolerance] of [[[0, 3, 3], 0.12], [[0, 1.6, 5], 0.3]] as [V3, number][]) {
            const V = normalize([eye[0] - P[0], eye[1] - P[1], eye[2] - P[2]]);
            for (const r of [0.2, 0.35, 0.6, 0.9]) {
                const brute = ggxBrute(panel(), P, N, V, r);
                const ltc = ltcSpecular(panel(), P, N, V, r, 1);
                if (process.env.LTC_PEEK) console.log('LTCPEEK', eye.join(','), r, brute, ltc, ltc / brute);
                expect(brute).toBeGreaterThan(0);
                expect(Math.abs(ltc - brute) / brute).toBeLessThan(tolerance);
            }
        }
    });
});

describe('AreaLight photometry', () => {
    it('spreads its lumens over its face: L = lm / (pi A) one-sided, half that a side two-sided', () => {
        const a = new AreaLight({ unit: LIGHT_UNIT, intensity: 3000, width: 2, height: 0.5 });
        expect(a.area).toBeCloseTo(1);
        expect(a.internalRadiance * REFERENCE_ILLUMINANCE).toBeCloseTo(3000 / Math.PI, 6);
        a.twoSided = true;
        expect(a.internalRadiance * REFERENCE_ILLUMINANCE).toBeCloseTo(3000 / (2 * Math.PI), 6);
        const disk = new AreaLight({ unit: LIGHT_UNIT, intensity: 1000, shape: 'disk', width: 0.2 });
        expect(disk.area).toBeCloseTo(Math.PI * 0.01);
        expect(disk.height).toBe(0.2);
    });

    it('is, far away, the light its record says: one-sided on-axis lm / pi, two-sided a point of the same lumens', () => {
        const one = new AreaLight({ unit: LIGHT_UNIT, intensity: 3000, width: 1, height: 1 });
        // Far field on the axis: E = L x A / d^2 = (lm / pi A) A / d^2 = (lm / pi) / d^2.
        const d = 40;
        const e: AreaEmitter = { ...panel(), halfWidth: 0.5, halfHeight: 0.5, center: [0, d, 0] };
        const N: V3 = [0, 1, 0];
        const E = one.internalRadiance * Math.PI * ltcIntegrate(e, [0, 0, 0], ltcFrame(N, N), IDENTITY3);
        expect(E / (one.internalIntensity / (d * d))).toBeCloseTo(1, 2);
        const two = new AreaLight({ unit: LIGHT_UNIT, intensity: 3000, width: 1, height: 1, twoSided: true });
        const point = new PointLight({ unit: LIGHT_UNIT, intensity: 3000 });
        expect(two.internalIntensity).toBeCloseTo(point.internalIntensity, 10);
        expect(two.sourceRadius).toBeCloseTo(Math.sqrt(1 / Math.PI));
    });

    it('keeps a sane size and resets to a ceiling panel', () => {
        const a = new AreaLight({ unit: LIGHT_UNIT, width: -3, height: NaN });
        expect(a.width).toBeGreaterThan(0);
        expect(a.height).toBeGreaterThan(0);
        a.width = 0.001;
        expect(a.width).toBe(0.01);
        a.sourceRadius = 5;   // ignored: an area light's size is its shape's
        expect(a.sourceRadius).toBeCloseTo(a.equivalentRadius);
        a.resetToPhysicalDefaults();
        expect(a.shape).toBe('rect');
        expect(a.twoSided).toBe(false);
    });
});

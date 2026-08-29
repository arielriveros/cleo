import { describe, it, expect } from 'vitest';

/**
 * The multi-scatter energy compensation, in JS, so its shape can be asserted without a GPU.
 *
 * This is a deliberate port of `EnvBRDFApprox` / `energyCompensation` from
 * `src/graphics/shaders/wgsl/chunks/pbrLighting.wgsl`. It exists for ONE reason: the denominator is the
 * single easiest thing in the whole BRDF to get wrong, and getting it wrong is invisible in code review.
 *
 * Filament's documentation gives `energyCompensation = 1.0 + f0 * (1.0 / dfg.y - 1.0)`. Copying that
 * line verbatim would have been a disaster here, because Filament's `dfg.y` is a dedicated channel
 * holding the white-furnace directional albedo `integral(D * V * NoL)`, while this engine's DFG — both
 * the baked LUT in `brdf.wgsl` and Karis' analytic fit — is the Schlick SPLIT-SUM pair, where the same
 * quantity is `A + B`. The tests below are what make that difference visible: with `A + B` the
 * compensation is a well-behaved 1.0 to 2.22; with `B` alone it reaches four times ten to the seventh.
 */

/** Karis, "Physically Based Shading on Mobile" (UE4). Returns (A, B) with `Fr = f0 * A + B`. */
function envBRDFApprox(NoV: number, roughness: number): [number, number] {
    const c0 = [-1, -0.0275, -0.572, 0.022];
    const c1 = [1, 0.0425, 1.04, -0.04];
    const r = c0.map((c, i) => roughness * c + c1[i]);
    const a004 = Math.min(r[0] * r[0], Math.pow(2, -9.28 * NoV)) * r[0] + r[1];
    return [-1.04 * a004 + r[2], 1.04 * a004 + r[3]];
}

function energyCompensation(f0: number, NoV: number, roughness: number): number {
    const [A, B] = envBRDFApprox(NoV, roughness);
    return 1 + f0 * (1 / Math.max(A + B, 1e-4) - 1);
}

/** The single-scatter directional albedo of a WHITE microfacet surface — substitute f0 = 1. */
const singleScatterAlbedo = (NoV: number, roughness: number) =>
    envBRDFApprox(NoV, roughness).reduce((a, b) => a + b, 0);

/** A sweep over the whole domain a shader can hand these functions. */
function* domain() {
    for (let ri = 0; ri <= 20; ri++)
        for (let vi = 1; vi <= 20; vi++)
            yield { roughness: ri / 20, NoV: vi / 20 };
}

describe('the split-sum DFG fit', () => {
    it('is exactly 1 at roughness 0 — a mirror loses no energy', () => {
        // The property that makes this safe to apply unconditionally: smooth surfaces are untouched,
        // so nothing that already looked right changes.
        for (const NoV of [0.05, 0.25, 0.5, 0.75, 1.0])
            expect(singleScatterAlbedo(NoV, 0)).toBeCloseTo(1.0, 6);
    });

    it('never goes non-positive, so the reciprocal is always finite', () => {
        let min = Infinity;
        for (const { roughness, NoV } of domain())
            min = Math.min(min, singleScatterAlbedo(NoV, roughness));
        expect(min).toBeGreaterThan(0.4);
        expect(min).toBeCloseTo(0.45, 2);
    });

    it('loses more energy as roughness rises', () => {
        // Monotonic at fixed NoV: the whole physical claim in one assertion.
        for (const NoV of [0.2, 0.6, 1.0]) {
            let previous = Infinity;
            for (let ri = 0; ri <= 20; ri++) {
                const albedo = singleScatterAlbedo(NoV, ri / 20);
                expect(albedo).toBeLessThanOrEqual(previous + 1e-9);
                previous = albedo;
            }
        }
    });
});

describe('energy compensation', () => {
    it('leaves a smooth surface alone', () => {
        expect(energyCompensation(0.04, 1.0, 0)).toBeCloseTo(1.0, 6);
        expect(energyCompensation(1.0, 1.0, 0)).toBeCloseTo(1.0, 6);
    });

    it('recovers what a rough conductor throws away', () => {
        // A fully rough metal keeps 45% of its energy under a single-scatter GGX lobe. This is the
        // number the whole change exists for: it is why rough metals read dull and dead without it.
        expect(energyCompensation(1.0, 1.0, 1.0)).toBeCloseTo(2.222, 2);
    });

    it('barely touches dielectrics', () => {
        // f0 = 0.04 is every non-metal. At most a 5% lift, which is the correct magnitude — the lost
        // energy is proportional to how much is reflected specularly in the first place.
        for (const { roughness, NoV } of domain()) {
            const c = energyCompensation(0.04, NoV, roughness);
            expect(c).toBeGreaterThanOrEqual(1.0);
            expect(c).toBeLessThan(1.06);
        }
    });

    it('is bounded everywhere, for every f0', () => {
        for (const f0 of [0.02, 0.04, 0.2, 0.5, 1.0])
            for (const { roughness, NoV } of domain()) {
                const c = energyCompensation(f0, NoV, roughness);
                expect(Number.isFinite(c)).toBe(true);
                expect(c).toBeGreaterThanOrEqual(1.0);
                expect(c).toBeLessThanOrEqual(2.23);
            }
    });

    it('would explode if the denominator were the bias term alone', () => {
        // The regression guard, stated as the bug it prevents. If someone "fixes" this to match
        // Filament's documented line without also changing what the LUT stores, this is what happens.
        const [, B] = envBRDFApprox(1.0, 1.0);
        const wrong = 1 + 1.0 * (1 / Math.max(B, 1e-9) - 1);
        expect(wrong).toBeGreaterThan(1e6);
        expect(energyCompensation(1.0, 1.0, 1.0)).toBeLessThan(2.23);
    });
});

// ---------------------------------------------------------------------------------------------
// Area lights (phase 3): the representative point, ported from `sphereLightSample` /
// `discLightSample` / `areaNormalization` in chunks/pbrLighting.wgsl.
// ---------------------------------------------------------------------------------------------

const dot3 = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len3 = (a: number[]) => Math.sqrt(dot3(a, a));
const norm3 = (a: number[]) => { const l = len3(a); return [a[0] / l, a[1] / l, a[2] / l]; };

/** `(alpha / saturate(alpha + halfAngle))^2` — the energy correction for a source with size. */
function areaNormalization(alpha: number, halfAngle: number): number {
    const alphaPrime = Math.min(1, Math.max(0, alpha + halfAngle));
    const ratio = alpha / Math.max(alphaPrime, 1e-6);
    return ratio * ratio;
}

/** The reflection ray clamped into a cone of half-angle `angularRadius` around `lightDir`. */
function discDirection(lightDir: number[], angularRadius: number, reflected: number[]): number[] {
    if (angularRadius <= 0) return lightDir;
    const cosAngle = Math.cos(angularRadius);
    const LoR = dot3(lightDir, reflected);
    if (LoR >= cosAngle) return reflected;
    const perp = [reflected[0] - LoR * lightDir[0], reflected[1] - LoR * lightDir[1],
                  reflected[2] - LoR * lightDir[2]];
    const l = len3(perp);
    if (l <= 1e-6) return lightDir;
    const s = Math.sin(angularRadius);
    return [lightDir[0] * cosAngle + (perp[0] / l) * s,
            lightDir[1] * cosAngle + (perp[1] / l) * s,
            lightDir[2] * cosAngle + (perp[2] / l) * s];
}

/**
 * Specular ambient occlusion (Lagarde), ported from `computeSpecularAO` in chunks/pbrLighting.wgsl.
 *
 * An AO map answers 'how much of the HEMISPHERE is blocked', which is the right question for a diffuse
 * lobe and the wrong one for a narrow specular cone. This is the correction, and the assertions below
 * are its two end points: at roughness 1 the specular lobe IS the hemisphere so it must agree with the
 * diffuse AO exactly, and as roughness falls it must relax toward 1 so a mirror keeps its reflection.
 */
function computeSpecularAO(NoV: number, ao: number, roughness: number): number {
    return Math.min(1, Math.max(0, Math.pow(NoV + ao, Math.pow(2, -16 * roughness - 1)) - 1 + ao));
}

describe('specular occlusion', () => {
    it('agrees with the diffuse AO when the lobe is the whole hemisphere', () => {
        // roughness 1: there is no narrow cone to be less occluded than the hemisphere.
        for (const ao of [0.0, 0.25, 0.5, 0.75, 1.0])
            expect(computeSpecularAO(1.0, ao, 1.0)).toBeCloseTo(ao, 2);
    });

    it('relaxes toward unoccluded as the surface gets smoother', () => {
        // The point of the whole term: a polished floor in a corner keeps its reflection of the room,
        // because the direction it reflects is not the direction the AO says is blocked.
        const ao = 0.3;
        let previous = -Infinity;
        for (const roughness of [1.0, 0.75, 0.5, 0.25, 0.1, 0.045]) {
            const s = computeSpecularAO(1.0, ao, roughness);
            expect(s).toBeGreaterThanOrEqual(previous - 1e-6);
            previous = s;
        }
        expect(computeSpecularAO(1.0, ao, 0.045)).toBeGreaterThan(computeSpecularAO(1.0, ao, 1.0));
    });

    it('never invents light and never goes negative', () => {
        for (const NoV of [0.05, 0.3, 0.7, 1.0])
            for (const ao of [0, 0.2, 0.5, 0.8, 1])
                for (const roughness of [0.045, 0.2, 0.5, 1.0]) {
                    const s = computeSpecularAO(NoV, ao, roughness);
                    expect(s).toBeGreaterThanOrEqual(0);
                    expect(s).toBeLessThanOrEqual(1);
                }
    });

    it('leaves a fully unoccluded surface completely alone', () => {
        for (const NoV of [0.05, 0.5, 1.0])
            for (const roughness of [0.045, 0.5, 1.0])
                expect(computeSpecularAO(NoV, 1.0, roughness)).toBeCloseTo(1, 6);
    });
});
describe('area lights — the energy correction', () => {
    it('is exactly 1 for a source with no size', () => {
        // The property the whole phase rests on: a zero-radius light must be bit-identical to what the
        // renderer did before it, or every existing scene shifts for nothing.
        for (const roughness of [0.045, 0.1, 0.5, 1.0])
            expect(areaNormalization(roughness * roughness, 0)).toBe(1);
    });

    it('reproduces the measured widening table', () => {
        // These are the numbers the phase was justified with, so they are the numbers pinned. A 5 cm
        // bulb at 2 m, then the real sun, both against a polished surface and a rough one.
        const bulb = 0.05 / (2 * 2);
        const sun = 0.00465 / 2;
        const widen = (r: number, h: number) => Math.min(1, r * r + h) / (r * r);

        expect(widen(0.045, bulb)).toBeCloseTo(7.17, 1);
        expect(areaNormalization(0.045 ** 2, bulb)).toBeCloseTo(0.019, 3);
        expect(widen(0.3, bulb)).toBeCloseTo(1.14, 2);      // rough: almost nothing

        expect(widen(0.045, sun)).toBeCloseTo(2.15, 1);
        expect(areaNormalization(0.045 ** 2, sun)).toBeCloseTo(0.217, 3);
        expect(widen(0.6, sun)).toBeCloseTo(1.01, 2);
    });

    it('only ever dims — a bigger light is a softer one, not a brighter one', () => {
        for (const roughness of [0.045, 0.2, 0.5, 1.0])
            for (const half of [0, 0.001, 0.01, 0.1, 0.5, 2.0]) {
                const n = areaNormalization(roughness * roughness, half);
                expect(n).toBeGreaterThan(0);
                expect(n).toBeLessThanOrEqual(1);
            }
    });
});

describe('area lights — the sun disc', () => {
    const L = [0, 0, 1];

    it('leaves the reflection ray alone when it already hits the disc', () => {
        // A mirror pointed at the sun shows the sun, not a clamped approximation of it.
        const r = norm3([0.001, 0, 1]);       // ~0.001 rad off axis, inside a 0.00465 cone
        expect(discDirection(L, 0.00465, r)).toEqual(r);
    });

    it('clamps a missing ray onto the rim, at exactly the angular radius', () => {
        const angularRadius = 0.05;
        const r = norm3([Math.sin(0.4), 0, Math.cos(0.4)]);   // 0.4 rad off axis — well outside
        const d = discDirection(L, angularRadius, r);

        expect(len3(d)).toBeCloseTo(1, 6);                        // still a direction
        expect(Math.acos(dot3(d, L))).toBeCloseTo(angularRadius, 6);   // on the rim
        // and it is the CLOSEST point on the rim: still in the plane of L and r, same side.
        expect(d[1]).toBeCloseTo(0, 6);
        expect(d[0]).toBeGreaterThan(0);
    });

    it('is inert at zero, which is what the renderer writes when there is no sun', () => {
        const r = norm3([1, 2, 3]);
        expect(discDirection(L, 0, r)).toEqual(L);
    });

    it('never leaves the cone, for any ray direction', () => {
        const angularRadius = 0.02;
        for (let i = 0; i < 64; i++) {
            const t = (i / 64) * Math.PI * 2;
            const r = norm3([Math.cos(t), Math.sin(t) * 0.5, Math.cos(t * 0.37)]);
            const angle = Math.acos(Math.min(1, Math.max(-1, dot3(discDirection(L, angularRadius, r), L))));
            expect(angle).toBeLessThanOrEqual(angularRadius + 1e-6);
        }
    });
});


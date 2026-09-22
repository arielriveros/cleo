import { describe, it, expect } from 'vitest';
import {
    MAX_TERRAIN_SURFACES, defaultBlendRule, parseBlendRule, cloneBlendRule, rangeCoverage, smoothstep,
    slopeDegreesFromNormalY, transitionShift, hash12, valueNoise, ruleNoise, surfaceAlpha, compositeWeights,
    legacyAutoRule, legacySplatAlphas, legacySplatToMasks, flattenSurfaces, surfaceWeightsAt, deriveSurface,
    type TerrainLayerSource, type TerrainSlotSource,
} from '../src/terrain/terrainLayers';

const slot = (rule = defaultBlendRule(), allowFoliage = true): TerrainSlotSource => ({
    surface: deriveSurface({ type: 'basic', properties: new Map(), textures: new Map() }, 20),
    rule, allowFoliage,
});

describe('rule ranges', () => {
    it('cover fully inside min..max and fade to zero across the falloff outside', () => {
        const r = { enabled: true, min: 10, max: 20, falloff: 4 };
        expect(rangeCoverage(r, 15)).toBe(1);
        expect(rangeCoverage(r, 10)).toBe(1);
        expect(rangeCoverage(r, 20)).toBe(1);
        expect(rangeCoverage(r, 6)).toBe(0);
        expect(rangeCoverage(r, 24)).toBe(0);
        expect(rangeCoverage(r, 8)).toBeCloseTo(0.5, 6);
        expect(rangeCoverage(r, 22)).toBeCloseTo(0.5, 6);
    });

    it('step hard when the falloff is zero', () => {
        const r = { enabled: true, min: 0, max: 1, falloff: 0 };
        expect(rangeCoverage(r, -1e-3)).toBe(0);
        expect(rangeCoverage(r, 0)).toBe(1);
        expect(rangeCoverage(r, 1)).toBe(1);
        expect(rangeCoverage(r, 1 + 1e-3)).toBe(0);
    });

    it('pass everywhere when disabled', () => {
        expect(rangeCoverage({ enabled: false, min: 5, max: 6, falloff: 0 }, 1000)).toBe(1);
    });

    it('slope is measured in degrees from straight up, undersides clamping to vertical', () => {
        expect(slopeDegreesFromNormalY(1)).toBe(0);
        expect(slopeDegreesFromNormalY(0)).toBeCloseTo(90, 9);
        expect(slopeDegreesFromNormalY(Math.cos(Math.PI / 4))).toBeCloseTo(45, 9);
        expect(slopeDegreesFromNormalY(-1)).toBeCloseTo(90, 9);
    });

    it('smoothstep has WGSL semantics', () => {
        expect(smoothstep(0, 1, 0.5)).toBe(0.5);
        expect(smoothstep(0, 1, -1)).toBe(0);
        expect(smoothstep(0, 1, 2)).toBe(1);
    });
});

describe('transition shift (noise and height blend)', () => {
    it('is the identity at strength 0 and never touches a fully in or fully out fragment', () => {
        for (const a of [0, 0.2, 0.5, 0.9, 1]) expect(transitionShift(a, 1, 0)).toBe(a);
        for (const t of [-1, -0.3, 0.4, 1]) {
            expect(transitionShift(0, t, 1)).toBe(0);
            expect(transitionShift(1, t, 1)).toBe(1);
        }
    });

    it('can move a mid transition all the way to either end', () => {
        expect(transitionShift(0.5, 1, 1)).toBe(1);
        expect(transitionShift(0.5, -1, 1)).toBe(0);
    });
});

describe('noise', () => {
    it('is deterministic and stays in 0..1', () => {
        for (let i = 0; i < 200; i++) {
            const x = i * 3.7 - 91, z = i * -1.3 + 40;
            const h = hash12(x, z);
            expect(h).toBeGreaterThanOrEqual(0);
            expect(h).toBeLessThan(1);
            expect(hash12(x, z)).toBe(h);
            const v = valueNoise(x * 0.37, z * 0.21);
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
        }
    });

    it('is continuous: value noise agrees with the hash at lattice points', () => {
        expect(valueNoise(3, -7)).toBeCloseTo(hash12(3, -7), 6);
    });

    it('seed decorrelates two rules with the same scale', () => {
        const a = { amount: 1, scale: 5, seed: 0 }, b = { amount: 1, scale: 5, seed: 3 };
        let same = 0;
        for (let i = 0; i < 50; i++) if (Math.abs(ruleNoise(a, i * 1.9, i * 0.7) - ruleNoise(b, i * 1.9, i * 0.7)) < 1e-6) same++;
        expect(same).toBeLessThan(5);
    });
});

describe('surface alpha', () => {
    it('is mask x elevation x slope x opacity with no noise or height blend', () => {
        const rule = defaultBlendRule();
        rule.elevation = { enabled: true, min: 100, max: 200, falloff: 0 };
        rule.slope = { enabled: true, min: 30, max: 90, falloff: 0 };
        rule.opacity = 0.5;
        expect(surfaceAlpha(rule, 1, 150, 45, 0.5)).toBe(0.5);
        expect(surfaceAlpha(rule, 0.4, 150, 45, 0.5)).toBeCloseTo(0.2, 9);
        expect(surfaceAlpha(rule, 1, 50, 45, 0.5)).toBe(0);
        expect(surfaceAlpha(rule, 1, 150, 10, 0.5)).toBe(0);
    });

    it('a mid-grey height map or neutral noise leaves the transition alone', () => {
        const rule = defaultBlendRule();
        rule.heightBlend = 1; rule.noise.amount = 1;
        expect(surfaceAlpha(rule, 0.3, 0, 0, 0.5, 0.5)).toBeCloseTo(0.3, 9);
    });
});

describe('over compositing', () => {
    it('distributes weight top-down and leaves nothing uncovered over a full base', () => {
        const out: number[] = [];
        const rem = compositeWeights([1, 0.5, 0.5], out);
        expect(rem).toBe(0);
        expect(out[2]).toBe(0.5);
        expect(out[1]).toBe(0.25);
        expect(out[0]).toBe(0.25);
        expect(out[0] + out[1] + out[2]).toBe(1);
    });

    it('reports the uncovered remainder when nothing covers', () => {
        const out: number[] = [];
        expect(compositeWeights([0.25, 0], out)).toBe(0.75);
    });
});

describe('legacy splat migration', () => {
    it('reproduces the normalized weights EXACTLY once composited over the base', () => {
        const cases = [
            [255, 0, 0, 0], [0, 255, 0, 0], [0, 0, 0, 255], [128, 64, 32, 31],
            [10, 20, 30, 195], [85, 85, 85, 0], [0, 0, 128, 127], [1, 1, 1, 252],
        ];
        const a = [0, 0, 0];
        const out: number[] = [];
        for (const w of cases) {
            legacySplatAlphas(w[0], w[1], w[2], w[3], a);
            compositeWeights([1, a[0], a[1], a[2]], out);
            const sum = w[0] + w[1] + w[2] + w[3];
            for (let k = 0; k < 4; k++) expect(out[k]).toBeCloseTo(w[k] / sum, 9);
        }
    });

    it('an all-zero texel shows only the base', () => {
        const a = [9, 9, 9];
        legacySplatAlphas(0, 0, 0, 0, a);
        expect(a).toEqual([0, 0, 0]);
    });

    it('converts a whole splat to masks in channels 0..2, within byte rounding', () => {
        const splat = new Uint8Array([255, 0, 0, 0, 0, 255, 0, 0, 64, 64, 64, 63]);
        const m = legacySplatToMasks(splat, 3);
        expect(Array.from(m.subarray(0, 4))).toEqual([0, 0, 0, 0]);
        expect(Array.from(m.subarray(4, 8))).toEqual([255, 0, 0, 0]);
        // Layer 3 at 63/255, layer 2 at 64/(255-63), layer 1 at 64/(255-63-64).
        expect(m[8 + 2]).toBe(63);
        expect(m[8 + 1]).toBe(Math.round((64 / 192) * 255));
        expect(m[8 + 0]).toBe(Math.round((64 / 128) * 255));
        expect(m[8 + 3]).toBe(0);
    });
});

describe('legacy auto rule', () => {
    it('is the default open rule when auto was off', () => {
        const r = legacyAutoRule(false, [3, 4], [0.2, 0.3]);
        expect(r.elevation.enabled).toBe(false);
        expect(r.slope.enabled).toBe(false);
    });

    it('reproduces the old elevation band exactly, relative to the origin', () => {
        const r = legacyAutoRule(true, [10, 50], [0, 1], 4);
        // old: smoothstep(8, 12, y) * (1 - smoothstep(48, 52, y)) in WORLD y
        for (const y of [6, 8, 9, 10, 12, 30, 48, 50, 51, 53]) {
            const old = smoothstep(8, 12, y) * (1 - smoothstep(48, 52, y));
            expect(rangeCoverage(r.elevation, y - 4)).toBeCloseTo(old, 9);
        }
    });

    it('keeps an open-ended slope range open', () => {
        const r = legacyAutoRule(true, [0, 100], [0, 1]);
        expect(rangeCoverage(r.slope, 0)).toBe(1);
        expect(rangeCoverage(r.slope, 90)).toBe(1);
    });
});

describe('parsing', () => {
    it('fills anything missing with defaults and clamps the unit ranges', () => {
        const r = parseBlendRule({ slope: { enabled: true, min: 35 }, opacity: 4, noise: { scale: 0 } });
        expect(r.slope.enabled).toBe(true);
        expect(r.slope.min).toBe(35);
        expect(r.slope.max).toBe(defaultBlendRule().slope.max);
        expect(r.opacity).toBe(1);
        expect(r.noise.scale).toBeGreaterThan(0);
        expect(parseBlendRule(null)).toEqual(defaultBlendRule());
    });

    it('round-trips through JSON', () => {
        const r = defaultBlendRule();
        r.elevation = { enabled: true, min: 120, max: 400, falloff: 12 };
        r.noise = { amount: 0.6, scale: 14, seed: 2 };
        expect(parseBlendRule(JSON.parse(JSON.stringify(cloneBlendRule(r))))).toEqual(r);
    });
});

describe('flattening the stack', () => {
    it('orders base slots first, marks only the base slot 0 as a fill, and multiplies layer opacity in', () => {
        const layers: TerrainLayerSource[] = [
            { slots: [slot(), slot()], mask: -1, visible: true, opacity: 1 },
            { slots: [slot()], mask: 0, visible: true, opacity: 0.5 },
        ];
        const { surfaces } = flattenSurfaces(layers);
        expect(surfaces.map(s => [s.layer, s.slot, s.mask, s.fill])).toEqual([
            [0, 0, -1, true], [0, 1, -1, false], [1, 0, 0, false],
        ]);
        expect(surfaces[2].rule.opacity).toBe(0.5);
    });

    it('skips hidden layers and caps at MAX_TERRAIN_SURFACES keeping the bottom', () => {
        const many: TerrainLayerSource[] = [{ slots: [slot()], mask: -1, visible: true, opacity: 1 }];
        for (let i = 0; i < 20; i++) many.push({ slots: [slot()], mask: i, visible: i !== 3, opacity: 1 });
        const { surfaces, truncated } = flattenSurfaces(many);
        expect(surfaces.length).toBe(MAX_TERRAIN_SURFACES);
        expect(truncated).toBe(true);
        expect(surfaces[0].fill).toBe(true);
        expect(surfaces.some(s => s.mask === 3)).toBe(false);
    });
});

describe('surface weights (the CPU twin of the shader)', () => {
    it('a painted road over a slope-ruled base resolves to the expected weights', () => {
        const rock = defaultBlendRule();
        rock.slope = { enabled: true, min: 35, max: 90, falloff: 0 };
        const layers: TerrainLayerSource[] = [
            { slots: [slot(), slot(rock)], mask: -1, visible: true, opacity: 1 }, // grass + rock on steep
            { slots: [slot()], mask: 0, visible: true, opacity: 1 },              // painted road
        ];
        const { surfaces } = flattenSurfaces(layers);
        const out: number[] = [];

        // Flat, unpainted: grass.
        expect(surfaceWeightsAt(surfaces, () => 0, 0, 5, 0, 0, out)).toBe(0);
        expect(out).toEqual([1, 0, 0]);
        // Steep, unpainted: rock.
        surfaceWeightsAt(surfaces, () => 0, 0, 50, 0, 0, out);
        expect(out).toEqual([0, 1, 0]);
        // Steep, road painted at 60%: the road takes 60% and the rock under it the rest.
        surfaceWeightsAt(surfaces, () => 0.6, 0, 50, 0, 0, out);
        expect(out[2]).toBeCloseTo(0.6, 9);
        expect(out[1]).toBeCloseTo(0.4, 9);
        expect(out[0]).toBe(0);
    });
});

import { describe, it, expect } from 'vitest';
import {
    DirectionalLight, PointLight, Spotlight,
    LIGHT_UNIT, REFERENCE_ILLUMINANCE, DEFAULT_LUMENS, DEFAULT_RANGE, DEFAULT_SOURCE_RADIUS,
    legacyRange, distanceAttenuation, legacyAmbientFromSceneJson,
} from '../src/graphics/lighting';
import { spotShadowFar } from '../src/graphics/shadowMath';

/**
 * Lights moved from the Phong-era `diffuse`/`specular`/`ambient` + `constant`/`linear`/`quadratic`
 * model to photometric intensity with a windowed inverse-square falloff. Every project in existence
 * carries the old form, so the conversion is not optional and it is not allowed to change the picture.
 *
 * The model is `migrateFoliageRule` (graphics/material.ts): engine-side, gated on a UNIT MARKER rather
 * than a version integer, so idempotency is structural. It runs in the light CONSTRUCTORS, which is
 * what makes one hook cover saved scenes, published games, the shipped examples, the editor's preview
 * scenes and the harness pages — all of which reach a light exactly one way.
 */

/** The old attenuation, so the fit can be checked against the thing it is fitting. */
const legacyAtt = (c: number, l: number, q: number, d: number) => 1 / (c + l * d + q * d * d);

describe('light migration — directional', () => {
    it('converts colour magnitude to illuminance exactly', () => {
        const light = new DirectionalLight({ diffuse: [1, 1, 1] });
        // The anchor: a legacy white sun is REFERENCE_ILLUMINANCE lux, and its internal intensity is
        // therefore exactly 1 — which is what the old shader received as `diffuse`. That equality is
        // the reason a directional-only scene is pixel-identical across this change.
        expect(light.intensity).toBeCloseTo(REFERENCE_ILLUMINANCE, 6);
        expect(light.internalIntensity).toBeCloseTo(1, 12);
        expect(Array.from(light.color)).toEqual([1, 1, 1]);
    });

    it('splits a tinted colour by its MAX channel, not its luminance', () => {
        // Luminance would give components above 1, which the editor's hex colour input can neither
        // display nor round-trip.
        const light = new DirectionalLight({ diffuse: [1, 0.55, 0.2] });
        expect(Math.max(...Array.from(light.color))).toBeCloseTo(1, 12);
        for (const c of light.color) expect(c).toBeLessThanOrEqual(1);
        expect(light.intensity).toBeCloseTo(REFERENCE_ILLUMINANCE, 6);
    });

    it('reproduces the old shader input for any legacy colour', () => {
        for (const diffuse of [[1, 1, 1], [0.5, 0.5, 0.5], [1, 0.8, 0.6], [2, 2, 2]] as [number, number, number][]) {
            const light = new DirectionalLight({ diffuse });
            for (let i = 0; i < 3; i++)
                // 6 places, not more: a colour is stored in a Float32Array, exactly as it was
                // before, so f32 rounding is carried across the change rather than introduced by it.
                expect(light.color[i] * light.internalIntensity).toBeCloseTo(diffuse[i], 6);
        }
    });
});

describe('light migration — point and spot', () => {
    const C = 1, L = 0.09, Q = 0.032;   // the legacy PointLight defaults

    it('takes the range from where the old curve reaches 1/256', () => {
        const light = new PointLight({ diffuse: [1, 1, 1], constant: C, linear: L, quadratic: Q });
        expect(light.range).toBeCloseTo(legacyRange(C, L, Q), 10);
        expect(legacyAtt(C, L, Q, light.range)).toBeCloseTo(1 / 256, 8);
    });

    it('matches the old brightness at the HALF-BRIGHTNESS distance', () => {
        const light = new PointLight({ diffuse: [1, 1, 1], constant: C, linear: L, quadratic: Q });
        // Where the old curve is exactly 0.5.
        const dHalf = 4.3581;
        expect(legacyAtt(C, L, Q, dHalf)).toBeCloseTo(0.5, 3);

        const before = 1.0 * legacyAtt(C, L, Q, dHalf);
        const after = light.color[0] * light.internalIntensity * distanceAttenuation(dHalf, light.range);
        expect(after / before).toBeCloseTo(1, 2);
    });

    it('produces a megalumen number for legacy content, and says so', () => {
        // NOT a bug in the fit. Legacy content asserts a lamp is as bright at 1 m as the sun, because
        // the sun was `diffuse = 1` and so was the lamp. Pinned here so nobody "fixes" it quietly.
        const light = new PointLight({ diffuse: [1, 1, 1], constant: C, linear: L, quadratic: Q });
        expect(light.intensity).toBeGreaterThan(1e6);
        expect(light.legacyFalloff).toBe(true);
    });

    it('resets a migrated light to authored defaults on request', () => {
        const light = new PointLight({ diffuse: [1, 1, 1], constant: C, linear: L, quadratic: Q });
        light.resetToPhysicalDefaults();
        expect(light.intensity).toBe(DEFAULT_LUMENS);
        expect(light.range).toBe(DEFAULT_RANGE);
        expect(light.sourceRadius).toBe(DEFAULT_SOURCE_RADIUS);
        expect(light.legacyFalloff).toBe(false);
    });

    it('agrees with the shadow far plane a migrated spot gets', () => {
        // Two copies of the 1/256 solve would let a migrated spot's shadow frustum end somewhere other
        // than its light, and a shadow clipped partway down a cone does not look like a units bug.
        const light = new Spotlight({ diffuse: [1, 1, 1], constant: C, linear: L, quadratic: Q });
        expect(spotShadowFar(light.range, 1e9)).toBeCloseTo(light.range, 10);
    });

    it('solves the cone into the scale/offset the shader wants', () => {
        const light = new Spotlight({ unit: LIGHT_UNIT, cutOff: 30, outerCutOff: 40 });
        const [scale, offset] = light.coneScaleOffset;
        const at = (deg: number) => Math.min(1, Math.max(0, Math.cos(deg * Math.PI / 180) * scale + offset));
        expect(at(20)).toBeCloseTo(1, 6);    // inside the inner cone
        expect(at(30)).toBeCloseTo(1, 6);    // exactly the inner edge
        expect(at(40)).toBeCloseTo(0, 6);    // exactly the outer edge
        expect(at(50)).toBeCloseTo(0, 6);    // outside
    });

    it('does not divide by zero when the two cone angles are equal', () => {
        const [scale, offset] = new Spotlight({ unit: LIGHT_UNIT, cutOff: 35, outerCutOff: 35 }).coneScaleOffset;
        expect(Number.isFinite(scale)).toBe(true);
        expect(Number.isFinite(offset)).toBe(true);
    });
});

describe('light migration — idempotency and zero', () => {
    it('leaves an already-photometric payload alone, however many round trips', () => {
        let payload: any = { unit: LIGHT_UNIT, color: [1, 0.5, 0.25], intensity: 900, range: 7,
                             sourceRadius: 0.2 };
        for (let pass = 0; pass < 3; pass++) {
            const light = new PointLight(payload);
            expect(light.intensity).toBe(900);
            expect(light.range).toBe(7);
            expect(light.sourceRadius).toBe(0.2);
            expect(Array.from(light.color)).toEqual([1, 0.5, 0.25]);
            payload = { unit: LIGHT_UNIT, color: Array.from(light.color), intensity: light.intensity,
                        range: light.range, sourceRadius: light.sourceRadius };
        }
    });

    it('keeps a switched-off light switched off', () => {
        // The `||` -> `??` fix. Under the old colour-as-brightness model a zero could not be expressed
        // at all, so this only became a real bug the moment intensity became a number.
        expect(new PointLight({ unit: LIGHT_UNIT, intensity: 0 }).intensity).toBe(0);
        expect(new DirectionalLight({ unit: LIGHT_UNIT, intensity: 0 }).intensity).toBe(0);
        expect(new Spotlight({ unit: LIGHT_UNIT, intensity: 0, cutOff: 0 }).cutOff).toBe(0);
    });

    it('gives a light with no payload at all the authored defaults', () => {
        const light = new PointLight({ unit: LIGHT_UNIT });
        expect(light.intensity).toBe(DEFAULT_LUMENS);
        expect(light.range).toBe(DEFAULT_RANGE);
        expect(light.legacyFalloff).toBe(false);
    });
});

describe('scene ambient recovered from a legacy save', () => {
    const legacyScene = (ambient: number[]) => ({
        scene: {
            name: 'root',
            children: [
                { name: 'a', children: [] },
                { name: 'sun', lightType: 'directional', light: { diffuse: [1, 1, 1], ambient }, children: [] },
            ],
        },
    });

    it('takes the fill from the directional light that used to carry it', () => {
        const found = legacyAmbientFromSceneJson(legacyScene([0.1, 0.12, 0.15]));
        expect(found).not.toBeNull();
        expect(found![0]).toBeCloseTo(0.1 * REFERENCE_ILLUMINANCE, 3);
        expect(found![2]).toBeCloseTo(0.15 * REFERENCE_ILLUMINANCE, 3);
    });

    it('ignores an already-migrated light', () => {
        const json = legacyScene([0.1, 0.1, 0.1]);
        (json.scene.children[1] as any).light.unit = LIGHT_UNIT;
        expect(legacyAmbientFromSceneJson(json)).toBeNull();
    });

    it('returns null when there is nothing to recover, rather than black', () => {
        expect(legacyAmbientFromSceneJson({ scene: { name: 'root', children: [] } })).toBeNull();
        expect(legacyAmbientFromSceneJson(undefined)).toBeNull();
    });
});

describe('the windowed falloff', () => {
    it('reaches exactly zero at the range and stays there', () => {
        expect(distanceAttenuation(10, 10)).toBe(0);
        expect(distanceAttenuation(20, 10)).toBe(0);
    });

    it('is inverse-square well inside the range', () => {
        // At a tenth of the range the window is 1 to within 1e-8, so this is `1/d^2` and nothing else.
        expect(distanceAttenuation(1, 100)).toBeCloseTo(1, 6);
        expect(distanceAttenuation(2, 100)).toBeCloseTo(0.25, 6);
        expect(distanceAttenuation(4, 100)).toBeCloseTo(0.0625, 6);
    });

    it('is monotonic', () => {
        let previous = Infinity;
        for (let d = 0.1; d < 10; d += 0.1) {
            const a = distanceAttenuation(d, 10);
            expect(a).toBeLessThanOrEqual(previous);
            previous = a;
        }
    });
});

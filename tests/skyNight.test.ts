import { describe, it, expect } from 'vitest';
import { keyLight, moonDirection, nightFactor } from '../src/graphics/skyNight';
import { SkyAtmosphereNode } from '../src/core/scene/nodes/skyAtmosphereNode';
import { VolumetricCloudsNode } from '../src/core/scene/nodes/volumetricCloudsNode';

const dirAt = (elevationDeg: number, azimuthDeg = 0): [number, number, number] => {
    const e = elevationDeg * Math.PI / 180, a = azimuthDeg * Math.PI / 180;
    return [Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)];
};
const MOON = { nightEnabled: true, moonEnabled: true, moonColor: [0.8, 0.9, 1], moonPhase: 1, moonlightIntensity: 0.1 };

describe('moon direction', () => {
    it('sits opposite the sun with no offset', () => {
        const sun = dirAt(-30, 40);
        const moon = moonDirection(sun, 0, 0);
        for (let i = 0; i < 3; i++) expect(moon[i]).toBeCloseTo(-sun[i], 5);
    });

    it('moves by the offset in elevation and azimuth, and stays a unit vector', () => {
        const moon = moonDirection(dirAt(-20, 0), 0, 10);
        expect(Math.asin(moon[1]) * 180 / Math.PI).toBeCloseTo(30, 4);
        const yawed = moonDirection(dirAt(-20, 0), 90, 0);
        expect(Math.hypot(...yawed)).toBeCloseTo(1, 6);
        expect(yawed[1]).toBeCloseTo(Math.sin(20 * Math.PI / 180), 5);
    });
});

describe('night factor', () => {
    it('is 0 by day, 1 deep in the night, and monotonic between', () => {
        expect(nightFactor(Math.sin(10 * Math.PI / 180))).toBe(0);
        expect(nightFactor(Math.sin(-12 * Math.PI / 180))).toBe(1);
        let last = -1;
        for (let e = 5; e >= -10; e -= 0.5) {
            const n = nightFactor(Math.sin(e * Math.PI / 180));
            expect(n).toBeGreaterThanOrEqual(last);
            last = n;
        }
    });
});

describe('key light', () => {
    it('is the authored sun by day', () => {
        const k = keyLight(dirAt(40), dirAt(-40), [1, 0.9, 0.8], 5, MOON);
        expect(k.isMoon).toBe(false);
        expect(k.intensity).toBeCloseTo(5);
        expect(k.dir[1]).toBeLessThan(0); // travels downward
    });

    it('becomes the moon at night, at the moonlight fraction, from the moon side', () => {
        const toMoon = dirAt(35, 180);
        const k = keyLight(dirAt(-20), toMoon, [1, 1, 1], 5, MOON);
        expect(k.isMoon).toBe(true);
        expect(k.intensity).toBeCloseTo(0.5);
        for (let i = 0; i < 3; i++) expect(k.dir[i]).toBeCloseTo(-toMoon[i], 6);
    });

    it('swaps sun for moon only while both are dark, so nothing pops', () => {
        let prev = keyLight(dirAt(10), dirAt(30, 180), [1, 1, 1], 5, MOON);
        for (let e = 10; e >= -12; e -= 0.05) {
            const k = keyLight(dirAt(e), dirAt(30, 180), [1, 1, 1], 5, MOON);
            if (k.isMoon !== prev.isMoon) {
                expect(prev.intensity).toBeLessThan(0.01);
                expect(k.intensity).toBeLessThan(0.01);
            }
            expect(Math.abs(k.intensity - prev.intensity)).toBeLessThan(0.2);
            prev = k;
        }
        expect(prev.isMoon).toBe(true);
    });

    it('stays dark at night with the moon off, new, or below the horizon', () => {
        expect(keyLight(dirAt(-20), dirAt(30), [1, 1, 1], 5, { ...MOON, moonEnabled: false }).intensity).toBe(0);
        expect(keyLight(dirAt(-20), dirAt(30), [1, 1, 1], 5, { ...MOON, moonPhase: 0 }).intensity).toBe(0);
        expect(keyLight(dirAt(-20), dirAt(-10), [1, 1, 1], 5, MOON).intensity).toBe(0);
    });
});

describe('night sky fields', () => {
    it('default on an old payload and round-trip through serialize', () => {
        const old = new SkyAtmosphereNode('sky', { sunIntensity: 20 });
        expect(old.nightEnabled).toBe(true);
        expect(old.moonPhase).toBe(1);
        expect(old.nightSkyTexture).toBeNull();

        const node = new SkyAtmosphereNode('sky', { moonPhase: 0.4, nightSkyTexture: 'stars', moonSize: 3 });
        const back = new SkyAtmosphereNode('sky', (node as any)._serializePayload().atmosphere);
        expect(back.moonPhase).toBeCloseTo(0.4);
        expect(back.nightSkyTexture).toBe('stars');
        expect(back.moonSize).toBe(3);
    });

    it('re-bakes the sky for night-sky edits, and for a moonlight change but not a rewrite of the same value', () => {
        const node = new SkyAtmosphereNode('sky');
        node.markBaked([0, 1, 0]);
        // The night sky's brightness follows the moonlight (u_nightScale), so a change re-bakes...
        node.moonlightIntensity = 0.2;
        expect(node.needsBake).toBe(true);
        // ...but a time-of-day script writing the same value every frame must not re-bake every frame.
        node.markBaked([0, 1, 0]);
        node.moonlightIntensity = 0.2;
        expect(node.needsBake).toBe(false);
        node.starIntensity = 2;
        expect(node.needsBake).toBe(true);
    });
});

describe('cloud sky bake staleness', () => {
    it('is never baked, then fresh, then stale on a sun move or a look change', () => {
        const node = new VolumetricCloudsNode('clouds', { bakeIntoSky: true });
        expect(node.bakeStaleness(dirAt(40))).toBe('never');
        node.markBaked(dirAt(40), 12);
        expect(node.bakeStaleness(dirAt(40))).toBe('none');
        expect(node.bakeStaleness(dirAt(40.2))).toBe('none');
        expect(node.bakeStaleness(dirAt(42))).toBe('sun');
        node.coverage = 0.9;
        expect(node.bakeStaleness(dirAt(40))).toBe('settings');
    });

    it('ignores the bake toggles themselves', () => {
        const node = new VolumetricCloudsNode('clouds');
        node.markBaked(dirAt(40), 0);
        node.previewBake = true;
        node.autoRebake = false;
        expect(node.bakeStaleness(dirAt(40))).toBe('none');
    });

    it('serializes the bake settings but not the bake', () => {
        const node = new VolumetricCloudsNode('clouds', { bakeIntoSky: true, bakeResolution: 1000 });
        node.markBaked(dirAt(40), 3);
        const back = new VolumetricCloudsNode('clouds', (node as any)._serializePayload().clouds);
        expect(back.bakeIntoSky).toBe(true);
        expect(back.bakeResolution).toBe(512);
        expect(back.bakedSunDir).toBeNull();
    });
});

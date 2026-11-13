import { describe, it, expect } from 'vitest';
import { buildDayCycle, dayLook, dayTracks, nightFactor, sunElevation, type DayAuthored } from '../tools/valley/cinematic/dayPath';
import { evaluateKeyedVector, evaluateKeyedNumber } from '../src/core/math';
import { parseSequence } from '../src/sequencer/parse';

// The Valley's day, keyed rather than scripted: the model that used to run every frame in a time-of-day
// script now writes keys on the sun and what follows it. The keys must reproduce the model, hold across the
// tour's jumps (behind its fades), and loop as a whole day in Free mode.

const AUTHORED: DayAuthored = {
    skyLight: 1, fog: { density: 0.0004, falloff: 0, opacity: 0.5 }, godRays: 0.18,
    fogVolumes: [{ slot: 'fogPondMist', name: 'Pond Mist', path: 'Fog Volumes/Pond Mist', density: 0.018 }],
};

const track = (tracks: any[], id: string) => tracks.find(t => t.id === id).sections[0].curve;

describe('the day model', () => {
    it('puts the sun high in the south at noon, under the horizon at midnight, warm and low at dawn', () => {
        expect(sunElevation(12)).toBeGreaterThan(50);
        expect(sunElevation(0)).toBeLessThan(-20);
        expect(nightFactor(12)).toBe(0);
        expect(nightFactor(0)).toBe(1);
        const noon = dayLook(12, 0, AUTHORED), dawn = dayLook(6.5, 0, AUTHORED);
        expect(noon.color[0] - noon.color[2]).toBeLessThan(dawn.color[0] - dawn.color[2]);
        // The night: the sky's fill falls, the fog volumes gather.
        const night = dayLook(1, 0, AUTHORED);
        expect(night.skyLight).toBeCloseTo(0.4, 3);
        expect(night.fogVolumes[0]).toBeCloseTo(0.018 * 3, 6);
        // Overcast greys the light and fades the god rays.
        expect(dayLook(12, 1, AUTHORED).godRays).toBeLessThan(noon.godRays);
    });
});

describe('dayTracks', () => {
    const hourKeys = { keys: [{ t: 0, v: 10, interp: 'constant' as const }, { t: 20, v: 13, interp: 'linear' as const }, { t: 50, v: 15, interp: 'constant' as const }, { t: 70, v: 21, interp: 'linear' as const }, { t: 100, v: 22 }] };
    const tracks = dayTracks({
        duration: 100, step: 1, authored: AUTHORED, breaks: [20, 50, 70],
        hourAt: t => evaluateKeyedNumber(hourKeys, t), overcastAt: () => 0,
    });

    it('keys the sun, the fill, the mist, the god rays and each fog volume, and parses whole', () => {
        expect(tracks.map(t => `${(t as any).slot}.${(t as any).path}`)).toEqual([
            'sun.rotation', 'sun.light.color', 'sun.light.intensity', 'skyLight.intensity', 'sky.fogDensity',
            'sky.fogHeightFalloff', 'sky.fogMaxOpacity', 'sky.godRayExposure', 'fogPondMist.density',
        ]);
        const seq = parseSequence({ name: 'T', duration: 100, slots: [], tracks, markers: [] });
        expect(seq.tracks).toHaveLength(tracks.length);
    });

    it('follows the model between its keys, within the tolerance', () => {
        const rot = track(tracks, 'sun-rotation');
        for (const t of [25, 33.3, 41.7]) {
            const want = dayLook(evaluateKeyedNumber(hourKeys, t), 0, AUTHORED).rotation;
            const got = evaluateKeyedVector(rot, t, [0, 0, 0]);
            expect(Math.abs(got[0] - want[0])).toBeLessThan(0.2);
            expect(Math.abs(((got[1] - want[1]) % 360 + 540) % 360 - 180)).toBeLessThan(0.2);
        }
        // Far fewer keys than samples.
        expect(rot.keys.length).toBeLessThan(60);
    });

    it('holds where the hour holds, and jumps where it jumps', () => {
        const lux = track(tracks, 'sun-lux');
        const held = lux.keys.filter((k: any) => k.interp === 'constant').map((k: any) => k.t);
        expect(held).toContain(0);
        expect(held).toContain(50);
        const rot = track(tracks, 'sun-rotation');
        const before = evaluateKeyedVector(rot, 69.9, [0, 0, 0]), after = evaluateKeyedVector(rot, 70, [0, 0, 0]);
        expect(before).toEqual(evaluateKeyedVector(rot, 55, [0, 0, 0]));
        expect(Math.abs(after[0] - before[0])).toBeGreaterThan(5);
    });
});

describe('the Day Cycle', () => {
    it('is a whole day in 24 minutes, looping, starting and ending on the same sun', () => {
        const day = buildDayCycle(AUTHORED);
        expect(day.loop).toBe(true);
        expect(day.duration).toBe(1440);
        const rot = track(day.tracks, 'sun-rotation');
        const a = evaluateKeyedVector(rot, 0, [0, 0, 0]), b = evaluateKeyedVector(rot, 1440, [0, 0, 0]);
        expect(Math.abs(a[0] - b[0])).toBeLessThan(1e-3);
        expect(Math.abs(((a[1] - b[1]) % 360 + 540) % 360 - 180)).toBeLessThan(1e-3);
        // Night falls part way through.
        const lux = (t: number) => evaluateKeyedNumber(track(day.tracks, 'sky-light'), t);
        expect(lux(720)).toBeLessThan(lux(150));
    });
});

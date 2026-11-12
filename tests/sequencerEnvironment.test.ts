import { describe, it, expect } from 'vitest';
import { SequencePlayer } from '../src/sequencer/sequencePlayer';
import { parseSequence } from '../src/sequencer/parse';
import { registerSequencePresets, sequencePresetsFor, blendPresetValue } from '../src/sequencer/presetRegistry';
import { definePresets } from '../src/core/presets';
import { VolumetricCloudsNode } from '../src/core/scene/nodes/volumetricCloudsNode';
import { WindNode } from '../src/core/scene/nodes/windNode';
import { VOLUMETRIC_CLOUDS_PRESETS } from '../src/core/scene/nodes/volumetricCloudsPresets';
import { WIND_PRESETS } from '../src/core/scene/nodes/windPresets';
import { WindFieldSnapshot, advanceGustTravel, windGustAt } from '../src/core/wind/windField';
import type { SequenceData } from '../src/sequencer/types';

// The environment tracks M3 added to the sequencer: Preset (a blend into a node's own presets, chained
// section to section) and Foliage (live multipliers on a landscape's layers). And the two clocks they need
// to look right while they change: the gusts' travel and the clouds' drift, both integrated, so a wind that
// changes speed carries what it moves on instead of racing it.

const seq = (tracks: any[], slots: any[] = []): SequenceData =>
    parseSequence({ name: 'Env', duration: 100, fps: 30, slots, tracks, markers: [] });

const player = (data: SequenceData, nodes: Record<string, any>, renderer: any = null) =>
    new SequencePlayer(data, { resolveSlot: id => nodes[id] ?? null, director: null, scene: null, renderer });

registerSequencePresets('testLight', definePresets({ level: 0, tint: [0, 0, 0], mode: 'off' as string }, [
    ['dim', 'Dim', '', { level: 2, tint: [0.2, 0.2, 0.2], mode: 'soft' }],
    ['bright', 'Bright', '', { level: 10, tint: [1, 1, 1], mode: 'hard' }],
    ['dark', 'Dark', '', { level: 0, tint: [0, 0, 0], mode: 'off' }],
]));

const lamp = () => ({ nodeType: 'testLight', level: 5, tint: new Float32Array([0.5, 0.5, 0.5]), mode: 'auto' });

describe('the Preset track', () => {
    it('knows the clouds, the wind and the weather', () => {
        expect(sequencePresetsFor('volumetricClouds')).toBe(VOLUMETRIC_CLOUDS_PRESETS);
        expect(sequencePresetsFor(new WindNode('w'))).toBe(WIND_PRESETS);
        expect(sequencePresetsFor('weather')!.some(p => p.id === 'storm')).toBe(true);
        expect(sequencePresetsFor('skyAtmosphere')).toBeNull();
    });

    it('blends numbers and colours, and switches a kind at the half', () => {
        expect(blendPresetValue(0, 10, 0.25)).toBeCloseTo(2.5, 9);
        expect(blendPresetValue([0, 0], new Float32Array([4, 8]), 0.5)).toEqual([2, 4]);
        expect(blendPresetValue('a', 'b', 0.49)).toBe('a');
        expect(blendPresetValue('a', 'b', 0.5)).toBe('b');
    });

    it('eases from what it found to the preset, holds it, and chains from section to section', () => {
        const node = lamp();
        const data = seq([{ id: 'p', type: 'preset', slot: 'lamp', sections: [
            { id: 'a', start: 10, end: 20, preset: 'bright' },
            { id: 'b', start: 30, end: 40, preset: 'dim' },
            { id: 'c', start: 50, end: 60, preset: 'dark', from: 'dim' },
        ] }]);
        const p = player(data, { lamp: node });
        p.evaluate(5);
        expect(node.level).toBe(5);                    // before the first section: untouched
        p.evaluate(10);
        expect(node.level).toBeCloseTo(5, 9);          // the blend starts where the node was
        p.evaluate(15);
        expect(node.level).toBeCloseTo(7.5, 9);        // half way, smoothstepped: 0.5
        expect(node.mode).toBe('hard');
        expect(node.tint).toBeInstanceOf(Float32Array); // a typed field stays typed
        p.evaluate(25);
        expect(node.level).toBe(10);                   // held between sections
        p.evaluate(35);
        expect(node.level).toBeCloseTo(6, 9);          // from the previous section's preset (10) to dim (2)
        p.evaluate(55);
        expect(node.level).toBeCloseTo(1, 9);          // `from` overrides the chain: dim (2) to dark (0)
        // A pure function of time: back to the middle of the first blend.
        p.evaluate(15);
        expect(node.level).toBeCloseTo(7.5, 9);
        p.restoreAll();
        expect([node.level, Array.from(node.tint), node.mode]).toEqual([5, [0.5, 0.5, 0.5], 'auto']);
    });

    it('drives a real clouds node from clear to a thunderstorm and back on stop', () => {
        const clouds = new VolumetricCloudsNode('clouds', { coverage: 0.3, windSpeed: 10 });
        const data = seq([{ id: 'p', type: 'preset', slot: 'c', sections: [{ id: 's', start: 0, end: 10, preset: 'stormy' }] }]);
        const p = player(data, { c: clouds });
        p.evaluate(10);
        const stormy = VOLUMETRIC_CLOUDS_PRESETS.find(x => x.id === 'stormy')!.options;
        expect(clouds.coverage).toBeCloseTo(stormy.coverage!, 6);
        expect(clouds.windSpeed).toBeCloseTo(stormy.windSpeed!, 6);
        p.restoreAll();
        expect(clouds.coverage).toBeCloseTo(0.3, 6);
        expect(clouds.windSpeed).toBeCloseTo(10, 6);
    });
});

describe('the Foliage track', () => {
    const layer = (name: string, extra: any = {}) => ({ name, densityScale: 1, cullDistance: 450, billboardDistance: Infinity, castShadows: true, ...extra });

    it('multiplies the named layers by its channels and restores them on stop', () => {
        const trees = layer('Spruce'), grass = layer('Grass', { cullDistance: 0, castShadows: false });
        const other = layer('Rock');
        const land = { terrain: { foliage: [trees, grass, other] } };
        const data = seq([{ id: 'f', type: 'foliage', slot: 'land', layers: ['Spruce', 'Grass'], sections: [{
            id: 's', start: 0, end: 10,
            density: { keys: [{ t: 0, v: 1, interp: 'linear' }, { t: 5, v: 0.1, interp: 'linear' }, { t: 10, v: 1 }] },
            cull: { keys: [{ t: 0, v: 0.2 }] },
            shadows: { keys: [{ t: 0, v: false }] },
        }] }]);
        const p = player(data, { land }, { foliageCullDistance: 300 });
        p.evaluate(5);
        expect(trees.densityScale).toBeCloseTo(0.1, 9);
        expect(trees.cullDistance).toBeCloseTo(90, 9);
        // A layer that follows the renderer's distance is brought in from that one.
        expect(grass.cullDistance).toBeCloseTo(60, 9);
        expect([trees.castShadows, grass.castShadows]).toEqual([false, false]);
        expect(other).toEqual(layer('Rock'));
        p.evaluate(2.5);
        expect(trees.densityScale).toBeCloseTo(0.55, 9);
        p.restoreAll();
        expect(trees).toEqual(layer('Spruce'));
        expect(grass).toEqual(layer('Grass', { cullDistance: 0, castShadows: false }));
    });

    it("leaves a channel it has no keys for as the layer's own", () => {
        const trees = layer('Spruce', { billboardDistance: 200 });
        const data = seq([{ id: 'f', type: 'foliage', slot: 'land', layers: 'all', sections: [{
            id: 's', start: 0, end: 10, billboard: { keys: [{ t: 0, v: 0.5 }] },
        }] }]);
        player(data, { land: { terrain: { foliage: [trees] } } }).evaluate(4);
        expect([trees.densityScale, trees.cullDistance, trees.billboardDistance, trees.castShadows]).toEqual([1, 450, 100, true]);
    });

    it('parses whole, dropping channels of the wrong kind', () => {
        const data = seq([{ id: 'f', type: 'foliage', slot: 'land', layers: ['A', 7, ''], sections: [{
            id: 's', start: 0, end: 1, density: { keys: [{ t: 0, v: 0.5 }] }, shadows: { keys: [{ t: 0, v: 3 }] },
        }] }]);
        const t = data.tracks[0] as any;
        expect(t.layers).toEqual(['A']);
        expect(t.sections[0].density.keys[0].v).toBe(0.5);
        expect(t.sections[0].shadows).toBeUndefined();
    });
});

describe('the gusts roll on when the wind changes', () => {
    it('places them by how far they travelled, never racing while the speed changes', () => {
        const clock = { gustTravel: 0 };
        const wind = new WindNode('w', { gustSpeed: 4, gustScale: 18 });
        const scene = { wind, forceFields: [] };
        const snap = new WindFieldSnapshot();
        const dt = 1 / 60;
        let t = 0, previous = NaN, worst = 0;
        // A minute at 4 m/s, then the wind builds to a storm's 15 m/s gust speed over ten seconds.
        for (let i = 0; i < 70 * 60; i++) {
            t += dt;
            if (t > 60) wind.gustSpeed = 4 + Math.min(1, (t - 60) / 10) * 11;
            advanceGustTravel(clock, wind, dt);
            snap.capture(scene, t, clock.gustTravel);
            // The travel the eight floats encode: gust speed x time / wavelength.
            const travel = snap.params[5] * snap.params[4] / snap.params[3];
            // The params are float32, as the GPU gets them.
            expect(travel / clock.gustTravel).toBeCloseTo(1, 5);
            if (i > 0) worst = Math.max(worst, travel - previous);
            previous = travel;
        }
        // Never more than a frame of the fastest gusts: 15 m/s over 18 m wavelengths, a 60th of a second.
        expect(worst).toBeLessThan(15 / 18 * dt * 1.01);
        // What `speed x time` would have jumped by over that one ramp: hundreds of wavelengths.
        expect((15 - 4) * 70 / 18).toBeGreaterThan(40);
    });

    it('matches speed x time for a steady wind, and needs no travel at all', () => {
        const wind = new WindNode('w', { gustSpeed: 5, gustScale: 20 });
        const scene = { wind, forceFields: [] };
        const a = new WindFieldSnapshot().capture(scene, 30, 5 / 20 * 30).params;
        const b = new WindFieldSnapshot().capture(scene, 30).params;
        expect(a[5]).toBeCloseTo(b[5], 9);
        for (const [x, z] of [[0, 0], [12, -7]]) expect(windGustAt(x, z, a)).toBeCloseTo(windGustAt(x, z, b), 6);
    });
});

// The render modules are a large import: a generous timeout for the first one.
describe('the render clock and the clouds\' drift', { timeout: 120_000 }, () => {
    it('runs the render clock at the game\'s speed only when effects follow it', async () => {
        const { FoliagePasses } = await import('../src/graphics/render/foliage');
        const { windFieldClock } = await import('../src/core/wind/windField');
        const view = { windTime: 0, windTimePrev: 0, windDelta: 0 };
        const passes: any = Object.assign(Object.create(FoliagePasses.prototype), {
            _view: view, _windClock: -1, effectsFollowTimeScale: false, effectsTimeScale: 2,
        });
        let now = 1000;
        const realNow = performance.now;
        (performance as any).now = () => now;
        try {
            passes.advanceWindTime();                 // the first frame only starts the clock
            now += 50; passes.advanceWindTime();
            expect(view.windDelta).toBeCloseTo(0.05, 9);
            passes.effectsFollowTimeScale = true;
            now += 50; passes.advanceWindTime();
            expect(view.windDelta).toBeCloseTo(0.1, 9);
            expect(view.windTime).toBeCloseTo(0.15, 9);
            expect(windFieldClock.time).toBe(view.windTime);
            // A stall is still clamped before it is scaled.
            now += 5000; passes.advanceWindTime();
            expect(view.windDelta).toBeCloseTo(0.2, 9);
        } finally {
            (performance as any).now = realNow;
            windFieldClock.time = 0;
        }
    });

    it('carries the clouds on by speed x dt, continuously while the wind builds and turns', async () => {
        const { VolumetricCloudPasses } = await import('../src/graphics/render/clouds');
        const passes: any = Object.assign(Object.create(VolumetricCloudPasses.prototype), {
            windOffset: [0, 0, 0], _windDir: [0, 0, 0],
        });
        const wind = new WindNode('w', { direction: 0, strength: 1 });
        const clouds = new VolumetricCloudsNode('c', { windSpeed: 10, useSceneWind: true });
        const scene = { volumetricClouds: clouds, wind };
        const dt = 1 / 60;
        let worst = 0;
        for (let i = 0; i < 60 * 30; i++) {
            const t = i * dt;
            wind.strength = 1 + Math.min(1, t / 10);           // to a storm's 2
            clouds.windSpeed = 10 + Math.min(1, t / 10) * 15;  // and the preset's 25 m/s
            if (t > 20) wind.direction = (t - 20) * 9;         // then turning, 90 degrees over 10 s
            const before = [...passes.windOffset];
            passes.advanceCloudWind(scene, dt);
            worst = Math.max(worst, Math.hypot(passes.windOffset[0] - before[0], passes.windOffset[2] - before[2]));
        }
        // Never more than a frame of the fastest wind: 25 m/s x 2.
        expect(worst).toBeLessThan(50 * dt * 1.001);
        expect(Math.hypot(passes.windOffset[0], passes.windOffset[2])).toBeGreaterThan(500);
        // No clouds node, no drift.
        const still = [...passes.windOffset];
        passes.advanceCloudWind({ volumetricClouds: null, wind }, dt);
        expect(passes.windOffset).toEqual(still);
    });
});

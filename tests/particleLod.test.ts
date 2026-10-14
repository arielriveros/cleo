import { describe, it, expect } from 'vitest';
import { mat4 } from 'gl-matrix';
import {
    defaultParticleSystem, defaultEmitter, makeModule, parseParticleSystem, LOD_ALL_LEVELS, type ParticleLod,
} from '../src/particles/particleSystemAsset';
import {
    FULL_DETAIL, PARTICLE_LOD_HYSTERESIS, particleLodDistance, particleLodFactors, selectParticleLod,
} from '../src/particles/particleLod';
import { ParticleSystemRuntime } from '../src/particles/particleRuntime';
import { ParticleSystemNode } from '../src/core/scene/nodes/particleSystemNode';

// Particle LOD: an effect far from the camera spawns less, simulates less often, drops its detail
// emitters, and past its cull distance is not drawn at all — while the defaults change nothing, so every
// effect authored before LOD runs exactly as it did.

const I = mat4.create();
const lod = (over: Partial<ParticleLod> = {}): ParticleLod => ({
    enabled: true,
    levels: [{ distance: 15, spawnScale: 0.5, stepScale: 2 }, { distance: 30, spawnScale: 0.25, stepScale: 3 }],
    cullDistance: 60, scaleBursts: false, ...over,
});
/** Walk the camera through `distances`, carrying the state, and return the levels/culls it passed. */
const walk = (l: ParticleLod, distances: number[], scale = 1) => {
    let state = FULL_DETAIL;
    return distances.map(d => (state = selectParticleLod(l, d, state, scale)));
};

describe('choosing a level', () => {
    it('coarsens as the camera passes each threshold, and culls past the cull distance', () => {
        const states = walk(lod(), [5, 16, 31, 61]);
        expect(states.map(s => s.level)).toEqual([0, 1, 2, 2]);
        expect(states.map(s => s.culled)).toEqual([false, false, false, true]);
    });

    it('refines only once the camera is 10% inside a boundary, so hovering on one does not flicker', () => {
        const at = 30 * PARTICLE_LOD_HYSTERESIS;
        const states = walk(lod(), [31, 29.5, at + 0.1, at - 0.1]);
        expect(states.map(s => s.level)).toEqual([2, 2, 2, 1]);
        // Coming all the way back in from far out lands on full detail.
        expect(walk(lod(), [40, 3]).at(-1)!.level).toBe(0);
    });

    it('un-culls only well inside the cull distance', () => {
        const states = walk(lod(), [61, 58, 53]);
        expect(states.map(s => s.culled)).toEqual([true, true, false]);
    });

    it('scales every threshold by the global distance scale', () => {
        expect(walk(lod(), [20], 2)[0].level).toBe(0);         // 15 m becomes 30 m
        expect(walk(lod(), [20], 0.5)[0].level).toBe(2);       // 30 m becomes 15 m
        expect(walk(lod(), [100], 2)[0].culled).toBe(false);   // cull at 120 m
    });

    it('is full detail when LOD is off, has no levels and no cull, or is missing', () => {
        expect(walk(lod({ enabled: false }), [500])[0]).toEqual(FULL_DETAIL);
        expect(walk(lod({ levels: [], cullDistance: 0 }), [500])[0]).toEqual(FULL_DETAIL);
        expect(selectParticleLod(undefined, 500, FULL_DETAIL)).toEqual(FULL_DETAIL);
    });

    it('measures to the surface of the bounds, not the centre', () => {
        expect(particleLodDistance([0, 0, 0], 5, [0, 0, 20])).toBeCloseTo(15);
        expect(particleLodDistance([0, 0, 0], 5, [0, 0, 2])).toBe(0);
    });

    it('reports what each level does', () => {
        expect(particleLodFactors(lod(), 0)).toEqual({ spawnScale: 1, stepScale: 1 });
        expect(particleLodFactors(lod(), 2)).toEqual({ spawnScale: 0.25, stepScale: 3 });
    });
});

describe('the asset', () => {
    it('defaults to LOD on with no levels and no cull — what every older effect ran as', () => {
        const old = parseParticleSystem({ emitters: [{ name: 'a' }] });
        expect(old.lod).toEqual({ enabled: true, levels: [], cullDistance: 0, scaleBursts: false });
        expect(old.emitters[0].maxLod).toBe(LOD_ALL_LEVELS);
        expect(defaultParticleSystem().lod.levels).toEqual([]);
    });

    it('clamps and sorts levels, and round-trips', () => {
        const parsed = parseParticleSystem({
            emitters: [{ maxLod: 1 }],
            lod: { levels: [{ distance: 40, spawnScale: 3, stepScale: 9 }, { distance: -5, spawnScale: -1, stepScale: 0 }], cullDistance: -2, scaleBursts: true },
        });
        expect(parsed.lod.levels).toEqual([{ distance: 0, spawnScale: 0, stepScale: 1 }, { distance: 40, spawnScale: 1, stepScale: 4 }]);
        expect(parsed.lod.cullDistance).toBe(0);
        expect(parsed.lod.scaleBursts).toBe(true);
        expect(parsed.emitters[0].maxLod).toBe(1);
        expect(parseParticleSystem(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    });
});

describe('a coarser level at runtime', () => {
    /** A looping emitter spawning `rate`/s, with an optional 10-particle burst at t=0 of every 1 s cycle. */
    const emitter = (rate: number, burst = 0, maxLod = LOD_ALL_LEVELS) => {
        const e = defaultEmitter();
        e.duration = 1;
        e.maxLod = maxLod;
        e.spawn = [makeModule('spawnRate')];
        e.spawn[0].params.rate = rate;
        if (burst) {
            const b = makeModule('spawnBurst');
            b.params.bursts = [{ time: 0, count: burst, cycles: 1, interval: 1, probability: 1 }];
            e.spawn.push(b);
        }
        return e;
    };
    const run = (rt: ParticleSystemRuntime, frames: number, step?: { level: number; spawnScale: number; stepScale: number; scaleBursts: boolean }) => {
        rt.emitters.forEach(e => e.play());
        let steps = 0, spawned = 0;
        for (let f = 0; f < frames; f++) {
            rt.advance(1 / 60, I, 1, undefined, step);
            for (let i = 0; i < rt.emitters.length; i++) for (const s of rt.drain(i)) { steps++; spawned += s.spawnCount; }
        }
        return { steps, spawned };
    };

    it('spawns at the level\'s rate', () => {
        const full = run(new ParticleSystemRuntime([emitter(100)]), 120);
        const half = run(new ParticleSystemRuntime([emitter(100)]), 120, { level: 1, spawnScale: 0.5, stepScale: 1, scaleBursts: false });
        expect(full.spawned).toBeGreaterThanOrEqual(199);
        expect(half.spawned).toBeCloseTo(full.spawned / 2, -1);
    });

    it('simulates less often but keeps real time: ×3 runs a third of the steps over the same seconds', () => {
        const full = run(new ParticleSystemRuntime([emitter(60)]), 120);
        const rt = new ParticleSystemRuntime([emitter(60)]);
        rt.emitters.forEach(e => e.play());
        let steps = 0, seconds = 0;
        for (let f = 0; f < 120; f++) {
            rt.advance(1 / 60, I, 1, undefined, { level: 1, spawnScale: 1, stepScale: 3, scaleBursts: false });
            for (const s of rt.drain(0)) { steps++; seconds += s.dt; }
        }
        expect(full.steps).toBe(120);
        expect(steps).toBe(40);
        expect(seconds).toBeCloseTo(2, 5);
    });

    it('leaves bursts whole unless asked to scale them', () => {
        const step = { level: 1, spawnScale: 0, stepScale: 1, scaleBursts: false };
        expect(run(new ParticleSystemRuntime([emitter(0, 10)]), 30, step).spawned).toBe(10);
        expect(run(new ParticleSystemRuntime([emitter(0, 10)]), 30, { ...step, spawnScale: 0.5, scaleBursts: true }).spawned).toBe(5);
    });

    it('silences a detail emitter past its last level, and only it', () => {
        const rt = new ParticleSystemRuntime([emitter(100), emitter(100, 10, 0)]);
        rt.emitters.forEach(e => e.play());
        const counts = [0, 0];
        for (let f = 0; f < 60; f++) {
            rt.advance(1 / 60, I, 1, undefined, { level: 1, spawnScale: 1, stepScale: 1, scaleBursts: false });
            for (let i = 0; i < 2; i++) for (const s of rt.drain(i)) counts[i] += s.spawnCount;
        }
        expect(counts[0]).toBeGreaterThan(90);
        expect(counts[1]).toBe(0);
    });
});

describe('the node', () => {
    const drainAll = (node: ParticleSystemNode) => node.runtime.emitters.forEach((_e, i) => node.runtime.drain(i));

    it('pauses a looping system culled by distance, but lets a one-shot play out', () => {
        const torch = new ParticleSystemNode('torch', {});
        torch.play();
        torch.lod = { level: 0, culled: true };
        torch.update(0.1, 0);
        expect(torch.runtime.hasPendingWork).toBe(false);

        const shotSystem = defaultParticleSystem();
        shotSystem.emitters[0].looping = false;
        const shot = new ParticleSystemNode('fx', { system: shotSystem });
        shot.play();
        drainAll(shot);
        shot.lod = { level: 0, culled: true };
        shot.update(0.1, 0);
        expect(shot.runtime.hasPendingWork).toBe(true);
    });

    it('round-trips its LOD switch and resets to full detail when it is turned off', () => {
        const node = new ParticleSystemNode('fx', { lodEnabled: false });
        expect(node.lodEnabled).toBe(false);
        node.lodEnabled = true;
        node.lod = { level: 2, culled: true };
        node.lodEnabled = false;
        expect(node.lod).toEqual(FULL_DETAIL);
        const json = (node as any)._serializePayload().particleSystem;
        expect(json.lodEnabled).toBe(false);
        expect(new ParticleSystemNode('default', {}).lodEnabled).toBe(true);
    });
});

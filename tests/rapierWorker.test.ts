import { describe, it, expect, beforeAll } from 'vitest';
import { acquirePhysicsBackend } from '../src/physics/pal/createWorld';
import { LoopbackPort } from '../src/physics/worker/ports';
import { runScenario, scenarioPhysics } from './helpers/physicsScenario';

// Rapier in the physics worker (pal/rapier/mirror.ts + replica.ts): the golden trace's mixed scene, run on
// Rapier inline and through the worker over an in-process port that clones every message like a real worker,
// must come out the same. The worker's result lands one frame after the scripts that caused it, so its trace
// is read with that one-frame lag (see physicsWorkerParity.test.ts, the same for cannon).
//
// The simulation is the same to the bit: every position and velocity, every frame. A rotation may read one
// unit in the last place apart: written back into this thread's world, Rapier renormalises it.

beforeAll(() => acquirePhysicsBackend('rapier'));

/** Fields of a body's sample (physicsScenario.ts): position 0-2, rotation 3-6, velocity 7-9, spin 10-12. */
const FIELDS = 13;
/** A few units in the last place of a single-precision number near 1. */
const ROTATION_ULPS = 3 * 2 ** -23;

describe('Rapier in the physics worker', () => {
    it('steps the mixed scene as the inline step does', () => {
        const inline = runScenario(scenarioPhysics('rapier'));
        const port = new LoopbackPort();
        const p = scenarioPhysics('rapier');
        p.setWorkerMode('on', () => port);
        expect(p.backend).toBe('rapier');
        expect(p.executor).toBe('worker');
        const worker = runScenario(p, 300, 1 / 60, 1);
        expect(p.executor).toBe('worker');
        expect(worker.triggers).toEqual(inline.triggers);
        expect(worker.collides).toEqual(inline.collides);
        expect(worker.grounded).toEqual(inline.grounded);
        expect(worker.frozen).toEqual(inline.frozen);
        expect(worker.states.length).toBe(inline.states.length);
        let rotation = 0;
        for (let i = 0; i < inline.states.length; i++) {
            const a = inline.states[i], b = worker.states[i];
            for (let k = 0; k < a.length; k++) {
                const field = k % FIELDS;
                if (field >= 3 && field <= 6) rotation = Math.max(rotation, Math.abs(a[k] - b[k]));
                else expect(b[k], `frame ${i * 10}, body ${Math.floor(k / FIELDS)}, field ${field}`).toBe(a[k]);
            }
        }
        expect(rotation).toBeLessThanOrEqual(ROTATION_ULPS);
    });
});

import { describe, it, expect, beforeAll } from 'vitest';
import { acquirePhysicsBackend } from '../src/physics/pal/createWorld';
import { LoopbackPort } from '../src/physics/worker/ports';
import { runScenario, scenarioPhysics } from './helpers/physicsScenario';

// Jolt in the physics worker (pal/copy/describedMirror.ts + describedReplica.ts): the golden trace's mixed
// scene, run on Jolt inline and through the worker over an in-process port that clones every message like a
// real worker, must come out the same. The worker's result lands one frame after the scripts that caused it,
// so its trace is read with that one-frame lag (see physicsWorkerParity.test.ts, the same for cannon).
//
// Jolt's simulation depends on its bodies' BodyIDs, so the copy gives each body the one the original's has
// (JoltWorld.createBodyWithNativeId): then it steps to the bit, every position, velocity and rotation.

beforeAll(() => acquirePhysicsBackend('jolt'));

describe('Jolt in the physics worker', () => {
    it('steps the mixed scene as the inline step does', () => {
        const inline = runScenario(scenarioPhysics('jolt'));
        const port = new LoopbackPort();
        const p = scenarioPhysics('jolt');
        p.setWorkerMode('on', () => port);
        expect(p.backend).toBe('jolt');
        expect(p.executor).toBe('worker');
        const worker = runScenario(p, 300, 1 / 60, 1);
        expect(p.executor).toBe('worker');
        expect(worker.triggers).toEqual(inline.triggers);
        expect(worker.collides).toEqual(inline.collides);
        expect(worker.grounded).toEqual(inline.grounded);
        expect(worker.frozen).toEqual(inline.frozen);
        expect(worker.states.length).toBe(inline.states.length);
        for (let i = 0; i < inline.states.length; i++) {
            const a = inline.states[i], b = worker.states[i];
            for (let k = 0; k < a.length; k++) expect(b[k], `frame ${i * 10}, value ${k}`).toBe(a[k]);
        }
    });
});

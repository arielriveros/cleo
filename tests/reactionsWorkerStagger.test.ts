import { describe, it, expect } from 'vitest';
import { acquirePhysicsBackend } from '../src/physics/pal/createWorld';
import { LoopbackPort } from '../src/physics/worker/ports';
import { groundWorld, humanoidModel } from './helpers/humanoidRig';

// A stagger with the physics worker, in a file of its own: each worker world (a loopback one here) holds a Jolt heap
// of its own, and the reactions suite's already fill the module's.

const H = 1 / 60;

describe('a stagger with the physics worker (jolt)', () => {
    // A stagger steps on its own legs with the worker as inline: its pushes go through the port, never a velocity
    // written from the step-old pose it reads.
    it('steps on its own legs with the physics worker: steps, stays up and is back on its animation', async () => {
        await acquirePhysicsBackend('jolt');
        const physics = groundWorld('jolt');
        physics.setWorkerMode('on', () => new LoopbackPort());
        const node = humanoidModel();
        const r = physics.reactionsOf(node)!;
        const seen = new Set<string>();
        let steps = 0, finiteAll = true;
        for (let f = 0; f < 300; f++) {
            if (f === 10) r.push([0, 0, -1.1]);
            physics.update(H);
            node.animator!.update(H);
            physics.endFrame(H);
            seen.add(r.state);
            steps = Math.max(steps, r.balance?.steps ?? 0);
            if (r.ragdoll && !r.ragdoll.parts.every(p => Number.isFinite(p.body.position.x + p.body.position.y + p.body.position.z))) finiteAll = false;
        }
        expect(physics.executor).toBe('worker');
        expect(seen.has('stagger')).toBe(true);
        expect(seen.has('falling')).toBe(false);
        expect(steps).toBeGreaterThan(0);
        expect(finiteAll).toBe(true);
        expect(r.state).toBe('animated');
        physics.dispose();
    }, 60000);

});

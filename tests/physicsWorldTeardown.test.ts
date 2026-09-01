import { describe, it, expect } from 'vitest';
import { World, Body, Box, Sphere, Vec3, SAPBroadphase } from 'cannon-es';
import { clearWorld, broadphaseBodyCount } from '../src/physics/worldTeardown';

/**
 * The bug this suite exists for: `world.bodies` is NOT what the broadphase iterates. `SAPBroadphase`
 * keeps its own `axisList`, synced only from the world's add/remove EVENTS, so a teardown that splices
 * while iterating (skipping every other body) or assigns `world.bodies = []` (dispatching no events)
 * leaves bodies in the broadphase for the lifetime of the page. They keep being sorted, paired and
 * collided against, and every play session adds another batch — the reported per-session frame decay.
 *
 * `world.bodies.length` alone can never catch it: it reads 0 either way. Always assert `axisList` too.
 */

const worldWithSAP = (): World => {
    const world = new World();
    world.broadphase = new SAPBroadphase(world);
    return world;
};

const fill = (world: World, n: number) => {
    for (let i = 0; i < n; i++) {
        // Alternating shapes and a mix of static/dynamic, so nothing passes by accident on one kind.
        const body = new Body({ mass: i % 2 });
        body.addShape(i % 2 ? new Box(new Vec3(0.5, 0.5, 0.5)) : new Sphere(0.5));
        body.position.set(i, 0, 0);
        world.addBody(body);
    }
};

describe('clearWorld', () => {
    it('empties the broadphase, not just world.bodies', () => {
        const world = worldWithSAP();
        // An ODD count is deliberate: splice-while-iterating skips every other entry, so an even count
        // can leave a passing-looking remainder.
        fill(world, 7);
        expect(broadphaseBodyCount(world)).toBe(7);

        clearWorld(world);

        expect(world.bodies.length).toBe(0);
        expect(broadphaseBodyCount(world)).toBe(0);
    });

    it('does not accumulate across repeated sessions', () => {
        const world = worldWithSAP();
        for (let session = 0; session < 10; session++) {
            fill(world, 9);
            expect(broadphaseBodyCount(world)).toBe(9);
            clearWorld(world);
            expect(broadphaseBodyCount(world)).toBe(0);
        }
    });

    it('heals a broadphase that already holds bodies the world lost', () => {
        const world = worldWithSAP();
        fill(world, 3);
        // Exactly what the old teardown produced: bodies gone from the world, still in the broadphase.
        const stranded = new Body({ mass: 1 });
        stranded.addShape(new Sphere(1));
        (world.broadphase as SAPBroadphase).axisList.push(stranded);
        expect(broadphaseBodyCount(world)).toBe(4);
        expect(world.bodies.length).toBe(3);

        clearWorld(world);

        expect(broadphaseBodyCount(world)).toBe(0);
    });

    it('keeps the broadphase in sync with bodies added after a clear', () => {
        const world = worldWithSAP();
        fill(world, 5);
        clearWorld(world);
        // The resync must re-register the handlers, not just empty the list.
        fill(world, 4);
        expect(broadphaseBodyCount(world)).toBe(4);

        const [first] = world.bodies;
        world.removeBody(first);
        expect(broadphaseBodyCount(world)).toBe(3);
    });

    it('leaves cleared bodies at rest', () => {
        const world = worldWithSAP();
        fill(world, 3);
        const body = world.bodies[1];
        body.velocity.set(4, 5, 6);
        body.angularVelocity.set(1, 2, 3);
        body.force.set(7, 8, 9);

        clearWorld(world);

        expect([body.velocity.x, body.velocity.y, body.velocity.z]).toEqual([0, 0, 0]);
        expect([body.angularVelocity.x, body.angularVelocity.y, body.angularVelocity.z]).toEqual([0, 0, 0]);
        expect([body.force.x, body.force.y, body.force.z]).toEqual([0, 0, 0]);
    });
});

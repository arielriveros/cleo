import { describe, it, expect } from 'vitest';
import { Body, Sphere, Vec3 } from 'cannon-es';
import { PhysicsSystem } from '../src/physics/physicsSystem';
import { Ragdoll } from '../src/physics/ragdoll';

// The game must cover the same ground at any frame rate. Physics used to keep its own clock (cannon's
// accumulator, capped at 5 substeps and abandoned after 16.7 ms of wall time, remainder discarded), so
// a heavy or slow frame silently simulated LESS time than the scripts and the animator advanced by: a
// character whose run/sprint blend is driven by measured speed walked at low fps. These pin the rule
// that replaced it — every frame advances the world by exactly its delta, in substeps ≤ 1/60 s.

/** A physics system over an empty stand-in scene: enough for update() to step the world. */
function physics(): PhysicsSystem {
    const p = new PhysicsSystem({ gravity: [0, 0, 0] });
    p.initialize();
    (p as any)._scene = { nodes: [], landscapes: [], tilemaps: [], activeCamera: null };
    return p;
}

/** A free body moving at 4 m/s along +X, added straight to the world. */
function mover(p: PhysicsSystem): Body {
    const body = new Body({ mass: 1, linearDamping: 0, shape: new Sphere(0.1) });
    body.velocity.set(4, 0, 0);
    p.addBody(body);
    return body;
}

describe('physics substeps', () => {
    it('split a frame into equal substeps no longer than 1/60 s', () => {
        expect(PhysicsSystem.substepsFor(0)).toBe(0);
        expect(PhysicsSystem.substepsFor(1 / 144)).toBe(1);
        expect(PhysicsSystem.substepsFor(1 / 60)).toBe(1);
        expect(PhysicsSystem.substepsFor(1 / 30)).toBe(2);
        expect(PhysicsSystem.substepsFor(0.05)).toBe(3);
        expect(PhysicsSystem.substepsFor(0.1)).toBe(6);
        for (const dt of [1 / 144, 1 / 60, 0.021, 1 / 30, 0.05, 0.1])
            expect(dt / PhysicsSystem.substepsFor(dt)).toBeLessThanOrEqual(PhysicsSystem.MAX_SUBSTEP + 1e-9);
    });

    it('advance the world by exactly the frame delta, at any frame rate', () => {
        for (const fps of [20, 30, 60, 90, 144]) {
            const p = physics();
            const body = mover(p);
            const frames = fps * 2;                       // two seconds
            for (let i = 0; i < frames; i++) p.update(1 / fps);
            expect(body.position.x, `${fps} fps`).toBeCloseTo(8, 4);
        }
    });

    it('never drops time on an uneven frame sequence', () => {
        const p = physics();
        const body = mover(p);
        const deltas = [0.07, 0.004, 0.033, 0.1, 0.0167, 0.009, 0.05];
        let total = 0;
        for (let r = 0; r < 10; r++) for (const dt of deltas) { p.update(dt); total += dt; }
        expect(body.position.x).toBeCloseTo(4 * total, 4);
    });

    it('keeps no clock of its own: a frame with no time in it moves nothing', () => {
        const p = physics();
        const body = mover(p);
        p.update(0);
        expect(body.position.x).toBe(0);
        p.update(0.01);
        expect(body.position.x).toBeCloseTo(0.04, 6);
    });
});

describe('physics substep cap (a project option)', () => {
    it('caps the substep count, lengthening the steps instead', () => {
        expect(PhysicsSystem.substepsFor(0.1, 2)).toBe(2);
        expect(PhysicsSystem.substepsFor(0.1, 32)).toBe(6);
        expect(PhysicsSystem.substepsFor(1 / 30, 0)).toBe(1);   // never below one
        expect(PhysicsSystem.substepsFor(1 / 30, 2.9)).toBe(2);
    });

    it('the world still covers the whole frame under a low cap', () => {
        const p = physics();
        p.maxSubsteps = 1;
        const body = mover(p);
        for (let i = 0; i < 20; i++) p.update(0.1);
        expect(body.position.x).toBeCloseTo(8, 1);   // 4 m/s for 2 s
    });
});

describe('ragdoll lifetime', () => {
    /** A stand-in ragdoll: its bodies are in the world, the node is whatever the test makes of it. */
    function fakeRagdoll(p: PhysicsSystem, node: any) {
        const r = Object.create(Ragdoll.prototype);
        const body = new Body({ mass: 1, shape: new Sphere(0.1) });
        p.addBody(body);
        Object.assign(r, {
            _physics: p, _animator: null, _bodies: new Map([[0, body]]), _constraints: [],
            node, _stillFor: 0, _frozen: false, _destroyed: false,
        });
        (p as any)._ragdolls.push(r);
        return { r, body };
    }
    const inWorld = (p: PhysicsSystem, b: Body) => (p as any)._world.bodies.includes(b);

    it('ends when its model leaves the scene, taking its bodies out of the world', () => {
        const p = physics();
        const node: any = { scene: {}, markForRemoval: false, spawned: true, parent: null };
        const { body } = fakeRagdoll(p, node);
        body.velocity.set(5, 0, 0);
        p.update(1 / 60);
        expect(p.ragdollCount).toBe(1);
        node.scene = null;                                 // removed
        p.update(1 / 60);
        expect(p.ragdollCount).toBe(0);
        expect(inWorld(p, body)).toBe(false);
    });

    it('ends when an ancestor is despawned', () => {
        const p = physics();
        const holder: any = { spawned: false, parent: null };
        const { body } = fakeRagdoll(p, { scene: {}, markForRemoval: false, spawned: true, parent: holder });
        body.velocity.set(5, 0, 0);
        p.update(1 / 60);
        expect(p.ragdollCount).toBe(0);
    });

    it('freezes once at rest: out of the world, pose kept, still counted', () => {
        const p = physics();
        const { r, body } = fakeRagdoll(p, { scene: {}, markForRemoval: false, spawned: true, parent: null });
        for (let i = 0; i < 120; i++) p.update(1 / 60);   // two seconds at rest
        expect(r.frozen).toBe(true);
        expect(inWorld(p, body)).toBe(false);
        expect(p.ragdollCount).toBe(1);
    });
});

describe('a body at rest relative to the frame', () => {
    it('is untouched by the substep count (no per-step drift without forces)', () => {
        const p = physics();
        const body = new Body({ mass: 1, shape: new Sphere(0.1), position: new Vec3(1, 2, 3) });
        p.addBody(body);
        for (const dt of [1 / 144, 0.1, 1 / 30]) p.update(dt);
        expect([body.position.x, body.position.y, body.position.z]).toEqual([1, 2, 3]);
    });
});

import { describe, it, expect, beforeAll } from 'vitest';
import { acquirePhysicsBackend, createPhysicsWorld } from '../../src/physics/pal/createWorld';
import { joltHeap } from '../../src/physics/pal/jolt/load';
import type { BodyHandle } from '../../src/physics/pal/types';
import type { PhysicsWorld } from '../../src/physics/pal/world';

// What only the Jolt backend has to get right (the conformance suite holds it to every other backend's
// behaviour): its WASM heap is a fixed 128 MB that cannot grow, so whatever a world builds there must be
// freed when it goes, by the world itself.

beforeAll(() => acquirePhysicsBackend('jolt'));

function fill(w: PhysicsWorld, n: number): BodyHandle[] {
    const out: BodyHandle[] = [];
    for (let i = 0; i < n; i++) {
        out.push(w.createBody({
            position: [i % 10, 1 + Math.floor(i / 10), 0], rotation: [0, 0, 0, 1], mass: i % 3 ? 1 : 0,
            colliders: [
                { shape: { kind: 'box', halfExtents: [0.2, 0.2, 0.2] } },
                { shape: { kind: 'capsule', radius: 0.1, height: 0.3 }, offset: [0, 0.4, 0] },
            ],
        }));
    }
    for (let i = 1; i < out.length; i += 2) w.createJoint({ kind: 'ball', a: out[i - 1], b: out[i], anchorA: [0, 0, 0], anchorB: [0, 1, 0] });
    return out;
}

describe('the Jolt backend', () => {
    it('gives back the heap its bodies, joints and shapes took when they are destroyed, cleared or disposed', () => {
        const before = joltHeap().free;
        const w = createPhysicsWorld('jolt', [0, -9.81, 0]);
        const empty = joltHeap().free;
        // Jolt keeps some of what a step allocated (its contact cache, the broadphase's nodes) for the next one:
        // the heap settles after a couple of rounds, and rounds after it give back what they took (to the few
        // bytes the allocator's bookkeeping moves).
        const round = () => {
            const bodies = fill(w, 200);
            for (let i = 0; i < 30; i++) w.step(1 / 60);
            expect(joltHeap().free).toBeLessThan(empty);
            for (const b of bodies) w.destroyBody(b);
            return joltHeap().free;
        };
        round();
        const settled = round();
        expect(empty - settled).toBeLessThan(256 * 1024);
        for (let i = 0; i < 4; i++) expect(Math.abs(round() - settled)).toBeLessThan(256);
        // A clear builds the world anew, and a dispose frees it: all of it back, but for the allocator's own
        // bookkeeping.
        fill(w, 200);
        w.clear();
        expect(Math.abs(joltHeap().free - empty)).toBeLessThan(4096);
        w.dispose();
        expect(Math.abs(joltHeap().free - before)).toBeLessThan(4096);
    });

    it('frees a world dropped without dispose once it is collected', async () => {
        // Needs node's --expose-gc (vitest.config.ts passes it).
        const gc = (globalThis as { gc?: () => void }).gc;
        expect(gc).toBeTypeOf('function');
        const before = joltHeap().free;
        (() => { const w = createPhysicsWorld('jolt'); fill(w, 50); w.step(1 / 60); })();
        expect(before - joltHeap().free).toBeGreaterThan(1024 * 1024);
        for (let i = 0; i < 20 && Math.abs(joltHeap().free - before) >= 4096; i++) {
            gc!();
            await new Promise(r => setTimeout(r, 5));
        }
        expect(Math.abs(joltHeap().free - before)).toBeLessThan(4096);
    });

    it('holds a world the size the engine asks for in a fraction of the heap', () => {
        const { total, free } = joltHeap();
        const w = createPhysicsWorld('jolt');
        const cost = free - joltHeap().free;
        w.dispose();
        expect(total).toBe(128 * 1024 * 1024);
        expect(cost).toBeLessThan(24 * 1024 * 1024);
    });

    it('says which body filled it rather than failing silently', () => {
        // Not filled for real (16,384 bodies): an id the world cannot hand out instead.
        const w = createPhysicsWorld('jolt');
        expect(() => (w as unknown as { createBodyWithNativeId(d: object, id: number): void }).createBodyWithNativeId(
            { position: [0, 0, 0], rotation: [0, 0, 0, 1], mass: 1, colliders: [{ shape: { kind: 'sphere', radius: 1 } }] }, 0x7FFFFF,
        )).toThrow(/Jolt's world is full|could not/);
        w.dispose();
    });
});

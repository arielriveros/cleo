import { describe, it, expect } from 'vitest';
import { PhysicsSystem } from '../src/physics/physicsSystem';
import { PhysicsBody } from '../src/physics/physicsBody';

// The engine's own body (physics/physicsBody.ts): what it is lives in its description, where it is lives in
// the world it was added to. These pin the bookkeeping between the two: state given before it is added,
// live views of the world's state, and what a removal or a world clear keeps.

function physics(): PhysicsSystem {
    const p = new PhysicsSystem({ gravity: [0, -10, 0] });
    p.initialize();
    (p as any)._scene = { nodes: [], landscapes: [], tilemaps: [], activeCamera: null };
    return p;
}
const ball = (y = 5) => new PhysicsBody({ mass: 1, position: [0, y, 0] }).addCollider({ shape: { kind: 'sphere', radius: 0.5 } });

describe('an engine physics body', () => {
    it('starts in the world from the state it was given before it was added', () => {
        const p = physics();
        const b = ball();
        b.velocity.set(2, 0, 0);
        b.quaternion.set(0, Math.SQRT1_2, 0, Math.SQRT1_2);
        p.addBody(b);
        expect(b.id).toBeGreaterThanOrEqual(0);
        expect(b.velocity.x).toBe(2);
        expect(b.quaternion.w).toBeCloseTo(Math.SQRT1_2, 12);
        p.update(1 / 60);
        expect(b.position.x).toBeGreaterThan(0);
    });

    it('reads the world live and writes straight to it', () => {
        const p = physics();
        const b = ball();
        p.addBody(b);
        const position = b.position;                        // a view: kept, it stays current
        p.update(1 / 60);
        expect(position.y).toBeLessThan(5);
        b.velocity.x = 3;                                   // one component, the rest kept
        expect(b.velocity.y).toBeLessThan(0);
        p.update(1 / 60);
        expect(b.position.x).toBeCloseTo(3 / 60, 3);       // less a little default damping
    });

    it('keeps its state when removed, and carries on from it when added again', () => {
        const p = physics();
        const b = ball();
        p.addBody(b);
        for (let i = 0; i < 10; i++) p.update(1 / 60);
        const y = b.position.y, vy = b.velocity.y;
        p.removeBody(b);
        expect(p.hasBody(b)).toBe(false);
        expect(b.position.y).toBe(y);
        p.update(1 / 60);
        expect(b.position.y).toBe(y);                       // out of the world: not stepped
        p.addBody(b);
        expect(b.velocity.y).toBe(vy);
        p.update(1 / 60);
        expect(b.position.y).toBeLessThan(y);
    });

    it('kept out of the world (a pool), comes back as the same body', () => {
        const p = physics();
        const b = ball();
        p.addBody(b);
        const id = b.id;
        p.removeBody(b, true);
        b.position.set(1, 2, 3);
        p.addBody(b);
        expect(b.id).toBe(id);
        expect(b.position.toArray()).toEqual([1, 2, 3]);
    });

    it('survives its world being cleared: added again, it is made afresh where it was', () => {
        const p = physics();
        const b = ball();
        p.addBody(b);
        for (let i = 0; i < 10; i++) p.update(1 / 60);
        const y = b.position.y;
        p.clear();
        expect(p.hasBody(b)).toBe(false);
        expect(b.world).toBe(null);
        expect(b.position.y).toBe(y);
        p.addBody(b);
        expect(b.position.y).toBeCloseTo(y, 12);
    });

    it('joins another body, until the joint is removed', () => {
        const p = physics();
        const anchor = new PhysicsBody({ position: [0, 5, 0] }).addCollider({ shape: { kind: 'sphere', radius: 0.05 } });
        const bob = ball(4);
        p.addBody(anchor); p.addBody(bob);
        const joint = p.addJoint(bob, anchor, { kind: 'ball', anchorA: [0, 0.5, 0], anchorB: [0, -0.5, 0] });
        expect(joint).not.toBeNull();
        for (let i = 0; i < 60; i++) p.update(1 / 60);
        expect(bob.position.y).toBeCloseTo(4, 1);
        p.removeJoint(joint!);
        for (let i = 0; i < 60; i++) p.update(1 / 60);
        expect(bob.position.y).toBeLessThan(0);
    });
});

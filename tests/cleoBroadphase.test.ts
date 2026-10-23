import { describe, it, expect } from 'vitest';
import { Body, Box, NaiveBroadphase, Sphere, Vec3, World } from 'cannon-es';
import { CleoSAPBroadphase, sortByStart } from '../src/physics/cleoBroadphase';

// The broadphase only ever chooses which pairs reach the narrowphase. Breaking its loop early is a speedup
// exactly as long as it never drops a pair: these hold it to NaiveBroadphase's answer (every pair, same
// bounding-sphere test) on scenes built to break a careless sweep.

function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Unordered pair keys, so two broadphases can be compared as sets. */
function pairsOf(world: World, broadphase: any): Set<string> {
    const p1: Body[] = [], p2: Body[] = [];
    broadphase.setWorld?.(world);
    broadphase.collisionPairs(world, p1, p2);
    const out = new Set<string>();
    for (let i = 0; i < p1.length; i++) {
        const a = p1[i].id, b = p2[i].id;
        out.add(a < b ? `${a}:${b}` : `${b}:${a}`);
    }
    return out;
}

function scene(seed: number, statics: number, dynamics: number, spread: [number, number]): World {
    const r = rng(seed);
    const world = new World();
    for (let k = 0; k < statics + dynamics; k++) {
        const isStatic = k < statics;
        const body = new Body({
            mass: isStatic ? 0 : 1,
            shape: r() < 0.5 ? new Sphere(0.3 + r() * 1.5) : new Box(new Vec3(0.2 + r(), 0.2 + r(), 0.2 + r())),
        });
        body.position.set((r() - 0.5) * spread[0], r() * 4, (r() - 0.5) * spread[1]);
        world.addBody(body);
    }
    return world;
}

describe('CleoSAPBroadphase', () => {
    it('finds exactly the pairs a naive broadphase finds', () => {
        for (const seed of [1, 2, 3, 4, 5]) {
            const world = scene(seed, 150, 80, [60, 60]);
            const cleo = new CleoSAPBroadphase(world);
            const naive = new NaiveBroadphase();
            expect(pairsOf(world, cleo), `seed ${seed}`).toEqual(pairsOf(world, naive));
        }
    });

    it('stays correct along whichever axis the level spreads', () => {
        const world = scene(9, 120, 60, [4, 200]);
        const cleo = new CleoSAPBroadphase(world);
        expect(pairsOf(world, cleo)).toEqual(pairsOf(world, new NaiveBroadphase()));
        // A level long in Z: after the re-detect interval the sweep runs along Z.
        for (let i = 0; i < CleoSAPBroadphase.AXIS_REDETECT_STEPS; i++) pairsOf(world, cleo);
        expect((cleo as any).axisIndex).not.toBe(0);
        expect(pairsOf(world, cleo)).toEqual(pairsOf(world, new NaiveBroadphase()));
    });

    it('reads live positions, not a cached box, for a static body moved behind cannon\'s back', () => {
        // A trigger following its node, or a pooled foliage collider re-placed: position written, the
        // cached AABB left where the body used to be.
        const world = new World();
        const wall = new Body({ mass: 0, shape: new Box(new Vec3(1, 1, 1)) });
        wall.position.set(-50, 0, 0);
        world.addBody(wall);
        wall.updateAABB();
        const ball = new Body({ mass: 1, shape: new Sphere(0.5) });
        ball.position.set(30, 0, 0);
        world.addBody(ball);
        const cleo = new CleoSAPBroadphase(world);
        expect(pairsOf(world, cleo).size).toBe(0);
        wall.position.set(30.5, 0, 0);   // no aabbNeedsUpdate: the stale box stays at x = -50
        expect(pairsOf(world, cleo).size).toBe(1);
    });

    it('sorts by start (position minus bounding radius)', () => {
        const world = scene(4, 0, 50, [40, 40]);
        const list = world.bodies.slice().reverse();
        sortByStart(list, 0);
        for (let i = 1; i < list.length; i++)
            expect(list[i].position.x - list[i].boundingRadius).toBeGreaterThanOrEqual(list[i - 1].position.x - list[i - 1].boundingRadius);
    });

    it('skips static pairs without scanning the whole list for each static body', () => {
        // 400 statics spread along X, one dynamic body in the middle. cannon's loop let every static body
        // `continue` past every later static body, ~80k needBroadphaseCollision calls; a bounded sweep
        // only looks at neighbours.
        const world = new World();
        for (let k = 0; k < 400; k++) {
            const b = new Body({ mass: 0, shape: new Sphere(0.4) });
            b.position.set(k * 2, 0, 0);
            world.addBody(b);
        }
        const mover = new Body({ mass: 1, shape: new Sphere(0.5) });
        mover.position.set(400, 0, 0);
        world.addBody(mover);
        const cleo: any = new CleoSAPBroadphase(world);
        let calls = 0;
        const real = cleo.needBroadphaseCollision.bind(cleo);
        cleo.needBroadphaseCollision = (a: Body, b: Body) => { calls++; return real(a, b); };
        pairsOf(world, cleo);
        expect(calls).toBeLessThan(2000);
    });
});

import { describe, it, expect } from 'vitest';
import { Body, Box, Cylinder, Heightfield, Ray, RaycastResult, Sphere, Vec3, World } from 'cannon-es';
import {
    PILLAR_CACHE_LIMIT, cachedPillarCount, installHeightfieldCollision,
} from '../src/physics/heightfieldCollision';

// The terrain collision replacement (physics/heightfieldCollision.ts) must give the answers cannon's own
// heightfield resolvers gave, while touching only the cells a body or a ray actually reaches. These pin
// both halves: parity against stock cannon on seeded terrain, and the culls that make it cheap.

// cannon's own ray method, captured BEFORE anything installs the replacement on the shared prototype.
const STOCK_RAY = (Ray.prototype as any)._intersectHeightfield;
let ours: any = null;

/** Deterministic pseudo-random numbers (mulberry32). */
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

/** Rolling hills with some noise: n x n samples. */
function hills(n: number, seed: number): number[][] {
    const r = rng(seed);
    const data: number[][] = [];
    for (let i = 0; i < n; i++) {
        const col: number[] = [];
        for (let j = 0; j < n; j++) col.push(3 * Math.sin(i * 0.31) * Math.cos(j * 0.23) + 0.4 * r());
        data.push(col);
    }
    return data;
}

function flat(n: number, h: number): number[][] {
    return Array.from({ length: n }, () => Array.from({ length: n }, () => h));
}

/** A heightfield body placed the way Terrain places one: field XY (Z up) rotated onto world XZ (Y up). */
function terrainBody(data: number[][], elementSize = 1): Body {
    const body = new Body({ mass: 0 });
    body.addShape(new Heightfield(data, { elementSize }));
    body.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    const size = (data.length - 1) * elementSize;
    body.position.set(-size / 2, 0, size / 2);
    return body;
}

/** The closest hit of a segment against one body, with the ray method given. */
function castWith(method: any, body: Body, from: Vec3, to: Vec3): RaycastResult | null {
    const saved = (Ray.prototype as any)._intersectHeightfield;
    (Ray.prototype as any)._intersectHeightfield = method;
    try {
        const ray = new Ray(from, to);
        ray.mode = Ray.CLOSEST;
        const result = new RaycastResult();
        ray.intersectBody(body, result);
        return result.hasHit ? result : null;
    } finally {
        (Ray.prototype as any)._intersectHeightfield = saved;
    }
}

function world(): World {
    const w = new World();
    w.gravity.set(0, -9.81, 0);
    return w;
}

function oursWorld(): World {
    const w = world();
    installHeightfieldCollision(w);
    ours ??= (Ray.prototype as any)._intersectHeightfield;
    return w;
}

describe('heightfield rays', () => {
    oursWorld();
    const data = hills(40, 7);
    const body = terrainBody(data);

    /** Ground truth: march the segment finely and return the distance where it first dips under the surface. */
    const hf = body.shapes[0] as Heightfield;
    function reference(from: Vec3, to: Vec3): number | null {
        const lf = new Vec3(), lt = new Vec3();
        body.pointToLocalFrame(from, lf);
        body.pointToLocalFrame(to, lt);
        const steps = 20000, length = from.distanceTo(to), max = data.length - 1;
        for (let k = 0; k <= steps; k++) {
            const s = k / steps;
            const x = lf.x + (lt.x - lf.x) * s, y = lf.y + (lt.y - lf.y) * s, z = lf.z + (lt.z - lf.z) * s;
            if (x < 0 || y < 0 || x > max || y > max) continue;
            if (z <= hf.getHeightAt(x, y, true)) return s * length;
        }
        return null;
    }

    it('find the first surface crossing, including the nearer ones stock cannon skipped', () => {
        // Stock cannon's cell test (`getAabbAtIndex`) bounds a cell's height by two opposite corners only,
        // so it can skip the cell where a ray actually first meets the ground and report a farther one:
        // 4 rays in this 400 reported a hit up to 10 m too far. The replacement must match ground truth.
        const r = rng(11);
        let hits = 0, stockTooFar = 0;
        for (let k = 0; k < 400; k++) {
            const from = new Vec3((r() - 0.5) * 36, 4 + r() * 6, (r() - 0.5) * 36);
            const to = new Vec3((r() - 0.5) * 36, -4 - r() * 2, (r() - 0.5) * 36);
            const truth = reference(from, to);
            const stock = castWith(STOCK_RAY, body, from, to);
            const mine = castWith(ours, body, from, to);
            if (stock) expect(mine, `ray ${k}: stock hit, ours missed`).not.toBeNull();
            if (truth === null) continue;
            hits++;
            expect(mine, `ray ${k}`).not.toBeNull();
            // The march resolves to length / steps; anything within a few of those is the same crossing.
            expect(Math.abs(mine!.distance - truth)).toBeLessThan(0.01);
            if (stock && stock.distance > truth + 0.01) stockTooFar++;
            else if (stock) expect(mine!.hitNormalWorld.dot(stock.hitNormalWorld)).toBeGreaterThan(0.999);
        }
        expect(hits).toBeGreaterThan(300);
        expect(stockTooFar).toBeLessThan(hits / 20);
    });

    it('reports no hit for a segment that stops short of the ground', () => {
        expect(castWith(ours, body, new Vec3(0, 20, 0), new Vec3(0, 10, 0))).toBeNull();
    });

    it('hits along a grid line at near-axis directions, where stock cannon missed erratically', () => {
        // cameraRigNode.ts records the stock quirk: a ray starting ON a grid line and running almost exactly
        // along an axis missed the surface for some epsilons and not others.
        const level = terrainBody(flat(21, 0));
        for (const dz of [-1e-9, -1e-7, -1e-6, -1e-5, -1e-3]) {
            const hit = castWith(ours, level, new Vec3(0, 2, 0), new Vec3(0.0, -2, dz));
            expect(hit, `dz=${dz}`).not.toBeNull();
            expect(hit!.hitPointWorld.y).toBeCloseTo(0, 5);
        }
    });

    it('clips a ray that starts outside the field', () => {
        const level = terrainBody(flat(21, 1));
        const hit = castWith(ours, level, new Vec3(-30, 5, 0), new Vec3(5, -2, 0));
        expect(hit).not.toBeNull();
        expect(hit!.hitPointWorld.y).toBeCloseTo(1, 5);
    });
});

describe('heightfield contacts', () => {
    /** Step a world until `body` comes to rest, or for `seconds`. */
    function settle(w: World, seconds: number): void {
        for (let i = 0; i < seconds * 60; i++) w.step(1 / 60);
    }

    it('rests a sphere on level ground at exactly its radius', () => {
        const w = oursWorld();
        w.addBody(terrainBody(flat(21, 2)));
        const ball = new Body({ mass: 1, shape: new Sphere(0.5) });
        ball.position.set(0.3, 4, -0.7);
        w.addBody(ball);
        settle(w, 3);
        expect(ball.position.y).toBeCloseTo(2.5, 1);
        expect(Math.abs(ball.position.y - 2.5)).toBeLessThan(0.02);
    });

    it('keeps a rolling sphere on the surface of a slope', () => {
        // A tilted plane as a heightfield: 20 degrees toward +X in world space.
        const n = 41, slope = Math.tan(20 * Math.PI / 180);
        const data = Array.from({ length: n }, (_, i) => Array.from({ length: n }, () => (n - 1 - i) * slope));
        const w = oursWorld();
        const t = terrainBody(data);
        w.addBody(t);
        const ball = new Body({ mass: 1, shape: new Sphere(0.4), linearDamping: 0.5 });
        ball.position.set(-5, 20 * slope + 2, 0);
        w.addBody(ball);
        settle(w, 0.8);
        let worst = 0;
        for (let i = 0; i < 60; i++) {
            w.step(1 / 60);
            // Height of the plane under the ball, in world space: x runs from -20 to 20.
            const surface = (20 - ball.position.x) * slope;
            const gap = (ball.position.y - surface) * Math.cos(20 * Math.PI / 180);
            worst = Math.max(worst, Math.abs(gap - 0.4));
        }
        expect(worst).toBeLessThan(0.03);
    });

    it('rests a box and an upright cylinder at their half heights', () => {
        const w = oursWorld();
        w.addBody(terrainBody(flat(21, 1)));
        const box = new Body({ mass: 2, shape: new Box(new Vec3(0.5, 0.25, 0.5)) });
        box.position.set(-3, 3, 2);
        const cyl = new Body({ mass: 2, shape: new Cylinder(0.3, 0.3, 1.2, 12), angularDamping: 0.9 });
        cyl.position.set(3, 3, -2);
        w.addBody(box);
        w.addBody(cyl);
        settle(w, 3);
        expect(Math.abs(box.position.y - 1.25)).toBeLessThan(0.03);
        expect(Math.abs(cyl.position.y - 1.6)).toBeLessThan(0.03);
    });

    it('lands a box on hills where stock cannon lands it', () => {
        const data = hills(40, 3);
        const run = (install: boolean) => {
            const w = install ? oursWorld() : world();
            w.addBody(terrainBody(data));
            const box = new Body({ mass: 1, shape: new Box(new Vec3(0.4, 0.4, 0.4)), angularDamping: 0.6, linearDamping: 0.6 });
            box.position.set(4.2, 8, -3.1);
            w.addBody(box);
            settle(w, 2.5);
            return box.position.clone();
        };
        const stock = run(false), mine = run(true);
        expect(mine.distanceTo(stock)).toBeLessThan(0.35);
    });

    it('never SAT-tests a cylinder hovering above a high plateau', () => {
        // The capsule body: its 16-segment cylinder sits a cap radius above the ground, where no cell can
        // touch it. On terrain whose lowest point is far below (the Valley runs from -1 to 430 m), stock
        // cannon's pillars reached that lowest point, its bounding-sphere cull passed every cell, and it ran
        // convex-vs-convex against every cell under the cylinder, every step.
        const plateau = flat(21, 300);
        plateau[20][20] = 0;      // one low sample far away: the field's minimum
        plateau[12][10] = 300.45; // a bump ~1.8 m off, inside stock cannon's padded range, outside ours
        const count = (install: boolean) => {
            const w = install ? oursWorld() : world();
            w.gravity.set(0, 0, 0);
            w.addBody(terrainBody(plateau));
            const cyl = new Body({ mass: 1, shape: new Cylinder(0.3, 0.3, 1.2, 16) });
            cyl.position.set(0.2, 301.05, 0.4);
            w.addBody(cyl);
            const np: any = (w as any).narrowphase;
            const real = np.convexConvex;
            let calls = 0;
            np.convexConvex = function (...args: any[]) { calls++; return real.apply(this, args); };
            for (let i = 0; i < 10; i++) w.step(1 / 60);
            return calls;
        };
        expect(count(false)).toBeGreaterThan(0);
        expect(count(true)).toBe(0);
    });

    it('keeps its pillar cache bounded', () => {
        const w = oursWorld();
        w.gravity.set(0, 0, 0);
        const t = terrainBody(hills(80, 5));
        w.addBody(t);
        const box = new Body({ mass: 1, shape: new Box(new Vec3(3, 0.5, 3)) });
        w.addBody(box);
        const hf = t.shapes[0] as Heightfield;
        // Drag a large box over the whole field, low enough to touch it everywhere.
        for (let x = -38; x <= 38; x += 3) {
            for (let z = -38; z <= 38; z += 3) {
                box.position.set(x, 0, z);
                box.velocity.set(0, 0, 0);
                w.step(1 / 60);
            }
        }
        expect(cachedPillarCount(hf)).toBeGreaterThan(0);
        expect(cachedPillarCount(hf)).toBeLessThanOrEqual(PILLAR_CACHE_LIMIT);
    });
});

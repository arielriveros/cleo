import { describe, it, expect } from 'vitest';
import { createPhysicsWorld } from '../../src/physics/pal/createWorld';
import { PhysicsEventKind } from '../../src/physics/pal/types';
import type { BodyDesc, BodyHandle, PhysicsBackendKind, ShapeDesc } from '../../src/physics/pal/types';
import type { PhysicsWorld } from '../../src/physics/pal/world';

// What every physics backend must do, written against the layer's interface only (src/physics/pal/world.ts)
// and run once per backend. Behaviour, not bits: a new backend passes this before the engine runs on it.
// The bit-for-bit pins of the cannon backend are the golden traces (physicsGoldenTrace, physicsGoldenB).

const BACKENDS: PhysicsBackendKind[] = ['cannon'];
const H = 1 / 60;
const G = -9.82;

const IDENTITY = [0, 0, 0, 1] as const;

function body(world: PhysicsWorld, shape: ShapeDesc, position: [number, number, number], extra: Partial<BodyDesc> = {}): BodyHandle {
    return world.createBody({ position, rotation: IDENTITY, mass: 1, colliders: [{ shape }], ...extra });
}

function ground(world: PhysicsWorld, top = 0): BodyHandle {
    return body(world, { kind: 'box', halfExtents: [50, 0.5, 50] }, [0, top - 0.5, 0], { mass: 0 });
}

function pose(world: PhysicsWorld, h: BodyHandle): number[] { const out = new Array(7).fill(0); world.getTransform(h, out); return out; }
function velocity(world: PhysicsWorld, h: BodyHandle): number[] { const out = new Array(6).fill(0); world.getVelocity(h, out); return out; }
function run(world: PhysicsWorld, steps: number, dt = H): void { for (let i = 0; i < steps; i++) world.step(dt); }

describe.each(BACKENDS)('physics backend: %s', kind => {
    const make = () => createPhysicsWorld(kind, [0, G, 0]);

    describe('the world', () => {
        it('reports what it is', () => {
            const w = make();
            expect(w.backend).toBe(kind);
            expect(w.capabilities.backend).toBe(kind);
            expect(w.gravity).toEqual([0, G, 0]);
        });

        it('keeps a clock that steps advance and a taking-over world may set', () => {
            const w = make();
            run(w, 3);
            expect(w.time).toBeCloseTo(3 * H, 12);
            w.time = 10;
            w.step(H);
            expect(w.time).toBeCloseTo(10 + H, 12);
        });

        it('runs the pre-substep hook once per substep, with its length', () => {
            const w = make();
            const seen: number[] = [];
            w.onPreSubstep = dt => seen.push(dt);
            run(w, 3);
            expect(seen).toEqual([H, H, H]);
        });

        it('counts state changes, so a cache can tell when to re-read', () => {
            const w = make();
            const b = body(w, { kind: 'sphere', radius: 0.5 }, [0, 5, 0]);
            const v0 = w.stateVersion;
            w.step(H);
            const v1 = w.stateVersion;
            expect(v1).not.toBe(v0);
            w.setLinearVelocity(b, 1, 0, 0);
            expect(w.stateVersion).not.toBe(v1);
        });

        it('clears to empty, keeping gravity and settings', () => {
            const w = make();
            const a = body(w, { kind: 'sphere', radius: 0.5 }, [0, 5, 0]);
            const b = body(w, { kind: 'sphere', radius: 0.5 }, [0, 7, 0]);
            w.createJoint({ kind: 'ball', a, b, anchorA: [0, 1, 0], anchorB: [0, -1, 0] });
            w.clear();
            expect(w.bodyCount).toBe(0);
            expect(w.bodies()).toEqual([]);
            expect(w.hasBody(a)).toBe(false);
            expect(w.gravity).toEqual([0, G, 0]);
        });
    });

    describe('bodies', () => {
        it('are listed in the order they were made, until destroyed', () => {
            const w = make();
            const a = body(w, { kind: 'sphere', radius: 0.5 }, [0, 0, 0]);
            const b = body(w, { kind: 'box', halfExtents: [0.5, 0.5, 0.5] }, [2, 0, 0]);
            expect(w.bodies()).toEqual([a, b]);
            expect(w.bodyCount).toBe(2);
            w.destroyBody(a);
            expect(w.hasBody(a)).toBe(false);
            expect(w.hasBody(b)).toBe(true);
            expect(w.bodies()).toEqual([b]);
        });

        it('sit where they were made: the node origin, whatever their colliders', () => {
            const w = make();
            const q = [0, Math.sin(0.3), 0, Math.cos(0.3)] as const;
            const b = w.createBody({
                position: [1, 2, 3], rotation: q, mass: 4,
                colliders: [{ shape: { kind: 'box', halfExtents: [0.5, 0.25, 0.5] }, offset: [0.6, 0.3, 0] }],
            });
            const p = pose(w, b);
            for (let i = 0; i < 3; i++) expect(p[i]).toBeCloseTo([1, 2, 3][i], 12);
            for (let i = 0; i < 4; i++) expect(p[3 + i]).toBeCloseTo(q[i], 12);
        });

        it('put the mass at the colliders by default, at the origin when asked', () => {
            const w = make();
            const at = (centerOfMass: 'colliders' | 'origin') => {
                const b = w.createBody({
                    position: [0, 0, 0], rotation: IDENTITY, mass: 2, centerOfMass,
                    colliders: [{ shape: { kind: 'sphere', radius: 0.5 }, offset: [1, 0, 0] }],
                });
                return w.getMassProperties(b, { mass: 0, centerOfMass: [0, 0, 0], inertia: [0, 0, 0] });
            };
            const recentred = at('colliders');
            expect(recentred.mass).toBe(2);
            expect(recentred.centerOfMass[0]).toBeCloseTo(1, 9);
            expect(at('origin').centerOfMass).toEqual([0, 0, 0]);
        });

        it('move and turn about their node origin', () => {
            const w = make();
            const b = w.createBody({
                position: [0, 0, 0], rotation: IDENTITY, mass: 1,
                colliders: [{ shape: { kind: 'sphere', radius: 0.5 }, offset: [1, 0, 0] }],
            });
            w.setTransform(b, [5, 6, 7], null);
            expect(pose(w, b).slice(0, 3).map(v => +v.toFixed(9))).toEqual([5, 6, 7]);
            const half = Math.SQRT1_2;
            w.setTransform(b, null, [0, half, 0, half]);
            const p = pose(w, b);
            expect(p.slice(0, 3).map(v => +v.toFixed(9))).toEqual([5, 6, 7]);
            // The collider swung round the origin: its bounds moved to −Z.
            const box = new Array(6).fill(0);
            w.getAabb(b, box);
            expect((box[2] + box[5]) / 2).toBeCloseTo(6, 6);
            expect((box[2] + box[5]) / 2).not.toBeCloseTo(7, 1);
        });

        it('fall under gravity', () => {
            const w = make();
            const b = body(w, { kind: 'sphere', radius: 0.5 }, [0, 10, 0], { linearDamping: 0 });
            run(w, 60);
            const y = pose(w, b)[1];
            // Semi-implicit Euler over 60 steps of 1/60 s: within a few cm of ½gt².
            expect(y).toBeLessThan(10 + 0.5 * G * 1 + 0.1);
            expect(y).toBeGreaterThan(10 + 0.5 * G * 1 - 0.1);
            expect(velocity(w, b)[1]).toBeCloseTo(G, 6);
        });

        it('take an impulse through the centre of mass as a change of velocity', () => {
            const w = make();
            w.gravity = [0, 0, 0];
            const b = body(w, { kind: 'sphere', radius: 0.5 }, [0, 0, 0], { mass: 2 });
            w.applyImpulse(b, [4, 0, 0]);
            expect(velocity(w, b)).toEqual([2, 0, 0, 0, 0, 0]);
        });

        it('spend a force over the next substep only', () => {
            const w = make();
            w.gravity = [0, 0, 0];
            const b = body(w, { kind: 'sphere', radius: 0.5 }, [0, 0, 0], { mass: 2, linearDamping: 0 });
            w.applyForce(b, [120, 0, 0]);
            w.step(H);
            const after1 = velocity(w, b)[0];
            expect(after1).toBeCloseTo(120 / 2 * H, 9);
            w.step(H);
            expect(velocity(w, b)[0]).toBeCloseTo(after1, 12);
        });

        it('hold a written velocity', () => {
            const w = make();
            w.gravity = [0, 0, 0];
            const b = body(w, { kind: 'sphere', radius: 0.5 }, [0, 0, 0], { linearDamping: 0, angularDamping: 0 });
            w.setLinearVelocity(b, 3, 0, 0);
            w.setAngularVelocity(b, 0, 1, 0);
            run(w, 30);
            expect(pose(w, b)[0]).toBeCloseTo(1.5, 6);
            expect(velocity(w, b)[4]).toBeCloseTo(1, 6);
        });

        it('stay put while asleep, and move again once woken', () => {
            const w = make();
            const b = body(w, { kind: 'sphere', radius: 0.5 }, [0, 10, 0]);
            w.sleep(b);
            expect(w.isSleeping(b)).toBe(true);
            run(w, 30);
            expect(pose(w, b)[1]).toBe(10);
            w.wakeUp(b);
            expect(w.isSleeping(b)).toBe(false);
            run(w, 30);
            expect(pose(w, b)[1]).toBeLessThan(10);
        });

        it('step out of the world while disabled, keeping handle and state, and come back', () => {
            const w = make();
            const b = body(w, { kind: 'sphere', radius: 0.5 }, [0, 10, 0]);
            const other = body(w, { kind: 'sphere', radius: 0.5 }, [5, 10, 0]);
            w.setEnabled(b, false);
            expect(w.hasBody(b)).toBe(true);
            expect(w.isEnabled(b)).toBe(false);
            expect(w.bodies()).toEqual([other]);
            run(w, 30);
            expect(pose(w, b)[1]).toBe(10);                     // not stepped
            let hit = false;
            w.raycast([0, 20, 0], [0, 0, 0], { mode: 'all' }, h => { if (h.body === b) hit = true; });
            expect(hit).toBe(false);                            // not queried
            w.setTransform(b, [0, 4, 0], null);                 // still writable
            expect(pose(w, b)[1]).toBeCloseTo(4, 12);
            w.setEnabled(b, true);
            expect(w.bodies()).toEqual([other, b]);             // last in order
            run(w, 30);
            expect(pose(w, b)[1]).toBeLessThan(4);
        });

        it('only collide with the layers both masks allow', () => {
            const w = make();
            const floor = ground(w);
            const ghost = body(w, { kind: 'sphere', radius: 0.5 }, [0, 1, 0]);
            w.setCollisionFilter(ghost, 2, ~1);                 // not in, and not colliding with, layer 1
            run(w, 60);
            expect(pose(w, ghost)[1]).toBeLessThan(0);
            void floor;
        });

        it('honour axis locks', () => {
            const w = make();
            const b = body(w, { kind: 'sphere', radius: 0.5 }, [0, 10, 0], { linearFactor: [1, 0, 1] });
            run(w, 30);
            expect(pose(w, b)[1]).toBe(10);
        });
    });

    describe('shapes', () => {
        // Each one dropped on the ground settles where its own extent says it should.
        const rest: [string, ShapeDesc, number][] = [
            ['sphere', { kind: 'sphere', radius: 0.4 }, 0.4],
            ['box', { kind: 'box', halfExtents: [0.5, 0.3, 0.5] }, 0.3],
            ['capsule', { kind: 'capsule', radius: 0.3, height: 1, segments: 12 }, 0.8],
            ['cylinder', { kind: 'cylinder', radiusTop: 0.4, radiusBottom: 0.4, height: 1.2, segments: 12 }, 0.6],
            ['convex', {
                kind: 'convex',
                vertices: [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5], [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]],
                faces: [[3, 2, 1, 0], [4, 5, 6, 7], [5, 4, 0, 1], [2, 3, 7, 6], [0, 4, 7, 3], [1, 2, 6, 5]],
            }, 0.5],
        ];
        for (const [name, shape, half] of rest) {
            it(`rests a ${name} on the ground at its own half-height`, () => {
                const w = make();
                ground(w);
                const b = body(w, shape, [0, half + 0.3, 0], { angularFactor: [0, 0, 0] });
                run(w, 120);
                expect(pose(w, b)[1]).toBeGreaterThan(half - 0.05);
                expect(pose(w, b)[1]).toBeLessThan(half + 0.02);
            });
        }

        it('lays a plane facing +Y through its origin', () => {
            const w = make();
            body(w, { kind: 'plane' }, [0, 1, 0], { mass: 0 });
            const b = body(w, { kind: 'sphere', radius: 0.5 }, [0, 3, 0]);
            run(w, 120);
            expect(pose(w, b)[1]).toBeCloseTo(1.5, 1);
        });

        it('lays a heightfield along +X and −Z with its heights up', () => {
            const w = make();
            const heights = Array.from({ length: 6 }, () => Array(6).fill(0.5));
            body(w, { kind: 'heightfield', heights, elementSize: 1 }, [0, 0, 0], { mass: 0 });
            // Inside the field: x in [0, 5], z in [−5, 0].
            const b = body(w, { kind: 'sphere', radius: 0.3 }, [2.5, 2, -2.5]);
            run(w, 120);
            expect(pose(w, b)[1]).toBeCloseTo(0.8, 1);
            // Outside it (z > 0) there is nothing to land on.
            const miss = body(w, { kind: 'sphere', radius: 0.3 }, [2.5, 2, 2.5]);
            run(w, 60);
            expect(pose(w, miss)[1]).toBeLessThan(0);
        });
    });

    describe('collider geometry', () => {
        const rotate = (q: ArrayLike<number>, v: ArrayLike<number>) => {
            const [x, y, z, w] = [q[0], q[1], q[2], q[3]];
            const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
            return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
        };
        const worldCentre = (frame: number[], offset: ArrayLike<number>) => {
            const r = rotate([frame[3], frame[4], frame[5], frame[6]], offset);
            return [frame[0] + r[0], frame[1] + r[1], frame[2] + r[2]];
        };

        it('places every part where its collider is, inside the frame bounding radius', () => {
            const w = make();
            const q = [0, Math.sin(0.3), 0, Math.cos(0.3)] as const;
            const b = w.createBody({
                position: [1, 2, 3], rotation: q, mass: 2,
                colliders: [
                    { shape: { kind: 'box', halfExtents: [0.5, 0.25, 0.5] }, offset: [0.6, 0.3, 0] },
                    { shape: { kind: 'sphere', radius: 0.2 }, offset: [-0.5, 0, 0] },
                ],
            });
            const frame = new Array(7).fill(0);
            const radius = w.getColliderFrame(b, frame);
            const parts = w.colliderParts(b);
            expect(w.colliderParts(b)).toBe(parts);
            const expected = (offset: number[]) => { const r = rotate(q, offset); return [1 + r[0], 2 + r[1], 3 + r[2]]; };
            const box = parts.find(p => p.shape.kind === 'box')!, ball = parts.find(p => p.shape.kind === 'sphere')!;
            worldCentre(frame, box.offset).forEach((v, i) => expect(v).toBeCloseTo(expected([0.6, 0.3, 0])[i], 9));
            worldCentre(frame, ball.offset).forEach((v, i) => expect(v).toBeCloseTo(expected([-0.5, 0, 0])[i], 9));
            for (const part of parts) {
                const c = worldCentre(frame, part.offset);
                expect(Math.hypot(c[0] - frame[0], c[1] - frame[1], c[2] - frame[2]) + part.boundingRadius).toBeLessThanOrEqual(radius + 1e-9);
            }
        });

        it('reports a capsule natively, or as the cylinder and two caps it simulates', () => {
            const w = make();
            const b = body(w, { kind: 'capsule', radius: 0.3, height: 1 }, [0, 0, 0]);
            const kinds = w.colliderParts(b).map(p => p.shape.kind).sort();
            if (w.capabilities.nativeCapsule) expect(kinds).toEqual(['capsule']);
            else expect(kinds).toEqual(['cylinder', 'sphere', 'sphere']);
        });
    });

    describe('contacts and events', () => {
        it('reports a resting contact with the normal pointing out of the first body', () => {
            const w = make();
            const g = ground(w);
            const b = body(w, { kind: 'sphere', radius: 0.5 }, [0, 0.55, 0]);
            run(w, 30);
            let found = 0;
            w.forEachContact((a, c, nx, ny, nz) => {
                if (!((a === g && c === b) || (a === b && c === g))) return;
                found++;
                // Out of the ground is up; out of the sphere is down.
                const up = a === g ? ny : -ny;
                expect(up).toBeGreaterThan(0.99);
                expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 6);
            });
            expect(found).toBeGreaterThan(0);
            expect(w.contactCount).toBeGreaterThan(0);
        });

        it('reports a body entering and leaving a sensor, in order', () => {
            const w = make();
            const zone = body(w, { kind: 'box', halfExtents: [1, 1, 1] }, [0, 0, 0], { mass: 0, sensor: true });
            const ball = body(w, { kind: 'sphere', radius: 0.2 }, [0, 3, 0]);
            const log: string[] = [];
            const name = (h: BodyHandle) => (h === zone ? 'zone' : h === ball ? 'ball' : '?');
            for (let i = 0; i < 90; i++) {
                w.step(H);
                w.drainEvents((kind, a, b) => log.push(`${kind === PhysicsEventKind.SensorBegin ? 'begin' : 'end'} ${[name(a), name(b)].sort().join('+')}`));
            }
            expect(log).toEqual(['begin ball+zone', 'end ball+zone']);
            // Nothing pushed it: it fell straight through.
            expect(velocity(w, ball)[1]).toBeLessThan(-5);
        });

        it('drops the queued events of a body destroyed before they were drained', () => {
            const w = make();
            body(w, { kind: 'box', halfExtents: [1, 1, 1] }, [0, 0, 0], { mass: 0, sensor: true });
            const ball = body(w, { kind: 'sphere', radius: 0.2 }, [0, 0, 0]);
            w.step(H);
            w.destroyBody(ball);
            let events = 0;
            w.drainEvents(() => events++);
            expect(events).toBe(0);
        });
    });

    describe('rays', () => {
        function scene() {
            const w = make();
            w.gravity = [0, 0, 0];
            const near = body(w, { kind: 'box', halfExtents: [0.5, 0.5, 0.5] }, [0, 0, 2], { mass: 0 });
            const ghost = body(w, { kind: 'box', halfExtents: [0.5, 0.5, 0.5] }, [0, 0, 4], { mass: 0, collisionResponse: false });
            const moving = body(w, { kind: 'sphere', radius: 0.5 }, [0, 0, 6]);
            const far = body(w, { kind: 'box', halfExtents: [0.5, 0.5, 0.5] }, [0, 0, 8], { mass: 0 });
            return { w, near, ghost, moving, far };
        }
        const cast = (w: PhysicsWorld, mode: 'all' | 'closest', opts: object = {}) => {
            const hits: { body: BodyHandle; distance: number; normal: number[] }[] = [];
            w.raycast([0, 0, 0], [0, 0, 10], { mode, ...opts }, h => hits.push({ body: h.body, distance: h.distance, normal: [...h.normal] }));
            return hits;
        };

        it('finds every solid body along the segment, at the right distance and facing back', () => {
            const { w, near, moving, far } = scene();
            // A body may be hit more than once (its entry and its exit face): the nearest hit of each counts.
            const hits = cast(w, 'all').sort((a, b) => a.distance - b.distance);
            expect([...new Set(hits.map(h => h.body))]).toEqual([near, moving, far]);
            expect(hits[0].distance).toBeCloseTo(1.5, 6);
            expect(hits[0].normal[2]).toBeCloseTo(-1, 6);
        });

        it('reports only the nearest in closest mode', () => {
            const { w, near } = scene();
            const hits = cast(w, 'closest');
            expect(hits.map(h => h.body)).toEqual([near]);
        });

        it('lets bodies without collision response through unless asked for them', () => {
            const { w, ghost } = scene();
            expect(cast(w, 'all').some(h => h.body === ghost)).toBe(false);
            expect(cast(w, 'all', { includeNoResponse: true }).some(h => h.body === ghost)).toBe(true);
        });

        it('skips dynamic bodies when asked', () => {
            const { w, near, moving, far } = scene();
            const hits = cast(w, 'all', { excludeDynamic: true }).map(h => h.body);
            expect(hits).toContain(near);
            expect(hits).toContain(far);
            expect(hits).not.toContain(moving);
            expect(cast(w, 'closest', { excludeDynamic: true }).map(h => h.body)).toEqual([near]);
        });
    });

    describe('joints', () => {
        /** A static anchor and a dynamic bob hanging below it, both spheres. */
        function pendulum(w: PhysicsWorld) {
            const anchor = body(w, { kind: 'sphere', radius: 0.05 }, [0, 5, 0], { mass: 0 });
            const bob = body(w, { kind: 'sphere', radius: 0.1 }, [0, 4, 0], { mass: 1 });
            return { anchor, bob };
        }

        it('ball: keeps the anchors together', () => {
            const w = make();
            const { anchor, bob } = pendulum(w);
            w.setLinearVelocity(bob, 3, 0, 0);
            w.createJoint({ kind: 'ball', a: anchor, b: bob, anchorA: [0, -0.5, 0], anchorB: [0, 0.5, 0] });
            run(w, 120);
            // The bob swings and turns, but its anchor stays on the static one's, half a metre below it.
            const p = pose(w, bob);
            expect(Math.hypot(p[0], p[1] - 4.5, p[2])).toBeCloseTo(0.5, 2);
        });

        it('hinge: swings only about its axis', () => {
            const w = make();
            const { anchor, bob } = pendulum(w);
            w.setLinearVelocity(bob, 2, 0, 2);
            w.createJoint({ kind: 'hinge', a: anchor, b: bob, anchorA: [0, -0.5, 0], anchorB: [0, 0.5, 0], axisA: [0, 0, 1], axisB: [0, 0, 1] });
            run(w, 60);
            expect(Math.abs(pose(w, bob)[2])).toBeLessThan(0.05);
        });

        it('fixed: holds the pose it was made in', () => {
            const w = make();
            const { anchor, bob } = pendulum(w);
            w.createJoint({ kind: 'fixed', a: anchor, b: bob });
            run(w, 60);
            expect(pose(w, bob)[1]).toBeCloseTo(4, 2);
        });

        it('cone-twist: keeps the bob within its cone', () => {
            const w = make();
            const { anchor, bob } = pendulum(w);
            w.setLinearVelocity(bob, 6, 0, 0);
            w.createJoint({
                kind: 'coneTwist', a: anchor, b: bob, anchorA: [0, -0.5, 0], anchorB: [0, 0.5, 0],
                axisA: [0, -1, 0], axisB: [0, -1, 0], coneAngle: 0.3, twistAngle: 0.1,
            });
            let widest = 0;
            for (let i = 0; i < 120; i++) { w.step(H); const p = pose(w, bob); widest = Math.max(widest, Math.atan2(Math.hypot(p[0], p[2]), 5 - p[1])); }
            expect(widest).toBeLessThan(0.45);
        });

        it('lets go once destroyed', () => {
            const w = make();
            const { anchor, bob } = pendulum(w);
            const j = w.createJoint({ kind: 'ball', a: anchor, b: bob, anchorA: [0, -0.5, 0], anchorB: [0, 0.5, 0] });
            w.destroyJoint(j);
            run(w, 60);
            expect(pose(w, bob)[1]).toBeLessThan(0);
        });
    });
});

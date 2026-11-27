import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { acquirePhysicsBackend, createPhysicsWorld, createWorldMirror, createWorldReplica } from '../../src/physics/pal/createWorld';
import type { BodyDesc, BodyHandle, JointHandle, ShapeDesc } from '../../src/physics/pal/types';
import type { PhysicsWorld } from '../../src/physics/pal/world';
import type { JoltWorld } from '../../src/physics/pal/jolt/joltWorld';
import { jolt } from '../../src/physics/pal/jolt/load';
import { ragdollJointPriorities } from '../../src/physics/pal/ragdollPlan';
import { groundWorld, humanoidModel } from '../helpers/humanoidRig';
import type { PhysicsSystem } from '../../src/physics/physicsSystem';

// Jolt's ragdoll tools in the physics layer (pal/ragdollPlan.ts, jolt/joltRagdollPlan.ts, capabilities
// ragdollPlanning and kinematicParts): bodies switched kinematic and back, swept bodies, self-collision by part
// pairs, asymmetric twist, joint priorities and position steps, motors that follow a turning target, and the
// planner a powered ragdoll is built from on Jolt.

const H = 1 / 60;
const IDENTITY = [0, 0, 0, 1] as const;

function body(world: PhysicsWorld, shape: ShapeDesc, position: [number, number, number], extra: Partial<BodyDesc> = {}): BodyHandle {
    return world.createBody({ position, rotation: IDENTITY, mass: 1, colliders: [{ shape }], ...extra });
}
function pose(world: PhysicsWorld, h: BodyHandle): number[] { const out = new Array(7).fill(0); world.getTransform(h, out); return out; }
function velocity(world: PhysicsWorld, h: BodyHandle): number[] { const out = new Array(6).fill(0); world.getVelocity(h, out); return out; }
function run(world: PhysicsWorld, steps: number, dt = H): void { for (let i = 0; i < steps; i++) world.step(dt); }
const aboutX = (angle: number) => [Math.sin(angle / 2), 0, 0, Math.cos(angle / 2)];
/** A rotation's angle about X, signed (a body turned only about X). */
const twistX = (q: ArrayLike<number>) => 2 * Math.atan2(q[3] < 0 ? -q[0] : q[0], Math.abs(q[3]));

describe('Jolt ragdoll tools in the physics layer', () => {
    beforeAll(async () => { await acquirePhysicsBackend('jolt'); });
    const made: PhysicsWorld[] = [];
    const make = (gravity: [number, number, number] = [0, -9.82, 0]) => { const w = createPhysicsWorld('jolt', gravity); made.push(w); return w; };
    const systems: PhysicsSystem[] = [];
    afterEach(() => { for (const w of made.splice(0)) w.dispose(); for (const p of systems.splice(0)) p.dispose(); });

    it('says what it can do', () => {
        const c = make().capabilities;
        expect([c.ragdollPlanning, c.kinematicParts]).toEqual([true, true]);
        expect(createPhysicsWorld('cannon', [0, -9.82, 0]).capabilities.ragdollPlanning).toBe(false);
    });

    describe('kinematic and back (setBodyType)', () => {
        it('keeps its velocity both ways, gravity off it while kinematic, and nothing pushes it', () => {
            const w = make();
            const h = body(w, { kind: 'box', halfExtents: [0.2, 0.2, 0.2] }, [0, 5, 0], { mass: 3 });
            w.setLinearVelocity(h, 1, 2, 0);
            w.setBodyType!(h, 'kinematic');
            expect(w.isDynamic(h)).toBe(false);
            run(w, 30);
            // Moved by its velocity alone: no gravity, the velocity as given.
            expect(velocity(w, h).slice(0, 3).map(v => +v.toFixed(4))).toEqual([1, 2, 0]);
            expect(pose(w, h)[1]).toBeCloseTo(5 + 2 * 30 * H, 3);
            // A ball dropped on it bounces off; it does not move.
            const ball = body(w, { kind: 'sphere', radius: 0.1 }, [pose(w, h)[0], pose(w, h)[1] + 0.35, 0], { mass: 20 });
            w.setLinearVelocity(h, 0, 0, 0);
            const at = pose(w, h);
            run(w, 30);
            expect(pose(w, h).slice(0, 3)).toEqual(at.slice(0, 3));
            void ball;
            w.setLinearVelocity(h, 0.5, 0, 0);
            w.setBodyType!(h, 'dynamic');
            expect(w.isDynamic(h)).toBe(true);
            expect(velocity(w, h)[0]).toBeCloseTo(0.5, 5);
            const mass = w.getMassProperties(h, { mass: 0, centerOfMass: [0, 0, 0], inertia: [0, 0, 0] }).mass;
            expect(mass).toBeCloseTo(3, 5);
            run(w, 10);
            expect(velocity(w, h)[1]).toBeLessThan(-1);
        });

        // Switched after its copy was made, and before (the copy then built from a kinematic description, which must
        // keep the body's mass to be dynamic again: it stayed kinematic, flying on at its last velocity, its joints
        // stretched after it).
        for (const switchAt of [5, 0]) it(`a body switched kinematic (frame ${switchAt}) and moved by its velocity steps in the worker as in the world itself, and comes back`, () => {
            const scene = (w: PhysicsWorld) => {
                body(w, { kind: 'box', halfExtents: [20, 0.5, 20] }, [0, -0.5, 0], { mass: 0 });
                const leg = body(w, { kind: 'box', halfExtents: [0.1, 0.4, 0.1] }, [0, 1, 0], { mass: 5 });
                const arm = body(w, { kind: 'box', halfExtents: [0.05, 0.3, 0.05] }, [0, 1.7, 0], { mass: 2 });
                const j = w.createJoint({ kind: 'coneTwist', a: arm, b: leg, anchorA: [0, -0.3, 0], anchorB: [0, 0.4, 0], axisA: [0, 1, 0], axisB: [0, 1, 0], coneAngle: 0.8, twistAngle: 0.5 });
                w.setJointDrive(j, { frequency: 5, damping: 1, maxTorque: 200, gravityCompensation: 1 }, [arm]);
                return { leg, arm, j };
            };
            const inline = make(), original = make();
            const a = scene(inline), b = scene(original);
            const mirror = createWorldMirror(original), replica = createWorldReplica('jolt');
            made.push(replica.world);
            for (let frame = 0; frame < 120; frame++) {
                for (const [w, s] of [[inline, a], [original, b]] as const) {
                    if (frame === switchAt) w.setBodyType!(s.leg, 'kinematic');
                    if (frame >= switchAt && frame < 90) w.setLinearVelocity(s.leg, 1.2, 0, 0.4 * Math.sin(frame * 0.1));
                    if (frame >= switchAt && frame < 90) w.setAngularVelocity(s.leg, 0, 0.8, 0);
                    if (frame === 90) w.setBodyType!(s.leg, 'dynamic');
                    w.setJointTarget(s.j, aboutX(0.4 * Math.sin(frame * 0.05)), [0.02 * Math.cos(frame * 0.05), 0, 0]);
                }
                inline.step(H);
                const diff = mirror.diff();
                replica.receive(structuredClone(diff.changes));
                replica.world.gravity = original.gravity;
                replica.world.time = original.time;
                replica.world.step(H);
                const rows = replica.report(bytes => new ArrayBuffer(bytes));
                mirror.apply(structuredClone({ ...rows, events: new Int32Array(0), time: replica.world.time }), () => {});
                // While kinematic the copy reports it back, so the world sees it move.
                if (frame === 60) expect(pose(original, b.leg)[0]).toBeGreaterThan(0.8);
            }
            for (const key of ['leg', 'arm'] as const) {
                expect(pose(original, b[key]), key).toEqual(pose(inline, a[key]));
                expect(velocity(original, b[key]), key).toEqual(velocity(inline, a[key]));
            }
            // Dynamic again in the copy too: it fell to the ground.
            expect(pose(original, b.leg)[1]).toBeLessThan(0.6);
        });
    });

    it('sweeps a body given linearCast: a fast small ball stops at a thin wall it would pass through', () => {
        const shoot = (quality?: 'linearCast') => {
            const w = make([0, 0, 0]);
            body(w, { kind: 'box', halfExtents: [2, 2, 0.02] }, [0, 0, 5], { mass: 0 });
            const ball = body(w, { kind: 'sphere', radius: 0.05 }, [0, 0, 0], { mass: 0.3, ...(quality ? { motionQuality: quality } : {}) });
            w.setLinearVelocity(ball, 0, 0, 120);
            run(w, 10);
            return pose(w, ball)[2];
        };
        expect(shoot()).toBeGreaterThan(5);
        expect(shoot('linearCast')).toBeLessThan(5);
    });

    describe('self-collision by part pairs (selfFilter)', () => {
        const pair = (ignoreEach: boolean, groups: [number, number] = [7, 7]) => {
            const w = make([0, 0, 0]);
            const a = body(w, { kind: 'sphere', radius: 0.3 }, [0, 0, 0], { selfFilter: { group: groups[0], index: 0, ignore: ignoreEach ? 1 << 1 : 0 } });
            const b = body(w, { kind: 'sphere', radius: 0.3 }, [0.2, 0, 0], { selfFilter: { group: groups[1], index: 1, ignore: ignoreEach ? 1 << 0 : 0 } });
            run(w, 20);
            return pose(w, b)[0] - pose(w, a)[0];
        };
        it('keeps two parts of one group it says ignore each other apart from colliding, and no others', () => {
            expect(pair(true)).toBeCloseTo(0.2, 4);
            expect(pair(false)).toBeGreaterThan(0.5);
            // Of two groups (two ragdolls), the same sub-groups collide.
            expect(pair(true, [7, 8])).toBeGreaterThan(0.5);
        });
        it('frees each group\'s table with its last body: 200 ragdolls made and gone leave nothing', () => {
            const w = make([0, 0, 0]) as unknown as JoltWorld;
            const J = jolt();
            const free = () => J.JoltInterface.prototype.sGetFreeMemory();
            const before = free();
            for (let g = 1; g <= 200; g++) {
                const hs: BodyHandle[] = [];
                for (let i = 0; i < 16; i++) hs.push(body(w, { kind: 'sphere', radius: 0.1 }, [g, i, 0], { selfFilter: { group: g, index: i, ignore: (1 << ((i + 1) % 16)) | (i > 0 ? 1 << (i - 1) : 0) } }));
                for (const h of hs) w.destroyBody(h);
            }
            expect((w as any)._native.groups.size).toBe(0);
            expect(before - free()).toBeLessThan(256 * 1024);
        });
    });

    describe('joints', () => {
        it('a cone-twist turns its A between twistMin and twistMax relative to B, one-sided', () => {
            const w = make([0, 0, 0]);
            const base = body(w, { kind: 'box', halfExtents: [0.2, 0.2, 0.2] }, [0, 0, 0], { mass: 0 });
            const arm = body(w, { kind: 'box', halfExtents: [0.2, 0.05, 0.05] }, [0, 0, 0], { mass: 1, angularDamping: 0 });
            w.createJoint({
                kind: 'coneTwist', a: arm, b: base, anchorA: [0, 0, 0], anchorB: [0, 0, 0], axisA: [1, 0, 0], axisB: [1, 0, 0],
                coneAngle: 0.03, twistAngle: Math.PI, twistMin: 0.2, twistMax: 0.7, rest: IDENTITY,
            });
            w.setAngularVelocity(arm, 3, 0, 0);
            run(w, 60);
            expect(twistX(pose(w, arm).slice(3))).toBeCloseTo(0.7, 1);
            w.setAngularVelocity(arm, -3, 0, 0);
            run(w, 60);
            expect(twistX(pose(w, arm).slice(3))).toBeCloseTo(0.2, 1);
        });

        it('takes its priority and its position steps onto the constraint', () => {
            const w = make() as unknown as JoltWorld;
            const a = body(w, { kind: 'sphere', radius: 0.1 }, [0, 1, 0]), b = body(w, { kind: 'sphere', radius: 0.1 }, [0, 2, 0], { mass: 0 });
            const j = w.createJoint({ kind: 'ball', a, b, anchorA: [0, 0.5, 0], anchorB: [0, -0.5, 0], priority: 7, positionIterations: 5 });
            const c = (w as any)._joints.get(j).constraint;
            expect([c.GetConstraintPriority(), c.GetNumPositionStepsOverride()]).toEqual([7, 5]);
            const plain = (w as any)._joints.get(w.createJoint({ kind: 'ball', a, b, anchorA: [0, 0, 0], anchorB: [0, 0, 0] })).constraint;
            expect([plain.GetConstraintPriority(), plain.GetNumPositionStepsOverride()]).toEqual([0, 0]);
        });
    });

    describe('motors that follow a turning target', () => {
        // A rod driven about X toward a target turning at a steady 2 rad/s: given the target's spin, the motor keeps
        // up (a hinge drives position and velocity together; a cone's target is led along the spin); without it, a
        // critically damped spring trails by 2ζω/Ω.
        for (const kind of ['hinge', 'coneTwist'] as const) {
            it(`a ${kind} motor given the target's spin trails it by far less`, () => {
                const lag = (spin: boolean) => {
                    const w = make([0, 0, 0]);
                    const anchor = body(w, { kind: 'sphere', radius: 0.05 }, [0, 0, 0], { mass: 0 });
                    const rod = body(w, { kind: 'box', halfExtents: [0.05, 0.4, 0.05] }, [0, -0.4, 0], { mass: 2, angularDamping: 0 });
                    const j: JointHandle = kind === 'hinge'
                        ? w.createJoint({ kind: 'hinge', a: rod, b: anchor, anchorA: [0, 0.4, 0], anchorB: [0, 0, 0], axisA: [1, 0, 0], axisB: [1, 0, 0] })
                        : w.createJoint({ kind: 'coneTwist', a: rod, b: anchor, anchorA: [0, 0.4, 0], anchorB: [0, 0, 0], axisA: [0, -1, 0], axisB: [0, -1, 0], coneAngle: 2.5, twistAngle: 1 });
                    w.setJointDrive(j, { frequency: 4, damping: 1, maxTorque: 500 }, [rod]);
                    const omega = 2;
                    let worst = 0;
                    for (let f = 0; f < 50; f++) {
                        const t = (f + 1) * H, target = omega * t;
                        w.setJointTarget(j, aboutX(target), spin ? [omega, 0, 0] : null);
                        w.step(H);
                        if (f > 30) worst = Math.max(worst, Math.abs(twistX(pose(w, rod).slice(3)) - target));
                    }
                    return worst;
                };
                const without = lag(false), withSpin = lag(true);
                expect(without).toBeGreaterThan(0.08);
                expect(withSpin).toBeLessThan(without * 0.35);
            });
        }

        /**
         * A limb hanging off its cone's centre (an arm from the shoulder, 40° out), its target swinging about Z only
         * (±26° at 1 Hz, no twist), driven at 5 Hz: the worst twist about the limb's own axis against the target,
         * and the worst angle off it in all, with the target's spin given or not. B is a static anchor, or a body
         * free to turn (a chest).
         */
        const offCentre = (spin: boolean, dynamicB: boolean, twisting = false) => {
            const w = make();
            const mul = (a: number[], b: number[]) => [
                a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
                a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
            const conj = (q: number[]) => [-q[0], -q[1], -q[2], q[3]];
            const about = (axis: number[], a: number) => [axis[0] * Math.sin(a / 2), axis[1] * Math.sin(a / 2), axis[2] * Math.sin(a / 2), Math.cos(a / 2)];
            const chest = body(w, { kind: 'box', halfExtents: [0.15, 0.2, 0.1] }, [0, 0, 0], { mass: dynamicB ? 15 : 0 });
            if (dynamicB) {
                const hook = body(w, { kind: 'sphere', radius: 0.05 }, [0, 1, 0], { mass: 0 });
                w.createJoint({ kind: 'ball', a: chest, b: hook, anchorA: [0, 0.2, 0], anchorB: [0, -0.8, 0] });
            }
            const a0 = 0.7, q0 = about([0, 0, 1], a0);
            const arm = body(w, { kind: 'capsule', radius: 0.05, height: 0.2 }, [Math.sin(a0) * 0.15, -0.2 - Math.cos(a0) * 0.15, 0], { mass: 2, rotation: q0 as never });
            const j = w.createJoint({ kind: 'coneTwist', a: arm, b: chest, anchorA: [0, 0.15, 0], anchorB: [0, -0.2, 0], axisA: [0, -1, 0], axisB: [0, -1, 0], coneAngle: 1.5, twistAngle: 0.6, matchTwist: true });
            w.setJointDrive(j, { frequency: 5, damping: 1, maxTorque: 200, gravityCompensation: 1 }, [arm]);
            let twist = 0, total = 0;
            for (let f = 0; f < 120; f++) {
                const t = (f + 1) * H, wave = 0.45 * Math.sin(2 * Math.PI * t), rate = 0.45 * 2 * Math.PI * Math.cos(2 * Math.PI * t);
                // Swinging about Z; or turning about its own (rest) axis as well.
                const target = twisting ? mul(q0, about([0, 1, 0], wave)) : about([0, 0, 1], a0 + wave);
                const own = twisting ? (() => { const r = mul(mul(q0, [0, 1, 0, 0]), conj(q0)); return [r[0] * rate, r[1] * rate, r[2] * rate]; })() : [0, 0, rate];
                w.setJointTarget(j, target, spin ? own : null);
                w.step(H);
                const rel = mul(conj(pose(w, chest).slice(3)), pose(w, arm).slice(3));
                const d = mul(conj(target), rel);
                if (f > 30) {
                    twist = Math.max(twist, Math.abs(2 * Math.atan2(d[3] < 0 ? -d[1] : d[1], Math.abs(d[3]))));
                    total = Math.max(total, 2 * Math.acos(Math.min(1, Math.abs(d[3]))));
                }
            }
            return { twist, total };
        };

        for (const dynamicB of [false, true]) {
            it(`a cone whose target swings off its centre gets no twist from its spin, and follows it closer (${dynamicB ? 'a free parent' : 'a fixed one'})`, () => {
                const still = offCentre(false, dynamicB), spun = offCentre(true, dynamicB);
                const DEG = Math.PI / 180;
                expect(spun.twist).toBeLessThan(2 * DEG);
                expect(spun.total).toBeLessThan(still.total * 0.5);
            });
        }

        it('a cone whose target twists about the limb follows that too', () => {
            const still = offCentre(false, false, true), spun = offCentre(true, false, true);
            expect(spun.total).toBeLessThan(still.total * 0.5);
        });
    });

    describe('the planner (planRagdoll) and a powered ragdoll built from it', () => {
        const powered = () => {
            const physics = groundWorld('jolt');
            systems.push(physics);
            const node = humanoidModel();
            const r = physics.startRagdoll(node, { mode: 'powered' });
            return { physics, node, r };
        };

        it('keeps the total mass, bounds the parents\' and children\'s ratios, and keeps every parent and child apart', () => {
            const { r } = powered();
            expect(r.powered).toBe(true);
            expect(r.planned).toBe(true);
            const parts = r.parts;
            const total = parts.reduce((s, p) => s + p.body.mass, 0);
            const passive = (() => { const p = groundWorld('jolt'); systems.push(p); return p.startRagdoll(humanoidModel()); })();
            const passiveTotal = [...passive.bodies.values()].reduce((s, b) => s + b.mass, 0);
            expect(total).toBeCloseTo(passiveTotal, 3);
            // Stabilised: no child more than a few times lighter or heavier than its parent.
            let worst = 1, worstBefore = 1;
            for (const p of parts) {
                if (p.parent < 0) continue;
                const ratio = (a: number, b: number) => Math.max(a / b, b / a);
                worst = Math.max(worst, ratio(p.body.mass, parts[p.parent].body.mass));
                const pa = [...passive.bodies.values()][p.index], pb = [...passive.bodies.values()][p.parent];
                if (pa && pb) worstBefore = Math.max(worstBefore, ratio(pa.mass, pb.mass));
            }
            expect(worst).toBeLessThanOrEqual(worstBefore);
            // Every parent and child kept from colliding, the masks symmetric.
            const filter = (i: number) => (parts[i].body as any)._desc.selfFilter as { group: number; index: number; ignore: number };
            const group = filter(0).group;
            for (const p of parts) {
                const f = filter(p.index);
                expect(f.group).toBe(group);
                expect(f.index).toBe(p.index);
                for (let j = 0; j < parts.length; j++) expect(((f.ignore >>> j) & 1), `${p.name}/${parts[j].name}`).toBe((filter(j).ignore >>> p.index) & 1);
                if (p.parent >= 0) expect((f.ignore >>> p.parent) & 1, `${p.name} and its parent`).toBe(1);
            }
            // A second ragdoll has a group of its own.
            const other = powered().r;
            expect(((other.parts[0].body as any)._desc.selfFilter).group).not.toBe(group);
        });

        it('makes knees and elbows one cone-twist each, sweeps hands, forearms, feet and the head, and solves a joint after those it carries', () => {
            const { r, physics } = powered();
            const parts = r.parts;
            const hinged = parts.filter(p => p.hinge).length;
            expect(hinged).toBeGreaterThan(0);
            // One joint per part but the root: no hinge-and-cone pairs.
            expect(((r as any)._joints as JointHandle[]).length).toBe(parts.length - 1);
            const swept = parts.filter(p => (p.body as any)._desc.motionQuality === 'linearCast').map(p => p.role).sort();
            expect(swept).toEqual(['foot.L', 'foot.R', 'foreArm.L', 'foreArm.R', 'hand.L', 'hand.R', 'head'].filter(s => parts.some(p => p.role === s)).sort());
            const world = (physics as any)._world as JoltWorld;
            const priorityOf = (p: typeof parts[number]) => (world as any)._joints.get(p.joint).constraint.GetConstraintPriority();
            // A joint is solved after every joint it carries: down each chain, the priorities fall.
            for (const p of parts) {
                if (p.parent < 0) continue;
                for (const c of p.children) expect(priorityOf(p), `${p.name} over ${parts[c].name}`).toBeGreaterThan(priorityOf(parts[c]));
            }
        });

        it('bends a planned knee only the way and as far as its profile says', () => {
            const { r, physics } = powered();
            const knee = r.parts.find(p => p.role === 'leg.L')!;
            const jt = knee.layout.part.joint!;
            const lo = Math.min(jt.hingeMin, jt.hingeMax) * Math.PI / 180, hi = Math.max(jt.hingeMin, jt.hingeMax) * Math.PI / 180;
            const bend = () => {
                const qa = knee.body.quaternion, qb = r.parts[knee.parent].body.quaternion;
                const la = knee.layout.rotation, lb = r.parts[knee.parent].layout.rotation;
                // The shin's rotation in the thigh's frame, from the bind pose's, about the hinge.
                const rel = mul(conj([qb.x, qb.y, qb.z, qb.w]), [qa.x, qa.y, qa.z, qa.w]);
                const bind = mul(conj([lb[0], lb[1], lb[2], lb[3]]), [la[0], la[1], la[2], la[3]]);
                const d = mul(conj(bind), rel);
                const axis = rot(conj([la[0], la[1], la[2], la[3]]), knee.layout.hingeAxis!);
                const s = d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2];
                return 2 * Math.atan2(d[3] < 0 ? -s : s, Math.abs(d[3]));
            };
            for (const spin of [12, -12]) {
                for (let f = 0; f < 40; f++) {
                    const axisW = rot([knee.body.quaternion.x, knee.body.quaternion.y, knee.body.quaternion.z, knee.body.quaternion.w], rot(conj([knee.layout.rotation[0], knee.layout.rotation[1], knee.layout.rotation[2], knee.layout.rotation[3]]), knee.layout.hingeAxis!));
                    knee.body.angularVelocity.set(axisW[0] * spin, axisW[1] * spin, axisW[2] * spin);
                    physics.update(H);
                }
                const b = bend();
                expect(b).toBeGreaterThan(lo - 0.1);
                expect(b).toBeLessThan(hi + 0.1);
            }
        });

        it('ports Jolt\'s constraint priorities exactly', () => {
            const w = make() as unknown as JoltWorld;
            const J = jolt();
            const parents = [-1, 0, 1, 2, 1, 4, 5, 1, 7, 8, 0, 10, 11, 0, 13, 14];
            const settings = new J.RagdollSettings();
            const skeleton = new J.Skeleton();
            parents.forEach((p, i) => { const s = new J.JPHString(`j${i}`, `j${i}`.length); skeleton.AddJoint(s, p); J.destroy(s); });
            settings.mSkeleton = skeleton;
            settings.mParts.resize(parents.length);
            const sphere = new J.SphereShapeSettings(0.1);
            for (let i = 0; i < parents.length; i++) {
                const part = settings.mParts.at(i);
                const shape = sphere.Create().Get();
                part.SetShape(shape);
                part.mPosition = new J.RVec3(0, i * 0.3, 0);
                part.mMotionType = J.EMotionType_Dynamic;
                part.mObjectLayer = (w as any)._layer(1, -1);
                if (parents[i] >= 0) {
                    const c = new J.PointConstraintSettings();
                    c.mPoint1 = new J.RVec3(0, i * 0.3 - 0.15, 0); c.mPoint2 = new J.RVec3(0, i * 0.3 - 0.15, 0);
                    part.mToParent = c;
                }
            }
            settings.CalculateConstraintPriorities(3);
            const ragdoll = settings.CreateRagdoll(0, 0, (w as any)._system);
            const native = [];
            for (let k = 0; k < ragdoll.GetConstraintCount(); k++) native.push(ragdoll.GetConstraint(k).GetConstraintPriority());
            const ported = ragdollJointPriorities(parents, 3).filter((_, i) => parents[i] >= 0);
            expect(ported).toEqual(native);
            J.destroy(ragdoll);
            J.destroy(settings);
        });

        it('plans 200 ragdolls without growing the heap', () => {
            const J = jolt();
            const { physics } = powered();
            const world = (physics as any)._world as JoltWorld;
            const input = {
                parts: Array.from({ length: 12 }, (_, i) => ({
                    parent: i - 1, colliders: [{ shape: { kind: 'capsule' as const, radius: 0.05, height: 0.2 } }],
                    position: [0, i * 0.3, 0] as [number, number, number], rotation: IDENTITY, mass: 1 + (i % 3) * 4,
                })),
            };
            world.planRagdoll(input);
            const before = J.JoltInterface.prototype.sGetFreeMemory();
            for (let k = 0; k < 200; k++) world.planRagdoll(input);
            expect(before - J.JoltInterface.prototype.sGetFreeMemory()).toBeLessThan(256 * 1024);
        });
    });
});

const conj = (q: ArrayLike<number>) => [-q[0], -q[1], -q[2], q[3]];
const mul = (a: ArrayLike<number>, b: ArrayLike<number>) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const rot = (q: ArrayLike<number>, v: ArrayLike<number>) => { const r = mul(mul(q, [v[0], v[1], v[2], 0]), conj(q)); return [r[0], r[1], r[2]]; };

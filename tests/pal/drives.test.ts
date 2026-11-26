import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { acquirePhysicsBackend, createPhysicsWorld } from '../../src/physics/pal/createWorld';
import type { BodyDesc, BodyHandle, JointDesc, JointDrive, JointHandle, PhysicsBackendKind, ShapeDesc } from '../../src/physics/pal/types';
import type { PhysicsWorld } from '../../src/physics/pal/world';

// Joint drives (muscles) and body pins (puppet strings), what every backend must do with them
// (pal/drive/driveSolver.ts; Jolt drives hinge and cone joints with its own motors). Behaviour, written against
// the layer's interface only and run once per backend, like conformance.test.ts.

const BACKENDS: PhysicsBackendKind[] = ['cannon', 'rapier', 'jolt'];
const H = 1 / 60;
const G = -9.82;
const DEG = Math.PI / 180;
const IDENTITY = [0, 0, 0, 1] as const;

function body(world: PhysicsWorld, shape: ShapeDesc, position: [number, number, number], extra: Partial<BodyDesc> = {}): BodyHandle {
    return world.createBody({ position, rotation: IDENTITY, mass: 1, colliders: [{ shape }], ...extra });
}
function pose(world: PhysicsWorld, h: BodyHandle): number[] { const out = new Array(7).fill(0); world.getTransform(h, out); return out; }
function velocity(world: PhysicsWorld, h: BodyHandle): number[] { const out = new Array(6).fill(0); world.getVelocity(h, out); return out; }
function run(world: PhysicsWorld, steps: number, dt = H): void { for (let i = 0; i < steps; i++) world.step(dt); }
const aboutZ = (angle: number) => [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)];

/** A 1 m rod hanging by its top end from a static anchor at (0, 5, 0): the joint's A is the rod, B the anchor. */
function rod(w: PhysicsWorld, kind: 'hinge' | 'ball' | 'coneTwist') {
    const anchor = body(w, { kind: 'sphere', radius: 0.05 }, [0, 5, 0], { mass: 0 });
    const rodBody = body(w, { kind: 'box', halfExtents: [0.05, 0.5, 0.05] }, [0, 4.5, 0], { mass: 2, angularDamping: 0, linearDamping: 0 });
    const common = { a: rodBody, b: anchor, anchorA: [0, 0.5, 0] as const, anchorB: [0, 0, 0] as const };
    const desc: JointDesc = kind === 'hinge'
        ? { kind: 'hinge', ...common, axisA: [0, 0, 1], axisB: [0, 0, 1] }
        : kind === 'ball' ? { kind: 'ball', ...common }
            : { kind: 'coneTwist', ...common, axisA: [0, -1, 0], axisB: [0, -1, 0], coneAngle: 80 * DEG, twistAngle: 80 * DEG };
    const joint = w.createJoint(desc);
    return { anchor, rod: rodBody, joint };
}
/** The rod's swing about Z: its centre's offset from the pivot. */
const swingOf = (w: PhysicsWorld, h: BodyHandle) => { const p = pose(w, h); return Math.atan2(p[0], 5 - p[1]); };

const MUSCLE: JointDrive = { frequency: 4, damping: 1, maxTorque: 200, gravityCompensation: 1 };

describe.each(BACKENDS)('drives on %s', kind => {
    const made: PhysicsWorld[] = [];
    const make = () => { const w = createPhysicsWorld(kind, [0, G, 0]); made.push(w); return w; };
    afterEach(() => { for (const w of made.splice(0)) w.dispose(); });
    beforeAll(async () => { await acquirePhysicsBackend(kind); });

    it('says how it drives', () => {
        expect(make().capabilities.jointDrives).toBe(kind === 'jolt' ? 'native' : 'shared');
    });

    for (const joint of ['hinge', 'ball', 'coneTwist'] as const) {
        it(`turns a ${joint} joint to its target and holds it there against gravity`, () => {
            const w = make();
            const r = rod(w, joint);
            w.setJointDrive(r.joint, MUSCLE, [r.rod]);
            w.setJointTarget(r.joint, aboutZ(45 * DEG));
            run(w, 150);
            expect(Math.abs(swingOf(w, r.rod) - 45 * DEG)).toBeLessThan(3 * DEG);
            // Only about Z: nothing swung out of the plane.
            expect(Math.abs(pose(w, r.rod)[2])).toBeLessThan(0.02);
            // And it stays there.
            expect(Math.hypot(...velocity(w, r.rod).slice(0, 3))).toBeLessThan(0.05);
        });
    }

    it('starts from the pose the bodies hold, so a new drive does not snap', () => {
        const w = make();
        const r = rod(w, 'ball');
        w.setJointDrive(r.joint, MUSCLE, [r.rod]);
        run(w, 60);
        expect(Math.abs(swingOf(w, r.rod))).toBeLessThan(0.5 * DEG);
    });

    it('sags under gravity without its compensation, less the stiffer it is', () => {
        const sag = (frequency: number, gravityCompensation: number) => {
            const w = make();
            const r = rod(w, 'hinge');
            w.setJointDrive(r.joint, { frequency, damping: 1, maxTorque: 500, gravityCompensation }, [r.rod]);
            w.setJointTarget(r.joint, aboutZ(45 * DEG));
            run(w, 240);
            return 45 * DEG - swingOf(w, r.rod);
        };
        const held = sag(4, 1), soft = sag(2, 0), stiff = sag(4, 0);
        expect(Math.abs(held)).toBeLessThan(1 * DEG);
        expect(soft).toBeGreaterThan(2 * DEG);
        expect(stiff).toBeLessThan(soft);
        expect(stiff).toBeGreaterThan(0);
    });

    it('barely overshoots when critically damped', () => {
        const w = make();
        const r = rod(w, 'hinge');
        w.setJointDrive(r.joint, MUSCLE, [r.rod]);
        w.setJointTarget(r.joint, aboutZ(45 * DEG));
        let most = 0;
        for (let i = 0; i < 180; i++) { w.step(H); most = Math.max(most, swingOf(w, r.rod)); }
        expect(most).toBeLessThan(45 * DEG * 1.08);
    });

    it('pushes no harder than its torque limit, and reports it saturated', () => {
        const w = make();
        const r = rod(w, 'hinge');
        // Holding 2 kg out at 45 degrees takes ~7 N·m; 1.5 N·m lifts it a little way only.
        w.setJointDrive(r.joint, { frequency: 6, damping: 1, maxTorque: 1.5, gravityCompensation: 0 }, [r.rod]);
        w.setJointTarget(r.joint, aboutZ(45 * DEG));
        run(w, 180);
        expect(swingOf(w, r.rod)).toBeLessThan(10 * DEG);
        const report = [0, 0, 0];
        w.readJointDrive(r.joint, report);
        expect(report[1]).toBeGreaterThan(0.9);
        expect(report[0]).toBeLessThan(1.5 * 1.8);
        expect(report[2]).toBeGreaterThan(30 * DEG);
    });

    it('takes new gains while it runs', () => {
        const error = (switchAt: number) => {
            const w = make();
            const r = rod(w, 'hinge');
            w.setJointDrive(r.joint, { frequency: 0.5, damping: 1, maxTorque: 500, gravityCompensation: 1 }, [r.rod]);
            w.setJointTarget(r.joint, aboutZ(60 * DEG));
            for (let i = 0; i < 40; i++) {
                if (i === switchAt) w.setJointDrive(r.joint, { frequency: 6, damping: 1, maxTorque: 500, gravityCompensation: 1 }, [r.rod]);
                w.step(H);
            }
            return Math.abs(60 * DEG - swingOf(w, r.rod));
        };
        expect(error(5)).toBeLessThan(error(1000) * 0.5);
    });

    it('lets go when its drive is taken away', () => {
        const w = make();
        const r = rod(w, 'hinge');
        w.setJointDrive(r.joint, MUSCLE, [r.rod]);
        w.setJointTarget(r.joint, aboutZ(45 * DEG));
        run(w, 120);
        w.setJointDrive(r.joint, null);
        run(w, 240);
        // Swinging freely now: it has passed back through the bottom at some point.
        let lowest = Infinity;
        for (let i = 0; i < 120; i++) { w.step(H); lowest = Math.min(lowest, Math.abs(swingOf(w, r.rod))); }
        expect(lowest).toBeLessThan(5 * DEG);
        expect(w.drives.driveCount).toBe(0);
    });

    it('drops a drive with its joint and a pin with its body', () => {
        const w = make();
        const r = rod(w, 'hinge');
        w.setJointDrive(r.joint, MUSCLE, [r.rod]);
        w.setBodyPin(r.rod, { linearFrequency: 2, angularFrequency: 2, damping: 1, maxForce: 100, maxTorque: 100 });
        expect(w.drives.size).toBe(2);
        w.destroyJoint(r.joint);
        expect(w.drives.driveCount).toBe(0);
        w.destroyBody(r.rod);
        expect(w.drives.size).toBe(0);
        run(w, 5);
    });

    it('skips a disabled body', () => {
        const w = make();
        const r = rod(w, 'ball');
        w.setJointDrive(r.joint, MUSCLE, [r.rod]);
        w.setJointTarget(r.joint, aboutZ(45 * DEG));
        w.setEnabled(r.rod, false);
        const before = pose(w, r.rod);
        run(w, 30);
        expect(pose(w, r.rod)).toEqual(before);
    });

    it('pins a free body to a pose in the world', () => {
        const w = make();
        const box = body(w, { kind: 'box', halfExtents: [0.3, 0.3, 0.3] }, [0, 2, 0], { mass: 3 });
        w.setBodyPin(box, { linearFrequency: 4, angularFrequency: 4, damping: 1, maxForce: 1000, maxTorque: 100 });
        const turn = [0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)];
        w.setBodyPinTarget(box, [2, 3, -1, ...turn]);
        run(w, 180);
        const p = pose(w, box);
        expect(Math.hypot(p[0] - 2, p[1] - 3, p[2] + 1)).toBeLessThan(0.05);
        const dot = Math.abs(p[3] * turn[0] + p[4] * turn[1] + p[5] * turn[2] + p[6] * turn[3]);
        expect(dot).toBeGreaterThan(Math.cos(2 * DEG / 2));
    });

    it('a pin pulls no harder than its force limit', () => {
        const w = make();
        const box = body(w, { kind: 'box', halfExtents: [0.3, 0.3, 0.3] }, [0, 10, 0], { mass: 1 });
        w.setBodyPin(box, { linearFrequency: 4, angularFrequency: 4, damping: 1, maxForce: 4, maxTorque: 10 });
        run(w, 60);
        // 4 N against 9.82 N of weight: it still falls, at about (9.82 - 4) m/s².
        expect(pose(w, box)[1]).toBeLessThan(10 - 0.5 * 5 * 1);
    });

    it('steps exactly as before once drives and pins are gone', () => {
        const trace = (touch: boolean) => {
            const w = make();
            const r = rod(w, 'coneTwist');
            w.setLinearVelocity(r.rod, 2, 0, 1);
            if (touch) {
                w.setJointDrive(r.joint, MUSCLE, [r.rod]);
                w.setBodyPin(r.rod, { linearFrequency: 2, angularFrequency: 2, damping: 1, maxForce: 100, maxTorque: 100 });
                w.setJointDrive(r.joint, null);
                w.setBodyPin(r.rod, null);
            }
            run(w, 90);
            return [...pose(w, r.rod), ...velocity(w, r.rod)];
        };
        expect(trace(true)).toEqual(trace(false));
    });

    it('never drives a fixed joint', () => {
        const w = make();
        const a = body(w, { kind: 'sphere', radius: 0.1 }, [0, 5, 0], { mass: 0 });
        const b = body(w, { kind: 'sphere', radius: 0.1 }, [0, 4, 0]);
        const j: JointHandle = w.createJoint({ kind: 'fixed', a: b, b: a });
        w.setJointDrive(j, MUSCLE);
        expect(w.drives.driveCount).toBe(0);
    });
});

describe('drives feel the same on every backend', () => {
    beforeAll(async () => { for (const kind of BACKENDS) await acquirePhysicsBackend(kind); });

    it('a hinge muscle reaches the same angle in the same time', () => {
        const at: Record<string, number> = {};
        for (const kind of BACKENDS) {
            const w = createPhysicsWorld(kind, [0, G, 0]);
            const r = rod(w, 'hinge');
            w.setJointDrive(r.joint, { frequency: 2, damping: 1, maxTorque: 500, gravityCompensation: 1 }, [r.rod]);
            w.setJointTarget(r.joint, aboutZ(60 * DEG));
            run(w, 15);
            at[kind] = swingOf(w, r.rod);
            w.dispose();
        }
        const ref = at.cannon;
        expect(ref).toBeGreaterThan(5 * DEG);
        for (const kind of BACKENDS) expect(Math.abs(at[kind] - ref), `${kind}: ${at[kind] / DEG}° vs cannon ${ref / DEG}°`).toBeLessThan(ref * 0.2);
    });

    it('a muscle without gravity compensation holds a weight equally stiffly', () => {
        const sag: Record<string, number> = {};
        for (const kind of BACKENDS) {
            const w = createPhysicsWorld(kind, [0, G, 0]);
            const r = rod(w, 'coneTwist');
            w.setJointDrive(r.joint, { frequency: 2, damping: 1, maxTorque: 500, gravityCompensation: 0 }, [r.rod]);
            w.setJointTarget(r.joint, aboutZ(45 * DEG));
            run(w, 240);
            sag[kind] = 45 * DEG - swingOf(w, r.rod);
            w.dispose();
        }
        // k = I·Ω²: 2 kg on a 1 m rod about its end, 2 Hz, against 6.9 N·m at 45 degrees: ~3.7 degrees.
        for (const kind of BACKENDS) expect(sag[kind] / DEG, kind).toBeCloseTo(3.7, 0);
    });
});

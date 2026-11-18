import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { acquirePhysicsBackend, createPhysicsWorld, createWorldMirror, createWorldReplica } from '../../src/physics/pal/createWorld';
import type { BodyHandle, PhysicsBackendKind, V3 } from '../../src/physics/pal/types';
import type { PhysicsWorld } from '../../src/physics/pal/world';
import type { VehicleDesc, VehicleHandle, VehicleInput } from '../../src/physics/pal/vehicle/vehicleDesc';
import {
    VH_GEAR, VH_SPEED, W_ANGLE, W_CONTACT, W_LENGTH, W_OMEGA, W_STEER, vehicleStateSize, wheelOffset,
} from '../../src/physics/pal/vehicle/vehicleState';

// Vehicles on every backend, written against the layer's interface only: one description, driven the
// same way, must spring, drive, brake, steer and hold alike. Behaviour within tolerances, not bits: each
// backend's own vehicle does the contact and tyre solve (Jolt's VehicleConstraint, Bullet's raycast
// vehicle on Rapier and cannon), so their numbers differ in the details.

const BACKENDS: PhysicsBackendKind[] = ['cannon', 'rapier', 'jolt'];
const H = 1 / 60;
const G = -9.81;
const MASS = 1200;

function ground(w: PhysicsWorld): BodyHandle {
    return w.createBody({ position: [0, -0.5, 0], rotation: [0, 0, 0, 1], mass: 0, friction: 1, colliders: [{ shape: { kind: 'box', halfExtents: [500, 0.5, 500] } }] });
}

function chassis(w: PhysicsWorld, at: V3 = [0, 1.2, 0]): BodyHandle {
    return w.createBody({
        position: at, rotation: [0, 0, 0, 1], mass: MASS, linearDamping: 0, angularDamping: 0,
        colliders: [{ shape: { kind: 'box', halfExtents: [0.9, 0.3, 2] } }],
    });
}

/** A car facing +Z: front wheels 0 (left, +X) and 1 (right, −X) steer, rear 2 and 3 drive and hold the hand brake. */
function car(chassisBody: BodyHandle): VehicleDesc {
    const wheel = (x: number, z: number, front: boolean) => ({
        position: [x, 0, z] as V3, radius: 0.35, width: 0.25, suspensionMinLength: 0.2, suspensionMaxLength: 0.5,
        suspensionFrequency: 1.5, suspensionDamping: 0.5,
        maxSteerAngle: front ? 0.5 : 0, maxHandBrakeTorque: front ? 0 : 4000,
    });
    return {
        chassis: chassisBody,
        wheels: [wheel(0.8, 1.3, true), wheel(-0.8, 1.3, true), wheel(0.8, -1.3, false), wheel(-0.8, -1.3, false)],
        differentials: [{ leftWheel: 2, rightWheel: 3 }],
        antiRollBars: [{ leftWheel: 0, rightWheel: 1 }, { leftWheel: 2, rightWheel: 3 }],
    };
}

const IDLE: VehicleInput = { forward: 0, right: 0, brake: 0, handBrake: 0 };

function pose(w: PhysicsWorld, h: BodyHandle): number[] { const out = new Array(7).fill(0); w.getTransform(h, out); return out; }
function run(w: PhysicsWorld, seconds: number): void { for (let i = 0, n = Math.round(seconds / H); i < n; i++) w.step(H); }
function state(w: PhysicsWorld, v: VehicleHandle): number[] { const out = new Array(vehicleStateSize(4)).fill(NaN); w.readVehicle(v, out); return out; }
/** The chassis's forward (+Z) in world space. */
function heading(w: PhysicsWorld, h: BodyHandle): number[] {
    const [, , , x, y, z, qw] = pose(w, h);
    // +Z turned by the rotation.
    return [2 * (x * z + qw * y), 2 * (y * z - qw * x), 1 - 2 * (x * x + y * y)];
}

interface Measured { rideHeight: number; speedAfter5s: number; stopDistance: number }
const measured = new Map<PhysicsBackendKind, Measured>();

describe.each(BACKENDS)('vehicle on %s', kind => {
    const made: PhysicsWorld[] = [];
    const make = () => { const w = createPhysicsWorld(kind, [0, G, 0]); made.push(w); ground(w); return w; };
    afterEach(() => { for (const w of made.splice(0)) w.dispose(); });
    beforeAll(async () => { await acquirePhysicsBackend(kind); });

    /** A car settled on the ground. */
    function settled() {
        const w = make(), body = chassis(w), v = w.createVehicle(car(body));
        run(w, 3);
        return { w, body, v };
    }

    it('says what its wheels find the ground with', () => {
        const w = make();
        expect(w.capabilities.vehicleCasts).toContain('ray');
        expect(typeof w.capabilities.nativeDrivetrain).toBe('boolean');
    });

    it('settles on its springs, every wheel down, at rest', () => {
        const { w, body, v } = settled();
        const s = state(w, v);
        for (let i = 0; i < 4; i++) {
            const o = wheelOffset(i);
            expect(s[o + W_CONTACT]).toBe(1);
            // Compressed from full length, not bottomed out.
            expect(s[o + W_LENGTH]).toBeGreaterThan(0.2);
            expect(s[o + W_LENGTH]).toBeLessThan(0.5);
        }
        const p = pose(w, body);
        run(w, 1);
        const later = pose(w, body);
        expect(Math.hypot(later[0] - p[0], later[1] - p[1], later[2] - p[2])).toBeLessThan(0.02);
        // Wheel bottom = origin − length − radius = ground.
        const length = s[wheelOffset(0) + W_LENGTH];
        expect(p[1] - length - 0.35).toBeCloseTo(0, 1);
        // Level: no pitch or roll worth the name.
        expect(Math.abs(p[3])).toBeLessThan(0.01);
        expect(Math.abs(p[5])).toBeLessThan(0.01);
        measured.set(kind, { ...(measured.get(kind) ?? { speedAfter5s: 0, stopDistance: 0 }), rideHeight: p[1] });
    });

    it('drives forward under throttle, rolling its wheels and shifting up', () => {
        const { w, body, v } = settled();
        const z0 = pose(w, body)[2];
        w.setVehicleInput(v, { ...IDLE, forward: 1 });
        run(w, 5);
        const s = state(w, v);
        expect(s[VH_SPEED]).toBeGreaterThan(8);
        expect(pose(w, body)[2] - z0).toBeGreaterThan(15);
        expect(s[VH_GEAR]).toBeGreaterThanOrEqual(2);
        // The driven wheels touch and roll forward: positive spin, about speed / radius.
        expect(s[wheelOffset(2) + W_CONTACT]).toBe(1);
        expect(s[wheelOffset(2) + W_OMEGA]).toBeGreaterThan(0.8 * s[VH_SPEED] / 0.35);
        expect(s[wheelOffset(0) + W_OMEGA]).toBeCloseTo(s[VH_SPEED] / 0.35, 0);
        const a0 = s[wheelOffset(0) + W_ANGLE];
        w.step(H);
        const a1 = state(w, v)[wheelOffset(0) + W_ANGLE];
        // Forward roll advances the angle (mod 2π).
        expect(((a1 - a0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)).toBeLessThan(Math.PI);
        expect(a1).not.toBe(a0);
        // Straight: barely off the Z axis.
        expect(Math.abs(pose(w, body)[0])).toBeLessThan(0.5);
        measured.set(kind, { ...(measured.get(kind) as Measured), speedAfter5s: s[VH_SPEED] });
    });

    it('reverses with the throttle backward', () => {
        const { w, body, v } = settled();
        const z0 = pose(w, body)[2];
        w.setVehicleInput(v, { ...IDLE, forward: -1 });
        run(w, 4);
        const s = state(w, v);
        expect(s[VH_SPEED]).toBeLessThan(-2);
        expect(s[VH_GEAR]).toBeLessThan(0);
        expect(pose(w, body)[2]).toBeLessThan(z0 - 2);
    });

    it('brakes to a stop', () => {
        const { w, body, v } = settled();
        w.setVehicleInput(v, { ...IDLE, forward: 1 });
        run(w, 4);
        const from = pose(w, body)[2], speed = state(w, v)[VH_SPEED];
        expect(speed).toBeGreaterThan(6);
        w.setVehicleInput(v, { ...IDLE, brake: 1 });
        run(w, 6);
        expect(Math.abs(state(w, v)[VH_SPEED])).toBeLessThan(0.2);
        const distance = pose(w, body)[2] - from;
        // At most ~0.3 g of braking, at least ~1.2 g: v² / 2a.
        expect(distance).toBeLessThan(speed * speed / (2 * 0.3 * 9.81));
        expect(distance).toBeGreaterThan(speed * speed / (2 * 1.5 * 9.81));
        measured.set(kind, { ...(measured.get(kind) as Measured), stopDistance: distance / (speed * speed) });
    });

    it('turns right under right steering (the engine\'s right is −X)', () => {
        const { w, body, v } = settled();
        w.setVehicleInput(v, { ...IDLE, forward: 0.6, right: 1 });
        run(w, 0.5);
        const s = state(w, v);
        // Front wheels steer right, which is a negative (clockwise) angle; rear wheels not at all.
        expect(s[wheelOffset(0) + W_STEER]).toBeLessThan(-0.3);
        expect(s[wheelOffset(1) + W_STEER]).toBeLessThan(-0.3);
        expect(s[wheelOffset(2) + W_STEER]).toBeCloseTo(0, 5);
        // Not so long that full lock brings it round past a half turn.
        run(w, 1.5);
        const f = heading(w, body);
        expect(f[0]).toBeLessThan(-0.2);
        expect(pose(w, body)[0]).toBeLessThan(-0.5);
    });

    it('holds still on a slope with the hand brake', () => {
        // A 10° slope: gravity tipped instead of the ground.
        const w = make(), a = 10 * Math.PI / 180;
        w.gravity = [0, G * Math.cos(a), G * Math.sin(a)];
        const body = chassis(w), v = w.createVehicle(car(body));
        w.setVehicleInput(v, { ...IDLE, handBrake: 1 });
        run(w, 3);
        const z0 = pose(w, body)[2];
        run(w, 4);
        expect(Math.abs(pose(w, body)[2] - z0)).toBeLessThan(0.1);
    });

    it('goes with its chassis, and with a clear', () => {
        const w = make(), body = chassis(w), v = w.createVehicle(car(body));
        run(w, 0.5);
        w.destroyVehicle(v);
        expect(() => w.readVehicle(v, new Array(vehicleStateSize(4)))).toThrow();
        // Without wheels the box drops onto the ground.
        run(w, 2);
        expect(pose(w, body)[1]).toBeCloseTo(0.3, 1);

        const v2 = w.createVehicle(car(body));
        w.destroyBody(body);
        expect(() => w.readVehicle(v2, new Array(vehicleStateSize(4)))).toThrow();
        run(w, 0.1);

        const b3 = chassis(w), v3 = w.createVehicle(car(b3));
        w.clear();
        expect(() => w.readVehicle(v3, new Array(vehicleStateSize(4)))).toThrow();
        ground(w);
        const b4 = chassis(w), v4 = w.createVehicle(car(b4));
        run(w, 1);
        expect(state(w, v4)[wheelOffset(0) + W_CONTACT]).toBe(1);
    });

    it("drives the same in the physics worker's copy, and the world reads what the copy did", () => {
        const inline = make(), original = make();
        // Off-centre mass, so the copy must place the wheels from the right frame.
        const offCentre = (w: PhysicsWorld) => w.createBody({
            position: [0, 1.2, 0], rotation: [0, 0, 0, 1], mass: MASS, linearDamping: 0, angularDamping: 0,
            colliders: [{ shape: { kind: 'box', halfExtents: [0.9, 0.3, 2] }, offset: [0, 0, 0.3] }],
        });
        const a = offCentre(inline), b = offCentre(original);
        const va = inline.createVehicle(car(a)), vb = original.createVehicle(car(b));
        const mirror = createWorldMirror(original), replica = createWorldReplica(kind);
        made.push(replica.world);
        for (let frame = 0; frame < 300; frame++) {
            const input = frame < 60 ? IDLE : frame < 200 ? { ...IDLE, forward: 1, right: 0.3 } : { ...IDLE, brake: 1 };
            inline.setVehicleInput(va, input);
            original.setVehicleInput(vb, input);
            inline.step(H);
            const diff = mirror.diff();
            replica.receive(structuredClone(diff.changes));
            replica.world.gravity = original.gravity;
            replica.world.step(H);
            const rows = replica.report(bytes => new ArrayBuffer(bytes));
            mirror.apply(structuredClone({ ...rows, events: new Int32Array(0), time: replica.world.time, vehicles: replica.reportVehicles?.() }), () => {});
        }
        const p = pose(original, b), q = pose(inline, a);
        for (let i = 0; i < 3; i++) expect(p[i], `pose[${i}]`).toBeCloseTo(q[i], 2);
        const sa = state(inline, va), sb = state(original, vb);
        expect(sb[VH_GEAR]).toBe(sa[VH_GEAR]);
        expect(sb[VH_SPEED]).toBeCloseTo(sa[VH_SPEED], 2);
        for (let i = 0; i < 4; i++) expect(sb[wheelOffset(i) + W_LENGTH]).toBeCloseTo(sa[wheelOffset(i) + W_LENGTH], 3);
        // Removing it on the main thread removes the copy's.
        original.destroyVehicle(vb);
        replica.receive(structuredClone(mirror.diff().changes));
        expect(replica.reportVehicles?.()).toBeUndefined();
    });

    it('drives on electric motors in its wheels, each held to its top speed', () => {
        const w = make(), body = chassis(w);
        const desc = car(body);
        // Motors in the rear wheels only: 400 N·m each, 30 rad/s (10.5 m/s on a 0.35 m wheel).
        const wheels = desc.wheels.map((wh, i) => (i >= 2 ? { ...wh, motorTorque: 400, motorMaxSpeed: 30 } : wh));
        const v = w.createVehicle({ ...desc, drive: 'motors', wheels, differentials: undefined });
        run(w, 1.5);
        w.setVehicleInput(v, { ...IDLE, forward: 1 });
        run(w, 6);
        const s = state(w, v);
        expect(s[VH_SPEED]).toBeGreaterThan(8);
        expect(s[VH_SPEED]).toBeLessThan(30 * 0.35 * 1.05);
        // The front wheels only roll.
        expect(s[wheelOffset(0) + W_OMEGA]).toBeCloseTo(s[VH_SPEED] / 0.35, 0);
        // Stopped, then backward: the same motors in reverse.
        w.setVehicleInput(v, { ...IDLE, brake: 1 });
        run(w, 3);
        w.setVehicleInput(v, { ...IDLE, forward: -1 });
        run(w, 4);
        expect(state(w, v)[VH_SPEED]).toBeLessThan(-3);
    });

    it('rolls, steers and brakes with no drive, but nothing pushes it', () => {
        const w = make(), body = chassis(w);
        const v = w.createVehicle({ ...car(body), drive: 'none' });
        run(w, 1.5);
        w.setVehicleInput(v, { ...IDLE, forward: 1 });
        run(w, 3);
        expect(Math.abs(state(w, v)[VH_SPEED])).toBeLessThan(0.1);
        // Pushed, it rolls; braked, it stops.
        w.setLinearVelocity(body, 0, 0, 8);
        run(w, 1);
        expect(state(w, v)[VH_SPEED]).toBeGreaterThan(5);
        w.setVehicleInput(v, { ...IDLE, brake: 1 });
        run(w, 3);
        expect(Math.abs(state(w, v)[VH_SPEED])).toBeLessThan(0.2);
    });

    it('refuses a static chassis and a vehicle with no wheels', () => {
        const w = make();
        const fixed = w.createBody({ position: [0, 5, 0], rotation: [0, 0, 0, 1], mass: 0, colliders: [{ shape: { kind: 'box', halfExtents: [1, 1, 1] } }] });
        expect(() => w.createVehicle(car(fixed))).toThrow();
        expect(() => w.createVehicle({ ...car(chassis(w)), wheels: [] })).toThrow();
    });
});

describe('one vehicle description on every backend', () => {
    it('rides at the same height, reaches about the same speed and stops in about the same distance', () => {
        if (measured.size < BACKENDS.length) return;
        const all = BACKENDS.map(k => measured.get(k) as Measured);
        const spread = (pick: (m: Measured) => number) => Math.max(...all.map(pick)) - Math.min(...all.map(pick));
        // Springs set by frequency on the mass they carry: within a centimetre.
        expect(spread(m => m.rideHeight)).toBeLessThan(0.01);
        // Engine, gearbox and grip the same model: within 25% of each other after 5 s.
        const speeds = all.map(m => m.speedAfter5s);
        expect(Math.max(...speeds) / Math.min(...speeds)).toBeLessThan(1.25);
        const stops = all.map(m => m.stopDistance);
        // Brakes lock at the tyre curves' grip everywhere.
        expect(Math.max(...stops) / Math.min(...stops)).toBeLessThan(1.15);
    });
});

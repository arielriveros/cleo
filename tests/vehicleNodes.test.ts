import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { Node } from '../src/core/scene/nodes/node';
import { parseNodeJson } from '../src/core/scene/nodes/parseNodeJson';
import { VehicleNode } from '../src/core/scene/nodes/vehicleNode';
import { WheelNode } from '../src/core/scene/nodes/wheelNode';
import { PhysicsSystem } from '../src/physics/physicsSystem';
import { installFeatures } from '../src/core/features/registry';
import vehicles from '../src/modules/vehicles/index';
import { TEST_PHYSICS } from './helpers/testPhysics';
import { LoopbackPort } from '../src/physics/worker/ports';
import { ControllerNode } from '../src/core/scene/nodes/controllerNode';
import { Logger } from '../src/core/logger';
import { fakeInput, type FakeInput } from './helpers/fakeInput';

// Vehicles as nodes: a Vehicle stands in its chassis Collider, its Wheels under it, and drives on every
// backend (this suite runs again on Rapier and Jolt, vitest.config.ts PHYSICS_SUITES), inline and in the
// physics worker.

const IDENT = { rotation: [0, 0, 0], scale: [1, 1, 1] };
const box = (w: number, h: number, d: number) => ({ type: 'box', width: w, height: h, depth: d, offset: [0, 0, 0], rotation: [0, 0, 0] });

const floor = () => ({
    type: 'collider', name: 'Floor', id: 'floor', position: [0, -0.5, 0], ...IDENT, children: [],
    collider: { mass: 0, friction: 1, shapes: [box(400, 1, 400)] },
});

/** A wheel at its centre with the suspension hanging free, a mesh node under it. */
const wheel = (name: string, x: number, z: number, front: boolean) => ({
    type: 'wheel', name, id: name, position: [x, -0.5, z], ...IDENT,
    radius: 0.35, width: 0.25, suspensionLength: 0.5, suspensionTravel: 0.3,
    steerAngle: front ? 30 : 0, driven: !front, handBrakeTorque: front ? 0 : 4000,
    children: [{ type: 'node', name: `${name} Mesh`, id: `${name}-mesh`, position: [0, 0, 0], rotation: [0, 0, 90], scale: [1, 1, 1], children: [] }],
});

const car = (y = 1.2) => ({
    type: 'collider', name: 'Car', id: 'car', position: [0, y, 0], ...IDENT,
    collider: { mass: 1200, linearDamping: 0, angularDamping: 0, shapes: [box(1.8, 0.6, 4)] },
    children: [{
        type: 'vehicle', name: 'Vehicle', id: 'vehicle', position: [0, 0, 0], ...IDENT, maxTorque: 500,
        children: [wheel('FL', 0.8, 1.3, true), wheel('FR', -0.8, 1.3, true), wheel('RL', 0.8, -1.3, false), wheel('RR', -0.8, -1.3, false)],
    }],
});

/** Started nodes in a running scene's physics, as physicsNodes.test.ts builds them. */
function world(root: Node, worker = false): { p: PhysicsSystem; frame: (seconds: number) => void } {
    const p = new PhysicsSystem({ gravity: [0, -9.81, 0], backend: TEST_PHYSICS });
    p.initialize();
    if (worker) p.setWorkerMode('on', () => new LoopbackPort());
    const nodes: Node[] = [];
    const walk = (n: Node) => { nodes.push(n); n.children.forEach(walk); };
    root.children.forEach(walk);
    const scene: any = { nodes, landscapes: [], tilemaps: [], activeCamera: null, physics: p };
    (p as any)._scene = scene;
    for (const n of nodes) { (n as any)._hasStarted = true; (n as any)._scene = scene; }
    const frame = (seconds: number) => {
        for (let t = 0; t < seconds - 1e-9; t += 1 / 60) {
            p.update(1 / 60);
            root.updateTransforms();
            for (const n of nodes) if (n instanceof VehicleNode) n.update(1 / 60, 0);
            root.updateTransforms();
            p.endFrame(1 / 60);
        }
    };
    return { p, frame };
}

function build(worker = false) {
    const root = new Node('root');
    parseNodeJson(root, floor());
    parseNodeJson(root, car());
    const chassis = root.getChildByName('Car')[0];
    const vehicle = chassis.getChildByName('Vehicle')[0] as VehicleNode;
    return { root, vehicle, chassis, ...world(root, worker) };
}

describe(`a Vehicle node (${TEST_PHYSICS})`, () => {
    beforeAll(async () => {
        installFeatures([vehicles]);
        await new PhysicsSystem({ backend: TEST_PHYSICS }).load();
    });

    it('parses as a Vehicle with its Wheels, and round-trips their settings', async () => {
        const { vehicle } = build();
        expect(vehicle).toBeInstanceOf(VehicleNode);
        expect(vehicle.wheels.map(w => w.name)).toEqual(['FL', 'FR', 'RL', 'RR']);
        const fl = vehicle.wheels[0];
        expect(fl).toBeInstanceOf(WheelNode);
        expect([fl.radius, fl.steerAngle, fl.driven]).toEqual([0.35, 30, false]);
        const json = await vehicle.serialize() as any;
        expect(json.maxTorque).toBe(500);
        expect(json.children[2]).toMatchObject({ type: 'wheel', driven: true, handBrakeTorque: 4000, suspensionTravel: 0.3 });
    });

    it('describes the wheels in the chassis frame: attachments above the wheels, rear axle driven', () => {
        const { vehicle } = build();
        const desc = vehicle.describe()!;
        expect(desc.wheels).toHaveLength(4);
        // Centre at y = -0.5 below the chassis origin; attached suspensionLength above it.
        [0.8, 0, 1.3].forEach((x, i) => expect(desc.wheels[0].position[i]).toBeCloseTo(x, 5));
        expect(desc.wheels[0].suspensionMinLength).toBeCloseTo(0.2, 6);
        expect(desc.differentials).toHaveLength(1);
        const d = desc.differentials![0];
        // Left is +X (the engine's right is -X).
        expect([d.leftWheel, d.rightWheel]).toEqual([2, 3]);
        expect(desc.antiRollBars).toHaveLength(2);
    });

    it('settles on its wheels, drives when told, and carries its wheel meshes with it', () => {
        const { vehicle, chassis, frame } = build();
        frame(2.5);
        const v = vehicle.vehicle!;
        expect(v.active).toBe(true);
        for (let i = 0; i < 4; i++) expect(v.wheel(i).grounded).toBe(true);
        // The wheel node rode up its suspension from where it was placed.
        const fl = vehicle.wheels[0];
        expect(fl.position[1]).toBeGreaterThan(-0.5 + 0.02);
        const z0 = chassis.worldPosition[2];
        vehicle.throttle = 1;
        frame(3);
        expect(vehicle.speed).toBeGreaterThan(5);
        expect(chassis.worldPosition[2] - z0).toBeGreaterThan(8);
        // The mesh under the wheel turns with it (its node's rotation changes each frame).
        const before = [...fl.quaternion];
        frame(1 / 60);
        expect([...fl.quaternion]).not.toEqual(before);
        // Steering right swings the front wheels clockwise.
        vehicle.throttle = 0.3;
        vehicle.steer = 1;
        frame(0.5);
        expect(vehicle.vehicle!.wheel(0).steerAngle).toBeLessThan(-0.4);
    });

    it('brakes with the throttle held back, then reverses (auto reverse)', () => {
        const { vehicle, frame } = build();
        frame(1.5);
        vehicle.throttle = 1;
        frame(3);
        expect(vehicle.speed).toBeGreaterThan(5);
        expect([vehicle.braking, vehicle.reversing]).toEqual([0, false]);
        vehicle.throttle = -1;
        frame(1);
        // Braking, not yet reversing: what brake lamps follow, though no brake was asked for.
        expect(vehicle.speed).toBeGreaterThan(-0.5);
        expect(vehicle.brake).toBe(0);
        expect(vehicle.braking).toBe(1);
        frame(6);
        expect(vehicle.speed).toBeLessThan(-1);
        expect(vehicle.gear).toBeLessThan(0);
        // Reversing, the throttle now with the way it rolls: no braking.
        expect([vehicle.braking, vehicle.reversing]).toEqual([0, true]);
        // Parked brakes it in full.
        vehicle.parked = true;
        frame(0.1);
        expect(vehicle.braking).toBe(1);
    });

    it('drives the same with the physics worker stepping it', () => {
        const inline = build(), worker = build(true);
        // Straight: a gearbox decision taken a substep apart (Jolt holds its upshift while a wheel spins) would
        // part the two for good, and that is not what this checks.
        for (const s of [inline, worker]) { s.frame(1); s.vehicle.throttle = 0.6; s.frame(3); }
        expect(worker.p.executor).toBe('worker');
        expect(worker.vehicle.speed).toBeGreaterThan(5);
        // The worker's state lands a frame behind: close, not equal.
        expect(Math.abs(worker.vehicle.speed - inline.vehicle.speed)).toBeLessThan(1);
        const a = inline.chassis.worldPosition, b = worker.chassis.worldPosition;
        expect(Math.hypot(a[0] - b[0], a[2] - b[2])).toBeLessThan(1);
        expect(worker.vehicle.vehicle!.wheel(2).grounded).toBe(true);
    });

    it('loads a vehicle saved before drives as engine-driven, and saves its drivetrain', async () => {
        const { vehicle } = build();
        expect(vehicle.drivetrain).toBe('engine');
        expect(((await vehicle.serialize()) as any).drivetrain).toBe('engine');
    });

    it('adds wheels at the chassis corners, axle by axle, with no mesh', () => {
        const root = new Node('root');
        parseNodeJson(root, { ...car(), children: [{ type: 'vehicle', name: 'Vehicle', id: 'vehicle', position: [0, 0, 0], ...IDENT, children: [] }] });
        const vehicle = root.getChildByName('Car')[0].getChildByName('Vehicle')[0] as VehicleNode;
        expect(vehicle.drivetrain).toBe('none');
        const made = [vehicle.addWheel(), vehicle.addWheel(), vehicle.addWheel(), vehicle.addWheel(), vehicle.addWheel()];
        expect(made.map(w => [...w.position].map(x => +x.toFixed(2)))).toEqual([
            [0.8, -0.5, 1.3], [-0.8, -0.5, 1.3], [0.8, -0.5, -1.3], [-0.8, -0.5, -1.3], [0.8, -0.5, -2.5],
        ]);
        expect(made.map(w => w.steerAngle)).toEqual([30, 30, 0, 0, 0]);
        expect(made.every(w => w.children.length === 0)).toBe(true);
        expect(vehicle.wheels).toHaveLength(5);
    });

    it("drives on its wheels' motors, held to their top speed", () => {
        const root = new Node('root');
        parseNodeJson(root, floor());
        parseNodeJson(root, { ...car(), children: [{ type: 'vehicle', name: 'Vehicle', id: 'vehicle', position: [0, 0, 0], ...IDENT, drivetrain: 'motors', children: [] }] });
        const vehicle = root.getChildByName('Car')[0].getChildByName('Vehicle')[0] as VehicleNode;
        for (let i = 0; i < 4; i++) {
            const w = vehicle.addWheel();
            w.radius = 0.35;
            w.motorTorque = i >= 2 ? 400 : 0;
            w.motorTopSpeed = 10;
        }
        const { frame } = world(root);
        frame(1);
        vehicle.throttle = 1;
        frame(7);
        expect(vehicle.speed).toBeGreaterThan(8);
        expect(vehicle.speed).toBeLessThan(10.5);
    });

    it('goes when its node does, and comes back after a world clear', () => {
        const { p, vehicle, frame } = build();
        frame(0.5);
        expect(p.vehicles.size).toBe(1);
        vehicle.onDespawn();
        expect(p.vehicles.size).toBe(0);
        frame(0.1);
        // Its node still in the scene: it puts the vehicle back.
        expect(p.vehicles.size).toBe(1);
    });
});

// A player's Controller possesses the Vehicle (the Sandbox's car): its intent drives it, Parked holds it.
describe(`a Vehicle possessed by a Controller (${TEST_PHYSICS})`, () => {
    let input: FakeInput;
    beforeAll(async () => {
        installFeatures([vehicles]);
        await new PhysicsSystem({ backend: TEST_PHYSICS }).load();
    });
    beforeEach(() => { input = fakeInput(); });
    afterEach(() => { input.restore(); });

    /** The car with a player Controller possessing its Vehicle, thinking before every frame as the scene's control pass does. */
    function driven() {
        const b = build();
        const controller = new ControllerNode('Driver');
        controller.controlSource = 'player';
        b.root.addChild(controller);
        (controller as any)._scene = (b.vehicle as any)._scene;
        controller.possess(b.vehicle);
        const frame = (seconds: number) => {
            for (let t = 0; t < seconds - 1e-9; t += 1 / 60) { controller.think(1 / 60); b.frame(1 / 60); input.endFrame(); }
        };
        return { ...b, controller, frame };
    }

    it('drives from the intent: Move steers and drives, the jump button held holds the hand brake', () => {
        const { vehicle, chassis, controller, frame } = driven();
        expect(controller.possessed).toBe(vehicle);
        expect(vehicle.controller).toBe(controller);
        frame(1.5);
        const z0 = chassis.worldPosition[2];
        input.setMove(0, 1);
        frame(2);
        expect(vehicle.throttle).toBe(1);
        expect(vehicle.speed).toBeGreaterThan(3);
        expect(chassis.worldPosition[2] - z0).toBeGreaterThan(3);
        input.setMove(1, 1);
        frame(0.3);
        expect(vehicle.steer).toBe(1);
        expect(vehicle.vehicle!.wheel(0).steerAngle).toBeLessThan(-0.3);
        input.press('Jump');
        frame(0.1);
        expect(vehicle.handBrake).toBe(1);
        input.release('Jump');
        frame(0.1);
        expect(vehicle.handBrake).toBe(0);
    });

    it('takes no player input of its own while possessed, and lets go of the controls when released', () => {
        const { vehicle, controller, frame } = driven();
        vehicle.playerInput = true;
        frame(1);
        input.setMove(0, 1);
        controller.controlSource = 'none';
        frame(0.5);
        // The controller's source asks for nothing: the vehicle's own playerInput does not take over.
        expect(vehicle.throttle).toBe(0);
        controller.controlSource = 'player';
        frame(0.5);
        expect(vehicle.throttle).toBe(1);
        controller.release();
        expect(vehicle.controller).toBeNull();
        expect([vehicle.throttle, vehicle.steer, vehicle.brake, vehicle.handBrake]).toEqual([0, 0, 0, 0]);
    });

    it('holds still while Parked, whatever the driver asks', () => {
        const { vehicle, chassis, frame } = driven();
        vehicle.parked = true;
        frame(1.5);
        const at = [...chassis.worldPosition];
        input.setMove(1, 1);
        frame(2);
        expect(Math.hypot(chassis.worldPosition[0] - at[0], chassis.worldPosition[2] - at[2])).toBeLessThan(0.05);
        expect(Math.abs(vehicle.vehicle!.wheel(0).steerAngle)).toBeLessThan(0.01);
        vehicle.parked = false;
        frame(1.5);
        expect(vehicle.speed).toBeGreaterThan(1);
    });

    it('an AI Controller asks nothing of it, and says so once', () => {
        const warn = vi.spyOn(Logger, 'warn');
        const { vehicle, controller, frame } = driven();
        controller.controlSource = 'ai';
        input.setMove(0, 1);
        frame(1);
        expect(vehicle.throttle).toBe(0);
        expect(warn.mock.calls.filter(c => String(c[0]).includes('AI steering only walks'))).toHaveLength(1);
        warn.mockRestore();
    });

    it('reads a vehicle saved with `drive` (before drivetrain) as its drivetrain', async () => {
        const root = new Node('root');
        parseNodeJson(root, { ...car(), children: [{ type: 'vehicle', name: 'Vehicle', id: 'vehicle', position: [0, 0, 0], ...IDENT, drive: 'motors', children: [] }] });
        const vehicle = root.getChildByName('Car')[0].getChildByName('Vehicle')[0] as VehicleNode;
        expect(vehicle.drivetrain).toBe('motors');
        const json = await vehicle.serialize() as any;
        expect([json.drivetrain, json.drive]).toEqual(['motors', undefined]);
    });
});

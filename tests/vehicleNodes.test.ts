import { describe, it, expect, beforeAll } from 'vitest';
import { Node } from '../src/core/scene/nodes/node';
import { parseNodeJson } from '../src/core/scene/nodes/parseNodeJson';
import { VehicleNode } from '../src/core/scene/nodes/vehicleNode';
import { WheelNode } from '../src/core/scene/nodes/wheelNode';
import { PhysicsSystem } from '../src/physics/physicsSystem';
import { installFeatures } from '../src/core/features/registry';
import vehicles from '../src/modules/vehicles/index';
import { TEST_PHYSICS } from './helpers/testPhysics';
import { LoopbackPort } from '../src/physics/worker/ports';

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
        vehicle.throttle = -1;
        frame(1);
        // Braking, not yet reversing.
        expect(vehicle.speed).toBeGreaterThan(-0.5);
        frame(6);
        expect(vehicle.speed).toBeLessThan(-1);
        expect(vehicle.gear).toBeLessThan(0);
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

import { describe, it, expect, beforeAll } from 'vitest';
import { Node } from '../src/core/scene/nodes/node';
import { parseNodeJson } from '../src/core/scene/nodes/parseNodeJson';
import { VehicleNode } from '../src/core/scene/nodes/vehicleNode';
import { ColliderNode } from '../src/core/scene/nodes/colliderNode';
import { VEHICLE_PRESETS, applyVehiclePreset } from '../src/core/scene/nodes/vehiclePresets';
import { PhysicsSystem } from '../src/physics/physicsSystem';
import { installFeatures } from '../src/core/features/registry';
import vehicles from '../src/modules/vehicles/index';
import { TEST_PHYSICS } from './helpers/testPhysics';
import { LoopbackPort } from '../src/physics/worker/ports';

// The Vehicle's presets: each lays a vehicle out (settings, wheels, chassis), keeps the meshes under its wheels,
// and drives as its name says on every backend (this suite runs again on Rapier and Jolt: PHYSICS_SUITES).

const IDENT = { rotation: [0, 0, 0], scale: [1, 1, 1] };
const box = (w: number, h: number, d: number) => ({ type: 'box', width: w, height: h, depth: d, offset: [0, 0, 0], rotation: [0, 0, 0] });

const floor = () => ({
    type: 'collider', name: 'Floor', id: 'floor', position: [0, -0.5, 0], ...IDENT, children: [],
    collider: { mass: 0, friction: 1, shapes: [box(2000, 1, 2000)] },
});

/** A chassis Collider holding an empty Vehicle, at `at`. */
const chassis = (id: string, at: number[]) => ({
    type: 'collider', name: id, id, position: at, ...IDENT,
    collider: { mass: 1200, linearDamping: 0, angularDamping: 0, shapes: [box(1.8, 0.6, 4)] },
    children: [{ type: 'vehicle', name: `${id} vehicle`, id: `${id}-vehicle`, position: [0, 0, 0], ...IDENT, children: [] }],
});

function vehicleIn(root: Node, id: string): VehicleNode {
    return root.getChildByName(id)[0].getChildByName(`${id} vehicle`)[0] as VehicleNode;
}

/** Started nodes in a running scene's physics, as vehicleNodes.test.ts builds them. */
function world(root: Node, worker = false) {
    const p = new PhysicsSystem({ gravity: [0, -9.81, 0], backend: TEST_PHYSICS });
    p.initialize();
    if (worker) p.setWorkerMode('on', () => new LoopbackPort());
    const nodes: Node[] = [];
    const walk = (n: Node) => { nodes.push(n); n.children.forEach(walk); };
    root.children.forEach(walk);
    const scene: any = { nodes, landscapes: [], tilemaps: [], activeCamera: null, physics: p, getNodeById: (id: string) => nodes.find(n => n.id === id) ?? null };
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

/** A vehicle laid out as `id`, its chassis set down so its wheels just touch, on a floor. */
function built(id: string) {
    const root = new Node('root');
    parseNodeJson(root, floor());
    parseNodeJson(root, chassis('car', [0, 0, 0]));
    const vehicle = vehicleIn(root, 'car');
    applyVehiclePreset(vehicle, id);
    const preset = VEHICLE_PRESETS.find(p => p.id === id)!;
    const lowest = Math.min(...preset.wheels.map(w => w.position[1] - w.radius));
    root.getChildByName('car')[0].setPosition([0, -lowest + 0.05, 0]);
    root.updateTransforms();
    return { root, vehicle, chassis: root.getChildByName('car')[0] as ColliderNode, ...world(root) };
}

/** Degrees the chassis is rolled from upright. */
function roll(node: Node): number {
    const [x, y, z, w] = node.worldQuaternion;
    return Math.abs(Math.asin(Math.max(-1, Math.min(1, 2 * (x * y + w * z))))) * 180 / Math.PI;
}

describe(`vehicle presets (${TEST_PHYSICS})`, () => {
    beforeAll(async () => {
        installFeatures([vehicles]);
        await new PhysicsSystem({ backend: TEST_PHYSICS }).load();
    });

    it('offers Car, Sports Car, Kart, Truck, Bus, Off-road, Bike and Trailer', () => {
        expect(VEHICLE_PRESETS.map(p => p.label)).toEqual(['Car', 'Sports Car', 'Kart', 'Truck', 'Bus', 'Off-road', 'Bike', 'Trailer']);
        for (const p of VEHICLE_PRESETS) {
            expect(p.description.length).toBeGreaterThan(20);
            // A preset never says what the vehicle is hitched to.
            expect('hitchTarget' in p.options).toBe(false);
        }
    });

    it('lays a vehicle out: its settings, its wheels and its chassis', () => {
        for (const preset of VEHICLE_PRESETS) {
            const root = new Node('root');
            parseNodeJson(root, chassis('car', [0, 1, 0]));
            const vehicle = vehicleIn(root, 'car');
            const result = applyVehiclePreset(vehicle, preset.id)!;
            expect(result.added).toHaveLength(preset.wheels.length);
            const wheels = vehicle.wheels;
            expect(wheels.map(w => w.name)).toEqual(preset.wheels.map(w => w.name));
            wheels.forEach((w, i) => {
                expect([...w.position].map(v => +v.toFixed(4))).toEqual(preset.wheels[i].position);
                expect(w.radius).toBe(preset.wheels[i].radius);
                expect(w.driven).toBe(preset.wheels[i].driven);
            });
            const collider = vehicle.collider as ColliderNode;
            expect(collider.mass).toBe(preset.chassis.mass);
            expect(collider.shapes[0]).toMatchObject({ type: 'box', width: preset.chassis.size[0], height: preset.chassis.size[1], depth: preset.chassis.size[2] });
            expect(vehicle.drive).toBe(preset.options.drive);
        }
    });

    it('leaves exactly the last preset applied, in any order', () => {
        const root = new Node('root');
        parseNodeJson(root, chassis('car', [0, 1, 0]));
        const vehicle = vehicleIn(root, 'car');
        for (const order of [VEHICLE_PRESETS, [...VEHICLE_PRESETS].reverse()]) {
            for (const preset of order) {
                applyVehiclePreset(vehicle, preset);
                for (const [k, v] of Object.entries(preset.options)) expect((vehicle as any)[k], `${preset.id}.${k}`).toEqual(v);
                expect(vehicle.wheels.map(w => [...w.position].map(x => +x.toFixed(4)))).toEqual(preset.wheels.map(w => w.position));
                for (const [i, w] of vehicle.wheels.entries()) expect(w.steerAngle, `${preset.id} wheel ${i}`).toBe(preset.wheels[i].steerAngle);
            }
        }
    });

    it('keeps the meshes under the wheels, and removes only bare extra wheels', () => {
        const root = new Node('root');
        parseNodeJson(root, chassis('car', [0, 1, 0]));
        const vehicle = vehicleIn(root, 'car');
        applyVehiclePreset(vehicle, 'truck');
        const [front, , , , , last] = vehicle.wheels;
        front.addChild(new Node('front tyre'));
        last.addChild(new Node('rear tyre'));
        const result = applyVehiclePreset(vehicle, 'car')!;
        // Four reused (the first one keeps its tyre); of the two extra, the bare one goes and the dressed one stays.
        expect(result.reused).toHaveLength(4);
        expect(result.removed).toHaveLength(1);
        expect(result.kept).toEqual([last]);
        expect(vehicle.wheels[0].children.map(c => c.name)).toEqual(['front tyre']);
        expect(vehicle.wheels[0].name).toBe('front left');
        expect(vehicle.wheels).toHaveLength(5);
    });

    it('renames only wheels that still have a default name', () => {
        const root = new Node('root');
        parseNodeJson(root, chassis('car', [0, 1, 0]));
        const vehicle = vehicleIn(root, 'car');
        vehicle.addWheel().name = 'my wheel';
        vehicle.addWheel();
        applyVehiclePreset(vehicle, 'bike');
        expect(vehicle.wheels.map(w => w.name)).toEqual(['my wheel', 'rear']);
    });

    for (const id of ['car', 'sportsCar', 'kart', 'truck', 'bus', 'offRoad', 'bike']) {
        it(`drives as a ${id}`, () => {
            const { vehicle, chassis: body, frame } = built(id);
            frame(1.5);
            const v = vehicle.vehicle!;
            for (let i = 0; i < v.wheelCount; i++) expect(v.wheel(i).grounded, `${id} wheel ${i}`).toBe(true);
            const z0 = body.worldPosition[2];
            vehicle.throttle = 1;
            let worst = 0;
            for (let i = 0; i < 6 * 60; i++) { frame(1 / 60); worst = Math.max(worst, roll(body)); }
            expect(vehicle.speed, id).toBeGreaterThan(id === 'truck' || id === 'bus' ? 3 : 6);
            expect(body.worldPosition[2] - z0).toBeGreaterThan(10);
            expect(worst, `${id} rolled`).toBeLessThan(20);
            if (id === 'kart') expect(vehicle.speed).toBeLessThan(16.7 * 1.05);
            if (id === 'truck') expect(vehicle.gear).toBeGreaterThanOrEqual(2);
            if (id === 'bike') {
                // Into a turn: it leans, comes round and stays up.
                vehicle.throttle = 0.3;
                vehicle.steer = 0.4;
                worst = 0;
                const f0 = body.worldTransform[8];
                for (let i = 0; i < 3 * 60; i++) { frame(1 / 60); worst = Math.max(worst, roll(body)); }
                expect(worst).toBeLessThan(60);
                expect(Math.abs(body.worldTransform[8] - f0)).toBeGreaterThan(0.1);
                expect(v.wheel(0).grounded && v.wheel(1).grounded).toBe(true);
            }
        });
    }

    function hitched(worker: boolean) {
        const root = new Node('root');
        parseNodeJson(root, floor());
        parseNodeJson(root, chassis('car', [0, 0.9, 0]));
        // The trailer behind the car, its tongue (1.7 m ahead of it) under the car's tail.
        parseNodeJson(root, { ...chassis('trailer', [0, 0.9, -3.75]), collider: { mass: 600, linearDamping: 0, angularDamping: 0, shapes: [box(1.6, 0.6, 2.4)] } });
        const car = vehicleIn(root, 'car'), trailer = vehicleIn(root, 'trailer');
        applyVehiclePreset(car, 'car');
        applyVehiclePreset(trailer, 'trailer');
        trailer.hitchTarget = 'car';
        root.updateTransforms();
        return { root, car, trailer, ...world(root, worker) };
    }

    for (const worker of [false, true]) {
        it(`tows a hitched trailer${worker ? ' with the physics worker stepping it' : ''}`, () => {
            const { root, car, trailer, p, frame } = hitched(worker);
            const carBody = root.getChildByName('car')[0], trailerBody = root.getChildByName('trailer')[0];
            // Where the trailer's hitch point is, in the car's frame: a hitch that holds keeps it where it was.
            const inCar = () => {
                const m = trailer.worldTransform, h = trailer.hitchPoint;
                const w = [0, 1, 2].map(k => m[k] * h[0] + m[4 + k] * h[1] + m[8 + k] * h[2] + m[12 + k]);
                const c = carBody.worldTransform, d = [w[0] - c[12], w[1] - c[13], w[2] - c[14]];
                // The car's rotation is orthonormal: its transpose takes world to car.
                return [0, 1, 2].map(k => c[4 * k] * d[0] + c[4 * k + 1] * d[1] + c[4 * k + 2] * d[2]);
            };
            frame(1.5);
            if (worker) expect(p.executor).toBe('worker');
            const before = inCar();
            car.throttle = 0.6;
            frame(3);
            car.steer = 0.5;
            frame(2);
            expect(car.speed).toBeGreaterThan(3);
            // The trailer came along: as far from the car as when it started, and its hitch held.
            expect(trailerBody.worldPosition[2]).toBeGreaterThan(2);
            const after = inCar();
            expect(Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2])).toBeLessThan(0.05);
        });
    }
});

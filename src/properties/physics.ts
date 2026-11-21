// The physics nodes' declared properties (see declare.ts): a Collider's body, a Trigger, and a Vehicle and its
// Wheels. Documented on the physics page (docs/editor/physics.md) and the vehicles page (docs/editor/vehicles.md).
// A body's shapes, a vehicle's wheel list and its live readout stay the cards' own.

import { CollisionLayer, CollisionMask, Vec2, Vec3 } from '../core/scripting/fieldTypes';
import { Choice, ListOf } from '../core/properties/types';
import { Node } from '../core/scene/nodes/node';
import { ColliderNode } from '../core/scene/nodes/colliderNode';
import { TriggerNode } from '../core/scene/nodes/triggerNode';
import { VehicleNode } from '../core/scene/nodes/vehicleNode';
import { WheelNode } from '../core/scene/nodes/wheelNode';
import { declareProperties, nodeIdAccess, type PropertyDeclaration } from './declare';

const whole = (v: number) => v.toFixed(0);

declareProperties(ColliderNode, 'Collider', [
    { title: '', props: [
        { key: 'simulatePhysics', label: 'Simulate Physics', type: Boolean },
        { key: 'mass', type: Number, min: 0, set: (n, v) => { n.mass = Math.max(0, Number(v)); } },
        { key: 'linearDamping', label: 'Damping', type: Number, min: 0, max: 1, step: 0.01 },
        { key: 'angularDamping', label: 'Angular Damping', type: Number, min: 0, max: 1, step: 0.01 },
        { key: 'friction', type: Number, min: 0, max: 1, step: 0.01 },
        { key: 'restitution', type: Number, min: 0, max: 1, step: 0.01 },
        { key: 'groundProbeDistance', label: 'Ground probe', type: Number, min: 0, max: 0.5, step: 0.01 },
        { key: 'motionSmoothing', label: 'Motion smoothing', type: Number, min: 0, max: 0.5, step: 0.01, divider: true },
        { key: 'layer', type: CollisionLayer },
        { key: 'mask', label: 'Collides with', type: CollisionMask, divider: true },
        // Frozen in place out of range, asleep at rest: what keeps a large level's far props free.
        { key: 'simulationMode', label: 'Simulation', type: Choice(['project', 'always', 'custom'], ['Project range', 'Always', 'Custom range']) },
        { key: 'simulationRange', label: 'Range (m)', type: Number, min: 0, step: 5, when: n => n.simulationMode === 'custom',
          set: (n, v) => { n.simulationRange = Math.max(0, Number(v)); } },
        { key: 'canSleep', label: 'Sleep when resting', type: Boolean },
    ] },
], { kind: 'physics', docs: 'editor/physics' });

// One card for both dimensions: a 3D trigger is its shapes (the card's), a 2D one a box.
declareProperties(TriggerNode, 'Trigger', [
    { title: '', props: [
        { key: 'enabled', type: Boolean, divider: true },
        { key: 'size', type: Vec2, min: 0, when: n => n.is2D },
        { key: 'offset', type: Vec2, when: n => n.is2D, divider: true },
        { key: 'layer', type: CollisionLayer },
        { key: 'mask', label: 'Detects', type: CollisionMask, divider: true },
        { key: 'detectTriggers', label: 'Detect triggers', type: Boolean },
        { key: 'continuous', type: Boolean, when: n => !n.is2D && n.detectTriggers },
    ] },
], { kind: 'physics', docs: 'editor/physics' });

// ----- Vehicle and Wheel -----

/** A vehicle already driving in Play is built again from what it holds now, so every change rebuilds it. */
function rebuilding<N extends Node>(rebuild: (n: N) => void, decl: PropertyDeclaration<N>): PropertyDeclaration<N> {
    return {
        ...decl,
        set: (n, v) => {
            if (decl.set) decl.set(n, v); else (n as any)[decl.key] = v;
            rebuild(n);
        },
    };
}

const vehicle = (decls: PropertyDeclaration<VehicleNode>[]) => decls.map(d => rebuilding<VehicleNode>(n => n.rebuild(), d));

/** The Vehicle a wheel is under, or null. */
function vehicleOf(wheel: WheelNode): VehicleNode | null {
    for (let n = wheel.parent; n; n = n.parent) if (n instanceof VehicleNode) return n;
    return null;
}
const wheel = (decls: PropertyDeclaration<WheelNode>[]) => decls.map(d => rebuilding<WheelNode>(n => vehicleOf(n)?.rebuild(), d));

/** What may tow a vehicle: another vehicle, or a chassis with mass, never its own. */
function towable(v: VehicleNode, candidate: any): boolean {
    const own = v.collider;
    if (candidate === v || candidate === own) return false;
    for (let p: Node | null = candidate; p; p = p.parent) if (p === own) return false;
    return candidate?.nodeType === 'vehicle' || (candidate?.nodeType === 'collider' && (candidate.mass ?? 0) > 0);
}

const engine = (n: VehicleNode) => n.drivetrain === 'engine';

declareProperties(VehicleNode, 'Vehicle', [
    { title: 'Drive', props: vehicle([
        { key: 'drivetrain', label: 'Power', type: Choice(['none', 'engine', 'motors'], ['None', 'Engine', 'Motors']) },
    ]) },
    { title: 'Driving', props: vehicle([
        { key: 'playerInput', label: 'Player input', type: Boolean },
        { key: 'parked', type: Boolean },
        { key: 'autoReverse', label: 'Auto reverse', type: Boolean },
    ]) },
    { title: 'Engine', when: engine, props: vehicle([
        { key: 'maxTorque', label: 'Torque', type: Number, min: 0, max: 3000, step: 10, readout: whole },
        { key: 'minRpm', label: 'Idle RPM', type: Number, min: 300, max: 3000, step: 50, readout: whole },
        { key: 'maxRpm', label: 'Redline RPM', type: Number, min: 2000, max: 12000, step: 100, readout: whole },
    ]) },
    { title: 'Gearbox', when: engine, props: vehicle([
        { key: 'shiftUpRpm', label: 'Shift up', type: Number, min: 1000, max: 12000, step: 100, readout: whole },
        { key: 'shiftDownRpm', label: 'Shift down', type: Number, min: 500, max: 8000, step: 100, readout: whole },
        { key: 'shiftTime', label: 'Shift time', type: Number, min: 0, max: 2, step: 0.05 },
        { key: 'finalDrive', label: 'Final drive', type: Number, min: 1, max: 10, step: 0.01 },
        { key: 'reverseRatio', label: 'Reverse ratio', type: Number, min: 0.5, max: 8, step: 0.01 },
        { key: 'clutchStrength', label: 'Clutch', type: Number, min: 1, max: 500, step: 1, readout: whole },
        // First gear first. A gear added reads 1 until it is set; the last one cannot be removed.
        { key: 'gearRatios', label: 'Gears', type: ListOf(Number),
          set: (n, v) => {
              const gears = (Array.isArray(v) ? v : []).map(g => (Number.isFinite(Number(g)) && Number(g) > 0 ? Number(g) : 1));
              if (gears.length) n.gearRatios = gears;
          } },
        { key: 'limitedSlip', label: 'Limited slip', type: Boolean },
    ]) },
    { title: 'Handling', props: vehicle([
        { key: 'antiRoll', label: 'Anti-roll', type: Number, min: 0, max: 20000, step: 100, readout: whole },
        { key: 'maxPitchRoll', label: 'Max pitch / roll', type: Number, min: 5, max: 180, step: 1, readout: whole },
        { key: 'cast', label: 'Wheel cast', type: Choice(['ray', 'sphere', 'cylinder'], ['Ray', 'Sphere', 'Cylinder']) },
    ]) },
    { title: 'Lean', props: vehicle([
        { key: 'lean', label: 'Lean into turns', type: Boolean },
        { key: 'maxLean', label: 'Max lean', type: Number, min: 5, max: 80, step: 1, readout: whole, when: n => n.lean },
        { key: 'leanSpring', label: 'Lean spring', type: Number, min: 0, max: 20000, step: 100, readout: whole, when: n => n.lean },
        { key: 'leanDamping', label: 'Lean damping', type: Number, min: 0, max: 5000, step: 50, readout: whole, when: n => n.lean },
    ]) },
    { title: 'Hitch', props: vehicle([
        { key: 'hitchTarget', label: 'Towed by', type: Node, accepts: towable, ...nodeIdAccess('hitchTarget') },
        { key: 'hitchPoint', label: 'Hitch point', type: Vec3, step: 0.05 },
    ]) },
], { docs: 'editor/vehicles', section: 'vehicle' });

declareProperties(WheelNode, 'Wheel', [
    { title: 'Tyre', props: wheel([
        { key: 'radius', type: Number, min: 0.05, max: 2, step: 0.01 },
        { key: 'width', type: Number, min: 0.02, max: 1, step: 0.01 },
        { key: 'grip', type: Number, min: 0.1, max: 2, step: 0.01 },
    ]) },
    { title: 'Suspension', props: wheel([
        { key: 'suspensionTravel', label: 'Travel', type: Number, min: 0, max: 1, step: 0.01 },
        // At least the travel: the spring is attached this far above the wheel.
        { key: 'suspensionLength', label: 'Length', type: Number, min: n => Math.max(0.05, n.suspensionTravel), max: 2, step: 0.01 },
        { key: 'suspensionFrequency', label: 'Frequency', type: Number, min: 0.3, max: 6, step: 0.05 },
        { key: 'suspensionDamping', label: 'Damping', type: Number, min: 0, max: 1.5, step: 0.01 },
    ]) },
    { title: 'Steering and brakes', props: wheel([
        { key: 'steerAngle', label: 'Steer angle', type: Number, min: 0, max: 60, step: 1, readout: whole },
        { key: 'brakeTorque', label: 'Brake', type: Number, min: 0, max: 10000, step: 50, readout: whole },
        { key: 'handBrakeTorque', label: 'Hand brake', type: Number, min: 0, max: 10000, step: 50, readout: whole },
        { key: 'driven', type: Boolean, when: n => vehicleOf(n)?.drivetrain === 'engine' },
    ]) },
    { title: 'Motor', when: n => vehicleOf(n)?.drivetrain === 'motors', props: wheel([
        { key: 'motorTorque', label: 'Torque', type: Number, min: 0, max: 3000, step: 10, readout: whole },
        // Kept in m/s, shown as the speed of the tyre's rim in km/h.
        { key: 'motorTopSpeed', label: 'Top speed', type: Number, min: 1, max: 300, step: 1, readout: v => `${v.toFixed(0)} km/h`,
          get: n => Math.round(n.motorTopSpeed * 3.6), set: (n, v) => { n.motorTopSpeed = Number(v) / 3.6; } },
    ]) },
], { docs: 'editor/vehicles', section: 'wheel' });

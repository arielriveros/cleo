import { applyPreset, definePresets, type Preset } from "../../presets";
import { WheelNode } from "./wheelNode";
import type { VehicleNode } from "./vehicleNode";
import type { Node } from "./node";
import type { VehicleCast, VehicleDrive } from "../../../physics/pal/vehicle/vehicleDesc";

// One-click vehicle configurations: a Vehicle's settings, its wheel layout and its chassis's mass and box
// (docs/editor/vehicles.md#presets). Unlike the behaviour presets (presets.ts), these lay a vehicle out, so they
// move and add wheels and size the chassis; they never set what it is hitched to (a target) or remove a wheel
// that carries a mesh.

/** The Vehicle fields a preset sets, every one (BASE below), so applying one never keeps the last one's. */
export interface VehicleSettings {
    drive: VehicleDrive;
    maxTorque: number; minRpm: number; maxRpm: number;
    gearRatios: number[]; reverseRatio: number; finalDrive: number;
    shiftDownRpm: number; shiftUpRpm: number; shiftTime: number; clutchStrength: number;
    limitedSlip: boolean; antiRoll: number; cast: VehicleCast; maxPitchRoll: number; autoReverse: boolean;
    lean: boolean; maxLean: number; leanSpring: number; leanDamping: number;
    hitchPoint: [number, number, number];
    /** Only the Trailer sets it (off): whether a vehicle answers the player is otherwise the developer's. */
    playerInput?: boolean;
}

/** One wheel of a layout: its name, its place (centre at full extension, in the Vehicle's frame) and settings. */
export interface WheelSlot {
    name: string;
    position: [number, number, number];
    radius: number; width: number; grip: number;
    suspensionTravel: number; suspensionLength: number; suspensionFrequency: number; suspensionDamping: number;
    steerAngle: number; driven: boolean; brakeTorque: number; handBrakeTorque: number;
    motorTorque: number; motorTopSpeed: number;
}

export interface VehiclePreset extends Preset<VehicleSettings> {
    chassis: { mass: number; size: [number, number, number] };
    wheels: WheelSlot[];
}

const BASE: VehicleSettings = {
    drive: 'engine',
    maxTorque: 500, minRpm: 1000, maxRpm: 6000,
    gearRatios: [2.66, 1.78, 1.3, 1, 0.74], reverseRatio: 2.9, finalDrive: 3.42,
    shiftDownRpm: 2000, shiftUpRpm: 4000, shiftTime: 0.5, clutchStrength: 10,
    limitedSlip: true, antiRoll: 1000, cast: 'cylinder', maxPitchRoll: 180, autoReverse: true,
    lean: false, maxLean: 45, leanSpring: 5000, leanDamping: 1000,
    hitchPoint: [0, 0, 2.2],
};

const WHEEL: Omit<WheelSlot, 'name' | 'position'> = {
    radius: 0.35, width: 0.25, grip: 1,
    suspensionTravel: 0.3, suspensionLength: 0.5, suspensionFrequency: 1.5, suspensionDamping: 0.5,
    steerAngle: 0, driven: false, brakeTorque: 1500, handBrakeTorque: 0,
    motorTorque: 0, motorTopSpeed: 27.8,
};

type SlotSpec = Partial<WheelSlot> & { name: string; position: [number, number, number] };
const slots = (shared: Partial<WheelSlot>, list: SlotSpec[]): WheelSlot[] => list.map(s => ({ ...WHEEL, ...shared, ...s }));

/** A left (+X) and right (−X) wheel of one axle. */
function axle(name: string, x: number, y: number, z: number, extra: Partial<WheelSlot> = {}): SlotSpec[] {
    return [{ name: `${name} left`, position: [x, y, z], ...extra }, { name: `${name} right`, position: [-x, y, z], ...extra }];
}

const settings = definePresets<VehicleSettings>(BASE, [
    ['car', 'Car', 'A road car: four wheels, the front ones steer, the rear ones drive. An engine and a five-speed automatic.', {}],
    ['sportsCar', 'Sports Car', 'Low, stiff and grippy: a strong engine to 8000 RPM, six gears, rear-wheel drive.', {
        maxTorque: 700, maxRpm: 8000, gearRatios: [3.0, 2.1, 1.6, 1.25, 1.0, 0.82], reverseRatio: 3.2, finalDrive: 3.7,
        shiftDownRpm: 4000, shiftUpRpm: 7200, shiftTime: 0.25, antiRoll: 4000,
    }],
    ['kart', 'Kart', 'Tiny and very stiff: an electric motor in each rear wheel to 60 km/h, no differential.', {
        drive: 'motors', limitedSlip: false, antiRoll: 0,
    }],
    ['truck', 'Truck', 'Heavy: six wheels on three axles, both rear axles driven, a low-revving engine and six low gears.', {
        maxTorque: 2000, minRpm: 600, maxRpm: 2800, gearRatios: [7.0, 4.5, 3.0, 2.0, 1.4, 1.0], reverseRatio: 6.5, finalDrive: 4.1,
        shiftDownRpm: 1100, shiftUpRpm: 2300, shiftTime: 0.6, clutchStrength: 200, antiRoll: 20000,
    }],
    ['bus', 'Bus', 'Long and heavy, softly sprung: a long wheelbase, rear-wheel drive, five gears.', {
        maxTorque: 1800, minRpm: 600, maxRpm: 2500, gearRatios: [5.5, 3.4, 2.2, 1.5, 1.0], reverseRatio: 5, finalDrive: 4.5,
        shiftDownRpm: 1000, shiftUpRpm: 2100, shiftTime: 0.6, clutchStrength: 200, antiRoll: 30000,
    }],
    ['offRoad', 'Off-road', 'A buggy: long soft suspension, all-wheel drive with limited slip, big loose-gripping tyres.', {
        maxTorque: 450, gearRatios: [3.2, 2.1, 1.5, 1.1, 0.85], reverseRatio: 3.3, finalDrive: 4.1,
        shiftDownRpm: 2000, shiftUpRpm: 4500, antiRoll: 500,
    }],
    ['bike', 'Bike', 'A motorcycle: two wheels in line, the rear one driven, leaning into turns. A high-revving engine.', {
        maxTorque: 120, maxRpm: 10000, shiftDownRpm: 4000, shiftUpRpm: 8500, limitedSlip: false, antiRoll: 0,
        lean: true, maxPitchRoll: 60,
    }],
    ['trailer', 'Trailer', 'Unpowered, on one axle, hitched by its tongue: set Towed by to the vehicle that pulls it.', {
        drive: 'none', hitchPoint: [0, -0.1, 1.7], playerInput: false,
    }],
]);

const LAYOUTS: Record<string, { chassis: VehiclePreset['chassis']; wheels: WheelSlot[] }> = {
    car: {
        chassis: { mass: 1200, size: [1.8, 0.6, 4] },
        wheels: slots({}, [
            ...axle('front', 0.8, -0.5, 1.3, { steerAngle: 30 }),
            ...axle('rear', 0.8, -0.5, -1.3, { driven: true, handBrakeTorque: 4000 }),
        ]),
    },
    sportsCar: {
        chassis: { mass: 1300, size: [1.9, 0.5, 4.4] },
        wheels: slots({ radius: 0.34, width: 0.3, grip: 1.15, suspensionTravel: 0.2, suspensionLength: 0.4, suspensionFrequency: 2.2, suspensionDamping: 0.6, brakeTorque: 3000 }, [
            ...axle('front', 0.85, -0.4, 1.4, { steerAngle: 28 }),
            ...axle('rear', 0.85, -0.4, -1.35, { driven: true, handBrakeTorque: 4000 }),
        ]),
    },
    kart: {
        chassis: { mass: 150, size: [1.0, 0.2, 1.5] },
        wheels: slots({ radius: 0.14, width: 0.15, suspensionTravel: 0.03, suspensionLength: 0.08, suspensionFrequency: 4, suspensionDamping: 0.7, brakeTorque: 300 }, [
            ...axle('front', 0.5, -0.15, 0.55, { steerAngle: 25 }),
            ...axle('rear', 0.5, -0.15, -0.55, { motorTorque: 60, motorTopSpeed: 16.7, handBrakeTorque: 500 }),
        ]),
    },
    truck: {
        chassis: { mass: 8000, size: [2.4, 1.2, 8] },
        wheels: slots({ radius: 0.5, width: 0.4, suspensionTravel: 0.25, suspensionLength: 0.55, suspensionFrequency: 1.2, brakeTorque: 8000 }, [
            ...axle('front', 1.0, -0.8, 3.0, { steerAngle: 35 }),
            ...axle('rear 1', 1.0, -0.8, -1.6, { driven: true, handBrakeTorque: 12000 }),
            ...axle('rear 2', 1.0, -0.8, -2.9, { driven: true, handBrakeTorque: 12000 }),
        ]),
    },
    bus: {
        chassis: { mass: 12000, size: [2.5, 1.6, 11] },
        wheels: slots({ radius: 0.5, width: 0.35, suspensionTravel: 0.2, suspensionLength: 0.5, suspensionFrequency: 1.1, brakeTorque: 10000 }, [
            ...axle('front', 1.05, -1.0, 3.6, { steerAngle: 35 }),
            ...axle('rear', 1.05, -1.0, -2.6, { driven: true, handBrakeTorque: 15000 }),
        ]),
    },
    offRoad: {
        chassis: { mass: 900, size: [1.7, 0.5, 3.2] },
        wheels: slots({ radius: 0.42, width: 0.32, grip: 0.9, suspensionTravel: 0.45, suspensionLength: 0.75, suspensionFrequency: 1.2, suspensionDamping: 0.45, driven: true }, [
            ...axle('front', 0.8, -0.55, 1.15, { steerAngle: 32 }),
            ...axle('rear', 0.8, -0.55, -1.15, { handBrakeTorque: 3000 }),
        ]),
    },
    bike: {
        // The body rides low between the wheels (their springs are attached above its middle), as a motorcycle's
        // does: a high one pulls wheelies under throttle.
        chassis: { mass: 220, size: [0.35, 0.6, 1.8] },
        wheels: slots({ radius: 0.32, width: 0.15, suspensionFrequency: 1.8, suspensionDamping: 0.6 }, [
            { name: 'front', position: [0, -0.3, 0.7], steerAngle: 30 },
            { name: 'rear', position: [0, -0.3, -0.7], driven: true, brakeTorque: 800 },
        ]),
    },
    trailer: {
        chassis: { mass: 600, size: [1.6, 0.6, 2.4] },
        wheels: slots({ suspensionTravel: 0.25, suspensionLength: 0.45, suspensionFrequency: 1.6, brakeTorque: 800, handBrakeTorque: 1500 }, [
            ...axle('axle', 0.75, -0.5, -0.2),
        ]),
    },
};

/** Every vehicle preset, in menu order. */
export const VEHICLE_PRESETS: readonly VehiclePreset[] = settings.map(p => ({ ...p, ...LAYOUTS[p.id] }));

const SLOT_NAMES = new Set(VEHICLE_PRESETS.flatMap(p => p.wheels.map(w => w.name)));
/** A wheel still named as addWheel or a preset named it: one a preset may rename. */
const defaultName = (name: string) => /^wheel \d+$/.test(name) || SLOT_NAMES.has(name);

export interface VehiclePresetResult {
    /** Wheels made for the layout, wheels moved into it, wheels removed (nothing under them), wheels kept (a mesh under them). */
    added: WheelNode[];
    reused: WheelNode[];
    removed: WheelNode[];
    kept: WheelNode[];
}

/**
 * Lay `vehicle` out as a preset: its settings, its chassis's mass and box (the Collider's first box shape, one
 * added if it has none) and its wheels. Existing wheels are reused in order, keeping what is under them (their
 * meshes move with them); missing ones are made, with no mesh; extra ones are removed only when nothing is under
 * them (through `options.remove` when given: the editor's scene removal). A wheel still carrying a default name
 * takes the slot's. Null for an unknown id.
 */
export function applyVehiclePreset(vehicle: VehicleNode, idOrPreset: string | VehiclePreset,
                                   options: { remove?: (node: Node) => void } = {}): VehiclePresetResult | null {
    const preset = typeof idOrPreset === 'string' ? VEHICLE_PRESETS.find(p => p.id === idOrPreset) : idOrPreset;
    if (!preset) return null;
    applyPreset(vehicle, [preset], preset);

    const chassis = vehicle.collider as (Node & { mass?: number; shapes?: Record<string, unknown>[] }) | null;
    if (chassis && chassis !== (vehicle as Node) && chassis.nodeType === 'collider') {
        chassis.mass = preset.chassis.mass;
        const [width, height, depth] = preset.chassis.size;
        const shapes = [...(chassis.shapes ?? [])];
        const i = shapes.findIndex(s => s.type === 'box');
        if (i >= 0) shapes[i] = { ...shapes[i], width, height, depth };
        else shapes.unshift({ type: 'box', width, height, depth, offset: [0, 0, 0], rotation: [0, 0, 0] });
        chassis.shapes = shapes;
    }

    const result: VehiclePresetResult = { added: [], reused: [], removed: [], kept: [] };
    const existing = vehicle.wheels;
    preset.wheels.forEach((slot, i) => {
        let wheel = existing[i];
        if (wheel) result.reused.push(wheel);
        else {
            wheel = new WheelNode(slot.name);
            vehicle.addChild(wheel);
            result.added.push(wheel);
        }
        if (defaultName(wheel.name)) wheel.name = slot.name;
        const { name: _name, position, ...fields } = slot;
        Object.assign(wheel, fields);
        wheel._forgetRest();
        wheel.setPosition(position as unknown as Float32Array);
    });
    for (const extra of existing.slice(preset.wheels.length)) {
        if (extra.children.length === 0 && extra.parent) {
            if (options.remove) options.remove(extra); else extra.parent.removeChild(extra);
            result.removed.push(extra);
        }
        else result.kept.push(extra);
    }
    vehicle.rebuild();
    return result;
}

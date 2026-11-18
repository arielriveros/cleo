import type { BodyHandle, V3 } from '../types';

// A vehicle as the physics layer builds it: one chassis body carried by virtual wheels. A wheel is not a
// body. Each substep it finds the ground (a ray or a cast shape down its suspension), and its spring,
// damper and tyre push the chassis at the contact. This is how Jolt, PhysX, Chaos, Unity and Bullet all do
// it: jointed wheel bodies tunnel, bounce on mesh edges and go soft in an iterative solver.
//
// Plain data in SI units (metres, kilograms, seconds, radians, newton-metres, RPM), modelled on Jolt's
// VehicleConstraintSettings: the most complete of the three backends'. Every backend builds the vehicle
// from this one description (see each pal/<backend>/<backend>Vehicle.ts), so one tuning drives alike on
// all of them.
//
// Frames: positions and directions are in the chassis body's frame, measured from its NODE ORIGIN, like
// joint anchors (types.ts).

/** A `[x, y]` point of a piecewise-linear curve. */
export type CurvePoint = readonly [number, number];

/** One wheel. Unset fields take the defaults in {@link WHEEL_DEFAULTS}. */
export interface WheelDesc {
    /** Where the suspension is attached: the wheel centre at full compression, minus `suspensionMinLength`. */
    position: V3;
    /** The way the suspension extends (toward the ground). Default `[0, -1, 0]`. */
    suspensionDirection?: V3;
    radius?: number;
    width?: number;
    /** From the attachment to the wheel centre, fully compressed and fully extended. */
    suspensionMinLength?: number;
    suspensionMaxLength?: number;
    /** The spring's natural frequency (Hz) and damping ratio (0 = undamped, 1 = critical). */
    suspensionFrequency?: number;
    suspensionDamping?: number;
    /** Most the spring may push, N. Default: no cap. */
    maxSuspensionForce?: number;
    /** Steering lock, radians: 0 for a wheel that does not steer. */
    maxSteerAngle?: number;
    maxBrakeTorque?: number;
    /** 0 for a wheel the hand brake does not hold. */
    maxHandBrakeTorque?: number;
    /** Friction coefficient against slip ratio (|ωr − v| / |v|). */
    longitudinalFriction?: readonly CurvePoint[];
    /** Friction coefficient against slip angle, in DEGREES (Jolt's convention). */
    lateralFriction?: readonly CurvePoint[];
    /** kg·m² of the wheel about its axle, and the fraction of its spin lost per second. */
    inertia?: number;
    angularDamping?: number;
    /** With `drive: 'motors'`: this wheel's own motor, N·m at full throttle (0 or unset: not motored). */
    motorTorque?: number;
    /** With `drive: 'motors'`: the motor's top speed, rad/s at the wheel. Default 100 (126 km/h on a 0.35 m wheel). */
    motorMaxSpeed?: number;
}

export interface VehicleEngineDesc {
    /** N·m at the peak of the torque curve. */
    maxTorque?: number;
    minRpm?: number;
    maxRpm?: number;
    /** Torque as a fraction of maxTorque, against RPM as a fraction of maxRpm. */
    torqueCurve?: readonly CurvePoint[];
    inertia?: number;
    angularDamping?: number;
}

export interface VehicleTransmissionDesc {
    /** Forward gears' ratios, first first. */
    gearRatios?: readonly number[];
    /** Reverse gears' ratios, negative. */
    reverseGearRatios?: readonly number[];
    /** Seconds a gear change takes, with no torque through the clutch. */
    switchTime?: number;
    /** Seconds the clutch takes to bite again after a change. */
    clutchReleaseTime?: number;
    /** Seconds after a change before the next may start. */
    switchLatency?: number;
    shiftUpRpm?: number;
    shiftDownRpm?: number;
    /** How hard the clutch couples the engine to the wheels. */
    clutchStrength?: number;
}

/** A differential: an axle the engine drives. A wheel index of -1 means none on that side. */
export interface VehicleDifferentialDesc {
    leftWheel: number;
    rightWheel: number;
    /** Final drive ratio. */
    ratio?: number;
    /** Share of the torque to the left wheel (0.5 = even). */
    leftRightSplit?: number;
    /** Most the faster wheel may spin over the slower before torque shifts to the slower. Infinity = open. */
    limitedSlipRatio?: number;
    /** Share of the engine's torque this differential takes (the ratios add to 1). */
    engineTorqueRatio?: number;
}

/** An anti-roll bar: resists one wheel of an axle compressing more than the other. */
export interface VehicleAntiRollBarDesc {
    leftWheel: number;
    rightWheel: number;
    /** N/m. */
    stiffness?: number;
}

/** What a wheel finds the ground with: a ray down its centre, a sphere, or its own cylinder. */
export type VehicleCast = 'ray' | 'sphere' | 'cylinder';

/**
 * What powers it: an engine through a gearbox to the `differentials`, an electric motor in each wheel that
 * has a `motorTorque`, or nothing (it rolls, steers and brakes).
 */
export type VehicleDrive = 'engine' | 'motors' | 'none';

export interface VehicleDesc {
    /** The chassis: a dynamic body of this world. */
    chassis: BodyHandle;
    /** Default: `'engine'` when there are differentials, `'none'` otherwise. */
    drive?: VehicleDrive;
    /** The chassis's up and forward, in its frame. Default `[0, 1, 0]` and `[0, 0, 1]` (the engine's +Z forward). */
    up?: V3;
    forward?: V3;
    wheels: readonly WheelDesc[];
    engine?: VehicleEngineDesc;
    transmission?: VehicleTransmissionDesc;
    /** Default: none, which leaves the vehicle undriven (it rolls, brakes and steers). */
    differentials?: readonly VehicleDifferentialDesc[];
    /** Most the differentials together may let the front and rear axles' speeds differ (Infinity = open). */
    differentialLimitedSlipRatio?: number;
    antiRollBars?: readonly VehicleAntiRollBarDesc[];
    /** Most the chassis may pitch or roll from upright, radians: past it the vehicle is held. Default π (free). */
    maxPitchRollAngle?: number;
    /** Default `'cylinder'`, where the backend can (capabilities.vehicleCasts); a ray otherwise. */
    cast?: VehicleCast;
}

/** What a driver asks of it, each frame. */
export interface VehicleInput {
    /** -1 (full reverse) .. 1 (full throttle). */
    forward: number;
    /** -1 (full left) .. 1 (full right). */
    right: number;
    /** 0 .. 1. */
    brake: number;
    /** 0 .. 1. */
    handBrake: number;
}

/** A vehicle in a world, as the world hands it out. */
export type VehicleHandle = number & { readonly __physicsVehicle: unique symbol };

// ---- defaults (Jolt's own, so a description means the same on every backend) ----

const DEG = Math.PI / 180;

export const WHEEL_DEFAULTS = {
    suspensionDirection: [0, -1, 0] as V3,
    radius: 0.3,
    width: 0.1,
    suspensionMinLength: 0.3,
    suspensionMaxLength: 0.5,
    suspensionFrequency: 1.5,
    suspensionDamping: 0.5,
    maxSuspensionForce: Infinity,
    maxSteerAngle: 70 * DEG,
    maxBrakeTorque: 1500,
    maxHandBrakeTorque: 4000,
    longitudinalFriction: [[0, 0], [0.06, 1.2], [0.2, 1]] as readonly CurvePoint[],
    lateralFriction: [[0, 0], [3, 1.2], [20, 1]] as readonly CurvePoint[],
    inertia: 0.9,
    angularDamping: 0.2,
};

export const ENGINE_DEFAULTS = {
    maxTorque: 500,
    minRpm: 1000,
    maxRpm: 6000,
    torqueCurve: [[0, 0.8], [0.66, 1], [1, 0.8]] as readonly CurvePoint[],
    inertia: 0.5,
    angularDamping: 0.2,
};

export const TRANSMISSION_DEFAULTS = {
    gearRatios: [2.66, 1.78, 1.3, 1, 0.74] as readonly number[],
    reverseGearRatios: [-2.9] as readonly number[],
    switchTime: 0.5,
    clutchReleaseTime: 0.3,
    switchLatency: 0.5,
    shiftUpRpm: 4000,
    shiftDownRpm: 2000,
    clutchStrength: 10,
};

export const DIFFERENTIAL_DEFAULTS = { ratio: 3.42, leftRightSplit: 0.5, limitedSlipRatio: 1.4, engineTorqueRatio: 1 };
export const ANTI_ROLL_DEFAULTS = { stiffness: 1000 };

// ---- the normalised form every backend builds from ----

export type NormalizedWheel = { position: V3 } & { -readonly [K in keyof typeof WHEEL_DEFAULTS]: (typeof WHEEL_DEFAULTS)[K] };
export type NormalizedEngine = typeof ENGINE_DEFAULTS;
export type NormalizedTransmission = typeof TRANSMISSION_DEFAULTS;
export type NormalizedDifferential = { leftWheel: number; rightWheel: number } & typeof DIFFERENTIAL_DEFAULTS;
export type NormalizedAntiRollBar = { leftWheel: number; rightWheel: number; stiffness: number };

/**
 * A vehicle with every field set, checked, and without its chassis: what a copy of the world (the physics
 * worker's) is sent, and what every backend builds from.
 */
export interface NormalizedVehicle {
    up: V3;
    forward: V3;
    wheels: NormalizedWheel[];
    engine: NormalizedEngine;
    transmission: NormalizedTransmission;
    differentials: NormalizedDifferential[];
    differentialLimitedSlipRatio: number;
    antiRollBars: NormalizedAntiRollBar[];
    maxPitchRollAngle: number;
    cast: VehicleCast;
}

const finite = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const positive = (v: unknown, fallback: number): number => (typeof v === 'number' && v > 0 ? v : fallback);
const nonNegative = (v: unknown, fallback: number): number => (typeof v === 'number' && v >= 0 ? v : fallback);
/** A positive number, Infinity allowed (an uncapped force, an open differential). */
const positiveOrInfinite = (v: unknown, fallback: number): number => (typeof v === 'number' && v > 0 ? v : fallback);

function unit(v: V3 | undefined, fallback: V3): V3 {
    if (!v) return fallback;
    const l = Math.hypot(v[0], v[1], v[2]);
    return l > 1e-9 && Number.isFinite(l) ? [v[0] / l, v[1] / l, v[2] / l] : fallback;
}

function curve(points: readonly CurvePoint[] | undefined, fallback: readonly CurvePoint[]): readonly CurvePoint[] {
    if (!points) return fallback;
    const kept = points.filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1])).map(p => [p[0], p[1]] as CurvePoint);
    kept.sort((a, b) => a[0] - b[0]);
    return kept.length > 0 ? kept : fallback;
}

function wheelIndex(i: number, count: number): number {
    return Number.isInteger(i) && i >= 0 && i < count ? i : -1;
}

/** A vehicle as built: its chassis and its normalised description (what a copy of the world builds it from). */
export interface VehicleRecord {
    readonly chassis: BodyHandle;
    readonly vehicle: NormalizedVehicle;
}

/** Engine RPM at a motor's top speed: the model's limiter, where the motors' own speed limits land. */
const MOTOR_RPM = 6000;
const DEFAULT_MOTOR_SPEED = 100;

/**
 * Electric motors in the wheels as the engine model every backend already runs (Jolt's drivetrain, and the
 * shared one): one engine of flat torque, one gear, and an open differential per motored wheel whose ratio
 * puts that wheel's top speed at the engine's limiter and whose share gives it its own torque. Each wheel then
 * pushes with its motor's torque up to its motor's speed. The motors share the one throttle.
 */
function motorsAsEngine(desc: Omit<VehicleDesc, 'chassis'>): Omit<VehicleDesc, 'chassis'> {
    const engineOmega = MOTOR_RPM * Math.PI / 30;
    const motored = desc.wheels.map((w, i) => ({ i, torque: w.motorTorque ?? 0, speed: w.motorMaxSpeed ?? DEFAULT_MOTOR_SPEED }))
        .filter(m => m.torque > 0 && Number.isFinite(m.torque) && m.speed > 0 && Number.isFinite(m.speed));
    if (motored.length === 0) return { ...desc, differentials: [] };
    const ratios = motored.map(m => engineOmega / m.speed);
    const shares = motored.map((m, k) => m.torque / ratios[k]);
    const total = shares.reduce((a, b) => a + b, 0);
    return {
        ...desc,
        engine: { maxTorque: total, minRpm: 1, maxRpm: MOTOR_RPM, torqueCurve: [[0, 1], [1, 1]], inertia: 0.05, angularDamping: 0 },
        transmission: { gearRatios: [1], reverseGearRatios: [-1], switchTime: 0, clutchReleaseTime: 0, switchLatency: 0, shiftUpRpm: MOTOR_RPM * 2, shiftDownRpm: 0.5, clutchStrength: 100 },
        differentials: motored.map((m, k) => ({ leftWheel: m.i, rightWheel: -1, ratio: ratios[k], limitedSlipRatio: Infinity, engineTorqueRatio: shares[k] / total })),
        differentialLimitedSlipRatio: Infinity,
    };
}

/** Every field of a vehicle set and in range. Throws on what cannot be fixed (no wheels). */
export function normalizeVehicle(desc: Omit<VehicleDesc, 'chassis'>): NormalizedVehicle {
    if (!desc.wheels || desc.wheels.length === 0) throw new Error('physics: a vehicle needs at least one wheel');
    const drive = desc.drive ?? ((desc.differentials?.length ?? 0) > 0 ? 'engine' : 'none');
    if (drive === 'motors') desc = motorsAsEngine(desc);
    else if (drive === 'none') desc = { ...desc, differentials: [] };
    const W = WHEEL_DEFAULTS, E = ENGINE_DEFAULTS, T = TRANSMISSION_DEFAULTS, D = DIFFERENTIAL_DEFAULTS;
    const wheels: NormalizedWheel[] = desc.wheels.map(w => {
        const min = nonNegative(w.suspensionMinLength, W.suspensionMinLength);
        const max = Math.max(min, nonNegative(w.suspensionMaxLength, Math.max(min, W.suspensionMaxLength)));
        return {
            position: [finite(w.position[0], 0), finite(w.position[1], 0), finite(w.position[2], 0)],
            suspensionDirection: unit(w.suspensionDirection, W.suspensionDirection),
            radius: positive(w.radius, W.radius),
            width: positive(w.width, W.width),
            suspensionMinLength: min,
            suspensionMaxLength: max,
            suspensionFrequency: positive(w.suspensionFrequency, W.suspensionFrequency),
            suspensionDamping: nonNegative(w.suspensionDamping, W.suspensionDamping),
            maxSuspensionForce: positiveOrInfinite(w.maxSuspensionForce, W.maxSuspensionForce),
            maxSteerAngle: Math.min(Math.PI / 2, nonNegative(w.maxSteerAngle, W.maxSteerAngle)),
            maxBrakeTorque: nonNegative(w.maxBrakeTorque, W.maxBrakeTorque),
            maxHandBrakeTorque: nonNegative(w.maxHandBrakeTorque, W.maxHandBrakeTorque),
            longitudinalFriction: curve(w.longitudinalFriction, W.longitudinalFriction),
            lateralFriction: curve(w.lateralFriction, W.lateralFriction),
            inertia: positive(w.inertia, W.inertia),
            angularDamping: nonNegative(w.angularDamping, W.angularDamping),
        };
    });
    const n = wheels.length;
    const e = desc.engine ?? {};
    const minRpm = positive(e.minRpm, E.minRpm);
    const engine: NormalizedEngine = {
        maxTorque: nonNegative(e.maxTorque, E.maxTorque),
        minRpm,
        maxRpm: Math.max(minRpm + 1, positive(e.maxRpm, E.maxRpm)),
        torqueCurve: curve(e.torqueCurve, E.torqueCurve),
        inertia: positive(e.inertia, E.inertia),
        angularDamping: nonNegative(e.angularDamping, E.angularDamping),
    };
    const t = desc.transmission ?? {};
    const gears = (t.gearRatios ?? T.gearRatios).filter(r => r > 0 && Number.isFinite(r));
    const reverse = (t.reverseGearRatios ?? T.reverseGearRatios).filter(r => r < 0 && Number.isFinite(r));
    const transmission: NormalizedTransmission = {
        gearRatios: gears.length > 0 ? gears : T.gearRatios,
        reverseGearRatios: reverse.length > 0 ? reverse : T.reverseGearRatios,
        switchTime: nonNegative(t.switchTime, T.switchTime),
        clutchReleaseTime: nonNegative(t.clutchReleaseTime, T.clutchReleaseTime),
        switchLatency: nonNegative(t.switchLatency, T.switchLatency),
        shiftUpRpm: positive(t.shiftUpRpm, T.shiftUpRpm),
        shiftDownRpm: positive(t.shiftDownRpm, T.shiftDownRpm),
        clutchStrength: positive(t.clutchStrength, T.clutchStrength),
    };
    const differentials: NormalizedDifferential[] = (desc.differentials ?? [])
        .map(d => ({
            leftWheel: wheelIndex(d.leftWheel, n), rightWheel: wheelIndex(d.rightWheel, n),
            ratio: positive(d.ratio, D.ratio),
            leftRightSplit: Math.min(1, nonNegative(d.leftRightSplit, D.leftRightSplit)),
            limitedSlipRatio: positiveOrInfinite(d.limitedSlipRatio, D.limitedSlipRatio),
            engineTorqueRatio: nonNegative(d.engineTorqueRatio, D.engineTorqueRatio),
        }))
        .filter(d => d.leftWheel >= 0 || d.rightWheel >= 0);
    const antiRollBars: NormalizedAntiRollBar[] = (desc.antiRollBars ?? [])
        .map(b => ({ leftWheel: wheelIndex(b.leftWheel, n), rightWheel: wheelIndex(b.rightWheel, n), stiffness: nonNegative(b.stiffness, ANTI_ROLL_DEFAULTS.stiffness) }))
        .filter(b => b.leftWheel >= 0 && b.rightWheel >= 0 && b.leftWheel !== b.rightWheel);
    return {
        up: unit(desc.up, [0, 1, 0]),
        forward: unit(desc.forward, [0, 0, 1]),
        wheels,
        engine,
        transmission,
        differentials,
        differentialLimitedSlipRatio: positiveOrInfinite(desc.differentialLimitedSlipRatio, 1.4),
        antiRollBars,
        maxPitchRollAngle: Math.min(Math.PI, positive(desc.maxPitchRollAngle, Math.PI)),
        cast: desc.cast === 'ray' || desc.cast === 'sphere' ? desc.cast : 'cylinder',
    };
}

/** The cast a backend builds: the one asked for where it can, a ray otherwise. */
export function castFor(asked: VehicleCast, supported: readonly VehicleCast[]): VehicleCast {
    return supported.includes(asked) ? asked : 'ray';
}

/** A wheel's right (its axle), in the chassis frame: forward × up. With +Z forward and +Y up that is −X. */
export function wheelRight(v: Pick<NormalizedVehicle, 'up' | 'forward'>): V3 {
    const f = v.forward, u = v.up;
    return [f[1] * u[2] - f[2] * u[1], f[2] * u[0] - f[0] * u[2], f[0] * u[1] - f[1] * u[0]];
}

/** 0, 1 or 2: the axis a direction mostly points along (a Bullet port names its chassis axes by index). */
export function dominantAxis(v: ArrayLike<number>): number {
    const ax = Math.abs(v[0]), ay = Math.abs(v[1]), az = Math.abs(v[2]);
    return ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
}

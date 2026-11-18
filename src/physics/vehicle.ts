import { clamp as clampRange } from '../core/math';
import type { PhysicsWorld } from './pal/world';
import type { PhysicsBody } from './physicsBody';
import type { BodyHandle } from './pal/types';
import { normalizeVehicle, type NormalizedVehicle, type VehicleDesc, type VehicleHandle, type VehicleInput } from './pal/vehicle/vehicleDesc';
import {
    VH_GEAR, VH_RPM, VH_SPEED, W_ANGLE, W_CONTACT, W_LAT_SLIP, W_LENGTH, W_LONG_SLIP, W_NORMAL, W_OMEGA, W_POINT, W_STEER,
    restingState, vehicleStateSize, wheelOffset,
} from './pal/vehicle/vehicleState';

/** Below this speed (m/s) a throttle the other way reverses instead of braking. */
const REVERSE_SPEED = 1;

/** One wheel as a script reads it, after the last step. */
export interface VehicleWheelState {
    /** On the ground. */
    grounded: boolean;
    /** Attachment to wheel centre, m. */
    suspensionLength: number;
    /** 0 fully extended .. 1 fully compressed. */
    compression: number;
    /** Radians, positive LEFT (the engine's counter-clockwise convention). */
    steerAngle: number;
    /** Radians about the axle, positive rolling forward, and its rate (rad/s). */
    rotation: number;
    angularVelocity: number;
    /** World space, where it touches (zero in the air), and the ground's normal there. */
    contactPoint: [number, number, number];
    contactNormal: [number, number, number];
    /** Slip ratio, and slip angle in radians. */
    longitudinalSlip: number;
    lateralSlip: number;
}

/**
 * A vehicle on an engine body: virtual wheels that carry, drive, brake and steer it (see
 * pal/vehicle/vehicleDesc.ts for what a description holds and how each backend builds it). The engine's
 * handle on it, the way a PhysicsBody is a body's: it keeps the description and the driver's input, builds
 * the vehicle in whatever world its chassis is in (again after a world clear, a backend change, or the
 * chassis leaving and coming back), and holds what the last step left it at.
 *
 * Driving: set {@link throttle} (-1 .. 1), {@link steer} (-1 left .. 1 right), {@link brake} and
 * {@link handBrake} (0 .. 1). By default the throttle is a driver's pedal pair: held against the way the
 * vehicle rolls it brakes, and reverses once nearly stopped ({@link autoReverse}).
 */
export class Vehicle {
    public readonly vehicle: NormalizedVehicle;
    /** -1 (full reverse) .. 1 (full throttle). */
    public throttle = 0;
    /** -1 (full left) .. 1 (full right). */
    public steer = 0;
    /** 0 .. 1. */
    public brake = 0;
    /** 0 .. 1. */
    public handBrake = 0;
    /**
     * A throttle against the direction of travel brakes until the vehicle is nearly stopped, then drives
     * that way (a road car's pedals). False: the throttle goes straight to the gearbox, which reverses.
     */
    public autoReverse = true;

    private _chassis: PhysicsBody | null = null;
    private _world: PhysicsWorld | null = null;
    private _built: { handle: VehicleHandle; chassis: BodyHandle } | null = null;
    private readonly _state: number[];
    private readonly _input: VehicleInput = { forward: 0, right: 0, brake: 0, handBrake: 0 };
    private readonly _wheels: VehicleWheelState[];

    constructor(desc: Omit<VehicleDesc, 'chassis'>) {
        this.vehicle = normalizeVehicle(desc);
        this._state = new Array<number>(vehicleStateSize(this.vehicle.wheels.length)).fill(0);
        restingState(this.vehicle.wheels.map(w => w.suspensionMaxLength), this._state);
        this._wheels = this.vehicle.wheels.map(w => ({
            grounded: false, suspensionLength: w.suspensionMaxLength, compression: 0, steerAngle: 0, rotation: 0,
            angularVelocity: 0, contactPoint: [0, 0, 0], contactNormal: [0, 1, 0], longitudinalSlip: 0, lateralSlip: 0,
        }));
    }

    /** The body it carries, or null. */
    public get chassis(): PhysicsBody | null { return this._chassis; }

    /** Whether it is built in a world and simulated. */
    public get active(): boolean { return this._built !== null; }

    /** Forward speed, m/s (negative backing up). */
    public get speed(): number { return this._state[VH_SPEED]; }
    public get rpm(): number { return this._state[VH_RPM]; }
    /** The gear engaged: 1, 2, … forward, -1 reverse, 0 neutral. */
    public get gear(): number { return this._state[VH_GEAR]; }
    public get wheelCount(): number { return this._wheels.length; }

    /** Wheel `i` after the last step. The object is kept and rewritten: copy what you keep. */
    public wheel(i: number): VehicleWheelState { return this._wheels[i]; }

    /** The raw state rows (pal/vehicle/vehicleState.ts). */
    public get state(): readonly number[] { return this._state; }

    // ---- for PhysicsSystem ----

    /** Carry `chassis` (a dynamic body). */
    public _attach(chassis: PhysicsBody): void {
        if (this._chassis !== chassis) this._unbuild();
        this._chassis = chassis;
    }

    public _detach(): void {
        this._unbuild();
        this._chassis = null;
    }

    /**
     * Before a step (and before the worker's diff): build it where its chassis now is, and hand the world
     * this frame's input.
     */
    public _sync(): void {
        const body = this._chassis;
        const world = body?.world ?? null;
        if (!body || !world || !(body.mass > 0)) { this._unbuild(); return; }
        if (!this._built || this._world !== world || this._built.chassis !== body.handle || !world.hasBody(this._built.chassis)) {
            this._unbuild();
            try {
                this._built = { handle: world.createVehicle({ ...this.vehicle, chassis: body.handle }), chassis: body.handle };
                this._world = world;
            } catch {
                this._built = null;
                return;
            }
        }
        this._driverInput(this._input);
        world.setVehicleInput(this._built.handle, this._input);
        if ((this._input.forward !== 0 || this._input.right !== 0) && body.isSleeping) body.wakeUp();
    }

    /** After a step (or a worker's step landing): what it reached. */
    public _read(): void {
        if (!this._built || !this._world) return;
        try { this._world.readVehicle(this._built.handle, this._state); } catch { this._built = null; return; }
        const s = this._state;
        for (let i = 0; i < this._wheels.length; i++) {
            const w = this._wheels[i], o = wheelOffset(i), d = this.vehicle.wheels[i];
            w.grounded = s[o + W_CONTACT] !== 0;
            w.suspensionLength = s[o + W_LENGTH];
            const travel = d.suspensionMaxLength - d.suspensionMinLength;
            w.compression = travel > 0 ? Math.min(1, Math.max(0, (d.suspensionMaxLength - w.suspensionLength) / travel)) : 0;
            w.steerAngle = s[o + W_STEER];
            w.rotation = s[o + W_ANGLE];
            w.angularVelocity = s[o + W_OMEGA];
            for (let k = 0; k < 3; k++) { w.contactPoint[k] = s[o + W_POINT + k]; w.contactNormal[k] = s[o + W_NORMAL + k]; }
            w.longitudinalSlip = s[o + W_LONG_SLIP];
            w.lateralSlip = s[o + W_LAT_SLIP];
        }
    }

    /** The pedals and wheel as the world's vehicle takes them (Jolt's: forward, right, brake, hand brake). */
    private _driverInput(out: VehicleInput): void {
        const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? clampRange(v, lo, hi) : 0);
        let forward = clamp(this.throttle, -1, 1), brake = clamp(this.brake, 0, 1);
        if (this.autoReverse && forward !== 0) {
            const speed = this._state[VH_SPEED];
            // Against the way it rolls: brake first, drive the other way once nearly stopped.
            if (Math.sign(forward) !== Math.sign(speed) && Math.abs(speed) > REVERSE_SPEED) {
                brake = Math.max(brake, Math.abs(forward));
                forward = 0;
            }
        }
        out.forward = forward;
        out.right = clamp(this.steer, -1, 1);
        out.brake = brake;
        out.handBrake = clamp(this.handBrake, 0, 1);
    }

    private _unbuild(): void {
        if (this._built && this._world) {
            try { this._world.destroyVehicle(this._built.handle); } catch { /* went with its world */ }
        }
        this._built = null;
        this._world = null;
    }
}

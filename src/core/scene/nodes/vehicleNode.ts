import { quat, vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Node } from "./node";
import { WheelNode } from "./wheelNode";
import { DEG2RAD, finiteOr } from "../../math";
import { Input } from "../../../input/inputApi";
import { Vehicle } from "../../../physics/vehicle";
import {
    WHEEL_DEFAULTS, type VehicleCast, type VehicleDesc, type VehicleDrive, type WheelDesc, type VehicleDifferentialDesc, type VehicleAntiRollBarDesc,
} from "../../../physics/pal/vehicle/vehicleDesc";
import type { PhysicsBody } from "../../../physics/physicsBody";

const CASTS: readonly VehicleCast[] = ['ray', 'sphere', 'cylinder'];
const DRIVES: readonly VehicleDrive[] = ['none', 'engine', 'motors'];
/** A chassis with no box to measure: where addWheel puts wheels (half width, half height, half length). */
const DEFAULT_CHASSIS: [number, number, number] = [0.9, 0.3, 2];
/** Wheels this close along the vehicle (metres) share an axle. */
const AXLE_TOLERANCE = 0.3;

/**
 * A vehicle: its Collider (the one it stands in) is the chassis, and the {@link WheelNode}s under it are its
 * wheels. The wheels are virtual: each physics step they find the ground and spring, grip, drive, brake and
 * steer the chassis, on every physics backend (physics/vehicle.ts, physics/pal/vehicle/). The vehicle faces
 * this node's +Z with its +Y up.
 *
 * Driven by {@link throttle}, {@link steer}, {@link brake} and {@link handBrake}, which a script sets each
 * frame, or by the player's input with {@link playerInput} on (`Move` steers and drives, `Jump` holds the
 * hand brake).
 *
 * Like a Character, it does its own work in `update` after the script's `onUpdate` (a script's method of the
 * same name would shadow a class one), so a script attached to it can drive it.
 */
export class VehicleNode extends Node {
    /**
     * What powers it: an engine through a gearbox to the wheels marked `driven`, an electric motor in each
     * wheel (its `motorTorque` and `motorTopSpeed`), or nothing: it rolls, steers and brakes, pushed or towed.
     */
    public drive: VehicleDrive = 'none';

    // ---- engine and gearbox (serialized) ----

    /** N·m at the torque curve's peak. */
    public maxTorque: number = 500;
    public minRpm: number = 1000;
    public maxRpm: number = 6000;
    /** Forward gears' ratios, first first. */
    public gearRatios: number[] = [2.66, 1.78, 1.3, 1, 0.74];
    /** The reverse gear's ratio (a positive number: it turns the other way). */
    public reverseRatio: number = 2.9;
    /** The differentials' final drive ratio. */
    public finalDrive: number = 3.42;
    public shiftUpRpm: number = 4000;
    public shiftDownRpm: number = 2000;
    /** Seconds a gear change takes. */
    public shiftTime: number = 0.5;
    /** Limited-slip differentials (torque shifts to the slower wheel); off = open. */
    public limitedSlip: boolean = true;
    /** N/m resisting body roll, per axle; 0 = none. */
    public antiRoll: number = 1000;
    /** What the wheels find the ground with, where the backend can (a ray otherwise). */
    public cast: VehicleCast = 'cylinder';
    /** Most it may pitch or roll from upright, DEGREES; 180 = free to roll over. */
    public maxPitchRoll: number = 180;
    /** The throttle against the way it rolls brakes, then reverses once nearly stopped. */
    public autoReverse: boolean = true;
    /** Drive from the player's input: `Move` (x steers, y drives), `Jump` holds the hand brake. */
    public playerInput: boolean = false;

    // ---- the driver (runtime, never serialized) ----

    /** -1 (full reverse) .. 1 (full throttle). */
    public throttle: number = 0;
    /** -1 (full left) .. 1 (full right). */
    public steer: number = 0;
    /** 0 .. 1. */
    public brake: number = 0;
    /** 0 .. 1. */
    public handBrake: number = 0;

    private _vehicle: Vehicle | null = null;
    private _wheels: WheelNode[] = [];
    private _chassis: PhysicsBody | null = null;
    /** The vehicle's up, forward and axle (up × forward), in the chassis's frame. */
    private readonly _vUp = vec3.fromValues(0, 1, 0);
    private readonly _vForward = vec3.fromValues(0, 0, 1);
    private readonly _vAxle = vec3.fromValues(1, 0, 0);
    private readonly _vDown = vec3.fromValues(0, -1, 0);

    constructor(name: string, id: string = uuidv4()) {
        super(name, 'vehicle', id);
    }

    /** The simulated vehicle (speed, RPM, gear, each wheel's state), once the scene runs. */
    public get vehicle(): Vehicle | null { return this._vehicle; }
    /** Forward speed, m/s. */
    public get speed(): number { return this._vehicle?.speed ?? 0; }
    public get rpm(): number { return this._vehicle?.rpm ?? 0; }
    public get gear(): number { return this._vehicle?.gear ?? 0; }

    /** Its wheels: the WheelNodes under it (not under a Collider nested in it). */
    public get wheels(): WheelNode[] {
        const out: WheelNode[] = [];
        const visit = (n: Node) => {
            for (const c of n.children) {
                if (c instanceof WheelNode) out.push(c);
                if (c.nodeType !== 'collider') visit(c);
            }
        };
        visit(this);
        return out;
    }

    /** Build the vehicle again from the wheels and settings as they are now (after editing them in Play). */
    public rebuild(): void {
        if (this._vehicle) this._scene?.physics?.removeVehicle(this._vehicle);
        this._vehicle = null;
    }

    /**
     * Add a wheel under it, with no mesh, at the chassis's next free corner: left (+X) then right, the first
     * axle at the front, the second at the back, each further one behind that. Measured from the Collider's
     * first box (a default car's size without one). The first axle steers.
     */
    public addWheel(): WheelNode {
        const n = this.wheels.length, axle = Math.floor(n / 2), right = n % 2 === 1;
        const [hw, hh, hd] = this._chassisHalfExtents();
        const front = Math.max(0.3, hd - 0.7);
        const z = axle === 0 ? front : axle === 1 ? -front : -front - (axle - 1) * 1.2;
        const wheel = new WheelNode(`wheel ${n + 1}`);
        wheel.setPosition([right ? -(hw - 0.1) : hw - 0.1, -hh - 0.2, z]);
        wheel.steerAngle = axle === 0 ? 30 : 0;
        this.addChild(wheel);
        return wheel;
    }

    /** The Collider's first box, in this node's units (half extents), or a default car's. */
    private _chassisHalfExtents(): [number, number, number] {
        const shapes = (this.collider as unknown as { shapes?: { type: string; width?: number; height?: number; depth?: number }[] } | null)?.shapes;
        const box = shapes?.find(s => s.type === 'box');
        if (!box) return DEFAULT_CHASSIS;
        return [(box.width ?? 1.8) / 2, (box.height ?? 0.6) / 2, (box.depth ?? 4) / 2];
    }

    public update(delta: number, time: number): void {
        super.update(delta, time);
        this._drive();
    }

    public onDespawn(): void {
        if (this._vehicle) this._scene?.physics?.removeVehicle(this._vehicle);
        this._vehicle = null;
        this._chassis = null;
    }

    private _drive(): void {
        const scene = this._scene, physics = scene?.physics;
        if (!scene || !physics || scene.spawnRulesEnabled === false) return;
        const body = this.collider?.ownBody ?? null;
        if (!body || !(body.mass > 0)) return;
        if (!this._vehicle) {
            const desc = this.describe();
            if (!desc) return;
            this._vehicle = new Vehicle(desc);
        }
        const v = this._vehicle;
        if (this._chassis !== body || !physics.vehicles.has(v)) {
            physics.addVehicle(body, v);
            this._chassis = body;
        }
        if (this.playerInput) {
            const move = Input.vector('Move');
            this.steer = move[0];
            this.throttle = move[1];
            this.handBrake = Input.pressed('Jump') ? 1 : 0;
        }
        v.throttle = this.throttle;
        v.steer = this.steer;
        v.brake = this.brake;
        v.handBrake = this.handBrake;
        v.autoReverse = this.autoReverse;
        this._poseWheels(v);
    }

    /** Move each wheel node to where its wheel is: down its suspension, steered, spun. */
    private _poseWheels(v: Vehicle): void {
        const n = Math.min(v.wheelCount, this._wheels.length);
        for (let i = 0; i < n; i++) {
            const w = v.wheel(i), node = this._wheels[i], d = v.vehicle.wheels[i];
            node._pose(this._vDown, this._vUp, this._vAxle, w.suspensionLength - d.suspensionMaxLength, w.steerAngle, w.rotation);
        }
    }

    /**
     * The vehicle as the physics layer takes it, from the wheels where they were placed, measured in the
     * chassis's (the Collider's) frame. Null without a Collider or wheels.
     */
    public describe(): Omit<VehicleDesc, 'chassis'> | null {
        const collider = this.collider;
        if (!collider || collider === this) return null;
        const wheels = this.wheels;
        if (wheels.length === 0) return null;
        this._wheels = wheels;
        collider.updateTransforms(collider.parent ? collider.parent.worldTransform : null);
        const cq = quat.invert(quat.create(), collider.worldQuaternion), cp = collider.worldPosition;
        const inChassis = (q: quat) => quat.multiply(quat.create(), cq, q);
        const toChassis = (p: ArrayLike<number>) => vec3.transformQuat(vec3.create(), [p[0] - cp[0], p[1] - cp[1], p[2] - cp[2]], cq);
        // The vehicle's axes: this node's, seen from the chassis.
        const vq = inChassis(this.worldQuaternion);
        vec3.transformQuat(this._vUp, [0, 1, 0], vq);
        vec3.transformQuat(this._vForward, [0, 0, 1], vq);
        vec3.cross(this._vAxle, this._vUp, this._vForward);
        vec3.negate(this._vDown, this._vUp);
        const right = vec3.cross(vec3.create(), this._vForward, this._vUp);

        const descs: WheelDesc[] = [];
        const along: number[] = [], across: number[] = [];
        for (const w of wheels) {
            const parent = w.parent!;
            w._captureRest(inChassis(parent.worldQuaternion));
            // The authored place, in the world through its parent, then in the chassis.
            const world = vec3.transformMat4(vec3.create(), w._restLocalPosition, parent.worldTransform);
            const centre = toChassis(world);
            const length = Math.max(w.suspensionLength, w.suspensionTravel);
            const attach = vec3.scaleAndAdd(vec3.create(), centre, this._vUp, length);
            const scale = (points: readonly (readonly [number, number])[]) => points.map(p => [p[0], p[1] * w.grip] as [number, number]);
            descs.push({
                position: [attach[0], attach[1], attach[2]],
                suspensionDirection: [this._vDown[0], this._vDown[1], this._vDown[2]],
                radius: w.radius, width: w.width,
                suspensionMinLength: length - w.suspensionTravel, suspensionMaxLength: length,
                suspensionFrequency: w.suspensionFrequency, suspensionDamping: w.suspensionDamping,
                maxSteerAngle: w.steerAngle * DEG2RAD,
                maxBrakeTorque: w.brakeTorque, maxHandBrakeTorque: w.handBrakeTorque,
                longitudinalFriction: scale(WHEEL_DEFAULTS.longitudinalFriction),
                lateralFriction: scale(WHEEL_DEFAULTS.lateralFriction),
                motorTorque: w.motorTorque,
                // m/s at the rim, as a wheel speed.
                motorMaxSpeed: w.motorTopSpeed / w.radius,
            });
            along.push(vec3.dot(centre, this._vForward));
            across.push(vec3.dot(centre, right));
        }

        // Axles: wheels side by side along the vehicle. Left is the side away from its right.
        const axles: number[][] = [];
        const order = wheels.map((_, i) => i).sort((a, b) => along[a] - along[b]);
        for (const i of order) {
            const axle = axles.find(a => Math.abs(along[a[0]] - along[i]) < AXLE_TOLERANCE);
            if (axle) axle.push(i); else axles.push([i]);
        }
        const pairs = axles.map(a => {
            const sorted = [...a].sort((x, y) => across[x] - across[y]);
            return { left: sorted[0], right: sorted.length > 1 ? sorted[sorted.length - 1] : -1, all: sorted };
        });
        const differentials: VehicleDifferentialDesc[] = [];
        if (this.drive === 'engine') for (const p of pairs) {
            const driven = p.all.filter(i => wheels[i].driven);
            if (driven.length === 0) continue;
            const left = driven.includes(p.left) ? p.left : -1, right = p.right >= 0 && driven.includes(p.right) ? p.right : -1;
            differentials.push({ leftWheel: left >= 0 ? left : driven[0], rightWheel: right, ratio: this.finalDrive, limitedSlipRatio: this.limitedSlip ? 1.4 : Infinity });
        }
        for (const d of differentials) d.engineTorqueRatio = 1 / differentials.length;
        const antiRollBars: VehicleAntiRollBarDesc[] = this.antiRoll > 0
            ? pairs.filter(p => p.right >= 0).map(p => ({ leftWheel: p.left, rightWheel: p.right, stiffness: this.antiRoll }))
            : [];

        return {
            drive: this.drive,
            up: [this._vUp[0], this._vUp[1], this._vUp[2]],
            forward: [this._vForward[0], this._vForward[1], this._vForward[2]],
            wheels: descs,
            engine: { maxTorque: this.maxTorque, minRpm: this.minRpm, maxRpm: this.maxRpm },
            transmission: {
                gearRatios: this.gearRatios, reverseGearRatios: [-Math.abs(this.reverseRatio)],
                switchTime: this.shiftTime, shiftUpRpm: this.shiftUpRpm, shiftDownRpm: this.shiftDownRpm,
            },
            differentials,
            differentialLimitedSlipRatio: this.limitedSlip ? 1.4 : Infinity,
            antiRollBars,
            maxPitchRollAngle: Math.min(180, Math.max(1, this.maxPitchRoll)) * DEG2RAD,
            cast: this.cast,
        };
    }

    // ---- serialization ----

    protected _serializePayload(): any {
        return {
            drive: this.drive,
            maxTorque: this.maxTorque, minRpm: this.minRpm, maxRpm: this.maxRpm,
            gearRatios: [...this.gearRatios], reverseRatio: this.reverseRatio, finalDrive: this.finalDrive,
            shiftUpRpm: this.shiftUpRpm, shiftDownRpm: this.shiftDownRpm, shiftTime: this.shiftTime,
            limitedSlip: this.limitedSlip, antiRoll: this.antiRoll, cast: this.cast, maxPitchRoll: this.maxPitchRoll,
            autoReverse: this.autoReverse, playerInput: this.playerInput,
        };
    }

    public static readSettings(node: VehicleNode, json: any): void {
        const positive = (v: unknown, fallback: number) => (typeof v === 'number' && v > 0 ? v : fallback);
        const nonNegative = (v: unknown, fallback: number) => (typeof v === 'number' && v >= 0 ? v : fallback);
        const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
        node.maxTorque = nonNegative(json.maxTorque, node.maxTorque);
        node.minRpm = positive(json.minRpm, node.minRpm);
        node.maxRpm = Math.max(node.minRpm + 1, positive(json.maxRpm, node.maxRpm));
        if (Array.isArray(json.gearRatios)) {
            const gears = json.gearRatios.map((g: unknown) => finiteOr(g, 0)).filter((g: number) => g > 0);
            if (gears.length > 0) node.gearRatios = gears;
        }
        node.reverseRatio = positive(Math.abs(finiteOr(json.reverseRatio, node.reverseRatio)), node.reverseRatio);
        node.finalDrive = positive(json.finalDrive, node.finalDrive);
        node.shiftUpRpm = positive(json.shiftUpRpm, node.shiftUpRpm);
        node.shiftDownRpm = positive(json.shiftDownRpm, node.shiftDownRpm);
        node.shiftTime = nonNegative(json.shiftTime, node.shiftTime);
        node.limitedSlip = bool(json.limitedSlip, node.limitedSlip);
        node.antiRoll = nonNegative(json.antiRoll, node.antiRoll);
        if (CASTS.includes(json.cast)) node.cast = json.cast;
        node.maxPitchRoll = Math.min(180, positive(json.maxPitchRoll, node.maxPitchRoll));
        node.autoReverse = bool(json.autoReverse, node.autoReverse);
        node.playerInput = bool(json.playerInput, node.playerInput);
        if (DRIVES.includes(json.drive)) node.drive = json.drive;
    }

    public static parse(parent: Node, json: any): void {
        const node = new VehicleNode(json.name, json.id);
        VehicleNode.readSettings(node, json);
        Node.finishParse(node, parent, json);
        // Saved before vehicles had a drive: its driven wheels were the engine's.
        if (!DRIVES.includes(json.drive)) node.drive = node.wheels.some(w => w.driven) ? 'engine' : 'none';
    }
}

import { clampTo as clamp, evaluatePolyline } from '../math';
import { rotate } from '../shapeBounds';
import type { Out, V3 } from '../types';
import type { NormalizedVehicle, NormalizedWheel, VehicleInput } from './vehicleDesc';
import { wheelRight } from './vehicleDesc';
import {
    VH_GEAR, VH_RPM, VH_SPEED, VH_WHEELS, W_ANGLE, W_CONTACT, W_LAT_SLIP, W_LENGTH, W_LONG_SLIP, W_NORMAL, W_OMEGA,
    W_POINT, W_STEER, wheelOffset,
} from './vehicleState';

// The shared half of a vehicle on a backend whose own vehicle is Bullet's raycast vehicle (cannon-es's
// RaycastVehicle, Rapier's DynamicRayCastVehicleController). Those find the ground, spring the suspension
// and solve the tyres' grip natively, but take only a steering angle, an engine force and a brake impulse
// per wheel, and keep no engine, gearbox, differential or wheel spin. This supplies those, modelled on
// Jolt's WheeledVehicleController so one description drives alike everywhere:
//
//  - the suspension in Bullet's units, from Jolt's (natural frequency and damping ratio on the mass the
//    wheel carries; see bulletWheelTuning);
//  - the engine (torque curve, idle and limiter), an automatic gearbox (shift points, switch time, clutch
//    release, latency) and the differentials' torque split;
//  - brakes and hand brake as torques, engine braking and wheel drag when coasting;
//  - grip capped at the tyre curves' peak against the load the wheel last carried (Bullet's own cap lets a
//    wheel push twice as hard forward as sideways);
//  - anti-roll bars;
//  - each wheel's spin, slips and what it reports (vehicleState.ts).
//
// A backend calls prepare() before its native update each substep and finish() after it.

/** What the native update found for a wheel, refreshed by the backend after each update. */
export interface RaycastWheelReading {
    contact: boolean;
    /** Attachment to wheel centre, m. */
    length: number;
    /** What the spring pushed with, N. */
    suspensionForce: number;
    /** World space; meaningful in contact. */
    point: [number, number, number];
    normal: [number, number, number];
}

/** The chassis's centre of mass, rotation and velocities, world space, as the backend reads them. */
export interface ChassisMotion {
    com: [number, number, number];
    rotation: [number, number, number, number];
    linear: [number, number, number];
    angular: [number, number, number];
}

/** One wheel in Bullet's terms. */
export interface BulletWheelTuning {
    /** Per unit of chassis mass, as Bullet multiplies back. */
    stiffness: number;
    compression: number;
    relaxation: number;
    /** The ray reaches restLength + radius from the attachment; the spring pushes nothing there. */
    restLength: number;
    /** How far below rest the wheel may be pushed up: rest − travel is the fully compressed length. */
    maxTravel: number;
    /** Grip coefficient: the lateral curve's peak (Bullet caps the tyre at suspension force × this). */
    frictionSlip: number;
    maxSuspensionForce: number;
}

/** The mass a point of the chassis moves with, pushed along `n` (r from the centre of mass, chassis frame). */
export function effectiveMass(mass: number, inertia: ArrayLike<number>, r: ArrayLike<number>, n: ArrayLike<number>): number {
    const cx = r[1] * n[2] - r[2] * n[1], cy = r[2] * n[0] - r[0] * n[2], cz = r[0] * n[1] - r[1] * n[0];
    const inv = 1 / mass + (inertia[0] > 0 ? cx * cx / inertia[0] : 0) + (inertia[1] > 0 ? cy * cy / inertia[1] : 0) + (inertia[2] > 0 ? cz * cz / inertia[2] : 0);
    return 1 / inv;
}

/**
 * A wheel's spring in Bullet's terms. Jolt springs a wheel at its natural frequency f with damping ratio ζ
 * on the mass that point of the chassis moves with (m_eff): k = m_eff·ω², c = 2ζ·m_eff·ω, ω = 2πf. Bullet's
 * force is chassisMass × (stiffness·Δlength − damping·speed), so stiffness = k / m and damping = c / m.
 */
export function bulletWheelTuning(wheel: NormalizedWheel, chassisMass: number, sprungMass: number): BulletWheelTuning {
    const w = 2 * Math.PI * wheel.suspensionFrequency;
    const k = sprungMass * w * w, c = 2 * wheel.suspensionDamping * sprungMass * w;
    return {
        stiffness: k / chassisMass,
        compression: c / chassisMass,
        relaxation: c / chassisMass,
        restLength: wheel.suspensionMaxLength,
        maxTravel: wheel.suspensionMaxLength - wheel.suspensionMinLength,
        frictionSlip: peak(wheel.lateralFriction),
        maxSuspensionForce: Number.isFinite(wheel.maxSuspensionForce) ? wheel.maxSuspensionForce : 1e12,
    };
}

function peak(points: readonly (readonly [number, number])[]): number {
    let m = 0;
    for (const p of points) m = Math.max(m, p[1]);
    return m;
}

const TWO_PI = Math.PI * 2;
const RPM_PER_RAD_S = 60 / TWO_PI;
/** Below this ground speed (m/s) a wheel's slips read 0: they are ratios that blow up at rest. */
const SLIP_SPEED = 0.5;

/** One driven wheel's place in the drivetrain. */
interface Drive {
    wheel: number;
    /** Share of the engine's torque, and the ratio from the gearbox to the wheel. */
    share: number;
    ratio: number;
}

export class RaycastDrive {
    public readonly vehicle: NormalizedVehicle;
    public readonly tuning: BulletWheelTuning[];
    public readonly input: VehicleInput = { forward: 0, right: 0, brake: 0, handBrake: 0 };

    // What the native update is to be given, per wheel, after prepare().
    /** Steering angle about the wheel's up (minus its suspension direction): positive turns LEFT, as both Bullet ports read it. */
    public readonly steering: number[];
    public readonly engineForce: number[];
    public readonly brakeImpulse: number[];
    /** Anti-roll impulse per wheel along the chassis's up, applied at the wheel's attachment (N·s). */
    public readonly antiRoll: number[];

    private readonly _drives: Drive[] = [];
    private readonly _omega: number[];
    private readonly _angle: number[];
    private readonly _steer: number[];
    private readonly _longSlip: number[];
    private readonly _latSlip: number[];
    private readonly _driveTorque: number[];
    private readonly _brakeTorque: number[];
    /** Driven wheels spinning faster than the ground: more torque than the tyre can put down. */
    private readonly _spinning: boolean[];
    /** Jolt's gate on an upshift: no driven wheel spinning, and the engine not slowing. */
    private _canShiftUp = true;
    private _lastRpm = 0;
    private readonly _right: V3;
    private _speed = 0;
    // Gearbox.
    private _gear = 0;
    private _target = 0;
    private _switchLeft = 0;
    private _releaseLeft = 0;
    private _latencyLeft = 0;
    private _clutch = 1;
    // Engine.
    private _rpm: number;
    private _freeRpm: number;
    private readonly _mass: number;
    private readonly _inertia: [number, number, number];
    private readonly _v = [0, 0, 0];
    private readonly _f = [0, 0, 0];
    private readonly _r = [0, 0, 0];

    /**
     * @param chassisMass the chassis's mass, kg
     * @param inertia its principal inertia, chassis axes
     * @param centerOfMass from its node origin, chassis frame
     */
    constructor(vehicle: NormalizedVehicle, chassisMass: number, inertia: ArrayLike<number>, centerOfMass: ArrayLike<number>) {
        this.vehicle = vehicle;
        this._mass = chassisMass;
        this._inertia = [inertia[0], inertia[1], inertia[2]];
        const n = vehicle.wheels.length, up = vehicle.up;
        this.tuning = vehicle.wheels.map(w => {
            const r = [w.position[0] - centerOfMass[0], w.position[1] - centerOfMass[1], w.position[2] - centerOfMass[2]];
            return bulletWheelTuning(w, chassisMass, effectiveMass(chassisMass, inertia, r, up));
        });
        const zeros = () => new Array<number>(n).fill(0);
        this.steering = zeros(); this.engineForce = zeros(); this.brakeImpulse = zeros(); this.antiRoll = zeros();
        this._omega = zeros(); this._angle = zeros(); this._steer = zeros();
        this._longSlip = zeros(); this._latSlip = zeros(); this._driveTorque = zeros(); this._brakeTorque = zeros();
        this._spinning = new Array<boolean>(n).fill(false);
        this._right = wheelRight(vehicle);
        this._rpm = this._freeRpm = vehicle.engine.minRpm;
        const total = vehicle.differentials.reduce((s, d) => s + d.engineTorqueRatio, 0);
        for (const d of vehicle.differentials) {
            const share = total > 0 ? d.engineTorqueRatio / total : 0;
            const both = d.leftWheel >= 0 && d.rightWheel >= 0;
            if (d.leftWheel >= 0) this._drives.push({ wheel: d.leftWheel, share: share * (both ? d.leftRightSplit : 1), ratio: d.ratio });
            if (d.rightWheel >= 0) this._drives.push({ wheel: d.rightWheel, share: share * (both ? 1 - d.leftRightSplit : 1), ratio: d.ratio });
        }
    }

    public get gear(): number { return this._gear; }
    public get rpm(): number { return this._rpm; }

    /** Work out this substep's steering, engine forces, brakes and anti-roll from the input and the last readings. */
    public prepare(dt: number, readings: readonly RaycastWheelReading[]): void {
        const v = this.vehicle, input = this.input;
        const forward = clamp(input.forward || 0, -1, 1), right = clamp(input.right || 0, -1, 1);
        const brake = clamp(input.brake || 0, 0, 1), handBrake = clamp(input.handBrake || 0, 0, 1);
        const wheels = v.wheels;

        for (let i = 0; i < wheels.length; i++) {
            // Jolt's convention: right input turns the wheel by −right × lock about its up.
            this._steer[i] = -right * wheels[i].maxSteerAngle;
            this.steering[i] = this._steer[i];
        }

        this._shift(dt, forward);
        const gearRatio = this._ratio(this._gear);

        // The engine runs at the speed the driven wheels turn it through the gearbox, the clutch slipping
        // below idle; with the clutch out it revs toward what the throttle asks.
        let clutchSpeed = 0;
        for (const d of this._drives) clutchSpeed += d.share * this._omega[d.wheel] * d.ratio;
        // Signed: positive while the wheels turn the way this gear drives them. Turning against it (reverse
        // engaged while still rolling forward) the clutch slips and the engine still pushes.
        const coupledRpm = clutchSpeed * gearRatio * RPM_PER_RAD_S;
        const e = v.engine;
        const wanted = e.minRpm + Math.abs(forward) * (e.maxRpm - e.minRpm);
        this._freeRpm += (wanted - this._freeRpm) * Math.min(1, dt / Math.max(1e-3, e.inertia * 0.6));
        const coupled = clamp(coupledRpm, e.minRpm, e.maxRpm);
        this._rpm = gearRatio === 0 ? this._freeRpm : this._freeRpm + (coupled - this._freeRpm) * this._clutch;

        // Torque at the flywheel: the curve's, nothing past the limiter.
        const torque = coupledRpm >= e.maxRpm && gearRatio !== 0
            ? 0
            : Math.abs(forward) * e.maxTorque * evaluatePolyline(e.torqueCurve, this._rpm / e.maxRpm);
        // Coasting in gear, the engine's own drag brakes the driven wheels.
        const engineDrag = forward === 0 && gearRatio !== 0 ? e.angularDamping * e.inertia * (this._rpm / RPM_PER_RAD_S) * this._clutch : 0;

        this._driveTorque.fill(0);
        for (let i = 0; i < wheels.length; i++) {
            const w = wheels[i];
            this._brakeTorque[i] = Math.max(brake * w.maxBrakeTorque, handBrake * w.maxHandBrakeTorque)
                + w.inertia * w.angularDamping * Math.abs(this._omega[i]);
        }
        for (const d of this._drives) {
            const r = Math.abs(gearRatio) * d.ratio;
            this._driveTorque[d.wheel] += torque * this._clutch * Math.sign(gearRatio) * r * d.share;
            this._brakeTorque[d.wheel] += engineDrag * r * d.share;
        }

        for (let i = 0; i < wheels.length; i++) {
            const w = wheels[i], reading = readings[i];
            // Grip is the curves' peak against the load: the most a tyre can push before it slides.
            const load = reading.contact ? reading.suspensionForce : 0;
            const grip = peak(w.longitudinalFriction) * load;
            const lockGrip = w.longitudinalFriction[w.longitudinalFriction.length - 1][1] * load;
            // Past the peak the tyre spins and pushes with its sliding grip, as Jolt's does on its curve's tail.
            const want = this._driveTorque[i] / w.radius;
            this._spinning[i] = reading.contact && want !== 0 && (this._spinning[i] ? Math.abs(want) > lockGrip : Math.abs(want) > grip);
            this.engineForce[i] = this._spinning[i] ? Math.sign(want) * lockGrip : clamp(want, -grip, grip);
            this.brakeImpulse[i] = Math.min(this._brakeTorque[i] / w.radius, lockGrip) * dt;
        }

        this.antiRoll.fill(0);
        for (const bar of v.antiRollBars) {
            const l = readings[bar.leftWheel], r = readings[bar.rightWheel];
            if (!l.contact || !r.contact) continue;
            // The more compressed side is lifted, the other pulled down (Jolt's: (r − l) · k · dt).
            const impulse = (r.length - l.length) * bar.stiffness * dt;
            this.antiRoll[bar.leftWheel] += impulse;
            this.antiRoll[bar.rightWheel] -= impulse;
        }
    }

    /**
     * Hold braked wheels where the native solve leaves them creeping: Rapier shares a wheel's rolling
     * friction among every wheel on the ground (each stops 1/n of its slide), so a car held by two wheels of
     * four creeps down a slope. Given what of each wheel's forward impulse the native solve `spent`, this
     * stops what is left of each braked wheel's forward slide at its contact, within the rest of its brake,
     * through `apply` (an impulse and the world point it acts at). After the native update, before finish().
     */
    public holdBrakes(readings: readonly RaycastWheelReading[], chassis: ChassisMotion, spent: ArrayLike<number>,
                      apply: (ix: number, iy: number, iz: number, point: ArrayLike<number>) => void): void {
        const q = chassis.rotation, inv = [-q[0], -q[1], -q[2], q[3]], f = this._f, r = this._r, vel = this._v;
        const lr = [0, 0, 0], lf = [0, 0, 0];
        for (let i = 0; i < readings.length; i++) {
            const reading = readings[i], budget = this.brakeImpulse[i] - Math.abs(spent[i]);
            if (!reading.contact || !(budget > 0)) continue;
            const p = reading.point, c = chassis.com, a = chassis.angular;
            const px = p[0] - c[0], py = p[1] - c[1], pz = p[2] - c[2];
            vel[0] = chassis.linear[0] + a[1] * pz - a[2] * py;
            vel[1] = chassis.linear[1] + a[2] * px - a[0] * pz;
            vel[2] = chassis.linear[2] + a[0] * py - a[1] * px;
            this._wheelAxes(i, q, f, r);
            const long = vel[0] * f[0] + vel[1] * f[1] + vel[2] * f[2];
            rotate(inv, px, py, pz, lr);
            rotate(inv, f[0], f[1], f[2], lf);
            const j = clamp(-long * effectiveMass(this._mass, this._inertia, lr, lf), -budget, budget);
            if (j !== 0) apply(f[0] * j, f[1] * j, f[2] * j, p);
        }
    }

    /** After the native update: spin the wheels, measure slips and speed. */
    public finish(dt: number, readings: readonly RaycastWheelReading[], chassis: ChassisMotion): void {
        const v = this.vehicle, wheels = v.wheels;
        const q = chassis.rotation, f = this._f, r = this._r, vel = this._v;
        rotate(q, v.forward[0], v.forward[1], v.forward[2], f);
        this._speed = chassis.linear[0] * f[0] + chassis.linear[1] * f[1] + chassis.linear[2] * f[2];
        const gearRatio = this._ratio(this._gear);
        for (let i = 0; i < wheels.length; i++) {
            const w = wheels[i], reading = readings[i];
            if (reading.contact) {
                // The chassis's velocity where the tyre touches, along the wheel's own forward and axle.
                const p = reading.point, c = chassis.com, a = chassis.angular;
                const px = p[0] - c[0], py = p[1] - c[1], pz = p[2] - c[2];
                vel[0] = chassis.linear[0] + a[1] * pz - a[2] * py;
                vel[1] = chassis.linear[1] + a[2] * px - a[0] * pz;
                vel[2] = chassis.linear[2] + a[0] * py - a[1] * px;
                this._wheelAxes(i, q, f, r);
                const long = vel[0] * f[0] + vel[1] * f[1] + vel[2] * f[2];
                const lat = vel[0] * r[0] + vel[1] * r[1] + vel[2] * r[2];
                const load = reading.suspensionForce;
                const locked = Math.abs(long) > SLIP_SPEED && this._brakeTorque[i] / w.radius > peak(w.longitudinalFriction) * load
                    && Math.abs(this._driveTorque[i]) < this._brakeTorque[i];
                if (this._spinning[i]) {
                    // Spinning: the engine's torque less what the tyre pushes back, on the wheel and the
                    // engine turning with it, up to the limiter; caught again once it rolls at ground speed.
                    const ratio = Math.abs(gearRatio) * this._driveRatio(i);
                    const inertia = w.inertia + v.engine.inertia * ratio * ratio * this._driveShare(i) * this._clutch;
                    const sliding = w.longitudinalFriction[w.longitudinalFriction.length - 1][1] * load;
                    const t = this._driveTorque[i], sign = Math.sign(t);
                    let omega = Math.max(this._omega[i] * sign, long / w.radius * sign);
                    omega += (Math.abs(t) - sliding * w.radius) / inertia * dt;
                    const limit = ratio > 0 ? v.engine.maxRpm / RPM_PER_RAD_S / ratio : Infinity;
                    omega = Math.min(omega, limit);
                    if (omega * w.radius <= long * sign) { this._spinning[i] = false; omega = long / w.radius * sign; }
                    this._omega[i] = omega * sign;
                    this._longSlip[i] = Math.abs(this._omega[i] * w.radius - long) / Math.max(Math.abs(long), 1e-3);
                } else {
                    this._omega[i] = locked ? 0 : long / w.radius;
                    this._longSlip[i] = locked ? 1 : 0;
                }
                const speed = Math.hypot(long, lat);
                this._latSlip[i] = speed > SLIP_SPEED ? Math.atan2(Math.abs(lat), Math.abs(long)) : 0;
            } else {
                // In the air the wheel spins up under the engine and down under its brake and drag.
                let omega = this._omega[i] + this._driveTorque[i] / w.inertia * dt;
                const stop = this._brakeTorque[i] / w.inertia * dt;
                omega = Math.abs(omega) <= stop ? 0 : omega - Math.sign(omega) * stop;
                const limit = gearRatio !== 0 && this._isDriven(i) ? v.engine.maxRpm / RPM_PER_RAD_S / (Math.abs(gearRatio) * this._driveRatio(i)) : Infinity;
                this._omega[i] = clamp(omega, -limit, limit);
                this._longSlip[i] = 0;
                this._latSlip[i] = 0;
            }
            let angle = this._angle[i] + this._omega[i] * dt;
            angle -= Math.floor(angle / TWO_PI) * TWO_PI;
            this._angle[i] = angle;
        }
        let spinning = false;
        for (const d of this._drives) if (this._driveTorque[d.wheel] !== 0 && (!readings[d.wheel].contact || this._longSlip[d.wheel] > 0.1)) spinning = true;
        this._canShiftUp = !spinning && this._rpm >= this._lastRpm;
        this._lastRpm = this._rpm;
    }

    /** Write the vehicle's state rows (vehicleState.ts). */
    public write(readings: readonly RaycastWheelReading[], out: Out): void {
        out[VH_SPEED] = this._speed;
        out[VH_RPM] = this._rpm;
        out[VH_GEAR] = this._gear;
        out[VH_WHEELS] = readings.length;
        for (let i = 0; i < readings.length; i++) {
            const o = wheelOffset(i), reading = readings[i], c = reading.contact;
            out[o + W_CONTACT] = c ? 1 : 0;
            out[o + W_LENGTH] = reading.length;
            out[o + W_STEER] = this._steer[i];
            out[o + W_ANGLE] = this._angle[i];
            out[o + W_OMEGA] = this._omega[i];
            for (let k = 0; k < 3; k++) {
                out[o + W_POINT + k] = c ? reading.point[k] : 0;
                out[o + W_NORMAL + k] = c ? reading.normal[k] : 0;
            }
            out[o + W_LONG_SLIP] = this._longSlip[i];
            out[o + W_LAT_SLIP] = this._latSlip[i];
        }
    }

    /** Wheel i's forward and axle, world space, turned by its steering. */
    private _wheelAxes(i: number, q: ArrayLike<number>, f: Out, r: Out): void {
        const v = this.vehicle, s = this._steer[i];
        const cs = Math.cos(s), sn = Math.sin(s), fw = v.forward, rt = this._right, up = v.up;
        // Steering turns forward toward −right (left) for a positive angle: f' = f cos s − r sin s.
        const fx = fw[0] * cs - rt[0] * sn, fy = fw[1] * cs - rt[1] * sn, fz = fw[2] * cs - rt[2] * sn;
        rotate(q, fx, fy, fz, f);
        // The axle is forward × up.
        rotate(q, fy * up[2] - fz * up[1], fz * up[0] - fx * up[2], fx * up[1] - fy * up[0], r);
    }

    private _ratio(gear: number): number {
        const t = this.vehicle.transmission;
        if (gear > 0) return t.gearRatios[gear - 1];
        if (gear < 0) return t.reverseGearRatios[-gear - 1];
        return 0;
    }

    private _isDriven(i: number): boolean { return this._drives.some(d => d.wheel === i); }
    private _driveRatio(i: number): number { return this._drives.find(d => d.wheel === i)?.ratio ?? 1; }
    private _driveShare(i: number): number { return this._drives.find(d => d.wheel === i)?.share ?? 0; }

    /**
     * Jolt's automatic gearbox: into first or reverse with the throttle's sign, up past the shift-up RPM and
     * down below the shift-down one. A change cuts the clutch for its switch time, lets it bite over the
     * release time, and holds the next change off for the latency.
     */
    private _shift(dt: number, forward: number): void {
        const t = this.vehicle.transmission;
        if (this._switchLeft > 0) {
            this._switchLeft -= dt;
            this._clutch = 0;
            if (this._switchLeft <= 0) {
                this._gear = this._target;
                this._releaseLeft = t.clutchReleaseTime;
            }
        } else if (this._releaseLeft > 0) {
            this._releaseLeft = Math.max(0, this._releaseLeft - dt);
            this._clutch = t.clutchReleaseTime > 0 ? 1 - this._releaseLeft / t.clutchReleaseTime : 1;
        } else {
            this._clutch = 1;
        }
        this._latencyLeft -= dt;
        if (this._switchLeft > 0) return;
        if (forward > 0 && this._target <= 0) this._switchTo(1);
        else if (forward < 0 && this._target >= 0) this._switchTo(-1);
        else if (this._target > 0 && this._latencyLeft <= 0 && this._releaseLeft <= 0) {
            if (this._rpm > t.shiftUpRpm && this._target < t.gearRatios.length && this._canShiftUp) this._switchTo(this._target + 1);
            else if (this._rpm < t.shiftDownRpm && this._target > 1) this._switchTo(this._target - 1);
        }
    }

    private _switchTo(gear: number): void {
        const t = this.vehicle.transmission;
        this._target = gear;
        this._latencyLeft = t.switchTime + t.clutchReleaseTime + t.switchLatency;
        // Out of neutral, or with no switch time, the gear goes straight in.
        if (this._gear === 0 || t.switchTime <= 0) {
            this._gear = gear;
            this._releaseLeft = t.clutchReleaseTime;
            return;
        }
        this._switchLeft = t.switchTime;
        this._clutch = 0;
    }
}

import { clampTo } from '../math';
import { rotate } from '../shapeBounds';
import type { Out } from '../types';
import type { NormalizedVehicle } from './vehicleDesc';

/** What the lean controller reads of a wheel after a step. */
export interface LeanWheel {
    contact: boolean;
    /** What the suspension pushed with, N (0 in the air). */
    suspensionForce: number;
}

/**
 * A motorcycle's lean controller, on every backend: it holds a vehicle on two wheels in line upright and leans
 * it into turns, by Jolt's MotorcycleController's settings (max lean, spring, damping, integral, smoothing):
 *  - the target lean is the angle that balances the turn the steering asks for, tan φ = v² · tan δ / (L · g)
 *    (speed, steering angle, wheelbase, gravity), smoothed and held to the most lean allowed. Jolt aims at where
 *    the tyres' forces point instead, and a measured yaw rate would do as badly: on a Bullet port a leaning
 *    chassis tilts its suspension, which turns it harder, which asks for more lean, until it falls in. The
 *    steering is what the rider holds, so the lean cannot feed itself;
 *  - a spring and a damper (and optionally an integral) turn the chassis's up toward it about its forward axis,
 *    as an angular impulse each substep, while a wheel is on the ground; in the air the integral decays.
 *    Integrated implicitly on the chassis's roll inertia, as Jolt's constraint solve is: Jolt's stiff, heavily
 *    damped defaults overshoot and ring when applied as an explicit force at a 1/60 s substep.
 *
 * It runs on Jolt too, instead of Jolt's own (which launched our bodies off the ground on their first contact,
 * with Jolt's default settings as much as with ours); Jolt still narrows the steering at speed itself.
 */
export class LeanController {
    private _target = 0;
    private _integral = 0;
    private readonly _fw = [0, 0, 0];
    private readonly _up = [0, 0, 0];
    private readonly _goal = [0, 0, 0];

    private readonly _rollInertia: number;
    private readonly _wheelBase: number;

    /** @param inertia the chassis's principal inertia, in its own axes (kg·m²) */
    constructor(private readonly _vehicle: NormalizedVehicle, inertia: ArrayLike<number>) {
        const f = _vehicle.forward;
        this._rollInertia = Math.max(1e-6, f[0] * f[0] * inertia[0] + f[1] * f[1] * inertia[1] + f[2] * f[2] * inertia[2]);
        this._wheelBase = wheelBaseOf(_vehicle);
    }

    /**
     * This substep's angular impulse (N·m·s, world space) into `out`, or false for none.
     * @param rotation the chassis's rotation, @param angular its angular velocity, both world space
     */
    /**
     * @param steer the steering angle (radians, positive left), @param linear and @param angular the chassis's
     * velocities, world space
     */
    public impulse(dt: number, wheels: readonly LeanWheel[], steer: number, rotation: ArrayLike<number>, linear: ArrayLike<number>,
                   angular: ArrayLike<number>, out: Out): boolean {
        const lean = this._vehicle.lean;
        if (!lean || !(dt > 0)) return false;
        const fw = this._fw, up = this._up, v = this._vehicle;
        // Held while any wheel is on the ground (Jolt asks for all of them; a bike pulling a wheelie would then
        // fall the moment its front wheel lifts).
        let loaded = false;
        for (const w of wheels) if (w.contact && w.suspensionForce > 0) loaded = true;
        rotate(rotation, v.forward[0], v.forward[1], v.forward[2], fw);
        rotate(rotation, v.up[0], v.up[1], v.up[2], up);
        const across = (a: ArrayLike<number>): number[] | null => {
            const d = a[0] * fw[0] + a[1] * fw[1] + a[2] * fw[2];
            const x = a[0] - fw[0] * d, y = a[1] - fw[1] * d, z = a[2] - fw[2] * d, l = Math.hypot(x, y, z);
            return l > 1e-9 ? [x / l, y / l, z / l] : null;
        };
        const worldUp = across([0, 1, 0]), chassisUp = across(up);
        if (!worldUp || !chassisUp) return false;
        const signedAngle = (a: ArrayLike<number>, b: ArrayLike<number>) => {
            const cx = a[1] * b[2] - a[2] * b[1], cy = a[2] * b[0] - a[0] * b[2], cz = a[0] * b[1] - a[1] * b[0];
            return Math.atan2(cx * fw[0] + cy * fw[1] + cz * fw[2], a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
        };
        // The lean that balances the turn steered: a positive angle about forward leans right, into a right
        // (negative steer) turn.
        const speed = linear[0] * fw[0] + linear[1] * fw[1] + linear[2] * fw[2];
        const balance = this._wheelBase > 1e-3 ? Math.atan2(-speed * speed * Math.tan(steer), this._wheelBase * 9.81) : 0;
        this._target = lean.smoothing * this._target + (1 - lean.smoothing) * balance;
        rotateAbout(worldUp, fw, clampTo(this._target, -lean.maxAngle, lean.maxAngle), this._goal);
        const dAngle = signedAngle(chassisUp, this._goal);
        if (!loaded) {
            this._integral *= Math.max(0, 1 - lean.integrationDecay * dt);
            return false;
        }
        this._integral += dAngle * dt;
        // Implicit: the roll rate this substep ends with, the spring measured where the chassis will be after it.
        const roll = angular[0] * fw[0] + angular[1] * fw[1] + angular[2] * fw[2], I = this._rollInertia;
        const next = (roll + dt * (lean.spring * dAngle + lean.integration * this._integral) / I)
            / (1 + dt * lean.damping / I + dt * dt * lean.spring / I);
        const j = I * (next - roll);
        out[0] = fw[0] * j; out[1] = fw[1] * j; out[2] = fw[2] * j;
        return j !== 0;
    }
}

/**
 * Jolt's pitch/roll limit (VehicleConstraintSettings.mMaxPitchRollAngle) for the backends that have none: past
 * `vehicle.maxPitchRollAngle` from the world's up, the chassis's rotation further away is stopped and the excess
 * is pushed back over a few substeps. The angular impulse into `out`; false when within the limit.
 * @param inertia the chassis's principal inertia, its own axes
 */
export function pitchRollLimitImpulse(vehicle: NormalizedVehicle, inertia: ArrayLike<number>, dt: number,
                                      rotation: ArrayLike<number>, angular: ArrayLike<number>, out: Out): boolean {
    const max = vehicle.maxPitchRollAngle;
    if (!(max < Math.PI) || !(dt > 0)) return false;
    const up = [0, 0, 0], u = vehicle.up;
    rotate(rotation, u[0], u[1], u[2], up);
    const tilt = Math.acos(clampTo(up[1], -1, 1));
    if (tilt <= max) return false;
    // The axis that turns the chassis back toward the world's up: up × worldUp.
    let ax = -up[2], ay = 0, az = up[0];
    const l = Math.hypot(ax, ay, az);
    if (l < 1e-9) return false;
    ax /= l; az /= l;
    // Its inertia about that axis, in the chassis's own axes.
    const inv = [-rotation[0], -rotation[1], -rotation[2], rotation[3]], local = [0, 0, 0];
    rotate(inv, ax, ay, az, local);
    const I = local[0] * local[0] * inertia[0] + local[1] * local[1] * inertia[1] + local[2] * local[2] * inertia[2];
    const back = angular[0] * ax + angular[1] * ay + angular[2] * az;
    // Stop turning further over, and take back a fifth of the excess each substep.
    const wanted = Math.max(back, 0.2 * (tilt - max) / dt);
    const j = I * (wanted - back);
    if (!(j > 0)) return false;
    out[0] = ax * j; out[1] = ay * j; out[2] = az * j;
    return true;
}

/** The steering a lean can hold at `speed` (m/s): asin(wheelBase · tan(maxLean) · g / v²), Jolt's limit. */
export function leanSteerLimit(vehicle: NormalizedVehicle, wheelBase: number, speed: number): number {
    const lean = vehicle.lean, v2 = speed * speed;
    if (!lean || v2 < 1e-6) return Math.PI;
    const factor = wheelBase * Math.tan(lean.maxAngle) * 9.81 / v2;
    return factor >= 1 ? Math.PI : Math.asin(factor);
}

/** Front-most wheel to rear-most along the vehicle, at full extension. */
export function wheelBaseOf(vehicle: NormalizedVehicle): number {
    const f = vehicle.forward;
    const along = vehicle.wheels.map(w => {
        const p = w.position, d = w.suspensionDirection, l = w.suspensionMaxLength;
        return (p[0] + d[0] * l) * f[0] + (p[1] + d[1] * l) * f[1] + (p[2] + d[2] * l) * f[2];
    });
    return Math.max(...along) - Math.min(...along);
}

/** `v` turned by `angle` radians about the unit `axis` (Rodrigues), into `out`. */
function rotateAbout(v: ArrayLike<number>, axis: ArrayLike<number>, angle: number, out: number[]): void {
    const c = Math.cos(angle), s = Math.sin(angle), d = (v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2]) * (1 - c);
    const cx = axis[1] * v[2] - axis[2] * v[1], cy = axis[2] * v[0] - axis[0] * v[2], cz = axis[0] * v[1] - axis[1] * v[0];
    out[0] = v[0] * c + cx * s + axis[0] * d;
    out[1] = v[1] * c + cy * s + axis[1] * d;
    out[2] = v[2] * c + cz * s + axis[2] * d;
}

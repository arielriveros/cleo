import type { Out } from '../types';

// What a vehicle reports after a step, as flat numbers: one header, then one row per wheel. The same rows
// every backend writes (PhysicsWorld.readVehicle) and the physics worker sends back in its snapshot, so
// what draws the wheels and what a script reads never learn where the vehicle was simulated.

/** [forward speed m/s, engine RPM, gear (0 neutral, < 0 reverse), wheel count] */
export const VEHICLE_HEADER = 4;
export const VH_SPEED = 0;
export const VH_RPM = 1;
export const VH_GEAR = 2;
export const VH_WHEELS = 3;

/**
 * Per wheel:
 * - contact: 1 on the ground, 0 in the air;
 * - suspension length: attachment to wheel centre, m;
 * - steer angle: radians about the wheel's up (minus its suspension direction), positive turning LEFT, the
 *   engine's counter-clockwise convention (a right turn is negative);
 * - rotation angle and angular velocity: about the axle, positive rolling FORWARD;
 * - contact point [3] and normal [3], world space (zero in the air);
 * - longitudinal slip (ratio) and lateral slip (radians).
 */
export const WHEEL_ROW = 13;
export const W_CONTACT = 0;
export const W_LENGTH = 1;
export const W_STEER = 2;
export const W_ANGLE = 3;
export const W_OMEGA = 4;
export const W_POINT = 5;
export const W_NORMAL = 8;
export const W_LONG_SLIP = 11;
export const W_LAT_SLIP = 12;

/** Numbers a vehicle of `wheels` wheels reports. */
export function vehicleStateSize(wheels: number): number { return VEHICLE_HEADER + WHEEL_ROW * wheels; }

/** Where wheel `i`'s row starts. */
export function wheelOffset(i: number): number { return VEHICLE_HEADER + WHEEL_ROW * i; }

/** Fill a state with a vehicle that has not stepped: at rest, wheels hanging at full length. */
export function restingState(lengths: readonly number[], out: Out): void {
    out[VH_SPEED] = 0; out[VH_RPM] = 0; out[VH_GEAR] = 0; out[VH_WHEELS] = lengths.length;
    for (let i = 0; i < lengths.length; i++) {
        const o = wheelOffset(i);
        for (let k = 0; k < WHEEL_ROW; k++) out[o + k] = 0;
        out[o + W_LENGTH] = lengths[i];
    }
}

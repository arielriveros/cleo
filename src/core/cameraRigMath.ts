import { vec3 } from "gl-matrix";
import { clamp, noise1 } from "./math";
export { aimFromDirection } from "./math";

/**
 * The camera rig's decision math as pure functions over plain vectors, testable without a GL context.
 * Angles are DEGREES, matching the rest of the engine (see `math.ts`).
 */

/**
 * The spring arm as a rig-local displacement: back along local -Z by `armLength`, plus the socket
 * offset. Collision shortens this whole vector, not just `armLength` (see `collisionRatio`).
 */
export function boomOffset(out: vec3, socketOffset: vec3, armLength: number): vec3 {
    out[0] = socketOffset[0];
    out[1] = socketOffset[1];
    out[2] = socketOffset[2] - armLength;
    return out;
}

/**
 * Fraction of the boom the camera may occupy given the nearest obstruction. `hit` is the pivot-to-
 * obstruction distance, or null when nothing was hit; `radius` is subtracted as a near-plane skin.
 * The result is floored at `minRatio`, never 0, so a pivot buried in geometry cannot collapse the boom.
 */
export function collisionRatio(hit: number | null, dist: number, radius: number, minRatio: number): number {
    if (hit === null || dist <= 1e-6) return 1;
    return clamp((hit - radius) / dist, clamp(minRatio, 0, 1), 1);
}

export interface ShakeOffsets {
    /** Camera-local position offset, metres. */
    position: vec3;
    /** Euler offset in degrees, [pitch, yaw, roll]. */
    rotation: vec3;
}

/**
 * Six uncorrelated noise channels scaled by `strength`, for camera shake. Channels are separated by a
 * large prime seed stride so the axes do not move in lockstep. `strength` must arrive pre-shaped by
 * the caller; it is a straight multiply, so at strength 0 every channel is exactly 0.
 */
export function shakeOffsets(
    out: ShakeOffsets,
    time: number,
    seed: number,
    frequency: number,
    strength: number,
    positionAmplitude: vec3,
    rotationAmplitude: vec3
): ShakeOffsets {
    if (strength <= 0) {
        vec3.zero(out.position);
        vec3.zero(out.rotation);
        return out;
    }

    const t = time * frequency;
    for (let i = 0; i < 3; i++) {
        out.position[i] = noise1(t, seed + i * 7919) * positionAmplitude[i] * strength;
        out.rotation[i] = noise1(t, seed + (i + 3) * 7919) * rotationAmplitude[i] * strength;
    }
    return out;
}

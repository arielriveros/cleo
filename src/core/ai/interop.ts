/**
 * The gl-matrix <-> Yuka boundary, and the only module allowed to cross it.
 *
 * A LEAF: no Node, no scene, no physics. Everything here is a copy between two representations of the
 * same number, so it is exhaustively testable and has no reason to ever grow a dependency.
 *
 * ## Why this is cheap
 *
 * Yuka and Cleo agree on more than they have any right to. Both are **right-handed, +Y up, +Z
 * forward** -- Cleo's forward at yaw θ is `(sin θ, 0, cos θ)`, and a Yuka entity yawed by θ reports
 * exactly that world direction. Both store a quaternion as `[x, y, z, w]` and a 4x4 column-major.
 * So the bridge is a component copy, never an axis remap, and never a sign flip.
 *
 * ## The one thing that does NOT line up
 *
 * Angles. Three conventions are in play:
 *
 *   - Yuka: **radians**, and its only Euler path is YXZ.
 *   - Cleo `Node.rotation`: **degrees**, composing Rz * Ry * Rx.
 *   - gl-matrix `quat.fromEuler`: **degrees**, ZYX.
 *
 * Never bridge through an Euler triple -- the two that look compatible are not. Bridge through a
 * quaternion, or (far more often, because navigation is planar anyway) through a single yaw scalar,
 * which is what {@link yawToYukaRotation} exists for.
 *
 * ## Scratch
 *
 * `scratchVec3` hands out from a small fixed ring rather than allocating. Yuka's own methods are
 * non-reentrant for the same reason, so the rule is identical: a scratch vector is valid until the
 * next call that takes one, and nothing may hold one across an `await`.
 */

import { vec3 } from "gl-matrix";
import { DEG2RAD, RAD2DEG } from "../math";
import { Quaternion, Vector3 } from "./yuka";

/** A read-only 3-component vector, in whatever shape the caller already has one. */
export type Vec3Like = Readonly<[number, number, number]> | Readonly<Float32Array> | vec3;

/** Copy a gl-matrix (or plain array) vector into a Yuka one. */
export function toYuka(out: Vector3, v: Vec3Like): Vector3 {
    out.x = v[0];
    out.y = v[1];
    out.z = v[2];
    return out;
}

/** Copy a Yuka vector into a gl-matrix one. */
export function fromYuka(out: vec3, v: Vector3): vec3 {
    return vec3.set(out, v.x, v.y, v.z);
}

/** A fresh Yuka vector from anything vector-shaped. Allocates -- prefer {@link toYuka} on a hot path. */
export function yukaVec(v: Vec3Like): Vector3 {
    return new Vector3(v[0], v[1], v[2]);
}

/**
 * The rotation a Yuka entity needs to face Cleo's world yaw.
 *
 * Degrees in, because that is what every angle on a Node is. This is the ONLY bridge perception needs:
 * a vision cone cares where the body points and nothing else, and going through the full quaternion
 * would drag in the Euler-order mismatch for no gain.
 */
export function yawToYukaRotation(out: Quaternion, yawDegrees: number): Quaternion {
    // YXZ with only Y set reduces to a rotation about +Y, which is what a planar heading is. Verified
    // against Cleo's convention: yaw +90 degrees gives a world direction of (1, 0, 0).
    const half = yawDegrees * DEG2RAD * 0.5;
    out.x = 0;
    out.y = Math.sin(half);
    out.z = 0;
    out.w = Math.cos(half);
    return out;
}

/**
 * The world yaw of a planar direction, in DEGREES -- the inverse of Cleo's
 * `forward = (sin θ, 0, cos θ)`, and therefore `atan2(x, z)`, not the `atan2(z, x)` reflex.
 *
 * Agrees exactly with `Node.planarAngle` and with `intentFromDesired`'s `aimYaw`, so a value from here
 * can go straight into `setRotation([0, a, 0])`.
 */
export function yawFromDirection(x: number, z: number): number {
    return Math.atan2(x, z) * RAD2DEG;
}

// ---------------------------------------------------------------------------------------------------
// Scratch
// ---------------------------------------------------------------------------------------------------

const SCRATCH_COUNT = 8;
const _scratch: Vector3[] = [];
for (let i = 0; i < SCRATCH_COUNT; i++) _scratch.push(new Vector3());
let _next = 0;

/**
 * A Yuka vector valid until the next `SCRATCH_COUNT` calls. Never store one.
 *
 * A ring rather than named temporaries because the call sites are conversions inside loops, where
 * naming each one buys nothing and mis-naming one silently aliases -- the exact bug that put the
 * camera at the right-vector in `CameraRigNode`.
 */
export function scratchVec3(v?: Vec3Like): Vector3 {
    const out = _scratch[_next];
    _next = (_next + 1) % SCRATCH_COUNT;
    return v ? toYuka(out, v) : out;
}

/** Reset the ring. Tests only -- it makes a scratch assertion independent of what ran before it. */
export function resetScratch(): void {
    _next = 0;
}

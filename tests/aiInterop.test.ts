import { describe, it, expect } from 'vitest';
import { vec3 } from 'gl-matrix';
import {
    fromYuka, resetScratch, scratchVec3, toYuka, yawFromDirection, yawToYukaRotation, yukaVec,
} from '../src/core/ai/interop';
import { Quaternion, Vector3 } from '../src/core/ai/yuka';
import { DEG2RAD } from '../src/core/math';

// The bridge is cheap only because Yuka and Cleo happen to agree: both right-handed, both +Y up, both
// +Z forward, both xyzw quaternions, both column-major matrices. These tests exist so that if a future
// Yuka version quietly changes any of that, the failure lands here rather than as NPCs facing backwards.
//
// The one thing that genuinely does NOT line up is Euler order -- Yuka is YXZ radians, Node.rotation is
// ZYX degrees, gl-matrix quat.fromEuler is ZYX degrees. Hence the yaw scalar bridge.

describe('vector conversion', () => {
    it('round-trips through both directions', () => {
        const out = new Vector3();
        toYuka(out, [1.5, -2.25, 3.75]);
        expect([out.x, out.y, out.z]).toEqual([1.5, -2.25, 3.75]);

        const back = fromYuka(vec3.create(), out);
        expect(Array.from(back)).toEqual([1.5, -2.25, 3.75]);
    });

    it('accepts a gl-matrix vec3, a plain tuple and a Float32Array alike', () => {
        const out = new Vector3();
        expect(toYuka(out, vec3.fromValues(1, 2, 3)).x).toBe(1);
        expect(toYuka(out, [4, 5, 6]).y).toBe(5);
        expect(toYuka(out, new Float32Array([7, 8, 9])).z).toBe(9);
    });

    it('allocates a fresh vector on demand', () => {
        const v = yukaVec([1, 2, 3]);
        expect(v).toBeInstanceOf(Vector3);
        expect([v.x, v.y, v.z]).toEqual([1, 2, 3]);
    });
});

describe('yaw bridging', () => {
    // Cleo's forward at yaw t is (sin t, 0, cos t). A Yuka entity rotated the same way must report the
    // same world direction, or every vision cone points somewhere other than where the body faces.
    it('produces the rotation whose forward matches Cleo convention', () => {
        for (const degrees of [0, 45, 90, 180, -90, 270]) {
            const q = yawToYukaRotation(new Quaternion(), degrees);
            // Rotate +Z (Yuka's default forward) by the quaternion.
            const forward = new Vector3(0, 0, 1).applyRotation(q);
            const radians = degrees * DEG2RAD;
            expect(forward.x).toBeCloseTo(Math.sin(radians), 5);
            expect(forward.y).toBeCloseTo(0, 5);
            expect(forward.z).toBeCloseTo(Math.cos(radians), 5);
        }
    });

    it('agrees with Yuka own YXZ Euler path', () => {
        const mine = yawToYukaRotation(new Quaternion(), 90);
        const theirs = new Quaternion().fromEuler(0, 90 * DEG2RAD, 0);
        expect(mine.x).toBeCloseTo(theirs.x, 6);
        expect(mine.y).toBeCloseTo(theirs.y, 6);
        expect(mine.z).toBeCloseTo(theirs.z, 6);
        expect(mine.w).toBeCloseTo(theirs.w, 6);
    });

    // atan2(x, z), not the atan2(z, x) reflex. This is the same convention as Node.planarAngle and
    // intentFromDesired's aimYaw, so a value from here can go straight into setRotation([0, a, 0]).
    it('recovers a yaw from a direction, inverting the forward convention', () => {
        expect(yawFromDirection(0, 1)).toBeCloseTo(0, 5);
        expect(yawFromDirection(1, 0)).toBeCloseTo(90, 5);
        expect(yawFromDirection(0, -1)).toBeCloseTo(180, 5);
        expect(yawFromDirection(-1, 0)).toBeCloseTo(-90, 5);
    });

    it('round-trips a yaw through a direction and back', () => {
        for (const degrees of [0, 30, 120, -75, 179]) {
            const radians = degrees * DEG2RAD;
            expect(yawFromDirection(Math.sin(radians), Math.cos(radians))).toBeCloseTo(degrees, 5);
        }
    });
});

describe('scratch ring', () => {
    it('hands out a distinct vector each call, then wraps', () => {
        resetScratch();
        const first = scratchVec3([1, 0, 0]);
        const second = scratchVec3([2, 0, 0]);
        expect(second).not.toBe(first);
        expect(first.x).toBe(1);

        // Eight slots, so the ninth call reuses the first -- the reason nothing may hold one.
        for (let i = 0; i < 6; i++) scratchVec3();
        expect(scratchVec3([9, 0, 0])).toBe(first);
    });

    it('returns an uninitialised slot when given no value', () => {
        resetScratch();
        expect(scratchVec3()).toBeInstanceOf(Vector3);
    });
});

import { describe, it, expect } from 'vitest';
import { quat, vec3 } from 'gl-matrix';
import {
    clamp, damp, dampTime, dampVec3Time, dampAngleDeg, deltaAngleDeg,
    eulerFromQuatDeg, noise1, fbm1, wrapDegrees,
} from '../src/core/math';

describe('damp', () => {
    // The property the whole camera rig rests on. A naive `lerp(a, b, 0.1)` per frame fails this:
    // it converges twice as fast at 120fps as at 60fps, so camera feel changes with frame rate.
    it('is frame-rate independent', () => {
        const oneBigStep = damp(0, 100, 3, 0.1);

        let many = 0;
        for (let i = 0; i < 10; i++) many = damp(many, 100, 3, 0.01);

        expect(many).toBeCloseTo(oneBigStep, 10);
    });

    it('returns current for a non-positive dt', () => {
        expect(damp(5, 100, 3, 0)).toBe(5);
        expect(damp(5, 100, 3, -1)).toBe(5);
    });

    it('is rigid for a non-positive or non-finite lambda', () => {
        expect(damp(5, 100, 0, 0.016)).toBe(100);
        expect(damp(5, 100, -1, 0.016)).toBe(100);
        expect(damp(5, 100, Infinity, 0.016)).toBe(100);
        expect(damp(5, 100, NaN, 0.016)).toBe(100);
    });

    it('converges monotonically without overshooting', () => {
        let v = 0;
        let previous = -1;
        for (let i = 0; i < 500; i++) {
            v = damp(v, 10, 5, 0.016);
            // Non-strict: once converged to within float epsilon the value stops moving entirely.
            expect(v).toBeGreaterThanOrEqual(previous);
            expect(v).toBeLessThanOrEqual(10);
            previous = v;
        }
        expect(v).toBeCloseTo(10, 6);
    });

    it('covers ~63% of the gap in one time constant', () => {
        expect(dampTime(0, 1, 0.5, 0.5)).toBeCloseTo(1 - Math.exp(-1), 10);
    });
});

describe('dampTime / dampVec3Time', () => {
    it('treats a zero time constant as instant', () => {
        expect(dampTime(5, 100, 0, 0.016)).toBe(100);
    });

    it('applies a separate time constant per axis', () => {
        const out = dampVec3Time(
            vec3.create(),
            vec3.fromValues(0, 0, 0),
            vec3.fromValues(10, 10, 10),
            vec3.fromValues(0, 0.5, 1e9),      // instant / normal / effectively frozen
            0.1
        );
        expect(out[0]).toBe(10);
        expect(out[1]).toBeGreaterThan(0);
        expect(out[1]).toBeLessThan(10);
        expect(out[2]).toBeCloseTo(0, 5);
    });
});

describe('angles', () => {
    it('wraps into (-180, 180]', () => {
        expect(wrapDegrees(190)).toBeCloseTo(-170, 10);
        expect(wrapDegrees(-190)).toBeCloseTo(170, 10);
        expect(wrapDegrees(180)).toBeCloseTo(180, 10);
        expect(wrapDegrees(-180)).toBeCloseTo(180, 10);
        expect(wrapDegrees(720 + 45)).toBeCloseTo(45, 10);
    });

    it('takes the short way across the +/-180 seam', () => {
        expect(deltaAngleDeg(170, -170)).toBeCloseTo(20, 10);
        expect(deltaAngleDeg(-170, 170)).toBeCloseTo(-20, 10);
    });

    // Damping the raw numbers instead would send a yaw crossing the seam -358 degrees the long way,
    // which on screen is the camera spinning a full turn to reach a heading 2 degrees away.
    it('damps along the short arc across the seam', () => {
        const next = dampAngleDeg(179, -179, 0.1, 0.05);
        expect(next).toBeGreaterThan(179);
        expect(wrapDegrees(next)).not.toBeGreaterThan(180);
        expect(deltaAngleDeg(179, next)).toBeGreaterThan(0);
        expect(deltaAngleDeg(179, next)).toBeLessThan(2);
    });

    it('snaps when the time constant is zero', () => {
        expect(dampAngleDeg(179, -179, 0, 0.016)).toBeCloseTo(-179, 10);
    });
});

describe('noise1 / fbm1', () => {
    it('is deterministic and bounded', () => {
        for (let i = 0; i < 200; i++) {
            const x = i * 0.37;
            const n = noise1(x, 1234);
            expect(n).toBe(noise1(x, 1234));
            expect(n).toBeGreaterThanOrEqual(-1);
            expect(n).toBeLessThanOrEqual(1);
            expect(fbm1(x, 1234)).toBeGreaterThanOrEqual(-1);
            expect(fbm1(x, 1234)).toBeLessThanOrEqual(1);
        }
    });

    // Continuity is the whole reason this exists instead of Math.random(): per-frame white noise
    // reads as dropped frames, not as a shake.
    it('is continuous', () => {
        for (let i = 0; i < 200; i++) {
            const x = i * 0.37;
            expect(Math.abs(noise1(x, 7) - noise1(x + 0.001, 7))).toBeLessThan(0.05);
        }
    });

    it('separates seeds', () => {
        expect(noise1(3.3, 1)).not.toBeCloseTo(noise1(3.3, 999), 3);
    });
});

describe('eulerFromQuatDeg', () => {
    // The mapping euler -> quat is many-to-one, so the euler that comes back need not match the one
    // that went in. What must hold is that it describes the SAME orientation. This is the test that
    // guards Node.setQuaternion's _euler sync: get it wrong and a setQuaternion followed by a
    // rotateY() snaps the node to a different orientation.
    // The angular error between the original orientation and the one the returned euler rebuilds.
    // `alloc` selects the storage: gl-matrix's default quat is Float32Array, which is what the engine
    // actually uses, but it caps achievable precision at ~0.1 degrees. Float64 isolates the formula.
    const roundTripError = (pitch: number, yaw: number, roll: number, alloc: () => any) => {
        const q = quat.fromEuler(alloc(), pitch, yaw, roll);
        const e = eulerFromQuatDeg(vec3.create(), q);
        const back = quat.fromEuler(alloc(), e[0], e[1], e[2]);
        // quat and -quat are the same rotation, so compare via |dot| rather than componentwise.
        return 2 * Math.acos(Math.min(1, Math.abs(quat.dot(q, back)))) * 180 / Math.PI;
    };

    // Float32 tolerance, measured: a dense sweep peaks around 0.05 deg. Deliberately not asserting
    // tighter -- that would be a flaky test rather than a stronger one.
    const sameOrientation = (pitch: number, yaw: number, roll: number) => {
        expect(roundTripError(pitch, yaw, roll, () => quat.create())).toBeLessThan(0.15);
    };

    // Deterministic sampling (a plain LCG): a Math.random() sweep here would fail intermittently
    // whenever it happened to land on a badly-conditioned orientation.
    it('round-trips arbitrary orientations', () => {
        let seed = 0x2f6e2b1
        const next = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
        for (let i = 0; i < 500; i++) {
            sameOrientation((next() * 2 - 1) * 180, (next() * 2 - 1) * 180, (next() * 2 - 1) * 180)
        }
    });

    // The real correctness guard, separated from float32 noise: in double precision the extraction
    // must be essentially exact. If the euler order or a sign is wrong, this fails by whole degrees
    // no matter how loose the float32 tolerance above is.
    it('is exact in double precision', () => {
        let worst = 0
        for (let pitch = -180; pitch <= 180; pitch += 15)
            for (let yaw = -180; yaw <= 180; yaw += 5)
                for (let roll = -180; roll <= 180; roll += 15)
                    worst = Math.max(worst, roundTripError(pitch, yaw, roll, () => new Float64Array(4)))
        expect(worst).toBeLessThan(1e-4)
    });

    it('round-trips the axis-aligned cases', () => {
        for (const yaw of [0, 45, 90, -90, 135, 180, -180]) {
            for (const pitch of [0, 30, -30, 89, -89]) {
                sameOrientation(pitch, yaw, 0);
            }
        }
    });

    // gl-matrix composes as Rz(roll)*Ry(yaw)*Rx(pitch), so the singular orientation is yaw = +/-90 --
    // not pitch. That is an ordinary camera heading, so the guard has to hold there exactly.
    it('round-trips at and around the yaw gimbal pole', () => {
        for (const yaw of [90, -90, 89.999, -89.999, 90.001]) {
            for (const pitch of [0, 25, -25]) {
                for (const roll of [0, 40]) {
                    sameOrientation(pitch, yaw, roll);
                }
            }
        }
    });

    it('reports the pole in yaw and pins roll to zero there', () => {
        const q = quat.fromEuler(quat.create(), 20, 90, 0);
        const e = eulerFromQuatDeg(vec3.create(), q);
        // Loose on yaw: asin has an infinite derivative at the pole, so float32 input caps the
        // achievable precision here at ~0.02 degrees. The orientation round-trip above is the real
        // guarantee; this test only pins down WHICH angle goes singular.
        expect(e[1]).toBeCloseTo(90, 1);
        expect(e[2]).toBe(0);
    });
});

describe('clamp', () => {
    it('bounds on both sides and passes through the interior', () => {
        expect(clamp(-5, 0, 1)).toBe(0);
        expect(clamp(5, 0, 1)).toBe(1);
        expect(clamp(0.25, 0, 1)).toBe(0.25);
    });
});

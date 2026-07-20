import { describe, it, expect } from 'vitest';
import { quat, vec3 } from 'gl-matrix';
import { aimFromDirection, boomOffset, collisionRatio, shakeOffsets } from '../src/core/cameraRigMath';

describe('aimFromDirection', () => {
    it('maps the axis directions to the engine conventions', () => {
        // toBeCloseTo, not toMatchObject: -asin(0) is -0, which Object.is distinguishes from +0.
        expect(aimFromDirection(vec3.fromValues(0, 0, 1)).yaw).toBeCloseTo(0, 10);
        expect(aimFromDirection(vec3.fromValues(0, 0, 1)).pitch).toBeCloseTo(0, 10);
        expect(aimFromDirection(vec3.fromValues(1, 0, 0)).yaw).toBeCloseTo(90, 10);
        expect(aimFromDirection(vec3.fromValues(-1, 0, 0)).yaw).toBeCloseTo(-90, 10);
        expect(Math.abs(aimFromDirection(vec3.fromValues(0, 0, -1)).yaw)).toBeCloseTo(180, 10);
        // Positive pitch looks DOWN.
        expect(aimFromDirection(vec3.fromValues(0, -1, 0)).pitch).toBeCloseTo(90, 10);
        expect(aimFromDirection(vec3.fromValues(0, 1, 0)).pitch).toBeCloseTo(-90, 10);
    });

    // The one test that catches a wrong euler order or a flipped sign. Without it, the failure mode
    // is a camera that points somewhere plausible-but-wrong and is painful to debug by eye.
    it('produces angles whose forward vector is the input direction', () => {
        for (let i = 0; i < 300; i++) {
            const d = vec3.normalize(vec3.create(), vec3.fromValues(
                Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1
            ));
            if (!isFinite(d[0])) continue;

            const { yaw, pitch } = aimFromDirection(d);
            const q = quat.fromEuler(quat.create(), pitch, yaw, 0);
            const forward = vec3.transformQuat(vec3.create(), vec3.fromValues(0, 0, 1), q);

            expect(forward[0]).toBeCloseTo(d[0], 6);
            expect(forward[1]).toBeCloseTo(d[1], 6);
            expect(forward[2]).toBeCloseTo(d[2], 6);
        }
    });

    it('is unaffected by the length of the input', () => {
        const a = aimFromDirection(vec3.fromValues(3, -4, 5));
        const b = aimFromDirection(vec3.fromValues(30, -40, 50));
        expect(a.yaw).toBeCloseTo(b.yaw, 10);
        expect(a.pitch).toBeCloseTo(b.pitch, 10);
    });

    it('returns a neutral aim for a degenerate direction', () => {
        expect(aimFromDirection(vec3.create())).toMatchObject({ yaw: 0, pitch: 0 });
    });
});

describe('boomOffset', () => {
    it('places the camera back along local -Z', () => {
        const out = boomOffset(vec3.create(), vec3.create(), 4);
        expect([...out]).toEqual([0, 0, -4]);
    });

    it('adds the socket offset', () => {
        const out = boomOffset(vec3.create(), vec3.fromValues(0.5, 1, 0.25), 4);
        expect([...out]).toEqual([0.5, 1, -3.75]);
    });
});

describe('collisionRatio', () => {
    it('keeps the full boom when nothing is hit', () => {
        expect(collisionRatio(null, 4, 0.2, 0.05)).toBe(1);
    });

    it('shortens proportionally, minus the radius skin', () => {
        expect(collisionRatio(2, 4, 0.2, 0.05)).toBeCloseTo((2 - 0.2) / 4, 10);
    });

    it('never lets the camera collapse onto the pivot', () => {
        // Pivot buried in geometry: every ray hits at ~0. Collapsing to 0 would clip through the
        // followed character, so the floor is what keeps the shot usable.
        expect(collisionRatio(0, 4, 0.2, 0.05)).toBe(0.05);
        expect(collisionRatio(0.1, 4, 0.2, 0.05)).toBe(0.05);
    });

    it('clamps a hit beyond the boom back to 1', () => {
        expect(collisionRatio(99, 4, 0.2, 0.05)).toBe(1);
    });

    it('is a no-op for a degenerate boom', () => {
        expect(collisionRatio(1, 0, 0.2, 0.05)).toBe(1);
    });
});

describe('shakeOffsets', () => {
    const make = () => ({ position: vec3.create(), rotation: vec3.create() });
    const posAmp = vec3.fromValues(0.15, 0.15, 0.05);
    const rotAmp = vec3.fromValues(1.5, 1.5, 2.5);

    it('is exactly zero at rest', () => {
        const out = shakeOffsets(make(), 12.5, 7, 22, 0, posAmp, rotAmp);
        expect([...out.position]).toEqual([0, 0, 0]);
        expect([...out.rotation]).toEqual([0, 0, 0]);
    });

    it('stays within the configured amplitudes', () => {
        for (let i = 0; i < 400; i++) {
            const out = shakeOffsets(make(), i * 0.013, 7, 22, 1, posAmp, rotAmp);
            for (let a = 0; a < 3; a++) {
                expect(Math.abs(out.position[a])).toBeLessThanOrEqual(posAmp[a] + 1e-12);
                expect(Math.abs(out.rotation[a])).toBeLessThanOrEqual(rotAmp[a] + 1e-12);
            }
        }
    });

    it('scales linearly with strength', () => {
        const full = shakeOffsets(make(), 3.1, 7, 22, 1, posAmp, rotAmp);
        const half = shakeOffsets(make(), 3.1, 7, 22, 0.5, posAmp, rotAmp);
        expect(half.position[0]).toBeCloseTo(full.position[0] * 0.5, 12);
        expect(half.rotation[2]).toBeCloseTo(full.rotation[2] * 0.5, 12);
    });

    // Correlated channels would make the camera slide along one diagonal instead of shaking.
    it('drives the six channels independently', () => {
        const uniform = vec3.fromValues(1, 1, 1);
        const seen = new Set<number>();
        for (let i = 0; i < 40; i++) {
            const out = shakeOffsets(make(), i * 0.11, 7, 22, 1, uniform, uniform);
            for (const v of [...out.position, ...out.rotation]) seen.add(Math.round(v * 1e6));
        }
        // 40 samples x 6 channels; if any two channels were duplicates we would see far fewer.
        expect(seen.size).toBeGreaterThan(200);
    });
});

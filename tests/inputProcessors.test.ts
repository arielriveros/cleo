import { describe, it, expect } from 'vitest';
import {
    applyCurve, applyDeadzone1D, applyInvert, applyRadialDeadzone, applyScale, normalizeVec2,
    runProcessors1D, runProcessors2D, smoothToward,
} from '../src/input/processors';
import type { SmoothingState, Vec2 } from '../src/input/processors';
import type { Processor } from '../src/input/actionMap';

// This is the half of the input system where a mistake is FELT rather than reported: a stick with a
// notch at the deadzone edge, a diagonal that runs faster than a cardinal, a resting analog stick that
// drifts. Those are all continuity or zero-case failures, and they are exactly what numbers can pin
// without a device.

describe('applyDeadzone1D', () => {
    it('is zero below min and saturates at max', () => {
        expect(applyDeadzone1D(0, 0.2, 0.9)).toBe(0);
        expect(applyDeadzone1D(0.2, 0.2, 0.9)).toBe(0);
        expect(applyDeadzone1D(0.9, 0.2, 0.9)).toBeCloseTo(1, 10);
        expect(applyDeadzone1D(5, 0.2, 0.9)).toBe(1);
    });

    it('is continuous at the deadzone edge', () => {
        // A jump from 0 to min here is the classic "notchy stick": the value has to leave zero smoothly,
        // which is why the surviving range is RESCALED rather than merely clipped.
        const justInside = applyDeadzone1D(0.2 - 1e-6, 0.2, 0.9);
        const justOutside = applyDeadzone1D(0.2 + 1e-6, 0.2, 0.9);
        expect(justInside).toBe(0);
        expect(justOutside).toBeLessThan(1e-4);
    });

    it('is monotone and symmetric about zero', () => {
        let previous = 0;
        for (let v = 0; v <= 1; v += 0.01) {
            const shaped = applyDeadzone1D(v, 0.15, 0.95);
            expect(shaped).toBeGreaterThanOrEqual(previous - 1e-12);
            expect(applyDeadzone1D(-v, 0.15, 0.95)).toBeCloseTo(-shaped, 10);
            previous = shaped;
        }
    });

    it('survives bounds that are equal, inverted or negative', () => {
        // parseInputMap repairs these, but a caller passing raw numbers must not produce Infinity/NaN.
        for (const [min, max] of [[0.5, 0.5], [0.9, 0.1], [-1, -2]] as const)
            expect(Number.isFinite(applyDeadzone1D(0.7, min, max))).toBe(true);
    });
});

describe('applyRadialDeadzone', () => {
    it('preserves direction and never exceeds unit length', () => {
        const out: Vec2 = [0, 0];
        applyRadialDeadzone(out, 3, 4, 0.15, 0.95);          // length 5, direction (0.6, 0.8)
        expect(Math.hypot(out[0], out[1])).toBeCloseTo(1, 10);
        expect(out[0] / out[1]).toBeCloseTo(3 / 4, 10);
    });

    it('silences a resting stick in every direction, not just on the axes', () => {
        // A per-axis deadzone lets a diagonal through while both axes are individually dead, which reads
        // as a controller that drifts diagonally when nobody is touching it.
        const out: Vec2 = [0, 0];
        for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 8) {
            applyRadialDeadzone(out, Math.cos(angle) * 0.1, Math.sin(angle) * 0.1, 0.15, 0.95);
            expect(Math.hypot(out[0], out[1])).toBe(0);
        }
    });

    it('returns [0, 0] for a zero vector rather than NaN', () => {
        const out: Vec2 = [9, 9];
        expect(applyRadialDeadzone(out, 0, 0, 0.15, 0.95)).toEqual([0, 0]);
    });
});

describe('applyCurve / applyScale / applyInvert', () => {
    it('leaves the value alone for exponent 1 and for a degenerate exponent', () => {
        expect(applyCurve(0.37, 1)).toBe(0.37);
        expect(applyCurve(0.37, 0)).toBe(0.37);
        expect(applyCurve(0.37, NaN)).toBe(0.37);
        expect(applyCurve(0.37, -2)).toBe(0.37);
    });

    it('keeps the sign and gives finer control near centre for exponent > 1', () => {
        expect(applyCurve(-0.5, 2)).toBeCloseTo(-0.25, 10);
        expect(applyCurve(1, 3)).toBeCloseTo(1, 10);
        expect(Math.abs(applyCurve(0.5, 2))).toBeLessThan(0.5);
    });

    it('ignores a non-finite scale factor rather than producing NaN', () => {
        expect(applyScale(2, 3)).toBe(6);
        expect(applyScale(2, NaN)).toBe(2);
        expect(applyScale(2, Infinity)).toBe(2);
    });

    it('inverts only when asked', () => {
        expect(applyInvert(0.5, true)).toBe(-0.5);
        expect(applyInvert(0.5, false)).toBe(0.5);
    });
});

describe('normalizeVec2', () => {
    it('returns [0, 0] for a zero vector rather than NaN', () => {
        // The exact defect in the controller this system replaces: `dirX /= Math.hypot(dirX, dirZ)`
        // unguarded, which produced NaN velocity the moment the player stood still.
        const out: Vec2 = [9, 9];
        expect(normalizeVec2(out, 0, 0)).toEqual([0, 0]);
        expect(Number.isNaN(out[0])).toBe(false);
    });

    it('clamps a long vector to unit length but leaves a short one alone', () => {
        const out: Vec2 = [0, 0];
        // A WASD diagonal is length sqrt(2) and must come out at the same speed as a cardinal...
        normalizeVec2(out, 1, 1);
        expect(Math.hypot(out[0], out[1])).toBeCloseTo(1, 10);
        // ...while a gently pushed analog stick must NOT be amplified to full tilt. Getting this wrong
        // is what destroys the analog range when a keyboard controller is ported to a pad.
        normalizeVec2(out, 0.3, 0);
        expect(out).toEqual([0.3, 0]);
    });
});

describe('smoothToward', () => {
    it('is instant when the time constant is zero or negative', () => {
        expect(smoothToward(0, 1, 0, 1 / 60)).toBe(1);
        expect(smoothToward(0, 1, -1, 1 / 60)).toBe(1);
    });

    it('does not move on a zero or negative dt', () => {
        // A paused frame must not advance a filter, or unpausing snaps.
        expect(smoothToward(0.4, 1, 0.1, 0)).toBe(0.4);
        expect(smoothToward(0.4, 1, 0.1, -1)).toBe(0.4);
    });

    it('approaches the target monotonically without overshooting', () => {
        let value = 0;
        for (let i = 0; i < 200; i++) {
            const next = smoothToward(value, 1, 0.1, 1 / 60);
            expect(next).toBeGreaterThanOrEqual(value);
            expect(next).toBeLessThanOrEqual(1);
            value = next;
        }
        expect(value).toBeCloseTo(1, 4);
    });

    it('reaches the same place in the same wall-clock time at any frame rate', () => {
        // Frame-rate dependence in input smoothing is invisible on the dev machine and obvious on a
        // slower one, so it is worth a test rather than a comment.
        let slow = 0;
        for (let i = 0; i < 30; i++) slow = smoothToward(slow, 1, 0.2, 1 / 30);
        let fast = 0;
        for (let i = 0; i < 120; i++) fast = smoothToward(fast, 1, 0.2, 1 / 120);
        expect(slow).toBeCloseTo(fast, 6);
    });
});

describe('runProcessors1D', () => {
    it('returns the value untouched for an absent or empty chain', () => {
        expect(runProcessors1D(undefined, 0.42, null, 1 / 60)).toBe(0.42);
        expect(runProcessors1D([], 0.42, null, 1 / 60)).toBe(0.42);
    });

    it('applies the chain in the authored order', () => {
        // scale-then-deadzone and deadzone-then-scale are different patches, and neither is wrong —
        // which is why order is preserved rather than the chain being sorted into a canonical form.
        const scaleThenDeadzone: Processor[] = [{ kind: 'scale', factor: 10 }, { kind: 'deadzone', min: 0.5, max: 1 }];
        const deadzoneThenScale: Processor[] = [{ kind: 'deadzone', min: 0.5, max: 1 }, { kind: 'scale', factor: 10 }];
        expect(runProcessors1D(scaleThenDeadzone, 0.1, null, 1 / 60))
            .not.toBe(runProcessors1D(deadzoneThenScale, 0.1, null, 1 / 60));
    });

    it('carries smoothing in the caller-supplied slot, not in module state', () => {
        const chain: Processor[] = [{ kind: 'smooth', seconds: 0.1 }];
        const a: SmoothingState = { x: 0, y: 0 };
        const b: SmoothingState = { x: 0, y: 0 };
        runProcessors1D(chain, 1, a, 1 / 60);
        expect(a.x).toBeGreaterThan(0);
        // Two filters must be independent, or two actions bound to the same source would share a lag.
        expect(b.x).toBe(0);
    });

    it('ignores a smooth processor when no slot was supplied', () => {
        const chain: Processor[] = [{ kind: 'smooth', seconds: 0.1 }];
        expect(runProcessors1D(chain, 1, null, 1 / 60)).toBe(1);
    });

    it('treats normalize as a clamp on a scalar', () => {
        expect(runProcessors1D([{ kind: 'normalize' }], 3, null, 1 / 60)).toBe(1);
        expect(runProcessors1D([{ kind: 'normalize' }], -3, null, 1 / 60)).toBe(-1);
    });
});

describe('runProcessors2D', () => {
    it('writes into the out parameter and returns it', () => {
        const out: Vec2 = [0, 0];
        expect(runProcessors2D(out, undefined, 0.2, 0.3, null, 1 / 60)).toBe(out);
        expect(out).toEqual([0.2, 0.3]);
    });

    it('applies a plain deadzone per axis and a radial one to the magnitude', () => {
        const perAxis: Vec2 = [0, 0];
        const radial: Vec2 = [0, 0];
        // Both axes individually inside a 0.2 deadzone, but the vector itself is 0.28 long.
        runProcessors2D(perAxis, [{ kind: 'deadzone', min: 0.2, max: 1 }], 0.2, 0.2, null, 1 / 60);
        runProcessors2D(radial, [{ kind: 'radialDeadzone', min: 0.2, max: 1 }], 0.2, 0.2, null, 1 / 60);
        expect(perAxis).toEqual([0, 0]);
        expect(Math.hypot(radial[0], radial[1])).toBeGreaterThan(0);
    });

    it('inverts each axis independently', () => {
        const out: Vec2 = [0, 0];
        runProcessors2D(out, [{ kind: 'invert', x: false, y: true }], 0.5, 0.5, null, 1 / 60);
        expect(out).toEqual([0.5, -0.5]);
    });

    it('normalizes a diagonal to unit length', () => {
        const out: Vec2 = [0, 0];
        runProcessors2D(out, [{ kind: 'normalize' }], 1, 1, null, 1 / 60);
        expect(Math.hypot(out[0], out[1])).toBeCloseTo(1, 10);
    });
});

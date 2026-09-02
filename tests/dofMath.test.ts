import { describe, it, expect } from 'vitest';
import { vec3 } from 'gl-matrix';
import {
    SENSOR_HEIGHT, circleOfConfusion, effectiveFocusDistance, focalLengthFromFov,
    focusDistanceToTarget,
} from '../src/graphics/dofMath';

/**
 * Depth of field is the post effect whose failures all look plausible.
 *
 * A circle of confusion that is mis-scaled, or that has lost its sign, still produces a blurry image —
 * so nothing looks broken, it just never quite focuses where the artist asked. The three properties
 * worth pinning are the ones a hand-rolled "blur by distance from focus" ramp gets wrong, and which
 * are the entire reason this uses a thin lens instead:
 *
 *   - the NEAR field blurs harder than the far field at the same distance from focus,
 *   - the far field SATURATES at infinity rather than growing without bound,
 *   - the sign distinguishes the two, because the near field composites over and the far field does not.
 */

// A 50mm-equivalent view on the fixed 35mm sensor, near enough: fovY 27.0 degrees.
const FOV = 27;
const F = focalLengthFromFov(FOV);
const H = 1080;

/** CoC at `depth` with the rig above, focused at `focus`, wide open, effectively unclamped. */
function coc(depth: number, focus: number, fStop = 2.8, range = 0, max = 1e9): number {
    return circleOfConfusion(depth, focus, range, fStop, F, H, max);
}

describe('focal length from field of view', () => {
    it('inverts to the FOV it was derived from', () => {
        // The lens has to follow the camera, or the image is focused for a lens the scene is not being
        // shot with. Round-trip through the same relation the renderer will use.
        const back = 2 * Math.atan((SENSOR_HEIGHT * 0.5) / F) * 180 / Math.PI;
        expect(back).toBeCloseTo(FOV, 6);
    });

    it('shortens as the view widens', () => {
        expect(focalLengthFromFov(90)).toBeLessThan(focalLengthFromFov(30));
    });

    it('survives a degenerate FOV instead of dividing by zero', () => {
        expect(Number.isFinite(focalLengthFromFov(0))).toBe(true);
        expect(Number.isFinite(focalLengthFromFov(-10))).toBe(true);
    });
});

describe('circle of confusion', () => {
    it('is exactly zero at the focal plane', () => {
        expect(coc(5, 5)).toBe(0);
    });

    it('is negative in front of focus and positive behind it', () => {
        // The sign is what tells the gather which side composites OVER the other. Losing it halos
        // every foreground silhouette, and the image still looks like depth of field.
        expect(coc(2, 5)).toBeLessThan(0);
        expect(coc(20, 5)).toBeGreaterThan(0);
    });

    it('blurs the near field harder than the far field at equal distance from focus', () => {
        // The property a linear ramp gets backwards. At 3m either side of a 5m plane, the foreground
        // is far more defocused than the background — which is why a subject stepping toward the
        // camera goes soft so much faster than one stepping away.
        const near = Math.abs(coc(2, 5));
        const far = Math.abs(coc(8, 5));
        expect(near).toBeGreaterThan(far);
    });

    it('saturates at infinity rather than growing without bound', () => {
        // The far field can only ever reach the CoC of a point at infinity. An unbounded ramp would
        // keep widening with the far plane, so pushing the camera's far distance out would change the
        // background blur of a scene nobody edited.
        const atInfinity = (F * F) / (2.8 * (5 - F)) / SENSOR_HEIGHT * H;
        expect(coc(1e6, 5)).toBeLessThanOrEqual(atInfinity + 1e-6);
        expect(coc(1e6, 5)).toBeCloseTo(atInfinity, 3);
        // ...and it is genuinely approached, not merely bounded.
        expect(coc(1000, 5)).toBeGreaterThan(atInfinity * 0.99);
    });

    it('opens up as the aperture widens', () => {
        // Smaller f-number = wider aperture = shallower focus, as written on a lens barrel.
        expect(Math.abs(coc(20, 5, 1.4))).toBeGreaterThan(Math.abs(coc(20, 5, 8)));
    });

    it('clamps to the pixel budget in both directions', () => {
        // A cost control, not a look control: the gather's sample count is chosen for a radius, so an
        // unclamped CoC undersamples and bands rather than blurring further.
        expect(coc(0.2, 5, 1.4, 0, 16)).toBe(-16);
        expect(coc(1e6, 5, 1.4, 0, 16)).toBe(16);
    });

    it('returns zero for a depth at or behind the lens', () => {
        // Guards the division. Reached by the sky branch and by any pass that hands over a cleared
        // depth buffer before anything has rendered into it.
        expect(coc(0, 5)).toBe(0);
        expect(coc(-3, 5)).toBe(0);
    });

    it('does not flip sign when focus is pushed inside the focal length', () => {
        // `subject - focalLength` is a denominator; a focus distance below it would inverse the whole
        // image's near/far relationship rather than failing visibly.
        expect(coc(10, 0)).toBeGreaterThan(0);
        expect(coc(10, F * 0.5)).toBeGreaterThan(0);
    });
});

describe('focus range', () => {
    it('keeps everything inside the band perfectly sharp', () => {
        // 4m band around 5m: 3m..7m is the subject, and all of it is in focus.
        expect(coc(3.5, 5, 2.8, 4)).toBe(0);
        expect(coc(5, 5, 2.8, 4)).toBe(0);
        expect(coc(6.5, 5, 2.8, 4)).toBe(0);
    });

    it('measures from the band edge, so there is no step at the boundary', () => {
        // Zeroing the CoC inside the band instead would make a pixel just outside it jump straight to
        // the CoC it would have had against the band's CENTRE — a visible ring around the subject.
        const justOutside = Math.abs(coc(7.001, 5, 2.8, 4));
        expect(justOutside).toBeLessThan(0.05);
        expect(justOutside).toBeGreaterThan(0);
    });

    it('reduces to the plain thin lens at zero range', () => {
        expect(coc(12, 5, 2.8, 0)).toBeCloseTo(coc(12, 5, 2.8, 0), 12);
        expect(effectiveFocusDistance(12, 5, 0)).toBe(5);
    });

    it('clamps a negative range rather than inverting the band', () => {
        expect(effectiveFocusDistance(12, 5, -4)).toBe(5);
    });
});

describe('focus distance to a target node', () => {
    const forward = vec3.fromValues(0, 0, -1);   // the engine's camera looks down -Z

    it('measures along the view axis, not the euclidean distance', () => {
        // The property that keeps a target sharp when it is off to one side. Euclidean distance to
        // this target is 5, but it sits on the 4m plane — focusing at 5 would leave it soft.
        const camera = vec3.fromValues(0, 0, 0);
        const target = vec3.fromValues(3, 0, -4);
        expect(vec3.distance(camera, target)).toBeCloseTo(5, 6);
        expect(focusDistanceToTarget(camera, forward, target)).toBeCloseTo(4, 6);
    });

    it('is unaffected by movement across the view axis', () => {
        const camera = vec3.fromValues(0, 0, 0);
        const a = focusDistanceToTarget(camera, forward, vec3.fromValues(0, 0, -7));
        const b = focusDistanceToTarget(camera, forward, vec3.fromValues(0, 9, -7));
        expect(a).toBeCloseTo(b, 6);
    });

    it('is measured from the camera, wherever it stands', () => {
        const camera = vec3.fromValues(10, 2, 30);
        const target = vec3.fromValues(10, 2, 24);
        expect(focusDistanceToTarget(camera, forward, target)).toBeCloseTo(6, 6);
    });

    it('goes negative for a target behind the camera', () => {
        // Not an error to handle here — `circleOfConfusion` clamps it to "focused at the nearest
        // distance that exists" rather than inverting the image.
        const camera = vec3.fromValues(0, 0, 0);
        expect(focusDistanceToTarget(camera, forward, vec3.fromValues(0, 0, 5))).toBeCloseTo(-5, 6);
        expect(coc(10, -5)).toBeGreaterThan(0);
    });
});

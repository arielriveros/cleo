// Depth-of-field math: where the focal plane is, and how far out of focus a given depth is.
//
// A leaf module on purpose, in the shape of `shadowMath.ts`. Everything here is arithmetic over
// numbers, so it is the half of depth of field that can be tested without a GPU — and it is the half
// that gets silently wrong, because a circle of confusion that is subtly mis-scaled still produces a
// plausible-looking blurry image.
//
// The model is a thin lens, not an artist-invented falloff. That is what makes an f-stop mean what a
// photographer expects: the near field blurs far harder than the far field, and the far field
// SATURATES at infinity instead of growing without bound. A linear "blur by distance from focus" ramp
// gets both of those backwards and needs a clamp to stay usable.

import { vec3 } from 'gl-matrix';

/**
 * Sensor height, in metres — full-frame 35mm (36 x 24). Fixed rather than exposed: it only ever
 * appears as a RATIO against the focal length derived from it below, so a second control here would
 * be a second way to say the same thing. It is what makes the f-stop numbers land where a
 * photographer expects them.
 */
export const SENSOR_HEIGHT = 0.024;

/**
 * The focal length, in metres, that reproduces this vertical FOV on {@link SENSOR_HEIGHT}.
 *
 * Derived from the camera rather than authored, so that widening the FOV shortens the lens the way it
 * does on a real camera — and with it the depth of field. Authoring focal length separately would let
 * the two disagree, and the image would then be focused for a lens the scene is not being shot with.
 */
export function focalLengthFromFov(fovDegrees: number): number {
    const fov = Math.max(1e-3, (Math.max(0, fovDegrees) * Math.PI) / 180);
    return (SENSOR_HEIGHT * 0.5) / Math.tan(fov * 0.5);
}

/**
 * The distance the lens is focused at when it tracks a target, in metres.
 *
 * The target's distance ALONG THE VIEW AXIS, not from the camera — a target off to one side is
 * further away than the plane it sits on, and focusing on the euclidean distance would pull the focal
 * plane past it and leave the target itself soft. This is the same projection a view matrix's Z row
 * performs; done here directly so the caller needs no matrix.
 *
 * `forward` must be unit length. A target behind the camera yields a negative distance, which
 * {@link circleOfConfusion} treats as "no useful focus" — see the clamp there.
 */
export function focusDistanceToTarget(
    cameraPosition: vec3, cameraForward: vec3, targetPosition: vec3,
): number {
    return (targetPosition[0] - cameraPosition[0]) * cameraForward[0]
         + (targetPosition[1] - cameraPosition[1]) * cameraForward[1]
         + (targetPosition[2] - cameraPosition[2]) * cameraForward[2];
}

/**
 * The distance the CoC is actually measured against, given a sharp band of `range` metres centred on
 * the focal plane.
 *
 * A band of perfect focus is not physical — a real lens has exactly one focused plane — but it is what
 * an artist means by "keep the subject sharp", and without it a character's nose and ears cannot both
 * be in focus at f/1.4. Implemented by moving the focus distance to the NEAR EDGE of the band for
 * anything in front of it and the FAR EDGE for anything behind, rather than by zeroing the CoC inside
 * the band: zeroing leaves a visible step at the band edge, where a pixel just outside jumps straight
 * to the CoC it would have had against the centre.
 */
export function effectiveFocusDistance(depth: number, focusDistance: number, focusRange: number): number {
    const half = Math.max(0, focusRange) * 0.5;
    if (depth < focusDistance - half) return focusDistance - half;
    if (depth > focusDistance + half) return focusDistance + half;
    return depth;   // inside the band: focused on itself, so the CoC below is exactly 0
}

/**
 * Signed circle of confusion in PIXELS, at a view-space depth of `depth` metres.
 *
 * NEGATIVE in the near field (nearer than focus), positive in the far field. The sign is not
 * decoration: the near field has to be composited OVER the focused image because an out-of-focus
 * foreground spreads across the things behind it, while the far field is occluded by them. A gather
 * that only had a magnitude would have to guess, and it would halo every foreground silhouette.
 *
 * `fStop` is the aperture as written on a lens barrel: smaller number, shallower focus.
 *
 * The result is clamped to +/-`maxCocPixels`, which is a COST control rather than a look control —
 * the gather's sample count is chosen for a radius, so an unclamped CoC would undersample and band.
 */
export function circleOfConfusion(
    depth: number, focusDistance: number, focusRange: number,
    fStop: number, focalLength: number, screenHeight: number, maxCocPixels: number,
): number {
    // A depth at or behind the lens has no meaningful projection, and would divide by ~0 below.
    if (!(depth > 1e-4)) return 0;
    const focus = effectiveFocusDistance(depth, focusDistance, focusRange);
    // Focusing at or inside the focal length is not a configuration a lens has; it would also flip the
    // sign of the whole expression. Treat it as "focused at the nearest distance that exists".
    const subject = Math.max(focus, focalLength * 1.0001);
    const aperture = Math.max(1e-3, fStop);

    // Thin lens. The leading term is the CoC at INFINITY, in metres on the sensor; the trailing term
    // runs it from 0 at the focal plane to 1 as depth grows, and negative in front of it.
    const cocAtInfinity = (focalLength * focalLength) / (aperture * (subject - focalLength));
    const cocMetres = cocAtInfinity * ((depth - subject) / depth);

    // Sensor metres -> pixels. The HEIGHT on both sides: the vertical FOV is what `focalLengthFromFov`
    // inverted, so pairing it with the width here would stretch the blur with the aspect ratio.
    const cocPixels = (cocMetres / SENSOR_HEIGHT) * screenHeight;
    const limit = Math.max(0, maxCocPixels);
    return Math.min(limit, Math.max(-limit, cocPixels));
}

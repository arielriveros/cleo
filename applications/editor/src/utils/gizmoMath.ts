import { vec3, quat, mat4 } from 'gl-matrix';
import type { ReadonlyVec3, ReadonlyQuat, ReadonlyMat4 } from 'gl-matrix';
import type { GizmoMode } from '../features/engineContextTypes';

/**
 * Pure geometry for the transform gizmo — no React, no engine scene, gl-matrix only.
 *
 * The gizmo used to move things by a pixel heuristic (`screenDelta * 0.01`), which meant the handle never
 * kept up with the cursor and vertical translation ignored the camera outright. Everything here exists so
 * the drag can instead be solved exactly: where the cursor ray actually meets the handle's axis, plane or
 * ring. Keeping it in its own dependency-free module is what lets it be unit-tested without a GL context.
 */

/** Which frame the gizmo's handles live in. */
export type GizmoSpace = 'local' | 'world';

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------------------------------
// Ray primitives
// ---------------------------------------------------------------------------------------------------

export interface AxisRayHit {
    /** Signed distance along `axisDir` from `axisOrigin` of the point closest to the ray. */
    s: number;
    /** Ray parameter of its closest point. */
    t: number;
    /** True when the axis is too near parallel to the ray for `s`/`t` to mean anything. */
    degenerate: boolean;
}

/**
 * Closest point on an infinite axis line to an infinite ray — the exact answer to "how far along this
 * handle is the cursor?".
 *
 * Both directions MUST be unit length; that is what collapses the usual closest-approach solution to the
 * two lines below (`a` and `c` are both 1). `denom` is the squared sine of the angle between the two
 * directions, so `minSin2` is a threshold on that angle: below it the lines are near parallel, the
 * solution runs off to infinity, and the caller must hold the last good value rather than jump. This is
 * not a rare case — it is exactly what happens when you sight down an axis, and under the 2D orthographic
 * camera every ray is parallel to world Z permanently.
 *
 * @param minSin2 Default 0.0025, i.e. about 2.9 degrees.
 */
export function closestPointOnAxisToRay(
    axisOrigin: ReadonlyVec3,
    axisDir: ReadonlyVec3,
    rayOrigin: ReadonlyVec3,
    rayDir: ReadonlyVec3,
    minSin2 = 0.0025,
): AxisRayHit {
    const w0x = axisOrigin[0] - rayOrigin[0];
    const w0y = axisOrigin[1] - rayOrigin[1];
    const w0z = axisOrigin[2] - rayOrigin[2];

    const b = axisDir[0] * rayDir[0] + axisDir[1] * rayDir[1] + axisDir[2] * rayDir[2];
    const d = axisDir[0] * w0x + axisDir[1] * w0y + axisDir[2] * w0z;
    const e = rayDir[0] * w0x + rayDir[1] * w0y + rayDir[2] * w0z;

    const denom = 1 - b * b;
    if (denom < minSin2) return { s: 0, t: 0, degenerate: true };

    return { s: (b * e - d) / denom, t: (e - b * d) / denom, degenerate: false };
}

export interface PlaneRayHit {
    t: number;
    point: vec3;
}

/**
 * Where a ray meets a plane, or null.
 *
 * `minCos` only guards against a division by zero — a caller that cares whether the plane is *usable*
 * (a plane seen edge-on gives a mathematically valid but wildly ill-conditioned answer) tests
 * {@link planeFacing} against a much larger threshold of its own.
 *
 * A hit behind the ray origin is rejected: with a perspective camera below the gizmo the rotation plane
 * genuinely does lie behind the cursor ray, and reporting that as a hit puts the handle on the wrong side.
 */
export function intersectRayPlane(
    rayOrigin: ReadonlyVec3,
    rayDir: ReadonlyVec3,
    planePoint: ReadonlyVec3,
    planeNormal: ReadonlyVec3,
    minCos = 1e-4,
): PlaneRayHit | null {
    const denom = planeNormal[0] * rayDir[0] + planeNormal[1] * rayDir[1] + planeNormal[2] * rayDir[2];
    if (Math.abs(denom) < minCos) return null;

    const num = planeNormal[0] * (planePoint[0] - rayOrigin[0])
        + planeNormal[1] * (planePoint[1] - rayOrigin[1])
        + planeNormal[2] * (planePoint[2] - rayOrigin[2]);
    const t = num / denom;
    if (t <= 0) return null;

    return { t, point: vec3.scaleAndAdd(vec3.create(), rayOrigin, rayDir, t) };
}

// ---------------------------------------------------------------------------------------------------
// Angles
// ---------------------------------------------------------------------------------------------------

/**
 * Angle of `v` measured in the orthonormal in-plane basis `(u, w)`, in (-pi, pi].
 *
 * With `w = cross(axis, u)` a positive result is a positive rotation about `axis` by the right-hand rule,
 * so the sign convention is fixed once by the basis rather than re-derived every frame.
 */
export function angleInBasis(u: ReadonlyVec3, w: ReadonlyVec3, v: ReadonlyVec3): number {
    const cu = v[0] * u[0] + v[1] * u[1] + v[2] * u[2];
    const cw = v[0] * w[0] + v[1] * w[1] + v[2] * w[2];
    return Math.atan2(cw, cu);
}

/** Wrap an angle to (-pi, pi]. Both +/-pi map to +pi, which is what pins the interval as half-open. */
export function wrapPi(a: number): number {
    let r = a - TAU * Math.round(a / TAU);
    if (r <= -Math.PI) r += TAU;
    return r;
}

/**
 * Continue a wrapped `sample` from `previous`, so a rotation drag accumulates past a full turn instead of
 * snapping back through zero. Exact as long as the frame-to-frame change stays under half a turn — true
 * at any frame rate a hand can beat.
 */
export function unwrapAngle(previous: number, sample: number): number {
    return previous + wrapPi(sample - previous);
}

// ---------------------------------------------------------------------------------------------------
// Screen-constant sizing
// ---------------------------------------------------------------------------------------------------

/** The camera facts {@link gizmoWorldScale} needs, so it can be called without an engine Camera. */
export interface GizmoCameraView {
    type: 'perspective' | 'orthographic';
    /** Vertical field of view in DEGREES. Perspective only. */
    fovDeg: number;
    /** Vertical frustum extents. Orthographic only. */
    top: number;
    bottom: number;
}

/**
 * World size the gizmo must be drawn at to cover a fixed fraction of the viewport, whatever the camera.
 *
 * Perspective uses view DEPTH, not the euclidean distance to the camera. The projected pixel length of a
 * segment perpendicular to the view axis is `l / (depth * tan(fov/2)) * (h/2)` — it depends on depth
 * alone. Euclidean distance is longer than depth by `1/cos(theta)`, so sizing by it makes the gizmo swell
 * by ~15% once the selection sits in the corner of a 60-degree viewport.
 *
 * Orthographic has no perspective divide, so apparent size comes from the vertical extent and nothing
 * else. Both paths clamp to `minScale`: a selection behind the camera would otherwise produce a zero or
 * negative scale and collapse the handles to a point that can never be grabbed again.
 */
export function gizmoWorldScale(
    cam: GizmoCameraView,
    viewMatrix: ReadonlyMat4,
    worldPos: ReadonlyVec3,
    screenFraction: number,
    minScale = 1e-3,
): number {
    if (cam.type === 'orthographic')
        return Math.max((cam.top - cam.bottom) * screenFraction, minScale);

    // Camera-space Z of the point; the camera looks down -Z, so depth is its negation.
    const zView = viewMatrix[2] * worldPos[0] + viewMatrix[6] * worldPos[1] + viewMatrix[10] * worldPos[2] + viewMatrix[14];
    const depth = -zView;
    return Math.max(depth * Math.tan((cam.fovDeg * Math.PI) / 360) * screenFraction, minScale);
}

// ---------------------------------------------------------------------------------------------------
// World -> parent-local
// ---------------------------------------------------------------------------------------------------

/**
 * The parent-local position `Node.setPosition` expects for a given world point.
 *
 * The gizmo solves in world space but every Node setter is parent-local; skipping this conversion is the
 * old bug where dragging a node under a rotated parent sent it somewhere other than along the axis you
 * grabbed. Pass `null` for a singular parent transform (a zero-scale ancestor) and the world point comes
 * back verbatim — wrong, but finite, where a NaN would poison the node's transform permanently.
 */
export function localPositionForWorld(parentWorldInverse: ReadonlyMat4 | null, world: ReadonlyVec3): vec3 {
    if (!parentWorldInverse) return vec3.clone(world as vec3);
    return vec3.transformMat4(vec3.create(), world, parentWorldInverse);
}

/**
 * The parent-local orientation `Node.setQuaternion` expects for a given world orientation.
 *
 * Exact under uniform ancestor scale. Under a NON-uniform one a rotated child is not representable as
 * TRS at all — it shears — so `worldQuaternion` is already a best-effort normalized decomposition and
 * this round trip inherits that approximation. Unity has the same limitation for the same reason.
 */
export function localQuaternionForWorld(parentWorldQuat: ReadonlyQuat, world: ReadonlyQuat): quat {
    const inv = quat.invert(quat.create(), parentWorldQuat);
    const out = quat.multiply(quat.create(), inv, world);
    return quat.normalize(out, out);
}

// ---------------------------------------------------------------------------------------------------
// Snapping
// ---------------------------------------------------------------------------------------------------

/** Nearest multiple of `step`. A non-positive step is identity, so "no snapping" needs no branch. */
export function snapValue(v: number, step: number): number {
    if (!(step > 0)) return v;
    return Math.round(v / step) * step;
}

/**
 * Snap a drag DELTA rather than an absolute coordinate.
 *
 * Absolute grid snapping has no meaning in local space — the axis is not world-aligned, so "a whole unit"
 * would land on a different lattice per node — and it would make the two spaces behave differently for
 * the same gesture. Delta snapping is identical in both.
 */
export function snapDelta(delta: number, step: number, enabled: boolean): number {
    return enabled ? snapValue(delta, step) : delta;
}

// ---------------------------------------------------------------------------------------------------
// Space policy
// ---------------------------------------------------------------------------------------------------

/**
 * The space a mode actually operates in, given the user's preference.
 *
 * Scale is always local: `Node.setScale` is parent-local, and scaling a rotated node along a WORLD axis
 * produces a shear, which no TRS transform can hold. The toolbar greys the toggle in scale mode for this
 * reason; the stored preference is left alone so it comes back when you switch to move or rotate.
 */
export function effectiveGizmoSpace(mode: GizmoMode, space: GizmoSpace): GizmoSpace {
    return mode === 'scale' ? 'local' : space;
}

// ---------------------------------------------------------------------------------------------------
// Plane handle orientation
// ---------------------------------------------------------------------------------------------------

/**
 * Which of the four quadrants a plane handle should sit in: the one facing the viewer, so the quad is
 * never hidden behind the object it belongs to.
 *
 * `toCamera` must be a direction, not a position — see {@link planeFacing} for how to build it.
 */
export function planeQuadrantSigns(
    a1: ReadonlyVec3,
    a2: ReadonlyVec3,
    toCamera: ReadonlyVec3,
): [1 | -1, 1 | -1] {
    const s1: 1 | -1 = vec3.dot(a1, toCamera) >= 0 ? 1 : -1;
    const s2: 1 | -1 = vec3.dot(a2, toCamera) >= 0 ? 1 : -1;
    return [s1, s2];
}

/**
 * How square-on a plane is to the viewer: 0 when edge-on, 1 when face-on.
 *
 * Both arguments must be unit. Build `toCamera` as `normalize(cameraPos - gizmoOrigin)` for a perspective
 * camera, and as the negated camera forward for an orthographic one — there all rays are parallel, so a
 * vector aimed at the camera position would be wrong everywhere but the centre of the screen.
 */
export function planeFacing(normal: ReadonlyVec3, toCamera: ReadonlyVec3): number {
    return Math.abs(vec3.dot(normal, toCamera));
}

/** Inverse of a node's world transform, or null when it is singular. Cache this once per drag. */
export function invertWorldTransform(worldTransform: ReadonlyMat4): mat4 | null {
    const out = mat4.create();
    return mat4.invert(out, worldTransform) ? out : null;
}

import { vec3, quat, mat4 } from 'gl-matrix';
import type { ReadonlyVec3, ReadonlyQuat, ReadonlyMat4 } from 'gl-matrix';
import { uiProjectToScreen } from 'cleo';
import type { GizmoMode } from '../engineContextTypes';
import {
    closestPointOnAxisToRay,
    intersectRayPlane,
    angleInBasis,
    unwrapAngle,
    localPositionForWorld,
    localQuaternionForWorld,
    snapDelta,
    snapValue,
    invertWorldTransform,
    type GizmoSpace,
} from '../../utils/gizmoMath';
import {
    HANDLE_LENGTH,
    RING_RADIUS,
    PLANE_AXES,
    axisIndexOf,
    isAxisId,
    isPlaneId,
    type HandleId,
    type GizmoFrame,
} from './gizmoPick';

/**
 * The transform-gizmo drag solver.
 *
 * Every drag is solved from where the cursor RAY actually meets the handle — the closest point on an
 * axis line, the intersection with a plane, the angle swept around a ring — rather than from a scaled
 * screen delta. That is what makes the handle stay under the cursor, makes the numeric readout mean
 * something, and makes a drag correct for a node nested under a rotated parent.
 *
 * Pure: no React, no scene graph. The caller supplies the node's transform as plain numbers and applies
 * the returned patch.
 */

// ---------------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------------

/** Ctrl-held snap steps. */
export const TRANSLATE_STEP = 1;
export const ROTATE_STEP_DEG = 15;
export const SCALE_STEP = 0.1;
/** Scale never reaches zero: a zero-scale node has a singular transform and can never be recovered. */
export const MIN_SCALE = 1e-3;

/**
 * How square-on a rotation plane must be to the cursor ray for the exact solve to be well conditioned.
 * Below this the ring is nearly edge-on, the intersection runs away, and the screen-tangent fallback
 * takes over instead.
 */
export const ROTATE_PLANE_MIN_FACING = 0.15;

/** Half-length of the dashed axis guide drawn during a translate drag, in gizmo scales. */
const GUIDE_REACH = 40;
/** Arc resolution: one segment per this many radians, within the bounds below. */
const ARC_SEGMENT_RADIANS = Math.PI / 32;
const ARC_MIN_SAMPLES = 2;
const ARC_MAX_SAMPLES = 256;

// ---------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------

export type TransformPatch =
    | { kind: 'position'; local: vec3 }
    | { kind: 'rotation'; localQuat: quat }
    | { kind: 'scale'; local: vec3 };

export type GizmoOverlayColor = 'x' | 'y' | 'z' | 'neutral' | 'muted';

export interface GizmoOverlayLine {
    /** World-space polyline. The overlay projects these and splits the line at the camera plane. */
    points: vec3[];
    color: GizmoOverlayColor;
    dashed?: boolean;
}

export interface GizmoOverlayLabel {
    /** World point the label is anchored to. */
    at: vec3;
    text: string;
    color: GizmoOverlayColor;
}

/** What to draw over the viewport for the drag in progress. World space; projection happens in the DOM layer. */
export interface GizmoOverlayModel {
    lines: GizmoOverlayLine[];
    labels: GizmoOverlayLabel[];
}

/** The selected node's transform, read once at the start of a drag. */
export interface DragTarget {
    worldPosition: ReadonlyVec3;
    worldQuaternion: ReadonlyQuat;
    localPosition: ReadonlyVec3;
    localScale: ReadonlyVec3;
    /** The parent's world transform, or null when the parent is the scene root (identity). */
    parentWorldTransform: ReadonlyMat4 | null;
    parentWorldQuaternion: ReadonlyQuat;
}

/** Per-frame view facts the solver needs beyond the cursor ray. */
export interface DragViewContext {
    /** `projection * view`. */
    viewProj: ReadonlyMat4;
    viewportWidth: number;
    viewportHeight: number;
    /** Cursor in CSS pixels, Y down — the same space `Raycaster.screenToRay` consumes. */
    cursor: { x: number; y: number };
    /** Cursor movement since the previous solve, CSS pixels. */
    cursorDelta: { x: number; y: number };
}

/**
 * Everything a drag needs, captured at mousedown and then held still.
 *
 * The freezing is not an optimisation. If the gizmo's scale tracked the camera mid-drag the handle
 * length would change under the cursor and every scale factor would drift; if the frame axes tracked the
 * node, a local-space rotation ring would spin out from under the hand that was turning it.
 */
export interface DragSession {
    handle: HandleId;
    mode: GizmoMode;
    /** Already resolved through `effectiveGizmoSpace` — scale is always local by the time it gets here. */
    space: GizmoSpace;
    gizmoScale: number;
    origin: vec3;
    axes: [vec3, vec3, vec3];
    startWorldQuat: quat;
    startLocalPos: vec3;
    startLocalScale: vec3;
    parentWorldInverse: mat4 | null;
    parentWorldQuat: quat;
    /** Axis/scale drags: where along the axis the grabbing ray met it. */
    grabS: number;
    /** Plane and screen drags: the world point grabbed. */
    grabPoint: vec3;
    /** Rotation: the in-plane orthonormal basis the swept angle is measured in. */
    grabBasisU: vec3;
    grabBasisW: vec3;
    /** Uniform scale: cursor distance in pixels from the projected origin at grab time. */
    grabScreenRadius: number;
    /** Rotation only, unwrapped so a multi-turn spin keeps counting. */
    accumulatedAngle: number;
    /** Held so a frame whose solve is degenerate leaves the node where it was instead of jumping. */
    lastValid: TransformPatch;
}

export interface DragResult {
    patch: TransformPatch;
    overlay: GizmoOverlayModel;
    /** True when the handle is edge-on or parallel to the view and the drag cannot be solved this frame. */
    degenerate: boolean;
}

// ---------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------

const v3 = (a: ReadonlyVec3) => vec3.clone(a as vec3);

/** Colour for the axis a handle acts on; plane and centre handles are neutral. */
export function handleColor(id: HandleId): GizmoOverlayColor {
    if (isAxisId(id)) return id;
    return 'neutral';
}

/** Any unit vector perpendicular to `n` — a stable starting angle when the real grab direction is unusable. */
function anyPerpendicular(n: ReadonlyVec3): vec3 {
    const seed: ReadonlyVec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const out = vec3.cross(vec3.create(), n, seed);
    return vec3.normalize(out, out);
}

/** Signed distance display, always carrying its sign so a readout never reads as an absolute coordinate. */
export function formatUnits(v: number): string {
    const s = v.toFixed(2);
    return v >= 0 && !s.startsWith('-') ? `+${s}` : s;
}

/** Accumulated degrees — may pass 360, which is the point of unwrapping. */
export function formatDegrees(v: number): string {
    const s = v.toFixed(1);
    return `${v >= 0 && !s.startsWith('-') ? '+' : ''}${s}°`;
}

export function formatFactor(v: number): string {
    return `×${v.toFixed(2)}`;
}

// ---------------------------------------------------------------------------------------------------
// Session construction
// ---------------------------------------------------------------------------------------------------

/**
 * Capture a drag.
 *
 * `grabS` is where the MOUSEDOWN ray met the axis, not the handle's centre, which is what makes the
 * handle stick exactly where it was grabbed instead of snapping to the cursor on the first move.
 */
export function beginDrag(
    handle: HandleId,
    mode: GizmoMode,
    space: GizmoSpace,
    frame: GizmoFrame,
    target: DragTarget,
    rayOrigin: ReadonlyVec3,
    rayDir: ReadonlyVec3,
    view: DragViewContext,
): DragSession {
    const origin = v3(target.worldPosition);
    const axes: [vec3, vec3, vec3] = [v3(frame.axes[0]), v3(frame.axes[1]), v3(frame.axes[2])];

    const session: DragSession = {
        handle,
        mode,
        space,
        gizmoScale: frame.scale,
        origin,
        axes,
        startWorldQuat: quat.clone(target.worldQuaternion as quat),
        startLocalPos: v3(target.localPosition),
        startLocalScale: v3(target.localScale),
        parentWorldInverse: target.parentWorldTransform ? invertWorldTransform(target.parentWorldTransform) : null,
        parentWorldQuat: quat.clone(target.parentWorldQuaternion as quat),
        grabS: 0,
        grabPoint: v3(origin),
        grabBasisU: vec3.fromValues(1, 0, 0),
        grabBasisW: vec3.fromValues(0, 0, 1),
        grabScreenRadius: 0,
        accumulatedAngle: 0,
        lastValid: { kind: 'position', local: v3(target.localPosition) },
    };

    if (mode === 'rotation') {
        const n = axes[axisIndexOf(handle as 'x' | 'y' | 'z')] ?? axes[0];
        const hit = intersectRayPlane(rayOrigin, rayDir, origin, n);
        const radial = hit ? vec3.subtract(vec3.create(), hit.point, origin) : null;
        // Strip any out-of-plane component before normalising, so the basis is exactly in the ring's plane.
        if (radial) vec3.scaleAndAdd(radial, radial, n, -vec3.dot(radial, n));
        session.grabBasisU = radial && vec3.length(radial) > 1e-6
            ? vec3.normalize(radial, radial)
            : anyPerpendicular(n);
        session.grabBasisW = vec3.cross(vec3.create(), n, session.grabBasisU);
        session.lastValid = { kind: 'rotation', localQuat: quat.clone(session.startWorldQuat) };
        if (target.parentWorldTransform)
            session.lastValid = { kind: 'rotation', localQuat: localQuaternionForWorld(session.parentWorldQuat, session.startWorldQuat) };
        return session;
    }

    if (mode === 'scale') session.lastValid = { kind: 'scale', local: v3(target.localScale) };

    if (isAxisId(handle)) {
        const axis = axes[axisIndexOf(handle)];
        const hit = closestPointOnAxisToRay(origin, axis, rayOrigin, rayDir);
        session.grabS = hit.degenerate ? 0 : hit.s;
    } else if (isPlaneId(handle)) {
        const [i1, i2] = PLANE_AXES[handle];
        const n = vec3.cross(vec3.create(), axes[i1], axes[i2]);
        vec3.normalize(n, n);
        const hit = intersectRayPlane(rayOrigin, rayDir, origin, n);
        if (hit) session.grabPoint = hit.point;
    } else {
        // Centre handle. Move drags it in the plane facing the camera; uniform scale reads screen radius.
        const n = vec3.negate(vec3.create(), rayDir);
        const hit = intersectRayPlane(rayOrigin, rayDir, origin, n);
        if (hit) session.grabPoint = hit.point;
        session.grabScreenRadius = screenRadius(session, view);
    }

    return session;
}

/** Cursor distance in pixels from the gizmo origin's projected position. */
function screenRadius(session: DragSession, view: DragViewContext): number {
    const p = uiProjectToScreen(view.viewProj, session.origin, view.viewportWidth, view.viewportHeight);
    if (!p.inFront) return 0;
    return Math.hypot(view.cursor.x - p.x, view.cursor.y - p.y);
}

// ---------------------------------------------------------------------------------------------------
// Rotation branches
// ---------------------------------------------------------------------------------------------------

/** The world point on the drag's ring at a given swept angle. */
export function ringPointAt(session: DragSession, angle: number): vec3 {
    const r = RING_RADIUS * session.gizmoScale;
    const out = v3(session.origin);
    vec3.scaleAndAdd(out, out, session.grabBasisU, Math.cos(angle) * r);
    vec3.scaleAndAdd(out, out, session.grabBasisW, Math.sin(angle) * r);
    return out;
}

/**
 * Swept angle read straight off the ray's intersection with the ring's plane. Exact, and the branch used
 * whenever the plane is square enough to the ray to be well conditioned.
 */
export function rotateAngleFromPlane(
    session: DragSession,
    rayOrigin: ReadonlyVec3,
    rayDir: ReadonlyVec3,
): number | null {
    const n = session.axes[axisIndexOf(session.handle as 'x' | 'y' | 'z')];
    const hit = intersectRayPlane(rayOrigin, rayDir, session.origin, n);
    if (!hit) return null;

    const radial = vec3.subtract(vec3.create(), hit.point, session.origin);
    if (vec3.length(radial) < 1e-6) return null;

    return unwrapAngle(session.accumulatedAngle, angleInBasis(session.grabBasisU, session.grabBasisW, radial));
}

/**
 * Swept angle from cursor motion projected onto the ring's own path across the screen — the fallback for
 * a ring seen nearly edge-on, where the plane intersection runs off to infinity.
 *
 * The screen tangent is measured numerically (project the ring point at the current angle and a hair
 * beyond it) rather than derived from a hand-worked sign. That costs one extra projection and buys two
 * things: it is correct for any camera without a handedness argument, and it agrees with the plane branch
 * in the limit, so crossing the threshold mid-drag produces no jump.
 */
export function rotateAngleFromScreen(session: DragSession, view: DragViewContext): number | null {
    const eps = 1e-3;
    const a = uiProjectToScreen(view.viewProj, ringPointAt(session, session.accumulatedAngle), view.viewportWidth, view.viewportHeight);
    const b = uiProjectToScreen(view.viewProj, ringPointAt(session, session.accumulatedAngle + eps), view.viewportWidth, view.viewportHeight);
    if (!a.inFront || !b.inFront) return null;

    // Pixels swept per radian, as a screen vector.
    const dx = (b.x - a.x) / eps;
    const dy = (b.y - a.y) / eps;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-9) return null;

    return session.accumulatedAngle + (view.cursorDelta.x * dx + view.cursorDelta.y * dy) / len2;
}

// ---------------------------------------------------------------------------------------------------
// The solver
// ---------------------------------------------------------------------------------------------------

/**
 * Advance a drag by one cursor sample.
 *
 * Mutates only `accumulatedAngle` and `lastValid` on the session; everything else was frozen at grab.
 */
export function solveDrag(
    session: DragSession,
    rayOrigin: ReadonlyVec3,
    rayDir: ReadonlyVec3,
    view: DragViewContext,
    snap: boolean,
): DragResult {
    const held = (): DragResult => ({ patch: session.lastValid, overlay: { lines: [], labels: [] }, degenerate: true });

    if (session.mode === 'rotation') return solveRotate(session, rayOrigin, rayDir, view, snap, held);
    if (session.mode === 'scale') return solveScale(session, rayOrigin, rayDir, view, snap, held);
    return solveTranslate(session, rayOrigin, rayDir, snap, held);
}

function accept(session: DragSession, patch: TransformPatch, overlay: GizmoOverlayModel): DragResult {
    session.lastValid = patch;
    return { patch, overlay, degenerate: false };
}

// --- translate -------------------------------------------------------------------------------------

function solveTranslate(
    session: DragSession,
    rayOrigin: ReadonlyVec3,
    rayDir: ReadonlyVec3,
    snap: boolean,
    held: () => DragResult,
): DragResult {
    const s = session.gizmoScale;

    if (isAxisId(session.handle)) {
        const i = axisIndexOf(session.handle);
        const axis = session.axes[i];
        const hit = closestPointOnAxisToRay(session.origin, axis, rayOrigin, rayDir);
        if (hit.degenerate) return held();

        const d = snapDelta(hit.s - session.grabS, TRANSLATE_STEP, snap);
        const world = vec3.scaleAndAdd(vec3.create(), session.origin, axis, d);

        const guide = [
            vec3.scaleAndAdd(vec3.create(), session.origin, axis, -GUIDE_REACH * s),
            vec3.scaleAndAdd(vec3.create(), session.origin, axis, GUIDE_REACH * s),
        ];
        const midpoint = vec3.lerp(vec3.create(), session.origin, world, 0.5);
        const overlay: GizmoOverlayModel = {
            lines: [
                { points: guide, color: handleColor(session.handle), dashed: true },
                { points: [v3(session.origin), v3(world)], color: handleColor(session.handle) },
            ],
            labels: [{ at: midpoint, text: `${session.handle.toUpperCase()} ${formatUnits(d)}`, color: handleColor(session.handle) }],
        };
        return accept(session, { kind: 'position', local: localPositionForWorld(session.parentWorldInverse, world) }, overlay);
    }

    if (isPlaneId(session.handle)) {
        const [i1, i2] = PLANE_AXES[session.handle];
        const a1 = session.axes[i1];
        const a2 = session.axes[i2];
        const n = vec3.cross(vec3.create(), a1, a2);
        vec3.normalize(n, n);

        const hit = intersectRayPlane(rayOrigin, rayDir, session.origin, n);
        if (!hit) return held();

        const raw = vec3.subtract(vec3.create(), hit.point, session.grabPoint);
        const d1 = snapDelta(vec3.dot(raw, a1), TRANSLATE_STEP, snap);
        const d2 = snapDelta(vec3.dot(raw, a2), TRANSLATE_STEP, snap);

        const world = v3(session.origin);
        vec3.scaleAndAdd(world, world, a1, d1);
        vec3.scaleAndAdd(world, world, a2, d2);
        const corner = vec3.scaleAndAdd(vec3.create(), session.origin, a1, d1);

        const c1 = handleColor(session.handle === 'xy' ? 'x' : session.handle === 'yz' ? 'y' : 'z');
        const c2 = handleColor(session.handle === 'xy' ? 'y' : session.handle === 'yz' ? 'z' : 'x');
        const overlay: GizmoOverlayModel = {
            lines: [
                { points: [v3(session.origin), corner], color: c1, dashed: true },
                { points: [v3(corner), v3(world)], color: c2, dashed: true },
                { points: [v3(session.origin), v3(world)], color: 'neutral' },
            ],
            labels: [
                { at: vec3.lerp(vec3.create(), session.origin, corner, 0.5), text: formatUnits(d1), color: c1 },
                { at: vec3.lerp(vec3.create(), corner, world, 0.5), text: formatUnits(d2), color: c2 },
            ],
        };
        return accept(session, { kind: 'position', local: localPositionForWorld(session.parentWorldInverse, world) }, overlay);
    }

    // Centre handle: drag in the plane facing the camera. Snapping is meaningless here — the plane is not
    // aligned to anything the user can reason about — so it is deliberately not applied.
    const n = vec3.negate(vec3.create(), rayDir);
    const hit = intersectRayPlane(rayOrigin, rayDir, session.origin, n);
    if (!hit) return held();

    const delta = vec3.subtract(vec3.create(), hit.point, session.grabPoint);
    const world = vec3.add(vec3.create(), session.origin, delta);
    const overlay: GizmoOverlayModel = {
        lines: [{ points: [v3(session.origin), v3(world)], color: 'neutral' }],
        labels: [{
            at: vec3.lerp(vec3.create(), session.origin, world, 0.5),
            text: `${formatUnits(delta[0])} ${formatUnits(delta[1])} ${formatUnits(delta[2])}`,
            color: 'neutral',
        }],
    };
    return accept(session, { kind: 'position', local: localPositionForWorld(session.parentWorldInverse, world) }, overlay);
}

// --- rotate ----------------------------------------------------------------------------------------

function solveRotate(
    session: DragSession,
    rayOrigin: ReadonlyVec3,
    rayDir: ReadonlyVec3,
    view: DragViewContext,
    snap: boolean,
    held: () => DragResult,
): DragResult {
    const n = session.axes[axisIndexOf(session.handle as 'x' | 'y' | 'z')];
    const facing = Math.abs(vec3.dot(n, rayDir));

    const next = facing > ROTATE_PLANE_MIN_FACING
        ? rotateAngleFromPlane(session, rayOrigin, rayDir)
        : rotateAngleFromScreen(session, view);
    if (next === null) return held();
    session.accumulatedAngle = next;

    const deg = snap
        ? snapValue((next * 180) / Math.PI, ROTATE_STEP_DEG)
        : (next * 180) / Math.PI;
    const angle = (deg * Math.PI) / 180;

    const worldQuat = quat.multiply(quat.create(), quat.setAxisAngle(quat.create(), n, angle), session.startWorldQuat);
    quat.normalize(worldQuat, worldQuat);

    return accept(
        session,
        { kind: 'rotation', localQuat: localQuaternionForWorld(session.parentWorldQuat, worldQuat) },
        buildRotateOverlay(session, angle, deg),
    );
}

/**
 * Arc, radial markers and a degrees label for a rotation drag.
 *
 * The arc is a projected POLYLINE, not an SVG arc: an ellipse fitted in screen space is only right for an
 * orthographic camera, and the whole point of the readout is to sit on the ring you are actually turning.
 */
export function buildRotateOverlay(session: DragSession, angle: number, degrees: number): GizmoOverlayModel {
    const samples = Math.min(ARC_MAX_SAMPLES, Math.max(ARC_MIN_SAMPLES, Math.ceil(Math.abs(angle) / ARC_SEGMENT_RADIANS) + 1));
    const points: vec3[] = [];
    for (let i = 0; i < samples; i++) points.push(ringPointAt(session, (angle * i) / (samples - 1)));

    const start = ringPointAt(session, 0);
    const end = ringPointAt(session, angle);
    const color = handleColor(session.handle);

    return {
        lines: [
            { points, color },
            { points: [v3(session.origin), start], color: 'muted', dashed: true },
            { points: [v3(session.origin), end], color },
        ],
        labels: [{ at: ringPointAt(session, angle / 2), text: `${session.handle.toUpperCase()} ${formatDegrees(degrees)}`, color }],
    };
}

// --- scale -----------------------------------------------------------------------------------------

function solveScale(
    session: DragSession,
    rayOrigin: ReadonlyVec3,
    rayDir: ReadonlyVec3,
    view: DragViewContext,
    snap: boolean,
    held: () => DragResult,
): DragResult {
    const length = HANDLE_LENGTH * session.gizmoScale;
    const local = v3(session.startLocalScale);
    let factor: number;
    const touched: number[] = [];

    if (isAxisId(session.handle)) {
        const i = axisIndexOf(session.handle);
        const hit = closestPointOnAxisToRay(session.origin, session.axes[i], rayOrigin, rayDir);
        if (hit.degenerate) return held();
        // Linear in the handle's own length — drag out one handle length and the node doubles. The ratio
        // `s / grabS` would be the obvious alternative and is unusable: it diverges near the origin.
        factor = 1 + (hit.s - session.grabS) / length;
        touched.push(i);
    } else if (isPlaneId(session.handle)) {
        const [i1, i2] = PLANE_AXES[session.handle];
        const n = vec3.cross(vec3.create(), session.axes[i1], session.axes[i2]);
        vec3.normalize(n, n);
        const hit = intersectRayPlane(rayOrigin, rayDir, session.origin, n);
        if (!hit) return held();

        const grabRadial = vec3.subtract(vec3.create(), session.grabPoint, session.origin);
        const nowRadial = vec3.subtract(vec3.create(), hit.point, session.origin);
        const grabLen = vec3.length(grabRadial);
        if (grabLen < 1e-6) return held();
        vec3.scale(grabRadial, grabRadial, 1 / grabLen);
        factor = 1 + (vec3.dot(nowRadial, grabRadial) - grabLen) / length;
        touched.push(i1, i2);
    } else {
        const radius = screenRadius(session, view);
        const reference = Math.max(session.grabScreenRadius, 1);
        factor = 1 + (radius - session.grabScreenRadius) / reference;
        touched.push(0, 1, 2);
    }

    if (snap) factor = snapValue(factor, SCALE_STEP);
    for (const i of touched) local[i] = Math.max(MIN_SCALE, session.startLocalScale[i] * factor);

    return accept(session, { kind: 'scale', local }, buildScaleOverlay(session, factor, touched));
}

/** Muted segment where the handle started, coloured segment where it is now, and the factor. */
export function buildScaleOverlay(session: DragSession, factor: number, touched: number[]): GizmoOverlayModel {
    const length = HANDLE_LENGTH * session.gizmoScale;
    const lines: GizmoOverlayLine[] = [];

    for (const i of touched) {
        const axis = session.axes[i];
        lines.push({ points: [v3(session.origin), vec3.scaleAndAdd(vec3.create(), session.origin, axis, length)], color: 'muted', dashed: true });
        lines.push({
            points: [v3(session.origin), vec3.scaleAndAdd(vec3.create(), session.origin, axis, length * Math.max(factor, MIN_SCALE))],
            color: handleColor((['x', 'y', 'z'] as const)[i]),
        });
    }

    const tip = vec3.scaleAndAdd(vec3.create(), session.origin, session.axes[touched[0]], length * Math.max(factor, MIN_SCALE));
    return { lines, labels: [{ at: tip, text: formatFactor(factor), color: 'neutral' }] };
}

/** Convenience for tests and callers that want the frame's world axes for a given space. */
export function frameAxes(space: GizmoSpace, worldQuat: ReadonlyQuat): [vec3, vec3, vec3] {
    if (space === 'world')
        return [vec3.fromValues(1, 0, 0), vec3.fromValues(0, 1, 0), vec3.fromValues(0, 0, 1)];

    const m = mat4.fromQuat(mat4.create(), worldQuat);
    const axis = (i: number) => vec3.normalize(vec3.create(), vec3.fromValues(m[i * 4], m[i * 4 + 1], m[i * 4 + 2]));
    return [axis(0), axis(1), axis(2)];
}

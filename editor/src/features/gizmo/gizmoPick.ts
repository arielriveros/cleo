import { vec3 } from 'gl-matrix';
import type { ReadonlyVec3 } from 'gl-matrix';
import { planeQuadrantSigns, planeFacing } from '../../utils/gizmoMath';
import type { GizmoMode } from '../engineContextTypes';

/**
 * Analytic picking for the transform gizmo's handles.
 *
 * The gizmo used to pick through `Raycaster.raycast(..., precise=false)`, which tests bounding boxes
 * only. That is why clicking the empty middle of a rotation ring grabbed the ring, and it has no way to
 * express "the plane quad wins over the axis running through it". Both problems go away by testing the
 * handle's real shape here — it is a few dozen lines, exact, and unit-testable with no GL context.
 */

/** Every draggable part of the gizmo. `screen` is the centre handle (uniform scale / screen-space move). */
export type HandleId = 'x' | 'y' | 'z' | 'xy' | 'yz' | 'zx' | 'screen';

/** The three axis handles, in the order their world axis index runs. */
export const AXIS_IDS = ['x', 'y', 'z'] as const;
/** The three plane handles, paired with the two axis indices they span and the axis index they exclude. */
export const PLANE_IDS = ['xy', 'yz', 'zx'] as const;

export type AxisId = (typeof AXIS_IDS)[number];
export type PlaneId = (typeof PLANE_IDS)[number];

/** Axis indices spanned by each plane handle; the missing index is the plane's normal. */
export const PLANE_AXES: Record<PlaneId, [number, number]> = { xy: [0, 1], yz: [1, 2], zx: [2, 0] };

export const isAxisId = (id: HandleId): id is AxisId => id === 'x' || id === 'y' || id === 'z';
export const isPlaneId = (id: HandleId): id is PlaneId => id === 'xy' || id === 'yz' || id === 'zx';

/** Axis index (0/1/2) of an axis handle. */
export const axisIndexOf = (id: AxisId): number => (id === 'x' ? 0 : id === 'y' ? 1 : 2);

// ---------------------------------------------------------------------------------------------------
// Handle proportions
//
// All in multiples of the gizmo's world scale S, which is itself screen-constant — so these are
// effectively pixel constants and need no per-frame conversion.
// ---------------------------------------------------------------------------------------------------

/** Length of an axis handle from the gizmo origin. */
export const HANDLE_LENGTH = 1;
/**
 * Where an axis handle becomes GRABBABLE. Deliberately outside the centre handle and inside the plane
 * quads' inner edge: the geometric separation, not the priority table below, is what stops an axis from
 * stealing a click aimed at a plane or the centre. Priority alone would make the axes feel unreachable
 * near the origin; separation alone would still leave the quads' outer corners ambiguous.
 */
export const AXIS_PICK_START = 0.3;
export const AXIS_PICK_RADIUS = 0.05;
/** Plane quads: half-extent, and how far along each of their two axes the quad centre sits. */
export const PLANE_HALF = 0.18;
export const PLANE_OFFSET = 0.55;
export const CENTRE_RADIUS = 0.14;
/** Rotation rings sit at the axis handles' full length; the band is the pickable thickness. */
export const RING_RADIUS = 1;
export const RING_TOLERANCE = 0.06;

/**
 * A plane quad seen closer to edge-on than this is a sliver on screen, and dragging in it is badly
 * conditioned. Such a quad is hidden AND unpickable — see `planeFacing` in `utils/gizmoMath`.
 */
export const PLANE_MIN_FACING = 0.2;

// ---------------------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------------------

export interface SegmentShape {
    kind: 'segment';
    a: ReadonlyVec3;
    b: ReadonlyVec3;
    radius: number;
}

export interface QuadShape {
    kind: 'quad';
    centre: ReadonlyVec3;
    /** In-plane unit axes. */
    u: ReadonlyVec3;
    w: ReadonlyVec3;
    halfU: number;
    halfW: number;
}

export interface RingShape {
    kind: 'ring';
    centre: ReadonlyVec3;
    /** Unit normal of the ring's plane. */
    normal: ReadonlyVec3;
    radius: number;
    tolerance: number;
    /**
     * When set, a hit on the half of the ring facing away from the viewer is rejected, so the near rim
     * cannot be reached through the far one. Unit, pointing from the gizmo toward the camera.
     */
    toCamera?: ReadonlyVec3;
}

export interface SphereShape {
    kind: 'sphere';
    centre: ReadonlyVec3;
    radius: number;
}

export type PickGeometry = SegmentShape | QuadShape | RingShape | SphereShape;

export type PickShape = PickGeometry & {
    id: HandleId;
    /** Higher wins regardless of depth. Centre 3, planes 2, axes and rings 1. */
    priority: number;
};

export interface PickResult {
    id: HandleId;
    /** Ray parameter of the hit — the caller uses it for nothing but ordering. */
    t: number;
}

// ---------------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------------

export interface SegmentRayHit {
    /** Distance between the two closest points. */
    distance: number;
    /** Ray parameter at closest approach. */
    t: number;
    /** Position along the segment, 0 at `a` and 1 at `b`, clamped to the segment. */
    sOnSegment: number;
}

/**
 * Closest approach between a ray and a finite segment.
 *
 * Unlike the infinite-line solve in `gizmoMath`, the segment parameter is CLAMPED, which is what turns
 * the axis handle into a capsule: past either end the nearest point is the cap, not a phantom extension.
 */
export function raySegmentDistance(
    rayOrigin: ReadonlyVec3,
    rayDir: ReadonlyVec3,
    a: ReadonlyVec3,
    b: ReadonlyVec3,
): SegmentRayHit {
    const ab = vec3.subtract(vec3.create(), b, a);
    const len2 = vec3.squaredLength(ab);
    if (len2 < 1e-12) {
        const d = vec3.subtract(vec3.create(), a, rayOrigin);
        const t = Math.max(0, vec3.dot(d, rayDir));
        const p = vec3.scaleAndAdd(vec3.create(), rayOrigin, rayDir, t);
        return { distance: vec3.distance(p, a), t, sOnSegment: 0 };
    }

    // Solve the unclamped closest approach, clamp the segment parameter, then re-solve the ray against
    // the clamped point. One clamp-and-resolve is exact for a ray-vs-segment pair.
    const w0 = vec3.subtract(vec3.create(), a, rayOrigin);
    const len = Math.sqrt(len2);
    const dir = vec3.scale(vec3.create(), ab, 1 / len);

    const bDot = vec3.dot(dir, rayDir);
    const d = vec3.dot(dir, w0);
    const e = vec3.dot(rayDir, w0);
    const denom = 1 - bDot * bDot;

    let sAlong = denom < 1e-9 ? 0 : (bDot * e - d) / denom;
    sAlong = Math.min(Math.max(sAlong, 0), len);

    const onSeg = vec3.scaleAndAdd(vec3.create(), a, dir, sAlong);
    const toSeg = vec3.subtract(vec3.create(), onSeg, rayOrigin);
    const t = Math.max(0, vec3.dot(toSeg, rayDir));
    const onRay = vec3.scaleAndAdd(vec3.create(), rayOrigin, rayDir, t);

    return { distance: vec3.distance(onRay, onSeg), t, sOnSegment: sAlong / len };
}

/** Ray parameter where a ray enters an axis-aligned-in-its-own-basis quad, or null. */
export function rayQuad(
    rayOrigin: ReadonlyVec3,
    rayDir: ReadonlyVec3,
    centre: ReadonlyVec3,
    u: ReadonlyVec3,
    w: ReadonlyVec3,
    halfU: number,
    halfW: number,
): number | null {
    const normal = vec3.cross(vec3.create(), u, w);
    vec3.normalize(normal, normal);

    const denom = vec3.dot(normal, rayDir);
    if (Math.abs(denom) < 1e-6) return null;

    const toCentre = vec3.subtract(vec3.create(), centre, rayOrigin);
    const t = vec3.dot(normal, toCentre) / denom;
    if (t <= 0) return null;

    const hit = vec3.scaleAndAdd(vec3.create(), rayOrigin, rayDir, t);
    const rel = vec3.subtract(hit, hit, centre);
    if (Math.abs(vec3.dot(rel, u)) > halfU) return null;
    if (Math.abs(vec3.dot(rel, w)) > halfW) return null;
    return t;
}

/**
 * Ray parameter where a ray crosses the band of a ring, or null.
 *
 * Tests the ring's own plane and then the radial distance, so the ring's empty middle misses — the
 * bounding-box picker it replaces treated the whole disc, hole included, as the handle.
 */
export function rayRingBand(
    rayOrigin: ReadonlyVec3,
    rayDir: ReadonlyVec3,
    centre: ReadonlyVec3,
    normal: ReadonlyVec3,
    radius: number,
    tolerance: number,
    toCamera?: ReadonlyVec3,
): number | null {
    const denom = vec3.dot(normal, rayDir);
    if (Math.abs(denom) < 1e-6) return null;

    const toCentre = vec3.subtract(vec3.create(), centre, rayOrigin);
    const t = vec3.dot(normal, toCentre) / denom;
    if (t <= 0) return null;

    const hit = vec3.scaleAndAdd(vec3.create(), rayOrigin, rayDir, t);
    const rel = vec3.subtract(vec3.create(), hit, centre);
    if (Math.abs(vec3.length(rel) - radius) > tolerance) return null;

    // The far half of the ring is drawn but not grabbable: reaching it would mean clicking "through" the
    // near half, which never matches what the user was aiming at.
    if (toCamera && vec3.dot(rel, toCamera) < 0) return null;

    return t;
}

/** Ray parameter of the nearer sphere intersection, or null. */
export function raySphere(
    rayOrigin: ReadonlyVec3,
    rayDir: ReadonlyVec3,
    centre: ReadonlyVec3,
    radius: number,
): number | null {
    const m = vec3.subtract(vec3.create(), rayOrigin, centre);
    const b = vec3.dot(m, rayDir);
    const c = vec3.squaredLength(m) - radius * radius;
    if (c > 0 && b > 0) return null;

    const disc = b * b - c;
    if (disc < 0) return null;

    const t = -b - Math.sqrt(disc);
    return t >= 0 ? t : null;
}

// ---------------------------------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------------------------------

/** Ray parameter at which `shape` is hit, or null. */
export function rayShape(rayOrigin: ReadonlyVec3, rayDir: ReadonlyVec3, shape: PickGeometry): number | null {
    switch (shape.kind) {
        case 'segment': {
            const hit = raySegmentDistance(rayOrigin, rayDir, shape.a, shape.b);
            return hit.distance <= shape.radius ? hit.t : null;
        }
        case 'quad':
            return rayQuad(rayOrigin, rayDir, shape.centre, shape.u, shape.w, shape.halfU, shape.halfW);
        case 'ring':
            return rayRingBand(rayOrigin, rayDir, shape.centre, shape.normal, shape.radius, shape.tolerance, shape.toCamera);
        case 'sphere':
            return raySphere(rayOrigin, rayDir, shape.centre, shape.radius);
    }
}

/**
 * The handle a cursor ray grabs, or null.
 *
 * Priority beats depth, deliberately: the centre and plane handles sit visually in front of the axes for
 * a user aiming at them, but a ray can still clip an axis capsule first. Among equal priorities the
 * nearer hit wins, which is the normal depth rule.
 */
export function pickHandle(
    rayOrigin: ReadonlyVec3,
    rayDir: ReadonlyVec3,
    shapes: PickShape[],
): PickResult | null {
    let best: PickResult | null = null;
    let bestPriority = -Infinity;

    for (const shape of shapes) {
        const t = rayShape(rayOrigin, rayDir, shape);
        if (t === null) continue;
        if (shape.priority < bestPriority) continue;
        if (shape.priority === bestPriority && best && t >= best.t) continue;
        best = { id: shape.id, t };
        bestPriority = shape.priority;
    }

    return best;
}

// ---------------------------------------------------------------------------------------------------
// Shape sets
// ---------------------------------------------------------------------------------------------------

/** Where the gizmo sits and which way its handles point, in world space. */
export interface GizmoFrame {
    origin: ReadonlyVec3;
    /** The three handle directions. World axes in world space, the node's own axes in local space. */
    axes: [ReadonlyVec3, ReadonlyVec3, ReadonlyVec3];
    /** Screen-constant world size of the whole gizmo (see `gizmoWorldScale`). */
    scale: number;
    /** Unit direction from the gizmo toward the viewer. Drives quadrant choice and ring back-half culling. */
    toCamera: ReadonlyVec3;
}

/** Resolved placement of one plane handle's quad, shared by the drawn node and the pickable shape. */
export interface PlaneQuad {
    normal: vec3;
    /** In-plane unit axes, already flipped into the camera-facing quadrant. */
    u: vec3;
    w: vec3;
    centre: vec3;
    half: number;
    /** 0 edge-on, 1 face-on. Below {@link PLANE_MIN_FACING} the handle is hidden and unpickable. */
    facing: number;
}

/**
 * Where a plane handle's quad sits for the current view.
 *
 * The quad is pushed into whichever of the four quadrants faces the viewer, so it is never behind the
 * object it belongs to — and the same call drives both the drawn node and the pick shape, so what you
 * click is always what you see.
 */
export function planeQuadGeometry(frame: GizmoFrame, id: PlaneId): PlaneQuad {
    const [i1, i2] = PLANE_AXES[id];
    const a1 = frame.axes[i1];
    const a2 = frame.axes[i2];

    const [s1, s2] = planeQuadrantSigns(a1, a2, frame.toCamera);
    const u = vec3.scale(vec3.create(), a1, s1);
    const w = vec3.scale(vec3.create(), a2, s2);

    const normal = vec3.cross(vec3.create(), a1, a2);
    vec3.normalize(normal, normal);

    const off = PLANE_OFFSET * frame.scale;
    const centre = vec3.clone(frame.origin as vec3);
    vec3.scaleAndAdd(centre, centre, u, off);
    vec3.scaleAndAdd(centre, centre, w, off);

    return { normal, u, w, centre, half: PLANE_HALF * frame.scale, facing: planeFacing(normal, frame.toCamera) };
}

/**
 * Every pickable shape for a mode, in world space.
 *
 * Rotation gets rings and nothing else; move and scale share the axis + plane + centre set, where the
 * centre means "screen-space move" and "uniform scale" respectively.
 */
export function buildPickShapes(mode: GizmoMode, frame: GizmoFrame): PickShape[] {
    const shapes: PickShape[] = [];
    const s = frame.scale;

    if (mode === 'rotation') {
        for (let i = 0; i < 3; i++) {
            shapes.push({
                kind: 'ring', id: AXIS_IDS[i], priority: 1,
                centre: frame.origin, normal: frame.axes[i],
                radius: RING_RADIUS * s, tolerance: RING_TOLERANCE * s,
                toCamera: frame.toCamera,
            });
        }
        return shapes;
    }

    shapes.push({
        kind: 'sphere', id: 'screen', priority: 3,
        centre: frame.origin, radius: CENTRE_RADIUS * s,
    });

    for (const id of PLANE_IDS) {
        const quad = planeQuadGeometry(frame, id);
        if (quad.facing < PLANE_MIN_FACING) continue;
        shapes.push({
            kind: 'quad', id, priority: 2,
            centre: quad.centre, u: quad.u, w: quad.w, halfU: quad.half, halfW: quad.half,
        });
    }

    for (let i = 0; i < 3; i++) {
        shapes.push({
            kind: 'segment', id: AXIS_IDS[i], priority: 1,
            a: vec3.scaleAndAdd(vec3.create(), frame.origin, frame.axes[i], AXIS_PICK_START * s),
            b: vec3.scaleAndAdd(vec3.create(), frame.origin, frame.axes[i], HANDLE_LENGTH * s),
            radius: AXIS_PICK_RADIUS * s,
        });
    }

    return shapes;
}

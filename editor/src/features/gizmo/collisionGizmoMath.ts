import { quat, vec3 } from 'gl-matrix';
import type { ReadonlyQuat, ReadonlyVec3 } from 'gl-matrix';
import { eulerFromQuatDeg } from 'cleo';
import type { ShapeDescription } from '../engineContextTypes';
import { snapValue } from '../../utils/gizmoMath';

/**
 * Pure geometry for the in-viewport collision-shape handles — no React, no scene graph.
 *
 * One rule runs through all of it: a handle sits exactly where the PHYSICS puts the face it edits. That is
 * `Shape.*` in the engine and `applyShapeTransform` in the wireframe code, both of which this mirrors:
 *
 *   - the offset is scaled per axis by the owner's world scale, in the owner's frame, then rotated by it;
 *   - the shape's own rotation is applied after its dimensions are scaled, never to the offset;
 *   - a box scales per axis, a sphere by the largest axis, a cylinder or capsule radially by max(X, Z)
 *     and along its length by Y — so a sphere on a node scaled [1, 3, 1] is three times wider, not an
 *     ellipsoid, and a handle on it has to be three times further out.
 *
 * Drags arrive as a signed distance in world metres along the handle's outward direction (the caller
 * solves that exactly from the cursor ray) and come back as a new shape descriptor in node-local units.
 */

export type CollisionAxis = 0 | 1 | 2;
export type CollisionDimension = 'width' | 'height' | 'depth' | 'radius';

export interface CollisionHandle {
  /** The shape-local axis the handle sits on. */
  axis: CollisionAxis;
  /** Which of the two faces on that axis. */
  side: 1 | -1;
  /** The descriptor field the handle edits. */
  dimension: CollisionDimension;
}

/** No dimension goes below this: a zero-size shape is degenerate to cannon and invisible to the eye. */
export const MIN_SHAPE_SIZE = 0.001;

const both = (axis: CollisionAxis, dimension: CollisionDimension): CollisionHandle[] =>
  [{ axis, side: 1, dimension }, { axis, side: -1, dimension }];

/**
 * The size handles a shape offers, both faces of every axis it can be sized along. A convex hull is sized
 * by its Definition and a plane has no extent, so neither gets any.
 */
export function collisionHandles(shape: ShapeDescription): CollisionHandle[] {
  switch (shape.type) {
    case 'box': return [...both(0, 'width'), ...both(1, 'height'), ...both(2, 'depth')];
    case 'sphere': return [...both(0, 'radius'), ...both(1, 'radius'), ...both(2, 'radius')];
    case 'capsule':
    case 'cylinder': return [...both(0, 'radius'), ...both(1, 'height'), ...both(2, 'radius')];
    default: return [];
  }
}

/** Stable identity of a handle within its shape, for DOM keys and hover state. */
export const handleKey = (h: CollisionHandle): string => `${h.dimension}:${'xyz'[h.axis]}${h.side > 0 ? '+' : '-'}`;

/**
 * World metres per local unit along each of the shape's own axes, as physics scales them. `scale` is the
 * owner's world scale; its sign is ignored, as it is everywhere else in collision.
 */
export function shapeScaleFactors(shape: ShapeDescription, scale: ReadonlyVec3): [number, number, number] {
  const sx = Math.abs(scale[0]), sy = Math.abs(scale[1]), sz = Math.abs(scale[2]);
  switch (shape.type) {
    case 'sphere': { const m = Math.max(sx, sy, sz); return [m, m, m]; }
    case 'cylinder':
    case 'capsule': { const radial = Math.max(sx, sz); return [radial, sy, radial]; }
    case 'plane': return [1, 1, 1];
    default: return [sx, sy, sz];
  }
}

/** Half extents along the shape's own axes, in world metres — the box physics collides with. */
export function shapeHalfExtents(shape: ShapeDescription, scale: ReadonlyVec3): [number, number, number] {
  const f = shapeScaleFactors(shape, scale);
  switch (shape.type) {
    case 'box': return [shape.width * f[0] / 2, shape.height * f[1] / 2, shape.depth * f[2] / 2];
    case 'sphere': return [shape.radius * f[0], shape.radius * f[0], shape.radius * f[0]];
    case 'cylinder': return [shape.radius * f[0], shape.height * f[1] / 2, shape.radius * f[2]];
    case 'capsule': {
      // At or below 2r the capsule is a sphere: the caps are what reach furthest along Y.
      const r = shape.radius * f[0];
      return [r, Math.max(shape.height * f[1], 2 * r) / 2, r];
    }
    case 'convex': {
      // Hull vertices are centred on their own centroid, so the furthest vertex bounds each axis.
      const h: [number, number, number] = [0, 0, 0];
      for (const v of shape.vertices) for (let a = 0; a < 3; a++) h[a] = Math.max(h[a], Math.abs(v[a]) * f[a]);
      return h;
    }
    default: return [0, 0, 0];
  }
}

/** The owner's world transform, as the collider sees it. */
export interface OwnerPose {
  position: ReadonlyVec3;
  quaternion: ReadonlyQuat;
  scale: ReadonlyVec3;
}

/** A shape placed in the world: its centre, orientation, unit axes and half extents. */
export interface ShapeFrame {
  centre: vec3;
  quaternion: quat;
  axes: [vec3, vec3, vec3];
  half: [number, number, number];
}

/** The shape's own rotation, as `attachShape` builds it. */
export function shapeLocalQuat(shape: ShapeDescription): quat {
  const r = shape.rotation;
  return quat.fromEuler(quat.create(), r[0] ?? 0, r[1] ?? 0, r[2] ?? 0);
}

export function shapeFrame(owner: OwnerPose, shape: ShapeDescription): ShapeFrame {
  const s = owner.scale;
  const o = shape.offset;
  const scaledOffset = vec3.fromValues(o[0] * Math.abs(s[0]), o[1] * Math.abs(s[1]), o[2] * Math.abs(s[2]));
  const centre = vec3.add(vec3.create(), owner.position, vec3.transformQuat(vec3.create(), scaledOffset, owner.quaternion));
  const quaternion = quat.multiply(quat.create(), owner.quaternion, shapeLocalQuat(shape));
  const axes = [0, 1, 2].map(a => {
    const unit = vec3.create(); unit[a] = 1;
    return vec3.transformQuat(unit, unit, quaternion);
  }) as [vec3, vec3, vec3];
  return { centre, quaternion, axes, half: shapeHalfExtents(shape, s) };
}

/** Where a handle sits: the centre of the face it moves. */
export function handlePoint(frame: ShapeFrame, handle: CollisionHandle): vec3 {
  return vec3.scaleAndAdd(vec3.create(), frame.centre, frame.axes[handle.axis], handle.side * frame.half[handle.axis]);
}

/** The handle's outward direction in the world. */
export function handleDirection(frame: ShapeFrame, handle: CollisionHandle): vec3 {
  return vec3.scale(vec3.create(), frame.axes[handle.axis], handle.side);
}

export interface CollisionDragOptions {
  /** Grow both faces at once and keep the centre still (Alt). Otherwise the opposite face stays put. */
  symmetric?: boolean;
  /** Snap the resulting full size (width, diameter, length) to this many metres; 0 or absent is off. */
  snap?: number;
}

/** The full world size the handle measures — width, diameter or length — and how it maps to the field. */
function fullSize(shape: ShapeDescription, handle: CollisionHandle, f: number): number {
  switch (shape.type) {
    case 'box': return shape[handle.dimension as 'width' | 'height' | 'depth'] * f;
    case 'sphere': return 2 * shape.radius * f;
    case 'cylinder':
    case 'capsule':
      return handle.dimension === 'radius' ? 2 * shape.radius * f : shape.height * f;
    default: return 0;
  }
}

/**
 * Move one face by `delta` metres along its outward direction (negative pulls it in). One-sided by
 * default: the opposite face stays where it is, so the shape's centre — its offset — follows by half the
 * change. `scale` is the owner's world scale.
 *
 * The change applied is the one that survives snapping and the minimum size, and the offset moves by
 * exactly that much, so a clamped drag never drifts the shape.
 */
export function applyCollisionDrag(
  shape: ShapeDescription,
  handle: CollisionHandle,
  delta: number,
  scale: ReadonlyVec3,
  options: CollisionDragOptions = {},
): ShapeDescription {
  if (shape.type !== 'box' && shape.type !== 'sphere' && shape.type !== 'cylinder' && shape.type !== 'capsule') return shape;
  const f = shapeScaleFactors(shape, scale)[handle.axis];
  if (!(f > 0)) return shape;

  const diameterField = handle.dimension === 'radius';
  // A capsule shorter than 2r is drawn (and collides) as a sphere, so its length handle starts from the
  // visible length, not the stored one — otherwise the first stretch of the drag would move nothing.
  const capsuleDiameter = shape.type === 'capsule' ? 2 * shape.radius * shapeScaleFactors(shape, scale)[0] : 0;
  const isCapsuleLength = shape.type === 'capsule' && handle.dimension === 'height';
  const before = isCapsuleLength ? Math.max(fullSize(shape, handle, f), capsuleDiameter) : fullSize(shape, handle, f);

  let after = before + delta * (options.symmetric ? 2 : 1);
  if (options.snap && options.snap > 0) after = snapValue(after, options.snap);
  const minimum = (diameterField ? 2 : 1) * MIN_SHAPE_SIZE * f;
  after = Math.max(after, minimum);

  const value = Math.max(MIN_SHAPE_SIZE, tidy(diameterField ? after / (2 * f) : after / f));
  const next = { ...shape, [handle.dimension]: value } as ShapeDescription;
  if (options.symmetric) return next;

  // What actually changed on screen. For a capsule's length that is clamped by its own caps.
  const visibleAfter = isCapsuleLength ? Math.max(after, capsuleDiameter) : after;
  const shift = (visibleAfter - before) / 2;
  if (shift === 0) return next;

  // The centre moves along the shape's own axis, expressed in the owner's frame (where `offset` lives,
  // pre-scale): rotate by the shape rotation, then undo the owner's per-axis scale.
  const along = vec3.create(); along[handle.axis] = handle.side * shift;
  vec3.transformQuat(along, along, shapeLocalQuat(shape));
  const offset = [0, 1, 2].map(a => {
    const s = Math.abs(scale[a]);
    return s > 0 ? tidy(shape.offset[a] + along[a] / s) : shape.offset[a];
  });
  return { ...next, offset } as ShapeDescription;
}

/**
 * A dragged value, to a tenth of a millimetre: finer than any collider is authored to, and what keeps a
 * drag from writing `1.3474068531297856` into the panel and the scene file.
 */
function tidy(v: number): number {
  const r = Math.round(v * 1e4) / 1e4;
  return Object.is(r, -0) ? 0 : r;
}

const DIMENSION_LABEL: Record<CollisionDimension, string> = { width: 'Width', height: 'Height', depth: 'Depth', radius: 'Radius' };

/** The live readout for a handle: the field it edits, at its world size ("Width 1.20 m"). */
export function dimensionReadout(shape: ShapeDescription, handle: CollisionHandle, scale: ReadonlyVec3): string {
  const f = shapeScaleFactors(shape, scale)[handle.axis];
  const value = handle.dimension === 'radius' ? fullSize(shape, handle, f) / 2 : fullSize(shape, handle, f);
  return `${DIMENSION_LABEL[handle.dimension]} ${value.toFixed(2)} m`;
}

/** A handle's tooltip: what it edits and the two modifiers. */
export function handleTitle(handle: CollisionHandle): string {
  const face = `${handle.side > 0 ? '+' : '−'}${'XYZ'[handle.axis]}`;
  return `${DIMENSION_LABEL[handle.dimension]} (${face} face). Drag to resize; Alt grows both sides, Ctrl snaps.`;
}

// ---------------------------------------------------------------------------------------------------
// World -> descriptor, for the move/rotate gizmo driving a shape through a proxy node
// ---------------------------------------------------------------------------------------------------

const clean = (v: number, digits: number) => {
  const f = 10 ** digits;
  const r = Math.round(v * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

/** The `offset` that puts the shape's centre at `world`: owner frame, pre-scale. */
export function offsetForWorldPoint(owner: OwnerPose, world: ReadonlyVec3): number[] {
  const inverse = quat.invert(quat.create(), owner.quaternion);
  const local = vec3.transformQuat(vec3.create(), vec3.subtract(vec3.create(), world, owner.position), inverse);
  return [0, 1, 2].map(a => {
    const s = Math.abs(owner.scale[a]);
    return clean(s > 0 ? local[a] / s : 0, 4);
  });
}

/** The `rotation` (euler degrees, the engine's order) that gives the shape this world orientation. */
export function rotationForWorldQuat(owner: OwnerPose, world: ReadonlyQuat): number[] {
  const local = quat.multiply(quat.create(), quat.invert(quat.create(), owner.quaternion), world);
  quat.normalize(local, local);
  const euler = eulerFromQuatDeg(vec3.create(), local);
  return [clean(euler[0], 4), clean(euler[1], 4), clean(euler[2], 4)];
}

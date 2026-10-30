import { quat, vec3 } from 'gl-matrix';
import type { ShapeDescription } from '../../engineContextTypes';
import { boundsFromPoints } from '../../../utils/editorHelpers';
import { MIN_SHAPE_SIZE, shapeLocalQuat } from '../../gizmo/collisionGizmoMath';

/**
 * The shape list's edits as pure functions over descriptors: what the Physics panel's row actions do, kept
 * apart from React so each can be tested on its own. Every function returns new arrays and objects and
 * never mutates its input — the panel writes the result straight into the shared bodies/triggers map, and
 * an undo entry keeps the old array, so sharing a nested `offset` between the two would let a later edit
 * reach back into history.
 */

export type PrimitiveShapeType = 'box' | 'sphere' | 'capsule' | 'cylinder';
export const PRIMITIVE_SHAPE_TYPES: PrimitiveShapeType[] = ['box', 'sphere', 'capsule', 'cylinder'];

const TYPE_LABEL: Record<ShapeDescription['type'], string> = {
  box: 'Box', sphere: 'Sphere', capsule: 'Capsule', cylinder: 'Cylinder', plane: 'Plane', convex: 'Convex Hull',
};

/** "Box", "Convex Hull" … */
export const shapeTypeLabel = (type: ShapeDescription['type']): string => TYPE_LABEL[type];

/** A row's title: its type and its 1-based place in the list ("Box 2"). */
export const shapeRowTitle = (shape: ShapeDescription, index: number): string => `${shapeTypeLabel(shape.type)} ${index + 1}`;

/** A deep copy: the arrays inside a descriptor are shared otherwise. */
export function cloneShape<T extends ShapeDescription>(shape: T): T {
  return JSON.parse(JSON.stringify(shape));
}

/**
 * Keep every dimension usable: sizes at least {@link MIN_SHAPE_SIZE} (a zero-size shape is degenerate to
 * cannon and cannot be grabbed again in the viewport) and a whole number of at least three segments.
 */
export function clampShape(shape: ShapeDescription): ShapeDescription {
  const size = (v: number) => (Number.isFinite(v) ? Math.max(MIN_SHAPE_SIZE, v) : MIN_SHAPE_SIZE);
  const segments = (v: number) => (Number.isFinite(v) ? Math.max(3, Math.round(v)) : 16);
  switch (shape.type) {
    case 'box': return { ...shape, width: size(shape.width), height: size(shape.height), depth: size(shape.depth) };
    case 'sphere': return { ...shape, radius: size(shape.radius) };
    case 'cylinder':
    case 'capsule':
      return { ...shape, radius: size(shape.radius), height: size(shape.height), numSegments: segments(shape.numSegments) };
    default: return shape;
  }
}

const tidy = (v: number) => { const r = Math.round(v * 1e4) / 1e4; return Object.is(r, -0) ? 0 : r; };

/**
 * Sizes, offset and rotation to a tenth of a millimetre (and degree). A fit to mesh bounds produces
 * values like 0.7071067811865476; nobody authors a collider to that, and the panel should not show it.
 */
export function tidyShape(shape: ShapeDescription): ShapeDescription {
  const out: any = { ...shape, offset: shape.offset.map(tidy), rotation: shape.rotation.map(tidy) };
  for (const key of ['width', 'height', 'depth', 'radius'] as const)
    if (typeof out[key] === 'number') out[key] = Math.max(MIN_SHAPE_SIZE, tidy(out[key]));
  return out;
}

/** A copy of shape `index` inserted right after it. */
export function duplicateShape(shapes: ShapeDescription[], index: number): ShapeDescription[] {
  if (!shapes[index]) return shapes;
  return [...shapes.slice(0, index + 1), cloneShape(shapes[index]), ...shapes.slice(index + 1)];
}

export function removeShapeAt(shapes: ShapeDescription[], index: number): ShapeDescription[] {
  return shapes.filter((_, i) => i !== index);
}

/** Move shape `index` by `delta` places, clamped to the list. Returns the new list and where it landed. */
export function moveShape(shapes: ShapeDescription[], index: number, delta: number): { shapes: ShapeDescription[]; index: number } {
  const to = Math.min(shapes.length - 1, Math.max(0, index + delta));
  if (to === index || !shapes[index]) return { shapes, index };
  const out = [...shapes];
  const [moved] = out.splice(index, 1);
  out.splice(to, 0, moved);
  return { shapes: out, index: to };
}

/**
 * Where a shape sits in the list after `moveShape(…, from, delta)` moved another one: the selection and
 * the panel's row keys both follow the shapes, not the places.
 */
export function indexAfterMove(index: number, from: number, to: number): number {
  if (index === from) return to;
  if (from < to && index > from && index <= to) return index - 1;
  if (from > to && index >= to && index < from) return index + 1;
  return index;
}

/**
 * Local half extents of a shape and the centre of those extents, in its own (rotated, unscaled) frame.
 * Everything but a hull is centred on its offset; a hull's vertices are centred on their centroid, which
 * is not the middle of its bounds.
 */
function localBounds(shape: ShapeDescription): { half: [number, number, number]; centre: [number, number, number] } {
  switch (shape.type) {
    case 'box': return { half: [shape.width / 2, shape.height / 2, shape.depth / 2], centre: [0, 0, 0] };
    case 'sphere': return { half: [shape.radius, shape.radius, shape.radius], centre: [0, 0, 0] };
    case 'cylinder': return { half: [shape.radius, shape.height / 2, shape.radius], centre: [0, 0, 0] };
    case 'capsule': return { half: [shape.radius, Math.max(shape.height / 2, shape.radius), shape.radius], centre: [0, 0, 0] };
    case 'convex': {
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (const v of shape.vertices) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], v[a]); max[a] = Math.max(max[a], v[a]); }
      if (!Number.isFinite(min[0])) return { half: [0.5, 0.5, 0.5], centre: [0, 0, 0] };
      return {
        half: [0, 1, 2].map(a => (max[a] - min[a]) / 2) as [number, number, number],
        centre: [0, 1, 2].map(a => (max[a] + min[a]) / 2) as [number, number, number],
      };
    }
    default: return { half: [0.5, 0.5, 0.5], centre: [0, 0, 0] };
  }
}

/** The primitive of `type` with these half extents, centred on `offset`, turned by `rotation`. */
function primitive(type: PrimitiveShapeType, half: number[], offset: number[], rotation: number[], segments = 16): ShapeDescription {
  const radial = Math.max(half[0], half[2]);
  switch (type) {
    case 'box': return tidyShape(clampShape({ type, width: half[0] * 2, height: half[1] * 2, depth: half[2] * 2, offset, rotation }));
    case 'sphere': return tidyShape(clampShape({ type, radius: Math.max(half[0], half[1], half[2]), offset, rotation }));
    case 'cylinder': return tidyShape(clampShape({ type, radius: radial, height: half[1] * 2, numSegments: segments, offset, rotation }));
    // A capsule's height is TOTAL, caps included, so it never goes below the 2r its caps already span.
    case 'capsule': return tidyShape(clampShape({ type, radius: radial, height: Math.max(half[1] * 2, radial * 2), numSegments: segments, offset, rotation }));
  }
}

/**
 * The same space as another type: a box that converts to a sphere becomes the sphere around it, a
 * cylinder becomes the capsule of its radius and length, and so on. Offset and rotation are kept (a hull
 * re-centres on its bounds, which its centroid is not). A plane has no extent and a hull needs a mesh, so
 * converting INTO either is not offered; converting a plane out of itself gives the unit size.
 */
export function convertShape(shape: ShapeDescription, type: PrimitiveShapeType): ShapeDescription {
  if (shape.type === type) return shape;
  const { half, centre } = localBounds(shape);
  const shift = vec3.transformQuat(vec3.create(), centre, shapeLocalQuat(shape));
  const offset = [0, 1, 2].map(a => shape.offset[a] + shift[a]);
  const segments = shape.type === 'cylinder' || shape.type === 'capsule' ? shape.numSegments : 16;
  return primitive(type, half, offset, [...shape.rotation], segments);
}

/**
 * Re-fit a primitive to mesh vertices (node-local, the space `meshPositions` returns), along its OWN axes:
 * the points are turned into the shape's frame first, so a shape rotated to lie along a beam fits the
 * beam, not the beam's axis-aligned box. Rotation is kept and the offset moves to the fitted centre.
 * A capsule's radius covers the same 80th percentile `addShape` uses, so a T-pose's arms do not swell it.
 * Returns the shape unchanged when there are no points or it is a plane or hull.
 */
export function fitShapeToPoints(shape: ShapeDescription, points: number[][]): ShapeDescription {
  if (!points.length || shape.type === 'plane' || shape.type === 'convex') return shape;
  const turn = shapeLocalQuat(shape);
  const inverse = quat.invert(quat.create(), turn);
  const v = vec3.create();
  const local = points.map(p => {
    vec3.transformQuat(v, vec3.fromValues(p[0], p[1], p[2]), inverse);
    return [v[0], v[1], v[2]];
  });
  const bounds = boundsFromPoints(local);
  if (!bounds) return shape;
  const centre = vec3.transformQuat(vec3.create(), bounds.center, turn);
  const offset = [centre[0], centre[1], centre[2]];
  const half = [bounds.half[0], bounds.half[1], bounds.half[2]];
  const segments = shape.type === 'cylinder' || shape.type === 'capsule' ? shape.numSegments : 16;
  if (shape.type === 'capsule') {
    const radius = Math.max(bounds.radius, MIN_SHAPE_SIZE);
    return tidyShape(clampShape({ ...shape, radius, height: Math.max(half[1] * 2, radius * 2), offset }));
  }
  return primitive(shape.type, half, offset, [...shape.rotation], segments);
}

/**
 * Keys for the panel's rows that follow the shapes through reorders, so a row's open/closed state and a
 * field mid-edit stay with their shape. UI-only, never persisted: `reconcileRowKeys` pads or trims them
 * when the list changes from elsewhere (an undo, the viewport, another panel).
 */
let nextRowKey = 1;
export const newRowKey = (): string => `shape-row-${nextRowKey++}`;

export function reconcileRowKeys(keys: string[], count: number): string[] {
  if (keys.length === count) return keys;
  if (keys.length > count) return keys.slice(0, count);
  return [...keys, ...Array.from({ length: count - keys.length }, newRowKey)];
}

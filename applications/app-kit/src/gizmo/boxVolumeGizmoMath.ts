import { mat4, vec3 } from 'gl-matrix';
import type { ReadonlyMat4, ReadonlyVec3 } from 'gl-matrix';
import type { ShapeDescription } from './shapeDescription';
import { applyCollisionDrag, type CollisionDragOptions, type CollisionHandle } from './collisionGizmoMath';

/**
 * Pure geometry for the face handles on box VOLUME nodes — light probes, exposure volumes — no React, no
 * scene graph.
 *
 * A volume is a box centred on its node, `size` along the node's own axes under its full transform: the
 * same thing as a box collider with no offset or rotation of its own. So it is handed to the collision
 * handle maths as exactly that, and the handles look and behave the same as the collider ones.
 *
 * The one difference is where a one-sided drag puts the centre. A collider has an offset to move; a volume
 * does not, so the NODE moves instead — to wherever the collision maths put the box's centre — keeping the
 * opposite face where it was.
 */

/** A box volume as the collision handle maths sees it: a box collider with no offset or rotation. */
export function volumeAsBoxShape(size: ReadonlyVec3): ShapeDescription {
  return { type: 'box', width: size[0], height: size[1], depth: size[2], offset: [0, 0, 0], rotation: [0, 0, 0] };
}

export interface VolumeDragResult {
  size: [number, number, number];
  /** The node's new position, in its PARENT's space (what `setPosition` takes). */
  position: [number, number, number];
}

/**
 * Move one face of a volume by `delta` world metres along its outward direction.
 *
 * `world` is the node's world transform at grab (its scale is the volume's scale), `parentWorld` its
 * parent's, or null at the root. `minSize` keeps the box from collapsing below the node's own minimum.
 */
export function applyVolumeDrag(
  size: ReadonlyVec3,
  world: ReadonlyMat4,
  worldScale: ReadonlyVec3,
  parentWorld: ReadonlyMat4 | null,
  localPosition: ReadonlyVec3,
  handle: CollisionHandle,
  delta: number,
  options: CollisionDragOptions & { minSize?: number } = {},
): VolumeDragResult {
  const shape = applyCollisionDrag(volumeAsBoxShape(size), handle, delta, worldScale, options);
  if (shape.type !== 'box') throw new Error('unreachable');
  const min = options.minSize ?? 0;
  const next: [number, number, number] = [Math.max(min, shape.width), Math.max(min, shape.height), Math.max(min, shape.depth)];
  // The clamp above can only hold a face the collision maths already let move to MIN_SHAPE_SIZE; scale the
  // centre shift down by what survived it so the opposite face stays put.
  const axis = handle.axis;
  const wanted = shape[(['width', 'height', 'depth'] as const)[axis]] - size[axis];
  const kept = next[axis] - size[axis];
  const ratio = wanted !== 0 ? kept / wanted : 1;
  const offset = shape.offset.map(o => o * ratio);
  if (offset.every(o => o === 0)) return { size: next, position: [localPosition[0], localPosition[1], localPosition[2]] };

  // The shifted centre in the world, then back into the parent's space.
  const centre = vec3.transformMat4(vec3.create(), vec3.fromValues(offset[0], offset[1], offset[2]), world);
  if (parentWorld) {
    const inverse = mat4.invert(mat4.create(), parentWorld);
    if (inverse) vec3.transformMat4(centre, centre, inverse);
  }
  return { size: next, position: [tidy(centre[0]), tidy(centre[1]), tidy(centre[2])] };
}

/** A dragged position, to a tenth of a millimetre, so the inspector and the scene file stay readable. */
function tidy(v: number): number {
  const r = Math.round(v * 1e4) / 1e4;
  return Object.is(r, -0) ? 0 : r;
}

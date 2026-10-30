import { describe, expect, it } from 'vitest';
import { quat, vec3 } from 'gl-matrix';
import {
  MIN_SHAPE_SIZE, applyCollisionDrag, collisionHandles, dimensionReadout, handlePoint, offsetForWorldPoint,
  rotationForWorldQuat, shapeFrame, shapeHalfExtents, type CollisionHandle, type OwnerPose,
} from '../src/features/gizmo/collisionGizmoMath';
import type { ShapeDescription } from '../src/features/engineContextTypes';

const box = (width: number, height = 2, depth = 2, extra: Partial<ShapeDescription> = {}): ShapeDescription =>
  ({ type: 'box', offset: [0, 0, 0], rotation: [0, 0, 0], width, height, depth, ...extra } as ShapeDescription);
const owner = (scale: number[] = [1, 1, 1], position: number[] = [0, 0, 0], q = quat.create()): OwnerPose =>
  ({ position: vec3.fromValues(position[0], position[1], position[2]), quaternion: q, scale: vec3.fromValues(scale[0], scale[1], scale[2]) });
const plusX: CollisionHandle = { axis: 0, side: 1, dimension: 'width' };
const minusX: CollisionHandle = { axis: 0, side: -1, dimension: 'width' };
const close = (a: ArrayLike<number>, b: number[]) => b.forEach((v, i) => expect(a[i]).toBeCloseTo(v, 5));

describe('collision handles', () => {
  it('puts a size handle on both faces of every axis a shape can be sized along', () => {
    expect(collisionHandles(box(2))).toHaveLength(6);
    expect(collisionHandles({ type: 'sphere', offset: [0, 0, 0], rotation: [0, 0, 0], radius: 1 })).toHaveLength(6);
    const capsule = collisionHandles({ type: 'capsule', offset: [0, 0, 0], rotation: [0, 0, 0], radius: 1, height: 3, numSegments: 8 });
    expect(capsule.filter(h => h.dimension === 'radius').map(h => h.axis).sort()).toEqual([0, 0, 2, 2]);
    expect(capsule.filter(h => h.dimension === 'height').map(h => h.side).sort()).toEqual([-1, 1]);
    // Sized by its Definition, or not at all.
    expect(collisionHandles({ type: 'plane', offset: [0, 0, 0], rotation: [0, 0, 0] })).toEqual([]);
    expect(collisionHandles({ type: 'convex', offset: [0, 0, 0], rotation: [0, 0, 0], quality: 'low', vertices: [], faces: [] })).toEqual([]);
  });

  it('places handles on the faces physics collides with, through the owner and the shape rotation', () => {
    // Owner at (1, 2, 3), turned 90 degrees about Y, scaled 2: the offset is scaled, then turned.
    const q = quat.fromEuler(quat.create(), 0, 90, 0);
    const frame = shapeFrame(owner([2, 2, 2], [1, 2, 3], q), box(1, 1, 1, { offset: [1, 0, 0] }));
    close(frame.centre, [1, 2, 1]);
    expect(frame.half).toEqual([1, 1, 1]);
    // Local +X is world -Z after the turn.
    close(handlePoint(frame, plusX), [1, 2, 0]);
  });

  it('scales a sphere by the largest axis and a capsule radially by max(X, Z), as cannon does', () => {
    const tall = vec3.fromValues(1, 3, 1);
    expect(shapeHalfExtents({ type: 'sphere', offset: [0, 0, 0], rotation: [0, 0, 0], radius: 1 }, tall)).toEqual([3, 3, 3]);
    // A capsule shorter than its two caps is a sphere: the caps reach furthest along Y.
    expect(shapeHalfExtents({ type: 'capsule', offset: [0, 0, 0], rotation: [0, 0, 0], radius: 1, height: 1, numSegments: 8 }, vec3.fromValues(2, 1, 1)))
      .toEqual([2, 2, 2]);
  });
});

describe('dragging a size handle', () => {
  it('moves only the dragged face: the size grows and the centre follows by half', () => {
    const plus = applyCollisionDrag(box(2), plusX, 0.5, [1, 1, 1]) as any;
    expect(plus.width).toBeCloseTo(2.5);
    close(plus.offset, [0.25, 0, 0]);
    const minus = applyCollisionDrag(box(2), minusX, 0.5, [1, 1, 1]) as any;
    expect(minus.width).toBeCloseTo(2.5);
    close(minus.offset, [-0.25, 0, 0]);
  });

  it('grows both sides about a fixed centre with Alt', () => {
    const both = applyCollisionDrag(box(2), plusX, 0.5, [1, 1, 1], { symmetric: true }) as any;
    expect(both.width).toBeCloseTo(3);
    close(both.offset, [0, 0, 0]);
  });

  it('follows a rotated shape along its own axis', () => {
    const turned = box(2, 2, 2, { rotation: [0, 90, 0] });
    const next = applyCollisionDrag(turned, plusX, 0.5, [1, 1, 1]) as any;
    expect(next.width).toBeCloseTo(2.5);
    // The shape's +X is the owner's -Z, so that is where the centre goes.
    close(next.offset, [0, 0, -0.25]);
  });

  it('measures in world metres under a non-uniform owner scale, and stores node-local units', () => {
    // Width 1 on a node scaled 2 along X is 2 m; one metre more is 1.5 local, the centre 0.25 local.
    const next = applyCollisionDrag(box(1), plusX, 1, [2, 1, 1]) as any;
    expect(next.width).toBeCloseTo(1.5);
    close(next.offset, [0.25, 0, 0]);
    // A sphere on [1, 3, 1] is radius 3 m: 0.6 m more on one side is radius 1.1, centre 0.3.
    const sphere = applyCollisionDrag({ type: 'sphere', offset: [0, 0, 0], rotation: [0, 0, 0], radius: 1 },
      { axis: 0, side: 1, dimension: 'radius' }, 0.6, [1, 3, 1]) as any;
    expect(sphere.radius).toBeCloseTo(1.1);
    close(sphere.offset, [0.3, 0, 0]);
  });

  it('snaps the resulting size with Ctrl, and moves the centre by the snapped change', () => {
    const next = applyCollisionDrag(box(2.3), plusX, 0.1, [1, 1, 1], { snap: 0.5 }) as any;
    expect(next.width).toBeCloseTo(2.5);
    close(next.offset, [0.1, 0, 0]);
  });

  it('never goes below the minimum size, and the far face stays exactly put when it clamps', () => {
    const next = applyCollisionDrag(box(2), plusX, -10, [1, 1, 1]) as any;
    expect(next.width).toBeCloseTo(MIN_SHAPE_SIZE);
    expect(next.offset[0] - next.width / 2).toBeCloseTo(-1);
    const sphere = applyCollisionDrag({ type: 'sphere', offset: [0, 0, 0], rotation: [0, 0, 0], radius: 1 },
      { axis: 1, side: -1, dimension: 'radius' }, -5, [1, 1, 1]) as any;
    expect(sphere.radius).toBeCloseTo(MIN_SHAPE_SIZE);
  });

  it('starts a capsule length drag from the length it shows, not the shorter one it stores', () => {
    const capsule: ShapeDescription = { type: 'capsule', offset: [0, 0, 0], rotation: [0, 0, 0], radius: 1, height: 1, numSegments: 8 };
    const next = applyCollisionDrag(capsule, { axis: 1, side: 1, dimension: 'height' }, 1, [1, 1, 1]) as any;
    expect(next.height).toBeCloseTo(3);
    close(next.offset, [0, 0.5, 0]);
  });

  it('reads out the world size of the field being dragged', () => {
    expect(dimensionReadout(box(1.25), plusX, [2, 1, 1])).toBe('Width 2.50 m');
    expect(dimensionReadout({ type: 'cylinder', offset: [0, 0, 0], rotation: [0, 0, 0], radius: 0.5, height: 2, numSegments: 12 },
      { axis: 2, side: 1, dimension: 'radius' }, [1, 1, 3])).toBe('Radius 1.50 m');
  });
});

describe('the move/rotate gizmo driving a shape', () => {
  it('turns a world point and orientation back into the offset and rotation that produce them', () => {
    const q = quat.fromEuler(quat.create(), 10, 35, 0);
    const pose = owner([2, 0.5, 1], [4, -1, 2], q);
    const shape = box(1, 1, 1, { offset: [0.3, -2, 1.5], rotation: [20, -40, 15] });
    const frame = shapeFrame(pose, shape);
    close(offsetForWorldPoint(pose, frame.centre), [0.3, -2, 1.5]);
    close(rotationForWorldQuat(pose, frame.quaternion), [20, -40, 15]);
  });
});

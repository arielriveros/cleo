import { describe, expect, it } from 'vitest';
import { mat4, quat, vec3 } from 'gl-matrix';
import { applyVolumeDrag } from '../src/features/gizmo/boxVolumeGizmoMath';
import type { CollisionHandle } from '../src/features/gizmo/collisionGizmoMath';

const PLUS_X: CollisionHandle = { axis: 0, side: 1, dimension: 'width' };
const MINUS_Y: CollisionHandle = { axis: 1, side: -1, dimension: 'height' };

/** World point of a face centre of a box `size` centred on a node at `local` under `parent`. */
function face(parent: mat4, local: vec3, rotation: quat, scale: vec3, size: number[], axis: number, side: number): vec3 {
  const world = mat4.multiply(mat4.create(), parent, mat4.fromRotationTranslationScale(mat4.create(), rotation, local, scale));
  const p = vec3.create(); p[axis] = side * size[axis] / 2;
  return vec3.transformMat4(p, p, world);
}

describe('applyVolumeDrag', () => {
  it('moves one face and keeps the opposite one where it was, at the root', () => {
    const world = mat4.create();
    const r = applyVolumeDrag([10, 4, 6], world, [1, 1, 1], null, [0, 0, 0], PLUS_X, 2);
    expect(r.size).toEqual([12, 4, 6]);
    expect(r.position).toEqual([1, 0, 0]);
  });

  it('keeps the opposite face fixed under a rotated, scaled parent and node', () => {
    const parent = mat4.fromRotationTranslationScale(mat4.create(), quat.fromEuler(quat.create(), 0, 30, 0), [5, 1, -2], [2, 2, 2]);
    const local = vec3.fromValues(1, 0.5, 3);
    const rot = quat.fromEuler(quat.create(), 20, 0, 45);
    const scale = vec3.fromValues(1, 3, 1);
    const world = mat4.multiply(mat4.create(), parent, mat4.fromRotationTranslationScale(mat4.create(), rot, local, scale));
    const worldScale = mat4.getScaling(vec3.create(), world);
    const size = [4, 2, 2];
    const before = face(parent, local, rot, scale, size, 1, 1);
    const r = applyVolumeDrag(size, world, worldScale, parent, local, MINUS_Y, 3);
    const after = face(parent, vec3.fromValues(...r.position), rot, scale, r.size, 1, 1);
    expect(r.size[1]).toBeGreaterThan(size[1]);
    for (let i = 0; i < 3; i++) expect(after[i]).toBeCloseTo(before[i], 3);
  });

  it('grows both faces about the centre with Alt, without moving the node', () => {
    const r = applyVolumeDrag([10, 4, 6], mat4.create(), [1, 1, 1], null, [3, 0, 0], PLUS_X, 1, { symmetric: true });
    expect(r.size).toEqual([12, 4, 6]);
    expect(r.position).toEqual([3, 0, 0]);
  });

  it('snaps the size', () => {
    const r = applyVolumeDrag([10, 4, 6], mat4.create(), [1, 1, 1], null, [0, 0, 0], PLUS_X, 0.7, { snap: 0.5 });
    expect(r.size[0]).toBe(10.5);
    expect(r.position[0]).toBeCloseTo(0.25, 6);
  });

  it('never goes below the minimum size, and the opposite face still holds', () => {
    const r = applyVolumeDrag([2, 4, 6], mat4.create(), [1, 1, 1], null, [0, 0, 0], PLUS_X, -5, { minSize: 0.01 });
    expect(r.size[0]).toBeCloseTo(0.01, 6);
    // The -X face was at -1; the box is now 0.01 wide against it.
    expect(r.position[0] - r.size[0] / 2).toBeCloseTo(-1, 3);
  });
});

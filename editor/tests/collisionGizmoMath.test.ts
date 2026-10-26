import { describe, expect, it } from 'vitest';
import { applyCollisionDrag, collisionHandles } from '../src/features/gizmo/collisionGizmoMath';

describe('collision gizmo contracts', () => {
  it('exposes offset and shape-specific dimension handles', () => {
    expect(collisionHandles({ type: 'box', offset: [0, 0, 0], rotation: [0, 0, 0], width: 2, height: 4, depth: 6 }))
      .toHaveLength(6);
    expect(collisionHandles({ type: 'sphere', offset: [0, 0, 0], rotation: [0, 0, 0], radius: 1 }))
      .toHaveLength(4);
    expect(collisionHandles({ type: 'capsule', offset: [0, 0, 0], rotation: [0, 0, 0], radius: 1, height: 3, numSegments: 8 }))
      .toHaveLength(5);
  });

  it('changes offset and dimensions without producing negative sizes', () => {
    const box = { type: 'box' as const, offset: [0, 0, 0], rotation: [0, 0, 0], width: 2, height: 2, depth: 2 };
    const offset = applyCollisionDrag(box, { kind: 'offset', axis: 1, extent: 1 }, 0.5);
    expect(offset.offset).toEqual([0, 0.5, 0]);
    const resized = applyCollisionDrag(box, { kind: 'size', axis: 0, extent: 1 }, -10);
    expect(resized.width).toBeGreaterThan(0);
  });
});

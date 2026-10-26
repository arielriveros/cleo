import type { ShapeDescription } from '../engineContextTypes';

export type CollisionHandleKind = 'offset' | 'size';
export type CollisionAxis = 0 | 1 | 2;

export interface CollisionHandle {
  kind: CollisionHandleKind;
  axis: CollisionAxis;
  /** Distance from the shape centre in the shape's local units. */
  extent: number;
}

/** The editable dimensions exposed by the in-scene collision editor. */
export function collisionHandles(shape: ShapeDescription): CollisionHandle[] {
  const reach = shape.type === 'box'
    ? Math.max(shape.width, shape.height, shape.depth) / 2 + 0.2
    : shape.type === 'sphere' ? shape.radius + 0.2
      : shape.type === 'capsule' || shape.type === 'cylinder' ? Math.max(shape.radius, shape.height / 2) + 0.2
        : 0.5;
  const offset: CollisionHandle[] = [
    { kind: 'offset', axis: 0, extent: reach },
    { kind: 'offset', axis: 1, extent: reach },
    { kind: 'offset', axis: 2, extent: reach },
  ];
  switch (shape.type) {
    case 'box':
      return [...offset, { kind: 'size', axis: 0, extent: shape.width / 2 },
        { kind: 'size', axis: 1, extent: shape.height / 2 }, { kind: 'size', axis: 2, extent: shape.depth / 2 }];
    case 'sphere':
      return [...offset, { kind: 'size', axis: 0, extent: shape.radius }];
    case 'capsule':
    case 'cylinder':
      return [...offset, { kind: 'size', axis: 0, extent: shape.radius },
        { kind: 'size', axis: 1, extent: shape.height / 2 }];
    default:
      return offset;
  }
}

/** Apply a signed local-unit drag to one handle. Values never become negative. */
export function applyCollisionDrag(shape: ShapeDescription, handle: CollisionHandle, delta: number): ShapeDescription {
  if (handle.kind === 'offset') {
    const offset = [...shape.offset] as number[];
    offset[handle.axis] += delta;
    return { ...shape, offset };
  }
  switch (shape.type) {
    case 'box': {
      const key = (['width', 'height', 'depth'] as const)[handle.axis];
      return { ...shape, [key]: Math.max(0.001, shape[key] + delta * 2) };
    }
    case 'sphere':
      return { ...shape, radius: Math.max(0.001, shape.radius + delta) };
    case 'capsule':
    case 'cylinder':
      return handle.axis === 0
        ? { ...shape, radius: Math.max(0.001, shape.radius + delta) }
        : { ...shape, height: Math.max(0.002, shape.height + delta * 2) };
    default:
      return shape;
  }
}

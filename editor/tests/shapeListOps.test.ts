import { describe, expect, it } from 'vitest';
import {
  clampShape, convertShape, duplicateShape, fitShapeToPoints, indexAfterMove, moveShape, reconcileRowKeys, removeShapeAt,
  shapeRowTitle,
} from '../src/features/nodeInspector/physicsEditors/shapeListOps';
import { MIN_SHAPE_SIZE } from '../src/features/gizmo/collisionGizmoMath';
import type { ShapeDescription } from '../src/features/engineContextTypes';

const box = (w: number, h: number, d: number, extra: Partial<ShapeDescription> = {}): ShapeDescription =>
  ({ type: 'box', offset: [0, 0, 0], rotation: [0, 0, 0], width: w, height: h, depth: d, ...extra } as ShapeDescription);
const sphere = (r: number): ShapeDescription => ({ type: 'sphere', offset: [0, 0, 0], rotation: [0, 0, 0], radius: r });
const close = (a: ArrayLike<number>, b: number[]) => b.forEach((v, i) => expect(a[i]).toBeCloseTo(v, 5));

/** The eight corners of an axis-aligned box, as a mesh's vertices would give them. */
function corners(centre: number[], size: number[]): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < 8; i++)
    out.push([0, 1, 2].map(a => centre[a] + ((i >> a) & 1 ? 0.5 : -0.5) * size[a]));
  return out;
}

describe('the shape list', () => {
  it('titles each row by its type and place', () => {
    expect(shapeRowTitle(box(1, 1, 1), 1)).toBe('Box 2');
    expect(shapeRowTitle({ type: 'convex', offset: [0, 0, 0], rotation: [0, 0, 0], quality: 'low', vertices: [], faces: [] }, 0)).toBe('Convex Hull 1');
  });

  it('clamps sizes to the minimum and segments to a whole number of at least three', () => {
    const b = clampShape(box(0, -1, 2)) as any;
    expect([b.width, b.height, b.depth]).toEqual([MIN_SHAPE_SIZE, MIN_SHAPE_SIZE, 2]);
    const c = clampShape({ type: 'cylinder', offset: [0, 0, 0], rotation: [0, 0, 0], radius: 1, height: 1, numSegments: 2.4 }) as any;
    expect(c.numSegments).toBe(3);
  });

  it('duplicates a shape right after itself, sharing nothing with the original', () => {
    const list = [box(1, 1, 1), sphere(2)];
    const out = duplicateShape(list, 0);
    expect(out.map(s => s.type)).toEqual(['box', 'box', 'sphere']);
    out[1].offset[0] = 5;
    expect(list[0].offset[0]).toBe(0);
    expect(list).toHaveLength(2);
  });

  it('moves and removes shapes, and a selection follows the shape it pointed at', () => {
    const list = [box(1, 1, 1), sphere(1), sphere(2)];
    const moved = moveShape(list, 0, 2);
    expect(moved.index).toBe(2);
    expect(moved.shapes.map(s => s.type)).toEqual(['sphere', 'sphere', 'box']);
    expect(moveShape(list, 0, -1)).toEqual({ shapes: list, index: 0 });
    expect(indexAfterMove(0, 0, 2)).toBe(2);
    expect(indexAfterMove(1, 0, 2)).toBe(0);
    expect(indexAfterMove(2, 2, 0)).toBe(0);
    expect(indexAfterMove(0, 2, 0)).toBe(1);
    expect(removeShapeAt(list, 1).map(s => (s as any).radius ?? 'box')).toEqual(['box', 2]);
  });

  it('converts to the same space: a box to the sphere around it, a cylinder to a capsule no shorter than its caps', () => {
    expect((convertShape(box(2, 4, 6), 'sphere') as any).radius).toBe(3);
    const capsule = convertShape({ type: 'cylinder', offset: [1, 2, 3], rotation: [0, 0, 0], radius: 1, height: 1, numSegments: 10 }, 'capsule') as any;
    expect(capsule).toMatchObject({ type: 'capsule', radius: 1, height: 2, numSegments: 10, offset: [1, 2, 3] });
    const back = convertShape(sphere(1.5), 'box') as any;
    expect([back.width, back.height, back.depth]).toEqual([3, 3, 3]);
  });

  it('re-centres a hull on its bounds when it becomes a primitive', () => {
    const hull: ShapeDescription = {
      type: 'convex', offset: [0, 0, 0], rotation: [0, 90, 0], quality: 'low', faces: [],
      vertices: [[0, -1, -1], [2, -1, -1], [0, 1, 1], [2, 1, 1]],
    };
    const b = convertShape(hull, 'box') as any;
    expect([b.width, b.height, b.depth]).toEqual([2, 2, 2]);
    // The bounds centre is +1 on the hull's own X, which the 90-degree turn points along -Z.
    close(b.offset, [0, 0, -1]);
    expect(b.rotation).toEqual([0, 90, 0]);
  });

  it('fits a shape to the mesh along its own axes, keeping its rotation', () => {
    const points = corners([1, 1, 1], [2, 4, 6]);
    const level = fitShapeToPoints(box(1, 1, 1), points) as any;
    expect([level.width, level.height, level.depth].map((v: number) => +v.toFixed(5))).toEqual([2, 4, 6]);
    close(level.offset, [1, 1, 1]);
    // Turned 90 degrees about Y, the box's own X lies along the mesh's Z: the long side.
    const turned = fitShapeToPoints(box(1, 1, 1, { rotation: [0, 90, 0] }), points) as any;
    expect([turned.width, turned.height, turned.depth].map((v: number) => +v.toFixed(5))).toEqual([6, 4, 2]);
    close(turned.offset, [1, 1, 1]);
    expect(turned.rotation).toEqual([0, 90, 0]);
    // Nothing to fit to, or nothing that can be fitted: unchanged.
    const plane: ShapeDescription = { type: 'plane', offset: [0, 0, 0], rotation: [0, 0, 0] };
    expect(fitShapeToPoints(plane, points)).toBe(plane);
    const b = box(1, 1, 1);
    expect(fitShapeToPoints(b, [])).toBe(b);
  });

  it('keeps row keys aligned with the list when it grows or shrinks from elsewhere', () => {
    const keys = reconcileRowKeys([], 2);
    expect(keys).toHaveLength(2);
    expect(reconcileRowKeys(keys, 2)).toBe(keys);
    expect(reconcileRowKeys(keys, 1)).toEqual([keys[0]]);
    const grown = reconcileRowKeys(keys, 3);
    expect(grown.slice(0, 2)).toEqual(keys);
    expect(new Set(grown).size).toBe(3);
  });
});

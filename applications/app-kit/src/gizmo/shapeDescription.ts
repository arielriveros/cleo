import type { HullQuality } from 'cleo';

// Physics collider shapes as the editor stores them on a node (and as the collision / box-volume
// gizmos edit them). Shared through app-kit so any Cleo application can drive those gizmos.

export type BoxShapeDescription = {
  type: 'box';
  offset: number[];
  rotation: number[];

  width: number;
  height: number;
  depth: number;
};

export type SphereShapeDescription = {
  type: 'sphere';
  offset: number[];
  rotation: number[];

  radius: number;
};

export type CylinderShapeDescription = {
  type: 'cylinder';
  offset: number[];
  rotation: number[];

  radius: number;
  height: number;
  numSegments: number;
};

/**
 * Capsule collider. `height` is the TOTAL tip-to-tip height, so the straight section is
 * `height - 2 * radius` and a height at or below `2 * radius` is a sphere.
 */
export type CapsuleShapeDescription = {
  type: 'capsule';
  offset: number[];
  rotation: number[];

  radius: number;
  height: number;
  numSegments: number;
};

export type PlaneShapeDescription = {
  type: 'plane';
  offset: number[];
  rotation: number[];
};

/**
 * Convex hull fitted to a mesh (see `hullFromPositions`). Vertices/faces are baked at authoring time and
 * centered on the hull's centroid; that displacement is folded into `offset`.
 */
export type ConvexShapeDescription = {
  type: 'convex';
  offset: number[];
  rotation: number[];

  quality: HullQuality;
  vertices: number[][];
  faces: number[][];
  /**
   * Hull algorithm version: the editor's `HULL_VERSION` (editorHelpers), currently 5. A hull stamped with
   * an older one (or none) is rebuilt from its node's mesh by the editor-helper reconciler on load.
   */
  v?: number;
};

export type ShapeDescription = BoxShapeDescription | SphereShapeDescription | CylinderShapeDescription | CapsuleShapeDescription | PlaneShapeDescription | ConvexShapeDescription;

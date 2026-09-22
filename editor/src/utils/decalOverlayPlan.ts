import { Vec, DecalNode } from 'cleo'
import type { Node } from 'cleo'

/**
 * What the selected decal's viewport box should look like, decided WITHOUT touching the GPU.
 *
 * The same split as `navOverlayPlan`: the decision ("is there a box, and where") is plain arithmetic
 * over a node, so it can be tested headlessly, and `editorHelpers` keeps only the part that needs a
 * device (building the `Model`). See `editor/tests/decalOverlayPlan.test.ts`.
 *
 * ## The box
 *
 * A decal's volume is `worldTransform x scale(size)` over the unit cube `|xyz| <= 0.5` — its
 * `volumeMatrix`. The helper cannot simply copy `worldPosition` / `worldQuaternion` / `worldScale` off
 * the node:
 *  - `worldScale` is a column LENGTH, always positive, so a mirrored node would lose its flip; and the
 *    quaternion gl-matrix extracts from a mirrored matrix is not a rotation at all.
 *  - `size` multiplies each local axis separately, so it must scale the frame per axis, not uniformly.
 * So the frame is rebuilt from the volume matrix's own columns (see {@link decalBoxFrame}).
 */

/** Where the box helper goes, in world space. `scale` is the FULL extent along each frame axis. */
export interface DecalOverlayFrame {
  center: Vec.vec3
  quaternion: Vec.quat
  scale: Vec.vec3
}

/** A zero extent would make the helper's scale degenerate; keep it a visible sliver instead. */
const MIN_EXTENT = 1e-3

/**
 * The box to draw for the selected node, or null when it is not a decal or not the user's.
 *
 * Selection is the whole gate, exactly as for the navmesh bake volume: this is an authoring aid for the
 * node being placed, not scene furniture, so it is not behind the eye menu (whose `decals` switch governs
 * the icon billboard). An editor-owned decal — the landscape brush — never gets one; it cannot be
 * selected today, and must not grow a box if that ever changes.
 */
export function planDecalBox(selected: Node | null | undefined): DecalOverlayFrame | null {
  if (!(selected instanceof DecalNode) || selected.isEditorOwned) return null
  return decalBoxFrame(selected.volumeMatrix)
}

/**
 * A position / proper rotation / per-axis scale that reproduces `volume` (unit cube -> world) closely
 * enough for a wireframe, and EXACTLY along its local Y axis — the projection direction, which is the
 * one thing the helper's arrow must never get wrong.
 *
 *  - Y is taken first, straight from the matrix's second column.
 *  - X is Gram-Schmidt'd against it; a sheared matrix (a non-uniformly scaled parent above a rotated
 *    child) comes out as the nearest box rather than a parallelepiped.
 *  - Z completes a right-handed frame. When the matrix is MIRRORED that Z points away from the matrix's
 *    own third column, and X is flipped instead: the cube is symmetric, so a flipped X draws the same
 *    wireframe, and the rotation stays a real rotation.
 */
export function decalBoxFrame(volume: Vec.mat4): DecalOverlayFrame {
  const ax = Vec.vec3.fromValues(volume[0], volume[1], volume[2])
  const ay = Vec.vec3.fromValues(volume[4], volume[5], volume[6])
  const az = Vec.vec3.fromValues(volume[8], volume[9], volume[10])
  const sx = Vec.vec3.length(ax), sy = Vec.vec3.length(ay), sz = Vec.vec3.length(az)

  const y = sy > 1e-9 ? Vec.vec3.scale(Vec.vec3.create(), ay, 1 / sy) : Vec.vec3.fromValues(0, 1, 0)

  const x = Vec.vec3.scaleAndAdd(Vec.vec3.create(), ax, y, -Vec.vec3.dot(ax, y))
  if (Vec.vec3.length(x) < 1e-9) {
    // X collapsed onto Y (or to nothing): any perpendicular will do, since the cube is symmetric.
    Vec.vec3.cross(x, y, Math.abs(y[0]) < 0.9 ? Vec.vec3.fromValues(1, 0, 0) : Vec.vec3.fromValues(0, 0, 1))
  }
  Vec.vec3.normalize(x, x)

  const z = Vec.vec3.cross(Vec.vec3.create(), x, y)
  if (Vec.vec3.dot(z, az) < 0) {
    Vec.vec3.negate(x, x)
    Vec.vec3.negate(z, z)
  }

  // Column-major, like everything in gl-matrix: the frame's axes are the columns.
  const rot = Vec.mat3.fromValues(x[0], x[1], x[2], y[0], y[1], y[2], z[0], z[1], z[2])
  const quaternion = Vec.quat.normalize(Vec.quat.create(), Vec.quat.fromMat3(Vec.quat.create(), rot))

  return {
    center: Vec.vec3.fromValues(volume[12], volume[13], volume[14]),
    quaternion,
    scale: Vec.vec3.fromValues(Math.max(sx, MIN_EXTENT), Math.max(sy, MIN_EXTENT), Math.max(sz, MIN_EXTENT)),
  }
}

/** Line-list geometry in the unit box's own space: positions, and index PAIRS (one per segment). */
export interface DecalBoxLines {
  positions: [number, number, number][]
  indices: number[]
}

/** Where the arrowhead's tip sits on the box's axis, and how far its barbs reach back and out. */
const ARROW_TIP_Y = 0.1
const ARROW_BARB_BACK = 0.2
const ARROW_BARB_OUT = 0.12

/**
 * The helper's wireframe: the unit cube's 12 edges, plus a shaft down the box's local Y axis from the
 * top face to the bottom one with a four-barbed arrowhead pointing along -Y — the way the decal projects.
 *
 * The arrowhead sits just ABOVE the centre, on purpose. A decal is normally placed with the surface it
 * lands on half-way up its box, and helper wireframes are depth-tested against the scene, so everything
 * below the centre is usually under the ground; a head at the bottom face would never be seen.
 *
 * Drawn as line pairs because a wireframe material draws its index buffer as a line list.
 */
export function decalBoxLines(): DecalBoxLines {
  const positions: [number, number, number][] = []
  for (let i = 0; i < 8; i++)
    positions.push([(i & 1) ? 0.5 : -0.5, (i & 2) ? 0.5 : -0.5, (i & 4) ? 0.5 : -0.5])
  const indices: number[] = []
  // Corners differing in exactly one bit share an edge: 4 edges per axis bit.
  for (let i = 0; i < 8; i++)
    for (const bit of [1, 2, 4])
      if (!(i & bit)) indices.push(i, i | bit)

  const add = (p: [number, number, number]): number => { positions.push(p); return positions.length - 1 }
  const top = add([0, 0.5, 0])
  const bottom = add([0, -0.5, 0])
  indices.push(top, bottom)
  const tip = add([0, ARROW_TIP_Y, 0])
  const barbY = ARROW_TIP_Y + ARROW_BARB_BACK
  for (const [bx, bz] of [[ARROW_BARB_OUT, 0], [-ARROW_BARB_OUT, 0], [0, ARROW_BARB_OUT], [0, -ARROW_BARB_OUT]])
    indices.push(add([bx, barbY, bz]), tip)
  return { positions, indices }
}

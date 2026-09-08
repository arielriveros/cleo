import { Vec, clipSoupToVolume, walkableSoup } from 'cleo'
import type { NavMeshNode, TriangleSoup } from 'cleo'

/**
 * What the nav-mesh overlays should look like right now — decided WITHOUT touching the GPU.
 *
 * ## Why this is a separate module
 *
 * The first cut of these overlays shipped invisible, and nothing could have caught it: the decision
 * ("should a box exist, and where") was tangled up with the drawing ("build a `Model`"), and a `Model`
 * needs a real device, so the whole path was untestable headlessly. Every test that existed covered
 * the geometry going in and the bake coming out, and both were fine — the bug was two gates in the
 * middle that nothing could reach.
 *
 * So the decision lives here, as plain arithmetic over a node and a triangle soup, and
 * `editorHelpers` is left holding only the part that genuinely needs a device. The two gates that
 * broke it are now assertions in `editor/tests/navOverlayPlan.test.ts`.
 */

/** Triangles above which the cyan fill is skipped rather than built. */
export const NAV_PREVIEW_TRIANGLE_CAP = 60_000

/** An oriented box to draw, in world space. `half` is half-extents, before the quaternion. */
export interface NavOverlayBox {
  center: Vec.vec3
  half: Vec.vec3
  quaternion: Vec.quat
  /**
   * True when this box stands for an UNBOUNDED node — it is the extent of the whole gathered level
   * rather than a volume anyone authored. Drawn dimmer, so the two never read as the same thing.
   */
  dimmed: boolean
}

export interface NavOverlayPlan {
  /** The box to draw, or null when there is nothing to stand for (nothing selected, empty level). */
  box: NavOverlayBox | null
  /**
   * The walkable surface to paint, or null when there is none.
   *
   * Non-indexed world-space triangles, ready to become geometry.
   */
  preview: TriangleSoup | null
  /**
   * Set when a preview was suppressed because it exceeded {@link NAV_PREVIEW_TRIANGLE_CAP}, carrying
   * the count that was refused. The inspector says so out loud — a fill that silently does not appear
   * on big levels is the same class of bug this module exists to prevent.
   */
  previewSkipped: number | null
}

const EMPTY_PLAN: NavOverlayPlan = { box: null, preview: null, previewSkipped: null }

/**
 * World AABB of a triangle soup, or null when it holds no triangles.
 *
 * Deliberately not `boundsFromPoints` from `editorHelpers`: that takes `number[][]` (this is a flat
 * `Float32Array`) and also fits a capsule radius nothing here wants.
 */
export function soupBounds(soup: TriangleSoup): { min: Vec.vec3; max: Vec.vec3 } | null {
  const p = soup.positions
  if (p.length < 9) return null

  const min = Vec.vec3.fromValues(Infinity, Infinity, Infinity)
  const max = Vec.vec3.fromValues(-Infinity, -Infinity, -Infinity)
  for (let i = 0; i + 2 < p.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      if (p[i + a] < min[a]) min[a] = p[i + a]
      if (p[i + a] > max[a]) max[a] = p[i + a]
    }
  }
  return { min, max }
}

/**
 * Decide both overlays for one nav-mesh node.
 *
 * `isSelected` is the whole gate. These are authoring aids for the node being placed, not scene
 * furniture — which is also why they are NOT behind the eye menu's "Navigation mesh" toggle: that
 * switch governs the persistent baked wireframe, and hiding a feature's only feedback behind a menu
 * the author has to already know about is how the first version of this shipped invisible.
 */
export function planNavOverlays(
  navMesh: NavMeshNode, soup: TriangleSoup, isSelected: boolean,
): NavOverlayPlan {
  if (!isSelected) return EMPTY_PLAN

  const box = navMesh.bounded ? boundedBox(navMesh) : unboundedBox(soup)

  // `invVolumeMatrix` is null when unbounded, and `clipSoupToVolume` reads that as "keep everything"
  // — which is exactly right, because an unbounded bake really does cover the whole level.
  const walkable = walkableSoup(clipSoupToVolume(soup, navMesh.invVolumeMatrix), navMesh.bake)
  const triangles = walkable.positions.length / 9

  if (triangles < 1) return { box, preview: null, previewSkipped: null }
  if (triangles > NAV_PREVIEW_TRIANGLE_CAP) {
    return { box, preview: null, previewSkipped: triangles }
  }
  return { box, preview: walkable, previewSkipped: null }
}

/**
 * The authored volume: the node's own transform, with `size` as the box's extent.
 *
 * Exported because the viewport helper recomputes it every frame to track the transform gizmo. That
 * is cheap — it reads four vectors off one node — where re-running the whole plan would re-walk the
 * level's triangle soup once a frame.
 */
export function boundedBox(navMesh: NavMeshNode): NavOverlayBox {
  const size = navMesh.size
  const scale = navMesh.worldScale
  return {
    center: Vec.vec3.clone(navMesh.worldPosition),
    quaternion: Vec.quat.clone(navMesh.worldQuaternion),
    // The box is `size` at scale 1, so the node's own scale multiplies it — the convention
    // `NavMeshNode.invVolumeMatrix` uses, and the reason the scale gizmo resizes the volume. Floored
    // so a zero axis stays a visible sliver rather than a degenerate scale.
    half: Vec.vec3.fromValues(
      Math.max(Math.abs(size[0] * scale[0]) / 2, 1e-3),
      Math.max(Math.abs(size[1] * scale[1]) / 2, 1e-3),
      Math.max(Math.abs(size[2] * scale[2]) / 2, 1e-3),
    ),
    dimmed: false,
  }
}

/**
 * The stand-in for an unbounded node: the extent of everything the bake would gather.
 *
 * Axis-aligned and independent of the node's transform, because an unbounded bake is too — moving an
 * unbounded node changes nothing about what it covers, and a box that followed it would imply
 * otherwise.
 */
function unboundedBox(soup: TriangleSoup): NavOverlayBox | null {
  const bounds = soupBounds(soup)
  if (!bounds) return null
  const { min, max } = bounds
  return {
    center: Vec.vec3.fromValues((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2),
    quaternion: Vec.quat.create(),
    half: Vec.vec3.fromValues(
      Math.max((max[0] - min[0]) / 2, 1e-3),
      Math.max((max[1] - min[1]) / 2, 1e-3),
      Math.max((max[2] - min[2]) / 2, 1e-3),
    ),
    dimmed: true,
  }
}

/**
 * Cheap identity of a plan, so the overlay meshes are rebuilt only when they would look different.
 *
 * The box is excluded on purpose — it is repositioned every frame in `onUpdate` rather than rebuilt,
 * so its transform must not churn the cache.
 */
export function navPreviewSignature(plan: NavOverlayPlan): string {
  if (!plan.preview) return `none:${plan.previewSkipped ?? 0}`
  const p = plan.preview.positions
  // Length plus a few sampled coordinates: a rebuild that produced identical geometry should not
  // churn the mesh, and one that moved a triangle differs in at least one of these.
  let hash = 0
  const stride = Math.max(3, Math.floor(p.length / 96))
  for (let i = 0; i < p.length; i += stride) hash += p[i] * (i + 1)
  return `${p.length}|${hash.toFixed(3)}`
}

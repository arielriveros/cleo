import { mat4, vec3 } from 'gl-matrix'
import {
  LandscapeNode, Node, clipSoupToVolume, foliageNavObstacles, heightfieldSoup, isEditorOwnedName, mergeSoups,
  navObstacleFor, navSourceForShape, tessellateSources,
} from 'cleo'
import type { NavObstacle, NavSource, TriangleSoup } from 'cleo'
import type { BodyDescription } from '../features/engineContextTypes'

/**
 * Turning the scene the author is looking at into the triangle soup `bakeNavMesh` wants.
 *
 * The engine half (`src/ai/navSources.ts`) is pure and knows nothing about nodes; this is the impure
 * half that walks the scene graph and the editor's collider map. Keeping them apart is what lets the
 * geometry be unit-tested without standing up a scene.
 *
 * ## Colliders, not render meshes
 *
 * A body's shapes are the input, because they are what the character actually collides with. The
 * alternative -- walking every ModelNode's geometry -- silently gets five things wrong: an invisible
 * collider blocking a corridor has no mesh at all; a LodGroupNode holds three co-located copies of one
 * floor; a skinned mesh contributes a bind pose; wireframe helper geometry is GL_LINES index PAIRS
 * that read as garbage triangles; and a foliage layer is up to 200,000 instances.
 *
 * ## The transform convention, which is not guessable
 *
 * `applyShapeTransform` in editorHelpers is the reference, and it is the order cannon uses: a shape's
 * OFFSET is scaled by the owner's world scale and then rotated, while the shape's DIMENSIONS take that
 * same scale directly. So the node's scale is folded into the primitive's size rather than into the
 * matrix -- putting it in both is how a collider ends up the square of its intended size. That rule
 * now lives in the engine as `navSourceForShape`, so the headless example generators bake with it too.
 *
 * ## Obstacles
 *
 * Every STATIC solid is also handed back as an obstacle for `bakeNavMesh` to carve out of the floor,
 * spheres and capsules included. Left out: dynamic bodies (mass > 0), which move away from where they
 * were baked; ghosts (`simulatePhysics: false`), which nothing collides with; and any node whose
 * variable `navObstacle` is `false` -- a gate that opens, which would otherwise close its route for
 * good. A body can still be walked ON when it is not an obstacle.
 *
 * Collidable foliage (a forest's trunks) carves too, posed as `foliageColliderPose` poses its bodies --
 * but only instances inside the bake volume, since a terrain can carry a hundred thousand of them.
 */

/**
 * Node position + rotation, with SCALE DELIBERATELY LEFT OUT.
 *
 * The scale is applied to each primitive's dimensions instead. A matrix carrying it as well would
 * apply it twice, which reads as a collider that grew quadratically with the node's scale.
 */
function rigidWorldMatrix(node: Node): mat4 {
  return mat4.fromRotationTranslation(mat4.create(), node.worldQuaternion, node.worldPosition)
}

export interface NavBakeGatherOptions {
  /** Colliders, keyed by node id — the editor's authoring-time physics. */
  bodies: Map<string, BodyDescription>
  /** Sample every Nth terrain vertex. 1 is full detail, which an XZ-planar navmesh cannot use. */
  terrainStep?: number
  /** Include terrain heightfields. */
  includeTerrain?: boolean
  /**
   * The navmesh node's bake volume as a world -> unit-cube matrix, or null/absent for the whole
   * scene. Comes straight off `NavMeshNode.invVolumeMatrix`.
   */
  volume?: mat4 | null
}

export interface NavBakeGatherResult {
  soup: TriangleSoup
  /** Bodies that contributed at least one primitive. */
  colliders: number
  /** Terrain nodes sampled. */
  terrains: number
  /** Triangles left after the bake volume clipped the gathered soup. */
  clippedTriangles: number
  /** Static solids for the bake to carve; not clipped, since one just outside the box still pads in. */
  obstacles: NavObstacle[]
}

/** A landscape's collidable foliage instances inside the volume (with a margin), as obstacles. */
function foliageObstaclesOf(node: LandscapeNode, volume: mat4 | null): NavObstacle[] {
  const out: NavObstacle[] = []
  const record = [0, 0, 0, 0, 0]
  const local = vec3.create()
  for (const layer of node.terrain.foliage) {
    if (!layer.collision) continue
    const kept: number[] = []
    for (let i = 0; i < layer.count; i++) {
      if (!layer.instanceAt(i, record)) break
      if (volume) {
        vec3.transformMat4(local, vec3.set(local, record[0], record[1], record[2]), volume)
        if (Math.abs(local[0]) > 0.55 || Math.abs(local[1]) > 0.55 || Math.abs(local[2]) > 0.55) continue
      }
      kept.push(...record)
    }
    out.push(...foliageNavObstacles(kept, layer.collision))
  }
  return out
}

/** The opt-out an author sets on a node -- a gate that opens -- to keep it from carving the floor. */
function isNavObstacle(node: Node, body: BodyDescription): boolean {
  if (body.mass > 0 || body.simulatePhysics === false) return false
  return node.getVariable('navObstacle') !== false
}

/**
 * Walk a scene into a triangle soup.
 *
 * Dormant nodes are included deliberately: `scene.nodes` holds only SPAWNED nodes, but a door that
 * spawns partway through a level is still geometry an agent has to path around, and a navmesh baked
 * without it routes straight through the doorway it will later block.
 */
export function gatherNavSoup(root: Node, options: NavBakeGatherOptions): NavBakeGatherResult {
  const { bodies, includeTerrain = true, terrainStep = 2, volume = null } = options
  const sources: NavSource[] = []
  const soups: TriangleSoup[] = []
  const obstacles: NavObstacle[] = []
  let colliders = 0
  let terrains = 0

  const visit = (node: Node) => {
    // Editor-only helpers are not level geometry. They are also the wireframe meshes whose GL_LINES
    // indices would read as garbage triangles if anything ever walked geometry instead of colliders.
    // By NAME (`isEditorOwnedName`), not `Node.isEditorOwned`: that also honours an explicit flag and
    // inherits it, and a flag-owned preview holder must not take the terrain and meshes under it along.
    if (!isEditorOwnedName(node.name)) {
      const body = bodies.get(node.id)
      if (body && body.shapes.length > 0) {
        const world = rigidWorldMatrix(node)
        const scale = node.worldScale
        const carves = isNavObstacle(node, body)
        let contributed = false
        for (const shape of body.shapes) {
          const source = navSourceForShape(shape, world, scale)
          if (!source) continue
          // A sphere or capsule is solid but has no floor: an obstacle, never a contributor.
          if (source.primitive.kind !== 'sphere' && source.primitive.kind !== 'capsule') {
            contributed = true
            sources.push(source)
          }
          if (carves) {
            const obstacle = navObstacleFor(source)
            if (obstacle) obstacles.push(obstacle)
          }
        }
        if (contributed) colliders++
      }

      if (node instanceof LandscapeNode && node.terrain.foliageColliders.enabled) {
        obstacles.push(...foliageObstaclesOf(node, volume))
      }

      if (includeTerrain && node instanceof LandscapeNode) {
        const terrain = node.terrain
        soups.push(heightfieldSoup({
          heights: terrain.heights,
          resolution: terrain.resolution,
          elementSize: terrain.elementSize,
          origin: [terrain.origin[0], terrain.origin[1], terrain.origin[2]],
        }, terrainStep))
        terrains++
      }
    }
    for (const child of node.children) visit(child)
  }
  visit(root)

  if (sources.length > 0) soups.push(tessellateSources(sources))

  // Clipped AFTER gathering rather than during it. The obvious optimisation is to hand the volume's
  // AABB to `heightfieldSoup` so it never triangulates rows outside the box, and it is worth doing if
  // terrain gathering ever shows up in a profile -- but the bake is a one-shot button and the live
  // preview re-clips a cached soup, so today it would buy nothing and split the clipping logic in two.
  const soup = clipSoupToVolume(mergeSoups(soups), volume)
  return { soup, colliders, terrains, clippedTriangles: soup.positions.length / 9, obstacles }
}

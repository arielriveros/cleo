import { mat4, quat, vec3 } from 'gl-matrix'
import { LandscapeNode, Node, heightfieldSoup, mergeSoups, tessellateSources } from 'cleo'
import type { NavSource, TriangleSoup } from 'cleo'
import type { BodyDescription, ShapeDescription } from '../features/engineContextTypes'

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
 * same scale directly. So the node's scale is folded into the primitive's size here rather than into
 * the matrix -- putting it in both is how a collider ends up the square of its intended size.
 */

/** Degrees, matching Node.rotation and ShapeDescription.rotation. */
const DEG2RAD = Math.PI / 180

/**
 * Node position + rotation, with SCALE DELIBERATELY LEFT OUT.
 *
 * The scale is applied to each primitive's dimensions instead. A matrix carrying it as well would
 * apply it twice, which reads as a collider that grew quadratically with the node's scale.
 */
function rigidWorldMatrix(node: Node): mat4 {
  return mat4.fromRotationTranslation(mat4.create(), node.worldQuaternion, node.worldPosition)
}

/** The shape's own placement inside its body: offset scaled by the owner, then the shape's rotation. */
function shapeLocalMatrix(shape: ShapeDescription, scale: vec3): mat4 {
  const sx = Math.abs(scale[0]), sy = Math.abs(scale[1]), sz = Math.abs(scale[2])
  const rotation = quat.fromEuler(
    quat.create(), shape.rotation[0], shape.rotation[1], shape.rotation[2])
  return mat4.fromRotationTranslation(mat4.create(), rotation, [
    shape.offset[0] * sx, shape.offset[1] * sy, shape.offset[2] * sz,
  ])
}

/**
 * One collider as a placed primitive, or null when it contributes no walkable surface.
 *
 * Spheres and capsules return null on purpose: neither offers a surface an agent can stand on, and
 * subtracting them as obstacles is an operation the baker does not do -- so including them would add
 * a degenerate patch at the apex and nothing else.
 */
function sourceFor(shape: ShapeDescription, world: mat4, scale: vec3): NavSource | null {
  const transform = mat4.multiply(mat4.create(), world, shapeLocalMatrix(shape, scale))
  const sx = Math.abs(scale[0]), sy = Math.abs(scale[1]), sz = Math.abs(scale[2])

  switch (shape.type) {
    case 'box':
      return {
        primitive: { kind: 'box', size: [shape.width * sx, shape.height * sy, shape.depth * sz] },
        transform,
      }
    case 'cylinder': {
      const radial = Math.max(sx, sz)
      return {
        primitive: {
          kind: 'cylinder',
          radius: shape.radius * radial,
          height: shape.height * sy,
          segments: shape.numSegments,
        },
        transform,
      }
    }
    case 'convex':
      // Hull vertices are authored in the node's local space, so the node scale belongs in the matrix
      // for this one -- there is no scalar dimension to fold it into.
      return {
        primitive: { kind: 'convex', vertices: shape.vertices, faces: shape.faces },
        transform: mat4.scale(transform, transform, [sx, sy, sz]),
      }
    case 'plane':
      // cannon's plane is an infinite half-space. `extent` is how much of it is worth emitting; a
      // navmesh over a genuinely infinite floor is not a thing anyone wants baked.
      return { primitive: { kind: 'plane', extent: 100 }, transform }
    default:
      return null
  }
}

export interface NavBakeGatherOptions {
  /** Colliders, keyed by node id — the editor's authoring-time physics. */
  bodies: Map<string, BodyDescription>
  /** Sample every Nth terrain vertex. 1 is full detail, which an XZ-planar navmesh cannot use. */
  terrainStep?: number
  /** Include terrain heightfields. */
  includeTerrain?: boolean
}

export interface NavBakeGatherResult {
  soup: TriangleSoup
  /** Bodies that contributed at least one primitive. */
  colliders: number
  /** Terrain nodes sampled. */
  terrains: number
}

/**
 * Walk a scene into a triangle soup.
 *
 * Dormant nodes are included deliberately: `scene.nodes` holds only SPAWNED nodes, but a door that
 * spawns partway through a level is still geometry an agent has to path around, and a navmesh baked
 * without it routes straight through the doorway it will later block.
 */
export function gatherNavSoup(root: Node, options: NavBakeGatherOptions): NavBakeGatherResult {
  const { bodies, includeTerrain = true, terrainStep = 2 } = options
  const sources: NavSource[] = []
  const soups: TriangleSoup[] = []
  let colliders = 0
  let terrains = 0

  const visit = (node: Node) => {
    // Editor-only helpers are not level geometry. They are also the wireframe meshes whose GL_LINES
    // indices would read as garbage triangles if anything ever walked geometry instead of colliders.
    if (!node.name.includes('__editor__') && !node.name.includes('__debug__')) {
      const body = bodies.get(node.id)
      if (body && body.shapes.length > 0) {
        const world = rigidWorldMatrix(node)
        const scale = node.worldScale
        let contributed = false
        for (const shape of body.shapes) {
          const source = sourceFor(shape, world, scale)
          if (source) { sources.push(source); contributed = true }
        }
        if (contributed) colliders++
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
  return { soup: mergeSoups(soups), colliders, terrains }
}

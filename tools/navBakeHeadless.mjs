// Baking a navmesh into a generated example, the way the editor's Bake button would.
//
// The geometry is the engine's own: navSources.ts (the collider convention, tessellation, carving) and
// navBake.ts are transpiled and run here rather than restated, so a generated bake and an editor bake
// of the same scene agree. What this file owns is the impure half the editor's `gatherNavSoup` does --
// walking a scene -- but over scene JSON instead of live nodes.
//
// Rules shared with the editor (editor/src/utils/navBakeSources.ts):
//   - colliders, not render meshes;
//   - every static solid is also an obstacle, except dynamic bodies (mass > 0), ghosts
//     (`simulatePhysics: false`) and nodes whose variable `navObstacle` is false (gates that open);
//   - triggers are not bodies and contribute nothing.

import path from 'path'
import { createRequire } from 'module'
import { mat4, quat, vec3 } from 'gl-matrix'
import { moduleRegistry } from './nightShift/tsLoader.mjs'

/** The engine's nav modules, loaded once per generator run. */
export function headlessNavBaker(root) {
  const require = createRequire(import.meta.url)
  // './yuka' is the engine's one-file re-export of 'yuka', so the suffix catching both is harmless.
  const load = moduleRegistry({ yuka: require('yuka') })
  const sources = load(path.join(root, 'src', 'ai', 'navSources.ts'))
  const bake = load(path.join(root, 'src', 'ai', 'navBake.ts'))
  const mesh = load(path.join(root, 'src', 'ai', 'navMesh.ts'))

  /**
   * Every collider under `sceneRoot` as surface sources and obstacles.
   * `skip(n)` prunes a subtree (spawns, the player, anything that moves).
   *
   * The world rotation is composed as quaternions down the tree rather than read back off the world
   * matrix: `mat4.getRotation` assumes an unscaled matrix, and a ramp scaled [3, 0.4, 5.3] and tilted
   * 16.5 degrees came back stood on end (Node._updateWorldCache divides the scale out first for the
   * same reason). The scale is the world matrix's column lengths, which is what `Node.worldScale` is.
   */
  function gather(sceneRoot, { skip = () => false } = {}) {
    const surface = []
    const obstacles = []
    const visit = (n, parent) => {
      if (skip(n)) return
      const r = n.rotation ?? [0, 0, 0]
      const localQ = quat.fromEuler(quat.create(), r[0], r[1], r[2])
      const localS = n.scale ?? [1, 1, 1]
      const matrix = mat4.multiply(mat4.create(), parent.matrix,
        mat4.fromRotationTranslationScale(mat4.create(), localQ, n.position ?? [0, 0, 0], localS))
      const rotation = quat.multiply(quat.create(), parent.rotation, localQ)
      const scale = mat4.getScaling(vec3.create(), matrix)
      const world = { matrix, rotation }

      const body = n.body
      if (body && Array.isArray(body.shapes) && body.shapes.length > 0) {
        const position = mat4.getTranslation(vec3.create(), matrix)
        const rigid = mat4.fromRotationTranslation(mat4.create(), rotation, position)
        const carves = !(body.mass > 0) && body.simulatePhysics !== false && n.variables?.navObstacle?.value !== false
        for (const shape of body.shapes) {
          const source = sources.navSourceForShape(shape, rigid, scale)
          if (!source) continue
          if (source.primitive.kind !== 'sphere' && source.primitive.kind !== 'capsule') surface.push(source)
          if (carves) {
            const obstacle = sources.navObstacleFor(source)
            if (obstacle) obstacles.push(obstacle)
          }
        }
      }
      for (const c of n.children ?? []) visit(c, world)
    }
    visit(sceneRoot, { matrix: mat4.create(), rotation: quat.create() })
    return { surface, obstacles }
  }

  /**
   * Bake, and return the fields to write onto the navmesh node.
   *
   * `volume` is `{ position, size }` (unrotated) or null for the whole scene; `soups` are extra
   * surfaces such as a terrain heightfield; `obstacles` extra solids such as tree trunks.
   */
  function bakeInto(navNode, { surface = [], soups = [], obstacles = [], volume = null, settings = {} }) {
    const all = sources.mergeSoups([...soups, sources.tessellateSources(surface)])
    let inv = null
    let bounds = null
    if (volume) {
      const box = mat4.fromRotationTranslationScale(mat4.create(), quat.create(), volume.position, volume.size)
      inv = mat4.invert(mat4.create(), box)
      bounds = [0, 1, 2].map(a => volume.position[a] - volume.size[a] / 2)
        .concat([0, 1, 2].map(a => volume.position[a] + volume.size[a] / 2))
    }
    const soup = sources.clipSoupToVolume(all, inv)
    const bakeSettings = bake.navBakeSettings({ ...(navNode.bake ?? {}), ...settings })
    const started = Date.now()
    const result = bake.bakeNavMesh(soup, bakeSettings, { obstacles, agentRadius: navNode.agentRadius ?? 0.4 })
    navNode.bake = { ...bakeSettings }
    const data = mesh.serializeNavMeshData(result.data)
    if (data) navNode.navMesh = data
    else delete navNode.navMesh
    if (bounds) navNode.bakedVolume = bounds
    return {
      regions: result.regions,
      triangles: soup.positions.length / 9,
      obstacles: obstacles.length,
      ms: Date.now() - started,
      bytes: data ? data.vertices.length + data.counts.length : 0,
      data: result.data,
    }
  }

  return { gather, bakeInto, sources, mesh }
}

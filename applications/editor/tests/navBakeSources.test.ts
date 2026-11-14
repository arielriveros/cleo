import { describe, it, expect } from 'vitest'
import { ColliderNode, NavMeshNode, Node, bakeNavMesh } from 'cleo'
import { gatherNavSoup } from '../src/utils/navBakeSources'

// The gatherer is where the scene's Collider nodes meet the engine's baker, and the transform convention
// across that seam is not guessable: a shape's OFFSET is scaled by the owner's world scale and then
// rotated, while the shape's DIMENSIONS take that same scale directly (this is the order cannon and
// `applyShapeTransform` use). Folding the scale into BOTH the matrix and the size makes a collider grow
// quadratically with its node, which looks almost right until a node is scaled past 2.
//
// So every assertion here is about WHERE the walkable surface landed, in world units, rather than
// about the shapes that went in.

/** What a Collider is set up with: its shapes and whichever of its fields a test changes. */
type BodySpec = Partial<Pick<ColliderNode, 'mass' | 'simulatePhysics'>> & { shapes: any[] }

function box(width: number, height: number, depth: number, over: Partial<BodySpec> = {}): BodySpec {
  return { shapes: [{ type: 'box', offset: [0, 0, 0], rotation: [0, 0, 0], width, height, depth }], ...over }
}

/** A Collider node named `name`, set up with `body`. */
function collider(name: string, body: BodySpec): ColliderNode {
  const node = new ColliderNode(name)
  Object.assign(node, body)
  return node
}

/** Bake what the gatherer produced and report where the walkable surface ended up. */
function surfaceOf(root: Node) {
  const gathered = gatherNavSoup(root, { includeTerrain: false })
  const result = bakeNavMesh(gathered.soup)
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  const v = result.data.vertices
  for (let i = 0; i < v.length; i += 3) {
    minX = Math.min(minX, v[i]); maxX = Math.max(maxX, v[i])
    minY = Math.min(minY, v[i + 1]); maxY = Math.max(maxY, v[i + 1])
  }
  return { ...result, ...gathered, minX, maxX, minY, maxY }
}

/** A root with one Collider child, transforms already resolved. */
function sceneWith(configure: (node: Node) => void, body: BodySpec) {
  const root = new Node('root')
  const floor = collider('floor', body)
  root.addChild(floor)
  configure(floor)
  root.updateTransforms()
  return root
}

describe('gatherNavSoup', () => {
  it('bakes a box collider into a surface on top of it', () => {
    const surface = surfaceOf(sceneWith(() => {}, box(4, 2, 4)))

    expect(surface.colliders).toBe(1)
    expect(surface.regions).toBeGreaterThan(0)
    // The top face of a 2-tall box centred on the origin.
    expect(surface.minY).toBeCloseTo(1, 5)
    expect(surface.minX).toBeCloseTo(-2, 5)
    expect(surface.maxX).toBeCloseTo(2, 5)
  })

  it('places the surface at the node world position', () => {
    const surface = surfaceOf(sceneWith(n => n.setPosition([10, 5, 0]), box(4, 2, 4)))
    expect(surface.minY).toBeCloseTo(6, 5)
    expect(surface.minX).toBeCloseTo(8, 5)
  })

  // The trap. Scale belongs in the primitive's dimensions OR the matrix, never both.
  it('applies node scale exactly once', () => {
    const surface = surfaceOf(sceneWith(n => n.setUniformScale(3), box(4, 2, 4)))
    // 4 wide x 3 = 12, so -6..6. Applied twice it would be 36 wide.
    expect(surface.minX).toBeCloseTo(-6, 4)
    expect(surface.maxX).toBeCloseTo(6, 4)
    // 2 tall x 3 = 6, half of it above the origin.
    expect(surface.minY).toBeCloseTo(3, 4)
  })

  it('scales a shape offset by the owner scale, as cannon does', () => {
    const body = box(2, 2, 2)
    body.shapes[0].offset = [2, 0, 0]
    const surface = surfaceOf(sceneWith(n => n.setUniformScale(2), body))
    // Offset 2 x scale 2 = 4, and the box is 2 x 2 = 4 wide, so 2..6.
    expect(surface.minX).toBeCloseTo(2, 4)
    expect(surface.maxX).toBeCloseTo(6, 4)
  })

  it('inherits a parent transform', () => {
    const root = new Node('root')
    const pivot = new Node('pivot')
    root.addChild(pivot)
    pivot.addChild(collider('floor', box(4, 2, 4)))
    pivot.setPosition([0, 10, 0])
    root.updateTransforms()

    expect(surfaceOf(root).minY).toBeCloseTo(11, 5)
  })

  it('skips nodes that are not colliders, and reports how many contributed', () => {
    const root = new Node('root')
    root.addChild(collider('floor', box(4, 2, 4)))
    root.addChild(new Node('decoration'))
    root.updateTransforms()

    expect(gatherNavSoup(root, { includeTerrain: false }).colliders).toBe(1)
  })

  // Those are the wireframe helper meshes whose GL_LINES indices read as garbage triangles, and the
  // billboards for lights. Neither is level geometry.
  it('ignores editor and debug helper nodes', () => {
    const root = new Node('root')
    root.addChild(collider('__editor__ShapeHelper', box(4, 2, 4)))
    root.addChild(collider('__debug__Something', box(4, 2, 4)))
    root.updateTransforms()

    expect(gatherNavSoup(root, { includeTerrain: false }).colliders).toBe(0)
  })

  it('produces nothing for a collider with no shapes', () => {
    const body = box(1, 1, 1)
    body.shapes = []
    expect(gatherNavSoup(sceneWith(() => {}, body), { includeTerrain: false }).colliders).toBe(0)
  })

  // A sphere has no surface an agent can stand on -- tessellating it would add a degenerate patch at
  // the apex -- but it is still solid, so it comes back as an obstacle to carve.
  it('takes no surface from spheres and capsules, only obstacles', () => {
    const body = box(1, 1, 1)
    body.shapes = [
      { type: 'sphere', offset: [0, 0, 0], rotation: [0, 0, 0], radius: 2 },
      { type: 'capsule', offset: [0, 0, 0], rotation: [0, 0, 0], radius: 1, height: 4, numSegments: 8 },
    ]
    const gathered = gatherNavSoup(sceneWith(() => {}, body), { includeTerrain: false })
    expect(gathered.colliders).toBe(0)
    expect(gathered.soup.positions.length).toBe(0)
    expect(gathered.obstacles).toHaveLength(2)
  })

  it('bakes two abutting floors into one connected surface', () => {
    const root = new Node('root')
    const left = collider('left', box(4, 1, 4))
    const right = collider('right', box(4, 1, 4))
    root.addChild(left)
    root.addChild(right)
    left.setPosition([-2, 0, 0])
    right.setPosition([2, 0, 0])
    root.updateTransforms()

    const gathered = gatherNavSoup(root, { includeTerrain: false })
    const result = bakeNavMesh(gathered.soup)
    expect(result.regions).toBeGreaterThan(0)
    expect(gathered.colliders).toBe(2)
  })

  it('gathers a collider inside another as a body of its own', () => {
    const root = new Node('root')
    const outer = collider('outer', box(4, 1, 4))
    root.addChild(outer)
    outer.addChild(collider('inner', box(1, 1, 1)))
    root.updateTransforms()
    expect(gatherNavSoup(root, { includeTerrain: false }).colliders).toBe(2)
  })
})

// ---------------------------------------------------------------------------------------------------
// Baking through a bounds volume
//
// The volume is what turns "navigate the level" into "navigate this room", so what matters is that the
// clip happens on the way OUT of the gatherer -- the bake, the editor's cyan preview and the "fit to
// scene" button all read the same soup, and only one of them may be restricted.
// ---------------------------------------------------------------------------------------------------

/** A floor centred at the origin, plus a second one far away on +X. */
function twoFloors() {
  const root = new Node('root')
  const far = collider('far', box(4, 1, 4))
  root.addChild(collider('near', box(4, 1, 4)))
  root.addChild(far)
  far.setPosition([50, 0, 0])
  root.updateTransforms()
  return root
}

describe('gatherNavSoup with a bake volume', () => {
  it('gathers the whole scene when the volume is absent', () => {
    const gathered = gatherNavSoup(twoFloors(), { includeTerrain: false })
    expect(gathered.colliders).toBe(2)
    expect(gathered.clippedTriangles).toBe(gathered.soup.positions.length / 9)
  })

  it('keeps only the geometry inside the volume', () => {
    const root = twoFloors()
    const nav = new NavMeshNode('nav')
    nav.size = [20, 20, 20]
    nav.updateTransforms()

    const gathered = gatherNavSoup(root, { includeTerrain: false, volume: nav.invVolumeMatrix })
    // Both colliders were VISITED -- the count reports what was gathered, not what survived -- but the
    // far floor at x = 50 must contribute no triangles.
    expect(gathered.colliders).toBe(2)
    for (let i = 0; i < gathered.soup.positions.length; i += 3)
      expect(gathered.soup.positions[i]).toBeLessThan(11)
    expect(gathered.clippedTriangles).toBeGreaterThan(0)
  })

  it('moves what gets baked when the volume moves, which is the whole point of placing one', () => {
    const root = twoFloors()
    const nav = new NavMeshNode('nav')
    nav.size = [20, 20, 20]

    nav.updateTransforms()
    const atOrigin = bakeNavMesh(gatherNavSoup(root, { includeTerrain: false, volume: nav.invVolumeMatrix }).soup)

    nav.setPosition([50, 0, 0])
    nav.updateTransforms()
    const atFarFloor = bakeNavMesh(gatherNavSoup(root, { includeTerrain: false, volume: nav.invVolumeMatrix }).soup)

    expect(atOrigin.regions).toBeGreaterThan(0)
    expect(atFarFloor.regions).toBeGreaterThan(0)
    // Same shape of surface, in two different places.
    expect(atOrigin.data.vertices[0]).toBeLessThan(11)
    expect(atFarFloor.data.vertices[0]).toBeGreaterThan(39)
  })

  it('bakes nothing when the volume encloses no walkable surface', () => {
    const root = twoFloors()
    const nav = new NavMeshNode('nav')
    nav.size = [4, 4, 4]
    nav.setPosition([0, 40, 0]) // up in the air
    nav.updateTransforms()

    const gathered = gatherNavSoup(root, { includeTerrain: false, volume: nav.invVolumeMatrix })
    expect(gathered.clippedTriangles).toBe(0)
    expect(bakeNavMesh(gathered.soup).regions).toBe(0)
  })

  it('clips terrain as well as colliders', () => {
    const root = twoFloors()
    const nav = new NavMeshNode('nav')
    nav.size = [2, 20, 2]
    nav.updateTransforms()

    const whole = gatherNavSoup(root, { includeTerrain: false })
    const clipped = gatherNavSoup(root, { includeTerrain: false, volume: nav.invVolumeMatrix })
    expect(clipped.clippedTriangles).toBeLessThan(whole.clippedTriangles)
    expect(clipped.clippedTriangles).toBeGreaterThan(0)
  })
})

describe('gatherNavSoup obstacles', () => {
  /** A floor plus one more Collider, configured by the caller. */
  function floorAnd(configure: (node: Node) => void, body: BodySpec) {
    const root = new Node('root')
    const floor = collider('floor', box(10, 0.5, 10))
    const other = collider('other', body)
    root.addChild(floor)
    root.addChild(other)
    floor.setPosition([0, -0.25, 0])
    configure(other)
    root.updateTransforms()
    return gatherNavSoup(root, { includeTerrain: false })
  }

  it('hands back every static collider, and a pillar carves the floor around it', () => {
    const gathered = floorAnd(n => n.setPosition([0, 1.5, 0]), box(1, 3, 1))
    expect(gathered.obstacles).toHaveLength(2)

    const result = bakeNavMesh(gathered.soup, undefined, { obstacles: gathered.obstacles, agentRadius: 0.5 })
    const plain = bakeNavMesh(gathered.soup)
    expect(result.regions).toBeGreaterThan(plain.regions)
  })

  it('skips dynamic bodies, ghosts and colliders flagged navObstacle = false', () => {
    expect(floorAnd(() => {}, box(1, 3, 1, { mass: 5 })).obstacles).toHaveLength(1)
    expect(floorAnd(() => {}, box(1, 3, 1, { simulatePhysics: false })).obstacles).toHaveLength(1)
    expect(floorAnd(n => n.setVariable('navObstacle', false, 'boolean'), box(1, 3, 1)).obstacles).toHaveLength(1)
    // A body converted from the old form keeps its node's variables on the node under the Collider.
    expect(floorAnd(n => {
      const gate = new Node('gate')
      gate.setVariable('navObstacle', false, 'boolean')
      n.addChild(gate)
    }, box(1, 3, 1)).obstacles).toHaveLength(1)
  })
})

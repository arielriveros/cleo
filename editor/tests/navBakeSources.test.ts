import { describe, it, expect } from 'vitest'
import { NavMeshNode, Node, bakeNavMesh } from 'cleo'
import { gatherNavSoup } from '../src/utils/navBakeSources'
import type { BodyDescription } from '../src/features/engineContextTypes'

// The gatherer is where the editor's collider descriptions meet the engine's baker, and the transform
// convention across that seam is not guessable: a shape's OFFSET is scaled by the owner's world scale
// and then rotated, while the shape's DIMENSIONS take that same scale directly (this is the order
// cannon and `applyShapeTransform` use). Folding the scale into BOTH the matrix and the size makes a
// collider grow quadratically with its node, which looks almost right until a node is scaled past 2.
//
// So every assertion here is about WHERE the walkable surface landed, in world units, rather than
// about the shapes that went in.

function box(width: number, height: number, depth: number, over: Partial<BodyDescription> = {}): BodyDescription {
  return {
    mass: 0,
    linearDamping: 0,
    angularDamping: 0,
    linearConstraints: [1, 1, 1],
    angularConstraints: [1, 1, 1],
    shapes: [{ type: 'box', offset: [0, 0, 0], rotation: [0, 0, 0], width, height, depth }],
    ...over,
  } as BodyDescription
}

/** Bake what the gatherer produced and report where the walkable surface ended up. */
function surfaceOf(root: Node, bodies: Map<string, BodyDescription>) {
  const gathered = gatherNavSoup(root, { bodies, includeTerrain: false })
  const result = bakeNavMesh(gathered.soup)
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  const v = result.data.vertices
  for (let i = 0; i < v.length; i += 3) {
    minX = Math.min(minX, v[i]); maxX = Math.max(maxX, v[i])
    minY = Math.min(minY, v[i + 1]); maxY = Math.max(maxY, v[i + 1])
  }
  return { ...result, ...gathered, minX, maxX, minY, maxY }
}

/** A root with one child carrying a collider, transforms already resolved. */
function sceneWith(configure: (node: Node) => void, body: BodyDescription) {
  const root = new Node('root')
  const floor = new Node('floor')
  root.addChild(floor)
  configure(floor)
  root.updateTransforms()
  return { root, bodies: new Map([[floor.id, body]]) }
}

describe('gatherNavSoup', () => {
  it('bakes a box collider into a surface on top of it', () => {
    const { root, bodies } = sceneWith(() => {}, box(4, 2, 4))
    const surface = surfaceOf(root, bodies)

    expect(surface.colliders).toBe(1)
    expect(surface.regions).toBeGreaterThan(0)
    // The top face of a 2-tall box centred on the origin.
    expect(surface.minY).toBeCloseTo(1, 5)
    expect(surface.minX).toBeCloseTo(-2, 5)
    expect(surface.maxX).toBeCloseTo(2, 5)
  })

  it('places the surface at the node world position', () => {
    const { root, bodies } = sceneWith(n => n.setPosition([10, 5, 0]), box(4, 2, 4))
    const surface = surfaceOf(root, bodies)
    expect(surface.minY).toBeCloseTo(6, 5)
    expect(surface.minX).toBeCloseTo(8, 5)
  })

  // The trap. Scale belongs in the primitive's dimensions OR the matrix, never both.
  it('applies node scale exactly once', () => {
    const { root, bodies } = sceneWith(n => n.setUniformScale(3), box(4, 2, 4))
    const surface = surfaceOf(root, bodies)
    // 4 wide x 3 = 12, so -6..6. Applied twice it would be 36 wide.
    expect(surface.minX).toBeCloseTo(-6, 4)
    expect(surface.maxX).toBeCloseTo(6, 4)
    // 2 tall x 3 = 6, half of it above the origin.
    expect(surface.minY).toBeCloseTo(3, 4)
  })

  it('scales a shape offset by the owner scale, as cannon does', () => {
    const body = box(2, 2, 2)
    body.shapes[0].offset = [2, 0, 0]
    const { root, bodies } = sceneWith(n => n.setUniformScale(2), body)
    const surface = surfaceOf(root, bodies)
    // Offset 2 x scale 2 = 4, and the box is 2 x 2 = 4 wide, so 2..6.
    expect(surface.minX).toBeCloseTo(2, 4)
    expect(surface.maxX).toBeCloseTo(6, 4)
  })

  it('inherits a parent transform', () => {
    const root = new Node('root')
    const pivot = new Node('pivot')
    const floor = new Node('floor')
    root.addChild(pivot)
    pivot.addChild(floor)
    pivot.setPosition([0, 10, 0])
    root.updateTransforms()

    const surface = surfaceOf(root, new Map([[floor.id, box(4, 2, 4)]]))
    expect(surface.minY).toBeCloseTo(11, 5)
  })

  it('skips nodes with no collider, and reports how many contributed', () => {
    const root = new Node('root')
    const withBody = new Node('floor')
    const without = new Node('decoration')
    root.addChild(withBody)
    root.addChild(without)
    root.updateTransforms()

    const gathered = gatherNavSoup(root, { bodies: new Map([[withBody.id, box(4, 2, 4)]]), includeTerrain: false })
    expect(gathered.colliders).toBe(1)
  })

  // Those are the wireframe helper meshes whose GL_LINES indices read as garbage triangles, and the
  // billboards for lights. Neither is level geometry.
  it('ignores editor and debug helper nodes', () => {
    const root = new Node('root')
    const helper = new Node('__editor__ShapeHelper')
    const debug = new Node('__debug__Something')
    root.addChild(helper)
    root.addChild(debug)
    root.updateTransforms()

    const bodies = new Map([[helper.id, box(4, 2, 4)], [debug.id, box(4, 2, 4)]])
    expect(gatherNavSoup(root, { bodies, includeTerrain: false }).colliders).toBe(0)
  })

  it('produces nothing for a body with no shapes', () => {
    const body = box(1, 1, 1)
    body.shapes = []
    const { root, bodies } = sceneWith(() => {}, body)
    expect(gatherNavSoup(root, { bodies, includeTerrain: false }).colliders).toBe(0)
  })

  // A sphere has no surface an agent can stand on, and subtracting it as an obstacle is an operation
  // the baker does not do -- so including it would contribute a degenerate patch at the apex.
  it('skips spheres and capsules', () => {
    const body = box(1, 1, 1)
    body.shapes = [
      { type: 'sphere', offset: [0, 0, 0], rotation: [0, 0, 0], radius: 2 },
      { type: 'capsule', offset: [0, 0, 0], rotation: [0, 0, 0], radius: 1, height: 4, numSegments: 8 },
    ] as BodyDescription['shapes']
    const { root, bodies } = sceneWith(() => {}, body)
    expect(gatherNavSoup(root, { bodies, includeTerrain: false }).colliders).toBe(0)
  })

  it('bakes two abutting floors into one connected surface', () => {
    const root = new Node('root')
    const left = new Node('left')
    const right = new Node('right')
    root.addChild(left)
    root.addChild(right)
    left.setPosition([-2, 0, 0])
    right.setPosition([2, 0, 0])
    root.updateTransforms()

    const bodies = new Map([[left.id, box(4, 1, 4)], [right.id, box(4, 1, 4)]])
    const gathered = gatherNavSoup(root, { bodies, includeTerrain: false })
    const result = bakeNavMesh(gathered.soup)
    expect(result.regions).toBeGreaterThan(0)
    expect(gathered.colliders).toBe(2)
  })
})

// ---------------------------------------------------------------------------------------------------
// Baking through a bounds volume
//
// The volume is what turns "navigate the level" into "navigate this room", so what matters is that the
// clip happens on the way OUT of the gatherer -- the bake, the editor's cyan preview and the "fit to
// scene" button all read the same soup, and only one of them may be restricted.
// ---------------------------------------------------------------------------------------------------

/** A floor of `size` centred at the origin, plus a second one far away on +X. */
function twoFloors() {
  const root = new Node('root')
  const near = new Node('near')
  const far = new Node('far')
  root.addChild(near)
  root.addChild(far)
  far.setPosition([50, 0, 0])
  root.updateTransforms()
  return { root, bodies: new Map([[near.id, box(4, 1, 4)], [far.id, box(4, 1, 4)]]) }
}

describe('gatherNavSoup with a bake volume', () => {
  it('gathers the whole scene when the volume is absent', () => {
    const { root, bodies } = twoFloors()
    const gathered = gatherNavSoup(root, { bodies, includeTerrain: false })
    expect(gathered.colliders).toBe(2)
    expect(gathered.clippedTriangles).toBe(gathered.soup.positions.length / 9)
  })

  it('keeps only the geometry inside the volume', () => {
    const { root, bodies } = twoFloors()
    const nav = new NavMeshNode('nav')
    nav.size = [20, 20, 20]
    nav.updateTransforms()

    const gathered = gatherNavSoup(root, { bodies, includeTerrain: false, volume: nav.invVolumeMatrix })
    // Both colliders were VISITED -- the count reports what was gathered, not what survived -- but the
    // far floor at x = 50 must contribute no triangles.
    expect(gathered.colliders).toBe(2)
    for (let i = 0; i < gathered.soup.positions.length; i += 3)
      expect(gathered.soup.positions[i]).toBeLessThan(11)
    expect(gathered.clippedTriangles).toBeGreaterThan(0)
  })

  it('moves what gets baked when the volume moves, which is the whole point of placing one', () => {
    const { root, bodies } = twoFloors()
    const nav = new NavMeshNode('nav')
    nav.size = [20, 20, 20]

    nav.updateTransforms()
    const atOrigin = bakeNavMesh(
      gatherNavSoup(root, { bodies, includeTerrain: false, volume: nav.invVolumeMatrix }).soup)

    nav.setPosition([50, 0, 0])
    nav.updateTransforms()
    const atFarFloor = bakeNavMesh(
      gatherNavSoup(root, { bodies, includeTerrain: false, volume: nav.invVolumeMatrix }).soup)

    expect(atOrigin.regions).toBeGreaterThan(0)
    expect(atFarFloor.regions).toBeGreaterThan(0)
    // Same shape of surface, in two different places.
    expect(atOrigin.data.vertices[0]).toBeLessThan(11)
    expect(atFarFloor.data.vertices[0]).toBeGreaterThan(39)
  })

  it('bakes nothing when the volume encloses no walkable surface', () => {
    const { root, bodies } = twoFloors()
    const nav = new NavMeshNode('nav')
    nav.size = [4, 4, 4]
    nav.setPosition([0, 40, 0]) // up in the air
    nav.updateTransforms()

    const gathered = gatherNavSoup(root, { bodies, includeTerrain: false, volume: nav.invVolumeMatrix })
    expect(gathered.clippedTriangles).toBe(0)
    expect(bakeNavMesh(gathered.soup).regions).toBe(0)
  })

  it('clips terrain as well as colliders', () => {
    const { root, bodies } = twoFloors()
    const nav = new NavMeshNode('nav')
    nav.size = [2, 20, 2]
    nav.updateTransforms()

    const whole = gatherNavSoup(root, { bodies, includeTerrain: false })
    const clipped = gatherNavSoup(root, { bodies, includeTerrain: false, volume: nav.invVolumeMatrix })
    expect(clipped.clippedTriangles).toBeLessThan(whole.clippedTriangles)
    expect(clipped.clippedTriangles).toBeGreaterThan(0)
  })
})

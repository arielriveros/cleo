import { describe, it, expect } from 'vitest'
import { Node, ModelNode, ColliderNode, Model, Geometry, Material } from 'cleo'
import { collectHullPositions, hullSourceTree } from '../src/utils/editorHelpers'
import { hullEntryState, hullSourcesFor, includedMeshes, inHullSources, toggleHullEntry } from '../src/utils/hullSources'

// Which meshes a convex hull is built from: the tree the Meshes picker lists, the `sources` it writes, and the
// vertices a hull then takes.

/** A box of eight corners, `size` across, centred on the node. */
const box = (size: number) => {
  const h = size / 2
  const corners: number[][] = []
  for (const x of [-h, h]) for (const y of [-h, h]) for (const z of [-h, h]) corners.push([x, y, z])
  return new Geometry(corners, corners.map(() => [0, 1, 0]), corners.map(() => [0, 0]), [], [], [0, 1, 2, 1, 3, 2])
}
/** A mesh node, its Model built without its constructor (which would allocate a GPU mesh: there is no device). */
const mesh = (name: string, size = 1) => {
  const m = Object.create(Model.prototype)
  Object.assign(m, { _geometry: box(size), _materials: [Material.PBR({ baseColor: [1, 1, 1], roughness: 0.5, metallic: 0 })], _submeshes: [], _geometryVersion: 0 })
  return new ModelNode(name, m)
}
const node = (name: string, ...children: Node[]) => { const n = new Node(name); for (const c of children) n.addChild(c); return n }

/** A car: its body and windows under Body (a badge on the body), a wheel's tyre under Vehicle, a door of its own. */
function car() {
  const root = new ColliderNode('Car')
  const body = mesh('Body', 2)
  body.addChild(mesh('Badge', 0.1))
  root.addChild(node('Body', body, mesh('Glass', 1.5)))
  root.addChild(node('Vehicle', node('Wheels', node('Wheel FL', node('Tyre', mesh('Tyre', 0.6))))))
  // Not listed: a door is a body of its own, an editor helper is not the scene's, an empty node has nothing.
  const door = new ColliderNode('Door')
  door.addChild(mesh('Door Panel'))
  root.addChild(door)
  root.addChild(mesh('__editor__Helper'))
  root.addChild(node('Empty'))
  return root
}

describe('a hull\'s meshes', () => {
  it('lists the meshes under the node, and what leads to them, by their name paths', () => {
    const tree = hullSourceTree(car())
    expect(tree.map(e => [e.path, e.depth, e.mesh])).toEqual([
      ['', 0, false],
      ['Body', 1, false], ['Body/Body', 2, true], ['Body/Body/Badge', 3, true], ['Body/Glass', 2, true],
      ['Vehicle', 1, false], ['Vehicle/Wheels', 2, false], ['Vehicle/Wheels/Wheel FL', 3, false],
      ['Vehicle/Wheels/Wheel FL/Tyre', 4, false], ['Vehicle/Wheels/Wheel FL/Tyre/Tyre', 5, true],
    ])
  })

  it('takes a node and everything under it, a node\'s own mesh alone with /., and every mesh without sources', () => {
    expect(inHullSources('Body/Glass', ['Body'])).toBe(true)
    expect(inHullSources('Bodywork', ['Body'])).toBe(false)
    expect(inHullSources('Body/Body/Badge', ['Body/Body/.'])).toBe(false)
    expect(inHullSources('Body/Body', ['Body/Body/.'])).toBe(true)
    expect(inHullSources('', ['.'])).toBe(true)
    expect(inHullSources('Body', ['.'])).toBe(false)
    expect(inHullSources('anything', undefined)).toBe(true)
    expect(inHullSources('anything', [])).toBe(false)
  })

  it('writes the fewest sources that say what is ticked', () => {
    const tree = hullSourceTree(car())
    const all = includedMeshes(tree)
    expect(hullSourcesFor(tree, all)).toBeUndefined()
    expect(hullSourcesFor(tree, new Set())).toEqual([])
    // The body and its windows, not the wheel: the Body node.
    const body = includedMeshes(tree, ['Body'])
    expect([...body].sort()).toEqual(['Body/Body', 'Body/Body/Badge', 'Body/Glass'])
    expect(hullSourcesFor(tree, body)).toEqual(['Body'])
    // Untick the windows: the body mesh and what is under it.
    const glass = tree.findIndex(e => e.path === 'Body/Glass')
    expect(hullSourcesFor(tree, toggleHullEntry(tree, glass, body))).toEqual(['Body/Body'])
    // Untick the badge too: the body mesh alone.
    const badge = tree.findIndex(e => e.path === 'Body/Body/Badge')
    expect(hullSourcesFor(tree, toggleHullEntry(tree, badge, toggleHullEntry(tree, glass, body)))).toEqual(['Body/Body/.'])
  })

  it('ticks a node by ticking everything under it, and shows part-way when some is', () => {
    const tree = hullSourceTree(car())
    const bodyAt = tree.findIndex(e => e.path === 'Body')
    const none = new Set<string>()
    expect(hullEntryState(tree, bodyAt, none)).toBe('none')
    const ticked = toggleHullEntry(tree, bodyAt, none)
    expect(hullEntryState(tree, bodyAt, ticked)).toBe('all')
    expect(hullEntryState(tree, 0, ticked)).toBe('some')
    expect(hullEntryState(tree, bodyAt, toggleHullEntry(tree, bodyAt, ticked))).toBe('none')
    // A part-way node ticks the rest on.
    expect(hullEntryState(tree, 0, toggleHullEntry(tree, 0, ticked))).toBe('all')
  })

  it('builds from the meshes its sources name, in the node\'s space', () => {
    const root = car()
    root.updateTransforms(null)
    const every = collectHullPositions(root)!
    const body = collectHullPositions(root, root, ['Body'])!
    const tyre = collectHullPositions(root, root, ['Vehicle'])!
    // Eight corners a mesh: body, badge, glass and tyre (not the door's, nor the helper's).
    expect([every.length, body.length, tyre.length]).toEqual([32, 24, 8])
    expect(Math.max(...tyre.map(v => v[0]))).toBeCloseTo(0.3, 5)
    expect(collectHullPositions(root, root, [])).toBeNull()
  })
})

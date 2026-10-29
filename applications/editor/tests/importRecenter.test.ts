import { describe, it, expect } from 'vitest'
import { Node } from 'cleo'
import { recenterIfOffOrigin } from '../src/utils/models'

// A Sketchfab pine baked its scene placement into the glTF root matrix: 20 m tall, 365 m below and
// 367 m away from the origin. The plain and merge-only import paths kept that verbatim, so the model tab
// showed nothing and the tree dropped out of sight wherever it was placed; only the grouped path (both
// modal toggles on) re-centred.

/** A part whose bounds are a unit sphere around its world position. */
function part(name: string, at: [number, number, number]): Node {
  const n = new Node(name)
  n.setPosition(at)
  ;(n as any).getBoundingSphere = () => ({ center: [...(n as any).worldPosition], radius: 1 })
  return n
}

function rooted(...parts: Node[]): Node {
  const root = new Node('Import')
  for (const p of parts) root.addChild(p)
  root.updateTransforms()
  return root
}

describe('recenterIfOffOrigin', () => {
  it('brings a far-off model back to the origin, keeping its parts\' layout', () => {
    const a = part('Bark', [-15, -365, 367]), b = part('Leaves', [-15, -355, 367])
    const root = rooted(a, b)
    expect(recenterIfOffOrigin(root, [a, b])).toBe(true)
    expect([...a.position].map(v => Math.round(v))).toEqual([0, -5, 0])
    expect([...b.position].map(v => Math.round(v))).toEqual([0, 5, 0])
  })

  it('leaves a model authored around its own pivot alone', () => {
    const feet = part('Body', [0, 0.9, 0])   // bounds reach y -0.1: the origin is inside
    const root = rooted(feet)
    expect(recenterIfOffOrigin(root, [feet])).toBe(false)
    expect(feet.position[1]).toBeCloseTo(0.9)
  })

  it('converts through the root scale a fit-to-size import puts on the root', () => {
    const a = part('Far', [100, 0, 0])
    const root = rooted(a)
    root.setScale([2, 2, 2])
    root.updateTransforms()
    expect(recenterIfOffOrigin(root, [a])).toBe(true)
    root.updateTransforms()
    expect(Math.abs((a as any).worldPosition[0])).toBeLessThan(1e-4)
  })
})

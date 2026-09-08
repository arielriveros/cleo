import { describe, it, expect } from 'vitest'
import { NavMeshNode } from 'cleo'
import type { TriangleSoup } from 'cleo'
import {
  NAV_PREVIEW_TRIANGLE_CAP, boundedBox, navPreviewSignature, planNavOverlays, soupBounds,
} from '../src/utils/navOverlayPlan'

/**
 * The coverage that was missing when these overlays first shipped INVISIBLE.
 *
 * The geometry going in and the bake coming out were both tested and both fine. The bug was two gates
 * in the middle — the node had to be `bounded`, and the eye menu had to have "Navigation mesh" on —
 * and nothing could reach them, because deciding what to draw was tangled up with building a `Model`,
 * which needs a GPU. So the first two blocks below are the regression tests for exactly that: an
 * unbounded node must still produce a plan, and selection must be the only gate.
 */

/** A flat ground quad, wound to face up, spanning [x0..x1] x [z0..z1] at y = 0. */
function ground(x0: number, z0: number, x1: number, z1: number): TriangleSoup {
  return {
    positions: new Float32Array([
      x0, 0, z0, x0, 0, z1, x1, 0, z1,
      x0, 0, z0, x1, 0, z1, x1, 0, z0,
    ]),
    indices: new Uint32Array(0),
  }
}

/** `count` disjoint ground triangles, for exercising the cap. */
function manyTriangles(count: number): TriangleSoup {
  const out = new Float32Array(count * 9)
  for (let i = 0; i < count; i++) {
    const x = i * 2
    out.set([x, 0, 0, x, 0, 1, x + 1, 0, 1], i * 9)
  }
  return { positions: out, indices: new Uint32Array(0) }
}

const EMPTY: TriangleSoup = { positions: new Float32Array(0), indices: new Uint32Array(0) }

function boundedNode(size: [number, number, number] = [10, 10, 10]): NavMeshNode {
  const node = new NavMeshNode('nav')
  node.size = size
  node.updateTransforms()
  return node
}

describe('planNavOverlays: selection is the only gate', () => {
  it('plans nothing for a node that is not selected', () => {
    const plan = planNavOverlays(boundedNode(), ground(-5, -5, 5, 5), false)
    expect(plan.box).toBeNull()
    expect(plan.preview).toBeNull()
  })

  it('plans a box AND a preview for a selected bounded node', () => {
    const plan = planNavOverlays(boundedNode(), ground(-5, -5, 5, 5), true)
    expect(plan.box).not.toBeNull()
    expect(plan.box!.dimmed).toBe(false)
    expect(plan.preview).not.toBeNull()
  })
})

describe('planNavOverlays: an UNBOUNDED node still gets overlays', () => {
  // The regression that made the feature invisible for every scene authored before it existed:
  // `size` defaults to [0,0,0], and the first version skipped both overlays on that.
  const unbounded = () => {
    const node = new NavMeshNode('nav')
    node.updateTransforms()
    return node
  }

  it('is unbounded by default, which is the case that used to draw nothing', () => {
    expect(unbounded().bounded).toBe(false)
  })

  it('boxes the whole gathered level and marks it dimmed', () => {
    const plan = planNavOverlays(unbounded(), ground(-8, -4, 8, 4), true)
    expect(plan.box).not.toBeNull()
    expect(plan.box!.dimmed).toBe(true)
    expect(plan.box!.half[0]).toBeCloseTo(8, 6)
    expect(plan.box!.half[2]).toBeCloseTo(4, 6)
  })

  it('previews the whole walkable level, because that is what an unbounded bake covers', () => {
    const plan = planNavOverlays(unbounded(), ground(-8, -4, 8, 4), true)
    expect(plan.preview!.positions.length / 9).toBe(2)
  })

  it('does not follow the node, because an unbounded bake does not either', () => {
    const node = unbounded()
    node.setPosition([100, 50, -70])
    node.updateTransforms()
    const plan = planNavOverlays(node, ground(-8, -4, 8, 4), true)
    // Centred on the LEVEL, not on the node that was just dragged a hundred metres away.
    expect(plan.box!.center[0]).toBeCloseTo(0, 6)
    expect(plan.box!.center[2]).toBeCloseTo(0, 6)
  })

  it('plans no box at all when the level is empty', () => {
    const plan = planNavOverlays(unbounded(), EMPTY, true)
    expect(plan.box).toBeNull()
    expect(plan.preview).toBeNull()
  })
})

describe('planNavOverlays: the bounded box follows the node', () => {
  it('takes the node position and half the size', () => {
    const node = boundedNode([10, 4, 6])
    node.setPosition([2, 1, -3])
    node.updateTransforms()
    const box = planNavOverlays(node, ground(-20, -20, 20, 20), true).box!
    expect(Array.from(box.center)).toEqual([2, 1, -3])
    expect(box.half[0]).toBeCloseTo(5, 6)
    expect(box.half[1]).toBeCloseTo(2, 6)
    expect(box.half[2]).toBeCloseTo(3, 6)
  })

  it('multiplies size by the node scale, so the scale gizmo resizes the volume', () => {
    const node = boundedNode([10, 10, 10])
    node.setScale([3, 1, 1])
    node.updateTransforms()
    const box = boundedBox(node)
    expect(box.half[0]).toBeCloseTo(15, 6)
    expect(box.half[1]).toBeCloseTo(5, 6)
  })

  it('carries the node rotation rather than flattening to an AABB', () => {
    const node = boundedNode()
    node.setRotation([0, 90, 0])
    node.updateTransforms()
    const box = boundedBox(node)
    // A 90-degree Y turn is (0, sin45, 0, cos45).
    expect(box.quaternion[1]).toBeCloseTo(Math.SQRT1_2, 5)
  })

  it('never produces a zero half-extent, which would be a degenerate scale', () => {
    const node = new NavMeshNode('nav')
    node.size = [10, 0, 10] // unbounded by the `bounded` test, but boundedBox must still be safe
    node.updateTransforms()
    expect(boundedBox(node).half[1]).toBeGreaterThan(0)
  })

  it('clips the preview to the box, so only what is inside is painted', () => {
    const node = boundedNode([4, 20, 4])
    node.updateTransforms()
    const plan = planNavOverlays(node, ground(-50, -50, 50, 50), true)
    for (let i = 0; i < plan.preview!.positions.length; i += 3) {
      expect(Math.abs(plan.preview!.positions[i])).toBeLessThanOrEqual(2 + 1e-6)
    }
  })
})

describe('planNavOverlays: the slope filter is the one the bake uses', () => {
  it('drops a preview whose ground is steeper than maxSlope', () => {
    const node = boundedNode([100, 100, 100])
    node.bake = { ...node.bake, maxSlope: 5 }
    // A 45-degree ramp: y rises with x.
    const ramp: TriangleSoup = {
      positions: new Float32Array([0, 0, 0, 0, 0, 1, 1, 1, 1]),
      indices: new Uint32Array(0),
    }
    expect(planNavOverlays(node, ramp, true).preview).toBeNull()

    node.bake = { ...node.bake, maxSlope: 60 }
    expect(planNavOverlays(node, ramp, true).preview).not.toBeNull()
  })

  it('still plans the box when nothing inside it is walkable', () => {
    // The box is what tells you the volume is in the wrong place; hiding it too would remove the only
    // clue for the most common authoring mistake.
    const node = boundedNode([4, 4, 4])
    node.setPosition([0, 40, 0])
    node.updateTransforms()
    const plan = planNavOverlays(node, ground(-50, -50, 50, 50), true)
    expect(plan.box).not.toBeNull()
    expect(plan.preview).toBeNull()
  })
})

describe('planNavOverlays: the triangle cap', () => {
  it('builds a preview below the cap', () => {
    const node = boundedNode([1e6, 1e6, 1e6])
    const plan = planNavOverlays(node, manyTriangles(10), true)
    expect(plan.preview).not.toBeNull()
    expect(plan.previewSkipped).toBeNull()
  })

  it('refuses one above the cap and reports the count, rather than silently drawing nothing', () => {
    const node = boundedNode([1e9, 1e9, 1e9])
    const plan = planNavOverlays(node, manyTriangles(NAV_PREVIEW_TRIANGLE_CAP + 10), true)
    expect(plan.preview).toBeNull()
    expect(plan.previewSkipped).toBe(NAV_PREVIEW_TRIANGLE_CAP + 10)
    // The box still stands — the volume is still worth seeing on a level too big to paint.
    expect(plan.box).not.toBeNull()
  })
})

describe('soupBounds', () => {
  it('returns null for a soup with no triangles', () => {
    expect(soupBounds(EMPTY)).toBeNull()
  })

  it('spans every vertex', () => {
    const b = soupBounds(ground(-3, -7, 11, 2))!
    expect(Array.from(b.min)).toEqual([-3, 0, -7])
    expect(Array.from(b.max)).toEqual([11, 0, 2])
  })
})

describe('navPreviewSignature', () => {
  it('is stable for the same plan, so an unchanged preview is not rebuilt every frame', () => {
    const node = boundedNode()
    const soup = ground(-5, -5, 5, 5)
    expect(navPreviewSignature(planNavOverlays(node, soup, true)))
      .toBe(navPreviewSignature(planNavOverlays(node, soup, true)))
  })

  it('changes when the volume moves over different ground', () => {
    const node = boundedNode([4, 20, 4])
    node.updateTransforms()
    const soup = ground(-50, -50, 50, 50)
    const before = navPreviewSignature(planNavOverlays(node, soup, true))

    node.setPosition([20, 0, 20])
    node.updateTransforms()
    expect(navPreviewSignature(planNavOverlays(node, soup, true))).not.toBe(before)
  })

  it('distinguishes "no preview" from "preview skipped for size"', () => {
    const none = navPreviewSignature({ box: null, preview: null, previewSkipped: null })
    const capped = navPreviewSignature({ box: null, preview: null, previewSkipped: 99_999 })
    expect(none).not.toBe(capped)
  })
})

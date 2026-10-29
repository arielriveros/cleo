import { describe, it, expect } from 'vitest'
import { describeCollider, fitColliderToBounds, fitColliderToTrunk } from '../src/utils/foliageColliderFit'
import { nearestFoliageColliders } from '../src/utils/editorHelpers'

// A synthetic tree in prototype units: a thin trunk (radius 0.3, 0..10) under a wide crown (radius 3, 4..10).
function tree(): any[] {
  const positions: number[] = []
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2
    for (let y = 0; y <= 10; y += 0.5) positions.push(Math.cos(a) * 0.3, y, Math.sin(a) * 0.3)
    for (let y = 4; y <= 10; y += 1) positions.push(Math.cos(a) * 3, y, Math.sin(a) * 3)
  }
  return [{ geometry: { positions: new Float32Array(positions) } }]
}

describe('foliage collider fit', () => {
  it('fits a trunk cylinder to the trunk, not the crown', () => {
    const c = fitColliderToTrunk(tree(), 'cylinder')!
    expect(c.shape).toBe('cylinder')
    expect(c.radius).toBeCloseTo(0.3, 2)
    expect(c.height).toBeCloseTo(6, 3)
    expect(c.offsetY).toBeCloseTo(3, 3) // stands on the base
  })

  it('fits bounds around the whole plant', () => {
    const c = fitColliderToBounds(tree(), 'cylinder')!
    expect(c.radius).toBeCloseTo(3, 2)
    expect(c.height).toBeCloseTo(10, 3)
    expect(c.offsetY).toBeCloseTo(5, 3)
    const box = fitColliderToBounds(tree(), 'box')!
    expect(box.width).toBeCloseTo(3, 2) // half-width
  })

  it('returns null with no geometry', () => {
    expect(fitColliderToTrunk([], 'cylinder')).toBeNull()
    expect(fitColliderToBounds(undefined, 'box')).toBeNull()
  })

  it('describes a collider in full sizes', () => {
    expect(describeCollider({ shape: 'cylinder', radius: 0.4, height: 6, offsetY: 3 })).toBe('Cylinder · Ø 0.8 · h 6 · centre +3')
    expect(describeCollider({ shape: 'box', width: 1, depth: 0.5, height: 2 })).toBe('Box · 2 × 1 · h 2 · centre auto +1')
    expect(describeCollider({ shape: 'sphere', radius: 0.5 })).toBe('Sphere · Ø 1 · centre auto +0.5')
  })
})

describe('nearestFoliageColliders', () => {
  const layer = (collision: any, pts: [number, number][]) => ({
    collision, count: pts.length,
    forEachInstanceNear(_x: number, _z: number, _r: number, cb: any) { pts.forEach(([x, z], i) => cb(i, x, 0, z, 0, 1)) },
  })
  const cyl = { shape: 'cylinder' as const, radius: 0.4, height: 6 }

  it('keeps instances within the radius, nearest first, capped', () => {
    const out = nearestFoliageColliders([layer(cyl, [[10, 0], [2, 0], [50, 0], [5, 0]])], 0, 0, 20, 2)
    expect(out.map(o => o.x)).toEqual([2, 5])
  })

  it('skips layers without a collider', () => {
    const out = nearestFoliageColliders([layer(null, [[1, 0]]), layer(cyl, [[3, 0]])], 0, 0, 20, 10)
    expect(out.map(o => o.x)).toEqual([3])
  })
})

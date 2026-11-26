import { describe, it, expect } from 'vitest'
import { BENCH_DEFAULTS, BENCH_SCENARIOS, benchLayout, boxLines, type BenchBox } from '../src/features/rig/reactions/scenarios'
import { BenchRecorder, benchStore, type BenchFrame } from '../src/features/rig/reactions/benchStore'

// The Reactions tab's test bench: the props each scenario builds around the preview character (pure geometry),
// and the recorder the timeline and the replay read.

/** The box's top face height at (x, z), for a box with no pitch, or null when (x, z) is off it. */
function topAt(box: BenchBox, x: number, z: number): number | null {
  const [cx, cy, cz] = box.center, [hx, hy, hz] = box.half
  if (box.pitch) {
    // Rotate (x, z) into the box frame about X, then the top face is local y = hy.
    const a = box.pitch * Math.PI / 180, dz = z - cz
    // A point on the top face: local (lx, hy, lz) -> world y = cy + hy cos a - lz sin a, z = cz + hy sin a + lz cos a.
    const lz = (dz - hy * Math.sin(a)) / Math.cos(a)
    if (Math.abs(x - cx) > hx || Math.abs(lz) > hz) return null
    return cy + hy * Math.cos(a) - lz * Math.sin(a)
  }
  if (Math.abs(x - cx) > hx || Math.abs(z - cz) > hz) return null
  return cy + hy
}

/** The highest top face under (x, z). */
const surfaceAt = (boxes: BenchBox[], x: number, z: number) =>
  Math.max(...boxes.map(b => topAt(b, x, z) ?? -Infinity))

describe('bench scenarios', () => {
  it('lists every scenario once, each with a layout', () => {
    const ids = BENCH_SCENARIOS.map(s => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) {
      const layout = benchLayout(id)
      expect(layout.boxes.length, id).toBeGreaterThan(0)
      for (const b of layout.boxes) for (const v of [...b.center, ...b.half]) expect(Number.isFinite(v), id).toBe(true)
    }
  })

  it('stands the character on something in every scenario', () => {
    for (const { id } of BENCH_SCENARIOS) {
      const { boxes, start } = benchLayout(id)
      expect(surfaceAt(boxes, start[0], start[2]), id).toBeCloseTo(start[1], 5)
    }
  })

  it('builds a flight of stairs that goes down a rise per run', () => {
    const o = { ...BENCH_DEFAULTS, stairCount: 6, stairRise: 0.2, stairRun: 0.3 }
    const { boxes, start, action } = benchLayout('stairs', o)
    expect(action).toBe('trip')
    expect(start[1]).toBeCloseTo(1.2)
    for (let i = 1; i < 6; i++) expect(surfaceAt(boxes, 0, (i - 0.5) * 0.3)).toBeCloseTo(1.2 - i * 0.2)
    // Past the last step: the ground.
    expect(surfaceAt(boxes, 0, 6 * 0.3 + 0.1)).toBeCloseTo(0)
  })

  it('builds a ramp at the angle set, from the top platform to the ground', () => {
    const o = { ...BENCH_DEFAULTS, rampAngle: 30 }
    const { boxes, start } = benchLayout('ramp', o)
    const ramp = boxes.find(b => b.pitch)!
    expect(ramp.pitch).toBeCloseTo(30)
    const height = Math.sin(Math.PI / 6) * 8, depth = Math.cos(Math.PI / 6) * 8
    expect(start[1]).toBeCloseTo(height)
    expect(topAt(ramp, 0, 0.01)!).toBeCloseTo(height, 1)
    expect(topAt(ramp, 0, depth - 0.01)!).toBeCloseTo(0, 1)
    // Halfway down it is halfway high: a straight slope.
    expect(topAt(ramp, 0, depth / 2)!).toBeCloseTo(height / 2, 2)
  })

  it('puts a ledge the height set under the character, which steps off it', () => {
    const { boxes, start, action, velocity } = benchLayout('ledge', { ...BENCH_DEFAULTS, ledgeHeight: 4 })
    expect(action).toBe('fall')
    expect(surfaceAt(boxes, 0, start[2])).toBeCloseTo(4)
    expect(surfaceAt(boxes, 0, 0.5)).toBeCloseTo(0)
    expect(velocity![2]).toBeGreaterThan(0)
  })

  it('moves the cart at the speed set and throws the rider out sideways at it', () => {
    const { boxes, velocity, exit, action, rides } = benchLayout('vehicle', { ...BENCH_DEFAULTS, vehicleSpeed: 12 })
    expect(action).toBe('bail')
    expect(rides).toBe(true)
    expect(boxes.find(b => b.velocity)!.velocity).toEqual([0, 0, 12])
    expect(velocity).toEqual([0, 0, 12])
    expect(Math.hypot(...exit!)).toBeCloseTo(1)
  })

  it('stands the wall in front of the character, and pushes it at it', () => {
    const { boxes, velocity } = benchLayout('wall')
    const wall = boxes[1]
    expect(wall.center[2] - wall.half[2]).toBeGreaterThan(0.5)
    expect(velocity![2]).toBeGreaterThan(0)
  })

  it('follows the floor height', () => {
    expect(benchLayout('ledge', BENCH_DEFAULTS, 2).start[1]).toBeCloseTo(2 + BENCH_DEFAULTS.ledgeHeight)
  })

  it('draws a box as its twelve edges', () => {
    const { positions, indices } = boxLines([1, 2, 3])
    expect(positions).toHaveLength(8)
    expect(indices).toHaveLength(24)
    for (let i = 0; i < indices.length; i += 2) {
      const a = positions[indices[i]], b = positions[indices[i + 1]]
      expect(a.filter((v, k) => v !== b[k])).toHaveLength(1)
    }
  })
})

const frame = (t: number): BenchFrame => ({ t, state: 'animated', poses: new Float32Array(7), behaviours: {} })

describe('the bench recorder', () => {
  it('keeps the last frames, oldest first, past its capacity', () => {
    const rec = new BenchRecorder(4)
    for (let i = 0; i < 6; i++) rec.push(frame(i))
    expect(rec.count).toBe(4)
    expect([0, 1, 2, 3].map(i => rec.at(i)!.t)).toEqual([2, 3, 4, 5])
    expect(rec.at(4)).toBeUndefined()
    expect(rec.at(-1)).toBeUndefined()
  })

  it('scrubs by fraction, clamped, the ends being the oldest and the newest', () => {
    const rec = new BenchRecorder(10)
    expect(rec.atFraction(0.5)).toBeUndefined()
    for (let i = 0; i < 5; i++) rec.push(frame(i))
    expect(rec.atFraction(0)!.t).toBe(0)
    expect(rec.atFraction(1)!.t).toBe(4)
    expect(rec.atFraction(0.5)!.t).toBe(2)
    expect(rec.atFraction(-3)!.t).toBe(0)
    expect(rec.atFraction(9)!.t).toBe(4)
  })

  it('clears', () => {
    const rec = new BenchRecorder(3)
    rec.push(frame(1)); rec.clear()
    expect(rec.count).toBe(0)
    rec.push(frame(2))
    expect(rec.at(0)!.t).toBe(2)
  })

  it('keeps 20 s at 60 fps', () => {
    expect(new BenchRecorder().capacity).toBe(1200)
  })
})

describe('the bench store', () => {
  it('tells its listeners, and stops when unsubscribed', () => {
    const seen: number[] = []
    const off = benchStore.subscribe(s => seen.push(s.slow))
    benchStore.set({ slow: 0.25 })
    off()
    benchStore.set({ slow: 1 })
    expect(seen).toEqual([0.25])
  })

  it('hands the tab\'s actions to the bench', () => {
    const got: string[] = []
    const off = benchStore.onAction(a => got.push(a.kind === 'act' ? a.what : a.kind))
    benchStore.act({ kind: 'act', what: 'trip' })
    benchStore.act({ kind: 'reset' })
    off()
    benchStore.act({ kind: 'start' })
    expect(got).toEqual(['trip', 'reset'])
  })
})

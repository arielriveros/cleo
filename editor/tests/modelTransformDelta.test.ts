import { describe, it, expect } from 'vitest'
import { nodeJsonTrs, modelTransformDelta } from '../src/utils/modelClips'

// The model editor can now move/rotate/scale a model's root and have every placement follow. Placements
// keep where the user put them, so what propagates is the CHANGE the model made — see modelTransformDelta.

const inst = (position: number[], rotation = [0, 0, 0], scale = [1, 1, 1]) => ({ position, rotation, scale })
const IDENTITY = [0, 0, 0, 0, 0, 0, 1, 1, 1]

describe('nodeJsonTrs', () => {
  it('defaults a bare node to an identity transform', () => {
    expect(nodeJsonTrs({})).toEqual(IDENTITY)
    expect(nodeJsonTrs(null)).toEqual(IDENTITY)
  })

  it('reads position/rotation/scale, keeping explicit zeros', () => {
    expect(nodeJsonTrs({ position: [1, 2, 3], rotation: [0, 90, 0], scale: [2, 2, 2] }))
      .toEqual([1, 2, 3, 0, 90, 0, 2, 2, 2])
  })

  it('falls back per component for a malformed triple', () => {
    expect(nodeJsonTrs({ scale: [3, null, undefined] })).toEqual([0, 0, 0, 0, 0, 0, 3, 1, 1])
  })
})

describe('modelTransformDelta', () => {
  it('returns null without a baseline — an older placement keeps its transform verbatim', () => {
    expect(modelTransformDelta(inst([5, 0, 3]), null, [0, 1, 0, 0, 0, 0, 1, 1, 1])).toBeNull()
    expect(modelTransformDelta(inst([5, 0, 3]), [0, 0, 0], [0, 1, 0, 0, 0, 0, 1, 1, 1])).toBeNull()
  })

  it('returns null when the model has not moved', () => {
    expect(modelTransformDelta(inst([5, 0, 3]), IDENTITY, IDENTITY)).toBeNull()
  })

  it('applies the change on top of where the copy sits, not instead of it', () => {
    const out = modelTransformDelta(inst([5, 0, 3], [0, 45, 0], [2, 2, 2]), IDENTITY, [0, 1, 0, 0, 90, 0, 3, 3, 3])
    expect(out).toEqual({ position: [5, 1, 3], rotation: [0, 135, 0], scale: [6, 6, 6] })
  })

  it('scales by ratio, so a model doubling in size doubles a copy already scaled down', () => {
    const out = modelTransformDelta(inst([0, 0, 0], [0, 0, 0], [0.5, 0.5, 0.5]), IDENTITY, [0, 0, 0, 0, 0, 0, 2, 2, 2])
    expect(out?.scale).toEqual([1, 1, 1])
  })

  it('subtracts a non-identity baseline, so a second save does not re-apply the first change', () => {
    const base = [0, 1, 0, 0, 90, 0, 2, 2, 2]
    const out = modelTransformDelta(inst([5, 1, 3], [0, 90, 0], [2, 2, 2]), base, base)
    expect(out).toBeNull()
  })

  it('treats a zero base scale as 1 rather than collapsing the copy to NaN', () => {
    const out = modelTransformDelta(inst([0, 0, 0], [0, 0, 0], [4, 4, 4]), [0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 2, 2, 2])
    expect(out?.scale).toEqual([4, 4, 4])
  })
})

import { describe, it, expect } from 'vitest'
import { rescaleLodDistances } from '../src/utils/models'

// LOD levels are placed as a SHARE of the cull distance in the model editor (a slider: 50% of a 200 m
// cull = 100 m), so moving the cull moves the levels with it.
describe('rescaleLodDistances', () => {
  it('keeps each level\'s share of the cull', () => {
    expect(rescaleLodDistances([0, 50, 100, 150], 200, 400)).toEqual([0, 100, 200, 300])
  })
  it('leaves the distances alone when either cull is automatic (0)', () => {
    expect(rescaleLodDistances([0, 40, 80], 0, 200)).toEqual([0, 40, 80])
    expect(rescaleLodDistances([0, 40, 80], 200, 0)).toEqual([0, 40, 80])
  })
})

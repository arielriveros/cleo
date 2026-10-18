import { describe, it, expect } from 'vitest'
import { compactRanges } from '../src/utils/foliageRules'

// A foliage draw is one material over the whole index buffer, so a merged multi-material tree is
// baked into one prototype per material; this is the per-material share of the mesh.
describe('compactRanges', () => {
  const quad = () => ({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 5, 5, 5, 6, 5, 5, 6, 6, 5]),
    normals: new Float32Array(21).fill(1),
    tangents: new Float32Array(0),
    bitangents: new Float32Array(0),
    texCoords: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 0.5, 0.5, 0.6, 0.5, 0.6, 0.6]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6]),
  })

  it('keeps only the referenced vertices, re-indexed from 0', () => {
    const out = compactRanges(quad(), [{ start: 6, count: 3 }])
    expect([...out.indices]).toEqual([0, 1, 2])
    expect([...out.positions]).toEqual([5, 5, 5, 6, 5, 5, 6, 6, 5])
    expect([...out.texCoords].map(v => +v.toFixed(2))).toEqual([0.5, 0.5, 0.6, 0.5, 0.6, 0.6])
    expect(out.tangents.length).toBe(0)
  })

  it('joins several ranges of one material, sharing their vertices', () => {
    const out = compactRanges(quad(), [{ start: 0, count: 3 }, { start: 3, count: 3 }])
    expect(out.positions.length).toBe(12)
    expect([...out.indices]).toEqual([0, 1, 2, 0, 2, 3])
  })
})

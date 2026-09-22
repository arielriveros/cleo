import { describe, it, expect } from 'vitest'
import { importHeightmapInto, applyHeightsTo, rangeFromFileName, type HeightmapTarget } from '../src/features/landscape/heightmapImport'

// "Importing a heightmap does nothing on a large landscape": Rebuild (how a landscape gets large) swaps a
// NEW Terrain onto the node, and the inspector kept writing into the one it had captured at render time.
// These pin that the import follows the node, and that foliage is re-seated on the new ground.

type FakeTerrain = HeightmapTarget['terrain'] & { imported: { url: string; amplitude: number }[]; reseated: number[] }

function fakeTerrain(origin: [number, number, number], height: number): FakeTerrain {
  const reseated: number[] = []
  const t: FakeTerrain = {
    imported: [],
    reseated,
    origin,
    heightAt: () => height,
    importHeightmap: async (url, amplitude) => { t.imported.push({ url, amplitude }) },
    foliage: [{
      reseat: (sample) => { reseated.push(sample(origin[0] + 3, origin[2] - 2)); return true },
    }],
  }
  return t
}

describe('importHeightmapInto', () => {
  it('writes into the terrain the node holds NOW, not one captured before a rebuild', async () => {
    const before = fakeTerrain([0, 0, 0], 1)
    const node = { terrain: before as HeightmapTarget['terrain'] }
    const after = fakeTerrain([0, 0, 0], 1)
    node.terrain = after // what rebuildTerrain does: same node, new Terrain

    await importHeightmapInto(node, 'data:image/png;base64,xx', 120)

    expect(before.imported).toEqual([])
    expect(after.imported).toEqual([{ url: 'data:image/png;base64,xx', amplitude: 120 }])
  })

  it('re-seats foliage at origin.y + heightAt, in world space', async () => {
    const t = fakeTerrain([10, 5, -4], 7)
    await importHeightmapInto({ terrain: t }, 'u', 30)
    expect(t.reseated).toEqual([12]) // 5 (origin y) + 7 (ground)
  })

  it('propagates a failed import instead of swallowing it', async () => {
    const t = fakeTerrain([0, 0, 0], 0)
    t.importHeightmap = async () => { throw new Error('decode failed') }
    await expect(importHeightmapInto({ terrain: t }, 'u', 30)).rejects.toThrow('decode failed')
    expect(t.reseated).toEqual([])
  })
})

describe('whole-field replacement (the import dialog)', () => {
  it('applies through setHeights and re-seats foliage, or reports it cannot', () => {
    const t = fakeTerrain([0, 2, 0], 5)
    const seen: Float32Array[] = []
    expect(applyHeightsTo({ terrain: t }, new Float32Array([1, 2]), (_t, h) => { seen.push(h); return true })).toBe(true)
    expect(seen.length).toBe(1)
    expect(t.reseated).toEqual([7])
    expect(applyHeightsTo({ terrain: t }, new Float32Array(1), () => false)).toBe(false)
    expect(t.reseated).toEqual([7]) // nothing re-seated when nothing was applied
  })

  it('reads an exported height range back out of the file name', () => {
    expect(rangeFromFileName('heightmap_min-12.5_max40.png')).toEqual({ min: -12.5, max: 40 })
    expect(rangeFromFileName('heightmap513x513_min0_max312.25.r16')).toEqual({ min: 0, max: 312.25 })
    expect(rangeFromFileName('mountains.png')).toBeNull()
  })
})

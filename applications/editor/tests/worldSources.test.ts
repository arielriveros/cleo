import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { encodePng16 } from 'cleo/terrain/heightmapIO'
import { entriesFromFiles, loadWorld, type WorldEntry } from '../src/features/landscape/worldSources'

// Reading a World export for Import world: the manifest found among the files, the heightmap, and the
// layers' weight planes -- from a zip as from loose files -- with a world whose maps are missing still
// importing its heights.

const N = 4
/** A grey 16-bit PNG of byte values (encodePng16 maps 0..1 onto 0..65535, so v/255 comes back as v). */
const greyPng = (values: number[]) => encodePng16({ width: N, height: N, data: Float32Array.from(values, v => v / 255) })
const fill = (v: number) => new Array(N * N).fill(v)

const manifest = {
  generator: 'world', version: 1, seed: 1, params: {},
  output: {
    format: 'cleo-world', version: 2, resolution: N, size: 512, minHeight: -10, maxHeight: 90,
    heightmap: { png: 'vale_height.png', raw: 'vale_height.r16', min: -10, max: 90 },
    splat: { resolution: N, files: ['vale_splat_0.png'], weights: 'normalized' },
    layers: [
      { id: 'grass', name: 'Grass', index: 0, splat: { file: 'vale_splat_0.png', channel: 'r' }, weightmap: 'vale_weight_00_grass.png', coverage: 0.75, kind: 'grass' },
      { id: 'rock', name: 'Rock', index: 1, splat: { file: 'vale_splat_0.png', channel: 'g' }, weightmap: 'vale_weight_01_rock.png', coverage: 0.25, kind: 'rock' },
    ],
    masks: {}, exportHash: 'abc123',
  },
}

async function files(): Promise<Record<string, Uint8Array>> {
  return {
    'vale.json': new TextEncoder().encode(JSON.stringify(manifest)),
    'vale_height.png': await greyPng(Array.from({ length: N * N }, (_, i) => i * 10)),
    'vale_weight_00_grass.png': await greyPng(fill(191)),
    'vale_weight_01_rock.png': await greyPng(fill(64)),
  }
}

const entries = (f: Record<string, Uint8Array>): WorldEntry[] => Object.entries(f).map(([name, bytes]) => ({ name, read: async () => bytes }))

describe('loadWorld', () => {
  it('finds the manifest, decodes the heightmap, and reads the weightmaps when the splatmaps are absent', async () => {
    const world = await loadWorld(entries(await files()))
    expect(world.name).toBe('vale')
    expect(world.manifest.exportHash).toBe('abc123')
    expect([world.height.width, world.height.bitDepth]).toEqual([N, 16])
    expect(world.height.data[1]).toBeCloseTo(10 / 255, 4)
    expect(world.weightsError).toBeUndefined()
    expect(world.weights!.size).toBe(N)
    expect(world.weights!.planes.map(p => p[0])).toEqual([191, 64])
  })

  it('reads a zip of the same files', async () => {
    const zip = new JSZip()
    for (const [name, bytes] of Object.entries(await files())) zip.file(`vale/${name}`, bytes)
    const file = new File([await zip.generateAsync({ type: 'uint8array' }) as BlobPart], 'vale.zip')
    const world = await loadWorld(await entriesFromFiles([file]))
    expect(world.weights!.planes.map(p => p[5])).toEqual([191, 64])
  })

  it('still imports the heights of a world whose surface maps are missing, and says which', async () => {
    const f = await files()
    delete f['vale_weight_01_rock.png']
    const world = await loadWorld(entries(f))
    expect(world.weights).toBeNull()
    expect(world.weightsError).toMatch(/vale_splat_0\.png/)
    expect(world.height.width).toBe(N)
  })

  it('takes a library asset\'s parsed sidecar instead of a .json file', async () => {
    const f = await files()
    delete f['vale.json']
    const world = await loadWorld(entries(f), { name: 'Vale', sidecar: manifest, creator: { id: 'world_1', revision: 2 } })
    expect(world.name).toBe('Vale')
    expect(world.creator).toEqual({ id: 'world_1', revision: 2 })
    expect(world.weights!.planes).toHaveLength(2)
  })

  it('refuses a set of files with no manifest', async () => {
    const f = await files()
    delete f['vale.json']
    await expect(loadWorld(entries(f))).rejects.toThrow(/manifest/)
  })
})

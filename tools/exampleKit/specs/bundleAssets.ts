// The bundle packer (applications/editor/src/utils/bundleAssets.ts) against a REAL project, not a fixture: run by
// the Valley's and the Dungeon's tests on their own folders.
//
// Synthetic bundles cannot produce what actually broke this format twice — geometry the foliage baker computed in
// float64 and stored as nested tuples, animation samplers that are genuinely float64, key orders that a hand-built
// object happens to get right. Both bugs were byte-level and silent: the scene still loaded, it just came back with
// a different content hash and resynced every placement. The Valley carries the foliage and building geometry, the
// Dungeon the animation samplers.

import { describe, it, expect } from 'vitest'
import { packBundleAssets, inflateBundleAssets } from '../../../applications/editor/src/utils/bundleAssets'
import type { BundleData } from '../../../applications/editor/src/utils/bundle'
import { dataReady, readThisExample } from '../testKit'

const dataOf = (b: BundleData) => ({ manifest: b.manifest, scenes: b.scenes, libraries: b.libraries, vfs: b.vfs })

/**
 * The bundle as one JSON string per scene and per library, in a fixed order. The Valley is ~270 MB of JSON;
 * stringified whole it sits next to V8's ~512 MB string ceiling, and a failed comparison of two such strings dies
 * building the diff instead of reporting it.
 */
const sectionsOf = (b: BundleData): [string, string][] => [
  ['manifest', JSON.stringify(b.manifest)],
  ['vfs', JSON.stringify(b.vfs)],
  ...Object.entries(b.scenes).map(([id, v]) => [`scene ${id}`, JSON.stringify(v)] as [string, string]),
  ...Object.entries(b.libraries).map(([name, v]) => [`library ${name}`, JSON.stringify(v)] as [string, string]),
]
const totalLength = (sections: [string, string][]) => sections.reduce((n, [, s]) => n + s.length, 0)

export function bundleAssetSpecs({ clips }: { clips: boolean }): void {
  describe.skipIf(!dataReady())('assets.bin against this example', () => {
    it('round-trips it byte-for-byte, and shrinks the JSON by an order of magnitude', async () => {
      // As the editor imports it. Textures and sounds are dropped: they are already raw bytes, and ~90 MB of them
      // proves nothing extra here.
      let bundle: BundleData | null = { ...structuredClone((await readThisExample()).bundle), textures: [], audio: [] }
      let before: Map<string, string> | null = new Map(sectionsOf(bundle))
      const beforeLength = totalLength([...before])

      const { blob, index } = await packBundleAssets(bundle)
      let packed: [string, string][] | null = sectionsOf(bundle)
      const indexJson = JSON.stringify(index)

      // Nothing bulky left in the JSON: no vertex arrays, no keyframes, no matrices, no base64 terrain, no data URLs.
      for (const [name, json] of packed)
        for (const bulky of ['"positions":[', '"output":[', '"inverseBindMatrix":[', '"heights":"', 'data:image'])
          expect(json.includes(bulky), `${name} still holds ${bulky}`).toBe(false)
      // Its clips' records are still there too, their keyframes moved out (only an example with clips has any).
      if (clips) expect(packed.some(([, json]) => json.includes('"samplers"')), 'no clip records left to check').toBe(true)

      // Loosely: the order of magnitude, not a number to edit whenever the example changes.
      expect(totalLength(packed) + indexJson.length).toBeLessThan(beforeLength / 10)
      expect(blob.byteLength).toBeLessThan(beforeLength / 2)

      const reparsed: BundleData = { ...JSON.parse(JSON.stringify(dataOf(bundle))), textures: [] }
      packed = null
      bundle = null
      await inflateBundleAssets(reparsed, blob, JSON.parse(indexJson))

      // Byte-identical, key order included: what keeps every asset's content hash the same.
      for (const [name, json] of sectionsOf(reparsed)) {
        const was = before.get(name)!
        if (json === was) continue
        let at = 0
        while (at < json.length && json[at] === was[at]) at++
        expect.fail(`${name} differs at ${at}: …${json.slice(Math.max(0, at - 80), at + 80)}… was …${was.slice(Math.max(0, at - 80), at + 80)}…`)
      }
      before = null
    }, 300_000)
  })
}

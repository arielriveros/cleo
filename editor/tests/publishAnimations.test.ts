import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { buildRigAsset, sourceSkinFor } from '../src/utils/rigAssets'
import type { StoredSkin } from '../src/utils/animationAssets'

// The published game retargets shared clips using `asset.sourceSkin` (player/animations.ts). Once an
// animation carries a `rigId` instead of its own embedded copy of that skeleton, publish MUST resolve the
// rig back into `sourceSkin` at pack time — otherwise the player falls through to playing the clips
// unretargeted: silently wrong animation, nothing logged, and no unit test downstream can see it.
//
// This file pins both halves: the resolution itself, and the fact that the publish path performs it.

const ident = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

const skin = (name: string): StoredSkin => ({
  name,
  skeleton: 0,
  joints: [{ nodeIndex: 0, inverseBindMatrix: ident(), parentIndex: undefined }],
  nodeNames: [[0, 'Hips']],
  nodeTransforms: [[0, ident()]],
})

/** What `buildMultiSceneGameData` does to each shipped animation. */
const shipped = (animations: any[], rigs: any[]) =>
  animations.map(a => ({ ...a, sourceSkin: sourceSkinFor(a, rigs) }))

describe('publishing an animation', () => {
  const rig = buildRigAsset('mannequin', skin('Armature'), undefined, 'rig-1')

  it('resolves a rigId into a real sourceSkin', () => {
    const anim = { id: 'idle', name: 'Idle', clips: [], sourceSkin: null, rigId: 'rig-1' }
    const [out] = shipped([anim], [rig])
    expect(out.sourceSkin).toEqual(rig.skin)
    expect(out.sourceSkin).not.toBeNull()
  })

  it('keeps the id and clips untouched', () => {
    const anim = { id: 'idle', name: 'Idle', clips: [{ name: 'Idle' }], sourceSkin: null, rigId: 'rig-1' }
    const [out] = shipped([anim], [rig])
    expect(out.id).toBe('idle')
    expect(out.clips).toEqual([{ name: 'Idle' }])
  })

  // A project that predates rigs ships exactly as it always did.
  it('passes a legacy embedded sourceSkin through unchanged', () => {
    const legacy = skin('Legacy')
    const anim = { id: 'walk', name: 'Walk', clips: [], sourceSkin: legacy }
    expect(shipped([anim], [rig])[0].sourceSkin).toBe(legacy)
  })

  it('prefers the rig when an asset carries both', () => {
    const anim = { id: 'run', name: 'Run', clips: [], sourceSkin: skin('stale'), rigId: 'rig-1' }
    expect(shipped([anim], [rig])[0].sourceSkin).toEqual(rig.skin)
  })

  // Degrades to the pre-rig behaviour rather than throwing: the clips still ship and still play, just
  // without a retarget — which is what a missing skeleton has always meant.
  it('ships null when neither a rig nor an embedded skin is available', () => {
    const anim = { id: 'jump', name: 'Jump', clips: [], sourceSkin: null, rigId: 'deleted' }
    expect(shipped([anim], [rig])[0].sourceSkin).toBeNull()
  })

  it('ships nothing extra when the project has no rigs at all', () => {
    const legacy = skin('Legacy')
    const anim = { id: 'idle', name: 'Idle', clips: [], sourceSkin: legacy }
    expect(shipped([anim], [])[0].sourceSkin).toBe(legacy)
  })
})

// The runtime contract this rests on. If the player ever stops reading `sourceSkin`, or publish stops
// filling it, the flattening above is either wrong or pointless — and the failure is invisible at runtime.
describe('the publish/player contract', () => {
  const read = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf-8').replace(/\r\n/g, '\n')

  it('publish still flattens the rig into sourceSkin', () => {
    const publish = read('src', 'features', 'publish', 'buildMultiSceneGameData.ts')
    expect(publish).toContain('sourceSkinFor')
    expect(publish).toMatch(/sourceSkin:\s*sourceSkinFor/)
  })

  it('the player still retargets off sourceSkin', () => {
    const player = read('src', 'player', 'animations.ts')
    expect(player).toContain('asset.sourceSkin')
  })

  // Shipping rigs as their own table would be a runtime format change; the flattening exists to avoid it.
  it('does not ship a rig table', () => {
    expect(read('src', 'player', 'animations.ts')).not.toContain('rigId')
  })

  /**
   * The flattening is only reachable if the caller actually HANDS publish the rig library.
   *
   * This is the gap the first version of this file had: it asserted `sourceSkinFor` in isolation, so the
   * publish call site could omit `rigs` entirely — falling back to a null `sourceSkin` and shipping
   * unretargeted animation — with every test still green.
   */
  it('the publish call site passes the rig library', () => {
    const menu = read('src', 'features', 'MenuBar.tsx')
    const call = menu.slice(menu.indexOf('buildMultiSceneGameData({'))
    const start = call.indexOf('libs: {')
    const libs = call.slice(start, call.indexOf(String.fromCharCode(10), start))
    expect(libs).toContain('rigs')
    expect(libs).toContain('animations')
  })
})

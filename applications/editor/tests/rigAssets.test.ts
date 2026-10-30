import { describe, it, expect } from 'vitest'
import {
  buildRigAsset, findEquivalentRig, preferRicherSkin, rigOf, skeletonFingerprint, sourceSkinFor,
} from '../src/utils/rigAssets'
import type { StoredSkin } from '../src/utils/animationAssets'

// The fingerprint decides whether two imports of one character share a rig. Getting it too loose collapses
// genuinely different skeletons; too tight and every re-import mints a duplicate. Pure data, no GL.

const ident = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

function skin(over: Partial<StoredSkin> = {}): StoredSkin {
  return {
    name: 'Armature',
    skeleton: 0,
    joints: [
      { nodeIndex: 0, inverseBindMatrix: ident(), parentIndex: undefined },
      { nodeIndex: 1, inverseBindMatrix: ident(), parentIndex: 0 },
    ],
    nodeNames: [[0, 'Hips'], [1, 'Spine']],
    nodeTransforms: [[0, ident()], [1, ident()]],
    ...over,
  }
}

describe('skeletonFingerprint', () => {
  it('is stable for the same skeleton', () => {
    expect(skeletonFingerprint(skin())).toBe(skeletonFingerprint(skin()))
  })

  // The same download is routinely renamed per character.
  it('ignores the skin name', () => {
    expect(skeletonFingerprint(skin({ name: 'mixamorig' }))).toBe(skeletonFingerprint(skin({ name: 'Armature' })))
  })

  // Map iteration order must not split two exports of one rig.
  it('ignores nodeNames ORDER', () => {
    expect(skeletonFingerprint(skin({ nodeNames: [[1, 'Spine'], [0, 'Hips']] })))
      .toBe(skeletonFingerprint(skin({ nodeNames: [[0, 'Hips'], [1, 'Spine']] })))
  })

  // Identity is the skeleton's SHAPE. Names are improved in place by importSkeletonNames, and if they were
  // part of the identity that backfill would fork a second rig and orphan the first — silently unlinking
  // every animation pointing at it. `preferRicherSkin` merges the better name table instead.
  it('ignores nodeNames content, so a backfill upgrades the rig instead of forking one', () => {
    expect(skeletonFingerprint(skin({ nodeNames: [[0, 'Hips'], [1, 'Chest']] })))
      .toBe(skeletonFingerprint(skin()))
  })

  it('matches a skeleton that has no names yet against the same one named', () => {
    expect(skeletonFingerprint(skin({ nodeNames: [] }))).toBe(skeletonFingerprint(skin()))
  })

  // Joint order is meaningful: an animation channel indexes into it.
  it('does NOT ignore joint ORDER', () => {
    const swapped = skin().joints.slice().reverse()
    expect(skeletonFingerprint(skin({ joints: swapped }))).not.toBe(skeletonFingerprint(skin()))
  })

  it('does not ignore the parent chain', () => {
    const reparented = skin().joints.map(j => ({ ...j, parentIndex: undefined }))
    expect(skeletonFingerprint(skin({ joints: reparented }))).not.toBe(skeletonFingerprint(skin()))
  })

  it('tolerates float noise below the quantisation step', () => {
    const noisy = skin().joints.map(j => ({ ...j, inverseBindMatrix: j.inverseBindMatrix.map(v => v + 1e-7) }))
    expect(skeletonFingerprint(skin({ joints: noisy }))).toBe(skeletonFingerprint(skin()))
  })

  it('still separates a genuinely different bind pose', () => {
    const moved = skin().joints.map(j => ({ ...j, inverseBindMatrix: j.inverseBindMatrix.map(v => v + 0.5) }))
    expect(skeletonFingerprint(skin({ joints: moved }))).not.toBe(skeletonFingerprint(skin()))
  })

  // Excluded deliberately: exporters vary the rest pose in the low bits.
  it('ignores nodeTransforms entirely', () => {
    expect(skeletonFingerprint(skin({ nodeTransforms: [] }))).toBe(skeletonFingerprint(skin()))
  })

  it('separates skeletons with different root joints', () => {
    expect(skeletonFingerprint(skin({ skeleton: 3 }))).not.toBe(skeletonFingerprint(skin()))
  })

  describe('the empty skeleton', () => {
    it('fingerprints as the empty string', () => {
      expect(skeletonFingerprint(skin({ joints: [] }))).toBe('')
      expect(skeletonFingerprint(null)).toBe('')
      expect(skeletonFingerprint(undefined)).toBe('')
    })
  })
})

describe('preferRicherSkin', () => {
  it('keeps the skin with more bone names', () => {
    const bare = skin({ nodeNames: [] })
    // Asserted in both argument orders: the richer skin must win whether it arrives as the incumbent or
    // as the newcomer, or the result would depend on library iteration order.
    expect(preferRicherSkin(bare, skin()).nodeNames).toHaveLength(2)
    expect(preferRicherSkin(skin(), bare).nodeNames).toHaveLength(2)
  })

  it('falls back to more rest transforms when names tie', () => {
    const bare = skin({ nodeTransforms: [] })
    expect(preferRicherSkin(bare, skin()).nodeTransforms).toHaveLength(2)
    expect(preferRicherSkin(skin(), bare).nodeTransforms).toHaveLength(2)
  })

  // Ties resolve to `existing`, which is what makes the migration idempotent.
  it('keeps the incumbent on a tie', () => {
    const existing = skin()
    expect(preferRicherSkin(existing, skin())).toBe(existing)
  })
})

describe('findEquivalentRig', () => {
  const rigs = [buildRigAsset('mannequin', skin(), 'mannequin.fbx', 'rig-1')]

  it('finds a rig with the same skeleton', () => {
    expect(findEquivalentRig(rigs, skin())?.id).toBe('rig-1')
  })

  it('finds it despite a different skin name and node-name order', () => {
    expect(findEquivalentRig(rigs, skin({ name: 'other', nodeNames: [[1, 'Spine'], [0, 'Hips']] }))?.id)
      .toBe('rig-1')
  })

  it('does not match a different skeleton', () => {
    expect(findEquivalentRig(rigs, skin({ joints: [] , nodeNames: [] }))).toBeUndefined()
  })

  // Otherwise every unskinned model in a project would collapse onto one meaningless rig.
  it('never matches an empty skeleton, even against an empty rig', () => {
    const empty = [buildRigAsset('empty', skin({ joints: [] }), undefined, 'rig-empty')]
    expect(findEquivalentRig(empty, skin({ joints: [] }))).toBeUndefined()
  })
})

describe('rigOf / sourceSkinFor', () => {
  const rig = buildRigAsset('mannequin', skin(), undefined, 'rig-1')
  const rigs = [rig]

  it('resolves a rigId', () => {
    expect(rigOf({ rigId: 'rig-1' }, rigs)).toBe(rig)
    expect(rigOf({ rigId: 'nope' }, rigs)).toBeUndefined()
    expect(rigOf({}, rigs)).toBeUndefined()
    expect(rigOf(null, rigs)).toBeUndefined()
  })

  it('prefers the rig over an embedded sourceSkin', () => {
    const legacy = skin({ nodeNames: [] })
    expect(sourceSkinFor({ rigId: 'rig-1', sourceSkin: legacy }, rigs)).toBe(rig.skin)
  })

  // The fallback that keeps a pre-rig asset — and an older build reading a newer bundle — working.
  it('falls back to sourceSkin when the rig is gone', () => {
    const legacy = skin()
    expect(sourceSkinFor({ rigId: 'deleted', sourceSkin: legacy }, rigs)).toBe(legacy)
    expect(sourceSkinFor({ sourceSkin: legacy }, rigs)).toBe(legacy)
  })

  it('returns null when there is nothing to retarget from', () => {
    expect(sourceSkinFor({ rigId: 'deleted' }, rigs)).toBeNull()
    expect(sourceSkinFor(null, rigs)).toBeNull()
  })
})

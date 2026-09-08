import { describe, it, expect } from 'vitest'
import { buildBoneMapping, applyManualMapping } from 'cleo'
import type { Skin } from 'cleo'
import { mat4 } from 'gl-matrix'
import {
  buildRigAsset, nodeByName, overridesFor, withOverride, withoutOverrides,
} from '../src/utils/rigAssets'
import type { StoredSkin } from '../src/utils/animationAssets'

// Manual bone re-points used to be discarded: `resolveAnimationAsset` rebuilds the mapping with
// `buildBoneMapping` on every retarget, so a correction made in the import modal survived exactly until
// the next resolve. They are now stored on the TARGET rig, keyed by the SOURCE rig, and replayed.
//
// Stored by NAME rather than node index, and that is the property most of this file exists to pin: node
// indices are stable only within one export, and `skeletonFingerprint` deliberately ignores `nodeNames` so
// a name backfill upgrades a rig IN PLACE — an index-keyed override would then point at the wrong bone.

const ident = () => Array.from(mat4.create())

/** A live `Skin`, which is what the retarget maths consumes. */
function liveSkin(names: string[]): Skin {
  return {
    joints: names.map((_, i) => ({ nodeIndex: i, inverseBindMatrix: mat4.create(), parentIndex: i === 0 ? undefined : i - 1 })),
    skeleton: 0,
    nodeParents: new Map(names.map((_, i) => [i, i - 1]).filter(([, p]) => p >= 0) as [number, number][]),
    nodeTransforms: new Map(names.map((_, i) => [i, mat4.create()])),
    nodeNames: new Map(names.map((n, i) => [i, n])),
  } as Skin
}

/** A clip animating every named bone, so `buildBoneMapping` produces an entry per bone. */
const clipFor = (names: string[]) => ([{
  name: 'clip',
  samplers: [{ input: [0], output: [0, 0, 0, 1], interpolation: 'LINEAR' }],
  channels: names.map((_, i) => ({ samplerIndex: 0, targetNodeIndex: i, targetPath: 'rotation' })),
}] as any[])

const storedSkin = (names: string[]): StoredSkin => ({
  joints: names.map((_, i) => ({ nodeIndex: i, inverseBindMatrix: ident(), parentIndex: i === 0 ? undefined : i - 1 })),
  skeleton: 0,
  nodeNames: names.map((n, i) => [i, n] as [number, string]),
  nodeTransforms: names.map((_, i) => [i, ident()] as [number, number[]]),
})

describe('override storage', () => {
  const rig = buildRigAsset('mannequin', storedSkin(['Hips', 'Spine']), undefined, 'rig-1')

  it('starts with none', () => {
    expect(overridesFor(rig, 'src')).toEqual([])
    expect(overridesFor(rig, undefined)).toEqual([])
    expect(overridesFor(null, 'src')).toEqual([])
  })

  it('records a re-point, keyed by source rig', () => {
    const next = withOverride(rig, 'src', 'mixamorig:Spine', 'Spine')
    expect(overridesFor(next, 'src')).toEqual([{ sourceName: 'mixamorig:Spine', targetName: 'Spine' }])
    expect(overridesFor(next, 'other')).toEqual([])
  })

  it('records a deliberate DROP as null, distinct from having no override', () => {
    const next = withOverride(rig, 'src', 'mixamorig:Tail', null)
    expect(overridesFor(next, 'src')).toEqual([{ sourceName: 'mixamorig:Tail', targetName: null }])
  })

  it('replaces rather than appends when the same bone is re-pointed twice', () => {
    const a = withOverride(rig, 'src', 'Bone', 'Hips')
    const b = withOverride(a, 'src', 'Bone', 'Spine')
    expect(overridesFor(b, 'src')).toEqual([{ sourceName: 'Bone', targetName: 'Spine' }])
  })

  it('removes an override when the target is undefined — back to the automatic match', () => {
    const a = withOverride(rig, 'src', 'Bone', 'Hips')
    expect(overridesFor(withOverride(a, 'src', 'Bone', undefined), 'src')).toEqual([])
  })

  // An empty override set and no override set mean the same thing; keeping both shapes would make every
  // equality check ambiguous.
  it('drops the key entirely when the last override goes', () => {
    const a = withOverride(rig, 'src', 'Bone', 'Hips')
    expect(withOverride(a, 'src', 'Bone', undefined).retargets).toBeUndefined()
    expect(withoutOverrides(a, 'src').retargets).toBeUndefined()
  })

  it('leaves other source rigs alone when one is cleared', () => {
    let r = withOverride(rig, 'srcA', 'Bone', 'Hips')
    r = withOverride(r, 'srcB', 'Bone', 'Spine')
    expect(overridesFor(withoutOverrides(r, 'srcA'), 'srcB')).toHaveLength(1)
  })

  // The library is React state and `updateRig` diffs by identity.
  it('never mutates the rig it is given', () => {
    withOverride(rig, 'src', 'Bone', 'Hips')
    expect(rig.retargets).toBeUndefined()
  })

  it('is a no-op clearing a source rig that has none', () => {
    expect(withoutOverrides(rig, 'nope')).toBe(rig)
  })
})

describe('nodeByName', () => {
  it('reads a stored skin\'s entry pairs', () => {
    expect(nodeByName(storedSkin(['Hips', 'Spine']).nodeNames)).toEqual(new Map([['Hips', 0], ['Spine', 1]]))
  })

  // The retarget path holds a LIVE skin, whose name table is a Map.
  it('reads a live skin\'s Map', () => {
    expect(nodeByName(liveSkin(['Hips']).nodeNames)).toEqual(new Map([['Hips', 0]]))
  })

  it('is empty for a skin with no names', () => {
    expect(nodeByName(undefined).size).toBe(0)
  })
})

describe('replaying overrides onto a built mapping', () => {
  const source = liveSkin(['mixamorig:Hips', 'mixamorig:Spine'])
  const target = liveSkin(['Hips', 'chest'])
  const clips = clipFor(['mixamorig:Hips', 'mixamorig:Spine'])

  const targetOf = (m: any, sourceNode: number) =>
    m.entries.find((e: any) => e.sourceNode === sourceNode)?.targetNode

  it('the automatic match leaves the odd bone out', () => {
    const mapping = buildBoneMapping(clips, source, target)
    // Hips matches by normalized name; Spine -> chest does not, which is what the user must fix by hand.
    expect(targetOf(mapping, 0)).toBe(0)
    expect(targetOf(mapping, 1)).not.toBe(1)
  })

  it('an override beats the automatic match', () => {
    const mapping = buildBoneMapping(clips, source, target)
    const fixed = applyManualMapping(mapping, 1, 1)
    expect(targetOf(fixed, 1)).toBe(1)
    expect(fixed.entries.find((e: any) => e.sourceNode === 1)?.kind).toBe('manual')
  })

  // Without this the raw fast path copies the clip verbatim and the override is ignored entirely.
  it('forces sameRig false so the raw path cannot swallow it', () => {
    const same = buildBoneMapping(clipFor(['Hips', 'chest']), target, target)
    expect(same.sameRig).toBe(true)
    expect(applyManualMapping(same, 1, 0).sameRig).toBe(false)
  })

  it('records a deliberate drop as no target', () => {
    const mapping = buildBoneMapping(clips, source, target)
    const dropped = applyManualMapping(mapping, 1, null)
    expect(targetOf(dropped, 1)).toBeNull()
    expect(dropped.entries.find((e: any) => e.sourceNode === 1)?.kind).toBe('none')
  })

  /**
   * The case that decides name-keying. `importSkeletonNames` backfills bone names onto a skeleton, which
   * can renumber nothing but DOES change which node a name sits on when the skeletons differ. A stored
   * override must follow the NAME.
   */
  it('a name-keyed override survives a skeleton whose bones sit at different indices', () => {
    // Same bones, opposite order — so node index 1 means a different bone on each side.
    const reordered = liveSkin(['chest', 'Hips'])
    const names = nodeByName(reordered.nodeNames)

    expect(names.get('chest')).toBe(0)
    expect(names.get('Hips')).toBe(1)

    const mapping = buildBoneMapping(clips, source, reordered)
    const fixed = applyManualMapping(mapping, 1, names.get('chest')!)
    expect(targetOf(fixed, 1)).toBe(0) // resolved by NAME; an index-keyed override would have said 1
  })
})

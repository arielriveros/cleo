import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { mat4, quat } from 'gl-matrix'
import { buildBoneMapping, resetClipEditWarnings } from 'cleo'
import type { Skin } from 'cleo'
import { registerRigResolver, resolveAnimationAsset, invalidateAnimationCache } from '../src/utils/animationResolve'
import { buildRigAsset } from '../src/utils/rigAssets'
import type { AnimationAsset, StoredClip, StoredSkin } from '../src/utils/animationAssets'

// A clip's edit stack is applied at RESOLVE, in source-rig space, and the exact point it runs at is the
// whole design. `buildBoneMapping` decides which source bones exist by SCANNING the clips, so an edit that
// adds a channel has to run before that scan or the new curve is dropped by `retargetAnimation` with
// nothing logged — the "raise the right arm on all thirty torch clips" feature would silently do nothing
// for precisely the clips that needed it.
//
// The other half is that the editor and the published player must agree. They are two separate
// implementations of the same pipeline, and a divergence is only ever discovered by playing the export.

const ident = () => Array.from(mat4.create())

const STORED_SKIN: StoredSkin = {
  name: 'Armature',
  skeleton: 0,
  joints: [0, 1, 2, 3].map(i => ({ nodeIndex: i, inverseBindMatrix: ident(), parentIndex: i === 0 ? undefined : i === 1 ? 0 : 1 })),
  nodeNames: [[0, 'Hips'], [1, 'Spine'], [2, 'LeftArm'], [3, 'RightArm']],
  nodeTransforms: [
    [0, Array.from(mat4.fromTranslation(mat4.create(), [0, 1, 0]))],
    [1, Array.from(mat4.fromTranslation(mat4.create(), [0, 0.2, 0]))],
    [2, Array.from(mat4.fromTranslation(mat4.create(), [0.2, 0, 0]))],
    [3, Array.from(mat4.fromTranslation(mat4.create(), [-0.2, 0, 0]))],
  ],
}

/** The same skeleton as a live `Skin` — what the retarget maths consumes as the target. */
function liveSkin(): Skin {
  return {
    name: STORED_SKIN.name,
    skeleton: 0,
    joints: STORED_SKIN.joints.map(j => ({ nodeIndex: j.nodeIndex, inverseBindMatrix: mat4.create(), parentIndex: j.parentIndex })),
    nodeParents: new Map([[1, 0], [2, 1], [3, 1]]),
    nodeNames: new Map(STORED_SKIN.nodeNames as [number, string][]),
    nodeTransforms: new Map((STORED_SKIN.nodeTransforms as [number, number[]][]).map(([k, v]) => [k, mat4.clone(v as any)])),
  }
}

const qz = (deg: number) => Array.from(quat.setAxisAngle(quat.create(), [0, 0, 1], deg * Math.PI / 180))

/** A clip driving only the LEFT arm. */
const leftArmClip = (edits?: any[]): StoredClip => ({
  name: 'Wave',
  samplers: [{ input: [0, 1], output: [...qz(0), ...qz(30)], interpolation: 'LINEAR' }],
  channels: [{ samplerIndex: 0, targetNodeIndex: 2, targetPath: 'rotation' }],
  ...(edits ? { edits } : {}),
})

const assetOf = (clips: StoredClip[]): AnimationAsset =>
  ({ id: 'anim-1', name: 'Wave', clips, sourceSkin: null, rigId: 'rig-1' })

const chanFor = (clips: any[], node: number) =>
  clips[0].channels.find((c: any) => c.targetNodeIndex === node && c.targetPath === 'rotation')

beforeEach(() => {
  invalidateAnimationCache()
  resetClipEditWarnings()
})

describe('the edit stack in resolveAnimationAsset', () => {
  const rig = (poses?: any[]) => ({ ...buildRigAsset('mannequin', STORED_SKIN, undefined, 'rig-1'), poses })

  it('leaves a clip with no stack completely alone', () => {
    registerRigResolver(() => rig())
    const clip = leftArmClip()
    const out = resolveAnimationAsset(assetOf([clip]), liveSkin())
    expect(chanFor(out, 2)).toBeTruthy()          // still the left arm
    expect(chanFor(out, 3)).toBeFalsy()
    expect(out[0].samplers[0].output).toEqual(clip.samplers[0].output)
  })

  it('applies a mirror, moving the curve to the other arm', () => {
    registerRigResolver(() => rig())
    const out = resolveAnimationAsset(assetOf([leftArmClip([{ kind: 'mirror', axis: 'x' }])]), liveSkin())
    expect(chanFor(out, 3)).toBeTruthy()
    expect(chanFor(out, 2)).toBeFalsy()
  })

  it('honours `enabled: false` without rebuilding the clip', () => {
    registerRigResolver(() => rig())
    const out = resolveAnimationAsset(assetOf([leftArmClip([{ kind: 'mirror', axis: 'x', enabled: false }])]), liveSkin())
    expect(chanFor(out, 2)).toBeTruthy()
  })

  // THE ordering property. A pose offset naming a bone the clip never drove adds a channel, and that
  // channel only survives if the mapping was built from the EDITED clips.
  it('keeps a channel a poseOffset adds for a bone the clip never drove', () => {
    registerRigResolver(() => rig([{ id: 'torch', name: 'Torch grip', bones: [{ name: 'RightArm', rotation: qz(25) }] }]))
    const out = resolveAnimationAsset(assetOf([leftArmClip([{ kind: 'poseOffset', poseId: 'torch' }])]), liveSkin())
    const added = chanFor(out, 3)
    expect(added, 'the pose offset\'s new channel was dropped by the retarget').toBeTruthy()
    expect(out[0].samplers[added.samplerIndex].output).toHaveLength(8) // two keys, never one
  })

  it('...which the mapping would NOT have contained had it been built from the unedited clips', () => {
    // The negative half, stated directly against `buildBoneMapping` so the reason the ordering matters is
    // pinned rather than merely implied by the test above.
    const unedited = buildBoneMapping([leftArmClip() as any], liveSkin(), liveSkin())
    expect(unedited.entries.some(e => e.sourceNode === 3)).toBe(false)
  })

  it('resolves a shared pose from the SOURCE rig, not the target', () => {
    // The offset is authored in source space, so it must be looked up on the rig the clips belong to.
    registerRigResolver(id => (id === 'rig-1' ? rig([{ id: 'torch', name: 'Torch', bones: [{ name: 'RightArm', rotation: qz(25) }] }]) : null) as any)
    const out = resolveAnimationAsset(assetOf([leftArmClip([{ kind: 'poseOffset', poseId: 'torch' }])]), liveSkin())
    expect(chanFor(out, 3)).toBeTruthy()
  })

  it('still stamps assetId, so an edited clip is never serialized into a scene', () => {
    registerRigResolver(() => rig())
    const out = resolveAnimationAsset(assetOf([leftArmClip([{ kind: 'mirror', axis: 'x' }])]), liveSkin())
    expect(out[0].assetId).toBe('anim-1')
  })

  it('applies a skeleton-free edit even when the asset has no source skin at all', () => {
    // A pre-rig asset with no embedded skin cannot mirror — but a retime needs no skeleton, and skipping
    // the whole stack would apply it in some projects and not others.
    registerRigResolver(() => null)
    const legacy: AnimationAsset = { id: 'anim-2', name: 'W', clips: [leftArmClip([{ kind: 'timeScale', scale: 2 }])], sourceSkin: null }
    const out = resolveAnimationAsset(legacy, liveSkin())
    expect(out[0].samplers[0].input).toEqual([0, 2])
  })

  it('re-resolves from scratch once the cache is invalidated', () => {
    // The stack lives on the asset, so an edit reaches characters only through `invalidateAnimationCache`.
    registerRigResolver(() => rig())
    const first = resolveAnimationAsset(assetOf([leftArmClip()]), liveSkin(), 'model-1')
    expect(resolveAnimationAsset(assetOf([leftArmClip()]), liveSkin(), 'model-1')).toBe(first) // cached
    invalidateAnimationCache('anim-1')
    const after = resolveAnimationAsset(assetOf([leftArmClip([{ kind: 'mirror', axis: 'x' }])]), liveSkin(), 'model-1')
    expect(after).not.toBe(first)
    expect(chanFor(after, 3)).toBeTruthy()
  })
})

// Two implementations of one pipeline. A difference between them is invisible until someone exports the
// game and watches a character animate differently than it did in the editor.
describe('the editor and the player apply the stack identically', () => {
  const read = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf-8').replace(/\r\n/g, '\n')
  const resolveSrc = () => read('src', 'utils', 'animationResolve.ts')
  const playerSrc = () => read('src', 'player', 'animations.ts')

  it('both call applyClipEdits', () => {
    expect(resolveSrc()).toContain('applyClipEdits')
    expect(playerSrc()).toContain('applyClipEdits')
  })

  it('both apply it BEFORE building the bone mapping', () => {
    for (const src of [resolveSrc(), playerSrc()]) {
      expect(src.indexOf('applyClipEdits')).toBeLessThan(src.indexOf('buildBoneMapping('))
    }
  })

  it('both retarget the EDITED clips, never the originals', () => {
    // The subtle version of the bug: edits computed, then thrown away by retargeting the source array.
    expect(resolveSrc()).toContain('edited.map(c => retargetAnimation(')
    expect(playerSrc()).toContain('for (const c of edited)')
  })

  it('both build the mapping from the edited clips', () => {
    expect(resolveSrc()).toContain('buildBoneMapping(edited,')
    expect(playerSrc()).toContain('buildBoneMapping(edited,')
  })

  it('the player is handed the rig poses a poseOffset needs', () => {
    // The rig itself is not shipped, so publish flattens its poses onto each animation. Without them a
    // posed clip plays with the offset silently missing.
    expect(playerSrc()).toContain('asset.poses')
    expect(read('src', 'features', 'publish', 'buildMultiSceneGameData.ts')).toContain('rig?.poses?.length')
  })
})

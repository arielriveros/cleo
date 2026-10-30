import { describe, it, expect } from 'vitest'
import { assetWithRagdollProfile, assetRagdollProfile } from '../src/utils/modelClips'
import { applyRagdollProfile } from '../src/utils/placedAnimation'
import { hashAsset } from '../src/utils/assetHash'

// The ragdoll profile is authored on the rig and travels inside the model's skin, like sockets: the
// runtime and the published game never see a rig.

const profile = () => ({
  version: 1 as const, totalMass: 70, selfCollision: true, linearDamping: 0.02, angularDamping: 0.2, solverIterations: 20,
  parts: [{ name: 'Pelvis', bone: 'Hips', shape: 'box', radius: 0.15, massFraction: 0.14, joint: { type: 'cone', swing: 0, twist: 0, hingeMin: 0, hingeMax: 0 } }],
})

const asset = () => ({
  nodeJson: { children: [{ model: { skin: { joints: [] } } }, { children: [{ model: { skin: { joints: [] } } }] }] },
})

describe('assetWithRagdollProfile', () => {
  it('embeds the profile into every skinned model, and clears it', () => {
    const next = assetWithRagdollProfile(asset(), profile())
    expect(next.nodeJson.children[0].model.skin.ragdollProfile).toEqual(profile())
    expect((next.nodeJson.children[1] as any).children[0].model.skin.ragdollProfile).toEqual(profile())
    expect(assetRagdollProfile(next)).toEqual(profile())
    const cleared = assetWithRagdollProfile(next, null)
    expect(cleared.nodeJson.children[0].model.skin.ragdollProfile).toBeUndefined()
  })

  it('hands the original back on a no-op', () => {
    const once = assetWithRagdollProfile(asset(), profile())
    expect(assetWithRagdollProfile(once, profile())).toBe(once)
    const bare = asset()
    expect(assetWithRagdollProfile(bare, null)).toBe(bare)
  })

  // A profile edit is pushed to live instances in place; it must not read as a content change that
  // rebuilds every placed character (and drops its per-node state).
  it('does not change the asset hash', () => {
    const bare = asset()
    expect(hashAsset(assetWithRagdollProfile(bare, profile()) as any)).toBe(hashAsset(bare as any))
  })
})

describe('applyRagdollProfile', () => {
  it('copies the profile onto every placed skin', () => {
    const skin: any = {}
    const placed: any = { animator: {}, model: { skin }, children: [] }
    applyRagdollProfile(placed, profile())
    expect(skin.ragdollProfile).toEqual(profile())
    applyRagdollProfile(placed, null)
    expect(skin.ragdollProfile).toBeUndefined()
  })
})

import { describe, it, expect } from 'vitest'
import { extractRigs } from '../src/utils/rigMigration'
import { skinnedModelJsonsOf } from '../src/utils/modelClips'
import { buildRigAsset, skeletonFingerprint } from '../src/utils/rigAssets'
import type { AnimationAsset, StoredSkin } from '../src/utils/animationAssets'

// The migration runs once over a real project's whole model library. Every property below is one a bad run
// would break silently — a duplicated skeleton, a lost bone-name table, or a multi-megabyte rewrite of
// models that did not change.

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

/** A second, genuinely different skeleton. */
const otherSkin = () => skin({ joints: [{ nodeIndex: 0, inverseBindMatrix: ident().map(v => v + 0.5), parentIndex: undefined }] })

const model = (id: string, name: string, s?: StoredSkin, extra: any = {}) => ({
  id, name,
  nodeJson: s ? { name, children: [{ name: 'mesh', model: { skin: s } }] } : { name, children: [] },
  ...extra,
})

const anim = (id: string, name: string, sourceSkin: StoredSkin | null, extra: any = {}): AnimationAsset =>
  ({ id, name, clips: [{ name, samplers: [], channels: [] }], sourceSkin, ...extra })

const run = (models: any[], animations: AnimationAsset[] = [], rigs: any[] = []) =>
  extractRigs(models, animations, rigs, skinnedModelJsonsOf)

describe('extractRigs', () => {
  it('mints a rig for a skinned model and links it', () => {
    const out = run([model('m1', 'mannequin', skin())])
    expect(out.created).toBe(1)
    expect(out.rigs[0].name).toBe('mannequin')
    expect(out.models[0].rigId).toBe(out.rigs[0].id)
    expect(out.linkedModels).toBe(1)
  })

  it('carries the skeleton onto the rig', () => {
    const out = run([model('m1', 'mannequin', skin())])
    expect(skeletonFingerprint(out.rigs[0].skin)).toBe(skeletonFingerprint(skin()))
  })

  // Property 4: sharing, not duplicating — what makes retargeting between them an identity transform.
  it('gives two models built on one armature the SAME rig', () => {
    const out = run([model('m1', 'player', skin()), model('m2', 'zombie', skin())])
    expect(out.created).toBe(1)
    expect(out.models[0].rigId).toBe(out.models[1].rigId)
  })

  it('gives two genuinely different skeletons two rigs', () => {
    const out = run([model('m1', 'player', skin()), model('m2', 'spider', otherSkin())])
    expect(out.created).toBe(2)
    expect(out.models[0].rigId).not.toBe(out.models[1].rigId)
  })

  it('de-duplicates rig names', () => {
    const out = run([model('m1', 'rig', skin()), model('m2', 'rig', otherSkin())])
    expect(out.rigs.map(r => r.name)).toEqual(['rig', 'rig (2)'])
  })

  // Property 2: a model that gains nothing must come back as the SAME object, or writeModelLibrary's
  // identity diff rewrites the entire library.
  it('returns an unskinned model unchanged, by identity', () => {
    const plain = model('m1', 'rock')
    const out = run([plain])
    expect(out.models[0]).toBe(plain)
    expect(out.created).toBe(0)
    expect(out.rigs).toEqual([])
  })

  it('never collapses two unskinned models onto one meaningless rig', () => {
    const out = run([model('m1', 'rock'), model('m2', 'crate')])
    expect(out.rigs).toEqual([])
  })

  // Property 6: the old pass took only the FIRST skinned sub-mesh.
  it('indexes every skinned sub-mesh, not just the first', () => {
    const multi = {
      id: 'm1', name: 'knight',
      nodeJson: {
        name: 'knight',
        children: [
          { name: 'body', model: { skin: skin() } },
          { name: 'armour', model: { skin: otherSkin() } },
        ],
      },
    }
    const out = run([multi])
    expect(out.created).toBe(2)
    // The model itself links the first — but the second is in the library, so a clip authored against it
    // can still find a rig.
    expect(out.models[0].rigId).toBe(out.rigs[0].id)
    expect(out.rigs.map(r => r.name)).toEqual(['knight', 'knight 2'])
  })

  it('finds a skeleton on the root node itself', () => {
    const out = run([{ id: 'm1', name: 'solo', nodeJson: { name: 'solo', model: { skin: skin() } } }])
    expect(out.created).toBe(1)
  })

  describe('animations', () => {
    it('points an animation at the rig matching its source skin', () => {
      const out = run([], [anim('a1', 'Idle', skin())])
      expect(out.created).toBe(1)
      expect(out.animations[0].rigId).toBe(out.rigs[0].id)
      expect(out.linkedAnimations).toBe(1)
    })

    // Property 5, and the whole point of the fingerprint: the clip lands on the SAME rig as the character
    // it was authored against, so resolving it is an identity retarget.
    it('lands on the same rig as the model it was authored against', () => {
      const out = run([model('m1', 'mannequin', skin())], [anim('a1', 'Idle', skin())])
      expect(out.created).toBe(1)
      expect(out.animations[0].rigId).toBe(out.models[0].rigId)
    })

    // Property: never destructive. sourceSkin is the fallback and the cross-version bundle read.
    it('keeps sourceSkin in place', () => {
      const out = run([], [anim('a1', 'Idle', skin())])
      expect(out.animations[0].sourceSkin).not.toBeNull()
    })

    it('leaves an animation with no source skin alone, by identity', () => {
      const bare = anim('a1', 'Idle', null)
      const out = run([], [bare])
      expect(out.animations[0]).toBe(bare)
      expect(out.rigs).toEqual([])
    })
  })

  describe('idempotence', () => {
    // Property 1. The migration is stamped by version, but a re-run must still be a no-op — a stamp can be
    // cleared, and a bundle import brings in records that have already been through it.
    it('mints nothing on a second run and is deep-equal', () => {
      const first = run([model('m1', 'mannequin', skin())], [anim('a1', 'Idle', skin())])
      const second = extractRigs(first.models, first.animations, first.rigs, skinnedModelJsonsOf)

      expect(second.created).toBe(0)
      expect(second.linkedModels).toBe(0)
      expect(second.linkedAnimations).toBe(0)
      expect(second.rigs).toEqual(first.rigs)
      expect(second.models).toEqual(first.models)
      expect(second.animations).toEqual(first.animations)
    })

    it('reuses a rig that already exists in the library', () => {
      const existing = buildRigAsset('preexisting', skin(), undefined, 'rig-1')
      const out = run([model('m1', 'mannequin', skin())], [], [existing])
      expect(out.created).toBe(0)
      expect(out.models[0].rigId).toBe('rig-1')
    })

    // Property 3 of the v2 pass, restated: a project already migrated gains only rig links.
    it('leaves an already-linked model and animation untouched', () => {
      const existing = buildRigAsset('preexisting', skin(), undefined, 'rig-1')
      const m = model('m1', 'mannequin', skin(), { rigId: 'rig-1' })
      const a = anim('a1', 'Idle', skin(), { rigId: 'rig-1' })
      const out = run([m], [a], [existing])
      expect(out.models[0]).toBe(m)
      expect(out.animations[0]).toBe(a)
    })

    it('re-links a model whose rig was deleted', () => {
      const out = run([model('m1', 'mannequin', skin(), { rigId: 'gone' })])
      expect(out.created).toBe(1)
      expect(out.models[0].rigId).not.toBe('gone')
    })
  })

  describe('preferRicherSkin integration', () => {
    // nodeTransforms is excluded from the fingerprint, so two rigs can match while only one carries the
    // rest pose — and buildBoneMapping needs it. Collapsing onto the poorer one loses the retarget.
    it('upgrades a stored rig when a richer copy of the same skeleton arrives', () => {
      const bare = buildRigAsset('bare', skin({ nodeTransforms: [] }), undefined, 'rig-1')
      const out = run([model('m1', 'mannequin', skin())], [], [bare])

      expect(out.created).toBe(0)
      expect(out.rigs).toHaveLength(1)
      expect(out.rigs[0].id).toBe('rig-1')
      expect(out.rigs[0].skin.nodeTransforms).toHaveLength(2)
    })

    // The reason nodeNames is out of the fingerprint. With names as part of the identity this forked a
    // second rig and orphaned the first, silently unlinking every animation pointing at it.
    it('backfilled bone names UPGRADE the existing rig instead of forking one', () => {
      const nameless = buildRigAsset('mannequin', skin({ nodeNames: [] }), undefined, 'rig-1')
      const out = run([model('m1', 'mannequin', skin())], [], [nameless])

      expect(out.created).toBe(0)
      expect(out.rigs).toHaveLength(1)
      expect(out.rigs[0].id).toBe('rig-1')
      expect(out.rigs[0].skin.nodeNames).toHaveLength(2)
    })

    it('does not downgrade a rich stored rig', () => {
      const rich = buildRigAsset('rich', skin(), undefined, 'rig-1')
      const out = run([model('m1', 'bare', skin({ nodeTransforms: [] }))], [], [rich])
      expect(out.rigs[0].skin.nodeTransforms).toHaveLength(2)
    })
  })
})

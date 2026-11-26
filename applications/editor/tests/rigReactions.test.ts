import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { parseReactionSets, reactionParamKeys, MUSCLE_SPECS, PIN_SPECS, THRESHOLD_SPECS, BEHAVIOUR_SPECS } from 'cleo'
import { assetWithReactionSets, assetReactionSets } from '../src/utils/modelClips'
import { applyReactionSets } from '../src/utils/placedAnimation'
import { hashAsset } from '../src/utils/assetHash'
import { runtimeReactionSets, reactionsUsePose, type RigReactions } from '../src/utils/reactionSets'
import { benchReactionSet } from '../src/features/rig/reactions/benchSet'
import type { PoseAsset } from '../src/utils/poseAssets'

// A rig's reaction sets are authored on the rig (the Reactions tab) and travel inside the model's skin, like the
// ragdoll profile: the runtime and the published game never see a rig. A behaviour's pose slot names a pose ASSET
// on the rig, and is embedded with that pose's bones resolved.

const poseAssets = (): PoseAsset[] => [{
  id: 'pa', name: 'Reaction poses', rigId: 'rig', poses: [
    { id: 'curl', name: 'Curl', bones: [{ name: 'Spine', rotation: [0.2, 0, 0, 0.98] }] },
    { id: 'curlTight', name: 'Curl tight', bones: [{ name: 'Neck', rotation: [0.1, 0, 0, 0.995] }], baseRef: { assetId: 'pa', poseId: 'curl' } },
  ],
}]

const reactions = (): RigReactions => ({
  version: 1, defaultSet: 'tough', sets: [
    { id: 'default', name: 'Default', strength: 1, behaviours: { tumble: { enabled: true, params: {}, poses: { curl: { poseRef: { assetId: 'pa', poseId: 'curlTight' } } } } } },
    { id: 'tough', name: 'Tough', strength: 1.4, behaviours: { hitReact: { enabled: true, params: { weakness: 0.1 } } } },
  ],
})

const asset = () => ({
  nodeJson: { children: [{ model: { skin: { joints: [] } } }, { children: [{ model: { skin: { joints: [] } } }] }] },
})

describe('runtimeReactionSets', () => {
  it('resolves each pose slot into its bones, keeping the link', () => {
    const rt = runtimeReactionSets(reactions(), poseAssets())!
    expect(rt.defaultSet).toBe('tough')
    const slot = rt.sets[0].behaviours.tumble.poses.curl
    expect(slot.poseRef).toEqual({ assetId: 'pa', poseId: 'curlTight' })
    // A variant: its own bones composed onto its base's, and the base kept as its reference.
    expect(slot.pose.name).toBe('Curl tight')
    expect(slot.pose.bones.map((b: any) => b.name).sort()).toEqual(['Neck', 'Spine'])
    expect(slot.pose.reference.map((b: any) => b.name)).toEqual(['Spine'])
    // The set the runtime parses from it reads the pose.
    const parsed = parseReactionSets(rt)!
    expect(parsed.sets[0].behaviours.tumble.poses?.curl?.pose?.bones.length).toBe(2)
  })

  it('keeps a slot whose pose is gone as a bare link, and drops none', () => {
    const r = reactions()
    r.sets[0].behaviours.tumble.poses.curl.poseRef.poseId = 'nope'
    const rt = runtimeReactionSets(r, poseAssets())!
    expect(rt.sets[0].behaviours.tumble.poses.curl).toEqual({ poseRef: { assetId: 'pa', poseId: 'nope' } })
  })

  it('is null for a rig without sets, and does not touch the rig', () => {
    expect(runtimeReactionSets(undefined, [])).toBeNull()
    expect(runtimeReactionSets({ version: 1, sets: [] }, [])).toBeNull()
    const r = reactions(), before = JSON.stringify(r)
    runtimeReactionSets(r, poseAssets())
    expect(JSON.stringify(r)).toBe(before)
  })

  it('is the same for the same input (an equal embed writes nothing)', () => {
    expect(JSON.stringify(runtimeReactionSets(reactions(), poseAssets()))).toBe(JSON.stringify(runtimeReactionSets(reactions(), poseAssets())))
  })

  it('tells which rigs a pose edit must re-embed', () => {
    expect(reactionsUsePose(reactions(), new Set(['curlTight']))).toBe(true)
    expect(reactionsUsePose(reactions(), new Set(['other']))).toBe(false)
    expect(reactionsUsePose(undefined, new Set(['curlTight']))).toBe(false)
  })
})

describe('assetWithReactionSets', () => {
  it('embeds the sets into every skinned model, and clears them', () => {
    const rt = runtimeReactionSets(reactions(), poseAssets())
    const next = assetWithReactionSets(asset(), rt)
    expect(next.nodeJson.children[0].model.skin.reactionSets).toEqual(rt)
    expect((next.nodeJson.children[1] as any).children[0].model.skin.reactionSets).toEqual(rt)
    expect(assetReactionSets(next)).toEqual(rt)
    const cleared = assetWithReactionSets(next, null)
    expect(cleared.nodeJson.children[0].model.skin.reactionSets).toBeUndefined()
  })

  it('hands the original back on a no-op', () => {
    const rt = runtimeReactionSets(reactions(), poseAssets())
    const once = assetWithReactionSets(asset(), rt)
    expect(assetWithReactionSets(once, runtimeReactionSets(reactions(), poseAssets()))).toBe(once)
    const bare = asset()
    expect(assetWithReactionSets(bare, null)).toBe(bare)
  })

  // A set edit is pushed to live instances in place; it must not read as a content change that rebuilds every
  // placed character (and drops its per-node state).
  it('does not change the asset hash', () => {
    const bare = asset()
    expect(hashAsset(assetWithReactionSets(bare, runtimeReactionSets(reactions(), poseAssets())) as any)).toBe(hashAsset(bare as any))
  })
})

describe('applyReactionSets', () => {
  it('copies the sets onto every placed skin, and clears them', () => {
    const skin: any = {}
    const placed: any = { animator: {}, model: { skin }, children: [] }
    const rt = runtimeReactionSets(reactions(), poseAssets())
    applyReactionSets(placed, rt)
    expect(skin.reactionSets).toEqual(rt)
    expect(skin.reactionSets).not.toBe(rt)
    applyReactionSets(placed, null)
    expect(skin.reactionSets).toBeUndefined()
  })
})

describe('the set the bench runs', () => {
  it('is the edited set, poses resolved, else the built-in default', () => {
    const tough = benchReactionSet(reactions(), poseAssets(), 1)
    expect(tough.name).toBe('Tough')
    expect(tough.strength).toBeCloseTo(1.4)
    expect(tough.behaviours.hitReact.params.weakness).toBeCloseTo(0.1)
    expect(benchReactionSet(reactions(), poseAssets(), 0).behaviours.tumble.poses?.curl?.pose).toBeTruthy()
    expect(benchReactionSet(undefined, [], 0).name).toBe('Default')
  })
})

describe('the inspector picks a set per character', () => {
  it('stores it in ragdollConfig.reactions, with Off and the skeleton default', () => {
    const rows = readFileSync(join(__dirname, '..', 'src', 'features', 'nodeInspector', 'propertyEditors', 'CharacterRows.tsx'), 'utf-8')
    expect(rows).toContain("onChange={reactions => setRagdoll({ ...ragdoll, reactions })}")
    expect(rows).toContain("set({ enabled: false, set: undefined })")
    expect(rows).toContain("eventEmitter.emit('FOCUS_RIG_ASSET', { kind: 'reactions' })")
  })
})

// The docs page is the tab's tooltips (docs-driven tooltips): every label the tab shows needs a row there, or its
// hover card is empty.
describe('docs/editor/reactions.md', () => {
  const doc = readFileSync(join(__dirname, '..', '..', '..', 'docs', 'editor', 'reactions.md'), 'utf-8')
  const rowOf = (label: string) => doc.includes(`| **${label}** |`)

  it('has a row for every muscle, pin, threshold and behaviour parameter', () => {
    const missing: string[] = []
    for (const s of [...MUSCLE_SPECS, ...PIN_SPECS, ...THRESHOLD_SPECS]) if (!rowOf(s.label)) missing.push(s.label)
    for (const b of BEHAVIOUR_SPECS) {
      if (!doc.includes(`### ${b.label}`)) missing.push(`### ${b.label}`)
      for (const s of b.params) if (!rowOf(s.label)) missing.push(`${b.label}: ${s.label}`)
      for (const slot of b.poses ?? []) if (!rowOf(slot.label)) missing.push(`${b.label} pose: ${slot.label}`)
      for (const slot of b.clips ?? []) if (!rowOf(slot.label)) missing.push(`${b.label} clip: ${slot.label}`)
    }
    expect(missing).toEqual([])
  })

  it('names every tunable number the sets carry', () => {
    // The flat key list is what a script's useSet() and the parse accept: the docs and it must not drift.
    expect(reactionParamKeys().length).toBeGreaterThan(40)
  })
})

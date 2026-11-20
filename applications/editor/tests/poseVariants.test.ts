import { describe, it, expect } from 'vitest'
import { quat } from 'gl-matrix'
import type { AnimationStateMachine } from 'cleo'
import {
  buildPoseAsset, composePoseBones, posesForRig, poseSampleKey, poseTree, relativePoseBones, resolvedPoseFor,
  resolvePoseBones, variantsOf, type PoseAsset,
} from '../src/utils/poseAssets'
import { toRuntimeField, buildAnimationFieldAsset, reembedFields, type AnimationFieldAsset } from '../src/utils/animationFields'
import { machineLinks, reembedMachine, reembedPoses, resolveMachineLinks } from '../src/utils/animationControllers'
import { resolveTablePose } from '../../../src/animation/animationPose'
import { edgesOfAsset } from '../src/utils/assetEdges'
import type { StoredPoseBone } from '../src/utils/animationAssets'

// Pose VARIANTS: a pose stored relative to another (`baseRef`), so editing the base moves it. Everything that
// plays a pose reads it resolved; a variant also embeds its base as `reference`, what an additive layer
// measures it from. A blend space of an aim pose's variants is how an aim offset follows an edit to the aim.

const axis = (a: [number, number, number], deg: number) => {
  const q = quat.setAxisAngle(quat.create(), a, deg * Math.PI / 180)
  return [q[0], q[1], q[2], q[3]]
}
const X: [number, number, number] = [1, 0, 0], Y: [number, number, number] = [0, 1, 0]
const rot = (b: StoredPoseBone | undefined) => quat.fromValues(...(b!.rotation as [number, number, number, number]))
const sameTurn = (a: StoredPoseBone | undefined, b: number[]) => expect(Math.abs(quat.dot(rot(a), quat.fromValues(...(b as [number, number, number, number]))))).toBeCloseTo(1, 6)

const library = (): PoseAsset[] => [
  buildPoseAsset('Rifle Poses', 'rig', [
    { id: 'aim', name: 'Aim', bones: [{ name: 'Spine', rotation: axis(Y, 20) }, { name: 'Hips', translation: [0, -0.1, 0] }] },
    { id: 'up', name: 'Aim Up', baseRef: { assetId: 'rifle', poseId: 'aim' }, bones: [{ name: 'Spine', rotation: axis(X, -30) }] },
    { id: 'upMore', name: 'Aim Up More', baseRef: { assetId: 'rifle', poseId: 'up' }, bones: [{ name: 'Spine', rotation: axis(X, -10) }] },
  ], 'rifle'),
]

describe('pose variants: composing', () => {
  it('composes a variant onto its base in the parent frame, and back', () => {
    const base = library()[0].poses[0].bones
    const rel = [{ name: 'Spine', rotation: axis(X, -30) }, { name: 'Head', rotation: axis(Y, 5) }]
    const composed = composePoseBones(base, rel)
    sameTurn(composed.find(b => b.name === 'Spine'), Array.from(quat.multiply(quat.create(), rot(rel[0]), rot(base[0]))))
    expect(composed.find(b => b.name === 'Hips')!.translation).toEqual([0, -0.1, 0])   // the base's, untouched
    sameTurn(composed.find(b => b.name === 'Head'), rel[1].rotation)                    // a bone the base lacks: from rest
    const back = relativePoseBones(composed, base)
    expect(back.map(b => b.name)).toEqual(['Spine', 'Head'])                             // Hips is where the base has it
    sameTurn(back[0], rel[0].rotation)
  })

  it('stores rotations with w >= 0, so equal turns write equal JSON', () => {
    const q = axis(Y, 20).map(v => -v)
    const out = composePoseBones([{ name: 'Spine', rotation: q }], [])
    expect(out[0].rotation![3]).toBeGreaterThan(0)
  })

  it('resolves a chain of variants all the way down', () => {
    const lib = library()
    const { bones, broken } = resolvePoseBones(lib, lib[0].poses[2])
    expect(broken).toBe(false)
    const expected = quat.multiply(quat.create(), rot({ name: '', rotation: axis(X, -10) }),
      quat.multiply(quat.create(), rot({ name: '', rotation: axis(X, -30) }), rot({ name: '', rotation: axis(Y, 20) })))
    sameTurn(bones.find(b => b.name === 'Spine'), Array.from(expected))
  })

  it('survives a loop and a missing base, flagging them', () => {
    const lib: PoseAsset[] = [buildPoseAsset('P', 'rig', [
      { id: 'a', name: 'A', baseRef: { assetId: 'p', poseId: 'b' }, bones: [{ name: 'Spine', rotation: axis(Y, 1) }] },
      { id: 'b', name: 'B', baseRef: { assetId: 'p', poseId: 'a' }, bones: [{ name: 'Spine', rotation: axis(Y, 2) }] },
      { id: 'c', name: 'C', baseRef: { assetId: 'p', poseId: 'gone' }, bones: [{ name: 'Spine', rotation: axis(Y, 3) }] },
    ], 'p')]
    expect(resolvePoseBones(lib, lib[0].poses[0]).broken).toBe(true)
    expect(resolvePoseBones(lib, lib[0].poses[2]).broken).toBe(true)
    const tree = poseTree(lib, 'rig')
    expect(tree.map(n => n.pose.id).sort()).toEqual(['a', 'c'])   // the loop broken at its first pose, nothing lost
    expect(tree.every(n => n.broken)).toBe(true)
  })

  it('finds a base in another asset (a variant of a read-only Creator pose)', () => {
    const lib: PoseAsset[] = [
      buildPoseAsset('Creator Aim', 'rig', [{ id: 'cr_aim_pose', name: 'Aim', bones: [{ name: 'Spine', rotation: axis(Y, 20) }] }], 'cr_aim'),
      buildPoseAsset('Rig Poses', 'rig', [{ id: 'v', name: 'Up', baseRef: { assetId: 'cr_aim', poseId: 'cr_aim_pose' }, bones: [{ name: 'Spine', rotation: axis(X, -30) }] }], 'mine'),
    ]
    const pose = resolvedPoseFor(lib, { assetId: 'mine', poseId: 'v' })!
    sameTurn(pose.reference![0], axis(Y, 20))
    expect(poseTree(lib, 'rig').map(n => [n.pose.id, n.variants.map(v => v.pose.id)])).toEqual([['cr_aim_pose', ['v']]])
    expect(edgesOfAsset('pose', lib[1]).map(e => `${e.to.kind}:${e.to.id}`)).toContain('pose:cr_aim')
  })
})

describe('pose variants: embedding', () => {
  it('embeds a variant resolved, with its base as the reference; a plain pose with none', () => {
    const lib = library()
    const up = resolvedPoseFor(lib, { assetId: 'rifle', poseId: 'up' })!
    expect(up.name).toBe('Aim Up')
    expect(up.reference!.map(b => b.name)).toEqual(['Spine', 'Hips'])
    expect(up.bones.find(b => b.name === 'Hips')!.translation).toEqual([0, -0.1, 0])
    expect(resolvedPoseFor(lib, { assetId: 'rifle', poseId: 'aim' })!.reference).toBeUndefined()
    expect(resolvedPoseFor(lib, { assetId: 'rifle', poseId: 'nope' })).toBeNull()
  })

  it('lists every variant of a pose, and resolves them for the rig', () => {
    const lib = library()
    expect(variantsOf(lib, 'aim').map(v => v.pose.id)).toEqual(['up', 'upMore'])
    const forRig = posesForRig({ id: 'rig', name: 'Rig' } as any, lib)
    expect(forRig.find(p => p.id === 'up')!.bones.length).toBe(2)   // resolved: Spine and the base's Hips
  })

  const aimField = (): AnimationFieldAsset => ({
    ...buildAnimationFieldAsset('Rifle Aim', 'rig', 'field1'),
    samples: [
      { clipName: poseSampleKey('aim'), x: 0, poseRef: { assetId: 'rifle', poseId: 'aim' } },
      { clipName: poseSampleKey('up'), x: 1, poseRef: { assetId: 'rifle', poseId: 'up' } },
      { clipName: 'Walk', x: 2 },
    ],
  })

  it('embeds a blend space’s pose samples under their key, each pose once in its table, a dangling one dropped', () => {
    const field = toRuntimeField(aimField(), library())
    expect(field.samples.map(s => s.clipName)).toEqual(['pose:aim', 'pose:up', 'Walk'])
    expect(field.samples.every(s => !s.pose)).toBe(true)
    // The variant as what it changes from Aim (one bone), naming Aim's key; Aim resolved, whole.
    expect(field.poses!['pose:up']).toEqual(JSON.parse(JSON.stringify({ name: 'Aim Up', bones: [{ name: 'Spine', rotation: axis(X, -30) }], base: 'pose:aim' })))
    expect(field.poses!['pose:aim'].bones.map(b => b.name)).toEqual(['Spine', 'Hips'])
    expect(field.poses!['pose:aim'].base).toBeUndefined()
    const gone = toRuntimeField(aimField(), [])
    expect(gone.samples.map(s => s.clipName)).toEqual(['Walk'])
    expect(gone.poses).toBeUndefined()
    // Without the library, the table embedded before is kept rather than lost.
    const kept = toRuntimeField(aimField(), undefined, field)
    expect(kept.poses).toEqual(field.poses)
  })

  it('places a pose at many points once (a carry over every gait)', () => {
    const asset: AnimationFieldAsset = {
      ...buildAnimationFieldAsset('Carry', 'rig', 'carry'),
      samples: [0, 1, 2, 3].map(x => ({ clipName: poseSampleKey('aim'), x, poseRef: { assetId: 'rifle', poseId: 'aim' } })),
    }
    const field = toRuntimeField(asset, library())
    expect(field.samples.length).toBe(4)
    expect(Object.keys(field.poses!)).toEqual(['pose:aim'])
  })

  it('composes a variant at runtime exactly as the editor resolves it', () => {
    const lib = library()
    const field = toRuntimeField({ ...aimField(), samples: [{ clipName: poseSampleKey('upMore'), x: 0, poseRef: { assetId: 'rifle', poseId: 'upMore' } }] }, lib)
    // upMore is a variant of a variant: in the table, relative to Aim Up resolved (its base, whole).
    const entry = field.poses![poseSampleKey('upMore')]
    const runtime = resolveTablePose(entry as any, field.poses as any)
    const editor = resolvedPoseFor(lib, { assetId: 'rifle', poseId: 'upMore' })!
    for (const b of editor.bones) {
      const r = runtime.bones.find(x => x.name === b.name)!
      if (b.rotation) sameTurn(r, b.rotation)
      if (b.translation) expect(r.translation!.map(v => +v.toFixed(9))).toEqual(b.translation.map(v => +v.toFixed(9)))
    }
    expect(runtime.reference!.length).toBe(editor.reference!.length)
  })

  it('re-embeds every machine playing a blend space of poses when a pose changes', () => {
    const sm: AnimationStateMachine = {
      parameters: [], transitions: [], events: [],
      states: [{ name: 'Aim', clipName: '', loop: true, speed: 0, isEntry: true, fieldId: 'field1' }],
    }
    const fields = [aimField()]
    const first = reembedFields(sm, fields, library())
    expect(first.states[0].field!.poses!['pose:up']).toBeTruthy()
    expect(machineLinks(first, 'rifle')).toBe(true)
    // Edit the base: the variant sample comes out changed, though only the base was touched.
    const edited = library()
    edited[0].poses[0].bones[0].rotation = axis(Y, 35)
    const next = reembedMachine(first, { animationFields: fields, boneMasks: [], poses: edited, controllers: [] })
    expect(next).not.toBeNull()
    // The variant's own entry is unchanged (what it changes from Aim); Aim's, which it is composed onto, moved.
    expect(next!.states[0].field!.poses!['pose:up']).toEqual(first.states[0].field!.poses!['pose:up'])
    expect(next!.states[0].field!.poses!['pose:aim']).not.toEqual(first.states[0].field!.poses!['pose:aim'])
    // The live path does the same without re-instantiating anything, and shares what did not change.
    const live = reembedPoses(first, edited)!
    expect(live.states[0].field!.poses).toEqual(next!.states[0].field!.poses)
    expect(reembedPoses(live, edited)).toBeNull()
    // Nothing changed: nothing to do.
    expect(reembedMachine(next!, { animationFields: fields, boneMasks: [], poses: edited, controllers: [] })).toBeNull()
  })

  it('embeds a pose state’s variant with its reference', () => {
    const sm: AnimationStateMachine = {
      parameters: [], transitions: [], events: [],
      states: [{ name: 'Base', clipName: 'Idle', loop: true, speed: 1, isEntry: true }],
      layers: [{ name: 'Aim', blend: 'additive', transitions: [], states: [{ name: 'Up', clipName: '', loop: true, speed: 1, isEntry: true, poseRef: { assetId: 'rifle', poseId: 'up' } }] }],
    }
    const out = resolveMachineLinks(sm, { animationFields: [], boneMasks: [], poses: library() })
    expect(out.layers![0].states[0].pose!.reference!.length).toBe(2)
  })

  it('records a blend space’s pose samples as edges', () => {
    expect(edgesOfAsset('animationField', aimField()).map(e => `${e.to.kind}:${e.to.id}`)).toEqual(['rig:rig', 'pose:rifle', 'pose:rifle'])
  })
})

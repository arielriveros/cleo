import { describe, it, expect } from 'vitest'
import type { AnimationStateMachine } from 'cleo'
import {
  applyClipOverrides, buildControllerAsset, controllerMachineOf, instantiateController, machineClipNames,
  machineLinks, reembedController, resolveMachineLinks,
} from '../src/utils/animationControllers'
import { branchOf, buildBoneMaskAsset, presetMask, withBranch, type BoneTree } from '../src/utils/boneMasks'
import { buildPoseAsset, newPose, poseAssetFromRig, posesForRig } from '../src/utils/poseAssets'

// Controllers, bone masks and pose assets are EMBEDDED into the machine a node holds, the way fields
// are. These pin the resolve step: what gets embedded, what a node keeps of its own, and what happens
// when a linked asset is gone.

const machine = (): AnimationStateMachine => ({
  parameters: [{ name: 'Speed', type: 'float', default: 0 }],
  states: [{ name: 'Idle', clipName: 'Idle', loop: true, speed: 1, isEntry: true }, { name: 'Walk', clipName: 'Walk', loop: true, speed: 1 }],
  transitions: [],
  events: [],
  layers: [{
    name: 'Upper', maskId: 'mask1', transitions: [],
    states: [
      { name: 'Grip', clipName: '', loop: true, speed: 1, isEntry: true, poseRef: { assetId: 'poses1', poseId: 'grip' } },
      { name: 'Wave', clipName: 'Wave', loop: false, speed: 1 },
    ],
  }],
  slots: [{ name: 'UpperBody', maskId: 'mask1' }],
})

const libs = () => ({
  animationFields: [],
  boneMasks: [buildBoneMaskAsset('Upper', 'rig', { Spine: 1, Head: 1 }, 'mask1')],
  poses: [buildPoseAsset('Hands', 'rig', [{ id: 'grip', name: 'Grip', bones: [{ name: 'RightHand', rotation: [0, 0, 0.38, 0.92] }] }], 'poses1')],
})

describe('controllers', () => {
  it('lists every clip a machine plays, across layers', () => {
    expect(machineClipNames(machine()).sort()).toEqual(['Idle', 'Walk', 'Wave'])
  })

  it('applies clip overrides on every layer', () => {
    const out = applyClipOverrides(machine(), { Walk: 'Crawl', Wave: 'Point' })
    expect(out.states[1].clipName).toBe('Crawl')
    expect(out.layers![0].states[1].clipName).toBe('Point')
  })

  it('embeds masks and poses on Apply', () => {
    const out = resolveMachineLinks(machine(), libs())
    expect(out.layers![0].mask).toEqual({ Spine: 1, Head: 1 })
    expect(out.slots![0].mask).toEqual({ Spine: 1, Head: 1 })
    expect(out.layers![0].states[0].pose).toEqual({ name: 'Grip', bones: [{ name: 'RightHand', rotation: [0, 0, 0.38, 0.92] }] })
  })

  it('switches a layer OFF, not to whole-body, when its mask is gone', () => {
    const out = resolveMachineLinks(machine(), { ...libs(), boneMasks: [] })
    expect(out.layers![0].mask).toEqual({})
  })

  it('stamps the node copy with its controller and keeps the node’s overrides through a re-embed', () => {
    const asset = buildControllerAsset('Zombie', machine(), 'rig', 'ctrl')
    const node = instantiateController(asset, libs(), { Walk: 'Crawl' })
    expect(node.controllerId).toBe('ctrl')
    expect(node.states[1].clipName).toBe('Crawl')

    const edited = { ...asset, machine: { ...asset.machine, parameters: [...asset.machine.parameters, { name: 'Aim', type: 'float' as const, default: 0 }] } }
    const again = reembedController(node, edited, libs())!
    expect(again.parameters.map(p => p.name)).toEqual(['Speed', 'Aim'])
    expect(again.states[1].clipName).toBe('Crawl')
    expect(reembedController({ ...node, controllerId: 'other' }, edited, libs())).toBeNull()
  })

  it('never stores a node’s own fields in the controller', () => {
    const stored = controllerMachineOf({ ...machine(), controllerId: 'x', clipOverrides: { Walk: 'Crawl' } })
    expect(stored.controllerId).toBeUndefined()
    expect(stored.clipOverrides).toBeUndefined()
  })

  it('knows which assets a machine links', () => {
    const m = { ...machine(), controllerId: 'ctrl' }
    expect(machineLinks(m, 'ctrl')).toBe(true)
    expect(machineLinks(m, 'mask1')).toBe(true)
    expect(machineLinks(m, 'poses1')).toBe(true)
    expect(machineLinks(m, 'nothing')).toBe(false)
  })
})

describe('bone masks', () => {
  const tree: BoneTree = [
    { name: 'Hips', parent: null },
    { name: 'Spine', parent: 'Hips' },
    { name: 'Head', parent: 'Spine' },
    { name: 'LeftArm', parent: 'Spine' },
    { name: 'LeftUpLeg', parent: 'Hips' },
    { name: 'RightUpLeg', parent: 'Hips' },
  ]

  it('takes a whole branch', () => {
    expect(branchOf(tree, 'Spine').sort()).toEqual(['Head', 'LeftArm', 'Spine'])
    expect(withBranch({}, tree, 'Spine', 1)).toEqual({ Spine: 1, Head: 1, LeftArm: 1 })
    expect(withBranch({ Spine: 1, Head: 1, LeftArm: 1 }, tree, 'Head', 0)).toEqual({ Spine: 1, LeftArm: 1 })
  })

  it('finds presets by bone name', () => {
    expect(Object.keys(presetMask(tree, 'upperBody')!).sort()).toEqual(['Head', 'LeftArm', 'Spine'])
    expect(Object.keys(presetMask(tree, 'lowerBody')!).sort()).toEqual(['LeftUpLeg', 'RightUpLeg'])
  })
})

describe('pose assets', () => {
  it('resolve alongside a rig’s legacy poses, and migrate out of it keeping ids', () => {
    const rig: any = { id: 'rig', name: 'Hero', skin: { joints: [] }, poses: [{ id: 'old', name: 'Old', bones: [] }] }
    const asset = buildPoseAsset('Hands', 'rig', [newPose('Fist', [{ name: 'RightHand' }])])
    expect(posesForRig(rig, [asset]).map(p => p.name)).toEqual(['Old', 'Fist'])
    const moved = poseAssetFromRig(rig)!
    expect(moved.poses[0].id).toBe('old')
    expect(moved.rigId).toBe('rig')
  })
})

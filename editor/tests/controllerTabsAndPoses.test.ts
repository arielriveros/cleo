import { describe, it, expect } from 'vitest'
import { mat4, quat } from 'gl-matrix'
import { assetIdOfTab, isRestorableTab } from '../src/utils/tabState'
import { poseBoneLocal, poseDeltaOf } from '../src/features/clip/boneTrs'

// A controller opened from the asset browser has no source node — Apply writes the ASSET — so its tab
// restores like any other asset tab. A state machine opened on a NODE still must not: its builder
// captures the active scene as the write-back target, which at boot is the wrong one.
describe('controller tabs', () => {
  it('restores a controller tab and names its controller', () => {
    const tab: any = { id: 't1', kind: 'stateMachine', title: 'Zombie (Controller)', controllerId: 'ctrl-1' }
    expect(isRestorableTab(tab)).toBe(true)
    expect(assetIdOfTab(tab)).toBe('ctrl-1')
  })

  it('never restores a node-based state machine tab, controller or not', () => {
    const node: any = { id: 't2', kind: 'stateMachine', title: 'Ch36 (Anim)', stateMachineSourceId: 'node-9' }
    const nodeOnController: any = { ...node, controllerId: 'ctrl-1' }
    expect(isRestorableTab(node)).toBe(false)
    expect(isRestorableTab(nodeOnController)).toBe(false)
  })
})

// Capturing a pose and previewing it are inverses: what the rig editor captures from a frame must put
// the bone back exactly where it was — including under an FBX-style rest that carries a 0.01 scale.
describe('pose deltas', () => {
  const rest = mat4.fromRotationTranslationScale(mat4.create(),
    quat.fromEuler(quat.create(), 0, 0, 90), [0, 10, 0], [0.01, 0.01, 0.01])
  const local = mat4.fromRotationTranslationScale(mat4.create(),
    quat.fromEuler(quat.create(), 25, 0, 90), [0, 12, 1], [0.01, 0.01, 0.01])

  it('round-trips capture -> preview', () => {
    const delta = poseDeltaOf(local, rest)!
    const back = poseBoneLocal(rest, delta)
    for (let i = 0; i < 16; i++) expect(back[i]).toBeCloseTo(local[i], 5)
  })

  it('stores nothing for a bone at rest', () => {
    expect(poseDeltaOf(rest, rest)).toBeNull()
  })
})

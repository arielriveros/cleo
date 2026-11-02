import { describe, it, expect } from 'vitest'
import { mat4, quat, vec3 } from 'gl-matrix'
import { assetIdOfTab, isRestorableTab } from '../src/utils/tabState'
import { poseBoneLocal } from '../src/features/rig/boneTrs'

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

// Previewing a stored pose: the bone's local is the pose's delta laid on its rest, in the PARENT frame
// (`rotation = delta x rest`, `translation = rest + delta`) — and the rest's scale is kept, which matters
// under an FBX-style rest that carries a 0.01 scale.
describe('pose preview', () => {
  const restRot = quat.fromEuler(quat.create(), 0, 0, 90)
  const rest = mat4.fromRotationTranslationScale(mat4.create(), restRot, [0, 10, 0], [0.01, 0.01, 0.01])
  const delta = quat.fromEuler(quat.create(), 25, 0, 0)

  it('lays the delta on the rest', () => {
    const got = poseBoneLocal(rest, { rotation: [delta[0], delta[1], delta[2], delta[3]], translation: [0, 2, 1] })
    const want = mat4.fromRotationTranslationScale(mat4.create(),
      quat.multiply(quat.create(), delta, restRot), [0, 12, 1], [0.01, 0.01, 0.01])
    for (let i = 0; i < 16; i++) expect(got[i]).toBeCloseTo(want[i], 5)
  })

  it('is the rest itself for an empty delta, scale included', () => {
    const got = poseBoneLocal(rest, {})
    for (let i = 0; i < 16; i++) expect(got[i]).toBeCloseTo(rest[i], 6)
    expect(vec3.length(mat4.getScaling(vec3.create(), got))).toBeCloseTo(Math.sqrt(3) * 0.01, 6)
  })
})

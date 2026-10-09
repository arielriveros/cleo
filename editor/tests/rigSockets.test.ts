import { describe, it, expect } from 'vitest'
import { assetWithSockets, assetSockets } from '../src/utils/modelClips'
import { runtimeSockets, type RigSocket } from '../src/utils/rigAssets'
import { applySockets } from '../src/utils/placedAnimation'

// Sockets are authored on the rig but must travel inside the model's skin: that is what templates,
// bundles and the published game carry, and the runtime never sees a rig.

const socket = (over: Partial<RigSocket> = {}): RigSocket =>
  ({ id: 's1', name: 'RightHandSocket', bone: 'mixamorig:RightHand', offset: { t: [0, 0, 0.1] }, previewModelId: 'm9', ...over })

/** A model asset whose subtree holds two skinned meshes — a body and separately exported armour. */
const asset = () => ({
  nodeJson: {
    children: [
      { model: { skin: { joints: [] } } },
      { children: [{ model: { skin: { joints: [] } } }] },
    ],
  },
})

describe('runtimeSockets', () => {
  it('drops the editor-only fields and anything half-authored', () => {
    expect(runtimeSockets([socket(), socket({ id: 's2', name: '' })]))
      .toEqual([{ name: 'RightHandSocket', bone: 'mixamorig:RightHand', offset: { t: [0, 0, 0.1] } }])
  })
})

describe('assetWithSockets', () => {
  it('writes the sockets into EVERY skinned model of the asset', () => {
    const sockets = runtimeSockets([socket()])
    const next = assetWithSockets(asset(), sockets)
    expect(next.nodeJson.children[0].model.skin.sockets).toEqual(sockets)
    expect(next.nodeJson.children[1].children[0].model.skin.sockets).toEqual(sockets)
    expect(assetSockets(next)).toEqual(sockets)
  })

  it('hands the original back on a no-op, so an unchanged rig rewrites nothing', () => {
    const once = assetWithSockets(asset(), runtimeSockets([socket()]))
    expect(assetWithSockets(once, runtimeSockets([socket()]))).toBe(once)
    const bare = asset()
    expect(assetWithSockets(bare, [])).toBe(bare)
  })

  it('clears them when the rig has none left', () => {
    const once = assetWithSockets(asset(), runtimeSockets([socket()]))
    const cleared = assetWithSockets(once, [])
    expect(cleared.nodeJson.children[0].model.skin.sockets).toBeUndefined()
  })
})

describe('applySockets', () => {
  it('replaces the array so the runtime resolver sees a new identity', () => {
    const skin: any = { sockets: undefined }
    const placed: any = { animator: {}, model: { skin }, children: [] }
    const sockets = runtimeSockets([socket()])
    applySockets(placed, sockets)
    expect(skin.sockets).toEqual(sockets)
    expect(skin.sockets).not.toBe(sockets)
    applySockets(placed, null)
    expect(skin.sockets).toBeUndefined()
  })
})

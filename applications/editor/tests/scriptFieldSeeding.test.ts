import { describe, it, expect } from 'vitest'
import { Node, Scene } from 'cleo'
import { resyncScene } from '../src/utils/sceneResync'
import { hashAsset, assetHashKey, ASSET_HASH_VERSION } from '../src/utils/assetHash'
import { SCRIPT_ID_VAR, type ScriptAsset } from '../src/utils/scripts'

// A saved node carries only the script fields it was given. With up-to-date asset hashes the script
// counts as unchanged on open, and the fields it never set had no native value: the inspector showed a
// message's interactRadius as 0 instead of its default 1.6.

const asset = {
  id: 'script-message', name: 'Message', baseType: 'node', kind: 'class',
  source: 'export default class Message extends Node { public title = "A message"; public interactRadius = 1.6 }',
  variables: [
    { name: 'title', type: 'string', access: 'public', default: 'A message', hidden: false },
    { name: 'interactRadius', type: 'number', access: 'public', default: 1.6, hidden: false },
  ],
} as unknown as ScriptAsset

const libs = { materials: [], models: [], templates: [], terrainMaterials: [], scripts: [asset], tilesets: [], aiBrains: [] } as any
const maps = () => ({ scripts: new Map<string, string>(), bodies: new Map(), triggers: new Map() })

describe('opening a scene whose script did not change', () => {
  it('seeds the fields a node never set, and leaves the ones it did alone', () => {
    const scene = new Scene()
    try {
      const node = new Node('Message: Lock on')
      node.setVariable(SCRIPT_ID_VAR, asset.id, 'string')
      ;(node as any).title = 'Lock on'
      scene.addNode(node)
      const hashes = { [assetHashKey('script', asset.id)]: hashAsset(asset) }
      const m = maps()
      expect(resyncScene(scene, m, libs, hashes, ASSET_HASH_VERSION)).toBe(false)
      expect((node as any).title).toBe('Lock on')
      expect((node as any).interactRadius).toBe(1.6)
      expect(m.scripts.get(node.id)).toBe(asset.source)
    } finally { scene.dispose() }
  })
})

describe('internal script fields', () => {
  const withInternal = {
    ...asset,
    variables: [...asset.variables, { name: '_w', type: 'number', access: 'private', default: 0, hidden: true }],
  } as unknown as ScriptAsset

  it('are neither seeded nor saved: the class initializer owns them', async () => {
    const { seedScriptFields, collectScriptVars } = await import('../src/utils/scripts')
    const node = new Node('HUD') as any
    seedScriptFields(node, withInternal, false)
    expect('_w' in node).toBe(false)
    expect(node.interactRadius).toBe(1.6)
    node._w = 0   // seeded by an older editor
    expect(collectScriptVars(node, withInternal)).toEqual({ title: 'A message', interactRadius: 1.6 })
  })
})

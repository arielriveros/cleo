import { describe, it, expect } from 'vitest'
import { Node, Scene } from 'cleo'
import { detachForeignChildren, reattachForeignChildren } from '../src/utils/foreignChildren'
import { resyncScene } from '../src/utils/sceneResync'
import { instantiateTemplate, type Template } from '../src/utils/templates'
import { MODEL_ID_VAR, type ModelAsset } from '../src/utils/models'
import { assetHashKey, hashAsset, ASSET_HASH_VERSION } from '../src/utils/assetHash'

// A node the user put INSIDE a placed model — the fire sprite on a torch's tip — must survive the model
// copy being rebuilt from its asset. Before, the rebuild knew only the asset and dropped it: a Torch
// template whose sprite sat under its torch model lost the sprite on every placed copy on the next open.

const maps = () => ({ scripts: new Map<string, string>(), bodies: new Map(), triggers: new Map() })

function tree(): Node {
  const root = new Node('Torch')
  const tip = new Node('Tip')
  root.addChild(tip)
  root.addChild(new Node('Handle'))
  return root
}

describe('detach / reattach', () => {
  it('keeps what the asset does not produce, at the same place, as the same node', () => {
    const live = tree()
    const fire = new Node('Fire')
    live.children[0].addChild(fire)               // under Tip
    const sticker = new Node('Sticker')
    live.addChild(sticker)                         // under the root
    const shape = { name: 'Torch', children: [{ name: 'Tip', children: [] }, { name: 'Handle', children: [] }] }

    const foreign = detachForeignChildren(live, shape)
    expect(foreign.map(f => f.node)).toEqual([fire, sticker])
    expect(live.children[0].children).toHaveLength(0)

    const rebuilt = tree()
    reattachForeignChildren(rebuilt, foreign)
    expect(rebuilt.children[0].children[0]).toBe(fire)
    expect(rebuilt.children).toContain(sticker)
  })

  it('tells namesakes apart, and falls back to the deepest surviving parent', () => {
    const live = new Node('Root')
    live.addChild(new Node('Light'))
    live.addChild(new Node('Light'))   // the user's second "Light"
    const shape = { children: [{ name: 'Light', children: [{ name: 'Bulb' }] }] }
    const deep = new Node('Spark')
    live.children[0].addChild(deep)
    const foreign = detachForeignChildren(live, shape)
    expect(foreign.map(f => f.node.name)).toEqual(['Spark', 'Light'])

    const rebuilt = new Node('Root')    // the asset dropped its Light entirely
    reattachForeignChildren(rebuilt, foreign)
    expect(rebuilt.children.map(c => c.name).sort()).toEqual(['Light', 'Spark'])
  })
})

describe('scene resync keeps nodes added inside a placed model', () => {
  it('survives the model being rebuilt on open (the torch sprite bug)', () => {
    const model = {
      id: 'model-torch', name: 'Torch Model',
      nodeJson: { id: 'm-root', name: 'Torch Model', type: 'node', children: [{ id: 'm-tip', name: 'Tip', type: 'node', children: [] }] },
    } as unknown as ModelAsset
    // The template holds the model copy, and the user's fire sprite under its tip.
    const template: Template = {
      id: 'tpl-torch', name: 'Torch',
      nodeJson: {
        id: 't-root', name: 'Torch', type: 'node',
        children: [{
          id: 't-model', name: 'Torch Model', type: 'node',
          variables: { [MODEL_ID_VAR]: { type: 'string', value: model.id } },
          children: [{ id: 't-tip', name: 'Tip', type: 'node', children: [{ id: 't-fire', name: 'Fire', type: 'node', children: [] }] }],
        }],
      },
      scripts: {}, bodies: {}, triggers: {},
    } as any
    const scene = new Scene()
    try {
      const m = maps()
      instantiateTemplate(template, scene.root, m)
      const libs = { materials: [], models: [model], templates: [template], terrainMaterials: [], scripts: [], tilesets: [], aiBrains: [] } as any
      // Saved before the model existed in this scene: the template hash matches, the model has none.
      const saved = { [assetHashKey('template', template.id)]: hashAsset(template) }
      resyncScene(scene, m, libs, saved, ASSET_HASH_VERSION)

      const fires = Array.from(scene.nodes).filter(n => n.name === 'Fire')
      expect(fires).toHaveLength(1)
      expect(fires[0].parent?.name).toBe('Tip')
      expect(fires[0].parent?.parent?.getVariable(MODEL_ID_VAR)).toBe(model.id)
    } finally { scene.dispose() }
  })
})

import { describe, it, expect } from 'vitest'
import { Scene, Node } from 'cleo'
import { resyncScene } from '../src/utils/sceneResync'
import { hashAsset, assetHashKey, ASSET_HASH_VERSION } from '../src/utils/assetHash'
import { TEMPLATE_ID_VAR } from '../src/utils/templates'
import { MODEL_ID_VAR } from '../src/utils/models'
import { MATERIAL_ID_VAR } from '../src/utils/materials'

// A model placed inside a template copy is rebuilt from its asset when the asset changes (the Sandbox's viewmodels
// follow their models: foreignChildren.test.ts), but it wears what its template gave it: a variant's body in its own
// material. Rebuilt from the bare asset it took the asset's: the Sandbox's NPCs came back in the Mannequin's white.
describe('resyncScene and the models inside a template copy', () => {
  const model = {
    id: 'mannequin', name: 'Mannequin', thumbnail: '',
    nodeJson: { id: 'm-root', name: 'Mannequin', type: 'node', variables: { [MATERIAL_ID_VAR]: { type: 'string', value: 'white' } }, children: [] },
  } as any
  const template = {
    id: 'civilian', name: 'Civilian', scripts: {},
    nodeJson: { id: 't-root', name: 'Civilian', type: 'node', children: [{ id: 't-body', name: 'Mannequin', type: 'node', children: [] }] },
  } as any
  const material = (id: string, baseColor: number[]) => ({ id, name: id, material: { type: 'pbr', baseColor }, thumbnail: '' })
  const materials = [material('white', [1, 1, 1]), material('blue', [0.15, 0.35, 1])]
  const libs = { materials, models: [model], templates: [template], terrainMaterials: [], scripts: [], tilesets: [], aiBrains: [] } as any

  function placed() {
    const scene = new Scene()
    const copy = new Node('Civilian 1')
    copy.setVariable(TEMPLATE_ID_VAR, template.id, 'string')
    const body = new Node('Mannequin')
    body.setVariable(MODEL_ID_VAR, model.id, 'string')
    body.setVariable(MATERIAL_ID_VAR, 'blue', 'string')
    copy.addChild(body)
    scene.addNode(copy)
    return { scene, copy, body }
  }

  it('keeps the material a model inside a copy wears when the model asset changed', () => {
    const { scene, copy, body } = placed()
    try {
      // The template as saved, the model changed since.
      const hashes = { [assetHashKey('template', template.id)]: hashAsset(template) }
      expect(resyncScene(scene, { scripts: new Map() }, libs, hashes, ASSET_HASH_VERSION)).toBe(true)
      const rebuilt = copy.children.find(n => n.name === 'Mannequin')!
      expect(rebuilt).not.toBe(body)
      expect(rebuilt.getVariable(MODEL_ID_VAR)).toBe(model.id)
      expect(rebuilt.getVariable(MATERIAL_ID_VAR)).toBe('blue')
    } finally { scene.dispose() }
  })



  it('still rebuilds a model placed on its own', () => {
    const scene = new Scene()
    const loose = new Node('Mannequin')
    loose.setVariable(MODEL_ID_VAR, model.id, 'string')
    loose.setVariable(MATERIAL_ID_VAR, 'blue', 'string')
    scene.addNode(loose)
    try {
      resyncScene(scene, { scripts: new Map() }, libs, {}, ASSET_HASH_VERSION)
      const rebuilt = scene.root.children.find(n => n.name === 'Mannequin')!
      expect(rebuilt).not.toBe(loose)
      expect(rebuilt.getVariable(MODEL_ID_VAR)).toBe(model.id)
    } finally { scene.dispose() }
  })
})

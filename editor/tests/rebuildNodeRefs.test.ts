import { describe, it, expect } from 'vitest'
import { CameraRigNode, Node, Scene } from 'cleo'
import { resyncScene, retargetNodeRefs } from '../src/utils/sceneResync'
import { instantiateTemplate, type Template } from '../src/utils/templates'
import { MODEL_ID_VAR, type ModelAsset } from '../src/utils/models'
import { assetHashKey, hashAsset, ASSET_HASH_VERSION } from '../src/utils/assetHash'

// A placed model rebuilt from its asset gets fresh ids. A reference to it from OUTSIDE the rebuilt
// subtree — the Valley Player's camera rig following the character model nested beside it — used to keep
// the old id: the rig logged "follows a node that no longer exists" on every open and stopped following.

const maps = () => ({ scripts: new Map<string, string>(), bodies: new Map(), triggers: new Map() })

describe('retargetNodeRefs', () => {
  it('rewrites live reference fields through the id map, and leaves the rest alone', () => {
    const scene = new Scene()
    try {
      const rig = new CameraRigNode('rig')
      rig.followId = 'old-model'
      rig.lookAtId = 'someone-else'
      scene.addNode(rig)
      retargetNodeRefs(scene, new Map([['old-model', 'new-model']]))
      expect(rig.followId).toBe('new-model')
      expect(rig.lookAtId).toBe('someone-else')
    } finally { scene.dispose() }
  })
})

describe('a model rebuilt on open keeps what follows it', () => {
  it('re-points a camera rig at the rebuilt model (the Valley camera bug)', () => {
    const model = {
      id: 'model-hero', name: 'Hero',
      nodeJson: { id: 'm-root', name: 'Hero', type: 'node', children: [{ id: 'm-hips', name: 'Hips', type: 'node', children: [] }] },
    } as unknown as ModelAsset
    const template: Template = {
      id: 'tpl-player', name: 'Player',
      nodeJson: {
        id: 'p-root', name: 'Player', type: 'node',
        children: [
          { id: 'p-rig', name: 'camera rig', type: 'cameraRig', followId: 'p-model', children: [] },
          {
            id: 'p-model', name: 'Hero', type: 'node',
            variables: { [MODEL_ID_VAR]: { type: 'string', value: model.id } },
            children: [{ id: 'p-hips', name: 'Hips', type: 'node', children: [] }],
          },
        ],
      },
      scripts: {}, bodies: {}, triggers: {},
    } as any
    const scene = new Scene()
    try {
      const m = maps()
      instantiateTemplate(template, scene.root, m)
      const libs = { materials: [], models: [model], templates: [template], terrainMaterials: [], scripts: [], tilesets: [], aiBrains: [] } as any
      // Saved before the model hash existed: the template matches, the model reads as changed and rebuilds.
      const saved = { [assetHashKey('template', template.id)]: hashAsset(template) }
      resyncScene(scene, m, libs, saved, ASSET_HASH_VERSION)

      const rig = Array.from(scene.nodes).find(n => n instanceof CameraRigNode) as CameraRigNode
      const hero = Array.from(scene.nodes).find(n => n.name === 'Hero' && n.getVariable(MODEL_ID_VAR)) as Node
      expect(rig).toBeDefined()
      expect(hero).toBeDefined()
      expect(rig.followId).toBe(hero.id)
      expect(scene.getNodeById(rig.followId!)).toBe(hero)
    } finally { scene.dispose() }
  })
})

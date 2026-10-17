import { describe, it, expect, vi } from 'vitest'
import { Node, ModelNode, Model, Geometry, Material } from 'cleo'

// Generated LOD levels are EMBEDDED in their source model: the level is the source subtree with its
// geometry swapped, so the root transform and the hierarchy survive; its materials are inline (no library
// link to be "resolved" back to full size); and from level 2 on only colour, normal and mask textures stay.

vi.mock('../src/utils/textureReady', () => ({ awaitTextureImage: async () => null }))
vi.mock('../src/utils/textureStore', () => ({ persistTextures: async () => 0 }))

const { generateLodLevel } = await import('../src/utils/lodGenerate')
const { levelTextureIds, levelMaterialJson, isLodTextureId } = await import('../src/utils/lodTextures')
const { modelLodLevelCount, generatedLodCount } = await import('../src/utils/models')
const { MATERIAL_ID_VAR } = await import('../src/utils/materials')

const quad = () => new Geometry(
  [[-1, 0, 0], [1, 0, 0], [1, 2, 0], [-1, 2, 0]],
  [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]],
  [[0, 0], [1, 0], [1, 1], [0, 1]],
  [], [], [0, 1, 2, 0, 2, 3],
)
const pbr = () => {
  const m = Material.PBR({ baseColor: [1, 1, 1], roughness: 0.5, metallic: 0 })
  m.textures.set('baseColorTexture', 'bark')
  m.textures.set('normalMap', 'bark_n')
  m.textures.set('roughnessMap', 'bark_r')
  m.textures.set('occlusionMap', 'bark_ao')
  m.textures.set('maskMap', 'bark_mask')
  return m
}
// The decimator itself is tested elsewhere; here it hands the buffers straight back.
const identity = async (b: any) => b

function model(): Node {
  const root = new Node('tree')
  root.setPosition([0, 5, 0])
  root.setRotation([0, 45, 0])
  root.setScale([2, 2, 2])
  const group = new Node('branches')
  group.setPosition([1, 0, 0])
  root.addChild(group)
  // A Model built without its constructor, which would allocate a GPU mesh (there is no device here).
  const m = Object.create(Model.prototype)
  Object.assign(m, { _geometry: quad(), _materials: [pbr()], _submeshes: [], _geometryVersion: 0 })
  const part = new ModelNode('leaf', m)
  part.setPosition([0, 1, 0])
  part.setVariable(MATERIAL_ID_VAR, 'lib-bark')
  group.addChild(part)
  return root
}

describe('generateLodLevel', () => {
  it('keeps the root transform and every intermediate transform', async () => {
    const root = model()
    const { nodeJson } = await generateLodLevel(root, 1, { ratio: 0.5, distance: 20 },
      { downscaleTextures: false, decimate: identity })
    const before = await root.serialize()
    expect(nodeJson.position).toEqual(before.position)
    expect(nodeJson.rotation).toEqual(before.rotation)
    expect(nodeJson.scale).toEqual(before.scale)
    expect(nodeJson.children[0].name).toBe('branches')
    expect(nodeJson.children[0].position).toEqual(before.children[0].position)
    expect(nodeJson.children[0].children[0].position).toEqual(before.children[0].children[0].position)
  })

  it('carries no material-asset link, so instantiation cannot swap the full-size material back', async () => {
    const { nodeJson } = await generateLodLevel(model(), 1, { ratio: 0.5, distance: 20 },
      { downscaleTextures: false, decimate: identity })
    const leaf = nodeJson.children[0].children[0]
    expect(leaf.variables?.[MATERIAL_ID_VAR]).toBeUndefined()
  })

  it('keeps only colour, normal and mask from level 2 on', async () => {
    const { nodeJson } = await generateLodLevel(model(), 2, { ratio: 0.25, distance: 40 },
      { downscaleTextures: false, decimate: identity })
    const leaf = nodeJson.children[0].children[0]
    const textures = (leaf.model.materials?.[0] ?? leaf.model.material).textures
    expect(Object.entries(textures).filter(([, v]) => v).map(([k]) => k).sort())
      .toEqual(['baseColorTexture', 'mask', 'normalMap'])
  })
})

describe('level texture slots', () => {
  const serialized = pbr().serialize()
  it('level 1 keeps every texture', () => {
    expect(levelTextureIds(serialized, 1).sort()).toEqual(['bark', 'bark_ao', 'bark_mask', 'bark_n', 'bark_r'])
  })
  it('level 2 keeps colour, normal and mask, repointed at their twins', () => {
    expect(levelTextureIds(serialized, 2).sort()).toEqual(['bark', 'bark_mask', 'bark_n'])
    const out = levelMaterialJson(serialized, new Map([['bark', 'bark__lod256']]), 2)
    expect(out.textures.baseColorTexture).toBe('bark__lod256')
    expect(out.textures.roughnessMap).toBeUndefined()
    expect(serialized.textures.roughnessMap).toBe('bark_r') // the source is untouched
  })
  it('recognises a twin id', () => {
    expect(isLodTextureId('bark__lod256')).toBe(true)
    expect(isLodTextureId('bark')).toBe(false)
  })
})

describe('what deleting a model takes with it', () => {
  const models: any[] = [
    { id: 'tree', lods: [{ distance: 20, generated: true, nodeJson: {} }, { distance: 40, modelId: 'bush' }] },
    { id: 'old-lod', lodSource: { modelId: 'tree', level: 3 } },
    { id: 'bush' },
  ]
  it('counts embedded levels and old-scheme level assets, never hand-picked models', () => {
    expect(generatedLodCount(models[0])).toBe(1)
    expect(modelLodLevelCount('tree', models)).toBe(2)
    expect(modelLodLevelCount('bush', models)).toBe(0)
  })
})

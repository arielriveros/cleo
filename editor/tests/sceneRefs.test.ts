import { describe, it, expect } from 'vitest'
import {
  buildSceneRefs, collectSceneMaterialIds, collectSceneFoliageModelIds, collectReferencedMaterialIds,
  SCENE_REFS_VERSION,
} from '../src/utils/references'
import { edgesOfScene, sceneRefsComplete } from '../src/utils/assetEdges'

// A scene's reference list must be what the scene ITSELF names. It used to be a whole-library closure, so
// every scene edged directly to nearly every asset in the project and the reference graph read as a flat
// star rather than scene -> model -> material -> texture.
//
// Scenes are built as structural stubs, never a real `Scene`: the node-env suite has no GL context.

const node = (over: any = {}) => ({
  nodeType: 'model',
  getVariable: (k: string) => over.vars?.[k],
  ...over,
})

/** A stub with only what the collectors touch. */
const scene = (over: any = {}) => ({
  nodes: [], landscapes: [], tilemaps: [], sprites: [], sounds: [], uiNodes: [], controllers: [],
  ...over,
}) as any

const ids = (edges: { to: { kind: string; id: string } }[]) =>
  [...new Set(edges.map(e => `${e.to.kind}:${e.to.id}`))].sort()

describe('collectSceneMaterialIds', () => {
  it('reports only what placed nodes name', () => {
    const s = scene({ nodes: [node({ vars: { __materialId: 'stone' } })] })
    expect([...collectSceneMaterialIds(s)]).toEqual(['stone'])
  })

  it('reports nothing for an empty scene', () => {
    expect([...collectSceneMaterialIds(scene())]).toEqual([])
  })
})

// The regression that made the graph flat, and the guarantee that fixing it did not break hashing.
describe('the wide vs direct split', () => {
  const models = [
    { id: 'unplaced1', materialIds: ['libMat1'] },
    { id: 'unplaced2', materialIds: ['libMat2'] },
  ] as any[]
  const s = scene({ nodes: [node({ vars: { __materialId: 'placedMat' } })] })

  it('a scene naming one material does not claim the whole model library', () => {
    expect([...collectSceneMaterialIds(s)]).toEqual(['placedMat'])
  })

  // Load-bearing: `buildAssetHashes` is still fed the WIDE set, because a closed scene must be able to
  // tell that a material changed while it was closed, and it reaches that material through a model.
  it('the wide collector still folds in every library model, unchanged', () => {
    expect([...collectReferencedMaterialIds(s, models)].sort())
      .toEqual(['libMat1', 'libMat2', 'placedMat'])
  })

  it('buildSceneRefs uses the direct one', () => {
    expect(buildSceneRefs(s).materialIds).toEqual(['placedMat'])
  })
})

describe('collectSceneFoliageModelIds', () => {
  const withFoliage = (rules: any[]) => scene({
    landscapes: [{ terrain: { layers: [{ material: { foliageInclude: rules } }], foliage: [] } }],
  })

  // Nothing collected this before, so a model used only as scatter looked unreferenced.
  it('finds a model scattered by a terrain layer', () => {
    expect([...collectSceneFoliageModelIds(withFoliage([{ modelId: 'fern' }]))]).toEqual(['fern'])
  })

  it('reads the pre-rename meshId spelling', () => {
    expect([...collectSceneFoliageModelIds(withFoliage([{ meshId: 'oldTree' }]))]).toEqual(['oldTree'])
  })

  it('finds terrain-level foliage layers too', () => {
    const s = scene({ landscapes: [{ terrain: { layers: [], foliage: [{ modelId: 'grass' }] } }] })
    expect([...collectSceneFoliageModelIds(s)]).toEqual(['grass'])
  })

  it('is empty for a scene with no landscape', () => {
    expect([...collectSceneFoliageModelIds(scene())]).toEqual([])
  })
})

describe('buildSceneRefs', () => {
  it('stamps the current version', () => {
    expect(buildSceneRefs(scene()).version).toBe(SCENE_REFS_VERSION)
  })

  // The LUT and lens-dirt mask live in RenderSettings, where no node walk reaches them; they were never
  // recorded at save time before, so a scene's grading LUT looked orphaned once the scene closed.
  it('records the render settings textures', () => {
    const refs = buildSceneRefs(scene(), { colorGradingLut: 'lut', lensDirtTexture: 'dirt' })
    expect(refs.textureIds.sort()).toEqual(['dirt', 'lut'])
  })

  it('keeps foliage models apart from placed models', () => {
    const s = scene({
      nodes: [node({ vars: { __modelId: 'placed' } })],
      landscapes: [{ terrain: { layers: [{ material: { foliageInclude: [{ modelId: 'fern' }] } }], foliage: [] } }],
    })
    const refs = buildSceneRefs(s)
    expect(refs.modelIds).toEqual(['placed'])
    expect(refs.foliageModelIds).toEqual(['fern'])
  })

  // One hop, deliberately: a scene places a MODEL and the model lists its clips.
  it('reaches animations through the models the scene places', () => {
    const s = scene({ nodes: [node({ vars: { __modelId: 'hero' } })] })
    const models = [
      { id: 'hero', animationIds: ['idle'] },
      { id: 'unplaced', animationIds: ['never'] },
    ]
    expect(buildSceneRefs(s, null, [], models).animationIds).toEqual(['idle'])
  })

  it('is empty, not undefined, for an empty scene', () => {
    const refs = buildSceneRefs(scene())
    expect(refs.materialIds).toEqual([])
    expect(refs.textureIds).toEqual([])
    expect(refs.foliageModelIds).toEqual([])
  })
})

describe('edgesOfScene labels', () => {
  it('names the link field, not the storage array', () => {
    const refs: any = {
      version: 1,
      materialIds: ['stone'], modelIds: ['boulder'], templateIds: ['crate'],
      terrainMaterialIds: ['grass'], tilesetIds: ['dungeon'], aiBrainIds: ['guard'],
      scriptIds: ['patrol'], animationFieldIds: ['locomotion'], soundSampleIds: ['hit'],
      textureIds: [], animationIds: [], audioSourceIds: [], foliageModelIds: ['fern'],
    }
    const byTarget = Object.fromEntries(edgesOfScene(refs).map(e => [`${e.to.kind}:${e.to.id}`, e.field]))
    expect(byTarget['material:stone']).toBe('__materialId')
    expect(byTarget['model:boulder']).toBe('__modelId')
    expect(byTarget['template:crate']).toBe('__templateId')
    expect(byTarget['script:patrol']).toBe('__scriptId')
    expect(byTarget['terrainMaterial:grass']).toBe('layer.materialId')
    expect(byTarget['tileset:dungeon']).toBe('tilesetId')
    expect(byTarget['aiBrain:guard']).toBe('brainId')
    expect(byTarget['animationField:locomotion']).toBe('state.fieldId')
    expect(byTarget['model:fern']).toBe('foliageInclude[].modelId')
  })

  // No label anywhere may still say `refs.*` — that was the storage field name leaking into the viewer.
  it('never labels an edge with a storage array name', () => {
    const refs: any = { version: 1, materialIds: ['a'], modelIds: ['b'], textureIds: ['c'] }
    for (const e of edgesOfScene(refs)) expect(e.field.startsWith('refs.')).toBe(false)
  })

  // A scene saved by an older build still shows its references — it is just marked partial.
  it('still reads a legacy refs blob', () => {
    const legacy: any = { materialIds: ['stone'], modelIds: ['boulder'], meshIds: ['old'] }
    expect(ids(edgesOfScene(legacy))).toEqual(['material:stone', 'model:boulder', 'model:old'])
  })
})

describe('sceneRefsComplete', () => {
  it('is false for a scene saved before versioning', () => {
    expect(sceneRefsComplete({ materialIds: [], modelIds: [] } as any)).toBe(false)
    expect(sceneRefsComplete(undefined)).toBe(false)
  })

  it('is true for refs the current builder produced', () => {
    expect(sceneRefsComplete(buildSceneRefs(scene()) as any)).toBe(true)
  })
})

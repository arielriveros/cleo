import { describe, it, expect } from 'vitest'
import { edgesOfAsset, edgesOfScene, sceneRefsComplete, walkRefs } from '../src/utils/assetEdges'
import type { EdgeSpec } from '../src/utils/assetEdges'
import type { SceneRefs } from '../src/utils/sceneStorage'

// One fixture per kind, asserting the documented edge table. Pure data, no GL.

/** Edges as `kind:id@field`, sorted — order is not part of the contract, content is. */
const shape = (edges: EdgeSpec[]): string[] =>
  edges.map(e => `${e.to.kind}:${e.to.id}@${e.field}`).sort()

const targets = (edges: EdgeSpec[]): string[] =>
  [...new Set(edges.map(e => `${e.to.kind}:${e.to.id}`))].sort()

/** A serialized node variable, as `Node.serialize` writes it. */
const v = (value: any, type = 'string') => ({ value, type })

describe('edgesOfAsset', () => {
  describe('leaves', () => {
    it.each(['image', 'audioSource', 'animation', 'aiBrain', 'script'] as const)(
      'a %s references nothing', kind => {
        expect(edgesOfAsset(kind, { id: 'x', name: 'x', clips: [], machine: {} })).toEqual([])
      })

    it('returns nothing for a missing asset', () => {
      expect(edgesOfAsset('material', null)).toEqual([])
    })
  })

  describe('texture', () => {
    it('points at the image it samples', () => {
      const asset = { id: 'rock', name: 'rock', source: { kind: 'image', imageId: 'rock.png' } }
      expect(shape(edgesOfAsset('texture', asset))).toEqual(['image:rock.png@source.imageId'])
    })

    it('points at the baked image and every packed channel source', () => {
      const asset = {
        id: 'packed', name: 'packed',
        source: {
          kind: 'pack',
          bakedImageId: 'baked.png',
          spec: { r: { textureId: 'ao' }, g: { textureId: 'rough' }, b: null, a: undefined },
        },
      }
      expect(shape(edgesOfAsset('texture', asset))).toEqual([
        'image:baked.png@source.bakedImageId',
        'texture:ao@source.spec.r.textureId',
        'texture:rough@source.spec.g.textureId',
      ])
    })

    // textureIds[0] IS the asset's own id; a generic walk would read it as a self-reference.
    it('ignores the textureIds / imageIds mirrors', () => {
      const asset = {
        id: 'rock', name: 'rock',
        source: { kind: 'image', imageId: 'rock.png' },
        textureIds: ['rock'], imageIds: ['rock.png'],
      }
      expect(edgesOfAsset('texture', asset)).toHaveLength(1)
    })

    it('has no source edges when the texture is runtime-generated', () => {
      expect(edgesOfAsset('texture', { id: 't', name: 't', source: { kind: 'runtime' } })).toEqual([])
    })
  })

  describe('soundSample', () => {
    it('points at its audio file', () => {
      const asset = {
        id: 's', name: 's',
        source: { kind: 'audio', audioId: 'hit.wav' },
        soundIds: ['s'], audioIds: ['hit.wav'],
      }
      expect(shape(edgesOfAsset('soundSample', asset))).toEqual(['audioSource:hit.wav@source.audioId'])
    })
  })

  describe('material', () => {
    it('names the slot each texture is read through', () => {
      const asset = {
        id: 'm', name: 'm',
        material: { type: 'pbr', textures: { baseTexture: 'rock', normalMap: 'rockN' } },
      }
      expect(shape(edgesOfAsset('material', asset))).toEqual([
        'texture:rock@textures.baseTexture',
        'texture:rockN@textures.normalMap',
      ])
    })

    // One picture in two slots is two references, and the viewer must be able to say which.
    it('keeps one edge per slot when a texture fills two', () => {
      const asset = { id: 'm', name: 'm', material: { textures: { baseTexture: 'rock', emissiveMap: 'rock' } } }
      expect(shape(edgesOfAsset('material', asset))).toEqual([
        'texture:rock@textures.baseTexture',
        'texture:rock@textures.emissiveMap',
      ])
    })

    it('excludes engine-derived channel packs', () => {
      const asset = {
        id: 'm', name: 'm',
        material: { textures: { baseTexture: 'rock', ormMap: '__packed__abc123' } },
      }
      expect(targets(edgesOfAsset('material', asset))).toEqual(['texture:rock'])
    })

    it('reads a legacy asset that embedded its textures', () => {
      const asset = { id: 'm', name: 'm', material: {}, textures: [{ id: 'rock', data: 'x' }] }
      expect(shape(edgesOfAsset('material', asset))).toEqual(['texture:rock@textures[].id'])
    })
  })

  describe('terrainMaterial', () => {
    it('reaches the base surface, the displacement map and the foliage rules', () => {
      const asset = {
        id: 'tm', name: 'tm',
        material: {
          textures: { baseTexture: 'grass' },
          displacementMap: 'grassH',
          foliageInclude: [
            { modelId: 'fern', textureId: 'fernBillboard' },
            { meshId: 'oldTree' },
          ],
        },
      }
      expect(shape(edgesOfAsset('terrainMaterial', asset))).toEqual([
        'model:fern@modelId',
        'model:oldTree@meshId',
        'texture:fernBillboard@textureId',
        'texture:grass@textures.baseTexture',
        'texture:grassH@displacementMap',
      ])
    })
  })

  describe('model', () => {
    it('lists its materials, its clips and its LOD models', () => {
      const asset = {
        id: 'boulder', name: 'boulder',
        materialIds: ['stone', 'moss'],
        animationIds: ['idle', 'crumble'],
        lods: [{ distance: 20, modelId: 'boulder_lod1' }, { distance: 60, modelId: 'boulder_lod2' }],
        nodeJson: {},
      }
      expect(shape(edgesOfAsset('model', asset))).toEqual([
        'animation:crumble@animationIds[1]',
        'animation:idle@animationIds[0]',
        'material:moss@materialIds[1]',
        'material:stone@materialIds[0]',
        'model:boulder_lod1@modelId',
        'model:boulder_lod2@modelId',
      ])
    })

    // Provenance, not a reference: models.ts calls this out explicitly.
    it('does not treat lodSource as a reference', () => {
      const asset = { id: 'lod1', name: 'lod1', lodSource: { modelId: 'boulder', level: 1 }, nodeJson: {} }
      expect(edgesOfAsset('model', asset)).toEqual([])
    })

    it('finds materials and textures embedded in the subtree', () => {
      const asset = {
        id: 'm', name: 'm',
        nodeJson: {
          name: 'root',
          children: [{
            name: 'mesh',
            variables: { __materialId: v('stone') },
            model: { material: { textures: { baseTexture: 'rock' } } },
          }],
        },
      }
      expect(shape(edgesOfAsset('model', asset))).toEqual([
        'material:stone@__materialId',
        'texture:rock@textures.baseTexture',
      ])
    })

    // Descending into a vertex buffer is millions of wasted calls on every library change.
    it('does not descend into a binary payload', () => {
      const asset = {
        id: 'm', name: 'm',
        nodeJson: { model: { geometry: { positions: new Float32Array(2048) } } },
      }
      expect(edgesOfAsset('model', asset)).toEqual([])
    })
  })

  describe('template', () => {
    it('reads every asset-link node variable, including the JSON-string lists', () => {
      const asset = {
        id: 't', name: 't',
        nodeJson: {
          variables: {
            __materialId: v('stone'),
            __modelId: v('boulder'),
            __scriptId: v('patrol'),
            __templateId: v('crate'),
            // No array type in the variable system: both lists are JSON strings.
            __materialIds: v(JSON.stringify(['stone', 'moss'])),
            __screenMaterialIds: v(JSON.stringify(['blurPass'])),
          },
        },
      }
      expect(shape(edgesOfAsset('template', asset))).toEqual([
        'material:blurPass@__screenMaterialIds[0]',
        'material:moss@__materialIds[1]',
        'material:stone@__materialId',
        'material:stone@__materialIds[0]',
        'model:boulder@__modelId',
        'script:patrol@__scriptId',
        'template:crate@__templateId',
      ])
    })

    it('reads the pre-rename __meshId spelling', () => {
      const asset = { id: 't', name: 't', nodeJson: { variables: { __meshId: v('boulder') } } }
      expect(shape(edgesOfAsset('template', asset))).toEqual(['model:boulder@__meshId'])
    })

    it('survives a corrupt JSON id list rather than inventing a reference', () => {
      const asset = { id: 't', name: 't', nodeJson: { variables: { __materialIds: v('{not json') } } }
      expect(edgesOfAsset('template', asset)).toEqual([])
    })

    it('reads an older project whose list was a real array', () => {
      const asset = { id: 't', name: 't', nodeJson: { variables: { __materialIds: v(['stone', 'moss']) } } }
      expect(targets(edgesOfAsset('template', asset))).toEqual(['material:moss', 'material:stone'])
    })

    it('finds sounds, tilemap tilesets and a sprite tileset', () => {
      const asset = {
        id: 't', name: 't',
        nodeJson: {
          children: [
            { sound: { sampleId: 'hit' } },
            { tilemap: { tilesets: [{ id: 'dungeon', textureId: 'atlas' }] } },
            { sprite: { tileset: { id: 'hero', textureId: 'heroAtlas' } } },
          ],
        },
      }
      expect(shape(edgesOfAsset('template', asset))).toEqual([
        'soundSample:hit@sampleId',
        'texture:atlas@textureId',
        'texture:heroAtlas@textureId',
        'tileset:dungeon@tilesets[].id',
        'tileset:hero@tileset.id',
      ])
    })

    // An inline tileset has no library asset behind it and must not be reported as a broken reference.
    it('excludes an inline sprite tileset', () => {
      const asset = {
        id: 't', name: 't',
        nodeJson: { sprite: { tileset: { id: '@sprite-inline', textureId: 'a' } } },
      }
      expect(targets(edgesOfAsset('template', asset))).toEqual(['texture:a'])
    })

    it('reads a terrain layer materialId as a TERRAIN material', () => {
      const asset = { id: 't', name: 't', nodeJson: { terrain: { layers: [{ materialId: 'grass' }] } } }
      expect(shape(edgesOfAsset('template', asset))).toEqual(['terrainMaterial:grass@materialId'])
    })

    it('reads a controller brainId and an animation state fieldId', () => {
      const asset = {
        id: 't', name: 't',
        nodeJson: {
          children: [
            { controller: { brainId: 'guard' } },
            { animator: { stateMachine: { states: [{ fieldId: 'locomotion' }] } } },
          ],
        },
      }
      expect(shape(edgesOfAsset('template', asset))).toEqual([
        'aiBrain:guard@brainId',
        'animationField:locomotion@fieldId',
      ])
    })
  })

  describe('tileset', () => {
    it('points at its atlas once, not twice through the mirror', () => {
      const asset = { id: 'ts', name: 'ts', textureId: 'atlas', textureIds: ['atlas'] }
      expect(shape(edgesOfAsset('tileset', asset))).toEqual(['texture:atlas@textureId'])
    })
  })

  describe('animationField', () => {
    it('points at the rig it blends', () => {
      expect(shape(edgesOfAsset('animationField', { id: 'f', name: 'f', modelId: 'hero' })))
        .toEqual(['model:hero@modelId'])
    })
  })

  describe('scene', () => {
    it('reads the refs snapshot rather than the stored blob', () => {
      const asset = { id: 's', name: 's', refs: { materialIds: ['stone'], modelIds: ['boulder'] } }
      expect(shape(edgesOfAsset('scene', asset))).toEqual([
        'material:stone@refs.materialIds',
        'model:boulder@refs.modelIds',
      ])
    })

    it('has no edges when the scene was never saved', () => {
      expect(edgesOfAsset('scene', { id: 's', name: 's' })).toEqual([])
    })
  })
})

describe('edgesOfScene', () => {
  const full: SceneRefs = {
    materialIds: ['stone'],
    modelIds: ['boulder'],
    meshIds: ['legacyRock'],
    templateIds: ['crate'],
    terrainMaterialIds: ['grass'],
    tilesetIds: ['dungeon'],
    aiBrainIds: ['guard'],
    textureIds: ['rock'],
    scriptIds: ['patrol'],
    animationFieldIds: ['locomotion'],
    animationIds: ['idle'],
    soundSampleIds: ['hit'],
    audioSourceIds: ['hit.wav'],
  }

  it('emits one edge per referenced asset, across every kind', () => {
    expect(targets(edgesOfScene(full))).toEqual([
      'aiBrain:guard', 'animation:idle', 'animationField:locomotion', 'audioSource:hit.wav',
      'material:stone', 'model:boulder', 'model:legacyRock', 'script:patrol',
      'soundSample:hit', 'template:crate', 'terrainMaterial:grass', 'texture:rock', 'tileset:dungeon',
    ])
  })

  it('reads the pre-rename meshIds as models', () => {
    expect(shape(edgesOfScene({ ...full, modelIds: [], meshIds: ['old'] })))
      .toContain('model:old@refs.meshIds')
  })

  it('handles a scene saved before the new fields existed', () => {
    const old: SceneRefs = {
      materialIds: ['stone'], modelIds: [], templateIds: [], terrainMaterialIds: [],
      tilesetIds: [], aiBrainIds: [], textureIds: [],
    }
    expect(targets(edgesOfScene(old))).toEqual(['material:stone'])
  })

  it('returns nothing for a scene with no refs at all', () => {
    expect(edgesOfScene(undefined)).toEqual([])
  })
})

describe('sceneRefsComplete', () => {
  const legacy: SceneRefs = {
    materialIds: [], modelIds: [], templateIds: [], terrainMaterialIds: [],
    tilesetIds: [], aiBrainIds: [], textureIds: [],
  }

  it('is false for refs written before the graph existed', () => {
    expect(sceneRefsComplete(legacy)).toBe(false)
  })

  // Empty arrays are a real answer; absent fields are not.
  it('is true once every field is present, even when empty', () => {
    expect(sceneRefsComplete({
      ...legacy,
      scriptIds: [], animationFieldIds: [], animationIds: [], soundSampleIds: [], audioSourceIds: [],
    })).toBe(true)
  })

  it('is false for no refs at all', () => {
    expect(sceneRefsComplete(undefined)).toBe(false)
  })
})

describe('walkRefs', () => {
  it('is safe on primitives and empty structures', () => {
    const out: EdgeSpec[] = []
    walkRefs(null, out); walkRefs(42, out); walkRefs('x', out); walkRefs([], out)
    expect(out).toEqual([])
  })

  it('walks arrays of nodes', () => {
    const out: EdgeSpec[] = []
    walkRefs([{ textureId: 'a' }, { textureId: 'b' }], out)
    expect(targets(out)).toEqual(['texture:a', 'texture:b'])
  })
})

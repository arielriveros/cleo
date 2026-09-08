import { describe, it, expect, beforeEach } from 'vitest'
import { AssetGraph, assetKey } from 'cleo'
import { edgesOfAsset } from '../src/utils/assetEdges'
import { structurallyChanged } from '../src/utils/assetHash'
import type { AssetKind } from '../src/utils/vfs'

// The extractors and the graph working together: a change to one asset reaching everything that depends
// on it, through the real edge table rather than a hand-built one. This is the behaviour the feature
// exists for, so it is asserted end to end (minus React, which the node suite deliberately excludes).

const K = assetKey

/** The fixture project: a scene placing a model, wearing a material, sampling a texture from an image. */
function project() {
  return {
    image: { id: 'rock.png', name: 'rock' },
    texture: { id: 'rockTex', name: 'rock', source: { kind: 'image', imageId: 'rock.png' } },
    material: { id: 'stone', name: 'stone', material: { textures: { baseTexture: 'rockTex' } }, thumbnail: '' },
    model: { id: 'boulder', name: 'boulder', materialIds: ['stone'], nodeJson: {}, thumbnail: '' },
    scene: { id: 'level1', name: 'Level 1', refs: { materialIds: ['stone'], modelIds: ['boulder'] } },
  }
}

/** Index a whole project into a fresh graph, as AssetGraphProvider's build pass does. */
function build(g: AssetGraph, p: Record<string, any>, kinds: Record<string, AssetKind>) {
  for (const [slot, asset] of Object.entries(p))
    g.setEdges({ kind: kinds[slot], id: asset.id }, edgesOfAsset(kinds[slot], asset))
}

const KINDS: Record<string, AssetKind> = {
  image: 'image', texture: 'texture', material: 'material', model: 'model', scene: 'scene',
}

describe('asset graph propagation', () => {
  let g: AssetGraph
  let p: ReturnType<typeof project>

  beforeEach(() => {
    g = new AssetGraph()
    p = project()
    build(g, p, KINDS)
  })

  it('wires the whole chain from the real extractors', () => {
    expect(g.outgoing(K('texture', 'rockTex')).map(e => e.to)).toEqual([K('image', 'rock.png')])
    expect(g.outgoing(K('material', 'stone')).map(e => e.to)).toEqual([K('texture', 'rockTex')])
    expect(g.outgoing(K('model', 'boulder')).map(e => e.to)).toEqual([K('material', 'stone')])
    expect(g.outgoing(K('scene', 'level1')).map(e => e.to).sort())
      .toEqual([K('material', 'stone'), K('model', 'boulder')].sort())
  })

  // The example from the brief: change the texture, and the material and model follow.
  it('cascades an image change up to the scene in one touch', () => {
    const affected = g.touch({ kind: 'image', id: 'rock.png' })
    expect(affected.map(r => `${r.kind}:${r.id}`).sort()).toEqual([
      'image:rock.png', 'material:stone', 'model:boulder', 'scene:level1', 'texture:rockTex',
    ])
  })

  it('moves every dependent revision, and only dependents', () => {
    g.setEdges({ kind: 'material', id: 'unrelated' }, [])
    g.touch({ kind: 'texture', id: 'rockTex' })

    expect(g.revisionOf(K('material', 'stone'))).toBe(1)
    expect(g.revisionOf(K('model', 'boulder'))).toBe(1)
    expect(g.revisionOf(K('scene', 'level1'))).toBe(1)
    // A dependency, not a dependent: changing the texture does not change the image it reads.
    expect(g.revisionOf(K('image', 'rock.png'))).toBe(0)
    expect(g.revisionOf(K('material', 'unrelated'))).toBe(0)
  })

  it('reaches a scene through a template as well as directly', () => {
    g.setEdges({ kind: 'template', id: 'crate' },
      edgesOfAsset('template', { id: 'crate', nodeJson: { variables: { __modelId: { value: 'boulder' } } } }))
    g.setEdges({ kind: 'scene', id: 'level2' },
      edgesOfAsset('scene', { id: 'level2', refs: { templateIds: ['crate'] } }))

    expect(g.touch({ kind: 'model', id: 'boulder' }).map(r => `${r.kind}:${r.id}`))
      .toContain('scene:level2')
  })

  it('follows a LOD reference between two models', () => {
    g.setEdges({ kind: 'model', id: 'boulder_lod1' }, edgesOfAsset('model', { id: 'boulder_lod1', nodeJson: {} }))
    g.setEdges({ kind: 'model', id: 'boulder' }, edgesOfAsset('model', {
      ...p.model, lods: [{ distance: 40, modelId: 'boulder_lod1' }],
    }))
    expect(g.dependents(K('model', 'boulder_lod1'), 1)).toEqual([K('model', 'boulder')])
  })

  describe('re-extraction after an edit', () => {
    it('drops the old texture edge when a material is re-pointed', () => {
      const edited = { ...p.material, material: { textures: { baseTexture: 'sandTex' } } }
      g.setEdges({ kind: 'material', id: 'stone' }, edgesOfAsset('material', edited))

      expect(g.incoming(K('texture', 'rockTex'))).toEqual([])
      expect(g.dependents(K('texture', 'sandTex'))).toContain(K('model', 'boulder'))
    })

    it('leaves a broken reference visible when the target is deleted', () => {
      g.removeNode({ kind: 'texture', id: 'rockTex' })
      expect(g.dangling().map(e => `${e.from} -> ${e.to}`))
        .toEqual([`${K('material', 'stone')} -> ${K('texture', 'rockTex')}`])
    })

    it('still cascades from a deleted asset, so dependents learn they are broken', () => {
      g.removeNode({ kind: 'texture', id: 'rockTex' })
      expect(g.touch({ kind: 'texture', id: 'rockTex' }).map(r => `${r.kind}:${r.id}`))
        .toContain('model:boulder')
    })
  })

  describe('structurallyChanged — the gate on the identity diff', () => {
    it('is false for the same object', () => {
      expect(structurallyChanged(p.material, p.material)).toBe(false)
    })

    // The regression it exists for: every material and model save is followed by an async thumbnail
    // write-back. Without the gate each save cascades twice and re-raises a just-dismissed banner.
    it('is false when only the thumbnail was rewritten', () => {
      expect(structurallyChanged(p.material, { ...p.material, thumbnail: 'data:image/png;base64,AAA' }))
        .toBe(false)
    })

    it('is false when only skeleton metadata was rewritten', () => {
      const model = { ...p.model, ikRig: { a: 1 }, nodeNames: ['a'] }
      expect(structurallyChanged(model, { ...model, ikRig: { a: 2 }, nodeNames: ['b'] })).toBe(false)
    })

    // A rename IS hashed by hashAsset (a closed scene must re-resolve it), but it changes nothing about
    // what instantiating the asset produces — so it must not offer the user a destructive Reload.
    it('is false for a pure rename', () => {
      expect(structurallyChanged(p.material, { ...p.material, name: 'granite' })).toBe(false)
    })

    it('is true when a referenced id moves', () => {
      expect(structurallyChanged(p.model, { ...p.model, materialIds: ['moss'] })).toBe(true)
    })

    it('is true when a field appears or disappears', () => {
      expect(structurallyChanged(p.model, { ...p.model, cullDistance: 120 })).toBe(true)
      const { materialIds, ...without } = p.model
      expect(structurallyChanged(p.model, without)).toBe(true)
    })

    it('is true against a missing previous version', () => {
      expect(structurallyChanged(undefined, p.material)).toBe(true)
      expect(structurallyChanged(p.material, null)).toBe(true)
    })
  })
})

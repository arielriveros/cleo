import { describe, it, expect, beforeEach } from 'vitest'
import { AssetGraph, assetKey } from 'cleo'
import type { AssetRef } from 'cleo'
import { buildReferenceView, DX, DY } from '../src/features/assets/assetGraphLayout'

// The viewer's layout is pure, so it is asserted here rather than by looking at it.

const K = assetKey
const nameOf = (ref: AssetRef) => ref.id

/** scene:level1 -> model:boulder -> material:stone -> texture:rock -> image:rock.png */
function chain(g: AssetGraph): void {
  g.setEdges({ kind: 'image', id: 'rock.png' }, [])
  g.setEdges({ kind: 'texture', id: 'rock' }, [{ to: { kind: 'image', id: 'rock.png' }, field: 'source.imageId' }])
  g.setEdges({ kind: 'material', id: 'stone' }, [{ to: { kind: 'texture', id: 'rock' }, field: 'textures.baseTexture' }])
  g.setEdges({ kind: 'model', id: 'boulder' }, [{ to: { kind: 'material', id: 'stone' }, field: 'materialIds[0]' }])
  g.setEdges({ kind: 'scene', id: 'level1' }, [{ to: { kind: 'model', id: 'boulder' }, field: 'refs.modelIds' }])
}

const at = (view: { nodes: any[] }, key: string) => view.nodes.find(n => n.key === key)

describe('buildReferenceView', () => {
  let g: AssetGraph
  beforeEach(() => { g = new AssetGraph(); chain(g) })

  it('puts the root at the origin', () => {
    const view = buildReferenceView(g, { kind: 'material', id: 'stone' }, { nameOf })
    const root = at(view, K('material', 'stone'))
    expect(root).toMatchObject({ depth: 0, x: 0, y: 0 })
  })

  it('fans referencers left and references right', () => {
    const view = buildReferenceView(g, { kind: 'material', id: 'stone' }, { nameOf })
    // What the material uses, to the right.
    expect(at(view, K('texture', 'rock'))).toMatchObject({ depth: 1, x: DX })
    expect(at(view, K('image', 'rock.png'))).toMatchObject({ depth: 2, x: 2 * DX })
    // What uses the material, to the left.
    expect(at(view, K('model', 'boulder'))).toMatchObject({ depth: -1, x: -DX })
    expect(at(view, K('scene', 'level1'))).toMatchObject({ depth: -2, x: -2 * DX })
  })

  it('honours a per-side depth limit', () => {
    const view = buildReferenceView(g, { kind: 'material', id: 'stone' },
      { nameOf, referencerDepth: 1, referenceDepth: 1 })
    expect(view.nodes.map(n => n.key).sort()).toEqual(
      [K('material', 'stone'), K('model', 'boulder'), K('texture', 'rock')].sort())
  })

  it('keeps only edges whose both ends are in view', () => {
    const view = buildReferenceView(g, { kind: 'material', id: 'stone' },
      { nameOf, referencerDepth: 1, referenceDepth: 1 })
    // model -> material and material -> texture survive; texture -> image is cut with the image.
    expect(view.edges.map(e => e.field).sort()).toEqual(['materialIds[0]', 'textures.baseTexture'])
  })

  it('carries the field onto the edge', () => {
    const view = buildReferenceView(g, { kind: 'material', id: 'stone' }, { nameOf, referenceDepth: 1, referencerDepth: 0 })
    expect(view.edges).toEqual([{
      id: `${K('material', 'stone')}->${K('texture', 'rock')}|textures.baseTexture`,
      source: K('material', 'stone'),
      target: K('texture', 'rock'),
      field: 'textures.baseTexture',
    }])
  })

  describe('column packing', () => {
    beforeEach(() => {
      g.setEdges({ kind: 'material', id: 'stone' }, [
        { to: { kind: 'texture', id: 'rock' }, field: 'textures.baseTexture' },
        { to: { kind: 'texture', id: 'alpha' }, field: 'textures.normalMap' },
        { to: { kind: 'texture', id: 'moss' }, field: 'textures.emissiveMap' },
      ])
    })

    it('centres a column on the root row and spaces it by DY', () => {
      const view = buildReferenceView(g, { kind: 'material', id: 'stone' }, { nameOf, referenceDepth: 1, referencerDepth: 0 })
      // `view.nodes` is in discovery order; the ROWS are what the layout decides, so sort by y.
      const column = view.nodes.filter(n => n.depth === 1).map(n => n.y).sort((a, b) => a - b)
      expect(column).toEqual([-DY, 0, DY])
    })

    it('orders a column by kind then name, so a redraw does not reshuffle rows', () => {
      const view = buildReferenceView(g, { kind: 'material', id: 'stone' }, { nameOf, referenceDepth: 1, referencerDepth: 0 })
      expect(view.nodes.filter(n => n.depth === 1).sort((a, b) => a.y - b.y).map(n => n.ref.id))
        .toEqual(['alpha', 'moss', 'rock'])
    })
  })

  describe('a node reachable from both sides', () => {
    // A cycle: the template embeds the model, and the model's subtree names the template.
    beforeEach(() => {
      g.setEdges({ kind: 'template', id: 'crate' }, [{ to: { kind: 'model', id: 'boulder' }, field: '__modelId' }])
      g.setEdges({ kind: 'model', id: 'boulder' }, [
        { to: { kind: 'material', id: 'stone' }, field: 'materialIds[0]' },
        { to: { kind: 'template', id: 'crate' }, field: '__templateId' },
      ])
    })

    it('terminates', () => {
      const view = buildReferenceView(g, { kind: 'model', id: 'boulder' }, { nameOf })
      expect(view.nodes.length).toBeGreaterThan(2)
    })

    it('draws it once, at the depth nearest the root', () => {
      const view = buildReferenceView(g, { kind: 'model', id: 'boulder' }, { nameOf })
      const crate = view.nodes.filter(n => n.key === K('template', 'crate'))
      expect(crate).toHaveLength(1)
      expect(Math.abs(crate[0].depth)).toBe(1)
    })
  })

  describe('broken references', () => {
    beforeEach(() => {
      g.setEdges({ kind: 'material', id: 'stone' }, [{ to: { kind: 'texture', id: 'deleted' }, field: 'textures.baseTexture' }])
    })

    it('marks a target that does not exist', () => {
      const view = buildReferenceView(g, { kind: 'material', id: 'stone' }, { nameOf })
      expect(at(view, K('texture', 'deleted'))).toMatchObject({ missing: true })
      expect(view.missingCount).toBe(1)
    })

    it('names it by its raw id, which is all there is to go on', () => {
      const view = buildReferenceView(g, { kind: 'material', id: 'stone' }, { nameOf })
      expect(at(view, K('texture', 'deleted')).name).toBe('deleted')
    })

    it('reports nothing missing for a whole project', () => {
      const view = buildReferenceView(g, { kind: 'image', id: 'rock.png' }, { nameOf })
      expect(view.missingCount).toBe(0)
    })
  })

  describe('filters', () => {
    it('hides a kind and closes the gap it left', () => {
      const view = buildReferenceView(g, { kind: 'material', id: 'stone' },
        { nameOf, hiddenKinds: new Set(['scene']) })
      expect(view.nodes.map(n => n.ref.kind)).not.toContain('scene')
    })

    it('never hides the root itself', () => {
      const view = buildReferenceView(g, { kind: 'scene', id: 'level1' },
        { nameOf, hiddenKinds: new Set(['scene']) })
      expect(at(view, K('scene', 'level1'))).toBeTruthy()
    })

    it('flags a partial scene', () => {
      const view = buildReferenceView(g, { kind: 'model', id: 'boulder' },
        { nameOf, isPartial: ref => ref.kind === 'scene' })
      expect(at(view, K('scene', 'level1'))).toMatchObject({ partial: true })
    })
  })

  it('handles a root with no edges at all', () => {
    g.setEdges({ kind: 'script', id: 'lonely' }, [])
    const view = buildReferenceView(g, { kind: 'script', id: 'lonely' }, { nameOf })
    expect(view.nodes).toHaveLength(1)
    expect(view.edges).toEqual([])
  })

  it('handles a root the graph has never heard of', () => {
    const view = buildReferenceView(g, { kind: 'model', id: 'ghost' }, { nameOf })
    expect(view.nodes).toEqual([expect.objectContaining({ key: K('model', 'ghost'), missing: true, depth: 0 })])
  })
})

import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Node, type PropertyType } from 'cleo'

// PropertyField is THE editor of a value by its type: the same widget for a script's `@attribute` field and an
// engine node's declared property. The pickers themselves are stubbed to markers: this is about which one a
// type gets, and the value it is handed.

// Toggle and Slider read their docs row through a store server rendering cannot subscribe to.
vi.mock('@cleo/app-kit/docs/DocScope', async (original) => ({ ...(await original<any>()), useDocEntry: () => null }))
vi.mock('../src/features/EngineContext', () => ({
  useCleoEngine: () => ({
    editorScene: null, rigs: [], animations: [], templates: [{ name: 'Hollow' }], animControllers: [],
    inputMap: { maps: [{ actions: [{ name: 'Jump' }, { name: 'Roll' }] }] },
    sceneList: [{ name: 'Dungeon' }], projectSettings: { collisionLayers: ['Default', 'Character'] },
    scriptAssetOf: () => undefined, scriptAssets: [],
  }),
}))
vi.mock('../src/features/AssetLibraryContext', () => ({
  useAssetLibrary: () => ({ soundSamples: [{ id: 's1', name: 'Swing' }], tilesets: [{ id: 't1', name: 'Dungeon tiles' }] }),
}))
vi.mock('../src/features/terrainMaterials/MaterialPicker', () => ({
  default: (p: any) => createElement('i', { 'data-picker': 'material', 'data-value': String(p.value) }),
}))
vi.mock('../src/features/texture/TextureSlotPicker', () => ({
  default: (p: any) => createElement('i', { 'data-picker': 'texture', 'data-value': String(p.value) }),
}))
vi.mock('../src/features/nodeInspector/NodeRefInput', () => ({
  default: (p: any) => createElement('i', { 'data-picker': 'node', 'data-value': String(p.value) }),
}))

const { default: PropertyField } = await import('../src/features/properties/PropertyField')

const html = (type: PropertyType, value: unknown, extra: Record<string, unknown> = {}, node: Node | null = null) =>
  renderToStaticMarkup(createElement(PropertyField, { type, value, node, onChange: () => {}, ...extra }))

describe('PropertyField', () => {
  it('edits plain values with the plain inputs', () => {
    expect(html({ kind: 'boolean' }, true)).toContain('role="switch"')
    expect(html({ kind: 'string' }, 'hi')).toContain('value="hi"')
    expect(html({ kind: 'string' }, 'hi', { multiline: true })).toContain('<textarea')
    expect(html({ kind: 'number' }, 3, { min: 0, max: 10 })).toMatch(/type="range"/)
    expect(html({ kind: 'choice', values: ['melee', 'ranged'] }, 'ranged')).toMatch(/<select[^]*ranged/)
  })

  it('gives a colour a colour picker, and a vector one number per component', () => {
    expect(html({ kind: 'color' }, [1, 0, 0])).toMatch(/type="color"[^>]*value="#ff0000"|value="#ff0000"[^>]*type="color"/)
    expect(html({ kind: 'vector', size: 3 }, [1, 2, 3])).not.toContain('type="color"')
    expect((html({ kind: 'vector', size: 2 }, [1, 2]).match(/<input/g) ?? []).length).toBe(2)
    expect((html({ kind: 'color', alpha: true }, [1, 1, 1, 0.5]).match(/<input/g) ?? []).length).toBe(5)
  })

  it('gives each asset kind its picker, handed the stored id', () => {
    expect(html({ kind: 'asset', asset: 'material' }, { $asset: 'material', id: 'm1' })).toContain('data-picker="material" data-value="m1"')
    expect(html({ kind: 'asset', asset: 'material' }, null)).toContain('data-value="null"')
    expect(html({ kind: 'asset', asset: 'texture' }, { $asset: 'texture', id: 't9' })).toContain('data-picker="texture" data-value="t9"')
    const sound = html({ kind: 'asset', asset: 'sound' }, { $asset: 'sound', id: 's1' })
    expect(sound).toContain('Swing')
    expect(sound).toMatch(/<option value="s1" selected/)
    expect(html({ kind: 'asset', asset: 'tileset' }, null)).toContain('Dungeon tiles')
  })

  it('gives a node field the scene node picker, and says when its path leads nowhere', () => {
    const root = new Node('root')
    const self = new Node('Self')
    const lamp = new Node('Lamp')
    root.addChild(self); root.addChild(lamp)
    ;(root as any)._scene = {}
    ;(self as any)._scene = {}
    const type: PropertyType = { kind: 'node', className: 'Node' }
    expect(html(type, { $nodePath: '../Lamp' }, {}, self)).toContain(`data-picker="node" data-value="${lamp.id}"`)
    expect(html(type, { $nodePath: '../Gone' }, {}, self)).toContain('Missing: ../Gone')
  })

  it('lists the project\'s names for a name only the project declares', () => {
    expect(html({ kind: 'name', name: 'action' }, 'Jump')).toContain('Jump')
    expect(html({ kind: 'name', name: 'scene' }, 'Dungeon')).toContain('Dungeon')
  })

  it('edits a list one row per entry, with the item type\'s editor', () => {
    const list = html({ kind: 'list', of: { kind: 'asset', asset: 'texture' } }, [{ $asset: 'texture', id: 'a' }, { $asset: 'texture', id: 'b' }])
    expect((list.match(/data-picker="texture"/g) ?? []).length).toBe(2)
    expect(list).toContain('+ Add')
    expect(html({ kind: 'list', of: { kind: 'string' } }, ['x', 'y'])).toContain('value="y"')
  })

  it("picks an @options field from the list it names", () => {
    expect(html({ kind: 'string' }, 'Axe', { options: ['Sword', 'Axe'] })).toMatch(/<option value="Axe" selected/)
  })
})

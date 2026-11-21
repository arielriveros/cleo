import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { declaredClasses, resolveProperty, LightNode, DirectionalLight, PointLight, Spotlight, AreaLight } from 'cleo'

// The generated inspector rows (features/properties/DeclaredSections.tsx) for every node class that declares its
// properties: each draws, and shows the rows its node's kind shows. The pickers are stubbed, as in
// propertyField.test.ts: this is about the rows, not the widgets.

vi.mock('@cleo/app-kit/docs/DocScope', async (original) => ({ ...(await original<any>()), useDocEntry: () => null }))
vi.mock('../src/features/EngineContext', () => ({
  useCleoEngine: () => ({
    eventEmitter: { on() {}, off() {}, emit() {} },
    editorScene: null, rigs: [], animations: [], templates: [], animControllers: [],
    inputMap: { maps: [] }, sceneList: [], projectSettings: { collisionLayers: [] }, scriptAssetOf: () => undefined, scriptAssets: [],
  }),
}))
vi.mock('../src/features/AssetLibraryContext', () => ({ useAssetLibrary: () => ({ soundSamples: [], tilesets: [] }) }))
vi.mock('../src/features/terrainMaterials/MaterialPicker', () => ({ default: () => createElement('i', { 'data-picker': 'material' }) }))
vi.mock('../src/features/texture/TextureSlotPicker', () => ({ default: () => createElement('i', { 'data-picker': 'texture' }) }))
vi.mock('../src/features/nodeInspector/NodeRefInput', () => ({ default: () => createElement('i', { 'data-picker': 'node' }) }))

const { default: DeclaredSections } = await import('../src/features/properties/DeclaredSections')

const SAMPLES = new Map<Function, () => any[]>([
  [LightNode, () => [DirectionalLight, PointLight, Spotlight, AreaLight].map(L => new LightNode('probe', new (L as any)({})))],
])
const instancesOf = (Class: any): any[] => SAMPLES.get(Class)?.() ?? (() => { try { return [new Class('probe')] } catch { return [] } })()

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;')

describe('the generated inspector rows', () => {
  it.each([...declaredClasses()].map(([Class, decl]) => [decl.title, Class, decl] as const))('%s: draws every row its node shows', (_t, Class, decl) => {
    for (const node of instancesOf(Class)) {
      const html = renderToStaticMarkup(createElement(DeclaredSections, { node }))
      for (const section of decl.sections) {
        if (section.when && !section.when(node)) continue
        if (section.title) expect(html, `${decl.title}: section ${section.title}`).toContain(escape(section.title))
        for (const p of section.props) {
          const label = resolveProperty(p, node).label
          const shown = !p.when || p.when(node)
          if (shown) expect(html, `${decl.title}: ${label}`).toContain(escape(label))
        }
      }
    }
  })
})

import { describe, it, expect } from 'vitest'
import { Node, Scene } from 'cleo'
import { resyncScene } from '../src/utils/sceneResync'
import { buildTemplateFromNode, instantiateTemplate, TEMPLATE_ID_VAR, type Template } from '../src/utils/templates'
import {
  applyOverrides, clearOverride, isOverridden, nodeAtPath, overrideCount, pathOf, readOverrides,
  setFieldOverride, setNameOverride, writeOverrides,
} from '../src/utils/templateOverrides'
import { SCRIPT_ID_VAR, type ScriptAsset } from '../src/utils/scripts'
import { cascadeFrom, createVariant, saveVariant } from '../src/utils/templateVariants'

const maps = () => ({ scripts: new Map<string, string>(), bodies: new Map(), triggers: new Map() })
const libs = (templates: Template[]) =>
  ({ materials: [], models: [], templates, terrainMaterials: [], scripts: [], tilesets: [], aiBrains: [] }) as any

/** A message-like template: a root carrying `title`, a Glow child carrying `rate`, and two Light children. */
function messageTemplate(title = 'Default', rate = 1): Template {
  return {
    id: 'tpl-message', name: 'Message',
    nodeJson: {
      name: 'Message', nodeType: 'node', id: 't-root', scriptVars: { title },
      children: [
        { name: 'Glow', nodeType: 'node', id: 't-glow', scriptVars: { rate }, children: [] },
        { name: 'Light', nodeType: 'node', id: 't-l1', children: [] },
        { name: 'Light', nodeType: 'node', id: 't-l2', children: [] },
      ],
    },
    scripts: {}, bodies: {}, triggers: {},
  }
}

function place(scene: Scene, template: Template, m = maps()): Node {
  const id = instantiateTemplate(template, scene.root, m)
  return scene.getNodeById(id)!
}

const instancesOf = (scene: Scene) => Array.from(scene.nodes).filter(n => n.getVariable(TEMPLATE_ID_VAR))

describe('override paths', () => {
  it('round-trips name paths, duplicate siblings included', () => {
    const scene = new Scene()
    try {
      const root = place(scene, messageTemplate())
      const [glow, light1, light2] = root.children as Node[]
      expect(pathOf(root, root)).toBe('')
      expect(pathOf(root, glow)).toBe('Glow')
      expect(pathOf(root, light1)).toBe('Light')
      expect(pathOf(root, light2)).toBe('Light#1')
      for (const n of [root, glow, light1, light2]) expect(nodeAtPath(root, pathOf(root, n)!)).toBe(n)
      expect(nodeAtPath(root, 'Missing')).toBeNull()
      expect(pathOf(glow, root)).toBeNull()
    } finally { scene.dispose() }
  })
})

describe('recording overrides', () => {
  it('records fields per node and the root name, and clears them', () => {
    const scene = new Scene()
    try {
      const root = place(scene, messageTemplate())
      const glow = root.children[0] as Node
      setFieldOverride(root, 'title', 'Mine')
      setFieldOverride(glow, 'rate', 5)
      setNameOverride(root, 'Boss Reward')
      expect(readOverrides(root)).toEqual({ '': { name: 'Boss Reward', fields: { title: 'Mine' } }, Glow: { fields: { rate: 5 } } })
      expect(isOverridden(root, 'name')).toBe(true)
      expect(isOverridden(glow, 'rate')).toBe(true)
      expect(overrideCount(root)).toBe(3)
      clearOverride(glow, 'rate')
      clearOverride(root, 'name')
      expect(readOverrides(root)).toEqual({ '': { fields: { title: 'Mine' } } })
      writeOverrides(root, {})
      expect(root.getVariable('__overrides')).toBeUndefined()
    } finally { scene.dispose() }
  })

  it('ignores nodes outside any instance, and a name on anything but the root', () => {
    const scene = new Scene()
    try {
      const loose = new Node('loose')
      scene.addNode(loose)
      setFieldOverride(loose, 'x', 1)
      expect(loose.getVariable('__overrides')).toBeUndefined()
      const root = place(scene, messageTemplate())
      writeOverrides(root, { Glow: { name: 'Renamed' } })
      expect(readOverrides(root)).toEqual({})
    } finally { scene.dispose() }
  })

  it('keeps an override whose node the template no longer has, and reports it', () => {
    const scene = new Scene()
    try {
      const root = place(scene, messageTemplate())
      writeOverrides(root, { Gone: { fields: { a: 1 } }, '': { fields: { title: 'Kept' } } })
      expect(applyOverrides(root)).toEqual(['Gone'])
      expect((root as any).title).toBe('Kept')
      expect(readOverrides(root).Gone).toBeDefined()
    } finally { scene.dispose() }
  })
})

describe('rebuilding an instance from its template', () => {
  it('keeps each placement\'s overrides and gives the rest the template\'s new values', () => {
    const scene = new Scene()
    try {
      const m = maps()
      const template = messageTemplate('Default', 1)
      const mine = place(scene, template, m)
      const plain = place(scene, template, m)
      mine.name = 'Boss Reward'
      setNameOverride(mine, 'Boss Reward')
      ;(mine as any).title = 'Mine'
      setFieldOverride(mine, 'title', 'Mine')
      const glow = mine.children[0] as any
      glow.rate = 7
      setFieldOverride(glow, 'rate', 7)
      mine.setPosition([1, 2, 3])

      // The template is edited: new defaults everywhere.
      const edited = messageTemplate('Changed', 2)
      expect(resyncScene(scene, m, libs([edited]), undefined)).toBe(true)

      const [a, b] = instancesOf(scene)
      const rebuiltMine = a.name === 'Boss Reward' ? a : b
      const rebuiltPlain = rebuiltMine === a ? b : a
      expect(rebuiltMine.id).not.toBe(mine.id)                 // really rebuilt
      expect(rebuiltMine.name).toBe('Boss Reward')
      expect((rebuiltMine as any).title).toBe('Mine')
      expect((rebuiltMine.children[0] as any).rate).toBe(7)
      expect(Array.from(rebuiltMine.position)).toEqual([1, 2, 3])
      expect(rebuiltPlain.name).toBe('Message')
      expect((rebuiltPlain as any).title).toBe('Changed')
      expect((rebuiltPlain.children[0] as any).rate).toBe(2)
      expect(plain.parent).toBeNull()
    } finally { scene.dispose() }
  })
})

describe('saving a template', () => {
  it('captures class-script field values, which serialize() does not see', async () => {
    const scene = new Scene()
    try {
      const root = new Node('Message')
      root.setVariable(SCRIPT_ID_VAR, 'script-message', 'string')
      ;(root as any).title = 'Authored'
      scene.addNode(root)
      const asset = {
        id: 'script-message', name: 'SoulsMessage', baseType: 'node', kind: 'class',
        source: 'export default class SoulsMessage extends Node { public title: string = "x" }',
        variables: [{ name: 'title', type: 'string', access: 'public', value: 'x' }],
      } as unknown as ScriptAsset
      const without = await buildTemplateFromNode(root, maps())
      expect(without.nodeJson.scriptVars).toBeUndefined()
      const withVars = await buildTemplateFromNode(root, maps(), [asset])
      expect(withVars.nodeJson.scriptVars).toEqual({ title: 'Authored' })
    } finally { scene.dispose() }
  })
})

describe('a placed copy of a template VARIANT', () => {
  it('follows an edit to the variant\'s base, and keeps its own overrides through it', () => {
    const scene = new Scene()
    try {
      const m = maps()
      const base = messageTemplate('Default', 1)
      // The variant changes the Glow's rate; it inherits the title.
      const v0 = createVariant(base, 'Loud Message', 'tpl-loud')
      const edited = { ...v0, nodeJson: JSON.parse(JSON.stringify(v0.nodeJson)) }
      edited.nodeJson.children[0].scriptVars.rate = 5
      const variant = saveVariant(v0, edited, base, base)

      const copy = place(scene, variant, m)
      ;(copy as any).title = 'Placed'
      setFieldOverride(copy, 'title', 'Placed')

      // The BASE is edited: the cascade rebuilds the variant, and the resync rebuilds the copy.
      const newBase = messageTemplate('New Default', 3)
      newBase.nodeJson.children.push({ name: 'Spark', nodeType: 'node', id: 't-spark', children: [] })
      const [cascaded] = cascadeFrom([newBase, variant], base.id)
      expect(resyncScene(scene, m, libs([newBase, cascaded]), undefined)).toBe(true)

      const [rebuilt] = instancesOf(scene)
      expect((rebuilt as any).title).toBe('Placed')                       // the placement's override
      expect((rebuilt.children[0] as any).rate).toBe(5)                   // the variant's override
      expect(rebuilt.children.map((c: Node) => c.name)).toContain('Spark') // the base's new child
    } finally { scene.dispose() }
  })
})

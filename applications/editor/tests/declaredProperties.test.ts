import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { declaredClasses, resolveProperty, typeOfToken, readProperty, writeProperty, LightNode, DirectionalLight, PointLight, Spotlight, AreaLight } from 'cleo'
import { parseDocs, resolveTerm, slugify } from '@cleo/app-kit/docs/parseDocs'

// The engine nodes' declared properties (src/properties): what the inspector generates its rows from. A row
// carries no prose of its own, so every declared label must have its docs row in its card's section of the
// node inspector's page; and every key must be a property the node really has.

const PAGE = 'editor/node-inspector'
const md = readFileSync(join(__dirname, '..', '..', '..', 'docs', 'editor', 'node-inspector.md'), 'utf-8')
const index = parseDocs({ [PAGE]: md })

/** Nodes of the class to read the properties from: one of each kind where a node comes in kinds. */
const SAMPLES = new Map<Function, () => any[]>([
  [LightNode, () => [DirectionalLight, PointLight, Spotlight, AreaLight].map(L => new LightNode('probe', new (L as any)({})))],
])
function instancesOf(Class: any): any[] {
  const make = SAMPLES.get(Class)
  if (make) return make()
  try { return [new Class('probe')] } catch { return [] }
}

const classes = [...declaredClasses()]

describe('declared properties', () => {
  it('are declared for at least the converted cards', () => {
    expect(classes.length).toBeGreaterThan(0)
  })

  it.each(classes.map(([Class, decl]) => [decl.title, Class, decl] as const))('%s: every key is a real property, of a type the editors know', (_title, Class, decl) => {
    const nodes = instancesOf(Class)
    for (const section of decl.sections) for (const p of section.props) {
      expect(typeOfToken(p.type), `${decl.title}.${p.key}`).not.toBeNull()
      for (const node of nodes) {
        if (p.get || (section.when && !section.when(node)) || (p.when && !p.when(node))) continue
        expect(readProperty(node, p), `${decl.title}.${p.key} reads undefined`).not.toBeUndefined()
      }
    }
  })

  it.each(classes.map(([Class, decl]) => [decl.title, Class, decl] as const))('%s: every row writes back what it reads', (_title, Class, decl) => {
    for (const node of instancesOf(Class)) for (const section of decl.sections) for (const p of section.props) {
      if (p.readonly || (section.when && !section.when(node)) || (p.when && !p.when(node))) continue
      const before = readProperty(node, p)
      const plain = ArrayBuffer.isView(before) ? Array.from(before as any) : before
      expect(() => writeProperty(node, p, plain), `${decl.title}.${p.key}`).not.toThrow()
      const after = readProperty(node, p)
      expect(JSON.stringify(ArrayBuffer.isView(after) ? Array.from(after as any) : after), `${decl.title}.${p.key}`).toBe(JSON.stringify(plain))
    }
  })

  it.each(classes.map(([Class, decl]) => [decl.title, Class, decl] as const))('%s: every row has its docs row', (_title, Class, decl) => {
    const nodes = instancesOf(Class)
    const section = slugify(decl.title)
    const missing = new Set<string>()
    for (const s of decl.sections) for (const p of s.props) {
      const labels = nodes.length ? nodes.map(node => resolveProperty(p, node).label) : [typeof p.label === 'string' ? p.label : p.key]
      for (const label of labels)
        if (!resolveTerm(index, [{ page: PAGE, section, fields: true }], label, 'field')) missing.add(label)
    }
    expect([...missing], `no docs row under "${decl.title}" in docs/editor/node-inspector.md`).toEqual([])
  })

  it.each(classes.map(([Class, decl]) => [decl.title, Class, decl] as const))('%s: the card and each titled section resolve in the docs', (_title, _Class, decl) => {
    expect(resolveTerm(index, [{ page: PAGE }], decl.title), `no "${decl.title}" in the node inspector's docs`).not.toBeNull()
    const section = slugify(decl.title)
    const missing = decl.sections.filter(s => s.title)
      .filter(s => !resolveTerm(index, [{ page: PAGE, section, fields: true }, { page: PAGE }], s.title)).map(s => s.title)
    expect(missing, `section titles with no docs entry under "${decl.title}"`).toEqual([])
  })
})

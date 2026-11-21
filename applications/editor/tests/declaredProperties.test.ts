import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { declaredClasses, resolveProperty, typeOfToken, readProperty, writeProperty, labelOfKey } from 'cleo'
import { declaredSamples as instancesOf } from './support/declaredSamples'
import { parseDocs, resolveTerm, slugify } from '@cleo/app-kit/docs/parseDocs'

// The engine nodes' declared properties (src/properties): what the inspector generates its rows from. A row
// carries no prose of its own, so every declared label must have its docs row in its card's section of the
// node inspector's page; and every key must be a property the node really has.

const DOCS = join(__dirname, '..', '..', '..', 'docs', 'editor')
const index = parseDocs(Object.fromEntries(readdirSync(DOCS).filter(f => f.endsWith('.md'))
  .map(f => [`editor/${f.replace(/\.md$/, '')}`, readFileSync(join(DOCS, f), 'utf-8')])))

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
    const section = decl.docsSection ?? slugify(decl.title)
    const missing = new Set<string>()
    for (const s of decl.sections) for (const p of s.props) {
      const labels = nodes.length ? nodes.map(node => resolveProperty(p, node).label) : [typeof p.label === 'string' ? p.label : labelOfKey(p.key)]
      // As the inspector looks a row up: in its section's own docs region when the docs give it one, else the card's.
      const regions = [...(s.title ? [slugify(s.title)] : []), section]
      for (const label of labels)
        if (!regions.some(r => resolveTerm(index, [{ page: decl.docs, section: r, fields: true }], label, 'field'))) missing.add(label)
    }
    expect([...missing], `no docs row under "${decl.title}" in docs/${decl.docs}.md`).toEqual([])
  })

  it.each(classes.map(([Class, decl]) => [decl.title, Class, decl] as const))('%s: the card and each titled section resolve in the docs', (_title, _Class, decl) => {
    expect(decl.docsSection ? true : resolveTerm(index, [{ page: decl.docs }], decl.title), `no "${decl.title}" in docs/${decl.docs}.md`).toBeTruthy()
    const section = decl.docsSection ?? slugify(decl.title)
    const missing = decl.sections.filter(s => s.title)
      .filter(s => !resolveTerm(index, [{ page: decl.docs, section, fields: true }, { page: decl.docs }], s.title)).map(s => s.title)
    expect(missing, `section titles with no docs entry under "${decl.title}"`).toEqual([])
  })
})

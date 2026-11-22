import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { ADD_ITEMS, ADD_CATEGORIES } from '../src/features/sceneInspector/addCatalog'
import { LIBRARIES, OPENERS } from '../src/features/agentBridge/libraries'
// The MCP server's own catalog: plain data, read here so it cannot drift from the editor's.
import { ADD_TYPES, ALL_ADD_TYPES, ASSET_KINDS, EXPERIMENTAL_TYPES, TYPES_2D, addTypesText } from '../../mcp/src/catalog.mjs'
import { experimentalFeatureOfAddItem } from '../src/features/projectFeatures/featureUi'

// The agent's tools describe the editor's Add catalog and asset libraries in a module of their own
// (applications/mcp/src/catalog.mjs), because the server answers tools/list before any editor connects.
// These tests are what keep that description true: a new add item or library fails here until the
// server's catalog names it too.

const UI = new Set(['uiLayout', 'uiCore', 'uiWidgets'])

describe('the MCP catalog matches the editor', () => {
  it('names every Add-catalog id, and nothing else', () => {
    expect([...ALL_ADD_TYPES].sort()).toEqual(ADD_ITEMS.map(i => i.id).sort())
  })

  it('groups each id under its catalog category (the UI ones under ui)', () => {
    const known = new Set((ADD_CATEGORIES as readonly { value: string }[]).map(c => c.value))
    for (const item of ADD_ITEMS) {
      const group = UI.has(item.category) ? 'ui' : item.category
      expect(known.has(item.category)).toBe(true)
      expect((ADD_TYPES as Record<string, string[]>)[group], `${item.id} (${item.category})`).toContain(item.id)
    }
  })

  it('lists as experimental exactly the ids whose feature the catalogue flags, and says so in the tool text', () => {
    const flagged = ADD_ITEMS.filter(i => experimentalFeatureOfAddItem(i.id)).map(i => i.id)
    expect([...EXPERIMENTAL_TYPES].sort()).toEqual(flagged.sort())
    for (const id of EXPERIMENTAL_TYPES) expect(addTypesText()).toContain(id)
    expect(addTypesText()).toMatch(/Experimental/)
  })

  it('marks only real ids as 2D', () => {
    for (const t of TYPES_2D) expect(ALL_ADD_TYPES).toContain(t)
  })

  it('lists the asset kinds the editor serves and opens', () => {
    expect(Object.keys(LIBRARIES).sort()).toEqual([...ASSET_KINDS].sort())
    expect(Object.keys(OPENERS).sort()).toEqual([...ASSET_KINDS].sort())
  })

  it('relays every tool to a method the editor answers', async () => {
    const tools = fs.readFileSync(path.resolve(__dirname, '../../mcp/src/tools.mjs'), 'utf8')
    const methods = [...tools.matchAll(/relay\('[a-z_]+', '([a-z.]+)'/g)].map(m => m[1])
    expect(methods.length).toBeGreaterThan(10)
    const commands = fs.readFileSync(path.resolve(__dirname, '../src/features/agentBridge/commands.ts'), 'utf8')
    for (const m of methods) expect(commands, m).toMatch(new RegExp(`(^|\\s)('${m.replace('.', '\\.')}'|${m.replace('.', '\\.')})(\\(|:|,)`, 'm'))
  })
})

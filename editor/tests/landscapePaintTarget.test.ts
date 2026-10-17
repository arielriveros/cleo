import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// Where the paint target lives. The layer stack and its material slots were reachable ONLY from a panel
// tabbed behind Properties, which in practice meant they could not be found at all: paint mode showed
// tools and no way to say which layer, or which material, they painted. Both halves of the fix are
// pinned here — the layout that puts the stack on screen, and the toolbar that repeats the target where
// the painting happens. No renderer in this suite, so these are source contracts.

const read = (...rel: string[]) => readFileSync(join(__dirname, '..', 'src', ...rel), 'utf8')
const DOCK = read('features', 'layout', 'DockLayout.tsx')
const TOOLBAR = read('features', 'landscape', 'LandscapeToolbar.tsx')
const PANEL = read('features', 'landscape', 'LandscapeLayersPanel.tsx')

describe('the landscape layer stack is on screen', () => {
  it('sits in a group of its own, not tabbed behind the tools', () => {
    expect(DOCK).toMatch(/id: 'landscapeLayers', component: 'landscapeLayers'[\s\S]{0,200}direction: 'below'/)
    // …and the tools keep sharing the Properties tab strip, so only one group was added.
    expect(DOCK).toMatch(/'clipTracks', \.\.\.TILEMAP_PANELS, 'landscapeTools'/)
  })

  it('opens on the tools rather than Properties, every time the mode is entered', () => {
    // Not only on a freshly built tree: a saved arrangement used to come back on whatever tab it held.
    expect(DOCK).toMatch(/if \(editorMode === 'landscape'\) \{[\s\S]{0,200}tools\.api\.setActive\(\)/)
  })

  it('bumped the layout version, or every existing user keeps the old arrangement', () => {
    const version = Number(/const LAYOUT_VERSION = (\d+)/.exec(DOCK)?.[1])
    expect(version).toBeGreaterThanOrEqual(18)
  })
})

describe('the paint target in the viewport toolbar', () => {
  it('picks only among the landscape material’s paint-only slots, with a way to edit that material', () => {
    expect(TOOLBAR).toMatch(/brush\.mode === 'paint' && <>[\s\S]{0,120}<PaintTarget/)
    expect(TOOLBAR).toMatch(/setBrush\(\{ paintSlotId: e\.target\.value \}\)/)
    expect(TOOLBAR).toMatch(/enterTerrainMaterialEditor\(materialId\)/)
    // Landscape mode never offers the project's Materials: those are chosen in the material editor.
    for (const source of [TOOLBAR, PANEL]) expect(source).not.toMatch(/\bMaterialPicker\b|MaterialMenu/)
  })

  it('falls back to the topmost paint slot exactly as the panel and the brush do', () => {
    for (const source of [TOOLBAR, PANEL, read('features', 'landscape', 'LandscapeBrush.tsx')])
      expect(source).toMatch(/resolvePaintTarget\([\w.]+, \w+\.paintSlotId\)/)
  })

  it('records the panel edits through the stack-edit hook, so each is one undo step', () => {
    expect(PANEL).toMatch(/useStackEdit\(node, refresh\)/)
    expect(read('features', 'landscape', 'useStackEdit.ts')).toMatch(/recordStackEdit\(/)
  })
})

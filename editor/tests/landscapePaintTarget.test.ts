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
  it('shows the active layer and its material, with a way to add one', () => {
    expect(TOOLBAR).toMatch(/brush\.mode === 'paint' && <>[\s\S]{0,120}<PaintTarget/)
    expect(TOOLBAR).toMatch(/setBrush\(\{ paintLayerId: e\.target\.value \}\)/)
    expect(TOOLBAR).toMatch(/<LandscapeMaterialSlot compact materialId=\{active\.materialId\}/)
    expect(TOOLBAR).toMatch(/<AddLayerButton/)
  })

  it('falls back to the topmost layer exactly as the panel does', () => {
    const fallback = /layers\.find\(l => l\.id === brush\.paintLayerId\) \?\? layers\[layers\.length - 1\]/
    expect(TOOLBAR).toMatch(fallback)
    expect(PANEL).toMatch(/layers\.some\(l => l\.id === brush\.paintLayerId\) \? brush\.paintLayerId : \(layers\[layers\.length - 1\]\?\.id \?\? null\)/)
  })

  it('records its edits through the same hook as the panel, so either is one undo step', () => {
    for (const source of [TOOLBAR, PANEL]) expect(source).toMatch(/useStackEdit\(node, refresh\)/)
    expect(read('features', 'landscape', 'useStackEdit.ts')).toMatch(/recordStackEdit\(/)
  })
})

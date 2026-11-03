import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// Source-text checks, for the reason editorModeReachability.test.ts gives: DockLayout pulls in dockview, the
// engine and a GL context, none of which a unit test can construct.
const DOCK = () => readFileSync(join(__dirname, '..', 'src', 'features', 'layout', 'DockLayout.tsx'), 'utf8')

describe('the Add palettes follow the mode', () => {
  it('shows only Scene Elements in scene mode', () => {
    expect(DOCK()).toMatch(/case 'scene':\s+hide\('uiAdd'\);\s+break;/)
  })

  it('shows only UI Elements in UI mode', () => {
    expect(DOCK()).toMatch(/case 'ui':\s+hide\('physics', 'sceneAdd'\);\s+break;/)
  })

  it('shows both while editing a template', () => {
    expect(DOCK()).toMatch(/case 'template':\s+break;/)
  })

  it('keeps UI Elements out of the landscape and tilemap scene sub-modes', () => {
    expect(DOCK()).toMatch(/case 'landscape':\s+case 'tilemap':\s+hide\('uiAdd', 'scripts', 'physics'\);/)
  })
})

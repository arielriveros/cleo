import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { DEFAULT_EDITOR_PREFS, parseEditorPrefs } from '../src/features/options/editorPrefs'

// The lock on Options ▸ Engine ▸ Performance: Play strips the editor to the viewport, except the Engine
// options panel when the lock is on (DockLayout docks it beside the viewport, open on Performance).
// DockLayout is read as source text: importing it pulls in Monaco, which needs a browser window.

const dock = readFileSync(join(__dirname, '../src/features/layout/DockLayout.tsx'), 'utf-8').replace(/\r\n/g, '\n')

describe('the Performance page lock in Play', () => {
  it('keeps only the Engine options panel up in Play when locked', () => {
    expect(dock).toContain("return pinPerformance ? hidden.filter(id => id !== 'optionsEngine') : hidden;")
    expect(dock).toContain('hiddenPanelIds(editorMode, isPlayMode, isSimulating, pinPerformanceInPlay)')
  })

  it('docks it beside the viewport, open on Performance, and follows the lock live', () => {
    expect(dock).toContain("if (isPlayMode && !isSimulating && pinPerformanceInPlay) {")
    expect(dock).toContain("setOptionsPage('engine', 'performance')")
    expect(dock).toContain("position: { referencePanel: 'viewport', direction: 'right' },")
    // The layout controller re-runs when the lock flips, so unlocking in Play closes the panel at once.
    expect(dock).toMatch(/\[api, editorMode, isPlayMode, isSimulating, pinPerformanceInPlay,/)
  })

  it('is an editor preference, off unless stored as true', () => {
    expect(DEFAULT_EDITOR_PREFS.pinPerformanceInPlay).toBe(false)
    expect(parseEditorPrefs({ pinPerformanceInPlay: true }).pinPerformanceInPlay).toBe(true)
    expect(parseEditorPrefs({ pinPerformanceInPlay: 'yes' }).pinPerformanceInPlay).toBe(false)
  })
})

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// The Debugger tab is for scripts: it is up while a game plays in a window (where a breakpoint stops it) or a
// script is open in a tab, and out of the bottom strip otherwise. Source-text checks, for the reason
// performancePlayPin.test.ts gives: importing DockLayout pulls in Monaco, which needs a browser window.

const dock = readFileSync(join(__dirname, '../src/features/layout/DockLayout.tsx'), 'utf-8').replace(/\r\n/g, '\n')

describe('the Debugger tab', () => {
  it('shows while a game plays in a window or a script tab is open', () => {
    expect(dock).toContain("import { useWindowPlay } from '../playWindow/windowPlay';")
    expect(dock).toContain("const showDebugger = windowPlaying || tabs.some(t => t.kind === 'script');")
    expect(dock).toContain("if (!showDebugger) hide('debugger');")
    // Every layout pass restricts with it.
    expect(dock).toContain('hiddenPanelIds(editorMode, isPlayMode, isSimulating, pinPerformanceInPlay, showDebuggerRef.current)')
  })

  it('comes and goes on its own, without rebuilding the tree', () => {
    // The flip adds or closes the one panel; the mode controller does not re-run for it.
    expect(dock).toMatch(/useEffect\(\(\) => \{\s+if \(!api\) return;\s+withProgrammaticLayout\(\(\) => \{\s+const hidden = hiddenPanelIds\(editorMode, isPlayMode, isSimulating, pinPerformanceInPlay, showDebugger\);/)
    expect(dock).toContain('}, [api, showDebugger]);')
    expect(dock).toMatch(/\}, \[editorMode, isPlayMode, isSimulating, pinPerformanceInPlay\]\);\n\n  \/\/ The Debugger comes and goes/)
  })

  it('comes back into the bottom strip, behind the tab that is showing', () => {
    // A tree saved while it was hidden has no Debugger: it is added back beside the Logger, inactive.
    const sync = dock.slice(dock.indexOf('function syncDebugger'), dock.indexOf('function loadLayouts'))
    expect(sync).toContain("position: { referencePanel: 'logger', direction: 'within' }, inactive: true,")
    // A remembered Debugger tab falls back to the Logger while it is hidden.
    expect(dock).toContain("dock.getPanel(want) ?? (want === 'debugger' ? dock.getPanel('logger') : undefined)")
  })
})

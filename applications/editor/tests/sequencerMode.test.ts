import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// Sequencer mode: a `.sequence` asset's tab over the OPEN scene. Source-text checks, for the reason
// editorModeReachability.test.ts gives (DockLayout, EngineContext and the panels pull in dockview and the
// engine). Each of these is a place where the mode fails silently: the Sequencer leaking into Scene mode, the
// Add palettes offering edits the mode refuses, the scene tab dirtied by keys, or the selection dropped.

const SRC = join(__dirname, '..', 'src')
const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf-8').replace(/\r\n/g, '\n')

describe('Sequencer mode', () => {
  it('is the only mode that shows the Sequencer, and it hides the Add palettes, Scripts and Physics', () => {
    const dock = read('features', 'layout', 'DockLayout.tsx')
    expect(dock).toContain("if (mode !== 'sequence') for (const id of SEQUENCER_PANELS) hidden.add(id)")
    expect(dock).toMatch(/case 'sequence':\s+hide\(\.\.\.ADD_PANELS, 'scripts', 'physics'\);/)
    // Opens on the timeline, and puts the mode on the dock for the orange skin.
    expect(dock).toContain(": editorMode === 'sequence' ? 'sequencer'")
    expect(dock).toContain('data-editor-mode={editorMode}')
    expect(read('..', '..', 'app-kit', 'src', 'styles', 'dockview.css')).toContain('[data-editor-mode="sequence"] .dockview-theme-cleo')
  })

  it('shows the open scene: no session scene, restored at boot, wearing the scene\'s own look', () => {
    const types = read('features', 'engineContextTypes.ts')
    expect(types).toMatch(/TAB_METERS_EXPOSURE[\s\S]*?\n  sequence: true,/)
    expect(types).toMatch(/TAB_RUNS_POST_PROCESSING[\s\S]*?\n  sequence: true,/)
    const ctx = read('features', 'EngineContext.tsx')
    expect(ctx).toContain("case 'sequence': return !!tab.sequenceId && sequencesRef.current.some(q => q.id === tab.sequenceId);")
    expect(ctx).toContain("case 'sequence': return sequencesRef.current.some(q => q.id === id);")
    expect(read('utils', 'tabState.ts')).toContain("sequence: 'sequenceId'")
    // The hook never gives a Sequencer tab a runtime.
    expect(read('features', 'hooks', 'useSequenceEditor.ts')).not.toContain('tabRuntimeRef.current.set')
  })

  it('keeps the selection and the view between the scene tab and a Sequencer tab, and applies its preview last', () => {
    const ctx = read('features', 'EngineContext.tsx')
    expect(ctx).toContain("const showsOpenScene = (k: TabKind | null) => k === 'scene' || k === 'sequence';")
    expect(ctx).toMatch(/if \(!sameScene\)\s+eventEmitter\.current\.emit\('SELECT_NODE'/)
    expect(ctx).toMatch(/eventEmitter\.current\.emit\('TAB_APPLIED', tab\.id\);\s+\};/)
    expect(ctx).toContain("if (activeTabKindRef.current === 'scene' || activeTabKindRef.current === 'sequence') viewDimensionRef.current = dimension;")
  })

  it('keys instead of dirtying the scene, and records sequence edits rather than scene snapshots', () => {
    const ctx = read('features', 'EngineContext.tsx')
    expect(ctx).toContain("if (sequenceKeyingActive()) return logDirtySkip('sequence-tab', e);")
    const history = read('features', 'HistoryContext.tsx')
    expect(history).toContain("const keysScene = allTabs.find(t => t.id === activeTabId)?.kind === 'sequence'")
    expect(history).toContain('if (keysSceneRef.current) return')
    expect(history).toContain('if (!selectedNode || keysScene) return')
  })

  it('refuses structure: the tree, the viewport, the inspector\'s links and the agent bridge', () => {
    const tree = read('features', 'sceneInspector', 'SceneInspector.tsx')
    expect(tree).toContain("const structureLocked = editorMode === 'sequence';")
    for (const guard of ['if (isPlayMode || structureLocked) return;', 'if (structureLocked) return;',
      'disableEdit={(d) => isPlayMode || structureLocked', 'disableDrop={({ parentNode }) => isPlayMode || structureLocked'])
      expect(tree).toContain(guard)
    const viewport = read('features', 'EngineViewport.tsx')
    expect(viewport).toMatch(/onViewportDragOver = [\s\S]*?if \(editorMode === 'sequence'\) return;/)
    expect(viewport).toMatch(/onViewportDrop = [\s\S]*?if \(editorMode === 'sequence'\) \{/)
    const inspector = read('features', 'nodeInspector', 'propertyEditors', 'PropertyEditor.tsx')
    expect(inspector).toContain('<fieldset disabled={lock.locked}')
    expect(read('utils', 'useAssetDrop.ts')).toContain('const locked = useContext(AssetDropLockContext);')
    expect(read('features', 'agentBridge', 'commands.ts')).toContain("if (h.engine.editorMode === 'sequence')")
  })

  it('saves every Sequencer tab from one saver, before the scene', () => {
    const saving = read('features', 'hooks', 'useSaving.ts')
    expect(saving).toMatch(/case 'sequence': \{\s+const saver = sequenceApplyRef\.current;/)
    expect(saving).toMatch(/sequence: 0,\s+model: 1, template: 2, scene: 3,/)
    expect(saving).toContain('const resumePreviews = suspendSequencePreviews();')
  })
})

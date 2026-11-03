import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// The Skeleton part's Ragdoll and Bone Masks are tabs of their own beside Properties. Source-text checks, for
// the reason editorModeReachability.test.ts gives: DockLayout and the rig panels pull in dockview and the
// engine. A dock panel missing from any one of these places fails silently — absent from every layout,
// leaking into other modes, or rendering nothing.

const SRC = join(__dirname, '..', 'src')
const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf-8').replace(/\r\n/g, '\n')
const DOCK = () => read('features', 'layout', 'DockLayout.tsx')
const PANELS = () => read('features', 'layout', 'panels.tsx')

describe('the rig mode has Ragdoll and Bone Masks tabs', () => {
  it('declares them, shows them only in rig mode, and puts them in the default tree', () => {
    const dock = DOCK()
    expect(dock).toMatch(/const RIG_PANELS = \['rigRagdoll', 'rigBoneMasks'\] as const/)
    expect(dock).toMatch(/const CHROME_PANELS = \[[\s\S]*\.\.\.RIG_PANELS[\s\S]*\] as const/)
    expect(dock).toContain("if (mode !== 'rig') for (const id of RIG_PANELS) hidden.add(id)")
    // Tabbed beside Properties, which rig mode keeps as Skeleton.
    expect(dock).toMatch(/for \(const id of \[[^\]]*\.\.\.RIG_PANELS\]\) \{\s+api\.addPanel\(\{\s+id, component: id, title: PANEL_TITLES\[id\],\s+position: \{ referencePanel: 'properties', direction: 'within' \}/)
  })

  it('registers a component and a title for each', () => {
    expect(PANELS()).toMatch(/rigRagdoll: RigRagdollPanel/)
    expect(PANELS()).toMatch(/rigBoneMasks: RigBoneMasksPanel/)
    const titles = read('features', 'layout', 'panelTitles.ts')
    expect(titles).toContain("rigRagdoll: 'Ragdoll', rigBoneMasks: 'Bone Masks'")
    expect(titles).toContain("rigRagdoll: 'editor/physics', rigBoneMasks: 'editor/animation'")
  })

  it('takes them out of the Skeleton inspector', () => {
    const inspector = read('features', 'rig', 'RigInspector.tsx')
    expect(inspector).not.toContain('<RagdollPanel')
    expect(inspector).not.toContain('<BoneMasksPanel')
  })

  it('re-reads what the tabs mirror when they mount, instead of being kept mounted', () => {
    // renderer:'always' on a tab beside Properties came back from a restored layout with Properties' content
    // missing — an empty Skeleton tab after every switch into rig mode.
    const dock = DOCK()
    const renderers = dock.slice(dock.indexOf('function assertRenderers'), dock.indexOf('function loadLayouts'))
    expect(renderers).not.toContain("'rigRagdoll'")
    expect(renderers).not.toContain("'rigBoneMasks'")
    // The Ragdoll tab asks the viewport overlay for Show / Test drop / the highlighted part, and the bone tree
    // for its selection; the Skeleton tab's sockets ask the tree too.
    const panel = read('features', 'rig', 'RagdollPanel.tsx')
    expect(panel).toContain('eventEmitter.emit(RAGDOLL_QUERY)')
    expect(panel).toContain('eventEmitter.emit(QUERY_SELECTED_JOINT)')
    expect(read('features', 'rig', 'SocketsPanel.tsx')).toContain('eventEmitter.emit(QUERY_SELECTED_JOINT)')
    const preview = read('features', 'rig', 'RagdollPreview.tsx')
    expect(preview).toContain('eventEmitter.on(RAGDOLL_QUERY, onQuery)')
    expect(preview).toContain('eventEmitter.emit(RAGDOLL_TEST_STATE, testRef.current !== null)')
    expect(read('features', 'animation', 'SkeletonTree.tsx')).toContain('eventEmitter.on(QUERY_SELECTED_JOINT, onQuery)')
  })

  it('bumped the layout version, since a stored tree cannot gain the two panels', () => {
    expect(DOCK()).toMatch(/const LAYOUT_VERSION = (2[2-9]|[3-9]\d)/)
  })

  it('a double-clicked mask or pose lands on the tab that edits it, expanded', () => {
    const dock = DOCK()
    expect(dock).toContain("e?.kind === 'boneMask' ? 'rigBoneMasks' : e?.kind === 'pose' ? 'properties' : null")
    expect(dock).toContain("eventEmitter.on('FOCUS_RIG_ASSET', onFocus)")
    // From another mode the request waits for the rig layout.
    expect(dock).toContain("if (editorMode === 'rig' && rigTab) api.getPanel(rigTab)?.api.setActive()")
    // The request outlives the panels: the session holds it, and the panels read it when they mount.
    const ctx = read('features', 'rig', 'RigContext.tsx')
    expect(ctx).toContain("eventEmitter.on('FOCUS_RIG_ASSET', onFocus)")
    expect(ctx).toMatch(/focus: RigFocus \| null/)
    for (const [file, kind] of [['BoneMasksPanel.tsx', 'boneMask'], ['PoseAssetsPanel.tsx', 'pose']] as const) {
      const panel = read('features', 'rig', file)
      expect(panel).toContain(`focus?.kind === '${kind}' ? focus.id : null`)
      expect(panel).not.toContain("'FOCUS_RIG_ASSET'")
    }
  })
})

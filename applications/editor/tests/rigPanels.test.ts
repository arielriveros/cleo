import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// The Skeleton part's Foot Placement, Ragdoll, Reactions and Bone Masks are tabs of their own beside Properties. Source-text checks, for
// the reason editorModeReachability.test.ts gives: DockLayout and the rig panels pull in dockview and the
// engine. A dock panel missing from any one of these places fails silently — absent from every layout,
// leaking into other modes, or rendering nothing.

const SRC = join(__dirname, '..', 'src')
const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf-8').replace(/\r\n/g, '\n')
const DOCK = () => read('features', 'layout', 'DockLayout.tsx')
const PANELS = () => read('features', 'layout', 'panels.tsx')

describe('the rig mode has Foot Placement, Ragdoll, Reactions and Bone Masks tabs', () => {
  it('declares them, shows them only in rig mode, and puts them in the default tree', () => {
    const dock = DOCK()
    expect(dock).toMatch(/const RIG_PANELS = \['rigFootPlacement', 'rigRagdoll', 'rigReactions', 'rigBoneMasks'\] as const/)
    expect(dock).toMatch(/const CHROME_PANELS = \[[\s\S]*\.\.\.RIG_PANELS[\s\S]*\] as const/)
    expect(dock).toContain("if (mode !== 'rig') for (const id of RIG_PANELS) hidden.add(id)")
    // Tabbed beside Properties, which rig mode keeps as Skeleton.
    expect(dock).toMatch(/for \(const id of \[[^\]]*\.\.\.RIG_PANELS\]\) \{\s+api\.addPanel\(\{\s+id, component: id, title: PANEL_TITLES\[id\],\s+position: \{ referencePanel: 'properties', direction: 'within' \}/)
  })

  it('registers a component and a title for each', () => {
    expect(PANELS()).toMatch(/rigFootPlacement: RigFootPlacementPanel/)
    expect(PANELS()).toMatch(/rigRagdoll: RigRagdollPanel/)
    expect(PANELS()).toMatch(/rigReactions: RigReactionsPanel/)
    expect(PANELS()).toMatch(/rigBoneMasks: RigBoneMasksPanel/)
    const titles = read('features', 'layout', 'panelTitles.ts')
    expect(titles).toContain("rigFootPlacement: 'Foot Placement', rigRagdoll: 'Ragdoll', rigReactions: 'Reactions', rigBoneMasks: 'Bone Masks'")
    expect(titles).toContain("rigFootPlacement: 'editor/animation', rigRagdoll: 'editor/physics', rigReactions: 'editor/reactions', rigBoneMasks: 'editor/animation'")
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
    expect(renderers).not.toContain("'rigReactions'")
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

  it('bumped the layout version, since a stored tree cannot gain the panels', () => {
    // 28 is Foot Placement's, 29 Reactions'.
    expect(DOCK()).toMatch(/const LAYOUT_VERSION = (29|[3-9]\d)/)
  })

  it('moves foot placement out from under the bone tree into its tab, open, with its blending', () => {
    // Under the tree it was in the Animator and Clip parts too, a collapsed section at the bottom of the tree.
    const tree = read('features', 'animation', 'SkeletonTree.tsx')
    expect(tree).not.toContain('<IkRigPanel')
    const tab = read('features', 'rig', 'FootPlacementPanel.tsx')
    expect(tab).toContain('<IkRigPanel skin={target.skin} selectedJoint={selectedJoint} />')
    // A tab: it asks the tree which bone is selected when it mounts behind another one.
    expect(tab).toContain('eventEmitter.emit(QUERY_SELECTED_JOINT)')
    const panel = read('features', 'animation', 'IkRigPanel.tsx')
    expect(panel).not.toContain('Collapsable')
    for (const key of ["'lockBlendIn'", "'lockRelease'", 'lockBlendCurve', 'FOOT_LOCK_CURVES']) expect(panel, key).toContain(key)
    const renderers = DOCK().slice(DOCK().indexOf('function assertRenderers'), DOCK().indexOf('function loadLayouts'))
    expect(renderers).not.toContain("'rigFootPlacement'")
  })

  it('a double-clicked mask or pose lands on the tab that edits it, expanded', () => {
    const dock = DOCK()
    expect(dock).toContain("e?.kind === 'boneMask' ? 'rigBoneMasks' : e?.kind === 'pose' ? 'properties' : e?.kind === 'ragdoll' ? 'rigRagdoll' : e?.kind === 'reactions' ? 'rigReactions' : null")
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

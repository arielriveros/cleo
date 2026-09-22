import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// Adding an editor mode means touching about fifteen files, and only four of them are compile errors if
// missed. The rest fail silently and in ways that look like something else: a panel that exists in no
// tree, a tab that restores into an empty viewport, a bottom strip that opens on the Logger.
//
// These read source text rather than importing, for the reason editorModeReachability.test.ts gives:
// EngineContext pulls in the whole engine.

const read = (...p: string[]) => readFileSync(join(__dirname, '..', 'src', ...p), 'utf-8').replace(/\r\n/g, '\n')

const DOCK = () => read('features', 'layout', 'DockLayout.tsx')
const PANELS = () => read('features', 'layout', 'panels.tsx')

describe('the clip editor mode is fully wired', () => {
  it('its panels are declared, registered, built and revealed', () => {
    const dock = DOCK()
    // Declared as a group...
    expect(dock).toMatch(/const CLIP_PANELS = \[[^\]]*'clipTracks'[^\]]*'clipTimeline'[^\]]*\]/)
    // ...hidden everywhere but its own mode. Without this line the panels leak into every other mode,
    // because `hiddenPanelIds`'s switch has no default.
    expect(dock).toContain("if (mode !== 'animation') for (const id of CLIP_PANELS) hidden.add(id)")
    // ...added to the default tree. A panel absent here exists in no layout at all.
    expect(dock).toMatch(/'clipTracks'.*TILEMAP_PANELS|clipTracks/)
    expect(dock).toContain("id: 'clipTimeline', component: 'clipTimeline'")
    // ...and resolvable to a component. An id with no entry here renders nothing, with no error.
    expect(PANELS()).toMatch(/clipTracks: ClipTracksPanel/)
    expect(PANELS()).toMatch(/clipTimeline: ClipTimelinePanel/)
  })

  it('the timeline is renderer:always, because its rAF loop poses the character', () => {
    // dockview unmounts an unselected panel by default. The timeline is the only thing ticking the
    // animator in this mode, so looking at the Logger would freeze the model mid-clip.
    expect(DOCK()).toMatch(/assertRenderers[\s\S]{0,400}'clipTimeline'/)
  })

  it('the bottom strip opens on the timeline rather than whatever was last used', () => {
    expect(DOCK()).toContain("editorMode === 'animation' ? 'clipTimeline'")
  })

  it('the layout version was bumped and the old key retired', () => {
    // A stored v15 tree is keyed by a mode name that no longer exists AND knows nothing of the new
    // panels. Leaving the version alone would restore an unreadable arrangement rather than rebuilding.
    const dock = DOCK()
    expect(dock).toMatch(/const LAYOUT_VERSION = (1[6-9]|[2-9]\d)/)
    expect(dock).toContain("'cleo_dock_layout_v15'")
  })

  it('double-clicking a .anim opens it', () => {
    // This used to `return false`, which sent the file manager into its metadata preview instead.
    expect(read('features', 'assets', 'assetKinds.ts')).toContain("case 'animation': deps.enterClipEditor(id); return true")
  })

  it('the tab restores across a reload', () => {
    expect(read('utils', 'tabState.ts')).toContain("animation: 'animationId'")
  })

  it('deleting the asset closes the tab', () => {
    // Otherwise the tab stays open over a record that no longer exists, and its session holds a working
    // copy that Save would happily re-add — resurrecting the asset the user just deleted.
    const ctx = read('features', 'EngineContext.tsx')
    const remove = ctx.slice(ctx.indexOf('const removeAnimation = '), ctx.indexOf('const removeAnimation = ') + 700)
    expect(remove).toContain("t.kind === 'animation' && t.animationId === id")
    expect(remove).toContain('removeTabById')
  })

  it('the save orchestrator can reach the session', () => {
    const saving = read('features', 'hooks', 'useSaving.ts')
    expect(saving).toContain('registerClipApply')
    expect(saving).toMatch(/case 'animation': \{[\s\S]{0,200}clipApplyRef/)
    // A clip saves in the first tier, with the rig it is authored against — before any model or scene
    // that plays it.
    expect(saving).toMatch(/animation: 0/)
  })
})

// The old `animation` mode was the per-node STATE MACHINE editor. It kept its behaviour and gave up its
// name, so that the clip editor's kind could match its AssetKind and need no special cases anywhere.
describe('the state machine mode kept its behaviour under its new name', () => {
  it('nothing still gates on the old spelling', () => {
    // Each of these is a place where `'animation'` now means the CLIP editor. A missed rename would not
    // fail to compile — both are valid TabKinds — it would just silently apply the wrong mode's rules.
    for (const [file, needle] of [
      [read('features', 'animation', 'StateGraph.tsx'), "editorMode !== 'stateMachine'"],
      [read('features', 'EngineViewport.tsx'), "editorMode === 'stateMachine' && !graphView"],
      [read('features', 'MenuBar.tsx'), "activeTab.kind === 'stateMachine'"],
      [read('features', 'TabBar.tsx'), "kind === 'stateMachine'"],
    ] as const) expect(file).toContain(needle)
  })

  it('the state machine tab is still NOT restorable', () => {
    // Its builder captures the source scene and source TAB from whatever is active when called, so
    // restoring it at boot would record the wrong write-back target for "Apply State Machine".
    const idField = read('utils', 'tabState.ts')
    const block = idField.slice(idField.indexOf('const ID_FIELD'), idField.indexOf('};', idField.indexOf('const ID_FIELD')))
    expect(block).not.toContain('stateMachine')
  })

  it('the skeleton tree and bone overlay serve all three skeleton modes', () => {
    expect(PANELS()).toContain("editorMode === 'stateMachine' || editorMode === 'rig' || editorMode === 'animation'")
    // `setSkeletonOverlay` is a single global slot, so the scene-wide debug overlay must stand down
    // wherever a dedicated bone overlay is up. Which modes those are is one exhaustive table now, and the
    // animation FIELD joined it: its skeleton used to depend on the debug toggle, which is off by default.
    expect(read('features', 'DebugSkeletonOverlay.tsx')).toContain('!MODE_SKELETON_OWNER[editorMode]')
    const types = read('features', 'engineContextTypes.ts')
    const table = types.slice(types.indexOf('MODE_SKELETON_OWNER'), types.indexOf('};', types.indexOf('MODE_SKELETON_OWNER')))
    for (const mode of ['stateMachine', 'animation', 'animationField', 'rig'])
      expect(table).toContain(`${mode}: true`)
  })
})

// Root motion and the in-place bake are opposite answers to one question. Two independent toggles could
// express states that mean nothing — drive the character from travel that has been baked out of the
// curves — and neither of the old surfaces could show the other half of the decision.
describe('root motion has exactly one place to set it', () => {
  it('the asset picker no longer toggles it', () => {
    const picker = read('features', 'animation', 'AnimationAssetPicker.tsx')
    expect(picker).not.toContain('rootMotion: on')
    expect(picker).not.toContain('rootMotionToggle')
  })

  it('the state machine clips panel no longer toggles it', () => {
    const sm = read('features', 'animation', 'StateMachineEditor.tsx')
    expect(sm).not.toContain('toggleClipRootMotion')
    expect(sm).not.toContain('rootMotionOf')
  })

  it('and the plumbing behind them is gone rather than left dangling', () => {
    expect(read('features', 'animation', 'StateMachineContext.tsx')).not.toContain('toggleClipRootMotion')
    expect(read('features', 'EngineContext.tsx')).not.toContain('setClipRootMotion')
  })

  it('the clip editor presents it as one three-way choice', () => {
    const inspector = read('features', 'clip', 'ClipInspector.tsx')
    expect(inspector).toContain("rootMode")
    // All three answers, and the fact that picking one clears the other.
    for (const mode of ['mesh', 'character', 'inPlace']) expect(inspector).toContain(`'${mode}'`)
    expect(inspector).toContain("filter(e => e.kind !== 'inPlace')")
  })
})

// The clip session edits a library asset, not an engine Scene, so `HistoryContext`'s recorder — which
// diffs Scene subtrees against a baseline captured on SELECT_NODE — sees nothing it can record. Undo here
// is hand-built, and these pin the three ways that goes wrong quietly.
describe('undo in the clip session', () => {
  const ctx = () => read('features', 'clip', 'ClipContext.tsx')

  it('every mutator goes through one commit that records', () => {
    const s = ctx()
    expect(s).toContain('useHistory')
    expect(s).toMatch(/const commit = useCallback\(\([\s\S]{0,400}push\(\{ label, coalesceKey, undo/)
  })

  it('mutators read a ref, not a functional setState', () => {
    // A side effect inside a state updater runs TWICE under StrictMode, which would put two entries on the
    // stack for one edit — and the second would restore to a state that was never on screen.
    const s = ctx()
    const body = s.slice(s.indexOf('const patchClip'))
    expect(body).toContain('assetRef.current')
    expect(s).not.toMatch(/setAsset\(prev =>/)
  })

  it('undo itself does NOT record', () => {
    // `restore` is what undo and redo call; if it pushed, undoing would push a redo of the undo and the
    // stack would never drain.
    const s = ctx()
    const restore = s.slice(s.indexOf('const restore = useCallback'), s.indexOf('const commit = useCallback'))
    expect(restore).not.toContain('push(')
  })

  it('a key drag is ONE step, not one per frame', () => {
    const t = read('features', 'clip', 'ClipTimeline.tsx')
    expect(t).toContain("beginBatch('Move key')")
    expect(t).toContain('endBatch()')
  })

  it('the live preview is debounced for content edits and immediate for structural ones', () => {
    // `applyPreviewClips` re-runs the edit stack, the retarget and a re-bind. A key drag replaces the
    // asset every pointer move, so doing that synchronously is O(bones x keys) sixty times a second.
    const t = read('features', 'clip', 'ClipTimeline.tsx')
    expect(t).toContain('lastStructuralRef')
    expect(t).toMatch(/setTimeout\(apply, \d+\)/)
  })
})

// The transform gizmo works on a scene NODE; a bone is not one. Rather than fork it, a proxy node is
// parked on the selected joint and the drag is converted back into the bone's local transform.
describe('posing a bone with the gizmo', () => {
  const g = () => read('features', 'clip', 'BoneGizmo.tsx')

  it('is mounted in clip mode, and the scene gizmo is not', () => {
    const v = read('features', 'EngineViewport.tsx')
    expect(v).toContain('<BoneGizmo viewportRef={viewportRef} />')
    // `showGizmo` stands down in clip mode, or two gizmos would fight over the same pointer.
    expect(v).toContain("editorMode !== 'stateMachine' && editorMode !== 'animation'")
  })

  it('reuses TransformGizmo rather than forking it', () => {
    expect(g()).toContain('<TransformGizmo')
  })

  it('walks the non-joint pivot chain when converting back to bone-local', () => {
    // Skipping `parentChain` lands the pose in the wrong frame on assimp-converted FBX rigs — which are
    // exactly the ones where it is hardest to see what went wrong.
    const s = g()
    expect(s).toContain('topo.parentChain[jointIndex]')
    expect(s).toContain('boneLocalTransform(nodeIndex)')  // the LIVE pivot local, not its rest
  })

  it('stops syncing the proxy while a drag is in flight', () => {
    // Otherwise the sync loop rewrites the proxy every frame and fights the pointer.
    expect(g()).toContain('!draggingRef.current')
  })

  it('does not let a move or rotate drag change the bone’s scale', () => {
    // The proxy carries whatever scale the joint's world matrix had; round-tripping it through every drag
    // would drift the bone's size with nothing touching scale.
    expect(g()).toMatch(/patch\.kind === 'scale'\s*\n?\s*\?/)
  })
})

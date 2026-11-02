import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

// Adding an editor mode means touching about fifteen files, and only four of them are compile errors if
// missed. The rest fail silently and in ways that look like something else: a panel that exists in no
// tree, a tab that restores into an empty viewport, a bottom strip that opens on the Logger.
//
// These read source text rather than importing, for the reason editorModeReachability.test.ts gives:
// EngineContext pulls in the whole engine.
//
// The mode is the CLIP PLAYER now: clips are authored in Cleo Creator, and the editor plays them and places
// their events. It kept the `animation` tab kind, so TabKind === EditorMode === AssetKind still holds.

const SRC = join(__dirname, '..', 'src')
const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf-8').replace(/\r\n/g, '\n')

const DOCK = () => read('features', 'layout', 'DockLayout.tsx')
const PANELS = () => read('features', 'layout', 'panels.tsx')

describe('the Clip Player mode is fully wired', () => {
  it('its panels are declared, registered, built and revealed', () => {
    const dock = DOCK()
    // Declared as a group...
    expect(dock).toMatch(/const CLIP_PANELS = \[[^\]]*'clipInspector'[^\]]*'clipTimeline'[^\]]*\]/)
    // ...hidden everywhere but its own mode. Without this line the panels leak into every other mode,
    // because `hiddenPanelIds`'s switch has no default.
    expect(dock).toContain("if (mode !== 'animation') for (const id of CLIP_PANELS) hidden.add(id)")
    // ...added to the default tree. A panel absent here exists in no layout at all.
    expect(dock).toMatch(/'clipInspector', \.\.\.TILEMAP_PANELS/)
    expect(dock).toContain("id: 'clipTimeline', component: 'clipTimeline'")
    // ...and resolvable to a component. An id with no entry here renders nothing, with no error.
    expect(PANELS()).toMatch(/clipInspector: ClipInspectorPanel/)
    expect(PANELS()).toMatch(/clipTimeline: ClipTimelinePanel/)
    // The per-bone key tracks are gone, and so is the panel id named after them.
    expect(dock).not.toContain("'clipTracks'")
    expect(PANELS()).not.toContain('clipTracks')
  })

  it('the timeline is renderer:always, because its rAF loop poses the character', () => {
    // dockview unmounts an unselected panel by default. The timeline is the only thing ticking the
    // animator in this mode, so looking at the Logger would freeze the model mid-clip.
    expect(DOCK()).toMatch(/assertRenderers[\s\S]{0,400}'clipTimeline'/)
  })

  it('the bottom strip opens on the timeline rather than whatever was last used', () => {
    expect(DOCK()).toContain("editorMode === 'animation' ? 'clipTimeline'")
  })

  it('the layout version was bumped for the renamed panel, and the old key retired', () => {
    // A stored v20 tree names `clipTracks`, which no longer exists. Leaving the version alone would
    // restore an arrangement with a hole in it rather than rebuilding.
    const dock = DOCK()
    expect(dock).toMatch(/const LAYOUT_VERSION = (2[1-9]|[3-9]\d)/)
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
    const ctx = read('features', 'EngineContext.tsx')
    const remove = ctx.slice(ctx.indexOf('const removeAnimation = '), ctx.indexOf('const removeAnimation = ') + 700)
    expect(remove).toContain("t.kind === 'animation' && t.animationId === id")
    expect(remove).toContain('removeTabById')
  })

  it('a clip tab has nothing to save: its edits are written as they are made', () => {
    const saving = read('features', 'hooks', 'useSaving.ts')
    expect(saving).not.toContain('registerClipApply')
    expect(saving).not.toContain('clipApplyRef')
    expect(saving).toContain("case 'animation': break;")
    // ORDER is exhaustive over TabKind, so the kind keeps a tier.
    expect(saving).toMatch(/animation: 0/)
    for (const gone of ['saveClipAs', 'saveClip:', 'registerClipApply'])
      expect(read('features', 'EngineContext.tsx')).not.toContain(gone)
  })
})

// The old `animation` mode was the per-node STATE MACHINE editor. It kept its behaviour and gave up its
// name, so that the clip tab's kind could match its AssetKind and need no special cases anywhere.
describe('the state machine mode kept its behaviour under its new name', () => {
  it('nothing still gates on the old spelling', () => {
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
    expect(read('features', 'DebugSkeletonOverlay.tsx')).toContain('!MODE_SKELETON_OWNER[editorMode]')
    const types = read('features', 'engineContextTypes.ts')
    const table = types.slice(types.indexOf('MODE_SKELETON_OWNER'), types.indexOf('};', types.indexOf('MODE_SKELETON_OWNER')))
    for (const mode of ['stateMachine', 'animation', 'animationField', 'rig'])
      expect(table).toContain(`${mode}: true`)
  })
})

describe('root motion has exactly one place to set it', () => {
  it('the asset picker and the animator clips panel no longer toggle it', () => {
    const picker = read('features', 'animation', 'AnimationAssetPicker.tsx')
    expect(picker).not.toContain('rootMotion: on')
    expect(picker).not.toContain('rootMotionToggle')
    const sm = read('features', 'animation', 'StateMachineEditor.tsx')
    expect(sm).not.toContain('toggleClipRootMotion')
    expect(sm).not.toContain('rootMotionOf')
    expect(read('features', 'animation', 'StateMachineContext.tsx')).not.toContain('toggleClipRootMotion')
    expect(read('features', 'EngineContext.tsx')).not.toContain('setClipRootMotion')
  })

  it('the Clip Player offers it as a two-way choice — baking in place was a clip edit, and those are gone', () => {
    const inspector = read('features', 'clip', 'ClipInspector.tsx')
    expect(inspector).toContain('rootMode')
    for (const mode of ['mesh', 'character']) expect(inspector).toContain(`value: '${mode}'`)
    expect(inspector).not.toContain("value: 'inPlace'")
    // A legacy In place edit still strips the travel when the clip resolves, so the choice is locked while
    // one is on the stack rather than silently doing nothing.
    expect(inspector).toContain('bakedInPlace')
  })
})

// The editor no longer authors motion: keys, bone posing, the edit stack and Save As went to Cleo Creator.
describe('the clip editor became a player', () => {
  it('the authoring files are gone', () => {
    for (const gone of [
      ['features', 'clip', 'BonePose.tsx'], ['features', 'clip', 'BoneGizmo.tsx'], ['features', 'clip', 'boneTrs.ts'],
      ['utils', 'clipTracks.ts'],
    ]) expect(existsSync(join(SRC, ...gone)), gone.join('/')).toBe(false)
    // The pose preview's one helper moved to the Skeleton part that still uses it.
    expect(existsSync(join(SRC, 'features', 'rig', 'boneTrs.ts'))).toBe(true)
  })

  it('no bone gizmo is mounted, and the scene gizmo stays off in the mode', () => {
    const v = read('features', 'EngineViewport.tsx')
    expect(v).not.toContain('BoneGizmo')
    expect(v).toContain("editorMode !== 'stateMachine' && editorMode !== 'animation'")
  })

  it('the inspector has no edit stack, no batch apply and no Save As', () => {
    const inspector = read('features', 'clip', 'ClipInspector.tsx')
    for (const gone of ['+ Mirror', '+ Retime', 'Apply an edit to other clips', 'Save As', 'BonePose'])
      expect(inspector).not.toContain(gone)
  })

  it('legacy edit stacks keep resolving, and the player offers a way to drop them', () => {
    const inspector = read('features', 'clip', 'ClipInspector.tsx')
    expect(inspector).toMatch(/legacy edit/)
    expect(inspector).toContain("{ edits: undefined }")
    // The engine-side edit stack is untouched: both resolve sites still run it.
    expect(read('utils', 'animationResolve.ts')).toContain('applyClipEdits(')
    expect(read('player', 'animations.ts')).toContain('applyClipEdits(')
  })

  it('the session has no working copy: the asset is the library record', () => {
    const ctx = read('features', 'clip', 'ClipContext.tsx')
    expect(ctx).toContain('animations.find(a => a.id === editingAnimationId)')
    for (const gone of ['assetRef', 'saveAs', 'patchClip', 'setEdits']) expect(ctx).not.toContain(gone)
  })

  it('the preview re-binds for a change to the motion, never for an events write', () => {
    // An events write replaces the asset object. Re-binding for it would stop playback for a change that
    // moves no bone.
    const t = read('features', 'clip', 'ClipTimeline.tsx')
    const parts = t.slice(t.indexOf('function poseParts'), t.indexOf('const sameParts'))
    expect(parts).toContain('c.samplers')
    expect(parts).not.toContain('events')
  })
})

// Events belong to the CLIP: one track, one hook, written to the `.anim`.
describe('events are authored on the clip, in one place', () => {
  it('one Events track serves the Clip Player and the Animator / Skeleton transport', () => {
    expect(read('features', 'clip', 'ClipTimeline.tsx')).toContain('<ClipEventsTrack')
    expect(read('features', 'animation', 'AnimationPlayer.tsx')).toContain('<ClipEventsTrack')
  })

  it('writes go to the library asset with an undo entry, and a drag is one write', () => {
    const hook = read('features', 'animation', 'useClipEvents.ts')
    expect(hook).toContain('editSharedClip(assetId, clipName, patch)')
    expect(hook).toMatch(/push\(\{[\s\S]{0,200}undo: \(\) => editSharedClip\(assetId, clipName, before\)/)
    // The marker follows the pointer locally; the asset is written once, on release.
    const track = read('features', 'animation', 'ClipEventsTrack.tsx')
    expect(track).toMatch(/const up = \(\) => \{[\s\S]{0,300}if \(moved\) move\(index, at\)/)
  })

  it('several clips of one asset can be written in one tick', () => {
    // The animator's events moving onto its clips writes them back to back; each write must build on the last.
    const ctx = read('features', 'EngineContext.tsx')
    const fn = ctx.slice(ctx.indexOf('const editSharedClip = '), ctx.indexOf('const editSharedClip = ') + 1400)
    expect(fn).toContain('animationsRef.current = animationsRef.current.map(')
  })

  it('the animator no longer authors its own markers, and moves old ones onto the clips when opened', () => {
    const smc = read('features', 'animation', 'StateMachineContext.tsx')
    for (const gone of ['addEvent', 'setEvent', 'removeEvent']) expect(smc).not.toContain(gone)
    expect(smc).toContain('liftMachineEvents(')
    expect(read('features', 'animation', 'StateMachineEditor.tsx')).not.toContain("title='Events'")
    expect(read('features', 'animation', 'AnimationPlayer.tsx')).not.toContain('addEvent(')
  })
})

describe('the Animate wizard is gone', () => {
  it('nothing builds or opens it', () => {
    expect(existsSync(join(SRC, 'features', 'characterAnimation', 'AnimateCharacterWizard.tsx'))).toBe(false)
    expect(existsSync(join(SRC, 'utils', 'animatorTemplates.ts'))).toBe(false)
    expect(read('features', 'nodeInspector', 'propertyEditors', 'AnimationSlot.tsx')).not.toContain('Wizard')
    expect(read('features', 'EngineContext.tsx')).not.toContain('animateCharacter')
    expect(read('features', 'EditorSessionsContext.tsx')).not.toContain('animateCharacter')
  })
})

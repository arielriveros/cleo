import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useCleoEngine } from '../EngineContext'
import { useAssetLibrary } from '../AssetLibraryContext'
import { useDocument } from '../DocumentContext'
import { useHistory } from '../HistoryContext'
import type { AnimationAsset, StoredClip, StoredClipEdit } from '../../utils/animationAssets'

// The clip authoring session: the working copy of the `.anim` asset open in the active tab.
//
// Shaped like RigContext — an immutable working copy in React state, pushed to the library only on save.
// Routing every edit through `updateAnimation` instead would invalidate the retarget cache and re-resolve
// every clip on every character built on the rig, on every keystroke; and `usePersistedLibrary` would
// rewrite the WHOLE `.anim` array (keyframes and all) to IndexedDB on a 400ms debounce while doing it.
// That cost is exactly what forced `usePersistedModelLibrary` to exist.
//
// The SELECTED CLIP lives here too, and is deliberately not part of the document: a `.anim` holds several
// clips and the tab addresses the asset, so which one is on screen is a view concern.
//
// UNDO is hand-built here rather than recorded. `HistoryContext` records by diffing engine `Scene`
// subtrees against a baseline captured on SELECT_NODE, and this session edits neither — its document is a
// library asset. Every entry below therefore just captures the working copy before and after.
//
// That is cheap only because nothing here mutates: `withKey` and friends replace one sampler and share the
// rest, so holding the previous asset is a reference plus the one array that changed, not a copy of the
// clip. A session that mutated in place would have to deep-copy megabytes of keyframes per keystroke.

type ClipContextValue = {
  /** The asset being edited, or null when no clip tab is active. */
  asset: AnimationAsset | null
  /** The clip currently on screen, or null when the asset has none. */
  clip: StoredClip | null
  clipName: string | null
  selectClip: (name: string) => void
  /** Replace the working copy wholesale. Marks the tab dirty. */
  patch: (next: AnimationAsset) => void
  /** Replace one clip by name, leaving the others alone. Marks the tab dirty. */
  patchClip: (name: string, next: StoredClip, label?: string) => void
  /** Replace the selected clip's edit stack. */
  setEdits: (edits: StoredClipEdit[]) => void
  /** Append one edit to a set of clips at once — the cross-clip gesture. */
  addEditToClips: (names: string[], edit: StoredClipEdit) => void
  save: () => void
  saveAs: (name: string) => void
  dirty: boolean
}

const ClipContext = createContext<ClipContextValue | null>(null)

export function useClip(): ClipContextValue {
  const ctx = useContext(ClipContext)
  if (!ctx) throw new Error('useClip must be used within a ClipProvider')
  return ctx
}

export function ClipProvider({ children }: { children: React.ReactNode }) {
  const { editingAnimationId, saveClip, saveClipAs, registerClipApply, activeTab } = useCleoEngine()
  const { animations } = useAssetLibrary()
  const { markTabDirty, dirtyTabs } = useDocument()

  const { push } = useHistory()

  const [asset, setAsset] = useState<AnimationAsset | null>(null)
  const [clipName, setClipName] = useState<string | null>(null)
  const loadedIdRef = useRef<string | null>(null)

  /**
   * The working copy as of right now, for the mutators below.
   *
   * They read this instead of taking a functional `setAsset` updater because each one also pushes an undo
   * entry, and a side effect inside a state updater runs twice under StrictMode — which would put two
   * entries on the stack for one edit. Written eagerly on every commit as well as on render, so a burst of
   * edits in a single tick chains off each other rather than all forking from the same base.
   */
  const assetRef = useRef<AnimationAsset | null>(null)
  assetRef.current = asset

  // Adopt the tab's asset when it CHANGES. Guarded on the id rather than the library array, so a save —
  // which rewrites the library — does not throw away the working copy that produced it. Save As changes
  // the id, so the session correctly re-adopts the new asset.
  useEffect(() => {
    if (!editingAnimationId) { loadedIdRef.current = null; assetRef.current = null; setAsset(null); setClipName(null); return }
    if (loadedIdRef.current === editingAnimationId) return
    const found = animations.find(a => a.id === editingAnimationId)
    if (!found) return
    loadedIdRef.current = editingAnimationId
    // Deep copy: the working copy must be detached from the library record it came from.
    const copy: AnimationAsset = JSON.parse(JSON.stringify(found))
    assetRef.current = copy
    setAsset(copy)
    setClipName(prev => (prev && copy.clips.some(c => c.name === prev) ? prev : copy.clips[0]?.name ?? null))
  }, [editingAnimationId, animations])

  const tabId = activeTab.kind === 'animation' ? activeTab.id : null

  // The selected clip, re-resolved by NAME rather than held by reference: every mutator below replaces the
  // clip object, so a captured reference would go stale on the first edit.
  const clip = useMemo(
    () => (asset && clipName ? asset.clips.find(c => c.name === clipName) ?? null : null),
    [asset, clipName],
  )

  /** Adopt a working copy without recording it — used by undo and redo themselves. */
  const restore = useCallback((next: AnimationAsset, label: string) => {
    assetRef.current = next
    setAsset(next)
    if (tabId) markTabDirty(tabId, label)
  }, [tabId, markTabDirty])

  /**
   * Adopt a new working copy and put it on the undo stack.
   *
   * `coalesceKey` merges entries pushed within the manager's window under the same key, so dragging a key
   * across the timeline or holding an arrow key on a number field is ONE undo step rather than sixty. Pass
   * a key specific enough that two different gestures cannot merge — the bone and track being edited, not
   * just the verb.
   */
  const commit = useCallback((next: AnimationAsset, label: string, coalesceKey?: string) => {
    const before = assetRef.current
    if (!before || next === before) return
    restore(next, label)
    push({ label, coalesceKey, undo: () => restore(before, label), redo: () => restore(next, label) })
  }, [restore, push])

  const patch = useCallback((next: AnimationAsset) => commit(next, 'Edit animation'), [commit])

  const patchClip = useCallback((name: string, next: StoredClip, label = 'Edit clip') => {
    const prev = assetRef.current
    if (!prev) return
    const clips = prev.clips.map(c => (c.name === name ? next : c))
    if (clips.every((c, i) => c === prev.clips[i])) return
    commit({ ...prev, clips }, label, `${label}:${name}`)
  }, [commit])

  const setEdits = useCallback((edits: StoredClipEdit[]) => {
    const prev = assetRef.current
    if (!prev || !clipName) return
    commit({ ...prev, clips: prev.clips.map(c => (c.name === clipName ? { ...c, edits } : c)) }, 'Clip edits')
  }, [clipName, commit])

  /**
   * Append one edit to several clips in a single step — "mirror all of these", "give all of these the
   * torch grip". The reason the edit stack exists rather than a destructive batch operation: this is
   * reversible, and re-editing the shared pose it names updates every clip that references it.
   */
  const addEditToClips = useCallback((names: string[], edit: StoredClipEdit) => {
    const prev = assetRef.current
    if (!names.length || !prev) return
    const wanted = new Set(names)
    // One entry for the whole batch: undoing "apply the torch grip to thirty clips" clip by clip would be
    // thirty presses, and the user made one decision.
    commit({ ...prev, clips: prev.clips.map(c => (wanted.has(c.name) ? { ...c, edits: [...(c.edits ?? []), edit] } : c)) },
      'Apply edit to clips')
  }, [commit])

  const save = useCallback(() => { if (asset) saveClip(asset) }, [asset, saveClip])

  const saveAs = useCallback((name: string) => {
    if (!asset) return
    // Clear the adoption guard FIRST: Save As mints a new id and re-points the tab at it, and the effect
    // above must be free to adopt that asset rather than skipping it as already loaded.
    loadedIdRef.current = null
    saveClipAs(asset, name)
  }, [asset, saveClipAs])

  // Register with the save orchestrator, so Ctrl+S and Save All reach this session.
  useEffect(() => {
    if (!tabId) return
    registerClipApply({ tabId, apply: save })
    return () => registerClipApply(null)
  }, [tabId, save, registerClipApply])

  const value = useMemo<ClipContextValue>(
    () => ({
      asset, clip, clipName, selectClip: setClipName, patch, patchClip, setEdits, addEditToClips,
      save, saveAs, dirty: !!(tabId && dirtyTabs[tabId]),
    }),
    [asset, clip, clipName, patch, patchClip, setEdits, addEditToClips, save, saveAs, tabId, dirtyTabs],
  )

  return <ClipContext.Provider value={value}>{children}</ClipContext.Provider>
}

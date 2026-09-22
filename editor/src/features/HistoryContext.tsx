import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { HistoryManager, Node, Scene, parseNodeJson } from 'cleo'
import type { HistoryEntry, SceneChange } from 'cleo'
import { useCleoEngine } from './EngineContext'
import { sameSnapshot, shareBuffers } from '../utils/snapshotDiff'
import { isEditorOwnedChange } from '../utils/editorOwned'
import { canSnapshot, structureEntry } from '../utils/historyRecording'

// Undo/redo for the editor. One HistoryManager PER TAB, not one shared stack: each asset tab owns its own
// throwaway Scene, and a single stack would undo a material edit into the scene tab's graph.
//
// Recording is a hybrid: `structure` events (add/remove/reparent/spawn/despawn) get an exact inverse
// holding the detached subtree; everything else is a subtree snapshot diffed across an interaction. The
// snapshot's "before" image comes from a baseline captured when a node is SELECTED — every inspector edit
// is preceded by selecting the node it edits. The baseline is refreshed when an interaction closes.
//
// Editor-owned nodes never reach the stack. That covers the free-fly camera, gizmo handles, helper icons and
// wireframes, brush cursors and preview props (see Node.isEditorOwned). Their events are rejected on sight,
// and Node.serialize leaves them out of every snapshot. The second half matters: a restore re-parses the
// snapshot, and a helper inside it came back as a plain node with none of its editor flags. It is not
// needed either, because the helper reconciler rebuilds the right helpers from the restore's structure event.

/** How long an interaction stays open after its last change before it becomes one undo step. */
const INTERACTION_IDLE_MS = 450

type HistoryContextValue = {
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | null
  redoLabel: string | null
  undo: () => void
  redo: () => void
  /** Push a hand-built entry onto the active tab's stack (tilemap strokes use this). */
  push: (entry: Omit<HistoryEntry, 'time'>) => void
  /** Group everything pushed until endBatch into one step. Re-entrant. */
  beginBatch: (label: string) => void
  endBatch: () => void
  /** Run a block with recording off — nothing inside it becomes an undo step. */
  silently: <T>(fn: () => T) => T
}

const HistoryContext = createContext<HistoryContextValue | null>(null)

export function useHistory(): HistoryContextValue {
  const ctx = useContext(HistoryContext)
  if (!ctx) throw new Error('useHistory must be used within a HistoryProvider')
  return ctx
}

/** Human label per change kind, for the Undo button's tooltip. */
const KIND_LABEL: Record<string, string> = {
  transform: 'Transform', name: 'Rename', visibility: 'Visibility', variable: 'Variable',
  physics: 'Physics', script: 'Script', material: 'Material', texture: 'Texture',
  light: 'Light', camera: 'Camera', environment: 'Environment', component: 'Component',
}

export function HistoryProvider({ children }: { children: React.ReactNode }) {
  const {
    eventEmitter, editorScene, activeTabId, isPlayMode, isDirtySuppressed, selectedNode,
  } = useCleoEngine()

  const managersRef = useRef(new Map<string, HistoryManager>())
  const [, force] = useState(0)
  const rerender = useCallback(() => force(x => x + 1), [])

  const managerFor = useCallback((tabId: string): HistoryManager => {
    let m = managersRef.current.get(tabId)
    if (!m) {
      m = new HistoryManager({ limit: 200, coalesceMs: 400 })
      m.onChange(rerender)
      managersRef.current.set(tabId, m)
    }
    return m
  }, [rerender])

  const active = managerFor(activeTabId)

  // --- baselines -------------------------------------------------------------------------------

  // nodeId -> its serialized subtree as of the last committed state. See the header for why this is
  // captured on selection rather than on the change itself.
  const baselineRef = useRef(new Map<string, any>())
  const sceneRef = useRef<Scene>(editorScene)
  sceneRef.current = editorScene

  /**
   * A node's subtree, with every buffer that has not changed since `against` replaced by that snapshot's
   * own array object.
   *
   * `serialize()` COPIES each vertex buffer, so without the sharing pass a history over a model holds one
   * copy of the mesh per entry — 200 entries deep, 200 meshes. It also makes the comparison below hit an
   * identity check instead of walking millions of floats.
   */
  const snapshot = useCallback(async (node: Node, against?: any): Promise<any | null> => {
    try {
      const json = await node.serialize()
      return against ? shareBuffers(json, against) : json
    } catch { return null }
  }, [])

  useEffect(() => {
    if (!selectedNode) return
    const node = sceneRef.current.getNodeById(selectedNode)
    if (!canSnapshot(node, sceneRef.current)) return
    let cancelled = false
    const previous = baselineRef.current.get(node.id)
    void snapshot(node, previous).then(json => { if (!cancelled && json) baselineRef.current.set(node.id, json) })
    return () => { cancelled = true }
  }, [selectedNode, snapshot, activeTabId])

  /** Rebuild a node's subtree from a snapshot, in place and keeping its position among its siblings. */
  // Read by restore(), which is created once.
  const selectedRef = useRef<string | null>(selectedNode)
  selectedRef.current = selectedNode

  const restore = useCallback((json: any) => {
    const scene = sceneRef.current
    const existing = scene.getNodeById(json.id)
    // Nothing to rebuild in place. Parsing it in under the root instead would put a node that is no longer
    // here back into the document: a step recorded against a document this tab has since replaced.
    if (!existing?.parent) return
    // Never the root, tested by identity. A loaded scene's root still has a parent, the wrapper Scene.parse
    // built it under, and restoring it would detach the live tree from the scene. canSnapshot never
    // baselines a root, so this only guards a stale entry.
    if (existing === scene.root) return
    const parent = existing.parent
    const index = parent.children.indexOf(existing)
    // The snapshot holds no editor-owned children (Node.serialize leaves them out), so the live helpers go
    // with the old subtree. The structure event below schedules the helper reconciler, which gives the rebuilt
    // node fresh helpers.
    parent.removeChild(existing, true)
    parseNodeJson(parent, json)
    // parseNodeJson always appends, so put it back where it was — an undo that also reshuffles the scene
    // tree is worse than no undo at all.
    const rebuilt = scene.getNodeById(json.id)
    if (rebuilt && index >= 0) parent.moveChildTo(rebuilt, index)
    // The node now IS this snapshot. Without this, the next edit's "before" is still whatever the last closed
    // interaction left, often the state just undone, so an undo after it would jump back to that state.
    baselineRef.current.set(json.id, json)
    eventEmitter.emit('SCENE_CHANGED', { kind: 'structure' })
    // The panels still hold the object the parse replaced. Re-select through null, on a later task, so they
    // rebind to the rebuilt one: an edit to the detached original would never be saved. Same move as
    // NodeInfo's reselectAfterConvert.
    const sel = selectedRef.current
    const holds = (n: Node): boolean => n.id === sel || n.children.some(holds)
    if (sel && rebuilt && holds(rebuilt)) {
      eventEmitter.emit('SELECT_NODE', null)
      window.setTimeout(() => eventEmitter.emit('SELECT_NODE', sel), 0)
    }
  }, [eventEmitter])

  // --- the recorder ----------------------------------------------------------------------------

  // The interaction currently being collected into one snapshot step, and the timer that closes it.
  const openRef = useRef<{ tabId: string; nodeId: string; before: any; kind: string } | null>(null)
  const timerRef = useRef<number | null>(null)

  const closeInteraction = useCallback(() => {
    if (timerRef.current !== null) { window.clearTimeout(timerRef.current); timerRef.current = null }
    const open = openRef.current
    openRef.current = null
    if (!open) return
    const node = sceneRef.current.getNodeById(open.nodeId)
    if (!node) return
    void snapshot(node, open.before).then(after => {
      if (!after) return
      baselineRef.current.set(open.nodeId, after)
      const before = open.before
      // Structural compare, never a stringify: a model node's subtree carries its vertex buffers, so
      // building the text of one costs minutes and eventually throws `RangeError: Invalid string length`.
      if (sameSnapshot(before, after)) return
      managerFor(open.tabId).push({
        label: KIND_LABEL[open.kind] ?? 'Edit',
        time: Date.now(),
        undo: () => restore(before),
        redo: () => restore(after),
      })
    })
  }, [managerFor, restore, snapshot])

  useEffect(() => {
    const onChange = (payload?: SceneChange) => {
      const manager = managerFor(activeTabId)
      // Play-mode churn (scripts spawning bullets) and the editor's own bookkeeping (thumbnail renders,
      // asset propagation) are not user edits. `withoutDirty` already brackets the latter.
      if (isPlayMode || isDirtySuppressed() || manager.suspended) return
      if (!payload || !payload.node) return
      // Checked BEFORE anything reaches manager.push, which clears the redo stack: a helper icon appearing
      // must not cost the user their redo branch either.
      if (isEditorOwnedChange(payload)) return
      const node = payload.node

      if (payload.kind === 'structure') {
        const entry = structureEntry(payload, sceneRef.current)
        if (entry) manager.push({ ...entry, time: Date.now() })
        return
      }

      // Everything else is snapshot-diffed across an interaction.
      const before = baselineRef.current.get(node.id)
      if (before === undefined) return // never selected, so there is nothing to diff against
      const open = openRef.current
      if (!open || open.nodeId !== node.id || open.tabId !== activeTabId) {
        closeInteraction()
        openRef.current = { tabId: activeTabId, nodeId: node.id, before, kind: payload.kind }
      }
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(closeInteraction, INTERACTION_IDLE_MS)
    }

    // A gizmo drag is explicitly bracketed rather than left to the idle timer: the drag has a real start
    // and end, and a mid-drag pause must not split it into two undo steps.
    const onDragEnd = () => closeInteraction()

    // A landscape brush stroke records its OWN undo step (a region diff of heights and masks), so it is
    // never snapshot-diffed here. What it must still do is move the node's BASELINE forward: otherwise the
    // next rename or move of the landscape diffs against the pre-stroke terrain, and undoing THAT would
    // also revert every stroke since.
    const onTerrainEdited = (nodeId: string) => {
      const node = sceneRef.current.getNodeById(nodeId)
      if (!node || !baselineRef.current.has(nodeId) || !canSnapshot(node, sceneRef.current)) return
      const previous = baselineRef.current.get(nodeId)
      void snapshot(node, previous).then(json => { if (json) baselineRef.current.set(nodeId, json) })
    }

    eventEmitter.on('SCENE_CHANGED', onChange)
    eventEmitter.on('GIZMO_DRAG_END', onDragEnd)
    eventEmitter.on('TERRAIN_EDITED', onTerrainEdited)
    return () => {
      eventEmitter.off('SCENE_CHANGED', onChange)
      eventEmitter.off('GIZMO_DRAG_END', onDragEnd)
      eventEmitter.off('TERRAIN_EDITED', onTerrainEdited)
    }
  }, [eventEmitter, activeTabId, isPlayMode, isDirtySuppressed, managerFor, closeInteraction])

  // A tab whose document was replaced wholesale starts a fresh stack. That is openScene in the scene tab, or
  // a reloaded asset tab: same tab id, new tree. Every entry and baseline refers to the tree thrown away, and
  // replaying one would act on it, or pull its nodes into the new document.
  useEffect(() => {
    const onReset = (tabId: string) => {
      if (openRef.current?.tabId === tabId) {
        if (timerRef.current !== null) { window.clearTimeout(timerRef.current); timerRef.current = null }
        openRef.current = null
      }
      // Keyed by node id, not by tab. Clearing them all only costs a re-baseline on the next selection.
      baselineRef.current.clear()
      managersRef.current.get(tabId)?.clear()
    }
    eventEmitter.on('HISTORY_RESET', onReset)
    return () => { eventEmitter.off('HISTORY_RESET', onReset) }
  }, [eventEmitter])

  // Drop a closed tab's stack. Its entries hold references to nodes in a scene that no longer exists.
  const { tabs } = useCleoEngine()
  useEffect(() => {
    const live = new Set(tabs.map(t => t.id))
    for (const id of [...managersRef.current.keys()]) if (!live.has(id)) managersRef.current.delete(id)
  }, [tabs])

  const value = useMemo<HistoryContextValue>(() => ({
    canUndo: active.canUndo,
    canRedo: active.canRedo,
    undoLabel: active.undoLabel,
    redoLabel: active.redoLabel,
    undo: () => { closeInteraction(); active.undo() },
    redo: () => { closeInteraction(); active.redo() },
    push: (entry) => active.push({ ...entry, time: Date.now() }),
    beginBatch: (label) => active.beginBatch(label),
    endBatch: () => active.endBatch(),
    silently: (fn) => active.silently(fn),
  }), [active, closeInteraction])

  return <HistoryContext.Provider value={value}>{children}</HistoryContext.Provider>
}

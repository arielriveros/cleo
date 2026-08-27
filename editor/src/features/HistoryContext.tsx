import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { HistoryManager, Node, Scene, parseNodeJson } from 'cleo'
import type { HistoryEntry, SceneChange, NodePlacement } from 'cleo'
import { useCleoEngine } from './EngineContext'

// Undo/redo for the editor. One HistoryManager PER TAB, not one shared stack: each asset tab owns its own
// throwaway Scene, and a single stack would undo a material edit into the scene tab's graph.
//
// Recording is a hybrid: `structure` events (add/remove/reparent/spawn/despawn) get an exact inverse
// holding the detached subtree; everything else is a subtree snapshot diffed across an interaction. The
// snapshot's "before" image comes from a baseline captured when a node is SELECTED — every inspector edit
// is preceded by selecting the node it edits. The baseline is refreshed when an interaction closes.

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

  const snapshot = useCallback(async (node: Node): Promise<any | null> => {
    try { return await node.serialize() } catch { return null }
  }, [])

  useEffect(() => {
    if (!selectedNode) return
    const node = sceneRef.current.getNodeById(selectedNode)
    if (!node) return
    let cancelled = false
    void snapshot(node).then(json => { if (!cancelled && json) baselineRef.current.set(node.id, json) })
    return () => { cancelled = true }
  }, [selectedNode, snapshot, activeTabId])

  /** Rebuild a node's subtree from a snapshot, in place and keeping its position among its siblings. */
  const restore = useCallback((json: any) => {
    const scene = sceneRef.current
    const existing = scene.getNodeById(json.id)
    const parent = existing?.parent ?? scene.root
    const index = parent.children.indexOf(existing as Node)
    if (existing) parent.removeChild(existing, true)
    parseNodeJson(parent, json)
    // parseNodeJson always appends, so put it back where it was — an undo that also reshuffles the scene
    // tree is worse than no undo at all.
    const rebuilt = scene.getNodeById(json.id)
    if (rebuilt && index >= 0) parent.moveChildTo(rebuilt, index)
    eventEmitter.emit('SCENE_CHANGED', { kind: 'structure' })
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
    void snapshot(node).then(after => {
      if (!after) return
      baselineRef.current.set(open.nodeId, after)
      const before = open.before
      if (JSON.stringify(before) === JSON.stringify(after)) return
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
      const node = payload.node

      if (payload.kind === 'structure') {
        // The detach half of a re-parent: the `reparent` event that follows describes the whole move, and
        // recording both would take two undos to reverse one drag.
        if (payload.prop === 'reparent-detach') return

        const prev = payload.prev as NodePlacement | null | undefined
        const next = payload.next as NodePlacement | null | undefined
        const scene = sceneRef.current
        const at = (p: NodePlacement | null | undefined): Node | null =>
          p ? (scene.getNodeById(p.parentId) ?? null) : null

        if (payload.prop === 'add' || payload.prop === 'reparent') {
          const fromParent = at(prev)
          const fromIndex = prev?.index ?? 0
          const toParent = at(next)
          const toIndex = next?.index ?? 0
          if (!toParent) return
          manager.push({
            label: payload.prop === 'add' ? `Add ${node.name}` : `Move ${node.name}`,
            time: Date.now(),
            // A strong reference to the node keeps the whole subtree — with its ids, scripts, bodies and
            // animator state — alive across the undo. The 200-entry cap is what bounds the memory.
            undo: () => {
              toParent.removeChild(node, !!fromParent)
              if (fromParent) fromParent.addChild(node, fromIndex)
            },
            redo: () => {
              if (fromParent) fromParent.removeChild(node, true)
              toParent.addChild(node, toIndex)
            },
          })
          return
        }
        if (payload.prop === 'remove') {
          const parent = at(prev)
          const index = prev?.index ?? 0
          if (!parent) return
          manager.push({
            label: `Delete ${node.name}`,
            time: Date.now(),
            undo: () => parent.addChild(node, index),
            redo: () => parent.removeChild(node),
          })
          return
        }
        if (payload.prop === 'spawn' || payload.prop === 'despawn') {
          const spawned = payload.prop === 'spawn'
          manager.push({
            label: spawned ? `Spawn ${node.name}` : `Despawn ${node.name}`,
            time: Date.now(),
            undo: () => (spawned ? node.despawn() : node.spawn()),
            redo: () => (spawned ? node.spawn() : node.despawn()),
          })
        }
        // 'sleep' is the engine applying spawnOnStart during a load, not a user edit.
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

    eventEmitter.on('SCENE_CHANGED', onChange)
    eventEmitter.on('GIZMO_DRAG_END', onDragEnd)
    return () => {
      eventEmitter.off('SCENE_CHANGED', onChange)
      eventEmitter.off('GIZMO_DRAG_END', onDragEnd)
    }
  }, [eventEmitter, activeTabId, isPlayMode, isDirtySuppressed, managerFor, closeInteraction])

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

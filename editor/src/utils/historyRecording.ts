import type { HistoryEntry, Node, NodePlacement, Scene, SceneChange } from 'cleo'
import { isEditorOwnedChange } from './editorOwned'

// The decisions HistoryContext's recorder makes about a SCENE_CHANGED event, kept free of React so they can be
// exercised headless. The recorder supplies the gates only it can know: play mode, `withoutDirty`, and an
// undo already in progress.

/**
 * The exact-inverse undo step for a `structure` change to `scene` — add, move, delete, spawn, despawn — or
 * `null` when the change is not the user's edit of that document.
 *
 * Rejected:
 * - Editor-owned nodes (the free-fly camera, gizmo handles, helper icons, brush cursors, preview props). The
 *   engine stamps ownership on the payload before a removal detaches the node, so a removal is judged correctly.
 * - Changes to any other scene. The bus is process-global, so every tab's scene, every thumbnail scene and
 *   the play scene reach this listener. The play scene deliberately reuses the editor's node ids, so resolving
 *   a parent by id alone would bind the step to the wrong tree.
 * - Changes inside a subtree that is still being built. Its nodes are in no scene yet, and the attach that
 *   finally brings the subtree in is recorded as one step.
 *
 * Every inverse resolves its node and parents by id when it runs, and checks that the tree is still where the
 * step left it before touching it. A step replayed against a tree that has moved on does nothing. It never
 * acts on whichever node now sits there, and it never re-attaches a node whose id is already in the scene.
 */
export function structureEntry(payload: SceneChange, scene: Scene): Omit<HistoryEntry, 'time'> | null {
  const node = payload.node
  if (payload.kind !== 'structure' || !node) return null
  if (isEditorOwnedChange(payload)) return null
  // The detach half of a re-parent: the `reparent` event that follows describes the whole move, and recording
  // both would take two undos to reverse one drag.
  if (payload.prop === 'reparent-detach') return null
  // Only the engine's structure events carry the scene. An editor-bus emit carries no scene, and no placement
  // to invert either.
  if (payload.scene !== scene) return null

  const prev = payload.prev as NodePlacement | null | undefined
  const next = payload.next as NodePlacement | null | undefined
  const find = (id: string | null | undefined): Node | null => (id ? scene.getNodeById(id) ?? null : null)

  // Every inverse resolves the node and its parents BY ID in `scene` when it runs, never through the objects
  // captured here. A snapshot undo, a type change or an asset re-instantiate rebuilds a node in place under
  // the same id, and leaves the captured object detached. Acting on that stale copy made "undo Add" do
  // nothing and "redo Add" put a second node with the same id into the scene. `live` is the object that
  // last stood for this id, and it is what a re-attach puts back.
  const id = node.id
  let live = node

  if (payload.prop === 'add' || payload.prop === 'reparent') {
    // The node's REAL parent, and only if this scene's tree resolves it to that same object. When a parse
    // attaches a loaded tree to its temporary holder, the holder is not in this scene's tree, so the parse is
    // not recorded.
    const toParent = node.parent
    if (!toParent || !next || find(next.parentId) !== toParent) return null
    const toId = toParent.id
    // Moved in from somewhere this scene cannot resolve (a subtree being built): undone as an add.
    const fromId = prev && find(prev.parentId) ? prev.parentId : null
    const fromIndex = prev?.index ?? 0
    const toIndex = next.index
    return {
      label: payload.prop === 'add' ? `Add ${node.name}` : `Move ${node.name}`,
      // A strong reference to the node keeps the whole subtree — with its ids, scripts, bodies and animator
      // state — alive across the undo. The 200-entry cap is what bounds the memory.
      undo: () => {
        const cur = find(id), to = find(toId)
        if (!cur || !to || cur.parent !== to) return
        const from = find(fromId)
        if (fromId && !from) return // the parent it came from is gone; there is nowhere to put it back
        live = cur
        to.removeChild(cur, !!from)
        if (from) from.addChild(cur, fromIndex)
      },
      redo: () => {
        const to = find(toId)
        if (!to) return
        if (fromId) {
          const cur = find(id), from = find(fromId)
          if (!cur || !from || cur.parent !== from) return
          live = cur
          from.removeChild(cur, true)
          to.addChild(cur, toIndex)
        } else if (!find(id)) {
          // Never while the id is still in the tree: that would be a second node with the same id.
          to.addChild(live, toIndex)
        }
      },
    }
  }

  if (payload.prop === 'remove') {
    const parentId = prev?.parentId
    if (!find(parentId)) return null
    const index = prev?.index ?? 0
    return {
      label: `Delete ${node.name}`,
      undo: () => {
        const parent = find(parentId)
        if (parent && !find(id)) parent.addChild(live, index)
      },
      redo: () => {
        const cur = find(id), parent = find(parentId)
        if (!cur || !parent || cur.parent !== parent) return
        live = cur
        parent.removeChild(cur)
      },
    }
  }

  if (payload.prop === 'spawn' || payload.prop === 'despawn') {
    const spawned = payload.prop === 'spawn'
    const toggle = (spawn: boolean) => { const cur = find(id); if (cur) (spawn ? cur.spawn() : cur.despawn()) }
    return {
      label: spawned ? `Spawn ${node.name}` : `Despawn ${node.name}`,
      undo: () => toggle(!spawned),
      redo: () => toggle(spawned),
    }
  }

  // 'sleep' is the engine applying spawnOnStart during a load, not a user edit.
  return null
}

/**
 * Whether a node may be given a snapshot baseline, and so have its property edits recorded as undo steps.
 *
 * Never an editor-owned node: it is not the user's work. A preview tab's holder is selected when the tab
 * opens, and baselining it would serialize the whole skinned preview character for nothing.
 *
 * Never the scene root, or any node without a parent. `restore()` rebuilds a node in place under its
 * parent, so a root has nowhere to go. The root is tested by IDENTITY: `Scene.parse` leaves a loaded scene's
 * root parented to the wrapper node it was parsed under, so a parent test alone lets it through. The root's own settings are recorded through payload-less events,
 * which carry nothing to snapshot anyway.
 *
 * Only a node of `scene`, the scene the tab is showing.
 */
export function canSnapshot(node: Node | null | undefined, scene: Scene): node is Node {
  return !!node && node !== scene.root && !!node.parent && node.scene === scene && !node.isEditorOwned
}

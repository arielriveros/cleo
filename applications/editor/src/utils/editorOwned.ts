import type { SceneChange } from 'cleo'

/**
 * Whether a SCENE_CHANGED payload is about an EDITOR-OWNED node — the free-fly camera, a gizmo handle, a
 * helper icon or wireframe, a brush cursor, a preview prop — rather than the user's content. Such a change
 * must never mark a tab unsaved and never become an undo step. See `Node.isEditorOwned` for what qualifies.
 *
 * An engine event carries the answer, computed when it was emitted. That is the only correct source for a
 * removal, which arrives after the node has left the ancestors its ownership came from. An event the editor
 * emits itself carries no stamp, so the node it names is asked instead. A payload with no node is never
 * owned: it is an inspector's "something changed", and it is how most panels mark the tab dirty.
 */
export function isEditorOwnedChange(e: SceneChange | null | undefined): boolean {
  if (!e) return false
  if (typeof e.editorOwned === 'boolean') return e.editorOwned
  return e.node?.isEditorOwned === true
}

import { useMemo } from 'react'
import { createDragDropManager } from 'dnd-core'
import { HTML5Backend } from 'react-dnd-html5-backend'

/**
 * A react-dnd manager whose HTML5 backend listens on `rootElement` instead of `window`.
 *
 * At its defaults react-dnd's HTML5 backend listens on `window` and force-sets
 * `dataTransfer.dropEffect = 'none'` on every dragover it does not own, killing every NATIVE HTML5 drop
 * in the editor for as long as a tree is mounted. Scoping the backend to the tree's container confines
 * that to the tree.
 *
 * A manager is passed rather than arborist's `dndRootElement` prop because react-dnd caches one manager
 * globally, keyed on nothing: the first tree to mount would fix the root element for every later tree.
 *
 * Returns null until the element exists; render the tree only once it does, or the backend is created
 * against `window`.
 */
export function useScopedDndManager(rootElement: HTMLElement | null) {
  return useMemo(
    () => (rootElement ? createDragDropManager(HTML5Backend, window, { rootElement }, false) : null),
    [rootElement],
  )
}

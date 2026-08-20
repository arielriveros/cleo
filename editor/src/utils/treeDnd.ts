import { useMemo } from 'react'
import { createDragDropManager } from 'dnd-core'
import { HTML5Backend } from 'react-dnd-html5-backend'

/**
 * A react-dnd manager whose HTML5 backend listens on `rootElement` instead of `window`.
 *
 * react-arborist drags through react-dnd. Left to its defaults, react-dnd's HTML5 backend installs
 * its top-level listeners on `window` AND force-sets `dataTransfer.dropEffect = 'none'` on every
 * dragover it does not own — which silently kills every *native* HTML5 drop in the editor (assets
 * into the viewport, nodes onto reference fields, tabs, ...) for as long as a tree is mounted.
 *
 * Scoping the backend to the tree's own container confines that to the tree, where the panel's own
 * capture-phase handlers deal with it (see SceneInspector). A manager is passed rather than
 * arborist's `dndRootElement` prop because react-dnd caches one manager *globally*, keyed on nothing:
 * the first tree to mount would fix the root element for every tree afterwards, including the one it
 * was swapped out for.
 *
 * Returns null until the element exists — render the tree only once it does, so the backend is never
 * created against `window` by accident.
 */
export function useScopedDndManager(rootElement: HTMLElement | null) {
  return useMemo(
    () => (rootElement ? createDragDropManager(HTML5Backend, window, { rootElement }, false) : null),
    [rootElement],
  )
}

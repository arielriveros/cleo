import { useEffect } from 'react'
import type { IApi } from '@svar-ui/react-filemanager'
import { dragPayload } from './assetKinds'
import { movablePaths, VfsEntry, VfsIndex } from '../../utils/vfs'

// HTML5 dragging layered onto SVAR's file-manager DOM, which has none of its own: drag OUT carrying the
// DataTransfer payloads every existing drop target already consumes, drag INTO a folder (ending in a
// normal `move-files` action), and the multi-selection coming along with the grabbed card.
// The coupling to SVAR's DOM is the class names below, `data-id`, and lib-dom's setID() prefixing ':'.

const CARD = '.wx-cards .wx-item[data-id]' // cards view, and each pane of the split view
const ROW = '.wx-row[data-id]'             // table view (rendered by @svar-ui/react-grid)
const TREE = 'li.wx-folder[data-id]'       // sidebar folder tree
const BACK = '.wx-back[data-id]'           // the ".." parent link
const DRAGGABLE = `${CARD}, ${ROW}`
const HIGHLIGHT = 'cleo-drop-target'

/** The path under the cursor. Multi-item drags carry MULTI_MIME as well: a JSON array of paths. */
const PATH_MIME = 'text/cleo-fm-path'
const MULTI_MIME = 'text/cleo-fm-paths'

/** setID() prefixes every DOM id with ':'. */
function readId(el: Element): string | null {
  const raw = el.getAttribute('data-id')
  if (!raw) return null
  return raw.startsWith(':') ? raw.slice(1) : raw
}

export function useDragOutPatch(
  wrapperRef: React.RefObject<HTMLElement>,
  vfsRef: React.MutableRefObject<VfsIndex>,
  pathIndexRef: React.MutableRefObject<Map<string, VfsEntry>>,
  apiRef: React.MutableRefObject<IApi | null>,
) {
  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return

    const isFolder = (path: string) => path === '/' || vfsRef.current.folders.includes(path)
    /** A path that maps to something real: an indexed asset, or a folder. */
    const isKnown = (path: string) => pathIndexRef.current.has(path) || isFolder(path)
    /** A data-id that maps to something real. The toolbar and the card container carry decoys ("body",
     *  "toggle-tree"), and the breadcrumbs reuse `.wx-item`. */
    const resolve = (el: Element): string | null => {
      if (el.closest('.wx-breadcrumbs')) return null
      const path = readId(el)
      if (!path) return null
      return isKnown(path) ? path : null
    }

    // --- 1. mark the items draggable ----------------------------------------------------------------
    const mark = () => {
      wrapper.querySelectorAll<HTMLElement>(DRAGGABLE).forEach(el => {
        const ok = !!resolve(el)
        if (ok && el.getAttribute('draggable') !== 'true') el.draggable = true
        // A card's <img> preview is natively draggable and would hijack the drag, handing the drop target
        // an image URL instead of the asset payload.
        el.querySelectorAll('img').forEach(img => { img.draggable = false })
      })
    }
    mark()
    // childList only: el.draggable reflects to the attribute, so observing attributes retriggers forever.
    const observer = new MutationObserver(mark)
    observer.observe(wrapper, { childList: true, subtree: true })

    // --- 2. what the current drag carries -----------------------------------------------------------
    /** Live only for the duration of one drag. dragover can't read the DataTransfer — the browser
     *  protects it until drop — so the sources are kept here to reject impossible targets up front. */
    let sources: string[] = []
    let ghost: HTMLElement | null = null

    /** The selection the grabbed path belongs to, or null when it isn't part of a multi-selection.
     *  Selection is per-panel in the split view; the active panel wins when both hold the same path. */
    const selectionHolding = (path: string): string[] | null => {
      const state = apiRef.current?.getState()
      const panels = state?.panels
      if (!panels?.length) return null
      const active = state?.activePanel ?? 0
      const ordered = [panels[active], ...panels.filter((_, i) => i !== active)]
      for (const panel of ordered) {
        const selected = panel?.selected
        if (!selected?.length || !selected.includes(path)) continue
        const known = selected.filter(isKnown)
        return known.length > 1 ? known : null
      }
      return null
    }

    /** Of `paths`, the ones that can actually land in `target`, in a shape SVAR's store won't choke on.
     *  The `getFile` pass is the store's own view: an id the FileTree doesn't hold would throw there. */
    const movableInto = (paths: string[], target: string): string[] =>
      movablePaths(paths, target, isKnown).filter(src => !!apiRef.current?.getFile(src))

    // --- 3. drag out --------------------------------------------------------------------------------
    const onDragStart = (e: DragEvent) => {
      const target = e.target as HTMLElement | null
      const el = target?.closest<HTMLElement>(DRAGGABLE)
      if (!el || !e.dataTransfer) return
      const path = resolve(el)
      if (!path) { e.preventDefault(); return }

      // Only the grabbed item gets an asset payload: every external drop target consumes exactly one.
      const entry = pathIndexRef.current.get(path)
      if (entry) for (const [mime, value] of dragPayload(entry.kind, entry.assetId)) e.dataTransfer.setData(mime, value)

      sources = selectionHolding(path) ?? [path]

      // The path drives the drop-into-a-folder below. Folders get only this — no asset payload.
      e.dataTransfer.setData(PATH_MIME, path)
      if (sources.length > 1) {
        e.dataTransfer.setData(MULTI_MIME, JSON.stringify(sources))
        // Purge first: 'dragend' never fires when the store re-renders the card out from under the drag.
        document.querySelectorAll('.cleo-drag-ghost').forEach(n => n.remove())
        ghost = document.createElement('div')
        ghost.className = 'cleo-drag-ghost'
        ghost.textContent = `${sources.length} items`
        document.body.appendChild(ghost)
        e.dataTransfer.setDragImage(ghost, 12, 12)
      }
      e.dataTransfer.effectAllowed = 'copyMove'
    }

    // --- 4. drop into a folder ----------------------------------------------------------------------
    let highlighted: HTMLElement | null = null
    const clearHighlight = () => {
      if (highlighted) highlighted.classList.remove(HIGHLIGHT)
      highlighted = null
    }

    const endDrag = () => {
      clearHighlight()
      sources = []
      ghost?.remove()
      ghost = null
    }

    /** The folder path an element represents as a drop target, or null. */
    const folderTargetOf = (target: HTMLElement | null): { el: HTMLElement; path: string } | null => {
      if (!target) return null

      const back = target.closest<HTMLElement>(BACK)
      if (back) {
        const path = currentPath()
        if (!path || path === '/') return null
        const parent = path.slice(0, path.lastIndexOf('/')) || '/'
        return { el: back, path: parent }
      }

      const el = target.closest<HTMLElement>(`${CARD}, ${ROW}, ${TREE}`)
      if (!el) return null
      const path = resolve(el)
      return path && isFolder(path) ? { el, path } : null
    }

    const currentPath = (): string | null => {
      const state = apiRef.current?.getState()
      if (!state?.panels) return null
      return state.panels[state.activePanel ?? 0]?.path ?? null
    }

    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes(PATH_MIME)) return
      const hit = folderTargetOf(e.target as HTMLElement)
      // Nothing in the drag can land there: no highlight and no preventDefault, so the drop is refused.
      if (!hit || (sources.length && !movableInto(sources, hit.path).length)) { clearHighlight(); return }

      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      if (highlighted !== hit.el) {
        clearHighlight()
        highlighted = hit.el
        hit.el.classList.add(HIGHLIGHT)
      }
    }

    const onDrop = (e: DragEvent) => {
      clearHighlight()
      const dt = e.dataTransfer
      if (!dt) return

      // The DataTransfer is authoritative, not `sources`: a drag can start in one explorer instance and
      // finish in another, and only the payload crosses that boundary.
      let dragged: string[] = []
      const multi = dt.getData(MULTI_MIME)
      if (multi) {
        try {
          const parsed = JSON.parse(multi)
          if (Array.isArray(parsed)) dragged = parsed.filter((p): p is string => typeof p === 'string')
        } catch { /* fall back to the single path below */ }
      }
      if (!dragged.length) {
        const one = dt.getData(PATH_MIME)
        if (one) dragged = [one]
      }
      if (!dragged.length) return

      const hit = folderTargetOf(e.target as HTMLElement)
      if (!hit) return

      // Dropping a folder onto itself or a descendant is rejected by the store, and an item already in
      // the target is a no-op; both are filtered out.
      const ids = movableInto(dragged, hit.path)
      if (!ids.length) return

      e.preventDefault()
      e.stopPropagation()
      apiRef.current?.exec('move-files', { ids, target: hit.path })
    }

    const onDragLeave = (e: DragEvent) => {
      if (!e.relatedTarget || !wrapper.contains(e.relatedTarget as Node)) clearHighlight()
    }

    wrapper.addEventListener('dragstart', onDragStart)
    wrapper.addEventListener('dragover', onDragOver)
    wrapper.addEventListener('drop', onDrop)
    wrapper.addEventListener('dragend', endDrag)
    wrapper.addEventListener('dragleave', onDragLeave)

    return () => {
      observer.disconnect()
      wrapper.removeEventListener('dragstart', onDragStart)
      wrapper.removeEventListener('dragover', onDragOver)
      wrapper.removeEventListener('drop', onDrop)
      wrapper.removeEventListener('dragend', endDrag)
      wrapper.removeEventListener('dragleave', onDragLeave)
      endDrag()
    }
  }, [wrapperRef, vfsRef, pathIndexRef, apiRef])
}

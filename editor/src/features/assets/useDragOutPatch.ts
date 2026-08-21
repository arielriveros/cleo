import { useEffect } from 'react'
import type { IApi } from '@svar-ui/react-filemanager'
import { dragPayload } from './assetKinds'
import { movablePaths, VfsEntry, VfsIndex } from '../../utils/vfs'

// SVAR's file manager has no drag-and-drop of any kind — its cards are plain divs and "move" is cut/paste
// only. The editor's whole asset workflow is drag-based (a mesh onto the viewport, a material onto a
// material slot), so we add HTML5 dragging on top of its DOM.
//
// Three things fall out of it:
//   1. drag OUT — each card/row carries the same DataTransfer payloads the old explorers set, so every
//      existing drop target (EngineViewport, MaterialSlot, TerrainLayerSlot, TextureInspector) keeps
//      working untouched.
//   2. drag INTO a folder — the move SVAR itself doesn't have. It ends in the normal `move-files` action,
//      so the event bridge handles it like any cut/paste.
//   3. the selection comes along — grabbing a card that is part of the current multi-selection drags the
//      whole selection, the way cut/paste and delete already treat it.
//
// The coupling to SVAR's DOM is deliberate and narrow: the class names below, plus `data-id`, plus
// lib-dom's setID() prefixing ids with ':'.

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
        // A card's <img> preview is natively draggable and would otherwise hijack the drag, handing the
        // drop target an image URL instead of our payload.
        el.querySelectorAll('img').forEach(img => { img.draggable = false })
      })
    }
    mark()
    // childList only: setting el.draggable reflects to the attribute, so observing attributes would make
    // the marker retrigger itself forever.
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

      // Only the grabbed item gets an asset payload: every external drop target (viewport, material slot)
      // consumes exactly one asset, and the item under the cursor is the unambiguous choice.
      const entry = pathIndexRef.current.get(path)
      if (entry) for (const [mime, value] of dragPayload(entry.kind, entry.assetId)) e.dataTransfer.setData(mime, value)

      sources = selectionHolding(path) ?? [path]

      // The path is what makes the drop-into-a-folder below possible. Folders get only this — they have
      // no asset payload.
      e.dataTransfer.setData(PATH_MIME, path)
      if (sources.length > 1) {
        e.dataTransfer.setData(MULTI_MIME, JSON.stringify(sources))
        // The default drag image is the one card under the cursor, which reads as a single-item move.
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
      // Nothing in the drag can land there: no highlight and no preventDefault, so the drop is refused
      // instead of quietly doing nothing.
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

      // Dropping a folder onto itself or its own descendant is rejected by the store, and an item already
      // in the target is a no-op — filter both out so a gesture the user obviously didn't mean doesn't
      // log an error.
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

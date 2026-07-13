import { useEffect } from 'react'
import type { IApi } from '@svar-ui/react-filemanager'
import { dragPayload } from './assetKinds'
import { VfsEntry, VfsIndex } from '../../utils/vfs'

// SVAR's file manager has no drag-and-drop of any kind — its cards are plain divs and "move" is cut/paste
// only. The editor's whole asset workflow is drag-based (a mesh onto the viewport, a material onto a
// material slot), so we add HTML5 dragging on top of its DOM.
//
// Two things fall out of it:
//   1. drag OUT — each card/row carries the same DataTransfer payloads the old explorers set, so every
//      existing drop target (EngineViewport, MaterialSlot, TerrainLayerSlot, TextureInspector) keeps
//      working untouched.
//   2. drag INTO a folder — the move SVAR itself doesn't have. It ends in the normal `move-files` action,
//      so the event bridge handles it like any cut/paste.
//
// The coupling to SVAR's DOM is deliberate and narrow: the class names below, plus `data-id`, plus
// lib-dom's setID() prefixing ids with ':'.

const CARD = '.wx-cards .wx-item[data-id]' // cards view, and each pane of the split view
const ROW = '.wx-row[data-id]'             // table view (rendered by @svar-ui/react-grid)
const TREE = 'li.wx-folder[data-id]'       // sidebar folder tree
const BACK = '.wx-back[data-id]'           // the ".." parent link
const DRAGGABLE = `${CARD}, ${ROW}`
const HIGHLIGHT = 'cleo-drop-target'

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
    /** A data-id that maps to something real. The toolbar and the card container carry decoys ("body",
     *  "toggle-tree"), and the breadcrumbs reuse `.wx-item`. */
    const resolve = (el: Element): string | null => {
      if (el.closest('.wx-breadcrumbs')) return null
      const path = readId(el)
      if (!path) return null
      return pathIndexRef.current.has(path) || isFolder(path) ? path : null
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

    // --- 2. drag out --------------------------------------------------------------------------------
    const onDragStart = (e: DragEvent) => {
      const target = e.target as HTMLElement | null
      const el = target?.closest<HTMLElement>(DRAGGABLE)
      if (!el || !e.dataTransfer) return
      const path = resolve(el)
      if (!path) { e.preventDefault(); return }

      const entry = pathIndexRef.current.get(path)
      if (entry) for (const [mime, value] of dragPayload(entry.kind, entry.assetId)) e.dataTransfer.setData(mime, value)

      // Also carries the path, which is what makes the drop-into-a-folder below possible. Folders get only
      // this — they have no asset payload.
      e.dataTransfer.setData('text/cleo-fm-path', path)
      e.dataTransfer.effectAllowed = 'copyMove'
    }

    // --- 3. drop into a folder ----------------------------------------------------------------------
    let highlighted: HTMLElement | null = null
    const clearHighlight = () => {
      if (highlighted) highlighted.classList.remove(HIGHLIGHT)
      highlighted = null
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
      if (!e.dataTransfer?.types.includes('text/cleo-fm-path')) return
      const hit = folderTargetOf(e.target as HTMLElement)
      if (!hit) { clearHighlight(); return }

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
      const source = e.dataTransfer?.getData('text/cleo-fm-path')
      if (!source) return
      const hit = folderTargetOf(e.target as HTMLElement)
      if (!hit || hit.path === source) return

      // Dropping a folder onto itself or its own descendant is rejected by the store, but bail early so it
      // doesn't log an error for a gesture the user obviously didn't mean.
      if (source !== '/' && (hit.path === source || hit.path.startsWith(`${source}/`))) return
      if (source.slice(0, source.lastIndexOf('/') || 1) === hit.path) return // already in that folder

      e.preventDefault()
      e.stopPropagation()
      apiRef.current?.exec('move-files', { ids: [source], target: hit.path })
    }

    const onDragLeave = (e: DragEvent) => {
      if (!e.relatedTarget || !wrapper.contains(e.relatedTarget as Node)) clearHighlight()
    }

    wrapper.addEventListener('dragstart', onDragStart)
    wrapper.addEventListener('dragover', onDragOver)
    wrapper.addEventListener('drop', onDrop)
    wrapper.addEventListener('dragend', clearHighlight)
    wrapper.addEventListener('dragleave', onDragLeave)

    return () => {
      observer.disconnect()
      wrapper.removeEventListener('dragstart', onDragStart)
      wrapper.removeEventListener('dragover', onDragOver)
      wrapper.removeEventListener('drop', onDrop)
      wrapper.removeEventListener('dragend', clearHighlight)
      wrapper.removeEventListener('dragleave', onDragLeave)
      clearHighlight()
    }
  }, [wrapperRef, vfsRef, pathIndexRef, apiRef])
}

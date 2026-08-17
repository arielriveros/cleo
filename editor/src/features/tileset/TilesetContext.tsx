import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useCleoEngine } from '../EngineContext'
import { useDocument } from '../DocumentContext'
import type { TilesetAsset, TileMeta } from '../../utils/tilesets'
import { guessTileSize, resliceTileset } from '../../utils/tilesets'
import { importAtlasImage } from './importAtlas'

// The tileset editing session: one working copy of the open tileset asset, shared by the atlas grid in the
// viewport slot and the inspector in the Properties panel.
//
// It wraps the whole dock (see Editor.tsx) for the same reason the animation and blend-space sessions do:
// either panel can be dragged anywhere, and the working copy must not be tied to one panel's mount.

type TilesetContextValue = {
  /** The working copy, or null when no tileset tab is active. */
  asset: TilesetAsset | null
  /** Patch the working copy and mark the tab dirty. Re-slices when the slicing fields change. */
  patch: (p: Partial<TilesetAsset>) => void
  /**
   * Import an image file as this tileset's atlas. Returns false when it could not be decoded (the reason
   * is logged). Guesses the tile size only for a tileset that has no atlas yet — swapping in a redrawn
   * sheet of the same layout must not clobber slicing the author already set.
   */
  importAtlas: (file: File) => Promise<boolean>
  /** Replace one tile's metadata; passing undefined (or an empty object) clears it. */
  setTileMeta: (index: number, meta: TileMeta | undefined) => void
  /** Read one tile's metadata from the working copy. */
  tileMeta: (index: number) => TileMeta | undefined
  /** Selected tile indices. The atlas grid writes it; the inspector edits whatever is in it. */
  selection: number[]
  setSelection: (indices: number[]) => void
  /** Write the working copy back to the library. */
  save: () => void
  dirty: boolean
}

const TilesetContext = createContext<TilesetContextValue | null>(null)

export function useTileset(): TilesetContextValue {
  const ctx = useContext(TilesetContext)
  if (!ctx) throw new Error('useTileset must be used within a TilesetProvider')
  return ctx
}

// Fields whose change alters the grid, so the derived columns/rows (and any now-out-of-range per-tile
// metadata) have to be recomputed rather than left stale.
const SLICING_KEYS: (keyof TilesetAsset)[] = [
  'tileWidth', 'tileHeight', 'margin', 'spacing', 'imageWidth', 'imageHeight', 'textureId',
]

export function TilesetProvider({ children }: { children: React.ReactNode }) {
  const { editingTilesetId, tilesets, saveTileset, activeTab, eventEmitter } = useCleoEngine()
  const { markTabDirty, dirtyTabs } = useDocument()

  const [asset, setAsset] = useState<TilesetAsset | null>(null)
  // Mirrored so importAtlas can read the CURRENT atlas without re-creating itself on every edit — it only
  // needs to know whether there is one, to decide between guessing the slicing and preserving it.
  const assetRef = useRef<TilesetAsset | null>(null)
  assetRef.current = asset
  const [selection, setSelection] = useState<number[]>([])
  const loadedIdRef = useRef<string | null>(null)

  // Adopt the tab's asset when it changes. Guarded on the id rather than the library array so a save (which
  // rewrites the library) does not throw away the working copy the user is still editing.
  useEffect(() => {
    if (!editingTilesetId) {
      loadedIdRef.current = null
      setAsset(null)
      setSelection([])
      return
    }
    if (loadedIdRef.current === editingTilesetId) return
    const found = tilesets.find(t => t.id === editingTilesetId)
    if (!found) return
    loadedIdRef.current = editingTilesetId
    setAsset(JSON.parse(JSON.stringify(found)))
    setSelection([])
  }, [editingTilesetId, tilesets])

  const tabId = activeTab.kind === 'tileset' ? activeTab.id : null

  const patch = useCallback((p: Partial<TilesetAsset>) => {
    setAsset(prev => {
      if (!prev) return prev
      const resliced = SLICING_KEYS.some(k => k in p && p[k] !== prev[k])
      const next = resliced ? resliceTileset(prev, p) : { ...prev, ...p }
      return next
    })
    if (tabId) markTabDirty(tabId, 'tileset-edit')
  }, [tabId, markTabDirty])

  const setTileMeta = useCallback((index: number, meta: TileMeta | undefined) => {
    setAsset(prev => {
      if (!prev) return prev
      const tiles = { ...prev.tiles }
      // An empty record is dropped rather than stored: a husk would ship in every embedded copy and would
      // make the "has metadata" markers in the grid lie.
      if (!meta || Object.keys(meta).length === 0) delete tiles[index]
      else tiles[index] = meta
      return { ...prev, tiles }
    })
    if (tabId) markTabDirty(tabId, 'tileset-edit')
  }, [tabId, markTabDirty])

  const tileMeta = useCallback((index: number) => asset?.tiles[index], [asset])

  const importAtlas = useCallback(async (file: File): Promise<boolean> => {
    const imported = await importAtlasImage(file, (event) => eventEmitter.emit(event as any))
    if (!imported) return false
    const fresh = !assetRef.current?.textureId
    const tile = fresh ? guessTileSize(imported.width, imported.height) : undefined
    patch({
      textureId: imported.textureId,
      imageWidth: imported.width,
      imageHeight: imported.height,
      ...(tile ? { tileWidth: tile, tileHeight: tile } : {}),
    })
    return true
  }, [eventEmitter, patch])

  const save = useCallback(() => { if (asset) saveTileset(asset) }, [asset, saveTileset])

  const value = useMemo<TilesetContextValue>(() => ({
    asset, patch, importAtlas, setTileMeta, tileMeta, selection, setSelection, save,
    dirty: !!(tabId && dirtyTabs[tabId]),
  }), [asset, patch, importAtlas, setTileMeta, tileMeta, selection, save, tabId, dirtyTabs])

  return <TilesetContext.Provider value={value}>{children}</TilesetContext.Provider>
}

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useCleoEngine } from '../EngineContext'
import { useDocument } from '../DocumentContext'
import type { TilesetAsset, TileMeta } from '../../utils/tilesets'
import { guessTileSize, resliceTileset } from '../../utils/tilesets'
import { importAtlasImage } from './importAtlas'

// The tileset editing session: one working copy of the open tileset asset, shared by the atlas grid in the
// viewport slot and the inspector in the Properties panel.
// It wraps the whole dock (see Editor.tsx): either panel can be dragged anywhere, so the working copy must
// not be tied to one panel's mount.

type TilesetContextValue = {
  /** The working copy, or null when no tileset tab is active. */
  asset: TilesetAsset | null
  /** Patch the working copy and mark the tab dirty. Re-slices when the slicing fields change. */
  patch: (p: Partial<TilesetAsset>) => void
  /**
   * Import an image file as this tileset's atlas. Returns false when it could not be decoded (the reason
   * is logged). Guesses the tile size only for a tileset that has no atlas yet, so swapping in a redrawn
   * sheet of the same layout keeps the slicing the author set.
   */
  importAtlas: (file: File) => Promise<boolean>
  /** Replace one tile's metadata; passing undefined (or an empty object) clears it. */
  setTileMeta: (index: number, meta: TileMeta | undefined) => void
  /** Read one tile's metadata from the working copy. */
  tileMeta: (index: number) => TileMeta | undefined
  /** Selected tile indices. The atlas grid writes it; the inspector edits whatever is in it. */
  selection: number[]
  setSelection: (indices: number[]) => void
  /**
   * The tile whose animation the atlas is currently picking frames for, or null. While set, clicking a
   * tile in the atlas APPENDS it to this tile's frames instead of selecting it.
   */
  framePick: number | null
  /**
   * Start picking frames for `tile`. `before` is the tile's metadata to restore on cancel — pass it when the
   * caller has just changed the tile (turning Animated on seeds a frame); otherwise the current one is kept.
   */
  startFramePick: (tile: number, before?: TileMeta | null) => void
  /** Keep the picked frames and leave picking. */
  finishFramePick: () => void
  /** Put the tile back exactly as it was when picking started, and leave picking. */
  cancelFramePick: () => void
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

// Fields whose change alters the grid, so the derived columns/rows and any now-out-of-range per-tile
// metadata have to be recomputed.
const SLICING_KEYS: (keyof TilesetAsset)[] = [
  'tileWidth', 'tileHeight', 'margin', 'spacing', 'imageWidth', 'imageHeight', 'textureId',
]

export function TilesetProvider({ children }: { children: React.ReactNode }) {
  const { editingTilesetId, tilesets, saveTileset, activeTab, eventEmitter, registerTilesetApply } = useCleoEngine()
  const { markTabDirty, dirtyTabs } = useDocument()

  const [asset, setAsset] = useState<TilesetAsset | null>(null)
  // Mirrored so importAtlas can read the CURRENT atlas without re-creating itself on every edit.
  const assetRef = useRef<TilesetAsset | null>(null)
  assetRef.current = asset
  const [selection, setSelection] = useState<number[]>([])
  const [framePick, setFramePick] = useState<number | null>(null)
  /** The picked tile's metadata as it was before picking — what Cancel restores. `null` = it had none. */
  const pickBeforeRef = useRef<{ tile: number; meta: TileMeta | null } | null>(null)
  const loadedIdRef = useRef<string | null>(null)

  // Adopt the tab's asset when it changes. Guarded on the id rather than the library array, so a save
  // (which rewrites the library) does not throw away the working copy still being edited.
  useEffect(() => {
    if (!editingTilesetId) {
      loadedIdRef.current = null
      setAsset(null)
      setSelection([])
      setFramePick(null)
      return
    }
    if (loadedIdRef.current === editingTilesetId) return
    const found = tilesets.find(t => t.id === editingTilesetId)
    if (!found) return
    loadedIdRef.current = editingTilesetId
    setAsset(JSON.parse(JSON.stringify(found)))
    setSelection([])
    setFramePick(null)
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
      // An empty record is dropped rather than stored: a husk would ship in every embedded copy and make
      // the grid's "has metadata" markers lie.
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

  const startFramePick = useCallback((tile: number, before?: TileMeta | null) => {
    const current = assetRef.current?.tiles[tile]
    const meta = before !== undefined ? before : (current ?? null)
    pickBeforeRef.current = { tile, meta: meta ? JSON.parse(JSON.stringify(meta)) : null }
    setFramePick(tile)
  }, [])
  const finishFramePick = useCallback(() => {
    pickBeforeRef.current = null
    setFramePick(null)
  }, [])
  const cancelFramePick = useCallback(() => {
    const before = pickBeforeRef.current
    pickBeforeRef.current = null
    setFramePick(null)
    if (before) setTileMeta(before.tile, before.meta ?? undefined)
  }, [setTileMeta])

  // Escape CANCELS picking, wherever focus is — the atlas has no keyboard focus of its own. Done keeps.
  useEffect(() => {
    if (framePick === null) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancelFramePick() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [framePick, cancelFramePick])

  const save = useCallback(() => { if (asset) saveTileset(asset) }, [asset, saveTileset])

  // Hand the save back to EngineContext so Ctrl+S, Save All and the close-tab prompt can reach the working
  // copy — they only know tab ids.
  useEffect(() => {
    if (!tabId) return
    registerTilesetApply({ tabId, apply: save })
    return () => registerTilesetApply(null)
  }, [tabId, save, registerTilesetApply])

  const value = useMemo<TilesetContextValue>(() => ({
    asset, patch, importAtlas, setTileMeta, tileMeta, selection, setSelection,
    framePick, startFramePick, finishFramePick, cancelFramePick, save,
    dirty: !!(tabId && dirtyTabs[tabId]),
  }), [asset, patch, importAtlas, setTileMeta, tileMeta, selection, framePick, startFramePick, finishFramePick,
       cancelFramePick, save, tabId, dirtyTabs])

  return <TilesetContext.Provider value={value}>{children}</TilesetContext.Provider>
}

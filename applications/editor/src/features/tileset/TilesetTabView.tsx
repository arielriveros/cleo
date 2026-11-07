import React, { useEffect, useMemo, useRef, useState } from 'react'
import { isTextEntryEvent } from 'cleo'
import { Button, TextInput } from '@cleo/app-kit/ui'
import { clamp } from '@cleo/app-kit/utils/math'
import { useTileset } from './TilesetContext'
import TileGrid, { MAX_TILE_ZOOM, MIN_TILE_ZOOM, type TileSelectMods } from './TileGrid'
import { token } from '@cleo/app-kit/utils/cssTokens'
import {
  appendFrames, clearTileMeta, copyableTileMeta, frameBadges, pasteTileMeta, removeLastFrame, tileMetaSummary,
} from '../../utils/tilesets'

// The tileset tab's main area: the atlas with its slicing grid. A tileset has no 3D preview, so nothing
// here touches the renderer.
//
// The atlas takes keyboard focus when clicked, and its shortcuts (arrows, Ctrl+A, Delete, Ctrl+C / Ctrl+V,
// Esc) are bound on it rather than on the window, so they never reach the scene or another panel.

/** The largest zoom a freshly opened tileset fits to: a tiny atlas should not open as a wall of pixels. */
const MAX_FIT_ZOOM = 4
/** The padding TileGrid sits in (p-3 on each side), which the fit leaves room for. */
const FIT_PADDING = 24

/** `selection` after a gesture that picked `indices`, by the modifiers it was made with. */
function mergeSelection(selection: number[], indices: number[], mods: TileSelectMods): number[] {
  if (mods.toggle) {
    const set = new Set(selection)
    const allIn = indices.every(i => set.has(i))
    for (const i of indices) { if (allIn) set.delete(i); else set.add(i) }
    // Keep the existing order, so the first-selected tile stays the one the inspector shows.
    return [...selection.filter(i => set.has(i)), ...indices.filter(i => set.has(i) && !selection.includes(i))]
  }
  if (mods.additive) return [...selection, ...indices.filter(i => !selection.includes(i))]
  return indices
}

export default function TilesetTabView() {
  const {
    asset, patch, importAtlas, selection, setSelection, framePick, finishFramePick, cancelFramePick, setTileMeta,
    edit, clipboard, setClipboard, save, dirty,
  } = useTileset()
  const [zoom, setZoom] = useState(2)
  const [busy, setBusy] = useState(false)
  const [hover, setHover] = useState<number | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const areaRef = useRef<HTMLDivElement | null>(null)
  const [area, setArea] = useState<{ w: number; h: number } | null>(null)
  const fittedRef = useRef<string | null>(null)

  // Corner badges so the atlas itself shows which tiles carry authoring, without opening each one.
  const colours = useMemo(() => ({
    solid: token('--danger'), animated: token('--warning'), authored: token('--success-fg'),
  }), [])
  const markerOf = useMemo(() => {
    if (!asset) return undefined
    return (index: number): string | null => {
      const meta = asset.tiles[index]
      if (!meta) return null
      if (meta.solid) return colours.solid
      if (meta.animation && meta.animation.frames.length > 1) return colours.animated
      return colours.authored
    }
  }, [asset, colours])

  // The animation on show: the one being picked, else the selected tile's own. Its frames are numbered on
  // the atlas so the order is visible where the tiles are, not only as a list of indices.
  const animTile = framePick ?? (selection.length === 1 ? selection[0] : null)
  const animFrames = (animTile !== null && asset?.tiles[animTile]?.animation?.frames) || null
  const badges = useMemo(() => frameBadges(animFrames ?? []), [animFrames])

  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setArea(prev => (prev && prev.w === width && prev.h === height ? prev : { w: width, h: height }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [!!asset])

  const fitZoom = (cap = MAX_TILE_ZOOM): number | null => {
    if (!asset || !area || asset.imageWidth <= 0 || asset.imageHeight <= 0) return null
    const z = Math.min((area.w - FIT_PADDING) / asset.imageWidth, (area.h - FIT_PADDING) / asset.imageHeight)
    return clamp(Math.min(z, cap), MIN_TILE_ZOOM, MAX_TILE_ZOOM)
  }

  // A tileset opens fitted to the view (once per tileset; the zoom is the author's after that).
  useEffect(() => {
    if (!asset || fittedRef.current === asset.id) return
    const z = fitZoom(MAX_FIT_ZOOM)
    if (z === null) return
    fittedRef.current = asset.id
    setZoom(z)
  }, [asset?.id, asset?.imageWidth, asset?.imageHeight, area]) // not `asset`: every edit is a new object

  if (!asset) return null
  const count = asset.columns * asset.rows

  const setFrames = (frames: number[]) => {
    if (framePick === null) return
    const meta = asset.tiles[framePick] ?? {}
    setTileMeta(framePick, { ...meta, animation: { frames, fps: meta.animation?.fps ?? 8 } })
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isTextEntryEvent(e.nativeEvent)) return
    const mod = e.ctrlKey || e.metaKey
    const key = e.key
    if (key.startsWith('Arrow') && framePick === null) {
      if (selection.length === 0) { setSelection([0]); e.preventDefault(); return }
      const from = selection[selection.length - 1]
      let col = from % asset.columns, row = Math.floor(from / asset.columns)
      if (key === 'ArrowLeft') col--
      else if (key === 'ArrowRight') col++
      else if (key === 'ArrowUp') row--
      else if (key === 'ArrowDown') row++
      col = clamp(col, 0, asset.columns - 1)
      row = clamp(row, 0, asset.rows - 1)
      const next = row * asset.columns + col
      // Shift extends the selection with the tile stepped onto; a plain arrow moves it.
      setSelection(e.shiftKey ? mergeSelection(selection, [next], { additive: true, toggle: false }) : [next])
      e.preventDefault()
      return
    }
    if (mod && key.toLowerCase() === 'a') {
      setSelection(Array.from({ length: count }, (_, i) => i))
      e.preventDefault(); e.stopPropagation()
      return
    }
    if (key === 'Escape' && framePick === null && selection.length > 0) {
      setSelection([])
      e.preventDefault()
      return
    }
    if ((key === 'Delete' || key === 'Backspace') && framePick === null && selection.length > 0) {
      edit(prev => clearTileMeta(prev, selection), 'Clear tile metadata')
      e.preventDefault(); e.stopPropagation()
      return
    }
    if (mod && key.toLowerCase() === 'c' && selection.length > 0) {
      setClipboard(copyableTileMeta(asset.tiles[selection[0]]))
      e.preventDefault(); e.stopPropagation()
      return
    }
    if (mod && key.toLowerCase() === 'v' && clipboard && selection.length > 0) {
      edit(prev => pasteTileMeta(prev, selection, clipboard), 'Paste tile metadata')
      e.preventDefault(); e.stopPropagation()
    }
  }

  const hovered = hover !== null && hover < count ? hover : null
  const status = framePick !== null
    ? null
    : hovered !== null
      ? `Tile ${hovered} · col ${hovered % asset.columns}, row ${Math.floor(hovered / asset.columns)} · ${tileMetaSummary(asset.tiles[hovered])}`
      : selection.length === 0
        ? 'Drag to select tiles; Shift adds, Ctrl toggles. Ctrl+wheel zooms, middle-drag pans.'
        : selection.length === 1
          ? `Tile ${selection[0]} selected`
          : `${selection.length} tiles selected — edits apply to all of them`

  return (
    <div className='absolute inset-0 flex flex-col bg-surface-sunken text-fg'>
      <div className='h-[30px] shrink-0 flex items-center gap-2 px-2 border-b border-border bg-surface-raised'>
        <TextInput
          className='w-48'
          value={asset.name}
          onChange={(name) => patch({ name })}
          title='Tileset name'
        />
        <span className='text-ui-sm text-muted truncate'>
          {asset.columns} x {asset.rows} tiles &middot; {asset.tileWidth}x{asset.tileHeight}px
        </span>
        <div className='flex items-center gap-1 ml-auto'>
          <Button
            size='sm' variant='ghost' disabled={busy}
            onClick={() => fileRef.current?.click()}
            title='Replace this tileset’s atlas image'
          >
            {busy ? 'Importing…' : 'Import image…'}
          </Button>
          <input
            ref={fileRef} type='file' className='hidden' accept='.png,.jpg,.jpeg,.bmp,.gif,.webp'
            onChange={(e) => {
              const file = e.target.files?.item(0)
              // Reset first: re-picking the same file fires no change event otherwise.
              e.target.value = ''
              if (!file) return
              setBusy(true)
              void importAtlas(file).finally(() => setBusy(false))
            }}
          />
          <Button size='sm' variant='ghost' onClick={() => setZoom(z => Math.max(MIN_TILE_ZOOM, z / 1.5))} title='Zoom out'>-</Button>
          <span className='text-ui-sm text-muted w-10 text-center tabular-nums'>{Math.round(zoom * 100)}%</span>
          <Button size='sm' variant='ghost' onClick={() => setZoom(z => Math.min(MAX_TILE_ZOOM, z * 1.5))} title='Zoom in'>+</Button>
          <Button size='sm' variant='ghost' title='Fit the whole atlas in view'
            onClick={() => { const z = fitZoom(); if (z !== null) setZoom(z) }}>Fit</Button>
          <Button size='sm' variant='ghost' title='Actual size: one atlas pixel per screen pixel' onClick={() => setZoom(1)}>1:1</Button>
          <Button size='sm' onClick={save} disabled={!dirty} title='Save this tileset and update every tilemap using it'>
            Save
          </Button>
        </div>
      </div>
      <div
        ref={areaRef}
        tabIndex={0}
        className='flex-1 min-h-0 flex outline-none'
        onKeyDown={onKeyDown}
        // Focus on press, so the atlas's shortcuts work right after clicking a tile.
        onMouseDownCapture={(e) => { if (document.activeElement !== e.currentTarget) e.currentTarget.focus({ preventScroll: true }) }}
      >
        <TileGrid
          className='flex-1 p-3'
          asset={asset}
          selection={framePick !== null ? [] : selection}
          // While picking, a click (or a dragged rectangle, row by row) adds frames instead of selecting.
          onSelect={(indices, _rect, mods) => framePick !== null
            ? setFrames(appendFrames(animFrames ?? [], indices))
            : setSelection(mergeSelection(selection, indices, mods))}
          badges={badges}
          anchor={animTile}
          onCellContextMenu={framePick !== null ? (tile) => setFrames(removeLastFrame(animFrames ?? [], tile)) : undefined}
          onHover={setHover}
          showLeftover
          cursor={framePick !== null ? 'copy' : 'crosshair'}
          zoom={zoom}
          onZoomChange={setZoom}
          markerOf={markerOf}
          onImport={() => fileRef.current?.click()}
        />
      </div>
      <div className='h-[22px] shrink-0 flex items-center gap-3 px-2 text-ui-sm text-muted border-t border-border'>
        {framePick !== null
          ? <>
              <span className='truncate'>Picking frames for tile {framePick}: click tiles in play order (drag adds a row), right-click removes.</span>
              <Button size='sm' variant='ghost' className='ml-auto' title='Discard the frames picked this time (Esc)'
                onClick={cancelFramePick}>Cancel</Button>
              <Button size='sm' variant='ghost' onClick={finishFramePick}>Done</Button>
            </>
          : <>
              <span className='truncate'>{status}</span>
              <span className='ml-auto flex items-center gap-2 shrink-0' title='The corner marks on the atlas'>
                {([['Solid', colours.solid], ['Animated', colours.animated], ['Other metadata', colours.authored]] as const).map(([name, colour]) => (
                  <span key={name} className='inline-flex items-center gap-1'>
                    <span className='inline-block w-2 h-2 rounded-[1px]' style={{ background: colour }} />
                    {name}
                  </span>
                ))}
              </span>
            </>}
      </div>
    </div>
  )
}

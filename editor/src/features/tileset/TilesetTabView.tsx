import { useMemo, useRef, useState } from 'react'
import { Button, TextInput } from '../../components/ui'
import { useTileset } from './TilesetContext'
import TileGrid from './TileGrid'
import { token } from '../../utils/cssTokens'
import { appendFrames, frameBadges, removeLastFrame } from '../../utils/tilesets'

// The tileset tab's main area: the atlas with its slicing grid. A tileset has no 3D preview, so nothing
// here touches the renderer.

export default function TilesetTabView() {
  const { asset, patch, importAtlas, selection, setSelection, framePick, finishFramePick, cancelFramePick, setTileMeta, save, dirty } = useTileset()
  const [zoom, setZoom] = useState(2)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)

  // Corner badges so the atlas itself shows which tiles carry authoring, without opening each one.
  const markerOf = useMemo(() => {
    if (!asset) return undefined
    const solid = token('--danger'), animated = token('--warning'), authored = token('--success-fg')
    return (index: number): string | null => {
      const meta = asset.tiles[index]
      if (!meta) return null
      if (meta.solid) return solid
      if (meta.animation && meta.animation.frames.length > 1) return animated
      return authored
    }
  }, [asset])

  // The animation on show: the one being picked, else the selected tile's own. Its frames are numbered on
  // the atlas so the order is visible where the tiles are, not only as a list of indices.
  const animTile = framePick ?? (selection.length === 1 ? selection[0] : null)
  const animFrames = (animTile !== null && asset?.tiles[animTile]?.animation?.frames) || null
  const badges = useMemo(() => frameBadges(animFrames ?? []), [animFrames])

  if (!asset) return null

  const setFrames = (frames: number[]) => {
    if (framePick === null) return
    const meta = asset.tiles[framePick] ?? {}
    setTileMeta(framePick, { ...meta, animation: { frames, fps: meta.animation?.fps ?? 8 } })
  }

  return (
    <div className='absolute inset-0 flex flex-col bg-surface-sunken text-fg'>
      <div className='h-[30px] shrink-0 flex items-center gap-2 px-2 border-b border-border bg-surface-raised'>
        <TextInput
          className='w-48'
          value={asset.name}
          onChange={(name) => patch({ name })}
          title='Tileset name'
        />
        <span className='text-ui-sm text-muted'>
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
          <Button size='sm' variant='ghost' onClick={() => setZoom(z => Math.max(0.25, z / 1.5))} title='Zoom out'>-</Button>
          <span className='text-ui-sm text-muted w-10 text-center'>{Math.round(zoom * 100)}%</span>
          <Button size='sm' variant='ghost' onClick={() => setZoom(z => Math.min(16, z * 1.5))} title='Zoom in'>+</Button>
          <Button size='sm' onClick={save} disabled={!dirty} title='Save this tileset and update every tilemap using it'>
            Save
          </Button>
        </div>
      </div>
      <TileGrid
        className='flex-1 p-3'
        asset={asset}
        selection={framePick !== null ? [] : selection}
        // While picking, a click (or a dragged rectangle, row by row) adds frames instead of selecting.
        onSelect={(indices) => framePick !== null
          ? setFrames(appendFrames(animFrames ?? [], indices))
          : setSelection(indices)}
        badges={badges}
        anchor={animTile}
        onCellContextMenu={framePick !== null ? (tile) => setFrames(removeLastFrame(animFrames ?? [], tile)) : undefined}
        cursor={framePick !== null ? 'copy' : 'crosshair'}
        zoom={zoom}
        onZoomChange={setZoom}
        markerOf={markerOf}
        onImport={() => fileRef.current?.click()}
      />
      <div className='h-[22px] shrink-0 flex items-center px-2 text-ui-sm text-muted border-t border-border'>
        {framePick !== null
          ? <>
              <span>Picking frames for tile {framePick}: click tiles in play order (drag adds a row), right-click removes.</span>
              <Button size='sm' variant='ghost' className='ml-auto' title='Discard the frames picked this time (Esc)'
                onClick={cancelFramePick}>Cancel</Button>
              <Button size='sm' variant='ghost' onClick={finishFramePick}>Done</Button>
            </>
          : selection.length === 0
          ? 'Drag a rectangle to select tiles. Ctrl+wheel zooms.'
          : selection.length === 1
            ? `Tile ${selection[0]} selected`
            : `${selection.length} tiles selected — edits apply to all of them`}
      </div>
    </div>
  )
}

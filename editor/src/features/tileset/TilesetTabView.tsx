import { useMemo, useRef, useState } from 'react'
import { Button, TextInput } from '../../components/ui'
import { useTileset } from './TilesetContext'
import TileGrid from './TileGrid'

// The tileset tab's main area: the atlas with its slicing grid. A tileset has no 3D preview, so nothing
// here touches the renderer.

export default function TilesetTabView() {
  const { asset, patch, importAtlas, selection, setSelection, save, dirty } = useTileset()
  const [zoom, setZoom] = useState(2)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)

  // Corner badges so the atlas itself shows which tiles carry authoring, without opening each one.
  const markerOf = useMemo(() => {
    if (!asset) return undefined
    return (index: number): string | null => {
      const meta = asset.tiles[index]
      if (!meta) return null
      if (meta.solid) return '#ff6b6b'
      if (meta.animation && meta.animation.frames.length > 1) return '#f2c14b'
      return '#7ec8a9'
    }
  }, [asset])

  if (!asset) return null

  return (
    <div className='absolute inset-0 flex flex-col bg-surface-sunken text-white'>
      <div className='h-[30px] shrink-0 flex items-center gap-2 px-2 border-b border-border bg-surface-raised'>
        <TextInput
          className='w-48'
          value={asset.name}
          onChange={(name) => patch({ name })}
          title='Tileset name'
        />
        <span className='text-[11px] text-muted'>
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
          <span className='text-[11px] text-muted w-10 text-center'>{Math.round(zoom * 100)}%</span>
          <Button size='sm' variant='ghost' onClick={() => setZoom(z => Math.min(16, z * 1.5))} title='Zoom in'>+</Button>
          <Button size='sm' onClick={save} disabled={!dirty} title='Save this tileset and update every tilemap using it'>
            Save
          </Button>
        </div>
      </div>
      <TileGrid
        className='flex-1 p-3'
        asset={asset}
        selection={selection}
        onSelect={(indices) => setSelection(indices)}
        zoom={zoom}
        onZoomChange={setZoom}
        markerOf={markerOf}
        onImport={() => fileRef.current?.click()}
      />
      <div className='h-[22px] shrink-0 flex items-center px-2 text-[11px] text-muted border-t border-border'>
        {selection.length === 0
          ? 'Drag a rectangle to select tiles. Ctrl+wheel zooms.'
          : selection.length === 1
            ? `Tile ${selection[0]} selected`
            : `${selection.length} tiles selected — edits apply to all of them`}
      </div>
    </div>
  )
}

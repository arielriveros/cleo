import React, { useMemo, useState } from 'react'
import { useCleoEngine } from '../EngineContext'
import { Button, Hint, Select } from '../../components/ui'
import { toRuntimeTileset } from '../../utils/tilesets'
import TileGrid from '../tileset/TileGrid'
import { useActiveTilemap } from './useActiveTilemap'
import { useAssetDrop } from '../../utils/useAssetDrop'

// The tilemap mode's palette panel: pick the layer's tileset, then pick what the brush paints. Dragging a
// rectangle across the atlas builds a multi-tile stamp rather than selecting one tile.

export default function TilePalette() {
  const { tilesets, tilemapBrush, eventEmitter, enterTilesetEditor } = useCleoEngine()
  const { node, revision } = useActiveTilemap()
  const [zoom, setZoom] = useState(2)

  const layerIndex = tilemapBrush.current.activeLayer
  const layer = node?.tilemap.layers[layerIndex]
  const asset = useMemo(
    () => tilesets.find(t => t.id === layer?.cfg.tilesetId),
    // `revision` is in the deps because the layer's tileset id lives in engine state, not React state.
    [tilesets, layer?.cfg.tilesetId, revision],
  )

  const assign = (id: string) => {
    if (!node || !layer) return
    const found = tilesets.find(t => t.id === id)
    if (!found) return
    layer.cfg.tilesetId = id
    // Register (or refresh) the embedded copy the map draws from — a layer pointing at a tileset the map
    // has never embedded would render nothing at all.
    node.tilemap.registerTileset(toRuntimeTileset(found))
    layer.markAllMeshesDirty()
    eventEmitter.emit('SCENE_CHANGED')
  }

  const { dragOver, dropProps } = useAssetDrop('text/cleo-tileset', assign)

  const selection = tilemapBrush.current.stamp.tiles

  if (!node) {
    return <div className='p-2 text-xs text-muted'>Add a Tilemap node to the scene to start painting.</div>
  }

  return (
    <div
      className={`flex flex-col h-full w-full bg-surface-raised text-white ${dragOver ? 'ring-1 ring-selected' : ''}`}
      {...dropProps}
    >
      <div className='h-[26px] shrink-0 flex items-center gap-1 px-1.5 border-b border-border'>
        <Select
          className='flex-1 text-xs'
          value={layer?.cfg.tilesetId ?? ''}
          onChange={(e) => { if (e.target.value) assign(e.target.value) }}
          title='Tileset this layer paints from'
        >
          <option value=''>No tileset…</option>
          {tilesets.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select>
        {asset && (
          <Button size='sm' variant='ghost' title='Edit this tileset' onClick={() => enterTilesetEditor(asset.id)}>✎</Button>
        )}
        <Button size='sm' variant='ghost' onClick={() => setZoom(z => Math.max(0.5, z / 1.5))} title='Zoom out'>-</Button>
        <Button size='sm' variant='ghost' onClick={() => setZoom(z => Math.min(12, z * 1.5))} title='Zoom in'>+</Button>
      </div>

      {asset ? (
        <TileGrid
          className='flex-1 p-1.5'
          asset={asset}
          selection={selection}
          zoom={zoom}
          onZoomChange={setZoom}
          onSelect={(indices, rect) => {
            const b = tilemapBrush.current
            b.stamp = { w: rect.w, h: rect.h, tiles: indices }
            // A rectangle is only a stamp; a single tile keeps whichever tool is selected.
            if (rect.w > 1 || rect.h > 1) b.tool = 'stamp'
            else if (b.tool === 'stamp') b.tool = 'brush'
            eventEmitter.emit('TILEMAP_BRUSH_CHANGED')
          }}
          markerOf={(index) => {
            const meta = asset.tiles[index]
            if (!meta) return null
            if (meta.solid) return '#ff6b6b'
            if (meta.animation && meta.animation.frames.length > 1) return '#f2c14b'
            return null
          }}
        />
      ) : (
        <div className='flex-1 flex items-center justify-center p-3'>
          <Hint>Assign a tileset to this layer — pick one above, or drag one in from the Assets explorer.</Hint>
        </div>
      )}
    </div>
  )
}

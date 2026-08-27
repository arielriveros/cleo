import { useEffect, useState } from 'react'
import { useCleoEngine } from '../EngineContext'
import type { TilemapTool } from '../EngineContext'
import { Button, Hint, Select, Toggle } from '../../components/ui'
import { useActiveTilemap } from './useActiveTilemap'

// The floating tool card for tilemap mode: a `data-cleo-overlay` panel over the viewport whose controls
// write straight into the shared brush ref, then announce the change.

const TOOLS: { id: TilemapTool; label: string; title: string }[] = [
  { id: 'brush', label: 'Brush', title: 'Paint the selected tile' },
  { id: 'eraser', label: 'Eraser', title: 'Clear cells on the active layer' },
  { id: 'rect', label: 'Rect', title: 'Drag a rectangle to fill it' },
  { id: 'bucket', label: 'Bucket', title: 'Flood-fill the matching region' },
  { id: 'stamp', label: 'Stamp', title: 'Place the whole palette selection as a block' },
  { id: 'eyedropper', label: 'Pick', title: 'Pick the tile under the cursor' },
  { id: 'randomize', label: 'Random', title: 'Scatter tiles from a variant set' },
  { id: 'autotile', label: 'Auto', title: 'Paint a terrain and resolve its edges' },
]

export default function TilemapInspector() {
  const { tilemapBrush, eventEmitter, tilesets } = useCleoEngine()
  const { node, revision } = useActiveTilemap()

  // Mirrored into state so the card re-renders; the ref stays the source of truth for the brush itself.
  const [tool, setTool] = useState<TilemapTool>(tilemapBrush.current.tool)
  const [orient, setOrient] = useState(tilemapBrush.current.orient)
  const [variantSetId, setVariantSetId] = useState<number | null>(tilemapBrush.current.variantSetId)
  const [terrainId, setTerrainId] = useState<number | null>(tilemapBrush.current.terrainId)

  // The brush is also written from elsewhere (the palette, the eyedropper, the X/Y/Z keys), so the card
  // follows the ref rather than assuming it is the only writer.
  useEffect(() => {
    const b = tilemapBrush.current
    setTool(b.tool)
    setOrient(b.orient)
    setVariantSetId(b.variantSetId)
    setTerrainId(b.terrainId)
  }, [revision, tilemapBrush])

  const write = (patch: Partial<typeof tilemapBrush.current>) => {
    Object.assign(tilemapBrush.current, patch)
    eventEmitter.emit('TILEMAP_BRUSH_CHANGED')
  }

  const layer = node?.tilemap.layers[tilemapBrush.current.activeLayer]
  const tileset = tilesets.find(t => t.id === layer?.cfg.tilesetId)

  if (!node) {
    return (
      <div data-cleo-overlay className='absolute top-2 left-2 z-20 w-56 rounded border border-control bg-surface-raised/95 p-2 text-white shadow-lg'>
        <Hint>No tilemap in this scene. Add one from the scene tree’s Add menu.</Hint>
      </div>
    )
  }

  return (
    <div
      data-cleo-overlay
      className='absolute top-2 left-2 z-20 w-56 max-h-[85%] overflow-y-auto rounded border border-control bg-surface-raised/95 p-2 text-white shadow-lg space-y-2'
    >
      <div className='grid grid-cols-4 gap-1'>
        {TOOLS.map(t => (
          <Button
            key={t.id}
            size='sm'
            variant='subtle'
            active={tool === t.id}
            title={t.title}
            onClick={() => { setTool(t.id); write({ tool: t.id }) }}
          >
            {t.label}
          </Button>
        ))}
      </div>

      <div className='flex items-center justify-between'>
        <span className='text-[11px] text-gray-300' title='Keyboard: X, Y and Z'>Flip X / Y / Rot</span>
        <span className='flex gap-1'>
          <Toggle checked={orient.flipX} onChange={(c) => { const o = { ...orient, flipX: c }; setOrient(o); write({ orient: o }) }} />
          <Toggle checked={orient.flipY} onChange={(c) => { const o = { ...orient, flipY: c }; setOrient(o); write({ orient: o }) }} />
          <Toggle checked={orient.rot90} onChange={(c) => { const o = { ...orient, rot90: c }; setOrient(o); write({ orient: o }) }} />
        </span>
      </div>

      {tool === 'randomize' && (
        <div className='space-y-1'>
          <Select
            className='text-xs'
            value={variantSetId ?? ''}
            onChange={(e) => {
              const v = e.target.value === '' ? null : Number(e.target.value)
              setVariantSetId(v); write({ variantSetId: v })
            }}
          >
            <option value=''>Variant set…</option>
            {(tileset?.variantSets ?? []).map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
          </Select>
          {(!tileset || tileset.variantSets.length === 0) && <Hint>Build one in the tileset editor first.</Hint>}
        </div>
      )}

      {tool === 'autotile' && (
        <div className='space-y-1'>
          <Select
            className='text-xs'
            value={terrainId ?? ''}
            onChange={(e) => {
              const v = e.target.value === '' ? null : Number(e.target.value)
              setTerrainId(v); write({ terrainId: v })
            }}
          >
            <option value=''>Terrain set…</option>
            {(tileset?.terrains ?? []).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
          {(!tileset || tileset.terrains.length === 0) && <Hint>Build one in the tileset editor first.</Hint>}
        </div>
      )}

      <Hint>
        Painting targets “{layer?.cfg.name ?? '—'}”. Ctrl+Z undoes a whole stroke.
      </Hint>
    </div>
  )
}

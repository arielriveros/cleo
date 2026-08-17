import { useCleoEngine } from '../EngineContext'
import { Button, ButtonWithConfirm, Hint, NumberInput, Select, TextInput, Toggle } from '../../components/ui'
import { useActiveTilemap } from './useActiveTilemap'

// The tilemap mode's layer stack: order, visibility, opacity, parallax, Y-sorting and which layer is the
// collision override. Painting always targets the ACTIVE layer, which is selected here.

const label = 'text-[11px] text-gray-300'

export default function TilemapLayersPanel() {
  const { tilemapBrush, eventEmitter, tilesets } = useCleoEngine()
  const { node, tilemaps, select, revision, refresh } = useActiveTilemap()

  const commit = () => { eventEmitter.emit('SCENE_CHANGED'); refresh() }

  if (!node) {
    return <div className='p-2 text-xs text-muted'>Add a Tilemap node to the scene to start painting.</div>
  }

  const tilemap = node.tilemap
  const active = tilemapBrush.current.activeLayer
  const setActive = (index: number) => {
    tilemapBrush.current.activeLayer = index
    eventEmitter.emit('TILEMAP_BRUSH_CHANGED')
    refresh()
  }

  return (
    <div className='flex flex-col text-white p-2 gap-2' key={revision}>
      {tilemaps.length > 1 && (
        <Select
          className='text-xs'
          value={node.id}
          onChange={(e) => select(e.target.value)}
          title='Which tilemap these panels edit'
        >
          {tilemaps.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select>
      )}

      <div className='flex items-center justify-between'>
        <span className='text-xs text-gray-300'>Layers</span>
        <Button size='sm' variant='ghost' onClick={() => { tilemap.addLayer(); commit() }} title='Add a layer above'>
          + Layer
        </Button>
      </div>

      {/* Topmost first, which is how a layer stack reads everywhere else. */}
      {[...tilemap.layers].map((layer, i) => ({ layer, i })).reverse().map(({ layer, i }) => (
        <div
          key={i}
          className={`border rounded p-1.5 space-y-1 cursor-pointer ${i === active ? 'border-selected bg-control' : 'border-control'}`}
          onClick={() => setActive(i)}
        >
          <div className='flex items-center gap-1'>
            <Toggle
              checked={layer.cfg.visible}
              onChange={(c) => { layer.cfg.visible = c; commit() }}
            />
            <TextInput
              className='flex-1 text-xs'
              value={layer.cfg.name}
              onChange={(name) => { layer.cfg.name = name; commit() }}
            />
            <span className='text-[10px] text-muted tabular-nums' title='Tiles painted on this layer'>
              {layer.tileCount}
            </span>
            <ButtonWithConfirm
              className='px-1 py-0 text-xs'
              disabled={tilemap.layers.length <= 1}
              onClick={() => { tilemap.removeLayer(i); if (active >= tilemap.layers.length) setActive(tilemap.layers.length - 1); commit() }}
            >
              ✕
            </ButtonWithConfirm>
          </div>

          {i === active && (
            <div className='space-y-1 pt-1'>
              <div className='flex items-center justify-between'>
                <span className={label}>Tileset</span>
                <span className='text-[10px] text-muted truncate max-w-[8rem]'>
                  {tilesets.find(t => t.id === layer.cfg.tilesetId)?.name ?? 'none'}
                </span>
              </div>
              <div className='flex items-center justify-between'>
                <span className={label}>Opacity</span>
                <NumberInput className='w-16' value={layer.cfg.opacity} step={0.05} min={0} max={1}
                  onChange={(v) => { layer.cfg.opacity = Math.max(0, Math.min(1, v)); layer.markAllMeshesDirty(); commit() }} />
              </div>
              <div className='flex items-center justify-between'>
                <span className={label} title='Draw band. Layers sort by this before anything else.'>Order</span>
                <NumberInput className='w-16' value={layer.cfg.order} step={1}
                  onChange={(v) => { layer.cfg.order = v; commit() }} />
              </div>
              <div className='flex items-center justify-between'>
                <span className={label} title='World Z nudge, so two layers in the same band do not z-fight'>Z offset</span>
                <NumberInput className='w-16' value={layer.cfg.zOffset} step={0.01}
                  onChange={(v) => { layer.cfg.zOffset = v; commit() }} />
              </div>
              <div className='flex items-center justify-between'>
                <span className={label} title='1 moves with the world, 0 is pinned to the camera'>Parallax</span>
                <span className='flex gap-1'>
                  <NumberInput className='w-14' value={layer.cfg.parallax[0]} step={0.05}
                    onChange={(v) => { layer.cfg.parallax = [v, layer.cfg.parallax[1]]; commit() }} />
                  <NumberInput className='w-14' value={layer.cfg.parallax[1]} step={0.05}
                    onChange={(v) => { layer.cfg.parallax = [layer.cfg.parallax[0], v]; commit() }} />
                </span>
              </div>
              <div className='flex items-center justify-between'>
                <span className={label} title='Depth-sort this layer’s tiles against sprites, row by row'>Y-sorted</span>
                <Toggle checked={layer.cfg.ySorted}
                  onChange={(c) => { layer.cfg.ySorted = c; layer.markAllMeshesDirty(); commit() }} />
              </div>
              <div className='flex items-center justify-between'>
                <span className={label} title='Every tile on this layer collides, whatever its tileset says'>Collision layer</span>
                <Toggle checked={layer.cfg.collision}
                  onChange={(c) => { layer.cfg.collision = c; commit() }} />
              </div>
              {layer.cfg.collision && (layer.cfg.parallax[0] !== 1 || layer.cfg.parallax[1] !== 1) && (
                <Hint>
                  A parallaxed layer is drawn at a camera-dependent offset, so it contributes no colliders —
                  its art and its collision could never line up.
                </Hint>
              )}
              <div className='flex items-center justify-between pt-1'>
                <span className={label} title='Sprites join this layer’s band when they depth-sort'>Entity layer</span>
                <Toggle checked={tilemap.entityLayer === i}
                  onChange={(c) => { if (c) { tilemap.entityLayer = i; commit() } }} />
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

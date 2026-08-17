import { useState } from 'react'
import { LandscapeNode } from 'cleo'
import Collapsable from '../../../components/Collapsable'
import { Button, Hint, NumberInput } from '../../../components/ui'
import { useCleoEngine } from '../../EngineContext'
import { rebuildTerrain } from '../../landscape/rebuildTerrain'

// Node inspector for a LandscapeNode: the terrain's STRUCTURE — how big it is, how finely it is sampled,
// how it is chunked — plus the heightmap import/export that replaces its shape wholesale.
//
// The split against landscape mode mirrors the tilemap's: this holds what the terrain IS, the mode holds
// the brushes that edit it. Position is the node's own transform, edited with the ordinary gizmo.

const label = 'text-xs text-gray-300'

export default function LandscapeEditor(props: { node: LandscapeNode }) {
  const { eventEmitter } = useCleoEngine()
  const terrain = props.node.terrain

  // Staged, not live. A rebuild reallocates every chunk and resamples the splat and the foliage — far too
  // expensive to run on each keystroke the way the tilemap's grid settings can afford to.
  //
  // Read from `config` rather than the `size`/`resolution` getters: those report the DERIVED values
  // (resolution is the vertices-per-side after clamping), and this control has to round-trip what the
  // terrain was actually built with.
  const cfg = terrain.config
  const [size, setSize] = useState(cfg.size)
  const [resolution, setResolution] = useState(cfg.resolution)
  const [chunkQuads, setChunkQuads] = useState(cfg.chunkQuads)
  const [amplitude, setAmplitude] = useState(30)
  const [busy, setBusy] = useState(false)

  const pending = size !== cfg.size || resolution !== cfg.resolution || chunkQuads !== cfg.chunkQuads

  const rebuild = () => {
    setBusy(true)
    try {
      rebuildTerrain(props.node, { size, resolution, chunkQuads })
      eventEmitter.emit('SCENE_CHANGED')
    } finally { setBusy(false) }
  }

  const importHeightmap = (files: FileList | null) => {
    if (!files || files.length === 0) return
    const reader = new FileReader()
    reader.onload = (e) => {
      terrain.importHeightmap(e.target?.result as string, amplitude)
        .then(() => eventEmitter.emit('SCENE_CHANGED'))
        .catch(err => console.error(err))
    }
    reader.readAsDataURL(files[0])
  }

  const exportHeightmap = () => {
    const a = document.createElement('a')
    a.href = terrain.exportHeightmap()
    a.download = 'heightmap.png'
    a.click()
  }

  return (
    <Collapsable title='Landscape' persistKey='node.landscape' defaultOpen>
      <div className='p-2 space-y-2'>
        <div className='flex items-center justify-between'>
          <span className={label} title='World size of the terrain, centred on this node'>Size</span>
          <NumberInput className='w-20' value={size} step={10} min={10}
            onChange={(v) => setSize(Math.max(10, v))} />
        </div>
        <div className='flex items-center justify-between'>
          <span className={label} title='Height samples per side. More detail, more memory.'>Resolution</span>
          <NumberInput className='w-20' value={resolution} step={1} min={8} max={513}
            onChange={(v) => setResolution(Math.max(8, Math.min(513, v)))} />
        </div>
        <div className='flex items-center justify-between'>
          <span className={label} title='Quads per side of each render chunk: the unit of frustum culling and distance LOD'>
            Chunk quads
          </span>
          <NumberInput className='w-20' value={chunkQuads} step={8} min={8} max={64}
            onChange={(v) => setChunkQuads(Math.max(8, Math.min(64, v)))} />
        </div>
        <Hint>Smaller chunks give finer culling and LOD granularity, at more draw calls.</Hint>

        <Button className='w-full' variant={pending ? 'primary' : 'default'} disabled={!pending || busy} onClick={rebuild}>
          {busy ? 'Rebuilding…' : 'Rebuild terrain'}
        </Button>
        {pending && (
          <Hint>
            Rebuilds at the new settings, resampling the sculpted shape, the painted layers and the
            scattered foliage onto it. Nothing you authored is lost.
          </Hint>
        )}

        <div className='pt-2 border-t border-control space-y-2'>
          <div className='flex items-center justify-between'>
            <span className={label} title='World height the brightest pixel of an imported heightmap maps to'>
              Amplitude
            </span>
            <NumberInput className='w-20' value={amplitude} step={1} onChange={setAmplitude} />
          </div>
          <div className='flex gap-1'>
            <label className='flex-1 bg-control hover:bg-control-hover rounded px-2 py-1 text-xs text-center cursor-pointer'>
              Import heightmap
              <input type='file' className='hidden' accept='.png,.jpg,.jpeg,.bmp'
                onChange={(e) => importHeightmap(e.target.files)} />
            </label>
            <Button size='sm' onClick={exportHeightmap} title='Download the current heightfield as a PNG'>
              Export
            </Button>
          </div>
          <Hint>Importing replaces the sculpted shape; the painted layers and foliage stay.</Hint>
        </div>

        <Hint>Sculpt, paint and scatter foliage in Landscape mode. Move it with the transform gizmo.</Hint>
      </div>
    </Collapsable>
  )
}

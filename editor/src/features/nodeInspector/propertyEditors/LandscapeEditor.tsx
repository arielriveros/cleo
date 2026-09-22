import { useEffect, useState } from 'react'
import { LandscapeNode, Logger, Loader, decodeHeightmap, imageFromHeights, encodePng16, encodeRaw16 } from 'cleo'
import type { HeightImage } from 'cleo'
import Collapsable from '../../../components/Collapsable'
import { Button, Hint, NumberInput, Popover } from '../../../components/ui'
import { useCleoEngine } from '../../EngineContext'
import { useHistory } from '../../HistoryContext'
import { rebuildTerrain } from '../../landscape/rebuildTerrain'
import { applyHeightsTo } from '../../landscape/heightmapImport'
import HeightmapImportDialog from '../../landscape/HeightmapImportDialog'
import { setTerrainHeights } from '../../../utils/terrainAccess'
import { clamp } from '../../../utils/math';

// Node inspector for a LandscapeNode: the terrain's STRUCTURE — size, sampling, chunking — plus the
// heightmap import/export that replaces its shape wholesale. Landscape mode holds the brushes that edit it.

const label = 'text-xs text-gray-300'

const RESOLUTION_HINT = 'Height samples per side. More detail, more memory. A layer’s height map is drawn by the parallax march, not by these vertices, so Resolution controls the terrain’s SHAPE and a material’s Depth controls its surface relief.'
const MASK_HINT = 'Texels per side of the paint masks. Independent of Resolution: a road wants a finer mask than the ground wants vertices. 1024 over 200 m is 20 cm per texel.'
const MASK_SIZES = [256, 512, 1024, 2048] as const
const CHUNK_QUADS_HINT = 'Quads per side of each render chunk: the unit of frustum culling and distance LOD. Smaller chunks give finer culling and LOD granularity, at more draw calls.'
const REBUILD_HINT = 'Rebuilds at the current settings, resampling the sculpted shape, the painted layers and the scattered foliage onto it. Nothing you authored is lost.'
const IMPORT_HINT = 'Replace the sculpted shape from a heightmap: 16-bit PNG or RAW (R16) at full precision, JPG/BMP at 8 bits. You choose the height range and see it on the landscape before committing; the painted layers and foliage stay.'

/** Decode a picked heightmap: PNG and RAW at full precision, anything else through the browser at 8 bits. */
async function decodeHeightmapFile(file: File): Promise<HeightImage> {
  const lower = file.name.toLowerCase()
  if (lower.endsWith('.png') || lower.endsWith('.raw') || lower.endsWith('.r16'))
    return decodeHeightmap(new Uint8Array(await file.arrayBuffer()))
  const url = URL.createObjectURL(file)
  try {
    const img = await Loader.ImageToArray(url)
    const data = new Float32Array(img.width * img.height)
    for (let i = 0; i < data.length; i++) data[i] = img.data[i * 4] / 255
    return { width: img.width, height: img.height, data, bitDepth: 8 }
  } finally { URL.revokeObjectURL(url) }
}

function download(bytes: Uint8Array, name: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function LandscapeEditor(props: { node: LandscapeNode }) {
  const { eventEmitter, editorScene, withoutDirty } = useCleoEngine()
  const { push } = useHistory()
  const [pendingImport, setPendingImport] = useState<{ image: HeightImage; fileName: string } | null>(null)
  // For DISPLAY only. Every action below reads `props.node.terrain` when it runs: a rebuild replaces the
  // Terrain object on the node, and a closure holding this one would write into the disposed original.
  const terrain = props.node.terrain

  // Staged, not live: a rebuild reallocates every chunk and resamples the splat and the foliage.
  // Read from `config`, not the `size`/`resolution` getters, which report the derived (clamped) values.
  const cfg = terrain.config
  const [size, setSize] = useState(cfg.size)
  const [resolution, setResolution] = useState(cfg.resolution)
  const [chunkQuads, setChunkQuads] = useState(cfg.chunkQuads)
  const [maskResolution, setMaskResolution] = useState(cfg.maskResolution)
  const [busy, setBusy] = useState(false)
  const [importing, setImporting] = useState(false)
  // Bumped after a rebuild so the panel re-renders against the NEW terrain. The rebuild's own
  // setBusy(true)/setBusy(false) pair batches to "no change", which is how the panel used to stay
  // bound to the old one.
  const [, setRevision] = useState(0)

  // A different Terrain object (a rebuild, or an undo that re-parsed the node) re-bases the staged fields.
  useEffect(() => {
    setSize(terrain.config.size)
    setResolution(terrain.config.resolution)
    setChunkQuads(terrain.config.chunkQuads)
    setMaskResolution(terrain.config.maskResolution)
  }, [terrain])

  const pending = size !== cfg.size || resolution !== cfg.resolution || chunkQuads !== cfg.chunkQuads
    || maskResolution !== cfg.maskResolution

  // One vertex per height-grid point. There was briefly a "Relief detail" control here that multiplied
  // the render mesh's density, because a paint layer's height map was baked into the vertices and the
  // grid was the only thing that could carry it. Layer relief is a parallax march again, so extra
  // vertices carry nothing a bilinear subdivision would not, and the mesh is the height grid.
  const chunksPerSide = Math.ceil((resolution - 1) / chunkQuads)
  const totalVerts = Math.pow(chunkQuads + 1, 2) * chunksPerSide * chunksPerSide
  const totalMB = (totalVerts * 56) / 1048576

  const rebuild = () => {
    setBusy(true)
    try {
      // withoutDirty: swapping the terrain removes and re-adds every chunk node, and each of those
      // would otherwise be its own undo step — two per chunk, enough to evict the whole history. The
      // payload-less SCENE_CHANGED below is the rebuild's one dirty signal.
      withoutDirty(() => rebuildTerrain(props.node, { size, resolution, chunkQuads, maskResolution }))
      eventEmitter.emit('SCENE_CHANGED')
      // The whole terrain was replaced, so the history's snapshot baseline for this node is stale: the
      // next rename would otherwise record a diff whose undo also reverted the rebuild.
      eventEmitter.emit('TERRAIN_EDITED', props.node.id)
    } catch (err) {
      Logger.error(`Could not rebuild the landscape: ${err instanceof Error ? err.message : err}`, 'Editor')
    } finally {
      setBusy(false)
      setRevision(r => r + 1)
    }
  }

  const importHeightmap = async (file: File | undefined) => {
    if (!file) return
    setImporting(true)
    try {
      // Full precision, a height RANGE, flips/rotation and a live preview — see HeightmapImportDialog.
      setPendingImport({ image: await decodeHeightmapFile(file), fileName: file.name })
    } catch (err) {
      Logger.error(`Could not import heightmap "${file.name}": ${err instanceof Error ? err.message : err}`, 'Editor')
    } finally {
      setImporting(false)
    }
  }

  /** One undo step for a whole-field replacement. The terrain is found by node id when it runs. */
  const commitHeights = (before: Float32Array, after: Float32Array) => {
    const nodeId = props.node.id
    const put = (h: Float32Array) => {
      const node = editorScene.getNodeById(nodeId) as LandscapeNode | null
      if (!node) return
      applyHeightsTo(node, h, setTerrainHeights)
      eventEmitter.emit('SCENE_CHANGED')
      eventEmitter.emit('TERRAIN_EDITED', nodeId)
    }
    put(after) // re-seats the foliage the live preview left where it was
    push({ label: 'Import heightmap', undo: () => put(before), redo: () => put(after) })
  }

  /**
   * Export at full precision. The range rides in the FILE NAME (`_min…_max…`), which the import dialog
   * reads back, so export -> import restores absolute heights instead of stretching them to 0..amplitude.
   */
  const exportHeightmap = async (format: 'png16' | 'raw16' | 'png8') => {
    const terrain = props.node.terrain
    if (format === 'png8') {
      const a = document.createElement('a')
      a.href = terrain.exportHeightmap()
      a.download = 'heightmap.png'
      a.click()
      return
    }
    const { image, min, max } = imageFromHeights(terrain.heights, terrain.resolution)
    const tag = `_min${+min.toFixed(3)}_max${+max.toFixed(3)}`
    if (format === 'png16') download(await encodePng16(image), `heightmap${tag}.png`, 'image/png')
    else download(encodeRaw16(image), `heightmap${terrain.resolution}x${terrain.resolution}${tag}.r16`, 'application/octet-stream')
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
          <span className={label} title={RESOLUTION_HINT}>Resolution</span>
          <NumberInput className='w-20' value={resolution} step={1} min={8} max={513}
            onChange={(v) => setResolution(clamp(v, 8, 513))} />
        </div>
        <div className='flex items-center justify-between'>
          <span className={label} title={CHUNK_QUADS_HINT}>
            Chunk quads
          </span>
          <NumberInput className='w-20' value={chunkQuads} step={8} min={8} max={64}
            onChange={(v) => setChunkQuads(clamp(v, 8, 64))} />
        </div>
        <div className='flex items-center justify-between'>
          <span className={label} title={MASK_HINT}>Paint resolution</span>
          <select className='w-20 bg-surface-raised text-white border border-control-hover rounded px-1 py-[2px] text-xs'
            value={maskResolution} onChange={e => setMaskResolution(Number(e.target.value))}>
            {(MASK_SIZES as readonly number[]).includes(maskResolution) ? null : <option value={maskResolution}>{maskResolution}</option>}
            {MASK_SIZES.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <Hint>{totalVerts.toLocaleString()} vertices ({totalMB.toFixed(1)} MB) across the whole terrain.</Hint>

        {/* Enabled even with no pending config change: a rebuild also re-bakes relief and re-resamples
            the layers, which is the natural thing to reach for after editing a terrain material. It used
            to be disabled unless one of the four fields above differed, so pressing it did nothing and
            looked exactly like a rebuild that had run and changed nothing. */}
        <Button className='w-full' variant={pending ? 'primary' : 'default'} disabled={busy} onClick={rebuild} title={REBUILD_HINT}>
          {busy ? 'Rebuilding…' : pending ? 'Rebuild terrain' : 'Rebuild terrain (re-bake relief)'}
        </Button>

        <div className='pt-2 border-t border-control space-y-2'>
          <div className='flex gap-1'>
            <label className='flex-1 bg-control hover:bg-control-hover rounded px-2 py-1 text-xs text-center cursor-pointer'
              title={IMPORT_HINT}>
              {importing ? 'Importing…' : 'Import heightmap'}
              <input type='file' className='hidden' accept='.png,.jpg,.jpeg,.bmp,.raw,.r16' disabled={importing}
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  // Cleared so picking the SAME file again still fires `change`. Without it a second pick
                  // of one file was silently ignored.
                  e.target.value = ''
                  void importHeightmap(file)
                }} />
            </label>
            <Popover align='right' title='Download the height field' trigger={<span className='text-xs px-2'>Export ▾</span>}>
              <div data-cleo-overlay className='flex flex-col p-1 text-xs min-w-[170px]'>
                <button className='text-left px-2 py-1 rounded hover:bg-control-hover' onClick={() => exportHeightmap('png16')}
                  title='Full precision; the height range is kept in the file name'>16-bit PNG</button>
                <button className='text-left px-2 py-1 rounded hover:bg-control-hover' onClick={() => exportHeightmap('raw16')}
                  title='Headerless little-endian R16, as Unreal, Unity and World Machine read it'>RAW (R16)</button>
                <button className='text-left px-2 py-1 rounded hover:bg-control-hover text-muted' onClick={() => exportHeightmap('png8')}
                  title='256 levels, normalised to the terrain’s own range'>8-bit PNG</button>
              </div>
            </Popover>
          </div>
        </div>

        <Hint>Sculpt, paint and scatter foliage in Landscape mode. Move it with the transform gizmo.</Hint>
      </div>
      {pendingImport && (
        <HeightmapImportDialog node={props.node} scene={editorScene} image={pendingImport.image} fileName={pendingImport.fileName}
          onClose={() => setPendingImport(null)} onCommit={commitHeights} />
      )}
    </Collapsable>
  )
}

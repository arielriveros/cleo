import React, { useState } from 'react'
import { LandscapeNode } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import { applyTerrainMaterialToLayer } from '../../utils/terrainMaterials'
import { Toggle } from '../../components/ui'

// The active-paint-layer control in the Landscape inspector: a terrain-material slot (drop / link /
// edit / clear) plus per-layer blend overrides (tiling + automatic height/slope masking). Assigning a
// terrain material reads its surface into the composite terrain material; the overrides tweak this layer.
export default function TerrainLayerSlot(props: { landscape: LandscapeNode | null; layerIndex: number }) {
  const { terrainMaterials, enterTerrainMaterialEditor, eventEmitter } = useCleoEngine()
  const [dragOver, setDragOver] = useState(false)
  const [, force] = useState(0)
  const rerender = () => force(x => x + 1)

  const terrain = props.landscape?.terrain ?? null
  const layer = terrain ? terrain.layers[props.layerIndex] : undefined
  const asset = layer?.materialId ? terrainMaterials.find(m => m.id === layer.materialId) : undefined

  const label = 'text-xs text-gray-300'
  const num = 'w-14 bg-surface-raised text-white border border-control-hover rounded px-1 py-[2px] text-xs'

  if (!terrain) return <div className='text-[10px] text-gray-400'>Create a terrain first.</div>

  const assign = (id: string) => {
    const a = terrainMaterials.find(m => m.id === id)
    if (!a) return
    applyTerrainMaterialToLayer(terrain, props.layerIndex, a)
    eventEmitter.emit('TEXTURES_CHANGED'); eventEmitter.emit('SCENE_CHANGED'); rerender()
  }
  const clear = () => { terrain.clearLayer(props.layerIndex); eventEmitter.emit('SCENE_CHANGED'); rerender() }
  const setBlend = (patch: any) => { terrain.setLayer(props.layerIndex, undefined, patch); eventEmitter.emit('SCENE_CHANGED'); rerender() }
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false)
    const id = e.dataTransfer.getData('text/cleo-terrain-material')
    if (id) assign(id)
  }
  const onDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('text/cleo-terrain-material')) { e.preventDefault(); setDragOver(true) }
  }

  return (
    <div onDragOver={onDragOver} onDragLeave={() => setDragOver(false)} onDrop={onDrop}
      className={`space-y-1 border rounded p-2 ${dragOver ? 'border-selected' : 'border-control'}`}>
      {asset ? (
        <div className='flex items-center gap-2'>
          <div className='w-10 h-10 rounded overflow-hidden bg-surface-raised flex items-center justify-center shrink-0'>
            {asset.thumbnail ? <img src={asset.thumbnail} className='w-full h-full object-cover' alt={asset.name} /> : <span>🏔️</span>}
          </div>
          <span className='truncate flex-1 text-xs' title={asset.name}>{asset.name}</span>
          <button className='text-blue-300 px-1' title='Edit this terrain material' onClick={() => enterTerrainMaterialEditor(asset.id)}>✎</button>
          <button className='text-red-300 px-1' title='Clear this layer' onClick={clear}>✕</button>
        </div>
      ) : (
        <div className='flex flex-col gap-1'>
          {layer?.materialId && <p className='text-[10px] text-warning'>Linked terrain material missing from the library.</p>}
          {terrainMaterials.length > 0 ? (
            <select className={`${num} w-full`} value='' onChange={e => { if (e.target.value) assign(e.target.value) }}>
              <option value=''>Link terrain material…</option>
              {terrainMaterials.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          ) : <p className='text-[10px] text-gray-400'>Create one in the “Terrain Mat.” tab.</p>}
          <p className='text-[10px] text-gray-400'>…or drag one here.</p>
        </div>
      )}

      <div className='flex items-center justify-between pt-1'>
        <span className={label}>Tiling</span>
        <input type='number' className={num} value={layer?.tiling ?? 20} onChange={e => setBlend({ tiling: Number(e.target.value) })} />
      </div>
      <div className='flex items-center justify-between'>
        <span className={label}>Auto (height/slope)</span>
        <Toggle checked={!!layer?.auto} onChange={c => setBlend({ auto: c })} />
      </div>
      {layer?.auto && <>
        <div className='flex items-center justify-between'>
          <span className={label}>Height min/max</span>
          <span className='flex gap-1'>
            <input type='number' className={num} value={layer.hRange[0]} onChange={e => setBlend({ hRange: [Number(e.target.value), layer.hRange[1]] })} />
            <input type='number' className={num} value={layer.hRange[1]} onChange={e => setBlend({ hRange: [layer.hRange[0], Number(e.target.value)] })} />
          </span>
        </div>
        <div className='flex items-center justify-between'>
          <span className={label}>Slope min/max</span>
          <span className='flex gap-1'>
            <input type='number' step={0.05} className={num} value={layer.sRange[0]} onChange={e => setBlend({ sRange: [Number(e.target.value), layer.sRange[1]] })} />
            <input type='number' step={0.05} className={num} value={layer.sRange[1]} onChange={e => setBlend({ sRange: [layer.sRange[0], Number(e.target.value)] })} />
          </span>
        </div>
      </>}
    </div>
  )
}

import React from 'react'
import { useCleoEngine } from '../EngineContext'
import { useAssetDrop } from '../../utils/useAssetDrop'
import type { TerrainMaterialAsset } from '../../utils/terrainMaterials'

// One landscape-material slot of the layer stack — the base, or a paint layer — as a compact control:
// thumbnail and name when linked, a link picker when not, and a drop target either way. Assignment is
// the CALLER's (the layers panel records it for undo); this only reports which asset was chosen.

export interface LandscapeMaterialSlotProps {
  /** The linked asset id, or null. */
  materialId: string | null
  /** The layer carries an embedded material even when its library link is gone. */
  hasEmbedded: boolean
  onAssign: (asset: TerrainMaterialAsset) => void
  onClear?: () => void
  /** Show a smaller one-line form, for a paint-layer row. */
  compact?: boolean
}

export default function LandscapeMaterialSlot({ materialId, hasEmbedded, onAssign, onClear, compact }: LandscapeMaterialSlotProps) {
  const { terrainMaterials, enterTerrainMaterialEditor } = useCleoEngine()
  const asset = materialId ? terrainMaterials.find(m => m.id === materialId) : undefined
  const assign = (id: string) => { const a = terrainMaterials.find(m => m.id === id); if (a) onAssign(a) }
  const { dragOver, dropProps } = useAssetDrop('text/cleo-terrain-material', assign, { stopPropagation: true })

  const thumb = compact ? 'w-7 h-7' : 'w-10 h-10'
  const frame = `flex items-center gap-2 rounded border px-1 py-1 ${dragOver ? 'border-selected bg-control' : 'border-control'}`

  if (asset) {
    return (
      <div {...dropProps} className={frame} title='Drop a landscape material here to replace it'>
        <div className={`${thumb} rounded overflow-hidden bg-surface-raised shrink-0`}>
          {asset.thumbnail && <img src={asset.thumbnail} className='w-full h-full object-cover' alt='' />}
        </div>
        <span className='truncate flex-1 text-xs' title={asset.name}>{asset.name}</span>
        <button className='text-blue-300 px-1 text-xs' title='Edit this landscape material'
          onClick={(e) => { e.stopPropagation(); enterTerrainMaterialEditor(asset.id) }}>✎</button>
        {onClear && <button className='text-red-300 px-1 text-xs' title='Remove the material from this layer'
          onClick={(e) => { e.stopPropagation(); onClear() }}>✕</button>}
      </div>
    )
  }

  return (
    <div {...dropProps} className={frame}>
      <div className='flex-1 min-w-0 space-y-0.5'>
        {materialId && hasEmbedded && <p className='text-[10px] text-warning'>Linked landscape material is missing from the library; its copy still draws.</p>}
        {terrainMaterials.length > 0 ? (
          <select className='w-full bg-surface-raised text-white border border-control-hover rounded px-1 py-[2px] text-xs'
            value='' onClick={e => e.stopPropagation()} onChange={e => { if (e.target.value) assign(e.target.value) }}>
            <option value=''>{hasEmbedded ? 'Replace material…' : 'Choose a landscape material…'}</option>
            {terrainMaterials.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        ) : <p className='text-[10px] text-muted'>Create a Landscape Material in the Assets panel first.</p>}
        {!compact && <p className='text-[10px] text-muted'>…or drag one here.</p>}
      </div>
    </div>
  )
}

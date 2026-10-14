import React from 'react'
import { useCleoEngine } from '../EngineContext'
import { useAssetDrop } from '../../utils/useAssetDrop'
import { Button, Select, cn, hintClass } from '../../components/ui'
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
  const frame = cn('flex items-center gap-2 rounded border px-1 py-1', dragOver ? 'border-selected bg-control' : 'border-control')

  if (asset) {
    return (
      <div {...dropProps} className={frame} title='Drop a landscape material here to replace it'>
        <div className={`${thumb} rounded overflow-hidden bg-surface-raised shrink-0`}>
          {asset.thumbnail && <img src={asset.thumbnail} className='w-full h-full object-cover' alt='' />}
        </div>
        <span className='truncate flex-1 text-ui' title={asset.name}>{asset.name}</span>
        <Button variant='ghost' size='sm' className='px-1 text-highlight hover:text-highlight' title='Edit this landscape material'
          onClick={(e) => { e.stopPropagation(); enterTerrainMaterialEditor(asset.id) }}>✎</Button>
        {onClear && <Button variant='remove' size='sm' className='px-1' title='Remove the material from this layer'
          onClick={(e) => { e.stopPropagation(); onClear() }}>✕</Button>}
      </div>
    )
  }

  return (
    <div {...dropProps} className={frame}>
      <div className='flex-1 min-w-0 space-y-0.5'>
        {materialId && hasEmbedded && <p className={cn(hintClass, 'text-warning')}>Linked landscape material is missing from the library; its copy still draws.</p>}
        {terrainMaterials.length > 0 ? (
          <Select className='w-full px-1 py-0.5'
            value='' onClick={e => e.stopPropagation()} onChange={e => { if (e.target.value) assign(e.target.value) }}>
            <option value=''>{hasEmbedded ? 'Replace material…' : 'Choose a landscape material…'}</option>
            {terrainMaterials.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
        ) : <p className={hintClass}>Create a Landscape Material in the Assets panel first.</p>}
        {!compact && <p className={hintClass}>…or drag one here.</p>}
      </div>
    </div>
  )
}

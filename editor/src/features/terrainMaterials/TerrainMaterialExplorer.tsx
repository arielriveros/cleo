import React from 'react'
import { useCleoEngine } from '../EngineContext'
import { AssetCard } from '../../components/ui'

// Bottom-bar "Terrain Materials" panel: the global terrain-material library. Mirrors MaterialExplorer;
// cards show a rendered sphere thumbnail and are draggable onto a landscape paint layer's slot.
export default function TerrainMaterialExplorer() {
  const { terrainMaterials, enterTerrainMaterialEditor, removeTerrainMaterial } = useCleoEngine()

  const onDragStart = (e: React.DragEvent<HTMLDivElement>, id: string) => {
    e.dataTransfer.setData('text/cleo-terrain-material', id)
    e.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <div className='w-full h-full p-2 text-white text-sm'>
      <div className='flex items-center gap-2 mb-3'>
        <button
          className='flex-1 bg-success hover:bg-success-hover rounded px-2 py-2 text-xs font-semibold'
          onClick={() => enterTerrainMaterialEditor()}
          title='Author a new terrain material (surface + blend + foliage)'>
          + New Terrain Material
        </button>
      </div>

      {terrainMaterials.length === 0 && <p className='text-xs text-gray-500'>No terrain materials yet.</p>}

      <div className='flex flex-wrap gap-2'>
        {terrainMaterials.map(m => (
          <AssetCard key={m.id}
            name={m.name}
            thumbnail={m.thumbnail}
            fallback='🏔️'
            className='border-success'
            draggable
            onDragStart={(e) => onDragStart(e, m.id)}
            title='Drag onto a landscape paint layer to assign'
            actions={<>
              <button className='text-blue-300 text-xs' onClick={(e) => { e.stopPropagation(); enterTerrainMaterialEditor(m.id) }} title='Edit this terrain material'>✎</button>
              <button className='text-red-300 text-xs'
                onClick={(e) => { e.stopPropagation(); if (window.confirm(`Delete terrain material "${m.name}"? Layers using it will be cleared.`)) removeTerrainMaterial(m.id) }}
                title='Delete'>🗑</button>
            </>}
          />
        ))}
      </div>
    </div>
  )
}

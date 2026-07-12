import React from 'react'
import { useCleoEngine } from '../EngineContext'

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
          className='flex-1 bg-[#2c7a2c] hover:bg-[#358535] rounded px-2 py-2 text-xs font-semibold'
          onClick={() => enterTerrainMaterialEditor()}
          title='Author a new terrain material (surface + blend + foliage)'>
          + New Terrain Material
        </button>
      </div>

      {terrainMaterials.length === 0 && <p className='text-xs text-gray-500'>No terrain materials yet.</p>}

      <div className='flex flex-wrap gap-2'>
        {terrainMaterials.map(m => (
          <div key={m.id}
            className='w-[96px] flex flex-col items-center bg-[#3b3b3b] border border-[#2d5d2d] rounded p-1 cursor-grab'
            draggable
            onDragStart={(e) => onDragStart(e, m.id)}
            title='Drag onto a landscape paint layer to assign'>
            <div className='relative w-[80px] h-[80px] rounded overflow-hidden bg-[#202020] flex items-center justify-center'>
              {m.thumbnail
                ? <img src={m.thumbnail} className='w-full h-full object-cover' alt={m.name} draggable={false} />
                : <span className='text-2xl'>🏔️</span>}
            </div>
            <span className='truncate w-full text-center text-xs mt-1' title={m.name}>{m.name}</span>
            <div className='flex gap-3 mt-1'>
              <button className='text-blue-300 text-xs' onClick={(e) => { e.stopPropagation(); enterTerrainMaterialEditor(m.id) }} title='Edit this terrain material'>✎</button>
              <button className='text-red-300 text-xs'
                onClick={(e) => { e.stopPropagation(); if (window.confirm(`Delete terrain material "${m.name}"? Layers using it will be cleared.`)) removeTerrainMaterial(m.id) }}
                title='Delete'>🗑</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

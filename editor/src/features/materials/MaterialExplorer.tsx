import React from 'react'
import { useCleoEngine } from '../EngineContext'

// Bottom-bar "Materials" panel: the global material library. Mirrors TemplateExplorer, but cards show a
// rendered sphere thumbnail and are draggable onto a node's material slot to assign.
export default function MaterialExplorer() {
  const { materials, enterMaterialEditor, removeMaterial } = useCleoEngine()

  const onDragStart = (e: React.DragEvent<HTMLDivElement>, id: string) => {
    e.dataTransfer.setData('text/cleo-material', id)
    e.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <div className='w-full h-full p-2 text-white text-sm'>
      <button
        className='w-full mb-3 bg-[#2c7a2c] hover:bg-[#358535] rounded px-2 py-2 text-xs font-semibold'
        onClick={() => enterMaterialEditor()}
        title='Author a new material on a preview sphere'>
        + New Material
      </button>

      {materials.length === 0 && <p className='text-xs text-gray-500'>No materials yet.</p>}

      <div className='flex flex-wrap gap-2'>
        {materials.map(m => (
          <div key={m.id}
            className='w-[96px] flex flex-col items-center bg-[#3b3b3b] border border-[#2d2d77] rounded p-1 cursor-grab'
            draggable
            onDragStart={(e) => onDragStart(e, m.id)}
            title='Drag onto a node’s material slot to assign'>
            <div className='w-[80px] h-[80px] rounded overflow-hidden bg-[#202020] flex items-center justify-center'>
              {m.thumbnail
                ? <img src={m.thumbnail} className='w-full h-full object-cover' alt={m.name} draggable={false} />
                : <span className='text-2xl'>🎨</span>}
            </div>
            <span className='truncate w-full text-center text-xs mt-1' title={m.name}>{m.name}</span>
            <div className='flex gap-3 mt-1'>
              <button className='text-blue-300 text-xs' onClick={() => enterMaterialEditor(m.id)} title='Edit this material'>✎</button>
              <button className='text-red-300 text-xs'
                onClick={() => { if (window.confirm(`Delete material "${m.name}"? Nodes using it will fall back to a basic material.`)) removeMaterial(m.id) }}
                title='Delete'>🗑</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

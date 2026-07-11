import React, { useEffect, useState } from 'react'
import { useCleoEngine } from '../EngineContext'
import { collectReferencedMaterialIds } from '../../utils/references'
import { useMultiSelect, BatchDeleteBar } from '../explorerSelection'

// Bottom-bar "Materials" panel: the global material library. Mirrors TemplateExplorer, but cards show a
// rendered sphere thumbnail and are draggable onto a node's material slot to assign.
export default function MaterialExplorer() {
  const { materials, meshes, mainScene, eventEmitter, enterMaterialEditor, removeMaterial } = useCleoEngine()

  // Material assets not applied to any placed node (or mesh asset) get a "not referenced" badge. Scene
  // (un)assignments mutate nodes without a React update, so re-render on SCENE_CHANGED.
  const [, bump] = useState(0)
  useEffect(() => {
    const onChange = () => bump(x => x + 1)
    eventEmitter.on('SCENE_CHANGED', onChange)
    return () => { eventEmitter.off('SCENE_CHANGED', onChange) }
  }, [eventEmitter])
  const referencedMaterialIds = collectReferencedMaterialIds(mainScene, meshes)

  const { selected, toggle, clear, has } = useMultiSelect(materials.map(m => m.id))
  const batchDelete = () => {
    if (!window.confirm(`Delete ${selected.size} selected materials? Nodes using them will fall back to a basic material.`)) return
    selected.forEach(id => removeMaterial(id))
    clear()
  }

  const onDragStart = (e: React.DragEvent<HTMLDivElement>, id: string) => {
    e.dataTransfer.setData('text/cleo-material', id)
    e.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <div className='w-full h-full p-2 text-white text-sm'>
      <div className='flex items-center gap-2 mb-3'>
        <button
          className='flex-1 bg-[#2c7a2c] hover:bg-[#358535] rounded px-2 py-2 text-xs font-semibold'
          onClick={() => enterMaterialEditor()}
          title='Author a new material on a preview sphere'>
          + New Material
        </button>
        <BatchDeleteBar count={selected.size} noun='materials' onDelete={batchDelete} onClear={clear} />
      </div>

      {materials.length === 0 && <p className='text-xs text-gray-500'>No materials yet.</p>}

      <div className='flex flex-wrap gap-2'>
        {materials.map(m => (
          <div key={m.id}
            className={`w-[96px] flex flex-col items-center bg-[#3b3b3b] border border-[#2d2d77] rounded p-1 cursor-grab ${has(m.id) ? 'ring-2 ring-[#2c2cff]' : ''}`}
            draggable
            onDragStart={(e) => onDragStart(e, m.id)}
            onClick={() => toggle(m.id)}
            title='Drag onto a node’s material slot to assign'>
            <div className='relative w-[80px] h-[80px] rounded overflow-hidden bg-[#202020] flex items-center justify-center'>
              {!referencedMaterialIds.has(m.id) && (
                <span
                  className='absolute top-0.5 left-0.5 flex items-center justify-center w-4 h-4 rounded-full bg-yellow-400 text-black text-[10px] font-bold leading-none shadow pointer-events-none'
                  title='Not referenced anywhere'
                >!</span>
              )}
              {m.thumbnail
                ? <img src={m.thumbnail} className='w-full h-full object-cover' alt={m.name} draggable={false} />
                : <span className='text-2xl'>🎨</span>}
            </div>
            <span className='truncate w-full text-center text-xs mt-1' title={m.name}>{m.name}</span>
            <div className='flex gap-3 mt-1'>
              <button className='text-blue-300 text-xs' onClick={(e) => { e.stopPropagation(); enterMaterialEditor(m.id) }} title='Edit this material'>✎</button>
              <button className='text-red-300 text-xs'
                onClick={(e) => { e.stopPropagation(); if (window.confirm(`Delete material "${m.name}"? Nodes using it will fall back to a basic material.`)) removeMaterial(m.id) }}
                title='Delete'>🗑</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

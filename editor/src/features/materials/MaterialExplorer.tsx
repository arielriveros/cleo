import React, { useEffect, useState } from 'react'
import { useCleoEngine } from '../EngineContext'
import { collectReferencedMaterialIds } from '../../utils/references'
import { useMultiSelect, BatchDeleteBar } from '../explorerSelection'
import { AssetCard, UnreferencedBadge } from '../../components/ui'

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
          className='flex-1 bg-success hover:bg-success-hover rounded px-2 py-2 text-xs font-semibold'
          onClick={() => enterMaterialEditor()}
          title='Author a new material on a preview sphere'>
          + New Material
        </button>
        <BatchDeleteBar count={selected.size} noun='materials' onDelete={batchDelete} onClear={clear} />
      </div>

      {materials.length === 0 && <p className='text-xs text-gray-500'>No materials yet.</p>}

      <div className='flex flex-wrap gap-2'>
        {materials.map(m => (
          <AssetCard key={m.id}
            name={m.name}
            thumbnail={m.thumbnail}
            fallback='🎨'
            selected={has(m.id)}
            draggable
            onDragStart={(e) => onDragStart(e, m.id)}
            onClick={() => toggle(m.id)}
            title='Drag onto a node’s material slot to assign'
            badge={!referencedMaterialIds.has(m.id) ? <UnreferencedBadge /> : undefined}
            actions={<>
              <button className='text-blue-300 text-xs' onClick={(e) => { e.stopPropagation(); enterMaterialEditor(m.id) }} title='Edit this material'>✎</button>
              <button className='text-red-300 text-xs'
                onClick={(e) => { e.stopPropagation(); if (window.confirm(`Delete material "${m.name}"? Nodes using it will fall back to a basic material.`)) removeMaterial(m.id) }}
                title='Delete'>🗑</button>
            </>}
          />
        ))}
      </div>
    </div>
  )
}

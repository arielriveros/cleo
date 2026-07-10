import React, { useState } from 'react'
import { Node } from 'cleo'
import { useCleoEngine } from '../../EngineContext'
import Collapsable from '../../../components/Collapsable'
import { getMaterialIdOf, applyMaterialAsset, unlinkToFallback } from '../../../utils/materials'

// The material reference control for model/sprite nodes: replaces inline material editing. Shows the
// linked material (thumbnail + edit/unlink) or a create/link affordance when none is set.
export default function MaterialSlot(props: { node: Node }) {
  const { materials, enterMaterialEditor, createMaterialForNode, eventEmitter } = useCleoEngine()
  const [dragOver, setDragOver] = useState(false)
  const [, force] = useState(0) // node mutations don't trigger React; bump to re-read the link

  const linkedId = getMaterialIdOf(props.node)
  const asset = linkedId ? materials.find(m => m.id === linkedId) : undefined

  const link = (id: string) => {
    const a = materials.find(m => m.id === id)
    if (!a) return
    applyMaterialAsset(props.node, a)
    eventEmitter.emit('TEXTURES_CHANGED')
    eventEmitter.emit('SCENE_CHANGED')
    force(x => x + 1)
  }
  const unlink = () => {
    unlinkToFallback(props.node)
    eventEmitter.emit('TEXTURES_CHANGED')
    eventEmitter.emit('SCENE_CHANGED')
    force(x => x + 1)
  }
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false)
    const id = e.dataTransfer.getData('text/cleo-material')
    if (id) link(id)
  }
  const onDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('text/cleo-material')) { e.preventDefault(); setDragOver(true) }
  }

  return (
    <Collapsable title='Material'>
      <div className='w-full p-2' onDragOver={onDragOver} onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
        {asset ? (
          <div className={`flex items-center gap-2 p-2 bg-[#3b3b3b] border rounded ${dragOver ? 'border-[#2c2cff]' : 'border-[#2d2d77]'}`}>
            <div className='w-[48px] h-[48px] rounded overflow-hidden bg-[#202020] flex items-center justify-center shrink-0'>
              {asset.thumbnail
                ? <img src={asset.thumbnail} className='w-full h-full object-cover' alt={asset.name} draggable={false} />
                : <span className='text-lg'>🎨</span>}
            </div>
            <span className='truncate flex-1' title={asset.name}>{asset.name}</span>
            <button className='text-blue-300 px-1' title='Edit this material' onClick={() => enterMaterialEditor(asset.id)}>✎</button>
            <button className='text-red-300 px-1' title='Unlink (revert to a basic material)' onClick={unlink}>✕</button>
          </div>
        ) : (
          <div className={`flex flex-col gap-2 p-2 border-2 border-dashed rounded ${dragOver ? 'border-[#2c2cff] bg-[#2d2d77]/30' : 'border-[#2d2d77]'}`}>
            {linkedId && <p className='text-[11px] text-[#ffd27a]'>Linked material is missing from the library — create or link one below.</p>}
            <button
              className='bg-[#2c7a2c] hover:bg-[#358535] rounded px-2 py-2 text-xs font-semibold'
              onClick={() => createMaterialForNode(props.node)}
              title='Create a reusable material from this node’s current material and edit it'>
              + Create Material
            </button>
            {materials.length > 0 && (
              <select
                className='bg-[#3b3b3b] text-white border border-[#2d2d77] rounded px-2 py-1 text-xs'
                value=''
                onChange={(e) => { if (e.target.value) link(e.target.value) }}>
                <option value=''>Link existing…</option>
                {materials.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            )}
            <p className='text-[11px] text-gray-400'>…or drag a material from the <b>Materials</b> tab here.</p>
          </div>
        )}
      </div>
    </Collapsable>
  )
}

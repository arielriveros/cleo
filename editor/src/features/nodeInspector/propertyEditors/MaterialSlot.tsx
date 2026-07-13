import React, { useState } from 'react'
import { Node } from 'cleo'
import { useCleoEngine } from '../../EngineContext'
import Collapsable from '../../../components/Collapsable'
import { getMaterialIdOf, applyMaterialAsset, unlinkToFallback } from '../../../utils/materials'
import { Select, Button, Hint, cn, valueClass } from '../../../components/ui'
import { MaterialIcon } from '../sectionIcons'

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
    <Collapsable title='Material' icon={<MaterialIcon />} persistKey='materialSlot'>
      <div className='w-full p-2' onDragOver={onDragOver} onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
        {asset ? (
          <div className={`flex items-center gap-2 p-2 bg-control border rounded ${dragOver ? 'border-selected' : 'border-border'}`}>
            <div className='w-[48px] h-[48px] rounded overflow-hidden bg-surface-raised flex items-center justify-center shrink-0'>
              {asset.thumbnail
                ? <img src={asset.thumbnail} className='w-full h-full object-cover' alt={asset.name} draggable={false} />
                : <span className='text-lg'>🎨</span>}
            </div>
            <span className={cn(valueClass, 'truncate flex-1')} title={asset.name}>{asset.name}</span>
            <Button variant='ghost' size='icon' className='text-highlight' title='Edit this material' onClick={() => enterMaterialEditor(asset.id)}>✎</Button>
            <Button variant='ghost' size='icon' className='text-danger' title='Unlink (revert to a basic material)' onClick={unlink}>✕</Button>
          </div>
        ) : (
          <div className={`flex flex-col gap-2 p-2 border-2 border-dashed rounded ${dragOver ? 'border-selected bg-border/30' : 'border-border'}`}>
            {linkedId && <Hint className='text-warning'>Linked material is missing from the library — create or link one below.</Hint>}
            <Button variant='success' className='w-full py-2' onClick={() => createMaterialForNode(props.node)}
              title='Create a reusable material from this node’s current material and edit it'>
              + Create Material
            </Button>
            {materials.length > 0 && (
              <Select value='' onChange={(e) => { if (e.target.value) link(e.target.value) }}>
                <option value=''>Link existing…</option>
                {materials.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </Select>
            )}
            <Hint>…or drag a material from the <b>Materials</b> tab here.</Hint>
          </div>
        )}
      </div>
    </Collapsable>
  )
}

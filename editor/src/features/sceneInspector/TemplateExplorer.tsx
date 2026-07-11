import React, { useState } from 'react'
import { Logger } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import { buildTemplateFromNode, Template } from '../../utils/templates'
import { useMultiSelect, BatchDeleteBar } from '../explorerSelection'

export default function TemplateExplorer() {
  const { editorScene, templates, addTemplate, removeTemplate, scripts, bodies, triggers, enterTemplateEditor } = useCleoEngine()
  const [dragOver, setDragOver] = useState(false)

  // Drop a scene node here (from the Scene tree, which sets text/plain = node id) to save a template.
  const onDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragOver(false)
    const nodeId = e.dataTransfer.getData('text/plain')
    if (!nodeId || !editorScene) return
    const node = editorScene.getNodeById(nodeId)
    if (!node) return
    if (node.name === 'root') { Logger.warn('Cannot template the root node', 'Editor'); return }
    if (!window.confirm(`Create a template from "${node.name}" (including its children, assets and scripts)?`)) return
    try {
      const template = await buildTemplateFromNode(node, { scripts, bodies, triggers })
      addTemplate(template)
      Logger.info(`Template "${template.name}" created`, 'Editor')
    } catch (err) {
      Logger.error('Failed to create template: ' + err, 'Editor')
    }
  }

  const onTemplateDragStart = (e: React.DragEvent<HTMLDivElement>, t: Template) => {
    e.dataTransfer.setData('text/cleo-template', t.id)
    e.dataTransfer.effectAllowed = 'copy'
  }

  const { selected, toggle, clear, has } = useMultiSelect(templates.map(t => t.id))
  const batchDelete = () => {
    if (!window.confirm(`Delete ${selected.size} selected templates? This can't be undone.`)) return
    selected.forEach(id => removeTemplate(id))
    clear()
  }

  return (
    <div className='w-full h-full p-2 text-white text-sm'>
      <div className='flex items-center gap-2 mb-3'>
        <button
          className='flex-1 bg-[#2c7a2c] hover:bg-[#358535] rounded px-2 py-2 text-xs font-semibold'
          onClick={() => enterTemplateEditor()}
          title='Author a new template in a dedicated empty scene'>
          + New Template
        </button>
        <BatchDeleteBar count={selected.size} noun='templates' onDelete={batchDelete} onClear={clear} />
      </div>

      <div
        className={`border-2 border-dashed rounded p-3 mb-3 text-center ${dragOver ? 'border-[#2c2cff] bg-[#2d2d77]/30' : 'border-[#2d2d77]'}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        Or drag a node from the <b>Scene</b> tree here to create a template.
      </div>

      {templates.length === 0 && <p className='text-xs text-gray-500'>No templates yet.</p>}

      <div className='flex flex-col gap-2'>
        {templates.map(t => (
          <div key={t.id}
            className={`flex items-center justify-between px-2 py-2 bg-[#3b3b3b] border border-[#2d2d77] rounded cursor-grab ${has(t.id) ? 'ring-2 ring-[#2c2cff]' : ''}`}
            draggable
            onDragStart={(e) => onTemplateDragStart(e, t)}
            onClick={() => toggle(t.id)}
            title='Drag into the viewport to instantiate'>
            <span className='truncate flex-1'>📦 {t.name}</span>
            <button className='text-blue-300 ml-2' onClick={(e) => { e.stopPropagation(); enterTemplateEditor(t.id) }} title='Edit this template'>Edit</button>
            <button className='text-red-300 ml-2' onClick={(e) => { e.stopPropagation(); removeTemplate(t.id) }}>Delete</button>
          </div>
        ))}
      </div>

      <p className='text-xs text-gray-400 mt-3'>Drag a template into the 3D viewport to add an independent copy.</p>
    </div>
  )
}

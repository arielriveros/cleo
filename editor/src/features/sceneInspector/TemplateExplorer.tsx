import React, { useState } from 'react'
import { Logger } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import { buildTemplateFromNode, Template } from '../../utils/templates'

export default function TemplateExplorer() {
  const { editorScene, templates, addTemplate, removeTemplate, scripts, bodies, triggers } = useCleoEngine()
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

  return (
    <div className='w-full h-full p-2 text-white text-sm'>
      <div
        className={`border-2 border-dashed rounded p-3 mb-3 text-center ${dragOver ? 'border-[#2c2cff] bg-[#2d2d77]/30' : 'border-[#2d2d77]'}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        Drag a node from the <b>Scene</b> tree here to create a template.
      </div>

      {templates.length === 0 && <p className='text-xs text-gray-500'>No templates yet.</p>}

      <div className='flex flex-col gap-2'>
        {templates.map(t => (
          <div key={t.id}
            className='flex items-center justify-between px-2 py-2 bg-[#3b3b3b] border border-[#2d2d77] rounded cursor-grab'
            draggable
            onDragStart={(e) => onTemplateDragStart(e, t)}
            title='Drag into the viewport to instantiate'>
            <span className='truncate'>📦 {t.name}</span>
            <button className='text-red-300 ml-2' onClick={() => removeTemplate(t.id)}>Delete</button>
          </div>
        ))}
      </div>

      <p className='text-xs text-gray-400 mt-3'>Drag a template into the 3D viewport to add an independent copy.</p>
    </div>
  )
}

import React, { useState } from 'react'
import { useCleoEngine } from '../EngineContext'
import { readDroppedEntries } from '../../utils/importGrouping'
import { useMultiSelect, BatchDeleteBar } from '../explorerSelection'
import { AssetCard } from '../../components/ui'

// Bottom-bar "Meshes" panel: the global mesh library. Mirrors MaterialExplorer — cards show a rendered
// thumbnail of the imported model and are draggable into the viewport to instantiate. The header hosts
// the unified importer (multiple files, a whole folder, or a mixed files+folders drag-drop).
export default function MeshExplorer() {
  const { meshes, importMeshFiles, removeMesh } = useCleoEngine()
  const [importing, setImporting] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  const runImport = async (files: File[]) => {
    if (!files.length) return
    setImporting(true)
    try { await importMeshFiles(files) }
    finally { setImporting(false) }
  }

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : []
    e.target.value = '' // allow re-importing the same selection
    runImport(files)
  }

  const onDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault(); setDragOver(false)
    const files = await readDroppedEntries(e.dataTransfer)
    runImport(files)
  }

  const onMeshDragStart = (e: React.DragEvent<HTMLDivElement>, id: string) => {
    e.dataTransfer.setData('text/cleo-mesh', id)
    e.dataTransfer.effectAllowed = 'copy'
  }

  const { selected, toggle, clear, has } = useMultiSelect(meshes.map(m => m.id))
  const batchDelete = () => {
    if (!window.confirm(`Delete ${selected.size} selected meshes? Placed copies stay in the scene.`)) return
    selected.forEach(id => removeMesh(id))
    clear()
  }

  return (
    <div className='w-full h-full p-2 text-white text-sm'>
      <div className='flex items-center gap-2 mb-2'>
        <label className={`bg-success hover:bg-success-hover rounded px-2 py-2 text-xs font-semibold cursor-pointer ${importing ? 'opacity-50 pointer-events-none' : ''}`} htmlFor='mesh-import-files'>
          + Import Files
        </label>
        <input id='mesh-import-files' className='hidden' type='file' multiple
          accept='.obj,.mtl,.gltf,.glb,.fbx,.bin,.png,.jpg,.jpeg,.bmp,.tga,.tiff'
          onChange={onPick} />
        <label className={`bg-control hover:bg-control-hover border border-black rounded px-2 py-2 text-xs font-semibold cursor-pointer ${importing ? 'opacity-50 pointer-events-none' : ''}`} htmlFor='mesh-import-folder'>
          Import Folder
        </label>
        <input id='mesh-import-folder' className='hidden' type='file' {...({ webkitdirectory: '', directory: '' } as any)}
          onChange={onPick} />
        {importing && <span className='text-xs text-warning'>Importing…</span>}
        <BatchDeleteBar count={selected.size} noun='meshes' onDelete={batchDelete} onClear={clear} />
      </div>

      <div
        className={`border-2 border-dashed rounded p-3 mb-3 text-center text-xs ${dragOver ? 'border-selected bg-border/30' : 'border-border'}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        Drag model files <b>and folders</b> here to import. Each model file becomes its own mesh asset.
      </div>

      {meshes.length === 0 && <p className='text-xs text-gray-500'>No meshes yet. Import a model to get started.</p>}

      <div className='flex flex-wrap gap-2'>
        {meshes.map(m => (
          <AssetCard key={m.id}
            name={m.name}
            thumbnail={m.thumbnail}
            fallback='🧊'
            selected={has(m.id)}
            draggable
            onDragStart={(e) => onMeshDragStart(e, m.id)}
            onClick={() => toggle(m.id)}
            title='Drag into the viewport to place'
            actions={
              <button className='text-red-300 text-xs'
                onClick={(e) => { e.stopPropagation(); if (window.confirm(`Delete mesh "${m.name}"? Placed copies stay in the scene.`)) removeMesh(m.id) }}
                title='Delete'>🗑</button>
            }
          />
        ))}
      </div>
    </div>
  )
}

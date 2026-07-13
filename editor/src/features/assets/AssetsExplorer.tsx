import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Logger } from 'cleo'
import { Filemanager, WillowDark, getMenuOptions } from '@svar-ui/react-filemanager'
import type { IFileMenuOption, IParsedEntity, TContextMenuType, TMode } from '@svar-ui/react-filemanager'
// filemanager.css @imports the SVAR stylesheet itself, so the skin's rules deterministically follow it.
import './filemanager.css'

import { useCleoEngine } from '../EngineContext'
import { useVfs } from './VfsContext'
import { useFileManagerBridge, FM_MODE_KEY } from './useFileManagerBridge'
import { useDragOutPatch } from './useDragOutPatch'
import { runUpload } from './uploadRouter'
import { iconFor, thumbnailOf } from './assetKinds'
import { buildFileManagerData, extOf, kindOfExt } from '../../utils/vfs'
import { readDroppedEntries } from '../../utils/importGrouping'
import { buildTemplateFromNode } from '../../utils/templates'

// The bottom bar's single "Assets" tab: one file-manager view over all five asset libraries (textures,
// materials, terrain materials, templates, meshes), with real folders.
//
// The folder layout lives in VfsContext; SVAR's own store owns what's on screen; useFileManagerBridge
// stitches the two together. Creation and import stay in our own toolbar because SVAR's context menu can't
// dispatch custom actions (its performAction is a closed switch over the built-in ids).

export default function AssetsExplorer() {
  const { ready } = useVfs()
  if (!ready) {
    return (
      <div className='w-full h-full flex items-center justify-center text-xs text-muted'>
        Loading assets…
      </div>
    )
  }
  // Mounted only once the index and every library have loaded, so its `data` is complete and can then stay
  // frozen — see the useMemo in the host.
  return <AssetsExplorerHost />
}

function AssetsExplorerHost() {
  const {
    enterMaterialEditor, enterTerrainMaterialEditor, enterTemplateEditor,
    importMeshFiles, addTemplate, editorScene, scripts, bodies, triggers, eventEmitter,
  } = useCleoEngine()
  const { vfs, libs, pathIndexRef, landingFolderRef, depsRef } = useVfs()

  const wrapperRef = useRef<HTMLDivElement>(null)
  const vfsRef = useRef(vfs)
  vfsRef.current = vfs

  const { init, apiRef } = useFileManagerBridge()
  useDragOutPatch(wrapperRef, vfsRef, pathIndexRef, apiRef)

  const [importing, setImporting] = useState(false)
  const importingRef = useRef(false)

  // "+ Add ▾" dropdown: closes on outside pointerdown or Escape.
  const [addOpen, setAddOpen] = useState(false)
  const addMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!addOpen) return
    const onDown = (e: PointerEvent) => {
      if (!addMenuRef.current?.contains(e.target as Node)) setAddOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setAddOpen(false) }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('keydown', onKey) }
  }, [addOpen])

  // Built once, on mount. Re-passing `data` would make SVAR call store.init() and rebuild its whole tree,
  // collapsing every open folder on every change; from here on the tree is kept in sync event by event.
  const initialData = useMemo(() => buildFileManagerData(vfs, libs), [])
  const initialMode = useMemo<TMode>(() => {
    try { return (localStorage.getItem(FM_MODE_KEY) as TMode) || 'cards' } catch { return 'cards' }
  }, [])

  // --- import ---------------------------------------------------------------------------------------
  const runImport = useCallback(async (files: File[]) => {
    if (!files.length || importingRef.current) return
    importingRef.current = true
    setImporting(true)
    try {
      await runUpload(files, {
        importMeshFiles,
        emit: (event: string) => eventEmitter.emit(event as any),
      })
    } catch (err) {
      Logger.error('Import failed: ' + err, 'Editor')
    } finally {
      importingRef.current = false
      setImporting(false)
    }
  }, [importMeshFiles, eventEmitter])

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : []
    e.target.value = '' // let the same selection be re-imported
    runImport(files)
  }

  // --- drops onto the explorer ------------------------------------------------------------------------
  // Capture phase, on purpose. SVAR's <Uploader> registers its own capture-phase drop listener on the
  // inner .wx-upload-area; ours sits on an ancestor, so it runs first and stopPropagation() keeps the file
  // away from it. That matters: SVAR's directory walker drops the folder structure, which would break
  // multi-file model bundles (a .gltf next to its .bin and textures/).
  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return

    const hint = (kind: 'file' | 'node' | null) => {
      el.classList.toggle('is-file-drag', kind === 'file')
      el.classList.toggle('is-node-drag', kind === 'node')
      if (kind === 'file') el.setAttribute('data-drop-hint', 'Drop models, folders or images to import')
      else if (kind === 'node') el.setAttribute('data-drop-hint', 'Drop to save this node as a template')
      else el.removeAttribute('data-drop-hint')
    }

    const kindOfDrag = (e: DragEvent): 'file' | 'node' | null => {
      const types = e.dataTransfer?.types ?? []
      if (types.includes('text/cleo-fm-path')) return null // an internal move; useDragOutPatch owns it
      if (types.includes('Files')) return 'file'
      if (types.includes('text/plain')) return 'node' // a node dragged out of the scene tree
      return null
    }

    const onDragOver = (e: DragEvent) => {
      const kind = kindOfDrag(e)
      if (!kind) return
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      hint(kind)
    }

    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget && el.contains(e.relatedTarget as Node)) return
      hint(null)
    }

    const onDrop = async (e: DragEvent) => {
      const kind = kindOfDrag(e)
      if (!kind || !e.dataTransfer) return
      e.preventDefault()
      e.stopPropagation()
      hint(null)

      if (kind === 'file') {
        const files = await readDroppedEntries(e.dataTransfer) // preserves each file's folder path
        await runImport(files)
        return
      }

      // A node from the scene tree becomes a template — what the old Templates tab's drop zone did, except
      // the whole explorer is now the drop zone.
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

    el.addEventListener('dragover', onDragOver, true)
    el.addEventListener('dragleave', onDragLeave, true)
    el.addEventListener('drop', onDrop, true)
    return () => {
      el.removeEventListener('dragover', onDragOver, true)
      el.removeEventListener('dragleave', onDragLeave, true)
      el.removeEventListener('drop', onDrop, true)
    }
  }, [runImport, editorScene, scripts, bodies, triggers, addTemplate])

  // --- file-manager rendering hooks -------------------------------------------------------------------
  // Stable identities: SVAR memoizes its `templates` (preview/icon) object, and a changing `data`/config
  // prop re-inits the store. Everything these need is read through refs.
  const previews = useCallback((file: Partial<IParsedEntity>): string | null => {
    if (!file?.id || file.type === 'folder') return null
    const entry = pathIndexRef.current.get(file.id)
    return entry ? thumbnailOf(entry.kind, entry.assetId, depsRef.current) : null
  }, [pathIndexRef, depsRef])

  const icons = useCallback((file: Partial<IParsedEntity>): string => {
    if (!file?.id || file.type === 'folder') return iconFor('folder')
    const entry = pathIndexRef.current.get(file.id)
    return iconFor(entry ? entry.kind : kindOfExt(extOf(file.id)))
  }, [pathIndexRef])

  const newFolder = useCallback(() => apiRef.current?.exec('create-file', {
    file: { name: 'New folder', type: 'folder' },
    parent: landingFolderRef.current,
  }), [apiRef, landingFolderRef])

  const menuOptions = useCallback((mode: TContextMenuType): IFileMenuOption[] => {
    const options = getMenuOptions(mode).filter(o => o.id !== 'download') as IFileMenuOption[]
    // Right-clicking empty space offers folder creation (SVAR's default body menu is Paste only). The id
    // is custom, so SVAR's own performAction ignores it — the capture-phase click listener below runs it.
    if (mode === 'body') return [{ id: 'cleo-new-folder', icon: 'wxi-folder', text: 'New folder' }, ...options]
    return options
  }, [])

  // SVAR's context menu portals to <body> and its performAction is a closed switch over the built-in
  // action ids — a custom option renders fine but its click goes nowhere. Catch it at the document level.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest?.('[data-id=":cleo-new-folder"]')) newFolder()
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [newFolder])

  // One compact 28px strip — every pixel here comes out of the card area below, which at a 30vh bottom
  // bar has only ~130px to show a full card row including its name.
  const btn = 'shrink-0 inline-flex items-center h-[20px] px-2 rounded text-[11px] font-semibold leading-none whitespace-nowrap cursor-pointer'
  const addItems: { label: string; kind: Parameters<typeof iconFor>[0]; run: () => void; title: string }[] = [
    { label: 'Material', kind: 'material', run: () => enterMaterialEditor(), title: 'Create a new material asset' },
    { label: 'Terrain Material', kind: 'terrainMaterial', run: () => enterTerrainMaterialEditor(), title: 'Create a new terrain material asset' },
    { label: 'Template', kind: 'template', run: () => enterTemplateEditor(), title: 'Author a new template in a dedicated empty scene' },
    { label: 'Folder', kind: 'folder', run: newFolder, title: 'Create a folder in the current directory' },
  ]
  return (
    <div className='w-full h-full flex flex-col text-sm'>
      <div className='h-[28px] flex items-center gap-1.5 px-2 border-b border-border-subtle shrink-0 bg-surface-sunken'>
        <div className='relative shrink-0' ref={addMenuRef}>
          <button
            className={`${btn} bg-success hover:bg-success-hover`}
            onClick={() => setAddOpen(v => !v)}
            title='Add a new asset or folder'>
            + Add <span className='ml-1 text-[9px]'>▾</span>
          </button>
          {addOpen && (
            <div className='absolute left-0 top-[22px] z-20 min-w-[160px] py-1 bg-surface-raised border border-border rounded shadow-lg'>
              {addItems.map(item => (
                <button key={item.label}
                  className='w-full flex items-center gap-2 h-[24px] px-2 text-[11px] text-left whitespace-nowrap hover:bg-selected/30'
                  onClick={() => { setAddOpen(false); item.run() }}
                  title={item.title}>
                  <img src={iconFor(item.kind)} className='w-3.5 h-3.5' alt='' draggable={false} />
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <span className='w-px h-4 bg-border-subtle mx-0.5 shrink-0' />

        <label
          htmlFor='asset-import-files'
          className={`${btn} bg-control hover:bg-control-hover border border-border ${importing ? 'opacity-50 pointer-events-none' : ''}`}
          title='Import models and textures'>
          Import Files
        </label>
        <input id='asset-import-files' className='hidden' type='file' multiple
          accept='.obj,.mtl,.gltf,.glb,.fbx,.bin,.png,.jpg,.jpeg,.bmp,.tga,.tiff,.webp'
          onChange={onPick} />

        <label
          htmlFor='asset-import-folder'
          className={`${btn} bg-control hover:bg-control-hover border border-border ${importing ? 'opacity-50 pointer-events-none' : ''}`}
          title='Import a whole folder of models and textures'>
          Import Folder
        </label>
        <input id='asset-import-folder' className='hidden' type='file'
          {...({ webkitdirectory: '', directory: '' } as any)}
          onChange={onPick} />

        {importing && <span className='shrink-0 text-[11px] text-warning whitespace-nowrap'>Importing…</span>}

        <span className='ml-auto min-w-0 truncate text-[11px] text-dim hidden xl:inline'>
          Drag assets into the viewport or onto a slot · drop files here to import
        </span>
      </div>

      <div ref={wrapperRef} className='cleo-fm relative flex-1 min-h-0'>
        <WillowDark fonts={false}>
          <Filemanager
            data={initialData}
            mode={initialMode}
            preview={false}
            previews={previews}
            icons={icons}
            menuOptions={menuOptions}
            init={init}
          />
        </WillowDark>
      </div>
    </div>
  )
}

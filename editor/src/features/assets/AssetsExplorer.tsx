import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Logger } from 'cleo'
import { confirmDialog } from '../dialogs/dialogStore'
import { Filemanager, WillowDark, getMenuOptions } from '@svar-ui/react-filemanager'
import type { IFileMenuOption, IParsedEntity, TContextMenuType, TMode } from '@svar-ui/react-filemanager'
// filemanager.css @imports the SVAR stylesheet itself, so the skin's rules deterministically follow it.
import './filemanager.css'
import { installBadgeStyles } from './badgeStyles'

import { useCleoEngine } from '../EngineContext'
import { useVfs } from './VfsContext'
import { useFileManagerBridge, FM_MODE_KEY } from './useFileManagerBridge'
import { useDragOutPatch } from './useDragOutPatch'
import { runUpload } from './uploadRouter'
import { badgeStyles, iconFor, thumbnailOf } from './assetKinds'
import MissingAssetsPopover from './MissingAssetsPopover'
import { baseOf, buildFileManagerData, extOf, kindOfExt, findMissingFromExplorer, findOrphanEntries } from '../../utils/vfs'
import { readDroppedEntries } from '../../utils/importGrouping'
import { buildTemplateFromNode } from '../../utils/templates'
import { hoveredScriptStore } from '../sceneInspector/hoveredScriptStore'

// The bottom bar's single "Assets" tab: one file-manager view over all five asset libraries, with real
// folders. Folder layout lives in VfsContext, SVAR's store owns what is on screen, useFileManagerBridge
// stitches them together. Creation and import stay in our toolbar: SVAR's performAction is a closed switch.

// The per-kind card badges. Generated from the icon and extension tables rather than written into
// filemanager.css, so they cannot drift from the icons they mirror — see `badgeStyles`.
installBadgeStyles()

export default function AssetsExplorer() {
  const { ready } = useVfs()
  if (!ready) {
    return (
      <div className='w-full h-full flex items-center justify-center text-xs text-muted'>
        Loading assets…
      </div>
    )
  }
  // Mounted only once the index and every library have loaded, so its `data` is complete and stays frozen.
  return <AssetsExplorerHost />
}

function AssetsExplorerHost() {
  const {
    enterMaterialEditor, enterTerrainMaterialEditor, enterTemplateEditor, enterScriptEditor, createTilesetFromImage, importAnimationFiles,
    importModelFiles, addTemplate, createScene, editorScene, scripts, bodies, triggers, eventEmitter,
  } = useCleoEngine()
  const { vfs, libs, pathIndexRef, folderKindsRef, landingFolderRef, depsRef } = useVfs()

  const wrapperRef = useRef<HTMLDivElement>(null)
  const vfsRef = useRef(vfs)
  vfsRef.current = vfs

  const { init, apiRef } = useFileManagerBridge()
  useDragOutPatch(wrapperRef, vfsRef, pathIndexRef, apiRef)

  const [importing, setImporting] = useState(false)
  const importingRef = useRef(false)

  // Audit: assets a library holds but the explorer is not showing. Checked against BOTH the index and the
  // file manager's live store — the two can disagree, and which one dropped the asset is the useful part.
  const [missingOpen, setMissingOpen] = useState(false)
  const missingMenuRef = useRef<HTMLDivElement>(null)
  const missing = useMemo(() => {
    const treeIds = new Set((apiRef.current?.serialize('/') ?? []).map((e: any) => e.id))
    return findMissingFromExplorer(vfs, libs, treeIds.size ? treeIds : undefined)
  }, [vfs, libs, apiRef, missingOpen])

  // The opposite direction: entries pointing at an asset that does not exist. They keep their path
  // reserved, so re-importing the same file comes back as "Rock (2)".
  const orphans = useMemo(() => findOrphanEntries(vfs, libs), [vfs, libs])
  const audited = missing.length + orphans.length

  useEffect(() => {
    if (!missingOpen) return
    const onDown = (e: PointerEvent) => {
      if (!missingMenuRef.current?.contains(e.target as Node)) setMissingOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMissingOpen(false) }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('keydown', onKey) }
  }, [missingOpen])

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

  // Built once, on mount: re-passing `data` makes SVAR call store.init() and collapse every open folder.
  const initialData = useMemo(() => buildFileManagerData(vfs, libs), [])
  const initialMode = useMemo<TMode>(() => {
    try { return (localStorage.getItem(FM_MODE_KEY) as TMode) || 'cards' } catch { return 'cards' }
  }, [])

  // SVAR's own toolbar is hidden (filemanager.css); these mirror its state and drive it through the
  // store's actions.
  const [previewOpen, setPreviewOpen] = useState(false)
  const [viewMode, setViewMode] = useState<TMode>(initialMode)
  const [search, setSearch] = useState('')
  const searchStartedRef = useRef(false)
  useEffect(() => {
    if (!searchStartedRef.current) { searchStartedRef.current = true; return }
    const t = window.setTimeout(() => apiRef.current?.exec('filter-files', { text: search }), 200)
    return () => window.clearTimeout(t)
  }, [search, apiRef])

  const togglePreview = () => {
    const next = !previewOpen
    setPreviewOpen(next)
    apiRef.current?.exec('show-preview', { mode: next })
  }
  const setMode = (mode: TMode) => {
    setViewMode(mode)
    apiRef.current?.exec('set-mode', { mode }) // the bridge persists it to localStorage
  }

  // --- import ---------------------------------------------------------------------------------------
  const runImport = useCallback(async (files: File[]) => {
    if (!files.length || importingRef.current) return
    importingRef.current = true
    setImporting(true)
    try {
      await runUpload(files, {
        importModelFiles,
        emit: (event: string) => eventEmitter.emit(event as any),
      })
    } catch (err) {
      Logger.error('Import failed: ' + err, 'Editor')
    } finally {
      importingRef.current = false
      setImporting(false)
    }
  }, [importModelFiles, eventEmitter])

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : []
    e.target.value = '' // let the same selection be re-imported
    runImport(files)
  }

  // --- drops onto the explorer ------------------------------------------------------------------------
  // Capture phase: SVAR's <Uploader> has its own capture-phase drop listener on the inner .wx-upload-area,
  // so an ancestor listener runs first and stopPropagation() keeps the file away from it. SVAR's directory
  // walker drops the folder structure, which breaks multi-file model bundles.
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
      // Only the scene tree's dedicated MIME counts as a node: dock-panel and doc-tab drags also carry
      // text/plain-ish payloads and must not light up "save as template".
      if (types.includes('text/cleo-node')) return 'node'
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

      // A node from the scene tree becomes a template; the whole explorer is the drop zone.
      const nodeId = e.dataTransfer.getData('text/cleo-node')
      if (!nodeId || !editorScene) return
      const node = editorScene.getNodeById(nodeId)
      if (!node) return
      if (node.name === 'root') { Logger.warn('Cannot template the root node', 'Editor'); return }
      const proceed = await confirmDialog({
        title: `Create a template from "${node.name}"?`,
        message: 'Its children, assets and scripts are captured with it, and it becomes reusable across scenes.',
        confirmLabel: 'Create template',
      })
      if (!proceed) return
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

  // Hovering a script card highlights every node icon in the scene tree that references it. Delegated over
  // the SVAR DOM: cards are `.wx-item[data-id]` / `.wx-row[data-id]` and data-id is the VFS path
  // (setID prefixes ':').
  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    const resolveScriptId = (target: EventTarget | null): string | null => {
      const card = (target as HTMLElement | null)?.closest?.('.wx-item[data-id], .wx-row[data-id]')
      const raw = card?.getAttribute('data-id')
      const path = raw ? (raw.startsWith(':') ? raw.slice(1) : raw) : null
      const entry = path ? pathIndexRef.current.get(path) : undefined
      return entry?.kind === 'script' ? entry.assetId : null
    }
    const onOver = (e: Event) => { const id = resolveScriptId(e.target); if (id) hoveredScriptStore.set(id) }
    const onOut = (e: Event) => { if (resolveScriptId(e.target)) hoveredScriptStore.set(null) }
    el.addEventListener('mouseover', onOver)
    el.addEventListener('mouseout', onOut)
    return () => { el.removeEventListener('mouseover', onOver); el.removeEventListener('mouseout', onOut); hoveredScriptStore.set(null) }
  }, [pathIndexRef])

  // A card label is ellipsized at 80px and SVAR renders no title of its own. Written on hover, not up
  // front: card elements are React-reused across renames and would keep a stale title.
  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    const onOver = (e: Event) => {
      const card = (e.target as HTMLElement | null)?.closest?.('.wx-cards .wx-item[data-id]') as HTMLElement | null
      if (!card || card.closest('.wx-breadcrumbs')) return // the breadcrumb bar reuses .wx-item
      const raw = card.getAttribute('data-id') ?? ''
      const path = raw.startsWith(':') ? raw.slice(1) : raw // setID prefixes every DOM id with ':'
      if (!path.startsWith('/')) return
      const name = baseOf(path)
      if (card.getAttribute('title') !== name) card.setAttribute('title', name)
    }
    el.addEventListener('mouseover', onOver)
    return () => el.removeEventListener('mouseover', onOver)
  }, [])

  // --- file-manager rendering hooks -------------------------------------------------------------------
  // Stable identities: SVAR memoizes its `templates` object and a changing `data`/config prop re-inits
  // the store, so everything these need is read through refs.
  const previews = useCallback((file: Partial<IParsedEntity>): string | null => {
    if (!file?.id || file.type === 'folder') return null
    const entry = pathIndexRef.current.get(file.id)
    return entry ? thumbnailOf(entry.kind, entry.assetId, depsRef.current) : null
  }, [pathIndexRef, depsRef])

  const icons = useCallback((file: Partial<IParsedEntity>): string => {
    if (!file?.id) return iconFor('folder')
    // A folder holding exactly one kind wears that kind's icon — which is what makes the `Source`
    // subfolder full of images read as images at a glance, and its parent read as textures.
    if (file.type === 'folder') {
      const only = folderKindsRef.current.get(file.id)
      return iconFor(only ?? 'folder')
    }
    const entry = pathIndexRef.current.get(file.id)
    return iconFor(entry ? entry.kind : kindOfExt(extOf(file.id)))
  }, [pathIndexRef, folderKindsRef])

  const newFolder = useCallback(() => apiRef.current?.exec('create-file', {
    file: { name: 'New folder', type: 'folder' },
    parent: landingFolderRef.current,
  }), [apiRef, landingFolderRef])

  const menuOptions = useCallback((mode: TContextMenuType): IFileMenuOption[] => {
    const options = getMenuOptions(mode).filter(o => o.id !== 'download') as IFileMenuOption[]
    // Right-clicking empty space offers folder creation. The id is custom, so SVAR's performAction ignores
    // it — the capture-phase click listener below runs it.
    if (mode === 'body') return [{ id: 'cleo-new-folder', icon: 'wxi-folder', text: 'New folder' }, ...options]
    return options
  }, [])

  // SVAR's context menu portals to <body> and its performAction is a closed switch over built-in action
  // ids, so a custom option's click goes nowhere. Catch it at the document level.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest?.('[data-id=":cleo-new-folder"]')) newFolder()
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [newFolder])

  // The explorer's entire chrome is ONE 28px row; every saved pixel goes to the card area below, which at
  // a 30vh bottom bar has only ~130px for a full card row.
  const addItems: { label: string; icon: React.ReactNode; run: () => void; title: string }[] = [
    { label: 'Material', icon: <img src={iconFor('material')} className='w-3.5 h-3.5' alt='' draggable={false} />, run: () => enterMaterialEditor(), title: 'Create a new material asset' },
    { label: 'Terrain Material', icon: <img src={iconFor('terrainMaterial')} className='w-3.5 h-3.5' alt='' draggable={false} />, run: () => enterTerrainMaterialEditor(), title: 'Create a new terrain material asset' },
    { label: 'Template', icon: <img src={iconFor('template')} className='w-3.5 h-3.5' alt='' draggable={false} />, run: () => enterTemplateEditor(), title: 'Author a new template in a dedicated empty scene' },
    { label: 'Script', icon: <img src={iconFor('script')} className='w-3.5 h-3.5' alt='' draggable={false} />, run: () => enterScriptEditor(), title: 'Create a new class-based script asset' },
    { label: 'Tileset', icon: <img src={iconFor('tileset')} className='w-3.5 h-3.5' alt='' draggable={false} />, run: () => document.getElementById('tileset-atlas-import')?.click(), title: 'Pick an atlas image and slice it into a tileset for tilemap layers' },
    { label: 'Sound', icon: <img src={iconFor('soundSample')} className='w-3.5 h-3.5' alt='' draggable={false} />, run: () => document.getElementById('sound-import')?.click(), title: 'Import an audio file as a sound sample' },
    { label: 'Animation', icon: <img src={iconFor('animation')} className='w-3.5 h-3.5' alt='' draggable={false} />, run: () => document.getElementById('animation-clip-import')?.click(), title: 'Import animation clips from a .fbx/.glb/.gltf and pick the rig they belong to' },
    { label: 'Scene', icon: <img src={iconFor('scene')} className='w-3.5 h-3.5' alt='' draggable={false} />, run: () => { void createScene() }, title: 'Create a new scene asset' },
    { label: 'Folder', icon: <img src={iconFor('folder')} className='w-3.5 h-3.5' alt='' draggable={false} />, run: newFolder, title: 'Create a folder in the current directory' },
    {
      label: 'Import Files…',
      icon: (
        <svg className='w-3.5 h-3.5' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'>
          <path d='M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' /><path d='M17 8l-5-5-5 5M12 3v12' />
        </svg>
      ),
      run: () => document.getElementById('asset-import-files')?.click(),
      title: 'Import models, textures and sounds',
    },
  ]
  const modeButtons: { mode: TMode; title: string; icon: React.ReactNode }[] = [
    { mode: 'table', title: 'Table view', icon: <svg className='w-3 h-3' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round'><path d='M4 6h16M4 12h16M4 18h16' /></svg> },
    { mode: 'cards', title: 'Cards view', icon: <svg className='w-3 h-3' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2'><rect x='3' y='3' width='7' height='7' rx='1' /><rect x='14' y='3' width='7' height='7' rx='1' /><rect x='3' y='14' width='7' height='7' rx='1' /><rect x='14' y='14' width='7' height='7' rx='1' /></svg> },
    { mode: 'panels', title: 'Split view', icon: <svg className='w-3 h-3' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2'><rect x='3' y='4' width='8' height='16' rx='1' /><rect x='13' y='4' width='8' height='16' rx='1' /></svg> },
  ]
  return (
    <div className='w-full h-full flex flex-col text-sm'>
      <div className='h-[28px] flex items-center gap-1.5 px-2 border-b border-border-subtle shrink-0 bg-surface-sunken'>
        <div className='relative shrink-0' ref={addMenuRef}>
          <button
            className='shrink-0 inline-flex items-center h-[20px] px-2 rounded text-[11px] font-semibold leading-none whitespace-nowrap cursor-pointer bg-success hover:bg-success-hover'
            onClick={() => setAddOpen(v => !v)}
            title='Add a new asset or folder, or import files'>
            + Add <span className='ml-1 text-[9px]'>▾</span>
          </button>
          {addOpen && (
            <div className='absolute left-0 top-[22px] z-20 min-w-[160px] py-1 bg-surface-raised border border-border rounded shadow-lg'>
              {addItems.map(item => (
                <button key={item.label}
                  className='w-full flex items-center gap-2 h-[24px] px-2 text-[11px] text-left whitespace-nowrap hover:bg-selected/30'
                  onClick={() => { setAddOpen(false); item.run() }}
                  title={item.title}>
                  {item.icon}
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <input id='asset-import-files' className='hidden' type='file' multiple
          accept='.obj,.mtl,.gltf,.glb,.fbx,.bin,.png,.jpg,.jpeg,.bmp,.tga,.tiff,.webp,.wav,.mp3,.ogg,.m4a,.flac,.aac,.opus'
          onChange={onPick} />

        {/* Audio. Routed through the same `runUpload` as everything else — the importer branches on the
            extension — so a sound picked here lands exactly as one dropped on the explorer does. */}
        <input id='sound-import' className='hidden' type='file' multiple
          accept='.wav,.mp3,.ogg,.m4a,.flac,.aac,.opus,.webm,audio/*'
          onChange={onPick} />

        {/* "+ Add > Tileset" picks the atlas first and builds the tileset around it, so the new asset opens
            already sliced. Its own input rather than the general importer's: this one takes exactly one
            image and its result is a tileset, not a texture sitting loose in the library. */}
        <input id='tileset-atlas-import' className='hidden' type='file'
          accept='.png,.jpg,.jpeg,.bmp,.gif,.webp'
          onChange={(e) => {
            const file = e.target.files?.item(0)
            // Reset first: picking the same file twice in a row fires no change event otherwise.
            e.target.value = ''
            if (file) void createTilesetFromImage(file)
          }} />

        {/* Animation clips. Its own input, like the tileset one above: the result is a shared animation
            asset, not a model, and the flow asks which rig to retarget onto rather than placing anything. */}
        <input id='animation-clip-import' className='hidden' type='file' multiple
          accept='.fbx,.glb,.gltf,.bin'
          onChange={(e) => {
            const files = Array.from(e.target.files ?? [])
            e.target.value = ''   // picking the same file twice fires no change event otherwise
            if (files.length) void importAnimationFiles(files)
          }} />

        <input
          id='asset-search'
          className='shrink min-w-[80px] w-[200px] h-[20px] px-2 rounded bg-control border border-border text-[11px] text-fg placeholder:text-dim focus:outline-none focus:border-highlight'
          placeholder='Search'
          value={search}
          onChange={e => setSearch(e.target.value)}
        />

        {importing && <span className='shrink-0 text-[11px] text-warning whitespace-nowrap'>Importing…</span>}

        <span className='ml-auto min-w-0 truncate text-[11px] text-dim hidden xl:inline'>
          Drag assets into the viewport or onto a slot · drop files here to import
        </span>

        {/* Assets in a library that the explorer isn't showing. The badge advertises the problem rather
            than waiting to be found — that is the whole reason this exists. */}
        <div className='relative shrink-0' ref={missingMenuRef}>
          <button
            id='asset-missing-audit'
            className={`shrink-0 w-[24px] h-[20px] inline-flex items-center justify-center rounded ${
              missingOpen ? 'bg-selected text-white'
                : audited ? 'text-warning hover:bg-control-hover'
                : 'text-muted hover:bg-control-hover hover:text-fg'
            }`}
            onClick={() => setMissingOpen(v => !v)}
            title={audited
              ? `${audited} asset${audited === 1 ? '' : 's'} are out of step between your libraries and the explorer`
              : 'Check for assets missing from the explorer'}>
            <svg className='w-3.5 h-3.5' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'>
              <circle cx='11' cy='11' r='7' /><path d='M20 20l-3.5-3.5' /><path d='M11 8v3.5M11 14.5h.01' />
            </svg>
          </button>
          {audited > 0 && !missingOpen && (
            <span className='absolute -top-[2px] -right-[2px] min-w-[12px] h-[12px] px-[3px] inline-flex items-center justify-center rounded-full bg-warning text-[9px] font-bold leading-none text-black pointer-events-none'>
              {audited > 99 ? '99+' : audited}
            </span>
          )}
          {missingOpen && (
            <MissingAssetsPopover missing={missing} orphans={orphans} onClose={() => setMissingOpen(false)} />
          )}
        </div>

        <button
          id='asset-preview-toggle'
          className={`shrink-0 w-[24px] h-[20px] inline-flex items-center justify-center rounded ${previewOpen ? 'bg-selected text-white' : 'text-muted hover:bg-control-hover hover:text-fg'}`}
          onClick={togglePreview}
          title='Show the details pane for the selected asset'>
          <svg className='w-3.5 h-3.5' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'>
            <path d='M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z' /><circle cx='12' cy='12' r='3' />
          </svg>
        </button>

        <div id='asset-view-modes' className='shrink-0 flex items-center gap-0.5 p-[2px] rounded bg-surface border border-border-subtle'>
          {modeButtons.map(b => (
            <button key={b.mode}
              data-mode={b.mode}
              className={`w-[24px] h-[16px] inline-flex items-center justify-center rounded-sm ${viewMode === b.mode ? 'bg-selected text-white' : 'text-muted hover:bg-control-hover hover:text-fg'}`}
              onClick={() => setMode(b.mode)}
              title={b.title}>
              {b.icon}
            </button>
          ))}
        </div>
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

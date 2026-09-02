import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Logger } from 'cleo'
import { Filemanager, WillowDark, getMenuOptions } from '@svar-ui/react-filemanager'
import type { IApi, IFileMenuOption, IParsedEntity, TContextMenuType, TMode } from '@svar-ui/react-filemanager'
import '../assets/filemanager.css'
import './projects.css'
import { iconFor } from '../assets/assetKinds'

import {
  ProjectRecord, createProject, deleteProject, loadProjects, openProject, renameProject,
} from '../../utils/projects'
import { activeProjectId } from '../../utils/projectScope'
import { confirmDialog } from '../dialogs/dialogStore'

// The project browser: the same SVAR file manager the Assets tab uses, over the project registry. A flat
// list — projects do not nest — so every project is one "file" whose id is its display path.
//
// Hosted in a modal (or the boot launcher), not a dock panel, which satisfies SVAR's mount-once /
// data-passed-once constraint: each open is a fresh mount with fresh data, each close an unmount.

/** View mode is a person's preference, not a project's — this key stays unscoped. */
const MODE_KEY = 'cleo_projects_view_mode'

/**
 * Turn a project name into a unique, `/`-prefixed path id (SVAR requires ids to be unique paths).
 * No virtual extension: SVAR truncates a card's name to keep the extension visible, which would hide the
 * only part that identifies the project.
 */
function buildEntities(projects: ProjectRecord[]): { data: IParsedEntity[]; byPath: Map<string, string> } {
  const byPath = new Map<string, string>()
  const used = new Set<string>()
  const data = projects.map(p => {
    const base = (p.name || 'Untitled').replace(/[/\\]/g, '-')
    let path = `/${base}`
    for (let n = 2; used.has(path); n++) path = `/${base} (${n})`
    used.add(path)
    byPath.set(path, p.id)
    // `size` is left off: SVAR renders it as bytes, and a project's footprint needs a full key scan.
    return { id: path, type: 'file', date: new Date(p.updatedAt) } as unknown as IParsedEntity
  })
  return { data, byPath }
}

function stemOfPath(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export default function ProjectsExplorer({ projects, onChanged, className = '' }: {
  projects: ProjectRecord[]
  /** Re-read the registry after a mutation that does not reload the page (rename, delete of another one). */
  onChanged: (projects: ProjectRecord[]) => void
  className?: string
}) {
  const apiRef = useRef<IApi | null>(null)
  const projectsRef = useRef(projects)
  projectsRef.current = projects
  const activeId = activeProjectId()

  const [busy, setBusy] = useState(false)
  const [naming, setNaming] = useState(false)
  const [newName, setNewName] = useState('')

  // Built once: re-passing `data` makes SVAR re-run store.init() and rebuild the whole tree. The
  // component is remounted on every open instead.
  const { data, byPath } = useMemo(() => buildEntities(projects), [])
  const byPathRef = useRef(byPath)
  const initialMode = useMemo<TMode>(() => {
    try { return (localStorage.getItem(MODE_KEY) as TMode) || 'cards' } catch { return 'cards' }
  }, [])

  const refresh = useCallback(async () => {
    onChanged(await loadProjects())
  }, [onChanged])

  const open = useCallback(async (id: string) => {
    if (id === activeId) return
    setBusy(true)
    await openProject(id) // writes the pointer and reloads
  }, [activeId])

  const remove = useCallback(async (id: string) => {
    const record = projectsRef.current.find(p => p.id === id)
    if (!record) return
    const isActive = id === activeId
    const ok = await confirmDialog({
      title: `Delete "${record.name}"?`,
      message: 'This cannot be undone.',
      details: [
        'Every scene, model, material, script, texture and folder in it is deleted with it',
        'Nothing is shared with your other projects, so nothing else is affected',
        ...(isActive ? ['This is the project you have open; the editor will reload into another one'] : []),
      ],
      confirmLabel: 'Delete project',
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      await deleteProject(id, isActive) // the active case reloads and wipes on the next boot
      if (!isActive) {
        // The tree is uncontrolled, so the card must also be dropped from SVAR's own store, with
        // skipProvider so the bridge does not treat this as a fresh user delete.
        for (const [path, pid] of byPathRef.current) {
          if (pid !== id) continue
          byPathRef.current.delete(path)
          apiRef.current?.exec('delete-files', { ids: [path], skipProvider: true })
          break
        }
        await refresh()
        Logger.info(`Deleted project "${record.name}"`, 'Editor')
      }
    } finally {
      setBusy(false)
    }
  }, [activeId, refresh])

  const create = useCallback(async () => {
    const name = newName.trim()
    if (!name) return
    setBusy(true)
    try {
      const record = await createProject(name)
      await openProject(record.id) // reloads into the empty project
    } catch (e) {
      setBusy(false)
      Logger.error(`Could not create the project: ${e}`, 'Editor')
    }
  }, [newName])

  const init = useCallback((api: IApi) => {
    apiRef.current = api

    // Projects have no folders and no blank files, and they are not created from inside the widget.
    api.intercept('create-file', () => false)
    // Nowhere to move a project to, and copying one means duplicating every key it owns.
    api.intercept('move-files', () => false)
    api.intercept('copy-files', () => false)

    api.intercept('rename-file', (cfg: any) => {
      if (cfg.skipProvider) return true
      // Only a path separator is forbidden, because ids are paths; storage is keyed by project id.
      const name = (cfg.name ?? '').trim().replace(/[/\\]/g, '-')
      if (!name) return false
      cfg.name = name
      return true
    })

    api.on('rename-file', (cfg: any) => {
      if (cfg.skipProvider) return
      const id = byPathRef.current.get(cfg.id)
      if (!id || !cfg.newId || cfg.newId === cfg.id) return
      // Nothing in storage is keyed by name, so this is pure metadata.
      byPathRef.current.delete(cfg.id)
      byPathRef.current.set(cfg.newId, id)
      void renameProject(id, stemOfPath(cfg.newId)).then(refresh)
    })

    // A hard stop: the tree must never drop a project card on its own. Deletion goes through the replaced
    // menu entry below, which also wipes the data behind the card.
    api.intercept('delete-files', (cfg: any) => cfg.skipProvider === true)

    api.on('open-file', (cfg: any) => {
      const id = byPathRef.current.get(cfg.id)
      if (id) void open(id)
    })

    api.on('set-mode', (cfg: any) => {
      try { localStorage.setItem(MODE_KEY, cfg.mode) } catch { /* ignore */ }
    })
  }, [open, remove, refresh])

  const previews = useCallback((file: Partial<IParsedEntity>): string | null => {
    const id = file?.id ? byPathRef.current.get(String(file.id)) : null
    return projectsRef.current.find(p => p.id === id)?.thumbnail ?? null
  }, [])

  const icons = useCallback(() => iconFor('scene'), [])

  const menuOptions = useCallback((mode: TContextMenuType): IFileMenuOption[] => {
    // No download and no cut/copy/paste. `delete` is replaced because SVAR runs its own generic "are you
    // sure" before dispatching delete-files. A custom id is ignored by SVAR's performAction (a closed
    // switch over the built-in ids), so the capture-phase listener below runs it.
    const drop = new Set(['download', 'copy', 'cut', 'paste', 'move', 'delete'])
    const options = (getMenuOptions(mode) as IFileMenuOption[]).filter(o => !drop.has(String(o.id)))
    if (mode === 'body') return options
    return [...options, { id: 'cleo-delete-project', icon: 'wxi-delete', text: 'Delete project' }]
  }, [])

  // SVAR's menu portals to <body> and carries no reference back to its target, so the id is captured off
  // the card's own data-id, which lib-dom prefixes with ':'.
  const menuTargetRef = useRef<string | null>(null)
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      const card = (e.target as HTMLElement)?.closest?.('[data-id]') as HTMLElement | null
      const raw = card?.getAttribute('data-id') ?? null
      menuTargetRef.current = raw ? raw.replace(/^:/, '') : null
    }
    const onClick = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest?.('[data-id=":cleo-delete-project"]')) return
      const path = menuTargetRef.current
      const id = path ? byPathRef.current.get(path) : null
      if (id) void remove(id)
    }
    document.addEventListener('contextmenu', onContextMenu, true)
    document.addEventListener('click', onClick, true)
    return () => {
      document.removeEventListener('contextmenu', onContextMenu, true)
      document.removeEventListener('click', onClick, true)
    }
  }, [remove])

  return (
    <div className={`w-full h-full flex flex-col text-sm ${className}`}>
      <div className='h-[28px] flex items-center gap-1.5 px-2 border-b border-border-subtle shrink-0 bg-surface-sunken'>
        {naming ? (
          <>
            <input
              autoFocus
              className='shrink min-w-[120px] w-[220px] h-[20px] px-2 rounded bg-control border border-border text-[11px] text-fg placeholder:text-dim focus:outline-none focus:border-highlight'
              placeholder='Project name'
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') void create()
                if (e.key === 'Escape') { setNaming(false); setNewName('') }
              }}
            />
            <button
              className='shrink-0 inline-flex items-center h-[20px] px-2 rounded text-[11px] font-semibold leading-none cursor-pointer bg-success hover:bg-success-hover disabled:opacity-40'
              disabled={!newName.trim() || busy}
              onClick={() => void create()}>
              Create
            </button>
            <button
              className='shrink-0 inline-flex items-center h-[20px] px-2 rounded text-[11px] leading-none cursor-pointer text-muted hover:bg-control-hover hover:text-fg'
              onClick={() => { setNaming(false); setNewName('') }}>
              Cancel
            </button>
          </>
        ) : (
          <button
            className='shrink-0 inline-flex items-center h-[20px] px-2 rounded text-[11px] font-semibold leading-none whitespace-nowrap cursor-pointer bg-success hover:bg-success-hover disabled:opacity-40'
            disabled={busy}
            onClick={() => { setNaming(true); setNewName('') }}
            title='Create an empty project with its own scenes, assets and layout'>
            + New Project
          </button>
        )}

        <span className='ml-auto min-w-0 truncate text-[11px] text-dim'>
          {busy ? 'Working…' : 'Double-click to open · right-click to rename or delete'}
        </span>
      </div>

      <div className='cleo-fm cleo-projects relative flex-1 min-h-0'>
        <WillowDark fonts={false}>
          <Filemanager
            data={data}
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

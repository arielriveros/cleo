import { useCallback, useEffect, useRef, useState } from 'react'
import { Logger } from 'cleo'
import { Button } from '@cleo/app-kit/ui'
import { confirmDialog } from '@cleo/app-kit/feedback/dialogStore'
import { beginLoad } from '@cleo/app-kit/feedback/loadingStore'
import { LauncherCard, LauncherGlyph, LauncherGrid } from '@cleo/app-kit/launcher/Launcher'
import { iconFor } from '../assets/assetKinds'
import { activeProjectId } from '../../utils/projectScope'
import { loadProjects, projectCardImage, relocateFolderRecord, type ProjectRecord } from '../../utils/projects'
import { confirmDiscard } from '../unloadGuard'
import NewProjectModal from '../projects/NewProjectModal'
import { importBundleJob } from '../../workers/workerClient'
import { requireProjectBridge } from './desktopProject'
import { openFolderDialog, removeFolderProject } from './folderActions'
import { installBundleToFolder, openFolderProject, readProjectFile } from './openFolder'
import { LocationModal } from './LocationField'
import { exportStoredProject } from './storedProjectExport'

// "My Projects" in the desktop app, where every project is a folder: the folders this machine has opened,
// newest first, plus the ways to add one — a new project, an existing folder (a clone, a copy from another
// machine), a .zip export. Projects that only ever lived in this app's browser storage are listed apart,
// for export only: the desktop opens folders.

interface Row { record: ProjectRecord; missing: boolean }

export default function FolderProjects({ projects, onChanged }: { projects: ProjectRecord[]; onChanged: (projects: ProjectRecord[]) => void }) {
  const [rows, setRows] = useState<Row[]>([])
  const [naming, setNaming] = useState(false)
  const [zip, setZip] = useState<{ file: File; name: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [legacyOpen, setLegacyOpen] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const legacy = projects.filter(p => !p.folder)

  const refresh = useCallback(async () => {
    const list = await loadProjects()
    onChanged(list)
  }, [onChanged])

  useEffect(() => {
    let live = true
    const bridge = requireProjectBridge()
    void (async () => {
      const out: Row[] = []
      for (const record of projects.filter(p => p.folder).sort((a, b) => b.updatedAt - a.updatedAt)) {
        const info = await bridge.inspect(record.folder!.root)
        out.push({ record, missing: !(info.ok && info.isProject) })
      }
      if (live) setRows(out)
    })()
    return () => { live = false }
  }, [projects])

  const open = async (row: Row) => {
    if (row.missing) return locate(row)
    if (row.record.id === activeProjectId()) return
    await openFolderProject(row.record.folder!.root)
  }

  const locate = async (row: Row) => {
    const picked = await requireProjectBridge().pickProject({ title: `Where is "${row.record.name}" now?` })
    if (!picked.ok) return
    const file = await readProjectFile(picked.root)
    if (!file.ok) { Logger.error(file.error, 'Editor'); return }
    if (row.record.folder?.uid && file.uid !== row.record.folder.uid) {
      const ok = await confirmDialog({
        title: 'A different project',
        message: `That folder holds "${file.name}", not "${row.record.name}". Open it as its own project?`,
        confirmLabel: 'Open it',
      })
      if (ok) await openFolderProject(picked.root)
      return
    }
    await relocateFolderRecord(row.record.id, picked.root)
    await refresh()
    await openFolderProject(picked.root)
  }

  const remove = async (row: Row) => {
    const ok = await confirmDialog({
      title: `Remove "${row.record.name}" from the list?`,
      message: `The folder stays where it is:\n${row.record.folder!.root}\n\nOpen it again any time with Open Folder.`,
      confirmLabel: 'Remove', tone: 'danger',
    })
    if (!ok) return
    await removeFolderProject(row.record)
    await refresh()
  }

  const pickZip = async (file: File) => {
    const name = file.name.replace(/\.cleoproj\.zip$|\.zip$/i, '') || 'Imported Project'
    setZip({ file, name })
  }

  const importZip = async (target: { root: string; name: string; gitInit: boolean; npmInstall: boolean }, file: File) => {
    if (!await confirmDiscard('Importing a project')) return
    setBusy(true)
    const load = beginLoad(`Importing ${target.name}`, [{ id: 'read', label: 'Reading the archive', weight: 2 }])
    let leaving = false
    try {
      load.step('read').start()
      const bundle = await importBundleJob(file)
      load.step('read').done()
      if (bundle.manifest.kind !== 'project') throw new Error('That archive is an asset pack, not a project')
      leaving = await installBundleToFolder(bundle, target.root, target.name, { gitInit: target.gitInit, npmInstall: target.npmInstall, load })
    } catch (e) {
      Logger.error(`Could not import ${file.name}: ${(e as Error)?.message ?? e}`, 'Editor')
    } finally {
      if (!leaving) load.finish()
      setBusy(false)
    }
  }

  return (
    <div className='w-full h-full flex flex-col text-ui'>
      {naming && <NewProjectModal onClose={() => setNaming(false)} onCreated={() => void refresh()} />}
      {zip && (
        <LocationModal title={`Import ${zip.file.name}`} name={zip.name} confirmLabel='Import'
          onDone={result => { const z = zip; setZip(null); if (result && z) void importZip(result, z.file) }} />
      )}
      <input ref={fileInput} type='file' accept='.zip' className='hidden'
        onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void pickZip(f) }} />

      <div className='h-[30px] flex items-center gap-1.5 px-2 border-b border-border-subtle shrink-0 bg-surface-sunken'>
        <Button size='sm' variant='success' disabled={busy} onClick={() => setNaming(true)}>+ New Project</Button>
        <Button size='sm' disabled={busy} onClick={() => void openFolderDialog()}>Open Folder…</Button>
        <Button size='sm' disabled={busy} onClick={() => fileInput.current?.click()}>Import .zip…</Button>
        <span className='flex-1' />
        {legacy.length > 0 && (
          <Button size='sm' variant='ghost' onClick={() => setLegacyOpen(v => !v)}
            title='Projects kept in this app’s own storage before projects became folders. Export one, then Import it into a folder.'>
            Browser-storage projects ({legacy.length})
          </Button>
        )}
      </div>

      {legacyOpen && legacy.length > 0 && (
        <div className='px-3 py-2 border-b border-border-subtle bg-surface flex flex-col gap-1'>
          <div className='text-ui-xs text-dim'>Kept in this app’s storage. The desktop app opens folders: export one, then Import .zip it into a folder.</div>
          {legacy.map(p => (
            <div key={p.id} className='flex items-center gap-2'>
              <span className='flex-1 truncate text-ui-sm text-fg'>{p.name}</span>
              <Button size='sm' onClick={() => void exportStoredProject(p).catch(e => Logger.error(`Could not export ${p.name}: ${e}`, 'Editor'))}>Export .zip…</Button>
            </div>
          ))}
        </div>
      )}

      <div className='flex-1 min-h-0 overflow-y-auto p-3'>
        {rows.length === 0 ? (
          <div className='text-ui-sm text-dim p-4 text-center'>No project folders yet. Create one, open one, or install an example.</div>
        ) : (
          <LauncherGrid>
            {rows.map(row => (
              <div key={row.record.id} className='flex flex-col gap-1'>
                <LauncherCard
                  name={row.record.name}
                  title={row.record.folder!.root}
                  meta={row.missing ? 'Folder not found — click to locate it' : row.record.folder!.root}
                  thumbnail={projectCardImage(row.record)
                    ? <img src={projectCardImage(row.record)} alt='' className='w-full h-full object-cover' />
                    : <LauncherGlyph><img src={iconFor('scene')} alt='' className='w-8 h-8 opacity-50' /></LauncherGlyph>}
                  active={row.record.id === activeProjectId()}
                  disabled={busy}
                  onClick={() => void open(row)} />
                <div className='flex gap-1'>
                  {!row.missing && <Button size='sm' variant='ghost' onClick={() => void requireProjectBridge().reveal(row.record.folder!.root)}>Show folder</Button>}
                  <Button size='sm' variant='ghost' onClick={() => void remove(row)}>Remove</Button>
                </div>
              </div>
            ))}
          </LauncherGrid>
        )}
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { Button, Modal, ModalFooter, ModalHeader, TextInput, Toggle } from '@cleo/app-kit/ui'
import { getProjectBridge, requireProjectBridge } from './desktopProject'

// Where a new folder project goes: a parent folder (Documents/Cleo Projects by default, or one picked with
// Browse…) and a folder inside it named after the project. Used by New Project, installing an example and
// importing a .zip — the three ways a project folder is born.

/** A project name as a folder name: what Windows, macOS and Linux all accept. */
export function folderNameOf(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/[. ]+$/, '').trim()
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(cleaned) || !cleaned ? 'Cleo Project' : cleaned.slice(0, 120)
}

const join = (parent: string, child: string) => (parent.endsWith('\\') || parent.endsWith('/') ? parent + child : `${parent}${parent.includes('\\') ? '\\' : '/'}${child}`)

export interface LocationValue {
  parent: string
  root: string
  gitInit: boolean
  npmInstall: boolean
  /** Why this location cannot be used, or null when it can. */
  problem: string | null
}

/** The location field, kept in `value`; the parent defaults to Documents/Cleo Projects. */
export function useLocation(name: string): [LocationValue, () => Promise<void>, (patch: Partial<LocationValue>) => void] {
  const [parent, setParent] = useState('')
  const [gitInit, setGitInit] = useState(false)
  const [npmInstall, setNpmInstall] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const root = parent ? join(parent, folderNameOf(name)) : ''

  useEffect(() => {
    // The web build has no folders: the hook is inert there (its host renders no field).
    const bridge = getProjectBridge()
    if (!bridge) return
    void bridge.defaultParent().then(res => { if (res.ok) setParent(p => p || res.path) })
    // The checkboxes start ticked when the tool is there to run.
    void bridge.hasCommand('git').then(res => { if (res.ok) setGitInit(res.present) })
    void bridge.hasCommand('npm').then(res => { if (res.ok) setNpmInstall(res.present) })
  }, [])

  useEffect(() => {
    if (!root || !getProjectBridge()) return
    let live = true
    void requireProjectBridge().inspect(root).then(info => {
      if (!live || !info.ok) return
      setProblem(info.isProject ? 'A Cleo project is already in that folder.' : info.exists && info.isDirectory === false ? 'That is a file.' : null)
    })
    return () => { live = false }
  }, [root])

  const browse = async () => {
    const res = await requireProjectBridge().pickLocation({ name, parent: parent || undefined })
    if (res.ok) setParent(res.parent)
  }
  const patch = (p: Partial<LocationValue>) => {
    if (p.gitInit !== undefined) setGitInit(p.gitInit)
    if (p.npmInstall !== undefined) setNpmInstall(p.npmInstall)
  }
  return [{ parent, root, gitInit, npmInstall, problem }, browse, patch]
}

export function LocationField({ value, onBrowse, onChange, showTools = true }: {
  value: LocationValue
  onBrowse: () => void
  onChange: (patch: Partial<LocationValue>) => void
  showTools?: boolean
}) {
  return (
    <div className='flex flex-col gap-1.5'>
      <div className='text-ui-sm text-muted'>Project folder</div>
      <div className='flex items-center gap-2'>
        <div className='flex-1 min-w-0 px-2 py-1 rounded border border-control bg-control text-ui-sm text-fg truncate' title={value.root}>
          {value.root || '…'}
        </div>
        <Button size='sm' onClick={onBrowse}>Browse…</Button>
      </div>
      {value.problem && <div className='text-ui-xs text-danger'>{value.problem}</div>}
      {showTools && (
        <div className='flex flex-col gap-1 mt-1'>
          <label className='flex items-center gap-2 text-ui-sm text-fg'>
            <Toggle checked={value.gitInit} doc={false} onChange={on => onChange({ gitInit: on })} />
            Create a git repository
          </label>
          <label className='flex items-center gap-2 text-ui-sm text-fg'>
            <Toggle checked={value.npmInstall} doc={false} onChange={on => onChange({ npmInstall: on })} />
            Install the script tools (npm install)
          </label>
        </div>
      )}
    </div>
  )
}

/**
 * A dialog that asks where a project folder goes, for a project whose name is already known (an example, an
 * imported .zip). Resolves with the location, or null when cancelled.
 */
export function LocationModal({ title, name: initialName, confirmLabel, onDone }: {
  title: string
  name: string
  confirmLabel: string
  onDone: (result: { root: string; name: string; gitInit: boolean; npmInstall: boolean } | null) => void
}) {
  const [name, setName] = useState(initialName)
  const [value, browse, patch] = useLocation(name)
  const ok = !!name.trim() && !!value.root && !value.problem
  return (
    <Modal onClose={() => onDone(null)} className='w-[560px] max-w-[95vw]' overlayClassName='z-[70]'>
      <ModalHeader title={title} doc='editor/project-folders#choosing-a-location' />
      <div className='px-4 py-3 flex flex-col gap-3'>
        <TextInput autoFocus placeholder='Project name' value={name} onChange={setName} maxLength={120}
          onKeyDown={e => { if (e.key === 'Enter' && ok) onDone({ root: value.root, name: name.trim(), gitInit: value.gitInit, npmInstall: value.npmInstall }) }} />
        <LocationField value={value} onBrowse={() => void browse()} onChange={patch} />
      </div>
      <ModalFooter>
        <Button onClick={() => onDone(null)}>Cancel</Button>
        <Button variant='success' className='font-semibold' disabled={!ok}
          onClick={() => onDone({ root: value.root, name: name.trim(), gitInit: value.gitInit, npmInstall: value.npmInstall })}>
          {confirmLabel}
        </Button>
      </ModalFooter>
    </Modal>
  )
}

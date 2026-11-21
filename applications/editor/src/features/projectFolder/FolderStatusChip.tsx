import { useState, useSyncExternalStore } from 'react'
import { Button } from '@cleo/app-kit/ui/Button'
import { cn } from '@cleo/app-kit/ui/cn'
import { folderSink } from './folderSink'
import { folderSession } from './folderSession'
import { useExternalChanges } from './ProjectFolderProvider'
import { reloadFolderProject } from './folderActions'
import { getProjectBridge } from './desktopProject'

// The project folder in the menu bar — only when it needs attention: files changed on disk outside the
// editor (a git pull, a checkout, an edit in another program), files the editor could not read, writes the
// folder refused, deletions waiting for a confirmation, a folder that went missing.

export default function FolderStatusChip() {
  const status = useSyncExternalStore(fn => folderSink.subscribe(fn), () => folderSink.getStatus())
  const external = useExternalChanges()
  const [open, setOpen] = useState(false)
  const session = folderSession()
  if (!session) return null

  const blocked = [...session.blocked.entries()]
  const attention = external.count > 0 || external.rootMissing || blocked.length > 0 || status.conflicts.length > 0
    || status.heldDeletes > 0 || status.state === 'error'
  if (!attention) return null

  const label = external.rootMissing ? 'Project folder missing'
    : status.state === 'error' ? 'Folder write failed'
    : status.heldDeletes ? `Delete ${status.heldDeletes} files?`
    : external.count ? `Changed on disk (${external.count})`
    : status.conflicts.length ? 'Folder conflict'
    : 'Unreadable files'
  const tone = external.rootMissing || status.state === 'error' ? 'bg-danger' : 'bg-warning'

  return (
    <div className='relative flex items-center'>
      <Button variant='ghost' size='sm' onClick={() => setOpen(v => !v)} title={session.root}
        className={cn('gap-1.5 px-2 py-0 h-[22px] font-normal text-ui-sm border-warning text-fg bg-warning/20 hover:bg-warning/30')}>
        <span className={`w-1.5 h-1.5 rounded-full ${tone}`} />
        {label}
      </Button>
      {open && (
        <div className='absolute top-[26px] left-0 z-40 w-[360px] p-3 rounded border border-control bg-surface-raised shadow-lg flex flex-col gap-2'>
          <div className='text-ui-sm text-dim break-all'>{session.root}</div>
          {external.rootMissing && <div className='text-ui-sm text-fg'>The project folder is gone (moved, renamed, or on a drive that was removed). Nothing has been changed in the editor.</div>}
          {status.state === 'error' && status.message && <div className='text-ui-sm text-fg'>{status.message}</div>}
          {external.count > 0 && (
            <div className='text-ui-sm text-fg'>
              {external.count} file{external.count === 1 ? '' : 's'} changed outside Cleo. Reload to take them in; edits you have not
              saved are kept only if you save them first.
              <ul className='mt-1 text-ui-xs text-dim max-h-[96px] overflow-auto'>{external.rels.slice(0, 12).map(r => <li key={r}>{r}</li>)}</ul>
            </div>
          )}
          {status.conflicts.length > 0 && (
            <div className='text-ui-sm text-fg'>
              Not written, because the file changed on disk first: {status.conflicts.slice(0, 4).join(', ')}{status.conflicts.length > 4 ? '…' : ''}. Reload to see the disk's version.
            </div>
          )}
          {blocked.length > 0 && (
            <div className='text-ui-sm text-fg'>
              Cleo could not read {blocked.length} file{blocked.length === 1 ? '' : 's'} and keeps its own copy until they read again:
              <ul className='mt-1 text-ui-xs text-dim max-h-[96px] overflow-auto'>{blocked.slice(0, 8).map(([rel, b]) => <li key={rel}>{rel}: {b.message}</li>)}</ul>
            </div>
          )}
          {status.heldDeletes > 0 && (
            <div className='text-ui-sm text-fg'>Writing the editor's state would delete {status.heldDeletes} files from the folder (deleted files go to the trash).</div>
          )}
          <div className='flex flex-wrap gap-1.5'>
            {(external.count > 0 || status.conflicts.length > 0 || blocked.length > 0) && (
              <Button size='sm' variant='primary' onClick={() => { setOpen(false); void reloadFolderProject() }}>Reload from disk</Button>
            )}
            {status.heldDeletes > 0 && (
              <Button size='sm' variant='danger' onClick={() => { setOpen(false); folderSink.confirmDeletes() }}>Delete them</Button>
            )}
            <Button size='sm' variant='ghost' onClick={() => { void getProjectBridge()?.reveal(session.root) }}>Show folder</Button>
          </div>
        </div>
      )}
    </div>
  )
}

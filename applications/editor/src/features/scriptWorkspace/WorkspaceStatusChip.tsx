import { useState } from 'react'
import { Button } from '@cleo/app-kit/ui/Button'
import { cn } from '@cleo/app-kit/ui/cn'
import { Modal, ModalFooter, ModalHeader } from '@cleo/app-kit/ui/Modal'
import { useScriptWorkspace } from './ScriptWorkspaceContext'

// The external script workspace in the menu bar — ONLY when it needs attention (a paused sync, an error,
// an edit conflict): the states where something is deliberately not applied. Setting it up, its folder
// and its everyday status live in Options ▸ Editor ▸ Scripts.

const DOT: Record<string, string> = {
  live: 'bg-success',
  connecting: 'bg-muted animate-pulse',
  paused: 'bg-warning',
  error: 'bg-danger',
}

export default function WorkspaceStatusChip() {
  const ws = useScriptWorkspace()
  const [expanded, setExpanded] = useState(false)
  const conflict = ws.conflicts[0]

  const needsAttention = ws.status === 'paused' || ws.status === 'error'
  if (!needsAttention && !conflict) return null

  return (
    <>
      {needsAttention && <div className='relative flex items-center'>
        <Button
          variant='ghost'
          size='sm'
          onClick={() => setExpanded(v => !v)}
          title={ws.message ?? ws.rootPath ?? ''}
          className={cn(
            'gap-1.5 px-2 py-0 h-[22px] font-normal text-ui-sm',
            needsAttention
              ? 'border-warning text-fg bg-warning/20 hover:bg-warning/30'
              : 'border-border text-muted hover:text-fg hover:bg-control')
          }
        >
          <span className={`w-1.5 h-1.5 rounded-full ${DOT[ws.status] ?? 'bg-muted'}`} />
          {ws.status === 'live' && 'Scripts synced'}
          {ws.status === 'connecting' && 'Connecting…'}
          {ws.status === 'paused' && 'Script sync paused'}
          {ws.status === 'error' && 'Script sync error'}
        </Button>

        {expanded && (
          <div className='absolute top-[26px] left-0 z-40 w-[320px] p-3 rounded border border-control bg-surface-raised shadow-lg'>
            <div className='text-ui-sm text-dim break-all mb-2'>{ws.rootPath}</div>
            {ws.message && <div className='text-ui-sm text-fg mb-2'>{ws.message}</div>}

            <div className='flex flex-wrap gap-1.5'>
              <Button size='sm' onClick={() => { void ws.openInEditor(); setExpanded(false) }}>
                Open in editor
              </Button>
              {needsAttention && (
                <>
                  <Button size='sm' variant='primary' title='Restores the folder from the script library.'
                    onClick={() => { void ws.resync(); setExpanded(false) }}>
                    Rewrite from editor
                  </Button>
                  <Button size='sm' variant='danger' title='Removes the scripts pending deletion from every node that uses them.'
                    onClick={() => { void ws.applyPendingDeletions(); setExpanded(false) }}>
                    Apply deletions
                  </Button>
                </>
              )}
              <Button size='sm' variant='ghost' onClick={() => { void ws.disconnect(); setExpanded(false) }}>
                Disconnect
              </Button>
            </div>

            {needsAttention && (
              <p className='mt-2 text-ui-xs text-dim leading-snug'>
                Nothing has been changed in the editor.
              </p>
            )}
          </div>
        )}
      </div>}

      {conflict && (
        <Modal onClose={() => ws.resolveConflict(conflict.scriptId, 'external')} className='w-[440px]'>
          <ModalHeader title={`“${conflict.name}” was edited in both places`} doc='editor/scripting-workflow::Resolve conflict' />
          <div className='px-4 py-3 text-ui text-muted leading-relaxed'>
            This script had unsaved changes in the editor when a new version arrived from the workspace
            folder. The workspace version has been taken — keep it, or put your unsaved editor version
            back (which then overwrites the file on disk).
          </div>
          <ModalFooter>
            <Button variant='ghost' onClick={() => ws.resolveConflict(conflict.scriptId, 'mine')}>
              Keep my editor version
            </Button>
            <Button variant='primary' onClick={() => ws.resolveConflict(conflict.scriptId, 'external')}>
              Keep the workspace version
            </Button>
          </ModalFooter>
        </Modal>
      )}
    </>
  )
}

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Button } from '@cleo/app-kit/ui/Button'
import { Toggle } from '@cleo/app-kit/ui/Toggle'
import { cn } from '@cleo/app-kit/ui/cn'
import { agentBridge } from './bridgeClient'

// The agent link in the menu bar. Shown only when there is something to say: a Cleo MCP server is running
// (connected, waiting, or turned off here), never for the many sessions that never start one.

const DOT: Record<string, string> = {
  connected: 'bg-success',
  connecting: 'bg-muted animate-pulse',
  standby: 'bg-warning',
  rejected: 'bg-danger',
  off: 'bg-muted',
}

const LABEL: Record<string, string> = {
  connected: 'Agent',
  connecting: 'Agent…',
  standby: 'Agent (other tab)',
  rejected: 'Agent refused',
  off: 'Agent off',
}

export default function AgentBridgeChip() {
  const status = useSyncExternalStore(agentBridge.subscribe, agentBridge.getSnapshot)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as globalThis.Node)) setOpen(false) }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  if (!agentBridge.supported) return null
  if (status.state === 'searching' || (!status.available && status.state !== 'connected' && status.state !== 'connecting')) return null

  const busy = !!status.activity
  const title = status.state === 'connected'
    ? `An AI agent (Claude, over MCP) is linked to this editor: ${status.server?.name} ${status.server?.version}. ${status.calls} command(s) so far.`
    : 'A Cleo MCP server is running on this machine.'

  return (
    <div className='relative flex items-center' ref={ref}>
      <Button
        variant='ghost' size='sm' title={title}
        onClick={() => setOpen(v => !v)}
        className={cn('gap-1.5 px-2 py-0 h-[22px] font-normal text-ui-sm border-border text-muted hover:text-fg hover:bg-control',
          status.state === 'connected' && 'text-fg')}
      >
        <span className={cn('w-1.5 h-1.5 rounded-full', DOT[status.state] ?? 'bg-muted', busy && 'animate-pulse bg-highlight')} />
        {LABEL[status.state] ?? 'Agent'}
      </Button>

      {open && (
        <div className='absolute top-[26px] left-0 z-40 w-[300px] p-3 rounded border border-control bg-surface-raised shadow-lg text-ui-sm'>
          {status.state === 'connected' ? (
            <>
              <div className='text-fg mb-1'>Linked to {status.server?.name} {status.server?.version}</div>
              <div className='text-dim mb-2'>
                {status.calls} command{status.calls === 1 ? '' : 's'}{status.lastMethod ? `; last: ${status.lastMethod}` : ''}.
                {' '}Its scene edits are undoable like yours (Ctrl+Z).
              </div>
              {status.lastError && <div className='text-warning mb-2 break-words'>Last error: {status.lastError}</div>}
              <Toggle
                checked={agentBridge.executeAllowed}
                onChange={on => agentBridge.setExecuteAllowed(on)}
                label='Allow code execution'
                doc={false}
                title='Lets the agent run JavaScript inside the editor (the execute_js tool). Its client still asks you before each run.'
              />
              <div className='flex gap-1.5 mt-3'>
                <Button size='sm' variant='ghost' onClick={() => { agentBridge.disconnect(); setOpen(false) }}>Disconnect</Button>
              </div>
            </>
          ) : (
            <>
              <div className='text-fg mb-2'>
                {status.state === 'standby' && 'Another editor tab is linked to the agent.'}
                {status.state === 'rejected' && 'The MCP server refused this editor (a stale discovery file). Restart the server, or connect again.'}
                {status.state === 'off' && 'A Cleo MCP server is running. Connect to let the agent edit this project.'}
                {status.state === 'connecting' && 'Connecting…'}
              </div>
              <Button size='sm' variant='primary' onClick={() => { agentBridge.connect(); setOpen(false) }}>
                {status.state === 'standby' ? 'Use this tab' : 'Connect'}
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

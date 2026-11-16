import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Button } from '@cleo/app-kit/ui/Button'
import { Toggle } from '@cleo/app-kit/ui/Toggle'
import { cn } from '@cleo/app-kit/ui/cn'
import { agentBridge } from './bridgeClient'
import { agentHostStore, ensureHost, NO_AGENT_HOST } from './agentHost'

// The agent link in the menu bar: the MCP server addon's chip. Shown whenever the addon is on, whatever the link
// is doing, and always clickable: its popover tells what the link is up to and offers what fits (Connect, Use
// this tab, Retry, Disconnect).

type Shown = 'connected' | 'connecting' | 'searching' | 'standby' | 'rejected' | 'off' | 'failed'

const DOT: Record<Shown, string> = {
  connected: 'bg-success',
  connecting: 'bg-muted animate-pulse',
  searching: 'bg-muted animate-pulse',
  standby: 'bg-warning',
  rejected: 'bg-danger',
  off: 'bg-muted',
  failed: 'bg-danger',
}

const LABEL: Record<Shown, string> = {
  connected: 'Agent',
  connecting: 'Agent…',
  searching: 'Agent…',
  standby: 'Agent (other tab)',
  rejected: 'Agent refused',
  off: 'Agent off',
  failed: 'Agent off',
}

export default function AgentBridgeChip() {
  const status = useSyncExternalStore(agentBridge.subscribe, agentBridge.getSnapshot)
  const host = useSyncExternalStore(agentHostStore.subscribe, agentHostStore.getSnapshot)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as globalThis.Node)) setOpen(false) }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  // What the chip says. The host failing to start outranks a link that is only looking for it; a link that is
  // on but has not looked yet (the addon just turned on) is looking.
  const shown: Shown =
    status.state === 'connected' || status.state === 'connecting' ? status.state
    : !agentBridge.supported || host.state === 'error' ? 'failed'
    : status.state === 'off' && agentBridge.enabled ? 'searching'
    : status.state
  const busy = !!status.activity
  const title =
    shown === 'connected' ? `An AI agent (Claude, over MCP) is linked to this editor: ${status.server?.name} ${status.server?.version}. ${status.calls} command(s) so far.`
    : shown === 'failed' ? `The MCP server is not running: ${agentBridge.supported ? host.error : NO_AGENT_HOST}`
    : shown === 'off' ? 'The agent link is off: no agent can reach this project. Click to connect.'
    : shown === 'standby' ? 'Another editor tab is linked to the agent.'
    : shown === 'rejected' ? 'The MCP server refused this editor.'
    : 'Starting the Cleo MCP server and linking to it.'
  const connect = () => { void ensureHost({ connect: true }); setOpen(false) }

  return (
    <div className='relative flex items-center' ref={ref}>
      <Button
        variant='ghost' size='sm' title={title}
        onClick={() => setOpen(v => !v)}
        className={cn('gap-1.5 px-2 py-0 h-[22px] font-normal text-ui-sm border-border text-muted hover:text-fg hover:bg-control',
          shown === 'connected' && 'text-fg')}
      >
        <span className={cn('w-1.5 h-1.5 rounded-full', DOT[shown], busy && 'animate-pulse bg-highlight')} />
        {LABEL[shown]}
      </Button>

      {open && (
        <div className='absolute top-[26px] left-0 z-40 w-[300px] p-3 rounded border border-control bg-surface-raised shadow-lg text-ui-sm'>
          {shown === 'connected' ? (
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
                title='Lets the agent run JavaScript inside the editor (the execute_js tool) without asking each time. Turn it off to refuse those requests.'
              />
              <div className='flex gap-1.5 mt-3'>
                <Button size='sm' variant='ghost' onClick={() => { agentBridge.disconnect(); setOpen(false) }}>Disconnect</Button>
              </div>
            </>
          ) : shown === 'failed' ? (
            <>
              <div className='text-fg mb-1'>The MCP server is not running</div>
              <div className='text-dim mb-2 break-words'>{agentBridge.supported ? host.error : NO_AGENT_HOST}</div>
              {agentBridge.supported && <Button size='sm' variant='primary' onClick={connect}>Retry</Button>}
            </>
          ) : shown === 'connecting' || shown === 'searching' ? (
            <div className='text-fg'>{host.state === 'starting' ? 'Starting the MCP server…' : 'Linking to the MCP server…'}</div>
          ) : (
            <>
              <div className='text-fg mb-2'>
                {shown === 'standby' && 'Another editor tab is linked to the agent.'}
                {shown === 'rejected' && 'The MCP server refused this editor (a stale discovery file). Restart the server, or connect again.'}
                {shown === 'off' && 'The agent link is off: no agent can reach this project. Connect to let it read and edit the project.'}
              </div>
              <Button size='sm' variant='primary' onClick={connect}>
                {shown === 'standby' ? 'Use this tab' : 'Connect'}
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

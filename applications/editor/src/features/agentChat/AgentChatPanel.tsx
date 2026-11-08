import { useSyncExternalStore } from 'react'
import { Button } from '@cleo/app-kit/ui/Button'
import { cn } from '@cleo/app-kit/ui/cn'
import ClaudeCodeView from './ClaudeCodeView'
import { panelActions, panelStore, PANEL_MIN_WIDTH } from './panelStore'
import { terminalActions, terminalStore } from './terminalStore'
import { ChatIcon, NewChatIcon } from './chatIcons'

// The Claude panel, docked at the right edge of the editor (like an IDE's assistant panel), outside dockview
// so it stays up in every mode and during Play. It shows the user's own Claude Code CLI, hosted in a terminal
// by the agent host (ClaudeCodeView). Claude Code signs in with the user's Claude account, so it runs on
// their plan, and it works on the project through the Cleo MCP tools: each edit is one undo step.

export default function AgentChatPanel() {
  const s = useSyncExternalStore(panelStore.subscribe, panelStore.getSnapshot)
  const t = useSyncExternalStore(terminalStore.subscribe, terminalStore.getSnapshot)

  if (!s.open) return null

  const term = t.term
  const dot = term?.running ? 'bg-success' : t.link === 'ready' ? 'bg-muted' : s.link === 'error' ? 'bg-danger' : 'bg-muted animate-pulse'
  const dotTitle = term?.running ? 'Claude Code is running' : t.link === 'ready' ? 'Claude Code is not running' : s.linkError ?? 'Connecting to the agent host'

  const onResizeStart = (e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX, startW = s.width
    const move = (ev: PointerEvent) => panelActions.setWidth(startW + (startX - ev.clientX))
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <aside className='relative flex flex-col shrink-0 min-h-0 border-l border-border bg-surface text-ui' style={{ width: Math.max(PANEL_MIN_WIDTH, s.width) }}>
      <div onPointerDown={onResizeStart} className='absolute left-0 top-0 bottom-0 w-1 -ml-0.5 cursor-col-resize hover:bg-primary/40 z-10' title='Drag to resize' />

      <div className='flex items-center gap-1.5 h-[30px] px-2 border-b border-border shrink-0'>
        <span className='w-4 h-4 text-highlight shrink-0'><ChatIcon /></span>
        <span className='font-semibold text-fg'>Claude Code</span>
        <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', dot)} title={dotTitle} />
        <div className='ml-auto flex items-center gap-0.5'>
          <Button variant='ghost' size='icon' title='Start a new Claude Code session (ends the running one)'
            disabled={t.link !== 'ready' || !term?.available} onClick={() => terminalActions.restart()}>
            <span className='w-3.5 h-3.5'><NewChatIcon /></span>
          </Button>
          <Button variant='ghost' size='icon' title='Close the panel' onClick={() => panelActions.setOpen(false)}><span className='text-ui leading-none'>✕</span></Button>
        </div>
      </div>

      <ClaudeCodeView />
    </aside>
  )
}

/** The menu-bar button that opens and closes the Claude panel. */
export function AgentChatToggle() {
  const s = useSyncExternalStore(panelStore.subscribe, panelStore.getSnapshot)
  return (
    <Button variant='subtle' size='sm' className='h-[25px]' active={s.open} title='Claude Code: build, script and test with Claude'
      onClick={() => panelActions.toggle()}>
      <span className='w-3.5 h-3.5'><ChatIcon /></span> Claude
    </Button>
  )
}

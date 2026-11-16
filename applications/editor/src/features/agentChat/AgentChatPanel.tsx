import { useSyncExternalStore } from 'react'
import { Button } from '@cleo/app-kit/ui/Button'
import { cn } from '@cleo/app-kit/ui/cn'
import { CloseIcon } from '@cleo/app-kit/ui/icons'
import { JOINED_DIVIDER_CLASS, JOINED_GROUP_CLASS } from '@cleo/app-kit/ui/SegmentedControl'
import ClaudeCodeView from './ClaudeCodeView'
import { panelActions, panelStore, PANEL_MIN_WIDTH } from './panelStore'
import { terminalActions, terminalStore } from './terminalStore'
import { ClaudeIcon, NewChatIcon, StopSessionIcon } from './chatIcons'

// The Claude panel, docked at the right edge of the editor (like an IDE's assistant panel), outside dockview
// so it stays up in every mode and during Play. It shows the user's own Claude Code CLI, hosted in a terminal
// by the agent host (ClaudeCodeView). Claude Code signs in with the user's Claude account, so it runs on
// their plan, and it works on the project through the Cleo MCP tools: each edit is one undo step.

/** A button of the header's joined strip. */
const ITEM = 'flex items-center justify-center w-[26px] h-[22px] text-muted hover:text-fg hover:bg-control disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted disabled:cursor-default'

export default function AgentChatPanel() {
  const s = useSyncExternalStore(panelStore.subscribe, panelStore.getSnapshot)
  const t = useSyncExternalStore(terminalStore.subscribe, terminalStore.getSnapshot)

  if (!s.open) return null

  const term = t.term
  const ready = t.link === 'ready'
  const dot = s.link === 'error' ? 'bg-danger' : !ready ? 'bg-dim animate-pulse' : term?.running ? 'bg-success-fg' : 'bg-dim'
  const state = s.link === 'error' ? (s.linkError ?? 'No agent host') : !ready ? 'Connecting to the agent host' : term?.running ? 'Running' : 'Not running'
  const about = [
    t.title ? `${t.title}\n` : null,
    `${term?.claude?.version ? `Claude Code ${term.claude.version}` : 'Claude Code'}: ${state.toLowerCase()}`,
    term?.claude?.path ?? null,
    term?.cwd ? `Started in ${term.cwd}` : null,
    'It signs in on its own: /login to sign in or switch accounts, /status to see which one it uses.',
    'Ctrl+wheel over the terminal zooms its text.',
  ].filter(Boolean).join('\n')

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

      <div className='flex items-center gap-2 h-[32px] pl-2.5 pr-1.5 border-b border-border-subtle bg-surface-sunken shrink-0'>
        <span className='w-4 h-4 shrink-0'><ClaudeIcon /></span>
        <div className='min-w-0 flex items-baseline gap-1.5 cursor-default' title={about}>
          <span className='font-semibold text-fg truncate'>{t.title ?? 'Claude Code'}</span>
          {t.title && <span className='text-ui-xs text-dim shrink-0'>Claude Code</span>}
        </div>
        <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', dot)} title={state} />
        <div className='ml-auto flex items-center gap-1 shrink-0'>
          <div className={JOINED_GROUP_CLASS}>
            <button type='button' className={ITEM} title='New session: end the running one and start a fresh Claude Code'
              disabled={t.link !== 'ready' || !term?.available} onClick={() => terminalActions.restart()}>
              <span className='w-3.5 h-3.5'><NewChatIcon /></span>
            </button>
            <button type='button' className={cn(ITEM, JOINED_DIVIDER_CLASS)} title='Stop Claude Code (the conversation is kept: Continue last picks it up)'
              disabled={!term?.running} onClick={() => terminalActions.stop()}>
              <span className='w-3.5 h-3.5'><StopSessionIcon /></span>
            </button>
          </div>
          <Button variant='ghost' size='icon' className='p-1' title='Close the panel (Claude Code keeps running)' onClick={() => panelActions.setOpen(false)}>
            <span className='block w-3.5 h-3.5'><CloseIcon /></span>
          </Button>
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
      <span className='w-3.5 h-3.5'><ClaudeIcon /></span> Claude
    </Button>
  )
}

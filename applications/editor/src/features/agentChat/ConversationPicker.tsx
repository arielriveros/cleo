import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Popover } from '@cleo/app-kit/ui/Popover'
import { controlClass } from '@cleo/app-kit/ui/inputs'
import { cn } from '@cleo/app-kit/ui/cn'
import { confirmDialog } from '@cleo/app-kit/feedback/dialogStore'
import { terminalActions, terminalStore, type Conversation } from './terminalStore'
import { conversationOrigin, filterConversations, ORIGIN_LABEL, whenLabel, type ConversationOrigin } from './conversations'
import { ChatIcon, ChevronDownIcon, ClaudeIcon, CurrentIcon, IdeIcon, NewChatIcon, TerminalIcon } from './chatIcons'

// The Claude panel's title, and the picker it opens: the conversations Claude Code saved for the folder it runs
// in (the agent host reads them, applications/mcp/src/claudeSessions.mjs), the most recent first. Picking one
// ends the running session and starts Claude Code on that conversation (`claude --resume`), as an IDE's chat
// history does. Its own conversation is saved as it goes, so it is in the list to come back to.

const ORIGIN_ICON: Record<ConversationOrigin, () => React.ReactElement> = {
  panel: () => <ClaudeIcon />,
  ide: () => <IdeIcon />,
  terminal: () => <TerminalIcon />,
  other: () => <ChatIcon />,
}

type Listing = { state: 'loading' } | { state: 'done'; conversations: Conversation[]; error: string | null }

export default function ConversationPicker({ about }: { about: string }) {
  const t = useSyncExternalStore(terminalStore.subscribe, terminalStore.getSnapshot)
  const [open, setOpen] = useState(false)
  const [listing, setListing] = useState<Listing>({ state: 'loading' })
  const asked = useRef(0)

  const onOpenChange = (next: boolean) => {
    setOpen(next)
    if (!next) return
    // Read afresh each time it opens: the session itself adds to the list as it goes.
    const ask = ++asked.current
    setListing(prev => prev.state === 'done' ? prev : { state: 'loading' })
    void terminalActions.listConversations().then(r => {
      if (ask === asked.current) setListing({ state: 'done', ...r })
    })
  }

  const term = t.term
  const title = t.title ?? t.picked ?? 'Claude Code'
  const usable = t.link === 'ready' && !!term?.available

  const pick = async (c: Conversation | null) => {
    setOpen(false)
    if (c && term?.running && c.id === term.sessionId) return
    if (term?.running && term.busy && !await confirmDialog({
      title: 'Switch conversations?',
      message: 'Claude Code is working on a turn. Switching ends it there; the conversation stays saved, so it can be picked up again here.',
      confirmLabel: 'Switch', tone: 'warning',
    })) return
    terminalActions.open(c)
  }

  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      disabled={!usable}
      title={`${about}\n\nClick for the saved conversations.`}
      rootClassName='min-w-0 -ml-1'
      triggerClassName='max-w-full min-w-0 flex items-center gap-1 h-[24px] px-1 rounded hover:bg-control disabled:hover:bg-transparent disabled:cursor-default'
      className='p-0'
      trigger={
        <>
          <span className='min-w-0 flex items-baseline gap-1.5'>
            <span className='font-semibold text-fg truncate'>{title}</span>
            {title !== 'Claude Code' && <span className='text-ui-xs text-dim shrink-0'>Claude Code</span>}
          </span>
          <span className='w-3 h-3 shrink-0 text-muted'><ChevronDownIcon /></span>
        </>
      }
    >
      <ConversationList listing={listing} current={term?.running ? term.sessionId ?? null : null} cwd={term?.cwd ?? ''} onPick={pick} />
    </Popover>
  )
}

function ConversationList({ listing, current, cwd, onPick }: {
  listing: Listing
  current: string | null
  cwd: string
  onPick: (c: Conversation | null) => void
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => { inputRef.current?.focus() }, [])

  const shown = useMemo(() => listing.state === 'done' ? filterConversations(listing.conversations, query) : [], [listing, query])
  // Row 0 is "New conversation"; the conversations follow. One open elsewhere cannot be picked.
  const rows: (Conversation | null)[] = [null, ...shown]
  const pickable = (i: number) => i === 0 || !rows[i]?.livePid
  useEffect(() => { setActive(0) }, [query])
  useEffect(() => {
    listRef.current?.querySelector(`[data-row="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const step = (dir: 1 | -1) => setActive(a => {
    for (let i = a + dir; i >= 0 && i < rows.length; i += dir) if (pickable(i)) return i
    return a
  })
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); step(1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1) }
    else if (e.key === 'Enter') { e.preventDefault(); if (pickable(active)) onPick(rows[active] ?? null) }
  }

  const now = Date.now()
  return (
    <div className='w-[360px] max-w-[85vw] flex flex-col'>
      <input ref={inputRef} type='text' value={query} placeholder='Search conversations…' onChange={e => setQuery(e.target.value)} onKeyDown={onKey}
        className={cn(controlClass, 'm-1.5 mb-1')} />
      <div ref={listRef} className='max-h-[min(420px,60vh)] overflow-y-auto px-1 pb-1'>
        <button type='button' data-row={0} onMouseEnter={() => setActive(0)} onClick={() => onPick(null)}
          className={cn('w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-ui', active === 0 && 'bg-control')}
          title='End the running session and start Claude Code on a fresh conversation'>
          <span className='w-3.5 h-3.5 shrink-0 text-muted'><NewChatIcon /></span>
          <span className='text-fg'>New conversation</span>
        </button>
        <div className='mx-2 my-1 border-t border-border-subtle' />
        {listing.state === 'loading' && <div className='px-2 py-1.5 text-ui-sm text-dim'>Reading the saved conversations…</div>}
        {listing.state === 'done' && listing.error && <div className='px-2 py-1.5 text-ui-sm text-muted leading-relaxed'>{listing.error}</div>}
        {listing.state === 'done' && !listing.error && !shown.length && (
          <div className='px-2 py-1.5 text-ui-sm text-dim'>{query ? 'No conversation matches.' : 'No saved conversations yet.'}</div>
        )}
        {shown.map((c, k) => {
          const i = k + 1
          const origin = conversationOrigin(c)
          const Icon = ORIGIN_ICON[origin]
          const elsewhere = c.livePid !== null
          const tip = [
            c.title,
            c.prompt && c.prompt !== c.title ? `“${c.prompt}”` : null,
            `${ORIGIN_LABEL[origin]}${c.branch ? ` on ${c.branch}` : ''}. Last used ${new Date(c.modifiedAt).toLocaleString()}.`,
            c.id === current ? 'The conversation Claude Code is on now.' : null,
            elsewhere ? `Open in another Claude Code (process ${c.livePid}): close it there to pick it up here.` : null,
          ].filter(Boolean).join('\n')
          return (
            <button key={c.id} type='button' data-row={i} disabled={elsewhere} title={tip}
              onMouseEnter={() => { if (!elsewhere) setActive(i) }} onClick={() => onPick(c)}
              className={cn('w-full flex items-center gap-2 px-2 py-1 rounded text-left disabled:cursor-default',
                i === active && 'bg-control', elsewhere && 'opacity-50')}>
              <span className={cn('w-3.5 h-3.5 shrink-0', origin === 'panel' ? '' : 'text-muted')}><Icon /></span>
              <span className='min-w-0 flex-1 flex flex-col'>
                <span className={cn('text-ui truncate', c.id === current ? 'text-primary' : 'text-fg')}>{c.title}</span>
                <span className='text-ui-xs text-dim truncate'>{whenLabel(c.modifiedAt, now)}{c.branch ? ` · ${c.branch}` : ''}</span>
              </span>
              {c.id === current && <span className='w-3.5 h-3.5 shrink-0 text-primary'><CurrentIcon /></span>}
            </button>
          )
        })}
      </div>
      {cwd && (
        <div className='px-2.5 py-1.5 border-t border-border-subtle text-ui-2xs text-dim truncate' title={`Claude Code saves the conversations of each folder it runs in. This panel runs in ${cwd}.`}>
          Saved by Claude Code for {cwd}
        </div>
      )}
    </div>
  )
}

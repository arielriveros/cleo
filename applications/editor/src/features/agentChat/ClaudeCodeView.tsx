import { useEffect, useRef, useSyncExternalStore } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { Button } from '@cleo/app-kit/ui/Button'
import { cn } from '@cleo/app-kit/ui/cn'
import { chatActions, chatStore } from './chatStore'
import { terminalActions, terminalKeyAction, terminalStore, type TerminalSink } from './terminalStore'

// Claude Code itself, in a terminal in the Claude panel. The agent host runs the user's own `claude` CLI in a
// pseudo-terminal; this draws it (xterm.js) and sends the keys back. Claude Code signs in through its own
// login, so it runs on the user's Claude plan, and it gets the `cleo` MCP tools for the open project.

const FONT = 'ui-monospace, "Cascadia Mono", "Cascadia Code", Consolas, "SF Mono", Menlo, monospace'
const SETUP_URL = 'https://code.claude.com/docs/en/setup'

// One terminal for the page's lifetime. It moves into the panel while the panel shows it; the host keeps the
// session, so closing the panel only stops the drawing.
let term: Terminal | null = null
let fit: FitAddon | null = null
let holder: HTMLDivElement | null = null

function themeFrom(el: HTMLElement) {
  const cs = getComputedStyle(el)
  return {
    background: cs.backgroundColor, foreground: cs.color, cursor: cs.color, cursorAccent: cs.backgroundColor,
    selectionBackground: 'rgba(110, 150, 255, 0.35)',
  }
}

function terminalIn(container: HTMLElement): Terminal {
  if (!holder) {
    holder = document.createElement('div')
    holder.style.width = '100%'
    holder.style.height = '100%'
  }
  container.appendChild(holder)
  if (term) return term
  const t = new Terminal({
    fontFamily: FONT, fontSize: 12, lineHeight: 1.1, cursorBlink: true, scrollback: 10000, allowProposedApi: true,
    theme: themeFrom(container),
    // Claude Code prints links as OSC 8 hyperlinks (FORCE_HYPERLINK in the host).
    linkHandler: { activate: (_e, uri) => { if (/^https?:\/\//i.test(uri)) window.open(uri, '_blank', 'noopener,noreferrer') } },
  })
  const f = new FitAddon()
  t.loadAddon(f)
  t.open(holder)
  t.onData(d => terminalActions.input(d))
  t.attachCustomKeyEventHandler(e => {
    const action = terminalKeyAction(e, t.hasSelection())
    if (action === 'copy') {
      const text = t.getSelection()
      if (text) void navigator.clipboard?.writeText(text).catch(() => {})
      t.clearSelection()
      return false
    }
    // Left to the browser, whose paste event xterm turns into one bracketed paste.
    if (action === 'paste') return false
    return true
  })
  term = t
  fit = f
  return t
}

const sink: TerminalSink = {
  reset(data) { term?.reset(); if (data) term?.write(data) },
  write(data) { term?.write(data) },
  size() { return { cols: term?.cols ?? 100, rows: term?.rows ?? 30 } },
  configure(s) {
    if (term && s.windowsBuild) term.options.windowsPty = { backend: 'conpty', buildNumber: s.windowsBuild }
  },
}

function Notice({ tone = 'info', children }: { tone?: 'info' | 'error'; children: React.ReactNode }) {
  return (
    <div className='absolute inset-0 flex items-center justify-center p-4 bg-surface/90'>
      <div className={cn('max-w-[340px] rounded border p-3 text-ui-sm flex flex-col gap-2 leading-snug',
        tone === 'error' ? 'border-danger bg-danger/10 text-danger-fg' : 'border-border bg-surface-raised text-muted')}>
        {children}
      </div>
    </div>
  )
}

export default function ClaudeCodeView() {
  const ref = useRef<HTMLDivElement>(null)
  const t = useSyncExternalStore(terminalStore.subscribe, terminalStore.getSnapshot)
  const panel = useSyncExternalStore(chatStore.subscribe, chatStore.getSnapshot)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const xt = terminalIn(el)
    xt.options.theme = themeFrom(el)
    let last = ''
    const refit = () => {
      if (!fit || el.clientWidth < 40 || el.clientHeight < 40) return
      try { fit.fit() } catch { return }
      const size = `${xt.cols}x${xt.rows}`
      if (size !== last) { last = size; terminalActions.resize(xt.cols, xt.rows) }
    }
    const observer = new ResizeObserver(refit)
    observer.observe(el)
    refit()
    terminalActions.registerSink(sink)
    xt.focus()
    return () => {
      observer.disconnect()
      terminalActions.registerSink(null)
      holder?.remove()
    }
  }, [])

  const s = t.term
  let notice: React.ReactNode = null
  if (panel.link === 'error') {
    notice = (
      <Notice tone='error'>
        <div>{panel.linkError ?? 'Could not reach the agent host.'}</div>
        <Button size='sm' className='self-start' onClick={() => chatActions.retry()}>Retry</Button>
      </Notice>
    )
  } else if (t.link === 'outdated') {
    notice = (
      <Notice>
        <div className='text-fg'>The agent host that is running is an older one and cannot host Claude Code.</div>
        <Button size='sm' className='self-start' onClick={() => chatActions.retry()}>Restart the agent host</Button>
      </Notice>
    )
  } else if (t.link !== 'ready' || !s) {
    notice = <Notice><div>Starting the agent host…</div></Notice>
  } else if (s.problem?.code === 'not-installed') {
    notice = <Notice tone='error'><div>{s.problem.message}</div></Notice>
  } else if (!s.available) {
    notice = (
      <Notice>
        <div className='text-fg font-semibold'>Claude Code is not installed</div>
        <div>This panel runs your own Claude Code, signed in with your Claude account. Install it, then check again.</div>
        <a href={SETUP_URL} target='_blank' rel='noopener noreferrer' className='text-highlight underline self-start'>How to install Claude Code</a>
        <Button size='sm' className='self-start' onClick={() => terminalActions.start()}>Check again</Button>
      </Notice>
    )
  }

  const stopped = !notice && s && !s.running
  return (
    <div className='flex-1 min-h-0 flex flex-col'>
      <div className='relative flex-1 min-h-0'>
        {/* The terminal draws here; px so its fit sees the real content box. */}
        <div ref={ref} className='absolute inset-0 pl-2 pt-1 bg-surface text-fg' onMouseDown={() => term?.focus()} />
        {notice}
      </div>
      {stopped && (
        <div className='shrink-0 border-t border-border px-2 py-1.5 flex items-center gap-1.5 text-ui-sm'>
          <span className={cn('truncate', s.problem ? 'text-danger-fg' : 'text-muted')}>
            {s.problem ? s.problem.message : s.started ? `Claude Code exited${s.exitCode !== null ? ` (code ${s.exitCode})` : ''}.` : 'Claude Code is not running.'}
          </span>
          <div className='ml-auto flex gap-1.5 shrink-0'>
            <Button size='sm' variant='primary' onClick={() => terminalActions.start()}>New session</Button>
            <Button size='sm' onClick={() => terminalActions.start(true)} title='claude --continue: the most recent conversation in this folder'>Continue last</Button>
          </div>
        </div>
      )}
      <div className='shrink-0 border-t border-border-subtle px-2 py-0.5 text-ui-xs text-dim truncate'
        title={s?.claude ? `${s.claude.path}\nStarted in ${s.cwd}` : undefined}>
        {s?.claude?.version ? `Claude Code ${s.claude.version}` : 'Claude Code'} · its own sign-in: /login, and /status shows the account
      </div>
    </div>
  )
}

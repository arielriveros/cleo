import { useEffect, useRef, useSyncExternalStore } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { Button } from '@cleo/app-kit/ui/Button'
import { cn } from '@cleo/app-kit/ui/cn'
import { JOINED_DIVIDER_CLASS, JOINED_GROUP_CLASS } from '@cleo/app-kit/ui/SegmentedControl'
import { tokenHex } from '@cleo/app-kit/utils/cssTokens'
import { clamp } from '@cleo/app-kit/utils/math'
import { panelActions, panelStore } from './panelStore'
import { terminalActions, terminalKeyAction, terminalStore, type TerminalSink } from './terminalStore'
import { ChatIcon, ContinueIcon, NewChatIcon } from './chatIcons'

// Claude Code itself, in a terminal in the Claude panel. The agent host runs the user's own `claude` CLI in a
// pseudo-terminal; this draws it (xterm.js) and sends the keys back. Claude Code signs in through its own
// login, so it runs on the user's Claude plan, and it gets the `cleo` MCP tools for the open project.

const FONT = 'ui-monospace, "Cascadia Mono", "Cascadia Code", Consolas, "SF Mono", Menlo, monospace'
const SETUP_URL = 'https://code.claude.com/docs/en/setup'

/** The text size, which Ctrl+wheel over the terminal changes; remembered across sessions. */
const FONT_KEY = 'cleo_agent_chat_font_size'
const FONT_MIN = 9, FONT_MAX = 20, FONT_DEFAULT = 12
/**
 * Line spacing on the GPU renderer, which draws box and block characters itself so Claude Code's frames and
 * logo stay joined. The DOM renderer, the fallback, draws them with the font, which leaves a gap between
 * rows at any spacing above 1.
 */
const GPU_LINE_HEIGHT = 1.15

/**
 * The 16 terminal colours: VS Code's dark terminal palette. Claude Code's own theme draws most of its screen
 * in exact colours; these are for what it leaves to the terminal (its ANSI themes, the output of commands).
 */
const ANSI: ITheme = {
  black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510',
  blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
  brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543',
  brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#e5e5e5',
}

// One terminal for the page's lifetime. It moves into the panel while the panel shows it; the host keeps the
// session, so closing the panel only stops the drawing.
let term: Terminal | null = null
let fit: FitAddon | null = null
let gpu: WebglAddon | null = null
let holder: HTMLDivElement | null = null
/** Fits the terminal to the panel again; set while the panel shows it. */
let refitShown: (() => void) | null = null

function readFontSize(): number {
  try {
    const n = Number(localStorage.getItem(FONT_KEY))
    return Number.isInteger(n) && n >= FONT_MIN && n <= FONT_MAX ? n : FONT_DEFAULT
  } catch { return FONT_DEFAULT }
}

/** The editor's colours (read when used: the stylesheet is not there yet when this module loads). */
function theme(): ITheme {
  return {
    background: tokenHex('--surface'), foreground: tokenHex('--text'),
    cursor: tokenHex('--text'), cursorAccent: tokenHex('--surface'),
    selectionBackground: tokenHex('--primary', 0.45), selectionInactiveBackground: tokenHex('--primary', 0.25),
    scrollbarSliderBackground: tokenHex('--control-hover', 0.45),
    scrollbarSliderHoverBackground: tokenHex('--control-hover', 0.75),
    scrollbarSliderActiveBackground: tokenHex('--text-dim', 0.6),
    ...ANSI,
  }
}

/**
 * Draw on the GPU where WebGL is there; fall back to the DOM renderer if it is not, or once it is lost.
 * The terminal is made with the GPU's line spacing, so the renderer measures its rows with it from the start:
 * a fit taken before a late change of spacing sizes the screen for more rows than show, and its top rows
 * end up scrolled out of sight.
 */
function drawOnGpu(t: Terminal) {
  try {
    const addon = new WebglAddon()
    addon.onContextLoss(() => dropGpu())
    t.loadAddon(addon)
    gpu = addon
  } catch {
    dropGpu()
  }
}

function dropGpu() {
  try { gpu?.dispose() } catch { /* already gone with its context */ }
  gpu = null
  if (term) term.options.lineHeight = 1
  refitShown?.()
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
    fontFamily: FONT, fontSize: readFontSize(), lineHeight: GPU_LINE_HEIGHT, letterSpacing: 0,
    cursorBlink: true, scrollback: 10000, allowProposedApi: true, theme: theme(),
    // Claude Code prints links as OSC 8 hyperlinks (FORCE_HYPERLINK in the host).
    linkHandler: { activate: (_e, uri) => { if (/^https?:\/\//i.test(uri)) window.open(uri, '_blank', 'noopener,noreferrer') } },
  })
  const f = new FitAddon()
  t.loadAddon(f)
  t.open(holder)
  drawOnGpu(t)
  t.onData(d => terminalActions.input(d))
  t.onTitleChange(title => terminalActions.setTitle(title))
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

/** A card over the terminal while there is nothing to type to: starting, not installed, no link. */
function Notice({ tone = 'info', busy, title, children }: { tone?: 'info' | 'error'; busy?: boolean; title?: string; children: React.ReactNode }) {
  return (
    <div className='absolute inset-0 flex items-center justify-center p-6 bg-surface/95'>
      <div className={cn('w-full max-w-[320px] rounded-md border p-4 flex flex-col items-center text-center gap-2.5',
        tone === 'error' ? 'border-danger-border bg-danger/10' : 'border-border-subtle bg-surface-raised')}>
        <span className={cn('relative w-7 h-7', tone === 'error' ? 'text-danger-fg' : 'text-highlight')}>
          <ChatIcon />
          {busy && <span className='absolute -inset-1.5 rounded-full border-2 border-highlight/25 border-t-highlight animate-spin' />}
        </span>
        {title && <div className='text-ui-lg font-semibold text-fg'>{title}</div>}
        <div className={cn('flex flex-col items-center gap-2.5 text-ui-sm leading-relaxed', tone === 'error' ? 'text-danger-fg' : 'text-muted')}>
          {children}
        </div>
      </div>
    </div>
  )
}

export default function ClaudeCodeView() {
  const ref = useRef<HTMLDivElement>(null)
  const t = useSyncExternalStore(terminalStore.subscribe, terminalStore.getSnapshot)
  const panel = useSyncExternalStore(panelStore.subscribe, panelStore.getSnapshot)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const xt = terminalIn(el)
    xt.options.theme = theme()
    let last = ''
    const fitNow = () => {
      if (!fit || el.clientWidth < 40 || el.clientHeight < 40) return
      try { fit.fit() } catch { return }
      const size = `${xt.cols}x${xt.rows}`
      if (size !== last) { last = size; terminalActions.resize(xt.cols, xt.rows) }
    }
    // Again a frame later: a change of text size or renderer reaches the cell size the fit reads only when
    // the terminal next draws.
    const refit = () => { fitNow(); requestAnimationFrame(fitNow) }
    refitShown = refit
    const observer = new ResizeObserver(fitNow)
    observer.observe(el)
    refit()
    // Ctrl+wheel over the terminal zooms its text, as in an IDE's terminal (and not the whole page).
    let wheel = 0
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      e.stopPropagation()
      wheel += e.deltaY
      if (Math.abs(wheel) < 40) return
      const size = clamp((xt.options.fontSize ?? FONT_DEFAULT) + (wheel < 0 ? 1 : -1), FONT_MIN, FONT_MAX)
      wheel = 0
      if (size === xt.options.fontSize) return
      xt.options.fontSize = size
      try { localStorage.setItem(FONT_KEY, String(size)) } catch { /* private mode */ }
      refit()
    }
    el.addEventListener('wheel', onWheel, { capture: true, passive: false })
    terminalActions.registerSink(sink)
    xt.focus()
    return () => {
      observer.disconnect()
      el.removeEventListener('wheel', onWheel, { capture: true })
      if (refitShown === refit) refitShown = null
      terminalActions.registerSink(null)
      holder?.remove()
    }
  }, [])

  const s = t.term
  let notice: React.ReactNode = null
  if (panel.link === 'error') {
    notice = (
      <Notice tone='error' title='No agent host'>
        <div>{panel.linkError ?? 'Could not reach the agent host.'}</div>
        <Button size='sm' onClick={() => panelActions.retry()}>Retry</Button>
      </Notice>
    )
  } else if (t.link === 'outdated') {
    notice = (
      <Notice title='Agent host out of date'>
        <div>The editor is linked to an MCP server that cannot host Claude Code (an older agent host, or a standalone server).</div>
        <Button size='sm' variant='primary' onClick={() => panelActions.retry()}>Start the agent host</Button>
      </Notice>
    )
  } else if (t.link !== 'ready' || !s) {
    notice = <Notice busy><div>Starting the agent host…</div></Notice>
  } else if (s.problem?.code === 'not-installed') {
    notice = <Notice tone='error' title='Agent package not installed'><div>{s.problem.message}</div></Notice>
  } else if (!s.available) {
    notice = (
      <Notice title='Claude Code is not installed'>
        <div>This panel runs your own Claude Code, signed in with your Claude account. Install it, then check again.</div>
        <a href={SETUP_URL} target='_blank' rel='noopener noreferrer' className='text-highlight underline-offset-2 hover:underline'>How to install Claude Code</a>
        <Button size='sm' variant='primary' onClick={() => terminalActions.start()}>Check again</Button>
      </Notice>
    )
  }

  const stopped = !notice && s && !s.running
  const segment = 'flex items-center gap-1.5 px-2.5 h-[24px] text-ui hover:bg-control disabled:opacity-50 disabled:cursor-default'
  return (
    <div className='flex-1 min-h-0 flex flex-col'>
      {/* The terminal draws here: the padding keeps its text off the panel's edges, and the frame lights up
          while it has the keys. */}
      <div className='relative flex-1 min-h-0 bg-surface ring-inset focus-within:ring-1 focus-within:ring-primary/40'>
        <div ref={ref} className='absolute inset-0 pl-2.5 pr-1 pt-2 pb-1 text-fg' onMouseDown={() => term?.focus()} />
        {notice}
      </div>
      {stopped && (
        <div className='shrink-0 border-t border-border-subtle bg-surface-sunken px-2.5 py-2 flex items-center gap-2 text-ui-sm'>
          <span className={cn('min-w-0 truncate', s.problem ? 'text-danger-fg' : 'text-muted')}>
            {s.problem ? s.problem.message : s.started ? `Claude Code exited${s.exitCode !== null ? ` (code ${s.exitCode})` : ''}.` : 'Claude Code is not running.'}
          </span>
          <div className={cn('ml-auto shrink-0', JOINED_GROUP_CLASS)}>
            <button type='button' className={cn(segment, 'bg-primary/25 text-fg hover:bg-primary/40')} onClick={() => terminalActions.start()}
              title='Start a fresh Claude Code session'>
              <span className='w-3.5 h-3.5'><NewChatIcon /></span>New session
            </button>
            <button type='button' className={cn(segment, JOINED_DIVIDER_CLASS, 'text-fg')} onClick={() => terminalActions.start(true)}
              title='claude --continue: pick up the most recent conversation in this folder'>
              <span className='w-3.5 h-3.5'><ContinueIcon /></span>Continue last
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

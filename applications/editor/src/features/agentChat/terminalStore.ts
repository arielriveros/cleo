import { agentBridge } from '../agentBridge/bridgeClient'

// Claude Code, hosted in the editor: the agent host runs the user's own `claude` CLI in a pseudo-terminal
// (applications/mcp/src/terminal.mjs) and this store is the editor's end of it. The process and its screen
// live in the host, so a reload loses nothing: on every new link the terminal attaches and gets the screen
// back as a snapshot. Output is a stream, not React state, so it goes straight to the one terminal
// (ClaudeCodeView registers it as the sink); only the session's state goes through the store.

export interface TerminalProblem { code: 'not-installed' | 'no-claude' | 'start-failed'; message: string }

export interface TerminalState {
  available: boolean
  problem: TerminalProblem | null
  running: boolean
  pid: number | null
  /** Whether this host ever started a session: a fresh host starts one by itself, an exited one waits. */
  started: boolean
  exitCode: number | null
  cols: number
  rows: number
  cwd: string
  claude: { path: string; version: string | null } | null
  windowsBuild: number | null
}

/**
 * - `idle`: no link to a host yet.
 * - `outdated`: linked to a host that has no terminal (an older one).
 * - `attaching`: asked for the screen.
 * - `ready`: the screen is current and output streams.
 */
export type TerminalLink = 'idle' | 'outdated' | 'attaching' | 'ready'

export interface TerminalSnapshot { link: TerminalLink; term: TerminalState | null }

/** Where output goes: the editor's one terminal. */
export interface TerminalSink {
  reset(data: string): void
  write(data: string): void
  size(): { cols: number; rows: number }
  /** Called once the host has told us its platform, before the first output. */
  configure(state: TerminalState): void
}

let state: TerminalSnapshot = { link: 'idle', term: null }
const listeners = new Set<() => void>()
let sink: TerminalSink | null = null
let attachedLink = -1
/** A fresh host starts Claude Code by itself, once per page: after that, starting is the user's call. */
let autoStarted = false

function set(patch: Partial<TerminalSnapshot>) {
  state = { ...state, ...patch }
  for (const cb of [...listeners]) cb()
}

export const terminalStore = {
  subscribe(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb) } },
  getSnapshot(): TerminalSnapshot { return state },
}

function onEvent(ev: any) {
  switch (ev?.kind) {
    case 'snapshot': {
      const term = ev.state as TerminalState
      if (sink) { sink.configure(term); sink.reset(String(ev.data ?? '')) }
      set({ link: 'ready', term })
      maybeAutoStart(term)
      return
    }
    case 'output':
      sink?.write(String(ev.data ?? ''))
      return
    case 'state': {
      const { kind: _kind, ...term } = ev
      set({ term: term as TerminalState })
      return
    }
    default:
      return
  }
}

function maybeAutoStart(term: TerminalState) {
  if (autoStarted || !sink || term.running || term.started || !term.available) return
  autoStarted = true
  terminalActions.start()
}

function attach() {
  if (!sink) return
  const b = agentBridge.getSnapshot()
  if (b.state !== 'connected') return
  if (!b.capabilities.includes('terminal')) { if (state.link !== 'outdated') set({ link: 'outdated' }); return }
  if (b.link === attachedLink && state.link !== 'idle') return
  attachedLink = b.link
  if (agentBridge.sendTerm('attach')) set({ link: 'attaching' })
}

agentBridge.onTermEvent(onEvent)
agentBridge.subscribe(() => {
  const b = agentBridge.getSnapshot()
  if (b.state === 'connected') attach()
  else if (state.link !== 'idle') { attachedLink = -1; set({ link: 'idle' }) }
})

export const terminalActions = {
  /** The terminal is on screen: from now on its output goes there, and it is brought up to date. */
  registerSink(next: TerminalSink | null) {
    sink = next
    // A fresh snapshot each time it is shown: what streamed while it was away was not drawn.
    if (next) { attachedLink = -1; attach() }
  },
  start(resume = false) {
    const size = sink?.size() ?? { cols: 100, rows: 30 }
    agentBridge.sendTerm('start', { cols: size.cols, rows: size.rows, resume })
  },
  input(data: string) {
    if (state.term?.running) agentBridge.sendTerm('input', { data })
  },
  resize(cols: number, rows: number) {
    agentBridge.sendTerm('resize', { cols, rows })
  },
  stop() { agentBridge.sendTerm('stop') },
  /** Stop the running session and start a fresh one. */
  restart() {
    if (!state.term?.running) { terminalActions.start(); return }
    const off = terminalStore.subscribe(() => {
      if (state.term && !state.term.running) { off(); terminalActions.start() }
    })
    terminalActions.stop()
  },
}

/**
 * What a key does in the terminal before xterm sees it: the editor's copy and paste habits (Ctrl+C copies
 * when there is a selection, otherwise it is the program's interrupt; Ctrl+V pastes through the browser so
 * it arrives as one bracketed paste), and everything else goes to the program.
 */
export function terminalKeyAction(e: Pick<KeyboardEvent, 'type' | 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>, hasSelection: boolean): 'copy' | 'paste' | 'pass' {
  if (e.type !== 'keydown' || e.altKey) return 'pass'
  const mod = e.ctrlKey || e.metaKey
  const key = e.key.toLowerCase()
  if (mod && key === 'c' && (hasSelection || e.shiftKey)) return 'copy'
  if (mod && key === 'v') return 'paste'
  if (e.shiftKey && !mod && key === 'insert') return 'paste'
  return 'pass'
}

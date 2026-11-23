import { agentBridge } from '../agentBridge/bridgeClient'

// Claude Code, hosted in the editor: the agent host runs the user's own `claude` CLI in a pseudo-terminal
// (applications/mcp/src/terminal.mjs) and this store is the editor's end of it. The process and its screen
// live in the host, so a reload loses nothing: on every new link the terminal attaches and gets the screen
// back as a snapshot. Output is a stream, not React state, so it goes straight to the one terminal
// (ClaudeCodeView registers it as the sink); only the session's state goes through the store.

export interface TerminalProblem { code: 'not-installed' | 'no-claude' | 'start-failed' | 'resume-failed'; message: string }

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
  // From a host that follows conversations (the `sessions` capability, cleo-mcp 0.6.1); left out by older ones.
  /** The conversation the session is on, or was on when it ended: Claude Code's session id. */
  sessionId?: string | null
  /** Whether that conversation is saved, so Continue last can pick it up. */
  resumable?: boolean
  /** Claude Code is working on a turn, not waiting for the user. */
  busy?: boolean
  /** The terminal title Claude Code set last (the header's title after a reload). */
  title?: string | null
}

/** A conversation Claude Code saved for the folder it runs in, as the picker lists it. */
export interface Conversation {
  id: string
  /** Its /rename name, else the title Claude Code wrote for it, else its first prompt. */
  title: string
  prompt: string | null
  modifiedAt: number
  createdAt: number | null
  /** Where it was started: 'cli' (a terminal, this panel included), 'claude-vscode', ... */
  entrypoint: string | null
  branch: string | null
  /** Started in this panel. */
  hosted: boolean
  /** Open in another Claude Code right now (that process), so it cannot be picked up here. */
  livePid: number | null
}

/** How a session starts: a fresh conversation, the last one (`true`), or a saved one by id. */
export type StartHow = { resume?: true | string }

/**
 * - `idle`: no link to a host yet.
 * - `outdated`: linked to a host that has no terminal (an older one).
 * - `attaching`: asked for the screen.
 * - `ready`: the screen is current and output streams.
 */
export type TerminalLink = 'idle' | 'outdated' | 'attaching' | 'ready'

export interface TerminalSnapshot {
  link: TerminalLink
  term: TerminalState | null
  /**
   * What the session is about, from the title Claude Code gives its terminal (a short summary of the task
   * once it has one), or null while it has none: the panel's header shows it, as an IDE shows a chat's title.
   * The host keeps the last one, so a reload shows it again.
   */
  title: string | null
  /** The title of the conversation picked in the header, shown until Claude Code titles the session itself. */
  picked: string | null
}

/** Where output goes: the editor's one terminal. */
export interface TerminalSink {
  reset(data: string): void
  write(data: string): void
  size(): { cols: number; rows: number }
  /** Called once the host has told us its platform, before the first output. */
  configure(state: TerminalState): void
}

let state: TerminalSnapshot = { link: 'idle', term: null, title: null, picked: null }
const listeners = new Set<() => void>()
let sink: TerminalSink | null = null
let attachedLink = -1
/**
 * A host that has not run a session yet starts Claude Code by itself, once per link: the page just loaded, or
 * the host started again under it (the dev server restarted). It carries on with the conversation the panel
 * was on. Once a session ran, starting is the user's call (a session they stopped stays stopped).
 */
let autoStartedLink = -1
/** Conversation lists asked of the host, by request. */
const listRequests = new Map<number, (ev: any) => void>()
let nextListRequest = 1

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
      // The xterm title is not part of the screen: the host's copy of it names the session after a reload.
      set({ link: 'ready', term, ...(term.title !== undefined ? { title: term.title ? sessionTitle(term.title) : null } : {}) })
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
    case 'sessions': {
      const done = listRequests.get(ev.reqId)
      listRequests.delete(ev.reqId)
      done?.(ev)
      return
    }
    default:
      return
  }
}

/** The host follows conversations (lists them, resumes by id, remembers the last). */
function hostHasSessions(): boolean {
  return agentBridge.getSnapshot().capabilities.includes('sessions')
}

function maybeAutoStart(term: TerminalState) {
  if (!sink || term.running || term.started || !term.available) return
  const link = agentBridge.getSnapshot().link
  if (link === autoStartedLink) return
  autoStartedLink = link
  // `auto`: the conversation the panel was on if the host can pick it up, else a fresh one. An older host
  // ignores it and starts a fresh one (its `resume` would be --continue: the folder's latest conversation,
  // which may belong to another program).
  sendStart({ auto: true })
}

function sendStart(extra: Record<string, unknown>) {
  const size = sink?.size() ?? { cols: 100, rows: 30 }
  if (state.title !== null) set({ title: null })
  agentBridge.sendTerm('start', { cols: size.cols, rows: size.rows, ...extra })
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
  /** Start Claude Code: a fresh conversation, the last one (`resume: true`), or a saved one by id. */
  start(how: StartHow = {}) {
    if (how.resume === undefined && state.picked !== null) set({ picked: null })
    sendStart(how.resume === undefined ? {} : { resume: how.resume })
  },
  /**
   * Carry on with a saved conversation (the header's picker), or a fresh one with null: the running session
   * ends first, its own conversation saved as it went.
   */
  open(conversation: Pick<Conversation, 'id' | 'title'> | null) {
    terminalActions.restart(conversation ? { resume: conversation.id } : {})
    set({ picked: conversation?.title ?? null })
  },
  /**
   * The conversations Claude Code saved for the folder it runs in, the most recent first. `error` says why
   * there are none to show when the host could not list them.
   */
  listConversations(): Promise<{ conversations: Conversation[]; error: string | null }> {
    if (!hostHasSessions()) return Promise.resolve({ conversations: [], error: OUTDATED_HOST })
    const reqId = nextListRequest++
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        listRequests.delete(reqId)
        resolve({ conversations: [], error: 'The agent host did not answer.' })
      }, 15_000)
      listRequests.set(reqId, ev => {
        clearTimeout(timer)
        resolve({ conversations: Array.isArray(ev.sessions) ? ev.sessions : [], error: ev.error ? String(ev.error) : null })
      })
      if (!agentBridge.sendTerm('sessions', { reqId })) {
        clearTimeout(timer)
        listRequests.delete(reqId)
        resolve({ conversations: [], error: 'Not linked to the agent host.' })
      }
    })
  },
  /** The terminal's title changed (an OSC sequence in Claude Code's output). */
  setTitle(raw: string) {
    const title = sessionTitle(raw)
    if (title !== state.title) set({ title })
  },
  input(data: string) {
    if (state.term?.running) agentBridge.sendTerm('input', { data })
  },
  resize(cols: number, rows: number) {
    agentBridge.sendTerm('resize', { cols, rows })
  },
  stop() { agentBridge.sendTerm('stop') },
  /** Stop the running session and start another: a fresh one unless `how` says otherwise. */
  restart(how: StartHow = {}) {
    if (!state.term?.running) { terminalActions.start(how); return }
    const off = terminalStore.subscribe(() => {
      if (state.term && !state.term.running) { off(); terminalActions.start(how) }
    })
    terminalActions.stop()
  },
}

/** Why a host cannot list conversations: it predates them (cleo-mcp before 0.6.1). */
export const OUTDATED_HOST = 'The agent host running now is older than this editor and cannot list conversations. Reload the editor to update it: Claude Code starts again with it, and its conversation can then be picked up here.'

/**
 * What Claude Code takes as a new line in its prompt, rather than sending it: a line feed (Ctrl+J). Shift+Enter
 * and Shift+Space send it; plain Enter sends the prompt.
 */
export const NEWLINE = '\n'

/**
 * A session title from a terminal title, or null when it names no task. Claude Code titles its terminal
 * "✳ Claude Code" until it knows what the session is about, then with a short summary, behind a glyph that
 * shows its state. Before that the console host titles it with the program's path.
 */
export function sessionTitle(raw: string): string | null {
  const text = raw.replace(/^[^\p{L}\p{N}]+/u, '').trim()
  if (!text || /^claude( code)?$/i.test(text)) return null
  if (/[\\/]/.test(text) && /\.(exe|cmd|bat)$|[\\/]claude$/i.test(text)) return null
  return text
}

/**
 * What a key does in the terminal before xterm sees it: the editor's copy and paste habits (Ctrl+C copies
 * when there is a selection, otherwise it is the program's interrupt; Ctrl+V pastes through the browser so
 * it arrives as one bracketed paste), a new line in the prompt on Shift+Enter or Shift+Space (as in a chat
 * box; xterm would send Shift+Enter as a plain Enter, which sends the prompt), and everything else goes to
 * the program. `swallow`: the keypress that follows a key already handled, which would type it again.
 */
export function terminalKeyAction(e: Pick<KeyboardEvent, 'type' | 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>, hasSelection: boolean): 'copy' | 'paste' | 'newline' | 'swallow' | 'pass' {
  const mod = e.ctrlKey || e.metaKey
  const key = e.key.toLowerCase()
  if (e.shiftKey && !mod && !e.altKey && (key === 'enter' || key === ' ')) {
    if (e.type === 'keydown') return 'newline'
    if (e.type === 'keypress') return 'swallow'
  }
  if (e.type !== 'keydown' || e.altKey) return 'pass'
  if (mod && key === 'c' && (hasSelection || e.shiftKey)) return 'copy'
  if (mod && key === 'v') return 'paste'
  if (e.shiftKey && !mod && key === 'insert') return 'paste'
  return 'pass'
}

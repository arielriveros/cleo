import { agentBridge } from '../agentBridge/bridgeClient'

// The Claude panel's own state: whether it is open, how wide, and the link to the agent host
// (applications/mcp/src/host.mjs), which runs Claude Code for it. What runs IN the panel is terminalStore.
//
// Opening the panel makes sure the host runs: the dev server starts it (POST /__cleo/agent-host/start,
// app-kit/vite.preset.ts), and the bridge then connects to it. A link to something that cannot host Claude
// Code (an older host, a standalone MCP server) goes through the same start, which replaces it.

export type PanelLink = 'idle' | 'starting' | 'connecting' | 'ready' | 'error'

export interface PanelState {
  open: boolean
  width: number
  link: PanelLink
  linkError: string | null
}

// The keys predate the panel's rename; kept so the panel stays where the user left it.
const OPEN_KEY = 'cleo_agent_chat_open'
const WIDTH_KEY = 'cleo_agent_chat_width'
export const PANEL_MIN_WIDTH = 300

function readLs(key: string): string | null { try { return localStorage.getItem(key) } catch { return null } }
function writeLs(key: string, v: string) { try { localStorage.setItem(key, v) } catch { /* private mode */ } }

let state: PanelState = {
  open: readLs(OPEN_KEY) === '1',
  width: Math.max(PANEL_MIN_WIDTH, Number(readLs(WIDTH_KEY)) || 400),
  link: 'idle',
  linkError: null,
}
const listeners = new Set<() => void>()

function set(patch: Partial<PanelState>) {
  state = { ...state, ...patch }
  for (const cb of [...listeners]) cb()
}

export const panelStore = {
  subscribe(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb) } },
  getSnapshot(): PanelState { return state },
}

agentBridge.subscribe(() => {
  const b = agentBridge.getSnapshot()
  if (b.state === 'connected') {
    if (state.link !== 'ready') set({ link: 'ready', linkError: null })
  } else if (state.link === 'ready' || state.link === 'connecting') {
    // The host went away (it idled out, or was replaced): bring one back while the panel is open.
    set({ link: 'idle' })
    if (state.open) void ensureHost()
  }
})

let starting: Promise<void> | null = null

/** Make sure the agent host runs and the bridge is linked to it: what opening the panel does. */
export function ensureHost(): Promise<void> {
  if (starting) return starting
  const b = agentBridge.getSnapshot()
  if (b.state === 'connected' && b.capabilities.includes('terminal')) return Promise.resolve()
  if (!agentBridge.supported) {
    set({ link: 'error', linkError: 'The Claude panel needs the editor dev server (npm run editor:dev); the packaged app has no agent host yet.' })
    return Promise.resolve()
  }
  set({ link: 'starting', linkError: null })
  starting = (async () => {
    try {
      const res = await fetch('/__cleo/agent-host/start', { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body.ok) throw new Error(body.error || `The dev server answered ${res.status}.`)
      // A link to an older or standalone server would block the host's: drop it and connect afresh.
      if (agentBridge.getSnapshot().state === 'connected') agentBridge.disconnect()
      agentBridge.connect()
      set({ link: 'connecting' })
    } catch (err) {
      set({ link: 'error', linkError: err instanceof Error ? err.message : String(err) })
    } finally {
      starting = null
    }
  })()
  return starting
}

export const panelActions = {
  setOpen(open: boolean) {
    writeLs(OPEN_KEY, open ? '1' : '0')
    set({ open })
    if (open) void ensureHost()
  },
  toggle() { panelActions.setOpen(!state.open) },
  setWidth(width: number) {
    const w = Math.round(Math.max(PANEL_MIN_WIDTH, Math.min(window.innerWidth * 0.6, width)))
    writeLs(WIDTH_KEY, String(w))
    set({ width: w })
  },
  retry() { void ensureHost() },
}

// Opened at boot (remembered from last time): start the host right away.
if (state.open) queueMicrotask(() => { void ensureHost() })

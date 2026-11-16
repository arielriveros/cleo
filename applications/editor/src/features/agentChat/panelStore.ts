import { agentBridge } from '../agentBridge/bridgeClient'
import { agentHostStore, ensureHost } from '../agentBridge/agentHost'

// The Claude panel's own state: whether it is open, how wide, and how its link to the agent host
// (applications/mcp/src/host.mjs), which runs Claude Code for it, is doing. What runs IN the panel is
// terminalStore.
//
// The link itself belongs to the MCP server addon (agentBridge/agentHost.ts), which keeps the host running while
// it is on. Opening the panel asks for the host as well, and links even if the user had turned the link off.

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

/** The panel's view of the link, from the bridge and the agent host's start. */
function syncLink() {
  const b = agentBridge.getSnapshot()
  const host = agentHostStore.getSnapshot()
  const link: PanelLink = b.state === 'connected' ? 'ready'
    : host.state === 'error' ? 'error'
    : host.state === 'starting' ? 'starting'
    : b.state === 'connecting' ? 'connecting'
    : 'idle'
  const linkError = link === 'error' ? host.error : null
  if (link !== state.link || linkError !== state.linkError) set({ link, linkError })
}
agentBridge.subscribe(syncLink)
agentHostStore.subscribe(syncLink)
syncLink()

export const panelActions = {
  setOpen(open: boolean) {
    writeLs(OPEN_KEY, open ? '1' : '0')
    set({ open })
    if (open) void ensureHost({ connect: true })
  },
  toggle() { panelActions.setOpen(!state.open) },
  setWidth(width: number) {
    const w = Math.round(Math.max(PANEL_MIN_WIDTH, Math.min(window.innerWidth * 0.6, width)))
    writeLs(WIDTH_KEY, String(w))
    set({ width: w })
  },
  retry() { void ensureHost({ connect: true }) },
}

// Opened at boot (remembered from last time): ask for the host right away.
if (state.open) queueMicrotask(() => { void ensureHost({ connect: true }) })

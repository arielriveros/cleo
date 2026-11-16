import { agentBridge } from './bridgeClient'

// The agent host (applications/mcp/src/host.mjs): the Cleo MCP server the editor's agent link connects to, which
// also hosts the Claude panel's terminal. The dev server starts it (POST /__cleo/agent-host/start,
// app-kit/vite.preset.ts). While the MCP server addon is on (./addon.tsx), its AgentBridgeHost keeps the host
// running and the link up, panel or not, and brings the host back when it idles out or is replaced. Opening the
// Claude panel asks for it too. A link to something that cannot host Claude Code (an older host, a standalone MCP
// server) goes through the same start, which replaces it.

export type AgentHostState = 'idle' | 'starting' | 'error'

export interface AgentHostStatus {
  state: AgentHostState
  /** Why the last start failed, while `state` is 'error'. */
  error: string | null
}

let status: AgentHostStatus = { state: 'idle', error: null }
const listeners = new Set<() => void>()

function set(patch: Partial<AgentHostStatus>) {
  status = { ...status, ...patch }
  for (const cb of [...listeners]) cb()
}

export const agentHostStore = {
  subscribe(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb) } },
  getSnapshot(): AgentHostStatus { return status },
}

/** Why a build without the dev server has no MCP server: the chip and the Claude panel say it. */
export const NO_AGENT_HOST = "The MCP server runs with the editor's dev server (npm run editor:dev); this build has no agent host yet."

let starting: Promise<void> | null = null
/** A start asked to link even though the user had turned the link off; honoured once the link is kept. */
let pendingConnect = false
/** Holders of keepAgentHost: the link runs only while there is one (the MCP server addon is on). */
let keepers = 0

/**
 * Make sure the agent host runs and the bridge is linked to it. `connect`: link even if the user turned the link
 * off (opening the Claude panel, the chip's Connect); otherwise a Disconnect the user chose stands.
 */
export function ensureHost(options: { connect?: boolean } = {}): Promise<void> {
  if (options.connect) pendingConnect = true
  if (starting) return starting
  const b = agentBridge.getSnapshot()
  if (b.state === 'connected' && b.capabilities.includes('terminal')) { pendingConnect = false; return Promise.resolve() }
  if (!agentBridge.supported) {
    set({ state: 'error', error: NO_AGENT_HOST })
    return Promise.resolve()
  }
  set({ state: 'starting', error: null })
  starting = (async () => {
    try {
      const res = await fetch('/__cleo/agent-host/start', { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body.ok) throw new Error(body.error || `The dev server answered ${res.status}.`)
      set({ state: 'idle', error: null })
      // The MCP server addon went off while the host started: it stays unlinked.
      if (keepers === 0) return
      const now = agentBridge.getSnapshot().state
      // A link to an older or standalone server would block the host's: drop it and connect afresh.
      if (now === 'connected') { agentBridge.disconnect(); agentBridge.connect() }
      // Not over another tab's link (standby) or a refused token unless asked: the chip offers those.
      else if (pendingConnect || (agentBridge.enabled && (now === 'searching' || now === 'off'))) agentBridge.connect()
      pendingConnect = false
    } catch (err) {
      set({ state: 'error', error: err instanceof Error ? err.message : String(err) })
    } finally {
      starting = null
    }
  })()
  return starting
}

let wasLinked = false
let unsubscribe: (() => void) | null = null

/**
 * Keep the agent host running and the link up while held (AgentBridgeHost, mounted while the MCP server addon is
 * on): start it now, and again when a link it had drops because the host went away (it idled out, or a newer one
 * replaced it). A Disconnect the user chose stands. Returns the release.
 */
export function keepAgentHost(): () => void {
  keepers++
  if (keepers === 1) {
    wasLinked = agentBridge.getSnapshot().state === 'connected'
    unsubscribe = agentBridge.subscribe(() => {
      const now = agentBridge.getSnapshot().state
      if (now === 'connected') { wasLinked = true; return }
      if (wasLinked && now === 'searching' && agentBridge.enabled) { wasLinked = false; void ensureHost() }
    })
    void ensureHost()
  }
  let released = false
  return () => {
    if (released) return
    released = true
    if (--keepers === 0) { unsubscribe?.(); unsubscribe = null; wasLinked = false; pendingConnect = false }
  }
}

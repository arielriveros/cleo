// The editor's end of the agent bridge: finds a running Cleo MCP server (applications/mcp), connects OUT to
// it over a loopback WebSocket, and runs the commands it relays, one at a time, through the handler the
// AgentBridgeHost installs. No React here: a module singleton with a tiny external store, so the menu-bar
// chip and the host component share one connection.
//
// Wire protocol: see applications/mcp/src/bridge.mjs (the server is the authority on it).
//
// Finding the server: the server writes `{port, token}` to a discovery file; the editor's dev server serves
// that file back at /__cleo/agent-bridge (app-kit vite.preset.ts, agentBridgeDiscoveryPlugin). Dev builds
// only for now; the packaged desktop app would need a preload route to the same file.

/** What the MCP server can ask for, and what the host answers with. */
export interface CommandResult {
  text?: string
  data?: unknown
  images?: { data: string; mimeType: string }[]
  isError?: boolean
}
export type CommandHandler = (method: string, params: any) => Promise<CommandResult>

export type BridgeState =
  /** Turned off by the user (or a production build). */
  | 'off'
  /** Polling for a server; none is running. */
  | 'searching'
  | 'connecting'
  | 'connected'
  /** Another editor tab took the connection over; this one waits until asked to reconnect. */
  | 'standby'
  /** The server refused our token (a stale discovery file); retried once the file changes. */
  | 'rejected'

export interface BridgeActivity { method: string; startedAt: number }

export interface BridgeStatus {
  state: BridgeState
  /** Bumped on every new connection, so a listener can tell a reconnect from a re-render. */
  link: number
  /** What the server offers beyond tool calls: 'chat' and 'terminal' when it is the agent host (the panel's backend). */
  capabilities: string[]
  /** A server's discovery file is there, whether or not this tab is connected to it. */
  available: boolean
  server: { name: string; version: string; port: number } | null
  /** The command running right now, for the chip's "working" pulse. */
  activity: BridgeActivity | null
  /** Commands handled since this page loaded. */
  calls: number
  lastMethod: string | null
  lastError: string | null
}

/** Unscoped on purpose: this is a property of the machine, not of a project. */
const ENABLED_KEY = 'cleo_agent_bridge'
const EXECUTE_KEY = 'cleo_agent_bridge_execute'
const DISCOVERY_URL = '/__cleo/agent-bridge'
const POLL_MS = 3000

/** Close codes from the server (bridge.mjs CLOSE). */
const BAD_TOKEN = 4401
const REPLACED = 4409

interface Discovery { port: number; token: string; version?: string }

export interface HelloClient {
  app: 'cleo-editor'
  version: string
  origin: string
  desktop: boolean
  project: { id: string | null; name: string | null }
}

class AgentBridgeClient {
  private status: BridgeStatus = { state: 'off', link: 0, capabilities: [], available: false, server: null, activity: null, calls: 0, lastMethod: null, lastError: null }
  private listeners = new Set<() => void>()
  private socket: WebSocket | null = null
  private timer: number | null = null
  private handler: CommandHandler | null = null
  private hello: () => Promise<HelloClient> = async () => ({
    app: 'cleo-editor', version: '0', origin: location.origin, desktop: false, project: { id: null, name: null },
  })
  private queue: Promise<void> = Promise.resolve()
  private chatListeners = new Set<(event: any) => void>()
  private termListeners = new Set<(event: any) => void>()
  private running = false
  /** A token this tab must not retry: refused, or handed over to another tab. */
  private parkedToken: string | null = null

  // --- store ---------------------------------------------------------------------------------------------

  readonly subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }
  readonly getSnapshot = (): BridgeStatus => this.status

  private set(patch: Partial<BridgeStatus>) {
    this.status = { ...this.status, ...patch }
    for (const cb of [...this.listeners]) cb()
  }

  // --- settings ------------------------------------------------------------------------------------------

  /** The link is on unless the user turned it off (dev builds; see `supported`). */
  get enabled(): boolean {
    try { return localStorage.getItem(ENABLED_KEY) !== 'off' } catch { return true }
  }
  /** Whether `execute` (arbitrary code from the agent) is allowed. On unless turned off. */
  get executeAllowed(): boolean {
    try { return localStorage.getItem(EXECUTE_KEY) !== 'off' } catch { return true }
  }
  setExecuteAllowed(on: boolean) {
    try { localStorage.setItem(EXECUTE_KEY, on ? 'on' : 'off') } catch { /* private mode */ }
    this.set({})
  }
  /** Only a dev server serves the discovery route. */
  get supported(): boolean { return import.meta.env.DEV }

  // --- chat channel --------------------------------------------------------------------------------------

  /** Events from the agent host's chat manager (applications/mcp/src/chat.mjs). */
  onChatEvent(cb: (event: any) => void): () => void {
    this.chatListeners.add(cb)
    return () => { this.chatListeners.delete(cb) }
  }

  /** Send a chat op to the host. False when there is no host link that offers chat. */
  sendChat(op: string, extra: Record<string, unknown> = {}): boolean {
    const s = this.socket
    if (!s || s.readyState !== WebSocket.OPEN || this.status.state !== 'connected' || !this.status.capabilities.includes('chat')) return false
    s.send(JSON.stringify({ type: 'chat', op, ...extra }))
    return true
  }

  // --- terminal channel ----------------------------------------------------------------------------------

  /** Events from the Claude Code the agent host runs for the editor (applications/mcp/src/terminal.mjs). */
  onTermEvent(cb: (event: any) => void): () => void {
    this.termListeners.add(cb)
    return () => { this.termListeners.delete(cb) }
  }

  /** Send a terminal op to the host. False when there is no host link that offers the terminal. */
  sendTerm(op: string, extra: Record<string, unknown> = {}): boolean {
    const s = this.socket
    if (!s || s.readyState !== WebSocket.OPEN || this.status.state !== 'connected' || !this.status.capabilities.includes('terminal')) return false
    s.send(JSON.stringify({ type: 'term', op, ...extra }))
    return true
  }

  // --- lifecycle -----------------------------------------------------------------------------------------

  /** Installed by AgentBridgeHost once the editor is up. Replaces any previous one. */
  setHost(handler: CommandHandler | null, hello?: () => Promise<HelloClient>) {
    this.handler = handler
    if (hello) this.hello = hello
  }

  start() {
    if (this.running) return
    this.running = true
    if (!this.supported) { this.set({ state: 'off' }); return }
    // Polled even while the user has the link off, so the chip can offer Connect when a server appears.
    this.schedule(0)
  }

  stop() {
    this.running = false
    if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null }
    this.socket?.close(1000, 'editor closed the link')
    this.socket = null
  }

  /** The chip's Connect: turn the link on and (re)connect now, taking over from another tab if need be. */
  connect() {
    try { localStorage.setItem(ENABLED_KEY, 'on') } catch { /* ignore */ }
    this.parkedToken = null
    if (!this.running) { this.start(); return }
    if (!this.socket) this.schedule(0)
  }

  /** The chip's Disconnect: off until Connect, remembered across reloads. */
  disconnect() {
    try { localStorage.setItem(ENABLED_KEY, 'off') } catch { /* ignore */ }
    if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null }
    const s = this.socket
    this.socket = null
    s?.close(1000, 'disconnected by the user')
    this.set({ state: 'off', server: null })
    if (this.running) this.schedule(POLL_MS * 2)
  }

  private schedule(ms: number) {
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => { this.timer = null; void this.poll() }, ms)
  }

  private async poll() {
    if (!this.running || this.socket) return
    // Not before the editor has installed its host: the hello must name the open project, and a call that
    // arrived first would only be refused.
    if (!this.handler) { this.schedule(250); return }
    const found = await discover()
    if (!this.running || this.socket) return
    if (this.status.available !== !!found) this.set({ available: !!found })
    if (!this.enabled) {
      if (this.status.state !== 'off') this.set({ state: 'off', server: null })
      this.schedule(POLL_MS * 2)
      return
    }
    if (!found) {
      if (this.status.state !== 'standby') this.set({ state: 'searching', server: null })
      this.schedule(POLL_MS)
      return
    }
    if (found.token === this.parkedToken) { this.schedule(POLL_MS); return }
    this.open(found)
  }

  private open(found: Discovery) {
    this.set({ state: 'connecting' })
    let socket: WebSocket
    try { socket = new WebSocket(`ws://127.0.0.1:${found.port}`) } catch { this.schedule(POLL_MS); return }
    this.socket = socket
    socket.onopen = () => {
      void this.hello().then(client => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'hello', token: found.token, client }))
      })
    }
    socket.onmessage = ev => {
      let msg: any
      try { msg = JSON.parse(String(ev.data)) } catch { return }
      if (msg?.type === 'welcome') {
        this.set({
          state: 'connected', link: this.status.link + 1,
          capabilities: Array.isArray(msg.capabilities) ? msg.capabilities.map(String) : [],
          server: { name: msg.server?.name ?? 'MCP server', version: msg.server?.version ?? '', port: found.port }, lastError: null,
        })
      } else if (msg?.type === 'chat-event') {
        for (const cb of [...this.chatListeners]) cb(msg.event)
      } else if (msg?.type === 'term-event') {
        for (const cb of [...this.termListeners]) cb(msg.event)
      } else if (msg?.type === 'call' && typeof msg.id === 'number') {
        this.enqueue(socket, msg.id, String(msg.method), msg.params)
      }
    }
    socket.onerror = () => { /* onclose follows and decides */ }
    socket.onclose = ev => {
      if (this.socket !== socket) return
      this.socket = null
      if (ev.code === BAD_TOKEN) { this.parkedToken = found.token; this.set({ state: 'rejected', server: null, capabilities: [] }) }
      else if (ev.code === REPLACED) { this.parkedToken = found.token; this.set({ state: 'standby', server: null, capabilities: [] }) }
      else this.set({ state: this.enabled ? 'searching' : 'off', server: null, capabilities: [] })
      if (this.running) this.schedule(POLL_MS)
    }
  }

  /** Commands run strictly one after another: the editor is one thread of React state and engine mutation. */
  private enqueue(socket: WebSocket, id: number, method: string, params: unknown) {
    this.queue = this.queue.then(async () => {
      this.set({ activity: { method, startedAt: Date.now() } })
      let reply: object
      try {
        if (!this.handler) throw new Error('The editor is still starting up; try again in a moment.')
        reply = { type: 'result', id, ok: true, result: await this.handler(method, params) }
        this.set({ lastError: null })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        reply = { type: 'result', id, ok: false, error: { message } }
        this.set({ lastError: message })
      }
      this.set({ activity: null, calls: this.status.calls + 1, lastMethod: method })
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(reply))
    })
  }
}

async function discover(): Promise<Discovery | null> {
  try {
    const res = await fetch(DISCOVERY_URL, { cache: 'no-store' })
    if (!res.ok) return null
    const info = await res.json()
    return typeof info?.port === 'number' && typeof info?.token === 'string' ? info : null
  } catch { return null }
}

export const agentBridge = new AgentBridgeClient()

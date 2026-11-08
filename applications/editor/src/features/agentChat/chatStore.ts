import { agentBridge } from '../agentBridge/bridgeClient'

// The chat panel's state: a transcript rebuilt from the agent host's chat events (applications/mcp/src/
// chat.mjs), plus the panel's own UI state. The host keeps the conversation; on every (re)connect the panel
// asks for a replay and reduces it from scratch, so a reload or a project switch loses nothing.

export type ToolStatus = 'running' | 'waiting' | 'done' | 'error'

export type ChatBlock =
  | { key: string; type: 'text' | 'thinking'; text: string }
  | { key: string; type: 'tool'; toolUseId: string; name: string; input?: unknown; status: ToolStatus
      result?: { text: string; images: { data: string; mimeType: string }[] } }

export type ChatItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; blocks: ChatBlock[] }
  | { kind: 'notice'; id: string; tone: 'info' | 'error'; text: string }
  | { kind: 'turn'; id: string; costUsd: number; durationMs: number; isError: boolean; error: string | null }

export interface PermissionRequest { requestId: string; toolUseId?: string; tool: string; input: unknown; canAlways: boolean }

export interface HostState {
  busy: boolean
  model: string
  mode: 'auto' | 'ask'
  sessionId: string | null
  auth: 'env' | 'saved' | 'missing' | 'mock'
  models: { id: string; label: string }[]
  cost: number
  mock: boolean
}

export type LinkState = 'idle' | 'starting' | 'connecting' | 'ready' | 'no-chat' | 'error'

/**
 * What the panel shows: Claude Code itself, hosted in a terminal (runs on the user's Claude plan; see
 * terminalStore), or the API-key chat this store drives.
 */
export type PanelView = 'code' | 'chat'

export interface ChatState {
  open: boolean
  width: number
  view: PanelView
  link: LinkState
  linkError: string | null
  host: HostState | null
  items: ChatItem[]
  permissions: PermissionRequest[]
  history: { sessionId: string; title: string; lastModified: number }[] | null
}

const OPEN_KEY = 'cleo_agent_chat_open'
const WIDTH_KEY = 'cleo_agent_chat_width'
const VIEW_KEY = 'cleo_agent_panel_view'
export const CHAT_MIN_WIDTH = 300

function readLs(key: string): string | null { try { return localStorage.getItem(key) } catch { return null } }
function writeLs(key: string, v: string) { try { localStorage.setItem(key, v) } catch { /* private mode */ } }

let state: ChatState = {
  open: readLs(OPEN_KEY) === '1',
  width: Math.max(CHAT_MIN_WIDTH, Number(readLs(WIDTH_KEY)) || 400),
  view: readLs(VIEW_KEY) === 'chat' ? 'chat' : 'code',
  link: 'idle',
  linkError: null,
  host: null,
  items: [],
  permissions: [],
  history: null,
}
const listeners = new Set<() => void>()
let notifyTimer: number | null = null

/** Coalesced: a streamed answer arrives as hundreds of deltas, and one render per frame is plenty. */
function publish(immediate = false) {
  if (immediate) {
    if (notifyTimer !== null) { window.clearTimeout(notifyTimer); notifyTimer = null }
    for (const cb of [...listeners]) cb()
    return
  }
  if (notifyTimer !== null) return
  notifyTimer = window.setTimeout(() => { notifyTimer = null; for (const cb of [...listeners]) cb() }, 16)
}

function set(patch: Partial<ChatState>, immediate = false) {
  state = { ...state, ...patch }
  publish(immediate)
}

export const chatStore = {
  subscribe(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb) } },
  getSnapshot(): ChatState { return state },
}

// --- the reducer ---------------------------------------------------------------------------------------------

let seq = 0
const nextId = () => `c${++seq}`

/** Apply one host event to a transcript. Pure over `items`/`permissions` (new arrays for what changed). */
export function reduceEvent(s: Pick<ChatState, 'items' | 'permissions'>, ev: any): Pick<ChatState, 'items' | 'permissions'> {
  let { items, permissions } = s
  const findAssistant = (id: string) => items.findIndex(i => i.kind === 'assistant' && i.id === id)
  const updateAssistant = (id: string, fn: (blocks: ChatBlock[]) => ChatBlock[]) => {
    let at = findAssistant(id)
    if (at < 0) { items = [...items, { kind: 'assistant', id, blocks: [] }]; at = items.length - 1 }
    const item = items[at] as Extract<ChatItem, { kind: 'assistant' }>
    items = items.slice()
    items[at] = { ...item, blocks: fn(item.blocks) }
  }
  const updateTool = (toolUseId: string, fn: (b: Extract<ChatBlock, { type: 'tool' }>) => ChatBlock) => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]
      if (it.kind !== 'assistant') continue
      const bi = it.blocks.findIndex(b => b.type === 'tool' && b.toolUseId === toolUseId)
      if (bi < 0) continue
      const blocks = it.blocks.slice()
      blocks[bi] = fn(blocks[bi] as Extract<ChatBlock, { type: 'tool' }>)
      items = items.slice()
      items[i] = { ...it, blocks }
      return
    }
  }

  switch (ev?.kind) {
    case 'user':
      items = [...items, { kind: 'user', id: nextId(), text: String(ev.text ?? '') }]
      break
    case 'assistant-start':
      if (findAssistant(ev.messageId) < 0) items = [...items, { kind: 'assistant', id: ev.messageId, blocks: [] }]
      break
    case 'block-start': {
      const key = `${ev.messageId}:${ev.index}`
      updateAssistant(ev.messageId, blocks => blocks.some(b => b.key === key) ? blocks : [...blocks,
        ev.block === 'tool'
          ? { key, type: 'tool', toolUseId: ev.toolUseId, name: ev.name ?? 'tool', status: 'running' }
          : { key, type: ev.block === 'thinking' ? 'thinking' : 'text', text: '' }])
      break
    }
    case 'delta': {
      const key = `${ev.messageId}:${ev.index}`
      updateAssistant(ev.messageId, blocks => blocks.map(b => b.key === key && b.type !== 'tool' ? { ...b, text: b.text + String(ev.text ?? '') } : b))
      break
    }
    case 'tool-input':
      updateTool(ev.toolUseId, b => ({ ...b, input: ev.input, name: ev.name ?? b.name }))
      break
    case 'tool-result':
      updateTool(ev.toolUseId, b => ({ ...b, status: ev.isError ? 'error' : 'done', result: { text: String(ev.text ?? ''), images: ev.images ?? [] } }))
      break
    case 'permission':
      permissions = [...permissions.filter(p => p.requestId !== ev.requestId),
        { requestId: ev.requestId, toolUseId: ev.toolUseId, tool: ev.tool, input: ev.input, canAlways: ev.canAlways !== false }]
      if (ev.toolUseId) updateTool(ev.toolUseId, b => ({ ...b, status: 'waiting' }))
      break
    case 'permission-resolved': {
      const p = permissions.find(x => x.requestId === ev.requestId)
      permissions = permissions.filter(x => x.requestId !== ev.requestId)
      if (p?.toolUseId) updateTool(p.toolUseId, b => (b.status === 'waiting' ? { ...b, status: 'running' } : b))
      break
    }
    case 'turn-end':
      items = [...items, { kind: 'turn', id: nextId(), costUsd: ev.costUsd ?? 0, durationMs: ev.durationMs ?? 0, isError: !!ev.isError, error: ev.error ?? null }]
      // Anything still marked running when the turn ended was cut off (an interrupt).
      items = items.map(it => it.kind !== 'assistant' || !it.blocks.some(b => b.type === 'tool' && (b.status === 'running' || b.status === 'waiting')) ? it
        : { ...it, blocks: it.blocks.map(b => b.type === 'tool' && (b.status === 'running' || b.status === 'waiting') ? { ...b, status: 'error' } : b) })
      permissions = []
      break
    case 'error':
    case 'info':
      items = [...items, { kind: 'notice', id: nextId(), tone: ev.kind === 'error' ? 'error' : 'info', text: String(ev.message ?? '') }]
      break
    default:
      break
  }
  return { items, permissions }
}

function onEvent(ev: any) {
  switch (ev?.kind) {
    case 'replay': {
      let t: Pick<ChatState, 'items' | 'permissions'> = { items: [], permissions: [] }
      for (const e of ev.events ?? []) t = reduceEvent(t, e)
      set({ ...t, host: ev.state ? stripKind(ev.state) : state.host, link: 'ready', linkError: null }, true)
      return
    }
    case 'state':
      set({ host: stripKind(ev) })
      return
    case 'history':
      set({ history: ev.sessions ?? [] })
      return
    default:
      set(reduceEvent(state, ev))
  }
}

function stripKind(ev: any): HostState {
  const { kind: _kind, ...rest } = ev
  return rest as HostState
}

// --- the link ------------------------------------------------------------------------------------------------

let attachedLink = -1

agentBridge.onChatEvent(onEvent)
agentBridge.subscribe(() => {
  const b = agentBridge.getSnapshot()
  if (b.state === 'connected') {
    if (!b.capabilities.includes('chat')) { if (state.link !== 'no-chat') set({ link: 'no-chat' }); return }
    // A new connection (first, or after a reload of the host): ask for the conversation.
    if (b.link !== attachedLink) {
      attachedLink = b.link
      if (agentBridge.sendChat('attach')) set({ link: 'connecting' })
    }
  } else if (state.link === 'ready' || state.link === 'connecting' || state.link === 'no-chat') {
    attachedLink = -1
    set({ link: 'idle', host: null })
    if (state.open) void ensureHost()
  }
})

let starting: Promise<void> | null = null

/** The host capability the current view needs. */
const requiredFor = (view: PanelView) => (view === 'code' ? 'terminal' : 'chat')

/**
 * Make sure the agent host runs and the bridge is linked to it: what opening the panel does. A link to a
 * host without what the view needs (an older one) goes through the dev server too, which replaces it.
 */
export function ensureHost(required: 'chat' | 'terminal' = requiredFor(state.view)): Promise<void> {
  if (starting) return starting
  const b = agentBridge.getSnapshot()
  if (b.state === 'connected' && b.capabilities.includes(required)) return Promise.resolve()
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
      // A link to an older, chat-less server would block the host's: drop it and connect afresh.
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

// --- actions -------------------------------------------------------------------------------------------------

function send(op: string, extra: Record<string, unknown> = {}) {
  if (!agentBridge.sendChat(op, extra)) {
    set({ items: [...state.items, { kind: 'notice', id: nextId(), tone: 'error', text: 'Not connected to the agent host.' }] })
    void ensureHost()
    return false
  }
  return true
}

export const chatActions = {
  setOpen(open: boolean) {
    writeLs(OPEN_KEY, open ? '1' : '0')
    set({ open }, true)
    if (open) void ensureHost()
  },
  toggle() { chatActions.setOpen(!state.open) },
  setView(view: PanelView) {
    writeLs(VIEW_KEY, view)
    set({ view }, true)
    if (state.open) void ensureHost(requiredFor(view))
  },
  setWidth(width: number) {
    const w = Math.round(Math.max(CHAT_MIN_WIDTH, Math.min(window.innerWidth * 0.6, width)))
    writeLs(WIDTH_KEY, String(w))
    set({ width: w }, true)
  },
  send(text: string, context: string) {
    const host = state.host
    return send('send', { text, context, model: host?.model, mode: host?.mode })
  },
  interrupt() { send('interrupt') },
  respond(requestId: string, allow: boolean, always = false) { send('permission', { requestId, allow, always }) },
  newChat() { send('new'); set({ history: null }) },
  setModel(model: string) { send('setModel', { model }) },
  setMode(mode: 'auto' | 'ask') { send('setMode', { mode }) },
  setKey(key: string) { send('setKey', { key }) },
  loadHistory() { send('history') },
  openSession(sessionId: string) { send('load', { sessionId }); set({ history: null }) },
  closeHistory() { set({ history: null }) },
  retry() { void ensureHost() },
}

// Opened at boot (remembered from last time): start the host right away.
if (state.open) queueMicrotask(() => { void ensureHost() })

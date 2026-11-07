import { CleoEngine, Logger, type LogEntry } from 'cleo'
import { elide } from './inspect'

// The console as the agent reads it: every Logger entry plus the page's uncaught errors (the same two
// sources as the console panel's logStore), each stamped with a monotonic cursor so `logs_read {since}`
// returns exactly what is new. Kept here rather than read off logStore because that store publishes on
// requestAnimationFrame, which a background tab barely runs; and as text, so no live object is retained.

export interface AgentLogEntry { seq: number; level: LogEntry['method']; scope: string; time: number; text: string }

const MAX = 1000
let buffer: AgentLogEntry[] = []
let seq = 0
let attached = false

function format(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) {
    const frame = value.stack?.split('\n').slice(1).find(l => l.trim())?.trim()
    return `${value.name}: ${value.message}${frame ? ` (${frame})` : ''}`
  }
  if (value === null || typeof value !== 'object') return String(value)
  try {
    const s = JSON.stringify(elide(value))
    return s.length > 400 ? `${s.slice(0, 400)}…` : s
  } catch { return Object.prototype.toString.call(value) }
}

function push(level: LogEntry['method'], scope: string, data: unknown[], time = Date.now()) {
  buffer.push({ seq: ++seq, level, scope, time, text: data.map(format).join(' ').slice(0, 4000) })
  if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX)
}

/** Idempotent. Seeds from the engine's own ring buffer so errors from before the link are visible too. */
export function attachAgentLogs() {
  if (attached) return
  attached = true
  for (const e of Logger.logs) push(e.method, e.scope, e.data, e.timestamp)
  CleoEngine.eventEmitter.on('LOG', (e: LogEntry) => push(e.method, e.scope, e.data, e.timestamp))
  // A flushed row (a progress line redrawn in place) arrives as an update; only its latest text matters.
  CleoEngine.eventEmitter.on('LOG_UPDATE', (e: LogEntry) => push(e.method, e.scope, e.data, e.timestamp))
  window.addEventListener('error', ev => push('error', 'Uncaught', [ev.error ?? ev.message]))
  window.addEventListener('unhandledrejection', ev => push('error', 'Uncaught', ['Unhandled promise rejection:', ev.reason]))
}

export function logCursor(): number { return seq }

const RANK: Record<string, number> = { debug: 0, log: 1, info: 1, warn: 2, error: 3 }

export function readLogs(opts: { since?: number; level?: 'all' | 'warn' | 'error'; scope?: string; limit?: number }): AgentLogEntry[] {
  const min = opts.level === 'error' ? 3 : opts.level === 'warn' ? 2 : 0
  const scope = opts.scope?.toLowerCase()
  const hits = buffer.filter(e => (opts.since === undefined || e.seq > opts.since)
    && (RANK[e.level] ?? 1) >= min
    && (!scope || e.scope.toLowerCase() === scope))
  return hits.slice(-(opts.limit ?? 60))
}

export function formatLogs(entries: AgentLogEntry[]): string {
  return entries.map(e => {
    const t = new Date(e.time).toISOString().slice(11, 19)
    return `${e.seq} ${t} ${e.level.toUpperCase()} [${e.scope}] ${e.text}`
  }).join('\n')
}

// In-memory console store. Lives outside React so producers (engine, scripts, uncaught errors) never
// touch component state directly: entries land in a buffer and at most one snapshot is published per
// animation frame, which is what keeps a per-frame `console.log` from melting the panel.
// Nothing is persisted — the buffer dies with the tab, by design.
import { CleoEngine, Logger } from 'cleo';
import type { LogEntry, LogMethod } from 'cleo';

export const MAX_LOGS = 500;

export interface ConsoleEntry extends LogEntry {
  /** Lowercased preview of `data`, built once at ingest so text filtering is a substring scan. */
  search: string;
}

export type LevelCounts = Record<LogMethod, number>;

export interface ConsoleSnapshot {
  entries: readonly ConsoleEntry[];
  counts: LevelCounts;
  scopes: readonly string[];
}

const EMPTY_COUNTS = (): LevelCounts => ({ log: 0, info: 0, warn: 0, error: 0, debug: 0 });

let buffer: ConsoleEntry[] = [];
let snapshot: ConsoleSnapshot = { entries: [], counts: EMPTY_COUNTS(), scopes: [] };
const listeners = new Set<() => void>();
let frame = 0;
let uncaughtId = 0;

function publish() {
  frame = 0;
  const counts = EMPTY_COUNTS();
  const scopes: string[] = [];
  for (const entry of buffer) {
    counts[entry.method]++;
    if (!scopes.includes(entry.scope)) scopes.push(entry.scope);
  }
  scopes.sort();
  snapshot = { entries: buffer.slice(), counts, scopes };
  for (const listener of listeners) listener();
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(publish);
}

function ingest(entry: LogEntry) {
  buffer.push({ ...entry, search: searchText(entry.data) });
  if (buffer.length > MAX_LOGS) buffer.splice(0, buffer.length - MAX_LOGS);
  schedule();
}

// A flushed entry replaces its row in place instead of appending one. It is matched by flushKey
// (unique in the buffer) rather than id, because the engine hands out a fresh id per emit so the
// console actually repaints the row.
function update(entry: LogEntry) {
  for (let i = buffer.length - 1; i >= 0; i--) {
    if (buffer[i].flushKey === entry.flushKey) {
      buffer[i] = { ...entry, search: searchText(entry.data) };
      schedule();
      return;
    }
  }
  ingest(entry); // the original row already fell out of the ring buffer
}

// Engine objects are huge and often circular, so the preview stays shallow — the inspector in the
// panel is what you expand when you actually want to look inside.
function preview(value: any): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (value === null || typeof value !== 'object') return String(value);
  try {
    const name = value.constructor?.name ?? 'Object';
    return `${name} ${Object.keys(value).slice(0, 12).join(' ')}`;
  } catch {
    return '';
  }
}

function searchText(data: any[]): string {
  return data.map(preview).join(' ').slice(0, 300).toLowerCase();
}

let attached = false;

/** Idempotent — StrictMode and HMR can import this module more than once. */
export function attachLogStore() {
  if (attached) return;
  attached = true;

  // Seed the backlog: the engine logs "Engine Ready" & friends long before the panel mounts.
  buffer = Logger.logs.map((entry) => ({ ...entry, search: searchText(entry.data) }));

  CleoEngine.eventEmitter.on('LOG', ingest);
  CleoEngine.eventEmitter.on('LOG_UPDATE', update);
  CleoEngine.eventEmitter.on('LOG_CLEAR', () => {
    buffer = [];
    schedule();
  });

  // Uncaught failures go straight into the buffer rather than through Logger: the browser already
  // reports them on the native console, and re-logging them would double up there.
  window.addEventListener('error', (e: ErrorEvent) => {
    ingest({
      id: `uncaught-${uncaughtId++}`,
      method: 'error',
      data: [e.error ?? e.message],
      scope: 'Uncaught',
      timestamp: Date.now(),
    });
  });
  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    ingest({
      id: `uncaught-${uncaughtId++}`,
      method: 'error',
      data: ['Unhandled promise rejection:', e.reason],
      scope: 'Uncaught',
      timestamp: Date.now(),
    });
  });

  publish();
}

export const logStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  getSnapshot(): ConsoleSnapshot {
    return snapshot;
  },
  clear() {
    Logger.clear(); // emits LOG_CLEAR, which empties the buffer
  },
};

// Play in window: the messages between the editor and the game window (play.html, src/player/session.tsx).
//
// Both pages are the same origin and the same browser session — on the desktop and on the web — so they
// talk over one BroadcastChannel and hand the game's bytes over through IndexedDB (sessionStore.ts). Every
// message names its session, because a BroadcastChannel reaches EVERY same-origin page: a second editor tab,
// a second game window, the Creator.
//
// Pure: no DOM, no engine import. Both pages import it, and so do the tests.

export const PLAY_CHANNEL = 'cleo-play';

/** The query parameter play.html reads its session id from. */
export const SESSION_PARAM = 'session';

/** What the editor tells the game window. */
export type EditorCommand =
  /** The game's bytes are in the session store: boot (ignored once booted). */
  | { type: 'data-ready' }
  | { type: 'pause' }
  | { type: 'resume' }
  /** Load the session's bytes again: the editor has just written a rebuilt game under the same id. */
  | { type: 'restart' }
  /** Close the window (a web popup closes itself; the desktop shell closes its window regardless). */
  | { type: 'stop' }
  /** Bring the window forward, where the platform lets a page do that. */
  | { type: 'focus' }
  /** Answer with `pong` and the current state. */
  | { type: 'ping' };

/** A game-side log row, flattened so it survives structured clone (see encodeLogData). */
export interface RemoteLogEntry {
  id: string;
  method: 'log' | 'info' | 'warn' | 'error' | 'debug';
  data: unknown[];
  scope: string;
  timestamp: number;
  flushKey?: string;
}

export type RemoteLogOp =
  | { op: 'add'; entry: RemoteLogEntry }
  /** A flushed row redrawn in place (Logger's `flush`). */
  | { op: 'update'; entry: RemoteLogEntry }
  | { op: 'clear' };

export interface GameState {
  /** booting: loading or starting the entry scene; running / paused once it runs. */
  phase: 'waiting' | 'booting' | 'running' | 'paused';
  /** The running scene's name, once there is one. */
  scene?: string;
}

/** What the game window tells the editor. */
export type GameEvent =
  /** The page is up and listening (sent again after every reload, so a restart re-announces). */
  | { type: 'hello'; state: GameState }
  | { type: 'state'; state: GameState }
  | { type: 'pong'; state: GameState }
  /** Log rows, batched. */
  | { type: 'log'; ops: RemoteLogOp[] }
  /** The game could not start. */
  | { type: 'failed'; message: string; stack?: string }
  /** The page is going away. `reloading` when the game reloads itself for a restart. */
  | { type: 'bye'; reloading: boolean };

export type PlayMessage =
  | ({ to: 'game'; session: string } & EditorCommand)
  | ({ to: 'editor'; session: string } & GameEvent);

/** Whether `value` is a message of ours, for `session`, addressed to `to`. */
export function isMessageFor<T extends PlayMessage['to']>(
  value: unknown, to: T, session: string,
): value is Extract<PlayMessage, { to: T }> {
  if (!value || typeof value !== 'object') return false;
  const m = value as { to?: unknown; session?: unknown; type?: unknown };
  return m.to === to && m.session === session && typeof m.type === 'string';
}

/**
 * Web Locks that say who is alive without anyone's JavaScript having to run — a page frozen at a
 * breakpoint, crashed, or closed with no goodbye still lets go of its locks only when it is really gone.
 *   owner: held by the editor for the whole session. The game waits on it: granted = the editor is gone
 *          (closed, reloaded, stopped the session), so the game closes itself.
 *   game:  held by each game page for its lifetime. The editor waits on it: granted = that page is gone,
 *          and unless a new page says hello shortly (a reload), the window was closed.
 */
export function ownerLockName(session: string): string { return `cleo-play/${session}/owner`; }
export function gameLockName(session: string): string { return `cleo-play/${session}/game`; }

/** A fresh session id. Not a secret: it only keeps two sessions' messages apart. */
export function newSessionId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

// ---- Log rows across the channel -------------------------------------------------------------------

/**
 * A log argument as something structured clone can carry and the console can show. Strings, numbers,
 * booleans and null pass through; an Error keeps its name, message and stack; anything else — an engine
 * node, a typed array, a function — becomes the same shallow preview the editor console draws. Never
 * walks a value: an engine object is huge and often circular.
 */
export function encodeLogValue(value: unknown): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case 'string': case 'number': case 'boolean': return value;
    case 'undefined': return 'undefined';
    case 'bigint': return `${value}n`;
    case 'symbol': return String(value);
    case 'function': return `ƒ ${(value as Function).name || 'anonymous'}()`;
  }
  if (value instanceof Error) {
    const head = `${value.name}: ${value.message}`;
    return value.stack && value.stack.includes(value.message) ? value.stack : `${head}${value.stack ? `\n${value.stack}` : ''}`;
  }
  try {
    const name = (value as any).constructor?.name ?? 'Object';
    // A typed array is summarised, never keyed: Object.keys on one makes a string per element.
    if (ArrayBuffer.isView(value)) return `${name}(${(value as any).length ?? (value as ArrayBufferView).byteLength})`;
    if (Array.isArray(value)) return `Array(${value.length})`;
    return `${name} ${Object.keys(value as object).slice(0, 12).join(' ')}`.trim();
  } catch {
    return '[object]';
  }
}

export function encodeLogEntry(entry: { id: string; method: RemoteLogEntry['method']; data: unknown[]; scope: string; timestamp: number; flushKey?: string }): RemoteLogEntry {
  return {
    id: entry.id,
    method: entry.method,
    data: (entry.data ?? []).map(encodeLogValue),
    scope: entry.scope,
    timestamp: entry.timestamp,
    ...(entry.flushKey !== undefined ? { flushKey: entry.flushKey } : {}),
  };
}

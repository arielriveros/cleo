// Play in window: the editor side of a game running in a window — and a renderer process — of its own.
//
// The game page is play.html (src/player/session.tsx). On Play the window opens AT ONCE, inside the click's
// user activation (a popup opened after a multi-second build would be blocked), and shows its loading
// screen while the editor builds the game the way Publish does, packs it in the project worker and leaves
// it in the play-session store. The window boots from there; the two talk over the play channel.
//
// The editor never enters play mode for this: it stays editable, its Console stays up (the game's log rows
// arrive in it), and a change reaches the game on Restart, which rebuilds while the old game keeps running
// and then reloads the window.
//
// Whether the window is still there is decided WITHOUT the game's JavaScript running: a game stopped at a
// breakpoint must look paused, not closed. Web Locks (protocol.ts) and, on the desktop, the main process's
// own window events do that; the game's goodbye message is only a hint.
//
// Everything platform-specific comes in through `WindowPlayEnv`, so the session logic is testable.

import type { LogEntry } from 'cleo';
import {
  type GameState, type PlayMessage, type EditorCommand, type RemoteLogEntry,
  isMessageFor,
} from './protocol';

export type WindowPlayStatus = 'idle' | 'building' | 'starting' | 'running' | 'paused' | 'failed';

export interface WindowPlaySnapshot {
  status: WindowPlayStatus;
  /** A session exists: from Play until Stop or the window closing (a failed one stays until dismissed). */
  active: boolean;
  sessionId: string | null;
  /** The running scene's name, once the game reported one. */
  scene?: string;
  /** A Restart's rebuild is in progress while the previous game keeps running. */
  rebuilding: boolean;
  /** Why the session failed. */
  error?: string;
}

export interface WindowSize { width: number; height: number; title: string }

/** Builds the game data (EngineContext.buildWindowPlayData). */
export type BuildGame = () => Promise<any>;

export interface WindowPlayEnv {
  newSessionId(): string;
  /** Open the play channel; `onMessage` gets every message on it, ours or not. */
  openChannel(onMessage: (message: unknown) => void): { post(message: PlayMessage): void; close(): void };
  /**
   * Open the game window for `sessionId`. MUST start synchronously: on the web it calls `window.open`,
   * which needs the click's user activation. Returns false when it cannot open one at all.
   */
  openWindow(sessionId: string, size: WindowSize): boolean;
  closeWindow(sessionId: string): void;
  focusWindow(sessionId: string): void;
  /** Whether a blocked popup is possible here (the web), and so worth watching for. */
  readonly popupsCanBeBlocked: boolean;
  /** Pack `data` and store it under `sessionId`; resolves with its size in bytes. */
  pack(data: any, sessionId: string): Promise<number>;
  dropSession(sessionId: string): Promise<void>;
  /** Hold the owner lock until the returned release is called. Null without Web Locks. */
  holdOwnerLock(sessionId: string): (() => void) | null;
  /** Call `gone` once the game page holding the session's lock is gone. False without Web Locks. */
  watchGameLock(sessionId: string, gone: () => void): boolean;
  /** Platform window events (the desktop shell), or null. */
  onWindowEvent(cb: (sessionId: string, event: 'closed' | 'crashed', detail?: string) => void): (() => void) | null;
  emitLog(kind: 'add' | 'update', entry: LogEntry): void;
  notify(tone: 'info' | 'warning' | 'error', message: string): void;
  /** A line for the editor's Console only (no toast): how long the build took, and so on. */
  log(message: string): void;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * How long a page that let go of its lock has to say hello again before the window counts as closed. Long,
 * because a reload of play.html from the dev server re-requests the whole engine module graph. A page that
 * said a goodbye that was NOT a reload (the window closing) gets the short one.
 */
export const RELOAD_GRACE_MS = 10000;
export const CLOSE_GRACE_MS = 1500;
/** On the web: no hello this long after opening means the browser blocked the popup. */
export const HELLO_TIMEOUT_MS = 15000;

interface Session {
  id: string;
  channel: { post(message: PlayMessage): void; close(): void };
  releaseOwner: (() => void) | null;
  /** The bytes for the current build are stored; a page that says hello can boot. */
  packed: boolean;
  heard: boolean;
  helloTimer: unknown;
  goneTimer: unknown;
  /** Bumped per hello, so only the newest lock watch counts. */
  watch: number;
  /** A build (first or Restart) is running. */
  building: boolean;
  /** Restart pressed again during a build: build once more when this one ends. */
  rebuildAgain: boolean;
  /** The last goodbye said the window is closing (not reloading). */
  closing: boolean;
}

const IDLE: WindowPlaySnapshot = { status: 'idle', active: false, sessionId: null, rebuilding: false };

export class WindowPlayController {
  private session: Session | null = null;
  private snapshot: WindowPlaySnapshot = IDLE;
  private readonly listeners = new Set<() => void>();
  private build: BuildGame | null = null;
  private readonly offWindowEvents: (() => void) | null;

  constructor(private readonly env: WindowPlayEnv) {
    this.offWindowEvents = env.onWindowEvent((sessionId, event, detail) => {
      if (this.session?.id !== sessionId) return;
      if (event === 'closed') this.end();
      else this.fail(`The game window's process stopped (${detail ?? 'crashed'}).`);
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): WindowPlaySnapshot => this.snapshot;

  private set(patch: Partial<WindowPlaySnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  private send(command: EditorCommand): void {
    const s = this.session;
    if (s) s.channel.post({ to: 'game', session: s.id, ...command } as PlayMessage);
  }

  /**
   * Play in window. Opens the window first (synchronously — call straight from the click), then builds.
   * With a session already running, brings its window forward instead.
   */
  start(build: BuildGame, size: WindowSize): void {
    if (this.session) {
      this.env.focusWindow(this.session.id);
      this.send({ type: 'focus' });
      return;
    }
    this.build = build;
    const id = this.env.newSessionId();
    const session: Session = {
      id, channel: this.env.openChannel(m => this.onMessage(m)),
      releaseOwner: null, packed: false, heard: false, helloTimer: null, goneTimer: null,
      watch: 0, building: false, rebuildAgain: false, closing: false,
    };
    this.session = session;
    // Before the window exists, so the owner lock is first in the queue the game page joins.
    session.releaseOwner = this.env.holdOwnerLock(id);
    if (!this.env.openWindow(id, size)) {
      this.fail('The game window could not be opened.');
      return;
    }
    if (this.env.popupsCanBeBlocked) {
      session.helloTimer = this.env.setTimeout(() => {
        if (this.session === session && !session.heard)
          this.fail('The browser blocked the game window. Allow pop-ups for this site, then press Play again.');
      }, HELLO_TIMEOUT_MS);
    }
    this.snapshot = { status: 'building', active: true, sessionId: id, rebuilding: false };
    this.set({});
    void this.runBuild(session, false);
  }

  /** Rebuild from the editor's current state and reload the window. The old game runs until then. */
  restart(build?: BuildGame): void {
    const session = this.session;
    if (!session) return;
    if (build) this.build = build;
    if (session.building) { session.rebuildAgain = true; return; }
    void this.runBuild(session, true);
  }

  pause(): void { this.send({ type: 'pause' }); }
  resume(): void { this.send({ type: 'resume' }); }

  /** End the session: the window closes and its bytes are dropped. */
  stop(): void {
    const session = this.session;
    if (!session) { if (this.snapshot.status === 'failed') this.set(IDLE); return; }
    this.send({ type: 'stop' });
    this.env.closeWindow(session.id);
    this.end();
  }

  /** The editor page is going away: take the game window with it. */
  stopForUnload(): void {
    if (this.session) this.stop();
  }

  dispose(): void {
    this.stopForUnload();
    this.offWindowEvents?.();
    this.listeners.clear();
  }

  private async runBuild(session: Session, restart: boolean): Promise<void> {
    const build = this.build;
    if (!build) return;
    session.building = true;
    if (restart) this.set({ rebuilding: true });
    try {
      do {
        session.rebuildAgain = false;
        const t0 = this.env.now();
        const data = await build();
        if (this.session !== session) return;
        const t1 = this.env.now();
        const bytes = await this.env.pack(data, session.id);
        if (this.session !== session) return;
        // Where a slow start goes: the build (every scene, the textures they use) or the pack.
        this.env.log(`Built the game in ${Math.round(t1 - t0)} ms, packed ${(bytes / 1048576).toFixed(1)} MB in ${Math.round(this.env.now() - t1)} ms`);
      } while (session.rebuildAgain);
      session.packed = true;
      if (restart) {
        this.set({ rebuilding: false, status: 'starting' });
        this.send({ type: 'restart' });
      } else {
        if (this.snapshot.status === 'building') this.set({ status: 'starting' });
        this.send({ type: 'data-ready' });
      }
    } catch (e: any) {
      if (this.session !== session) return;
      const message = `The game could not be built: ${e?.message ?? e}`;
      // A failed Restart keeps the game that was running; a failed first build has nothing to keep.
      if (restart) { this.set({ rebuilding: false }); this.env.notify('error', message); }
      else this.fail(message);
    } finally {
      session.building = false;
    }
  }

  private onMessage(message: unknown): void {
    const session = this.session;
    if (!session || !isMessageFor(message, 'editor', session.id)) return;
    switch (message.type) {
      case 'hello':
        session.heard = true;
        session.closing = false;
        if (session.helloTimer !== null) { this.env.clearTimeout(session.helloTimer); session.helloTimer = null; }
        if (session.goneTimer !== null) { this.env.clearTimeout(session.goneTimer); session.goneTimer = null; }
        this.watch(session);
        // A page that came up after `data-ready` went out (or a reload) still finds the bytes itself; this
        // is the belt to that brace.
        if (session.packed) this.send({ type: 'data-ready' });
        this.applyState(message.state);
        break;
      case 'state':
      case 'pong':
        this.applyState(message.state);
        break;
      case 'log':
        for (const op of message.ops) {
          // The game's own Clear stays in the game: it must not wipe the editor's rows.
          if (op.op === 'clear') continue;
          this.env.emitLog(op.op, this.localEntry(session.id, op.entry));
        }
        break;
      case 'failed':
        this.fail(`The game failed to start: ${message.message}`);
        break;
      case 'bye':
        // Only a hint: the lock (or the desktop shell) decides. A goodbye that is not a reload shortens the
        // wait, and without Web Locks it is all there is to go on.
        if (!message.reloading) { session.closing = true; this.startGrace(session); }
        break;
    }
  }

  private applyState(state: GameState): void {
    const status: WindowPlayStatus | null =
      state.phase === 'running' ? 'running'
      : state.phase === 'paused' ? 'paused'
      : state.phase === 'booting' ? 'starting'
      : null;
    if (this.snapshot.status === 'failed') return;
    this.set({ ...(status ? { status } : {}), ...(state.scene ? { scene: state.scene } : {}) });
  }

  private watch(session: Session): void {
    const token = ++session.watch;
    this.env.watchGameLock(session.id, () => {
      if (this.session === session && session.watch === token) this.startGrace(session);
    });
  }

  private startGrace(session: Session): void {
    // A goodbye after the lock already started the long wait cuts it short.
    if (session.goneTimer !== null) {
      if (!session.closing) return;
      this.env.clearTimeout(session.goneTimer);
    }
    session.goneTimer = this.env.setTimeout(() => {
      session.goneTimer = null;
      if (this.session === session) this.end();
    }, session.closing ? CLOSE_GRACE_MS : RELOAD_GRACE_MS);
  }

  /** A row from the game, with an id and flush key of its own and a scope that says where it came from. */
  private localEntry(sessionId: string, entry: RemoteLogEntry): LogEntry {
    return {
      id: `game:${sessionId}:${entry.id}`,
      method: entry.method,
      data: entry.data as any[],
      scope: `Game/${entry.scope}`,
      timestamp: entry.timestamp,
      ...(entry.flushKey !== undefined ? { flushKey: `game:${sessionId}:${entry.flushKey}` } : {}),
    };
  }

  private fail(message: string): void {
    const session = this.session;
    this.env.notify('error', message);
    if (session) {
      this.send({ type: 'stop' });
      this.env.closeWindow(session.id);
      this.teardown(session);
    }
    this.snapshot = { status: 'failed', active: false, sessionId: null, rebuilding: false, error: message };
    this.set({});
  }

  /** The session is over (Stop, or the window went away). */
  private end(): void {
    const session = this.session;
    if (!session) return;
    this.teardown(session);
    this.snapshot = IDLE;
    this.set({});
  }

  private teardown(session: Session): void {
    if (session.helloTimer !== null) this.env.clearTimeout(session.helloTimer);
    if (session.goneTimer !== null) this.env.clearTimeout(session.goneTimer);
    session.releaseOwner?.();
    session.channel.close();
    void this.env.dropSession(session.id).catch(() => {});
    if (this.session === session) this.session = null;
  }
}

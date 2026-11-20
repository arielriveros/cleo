// Play › Multiplayer (docs/design/netsync.md §8): the game played online on this machine — a local NetSync host
// (`npm run host -- --dev`, applications/host/src/devHost.ts) and a game window per player, each joined to it as
// a published game's page would be. Each player can be forced onto the WebSocket fallback and given a worse
// network (lag, jitter, loss), so the fallback and bad connections get played as much as the good path.
//
// On Start the windows open at once, inside the click (a web popup needs its user activation), joined to the dev
// host's address — known before any game is, as the dev host keeps fixed ports and one certificate. Then the game
// is built and packed as Play in window packs it, handed to the dev host and to every window's session store,
// and the windows are told it is ready. Each reports its link and prediction to the editor every second; the dev
// host its own status. Stop closes the windows and the host's game.
//
// A browser lets one click open ONE pop-up (window.open uses the click's activation up), unless the site has been
// allowed pop-ups: the other players' windows are then blocked, and nothing says so (noopener: window.open
// answers null either way). So a window counts as open only once its page says hello; one that does not is shown
// in the dialog with an Open button, a click of its own. Open again starts the player on a fresh session, so a
// page of the old one that comes up after all finds its owner gone and closes itself.
//
// The desktop editor runs the dev host itself (app-kit/desktop/devHostProcess.js): when the Dev host address is
// this machine's and nothing answers there, the dialog asks the shell to start one, and it goes when the editor
// does. On the web it is the terminal's `npm run host -- --dev`.

import { useSyncExternalStore } from 'react';
import { PLAY_CHANNEL, SESSION_PARAM, isMessageFor, newSessionId, ownerLockName, type PlayMessage } from './protocol';
import { getPlaySession, putPlaySession, deletePlaySession } from './sessionStore';
import { desktopDevHost, desktopPlay } from './desktopPlay';
import type { PlayWindowJoin } from './desktopPlay';
import { HELLO_TIMEOUT_MS } from './playWindowController';
import { playPackJob } from '../../workers/workerClient';

export interface MultiplayerPlayer {
  name: string;
  /** auto: WebTransport, falling back to WebSocket; websocket: the fallback on purpose. */
  transport: 'auto' | 'websocket';
  /** One-way delay added to this player's link, ms. */
  lag: number;
  jitter: number;
  /** Percent of this player's pulses lost. */
  loss: number;
}

/** What a game window says of its link and its prediction (the play page's `netsync` event). */
export interface PeerReport {
  peerId: number;
  link: string;
  fallbackReason: string | null;
  rttMs: number;
  checked: number;
  corrections: number;
  maxErrorCm: number;
  ticks: number;
}

/** A player's window in the running session. */
export interface MultiplayerWindow {
  sessionId: string;
  player: MultiplayerPlayer;
  report?: PeerReport;
  failed?: string;
  /** Its page said hello. */
  open?: boolean;
  /** No page: the browser blocked the pop-up (or is slow to show it), or the player closed the window. */
  missing?: 'blocked' | 'closed';
}

export interface MultiplayerSnapshot {
  status: 'idle' | 'starting' | 'running' | 'failed';
  devHost: string;
  /** Whether the dev host answered (null: not asked yet). */
  hostReachable: boolean | null;
  /** The desktop editor is starting the dev host. */
  hostStarting: boolean;
  /** Why the desktop editor could not start the dev host, or why the one it started stopped. */
  hostNote?: string;
  players: MultiplayerPlayer[];
  /** The windows of the running session, one per player, in the players' order. */
  windows: MultiplayerWindow[];
  /** The dev host's status (GET /dev/status). */
  host: any | null;
  error?: string;
}

const PREFS_KEY = 'cleo_multiplayer_play';
const DEFAULT_DEV_HOST = 'http://127.0.0.1:4490';
const defaultPlayers = (): MultiplayerPlayer[] => [
  { name: 'Player 1', transport: 'auto', lag: 0, jitter: 0, loss: 0 },
  { name: 'Player 2', transport: 'websocket', lag: 75, jitter: 10, loss: 2 },
];

function readPrefs(): { devHost: string; players: MultiplayerPlayer[] } {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null');
    if (p && typeof p.devHost === 'string' && Array.isArray(p.players) && p.players.length) return p;
  } catch { /* none */ }
  return { devHost: DEFAULT_DEV_HOST, players: defaultPlayers() };
}

/** The game page's address for a player (web): the play page, its session, and the join parameters. */
export function multiplayerPageUrl(sessionId: string, base: string, join: PlayWindowJoin): string {
  const q = new URLSearchParams({ [SESSION_PARAM]: sessionId });
  for (const [k, v] of Object.entries(join)) if (v !== undefined && v !== '' && v !== 0) q.set(k, String(v));
  return new URL(`play.html?${q}`, base).toString();
}

/**
 * A pop-up opened with no activation left (every player's window after the first, in one click) that has not said
 * hello this long was most likely blocked. Short, so the Open button comes soon; one that was only slow to load
 * says hello later and its row is right again.
 */
export const BLOCKED_AFTER_MS = 4000;

/** Room for a pop-up's frame around its page: the title bar and Chrome's address strip. */
const FRAME = { width: 16, height: 72 };

/**
 * Where player `index` of `count` opens its window (web: screen pixels for window.open's left and top): spread
 * evenly from the top-left corner of the screen's work area to its bottom-right, so no window sits exactly over
 * another one. Pure, for the tests.
 */
export function windowPlacement(
  index: number, count: number, size: { width: number; height: number },
  area: { left: number; top: number; width: number; height: number },
): { left: number; top: number } {
  const t = count > 1 ? Math.min(1, Math.max(0, index / (count - 1))) : 0.5;
  const spanX = Math.max(0, area.width - size.width - FRAME.width);
  const spanY = Math.max(0, area.height - size.height - FRAME.height);
  return { left: Math.round(area.left + spanX * t), top: Math.round(area.top + spanY * t) };
}

/**
 * The port of a Dev host address on this machine (http://127.0.0.1, localhost or [::1], with a port), which the
 * desktop editor may start a dev host on; null for any other address. Pure, for the tests.
 */
export function localDevHostPort(address: string): number | null {
  let url: URL;
  try { url = new URL(address); } catch { return null; }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return null;
  const port = Number(url.port);
  return url.port && Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
}

/** A player's join parameters for the dev host's endpoint. */
export function joinFor(endpoint: any, player: MultiplayerPlayer): PlayWindowJoin {
  return {
    wt: endpoint.webTransport?.url, hash: endpoint.webTransport?.certHashes?.[0], ws: endpoint.webSocket?.url,
    name: player.name.replace(/[^\w .-]/g, '').slice(0, 32) || 'Player',
    ...(player.transport === 'websocket' ? { transport: 'websocket' as const } : {}),
    ...(player.lag > 0 ? { lag: Math.round(player.lag) } : {}),
    ...(player.jitter > 0 ? { jitter: Math.round(player.jitter) } : {}),
    ...(player.loss > 0 ? { loss: Math.round(player.loss * 10) / 10 } : {}),
  };
}

export class MultiplayerPlay {
  private _snap: MultiplayerSnapshot;
  private readonly _listeners = new Set<() => void>();
  private _endpoint: any = null;
  private _channel: BroadcastChannel | null = null;
  private _poll: ReturnType<typeof setInterval> | null = null;
  private readonly _locks = new Map<string, () => void>();
  private readonly _helloTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** The running session's window size and title, for a window opened again. */
  private _size: { width: number; height: number; title: string } | null = null;
  /** The packed game, once built: a window opened again gets its own copy. */
  private _bytes: Blob | null = null;
  /** The desktop shell starting the dev host: one ask at a time. */
  private _hostStart: Promise<boolean> | null = null;

  constructor() {
    const prefs = readPrefs();
    this._snap = { status: 'idle', devHost: prefs.devHost, hostReachable: null, hostStarting: false, players: prefs.players, windows: [], host: null };
    desktopDevHost()?.onEvent((e) => {
      if (e.type !== 'exit') return;
      this._endpoint = null;
      const last = e.tail.slice(-4).join('\n');
      this._set({ hostReachable: false, hostNote: `The dev host stopped (exit code ${e.code ?? '?'}).${last ? `\n${last}` : ''}` });
    });
  }

  public readonly subscribe = (fn: () => void) => { this._listeners.add(fn); return () => { this._listeners.delete(fn); }; };
  public readonly getSnapshot = () => this._snap;

  private _set(patch: Partial<MultiplayerSnapshot>): void {
    this._snap = { ...this._snap, ...patch };
    try { localStorage.setItem(PREFS_KEY, JSON.stringify({ devHost: this._snap.devHost, players: this._snap.players })); } catch { /* no storage */ }
    for (const fn of this._listeners) fn();
  }

  public setPlayers(players: MultiplayerPlayer[]): void { this._set({ players }); }
  public setDevHost(devHost: string): void { this._endpoint = null; this._set({ devHost, hostReachable: null, hostNote: undefined }); }

  /**
   * Ask the dev host where players join (before Start: the windows open inside the click). With `start`, on the
   * desktop, and nothing answering at an address on this machine, the editor starts the dev host there first: the
   * dialog asks so when it opens and on Check, never while the address is being typed.
   */
  public async probe(start = false): Promise<boolean> {
    if (this._hostStart) return this._hostStart;
    if (await this._ask()) return true;
    const shell = desktopDevHost();
    const port = localDevHostPort(this._snap.devHost);
    if (!start || !shell || port === null) return false;
    this._set({ hostStarting: true, hostNote: undefined });
    const starting = (async () => {
      try {
        const r = await shell.start(port);
        if (!r.ok) { this._set({ hostNote: r.error ?? 'The dev host did not start.' }); return false; }
        const ok = await this._ask();
        if (!ok) this._set({ hostNote: 'The dev host started, but does not answer at this address.' });
        return ok;
      } catch (e) {
        this._set({ hostNote: (e as Error)?.message ?? String(e) });
        return false;
      } finally {
        this._hostStart = null;
        this._set({ hostStarting: false });
      }
    })();
    this._hostStart = starting;
    return starting;
  }

  /** GET /dev/endpoint once. */
  private async _ask(): Promise<boolean> {
    try {
      const res = await fetch(`${this._snap.devHost}/dev/endpoint`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this._endpoint = await res.json();
      this._set({ hostReachable: true, hostNote: undefined });
      return true;
    } catch {
      this._endpoint = null;
      this._set({ hostReachable: false });
      return false;
    }
  }

  /**
   * Start: open a window per player NOW (synchronously, inside the click), then build, pack and hand the game to
   * the dev host and the windows. `build` is EngineContext.buildWindowPlayData.
   */
  public start(build: () => Promise<any>, size: { width: number; height: number; title: string }): void {
    if (this._snap.status === 'starting' || this._snap.status === 'running') this.stop();
    const endpoint = this._endpoint;
    if (!endpoint) {
      this._set({ status: 'failed', error: desktopDevHost()
        ? 'The dev host is not running: press Check to start it, then Start again.'
        : 'The dev host is not running. Start it with "npm run host -- --dev", then press Start again.' });
      return;
    }
    this._size = size;
    this._bytes = null;
    const windows: MultiplayerWindow[] = this._snap.players.map((player) => ({ sessionId: newSessionId(), player }));
    this._listen();
    windows.forEach((w, i) => this._open(w, i, windows.length));
    this._set({ status: 'starting', windows, error: undefined, host: null });
    void this._boot(build);
  }

  /**
   * Open a player's window again: the browser blocked it, or the player closed it. Call it inside a click (a web
   * pop-up needs one of its own). The player gets a fresh session; the old one is let go.
   */
  public reopen(sessionId: string): void {
    const index = this._snap.windows.findIndex((w) => w.sessionId === sessionId);
    if (index < 0 || !this._endpoint || !this._size) return;
    if (this._snap.status !== 'starting' && this._snap.status !== 'running') return;
    const next: MultiplayerWindow = { sessionId: newSessionId(), player: this._snap.windows[index].player };
    this._open(next, index, this._snap.windows.length); // first: the click's activation is what lets it open
    this._forget(sessionId);
    this._set({ windows: this._snap.windows.map((w) => (w.sessionId === sessionId ? next : w)) });
    const bytes = this._bytes;
    if (bytes) {
      void putPlaySession(next.sessionId, bytes).then(() => {
        if (this._snap.status === 'running') this._post({ to: 'game', session: next.sessionId, type: 'data-ready' });
      }).catch((e) => this._update(next.sessionId, { failed: `Could not hand the game to the window: ${(e as Error)?.message ?? e}` }));
    }
  }

  /** Open `w`'s window (synchronously: on the web, inside the click), as player `index` of `count`. */
  private _open(w: MultiplayerWindow, index: number, count: number): void {
    const size = this._size!;
    this._holdOwnerLock(w.sessionId);
    const join = joinFor(this._endpoint, w.player);
    const title = `${size.title} — ${join.name}`;
    const scr = window.screen as Screen & { availLeft?: number; availTop?: number };
    const at = windowPlacement(index, count, size,
      { left: scr.availLeft ?? 0, top: scr.availTop ?? 0, width: scr.availWidth, height: scr.availHeight });
    const desktop = desktopPlay();
    if (desktop) {
      const position = { x: at.left, y: at.top };
      void desktop.open({ sessionId: w.sessionId, width: size.width, height: size.height, title, join, position })
        .then((r) => { if (r && r.ok === false) this._update(w.sessionId, { failed: r.error ?? 'The window did not open.' }); })
        .catch((e) => this._update(w.sessionId, { failed: (e as Error)?.message ?? String(e) }));
      return;
    }
    // Asked before window.open, which uses the activation up: a pop-up opened with none left is blocked unless
    // the site may open pop-ups, so its missing hello is worth saying soon.
    const activated = navigator.userActivation ? navigator.userActivation.isActive : index === 0;
    window.open(multiplayerPageUrl(w.sessionId, document.baseURI, join), '_blank',
      `popup,noopener,noreferrer,width=${size.width},height=${size.height},left=${at.left},top=${at.top}`);
    this._helloTimers.set(w.sessionId, setTimeout(() => {
      this._helloTimers.delete(w.sessionId);
      const now = this._snap.windows.find((x) => x.sessionId === w.sessionId);
      if (now && !now.open) this._update(w.sessionId, { missing: 'blocked' });
    }, activated ? HELLO_TIMEOUT_MS : BLOCKED_AFTER_MS));
  }

  /** Let a window's session go: its page (if any) closes itself, and its bytes are dropped. */
  private _forget(sessionId: string): void {
    this._post({ to: 'game', session: sessionId, type: 'stop' });
    void desktopPlay()?.close(sessionId).catch(() => {});
    void deletePlaySession(sessionId).catch(() => {});
    this._locks.get(sessionId)?.();
    this._locks.delete(sessionId);
    const timer = this._helloTimers.get(sessionId);
    if (timer !== undefined) clearTimeout(timer);
    this._helloTimers.delete(sessionId);
  }

  private async _boot(build: () => Promise<any>): Promise<void> {
    try {
      const data = await build();
      // Packed once, as Play in window packs it, under a session of its own; every window reads a copy from its
      // own session (a window opened again meanwhile included).
      const packId = newSessionId();
      await playPackJob(data, packId);
      const blob = await getPlaySession(packId);
      void deletePlaySession(packId).catch(() => {});
      if (!blob) throw new Error('The packed game went missing from the play-session store.');
      if (this._snap.status !== 'starting') return; // stopped meanwhile
      const bytes = blob instanceof Blob ? blob : new Blob([blob]);
      this._bytes = bytes;
      await Promise.all(this._snap.windows.map((w) => putPlaySession(w.sessionId, bytes)));
      const res = await fetch(`${this._snap.devHost}/dev/play`, { method: 'POST', body: bytes });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`The dev host could not run the game: ${body?.error ?? `HTTP ${res.status}`}`);
      if (this._snap.status !== 'starting') return; // stopped meanwhile
      this._set({ status: 'running', host: body.status });
      for (const w of this._snap.windows) this._post({ to: 'game', session: w.sessionId, type: 'data-ready' });
      this._poll = setInterval(() => void this._pollHost(), 1000);
    } catch (e) {
      this._set({ status: 'failed', error: (e as Error)?.message ?? String(e) });
    }
  }

  public stop(): void {
    for (const w of this._snap.windows) this._forget(w.sessionId);
    for (const release of this._locks.values()) release();
    this._locks.clear();
    if (this._poll) clearInterval(this._poll);
    this._poll = null;
    this._bytes = null;
    void fetch(`${this._snap.devHost}/dev/stop`, { method: 'POST' }).catch(() => {});
    this._set({ status: 'idle', windows: [], host: null });
  }

  private async _pollHost(): Promise<void> {
    try {
      const res = await fetch(`${this._snap.devHost}/dev/status`);
      this._set({ host: await res.json(), hostReachable: true });
    } catch {
      this._set({ hostReachable: false });
    }
  }

  private _post(message: PlayMessage): void {
    if (!this._channel) this._listen();
    this._channel!.postMessage(message);
  }

  private _listen(): void {
    if (this._channel) return;
    this._channel = new BroadcastChannel(PLAY_CHANNEL);
    this._channel.onmessage = (event) => {
      for (const w of this._snap.windows) {
        const m = event.data;
        if (!isMessageFor(m, 'editor', w.sessionId)) continue;
        if (m.type === 'netsync') this._update(w.sessionId, { report: m.report });
        else if (m.type === 'failed') this._update(w.sessionId, { failed: m.message });
        else if (m.type === 'hello') {
          const timer = this._helloTimers.get(w.sessionId);
          if (timer !== undefined) clearTimeout(timer);
          this._helloTimers.delete(w.sessionId);
          this._update(w.sessionId, { open: true, missing: undefined });
          // The page finds bytes already stored by itself; this is for one that came up before they were.
          if (this._snap.status === 'running') this._post({ to: 'game', session: w.sessionId, type: 'data-ready' });
        } else if (m.type === 'bye' && !m.reloading) {
          this._update(w.sessionId, { open: false, missing: 'closed', report: undefined });
        }
      }
    };
  }

  private _update(sessionId: string, patch: Partial<Omit<MultiplayerWindow, 'sessionId' | 'player'>>): void {
    this._set({ windows: this._snap.windows.map((w) => (w.sessionId === sessionId ? { ...w, ...patch } : w)) });
  }

  /** The game page closes itself once nobody holds its owner lock: held for as long as the session runs. */
  private _holdOwnerLock(sessionId: string): void {
    const locks: LockManager | undefined = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (!locks) return;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    void locks.request(ownerLockName(sessionId), () => held).catch(() => {});
    this._locks.set(sessionId, release);
  }
}

let instance: MultiplayerPlay | null = null;
export function multiplayerPlay(): MultiplayerPlay {
  if (!instance) {
    instance = new MultiplayerPlay();
    window.addEventListener('pagehide', () => { if (instance?.getSnapshot().status !== 'idle') instance?.stop(); });
  }
  return instance;
}

export function useMultiplayerPlay(): MultiplayerSnapshot {
  const c = multiplayerPlay();
  return useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
}

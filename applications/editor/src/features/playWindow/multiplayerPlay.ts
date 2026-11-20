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

import { useSyncExternalStore } from 'react';
import { PLAY_CHANNEL, SESSION_PARAM, isMessageFor, newSessionId, ownerLockName, type PlayMessage } from './protocol';
import { getPlaySession, putPlaySession, deletePlaySession } from './sessionStore';
import { desktopPlay } from './desktopPlay';
import type { PlayWindowJoin } from './desktopPlay';
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

export interface MultiplayerSnapshot {
  status: 'idle' | 'starting' | 'running' | 'failed';
  devHost: string;
  /** Whether the dev host answered (null: not asked yet). */
  hostReachable: boolean | null;
  players: MultiplayerPlayer[];
  /** The windows of the running session, by session id, with each one's player. */
  windows: { sessionId: string; player: MultiplayerPlayer; report?: PeerReport; failed?: string }[];
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

  constructor() {
    const prefs = readPrefs();
    this._snap = { status: 'idle', devHost: prefs.devHost, hostReachable: null, players: prefs.players, windows: [], host: null };
  }

  public readonly subscribe = (fn: () => void) => { this._listeners.add(fn); return () => { this._listeners.delete(fn); }; };
  public readonly getSnapshot = () => this._snap;

  private _set(patch: Partial<MultiplayerSnapshot>): void {
    this._snap = { ...this._snap, ...patch };
    try { localStorage.setItem(PREFS_KEY, JSON.stringify({ devHost: this._snap.devHost, players: this._snap.players })); } catch { /* no storage */ }
    for (const fn of this._listeners) fn();
  }

  public setPlayers(players: MultiplayerPlayer[]): void { this._set({ players }); }
  public setDevHost(devHost: string): void { this._endpoint = null; this._set({ devHost, hostReachable: null }); }

  /** Ask the dev host where players join (before Start: the windows open inside the click). */
  public async probe(): Promise<boolean> {
    try {
      const res = await fetch(`${this._snap.devHost}/dev/endpoint`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this._endpoint = await res.json();
      this._set({ hostReachable: true });
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
      this._set({ status: 'failed', error: 'The dev host is not running. Start it with "npm run host -- --dev", then press Start again.' });
      return;
    }
    const desktop = desktopPlay();
    const windows = this._snap.players.map((player) => ({ sessionId: newSessionId(), player }));
    for (const w of windows) {
      this._holdOwnerLock(w.sessionId);
      const join = joinFor(endpoint, w.player);
      const title = `${size.title} — ${join.name}`;
      if (desktop) void desktop.open({ sessionId: w.sessionId, width: size.width, height: size.height, title, join }).catch(() => {});
      else window.open(multiplayerPageUrl(w.sessionId, document.baseURI, join), '_blank', `popup,noopener,noreferrer,width=${size.width},height=${size.height}`);
    }
    this._listen();
    this._set({ status: 'starting', windows, error: undefined, host: null });
    void this._boot(build, windows.map((w) => w.sessionId));
  }

  private async _boot(build: () => Promise<any>, ids: string[]): Promise<void> {
    try {
      const data = await build();
      // Packed once, as Play in window packs it; every window reads the same bytes from its own session.
      await playPackJob(data, ids[0]);
      const blob = await getPlaySession(ids[0]);
      if (!blob) throw new Error('The packed game went missing from the play-session store.');
      const bytes = blob instanceof Blob ? blob : new Blob([blob]);
      for (const id of ids.slice(1)) await putPlaySession(id, bytes);
      const res = await fetch(`${this._snap.devHost}/dev/play`, { method: 'POST', body: bytes });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`The dev host could not run the game: ${body?.error ?? `HTTP ${res.status}`}`);
      if (this._snap.status !== 'starting') return; // stopped meanwhile
      this._set({ status: 'running', host: body.status });
      for (const id of ids) this._post({ to: 'game', session: id, type: 'data-ready' });
      this._poll = setInterval(() => void this._pollHost(), 1000);
    } catch (e) {
      this._set({ status: 'failed', error: (e as Error)?.message ?? String(e) });
    }
  }

  public stop(): void {
    for (const w of this._snap.windows) {
      this._post({ to: 'game', session: w.sessionId, type: 'stop' });
      void desktopPlay()?.close(w.sessionId).catch(() => {});
      void deletePlaySession(w.sessionId).catch(() => {});
    }
    for (const release of this._locks.values()) release();
    this._locks.clear();
    if (this._poll) clearInterval(this._poll);
    this._poll = null;
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
      }
    };
  }

  private _update(sessionId: string, patch: { report?: PeerReport; failed?: string }): void {
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

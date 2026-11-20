// Play in window: the game page (play.html). The editor opens it in a window of its own — a BrowserWindow
// the desktop shell creates, or a popup on the web — so the game runs in ANOTHER renderer process than the
// editor. That is the point: a script that stops at a breakpoint, a hang, a crash, all stay in here.
//
// The page boots the same runtime as a published game (boot.tsx) from a packed game.bin the editor leaves
// in the play-session store, but with the Logger on, its rows forwarded to the editor's Console, and the
// scripts compiled from source. The editor drives it over the play channel (features/playWindow/protocol.ts).

import { AudioManager, CleoEngine, Logger, scriptLocationOf } from 'cleo';
import { readBackendPreference } from '@cleo/app-kit/renderer/backendPreference';
import { bootPlayer, hideLoadingWhenSmooth, setLoadingText, showError, type PlayerHandle } from './boot';
import { createPhysicsWorker } from '../workers/physicsWorkerHost';
import { PLAY_CHANNEL, SESSION_PARAM, encodeLogEntry, gameLockName, isMessageFor, ownerLockName, type GameEvent, type GameState, type RemoteLogOp } from '../features/playWindow/protocol';
import { getPlaySession } from '../features/playWindow/sessionStore';
import { playSaveStore, type PlaySavesConfig } from '../features/saves/playSaves';
import { blobSource, bufferSource } from './gameSource';
import { readGameHeader } from './unpack';
import { netsyncFromUrl } from './netsyncJoin';

const session = new URLSearchParams(location.search).get(SESSION_PARAM) ?? '';
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(PLAY_CHANNEL);

let state: GameState = { phase: 'waiting' };
let handle: PlayerHandle | null = null;
let booting = false;
/** Set when the page reloads itself for a restart, so its goodbye says it is coming back. */
let reloading = false;

function send(event: GameEvent): void {
  channel?.postMessage({ to: 'editor', session, ...event });
}

function setState(next: GameState): void {
  state = next;
  send({ type: 'state', state });
}

// ---- Logs to the editor's Console ------------------------------------------------------------------
//
// Batched: a script that logs every frame must not post a message a frame. A timer, not a frame callback,
// so the rows still go out while the window is hidden and its frames have stopped.

const pending: RemoteLogOp[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let uncaught = 0;

function flush(): void {
  flushTimer = null;
  if (pending.length) send({ type: 'log', ops: pending.splice(0) });
}

function queue(op: RemoteLogOp): void {
  pending.push(op);
  flushTimer ??= setTimeout(flush, 50);
}

CleoEngine.eventEmitter.on('LOG', (entry: any) => queue({ op: 'add', entry: encodeLogEntry(entry) }));
CleoEngine.eventEmitter.on('LOG_UPDATE', (entry: any) => queue({ op: 'update', entry: encodeLogEntry(entry) }));
CleoEngine.eventEmitter.on('LOG_CLEAR', () => queue({ op: 'clear' }));

// Uncaught failures, as the editor's own console store takes them (they bypass the Logger).
window.addEventListener('error', (e: ErrorEvent) => {
  queue({ op: 'add', entry: encodeLogEntry({ id: `uncaught-${uncaught++}`, method: 'error', data: [e.error ?? e.message], scope: 'Uncaught', timestamp: Date.now(), source: scriptLocationOf(e.error) ?? undefined }) });
});
window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
  queue({ op: 'add', entry: encodeLogEntry({ id: `uncaught-${uncaught++}`, method: 'error', data: ['Unhandled promise rejection:', e.reason], scope: 'Uncaught', timestamp: Date.now(), source: scriptLocationOf(e.reason) ?? undefined }) });
});

// ---- The script debugger's hooks -------------------------------------------------------------------
//
// Called from outside by the editor's debugger, over the DevTools protocol (scriptDebugger/
// debugController.ts) — never over the channel, which a page stopped at a breakpoint does not hear.

(globalThis as any).__cleoDebug = {
  // Stopped at a breakpoint the frame is frozen, but the music would play on over it.
  paused() { AudioManager.Instance.suspend(); },
  resumed() { if (!handle?.engine.isPaused) AudioManager.Instance.resume(); },
};

// A logpoint (scriptDebugger/logpoints.ts): its line's own row, linked back to the line.
(globalThis as any).__cleoLogpoint = (url: unknown, line: unknown, ...parts: unknown[]) => {
  const source = typeof url === 'string' && Number.isFinite(line) ? { url, line: Number(line) } : undefined;
  Logger.print('info', parts, 'Logpoint', source ? { source } : undefined);
};

// ---- Boot ------------------------------------------------------------------------------------------

function fail(err: unknown): void {
  send({ type: 'failed', message: String((err as any)?.message ?? err), ...((err as any)?.stack ? { stack: String((err as any).stack) } : {}) });
  showError(err);
}

/** The editor's release-mouse key, as features/options/editorPrefs.ts stores it; Escape when unreadable. */
function editorReleaseKey(): string {
  try {
    const stored = JSON.parse(localStorage.getItem('cleo_editor_prefs_v1') ?? 'null')?.releaseMouseKey;
    if (typeof stored === 'string' && /^[A-Za-z][A-Za-z0-9]{1,24}$/.test(stored)) return stored;
  } catch { /* storage blocked, or not JSON */ }
  return 'Escape';
}

/** The stored game: a Blob, read a range at a time from IndexedDB's copy (an ArrayBuffer from an older editor). */
async function boot(stored: Blob | ArrayBuffer): Promise<void> {
  booting = true;
  setState({ phase: 'booting' });
  setLoadingText('Starting…');
  try {
    const source = stored instanceof Blob ? blobSource(stored) : bufferSource(stored);
    const header = await readGameHeader(source);
    // Saves go where in-editor Play's do, the project's Play saves (the editor's Saves panel lists them), and
    // Saves ▸ Play from save names the one to start from.
    const playSaves: PlaySavesConfig | undefined = header.manifest?.config?.playSaves;
    const saveStore = playSaves?.namespace ? playSaveStore(playSaves.namespace) : undefined;
    const fromSlot = playSaves?.fromSlot;
    handle = await bootPlayer({
      source,
      header,
      logging: true,
      saveStore,
      startFromSave: saveStore && fromSlot ? () => saveStore.read(fromSlot) : undefined,
      // The editor's own graphics API, so the game draws as it does in the editor's viewport.
      graphicsBackend: readBackendPreference(),
      physicsWorkerFactory: createPhysicsWorker,
      onSceneStarted: name => setState({ phase: handle?.engine.isPaused ? 'paused' : 'running', scene: name }),
      onError: fail,
      // Play › Multiplayer opens each player's window with the local host to join (netsyncJoin.ts), and reads
      // how its link and prediction are doing every second.
      netsync: (() => {
        const net = netsyncFromUrl();
        if (!net) return undefined;
        return {
          ...net,
          onJoined: (client) => {
            setInterval(() => {
              const s = client.predictor.stats;
              send({ type: 'netsync', report: {
                peerId: client.session.peerId, link: client.session.linkKind ?? '', fallbackReason: client.session.fallbackReason,
                rttMs: Math.round(client.session.clock.rttMs * 10) / 10, checked: s.checked, corrections: s.corrections,
                maxErrorCm: Math.round(s.maxError * 1000) / 10, ticks: client.frames.ticks,
              } });
            }, 1000);
          },
        };
      })(),
    });
    setState({ phase: handle.engine.isPaused ? 'paused' : 'running', scene: handle.currentSceneName() });
    // The editor's release-mouse key (Options ▸ Editor ▸ Viewport ▸ Play), from its own storage: this window is
    // the editor's origin on the web. The desktop window may not see it, and keeps Esc.
    handle.engine.input.releaseKey = editorReleaseKey();
    hideLoadingWhenSmooth();
  } catch (err) {
    fail(err);
  } finally {
    booting = false;
  }
}

// The bytes may already be there (a reload, a restart) or still on their way (a fresh Play: the window
// opens before the editor has built the game). Both the first check and every `data-ready` come through
// here; one look at a time, and a `data-ready` that lands during a look gets a second one.
let checking = false;
let checkAgain = false;
async function tryBoot(): Promise<void> {
  if (handle || booting) return;
  if (checking) { checkAgain = true; return; }
  checking = true;
  try {
    do {
      checkAgain = false;
      const stored = await getPlaySession(session).catch(() => null);
      if (stored) { await boot(stored); return; }
    } while (checkAgain);
  } finally {
    checking = false;
  }
}

function stop(): void {
  if (handle) {
    handle.engine.isPaused = true;
    AudioManager.Instance.stopAll();
  }
  // A window a script opened may close itself; the desktop shell closes it from outside anyway. A page
  // that is still here a moment later (a browser that refuses) says what happened instead.
  window.close();
  setTimeout(() => {
    document.getElementById('cleo-loading')?.remove();
    const note = document.createElement('pre');
    note.id = 'cleo-error';
    note.style.color = '#9a968e';
    note.textContent = 'The game was stopped from the editor. You can close this window.';
    document.body.appendChild(note);
  }, 300);
}

// ---- Commands from the editor ----------------------------------------------------------------------

if (channel) channel.onmessage = (event: MessageEvent) => {
  const message = event.data;
  if (!isMessageFor(message, 'game', session)) return;
  switch (message.type) {
    case 'data-ready':
      void tryBoot();
      break;
    case 'pause':
      if (!handle) break;
      handle.engine.isPaused = true;
      // Muted rather than stopped, as the editor's Pause does: resuming picks the music up where it was.
      AudioManager.Instance.suspend();
      setState({ ...state, phase: 'paused' });
      break;
    case 'resume':
      if (!handle) break;
      handle.engine.isPaused = false;
      AudioManager.Instance.resume();
      setState({ ...state, phase: 'running' });
      break;
    case 'restart':
      // A fresh page is the only complete reset: every engine singleton, GPU resource, worker and script
      // module goes with it. The editor has already written the rebuilt game under this session.
      reloading = true;
      flush();
      location.reload();
      break;
    case 'stop':
      stop();
      break;
    case 'focus':
      window.focus();
      break;
    case 'ping':
      send({ type: 'pong', state });
      break;
  }
};

window.addEventListener('pagehide', () => {
  flush();
  send({ type: 'bye', reloading });
});

// In a browser this window's own developer tools are the script debugger (the editor cannot drive another
// page's): say so while it loads. The desktop app's window is debugged from the editor or VS Code instead.
if (!/\bElectron\//.test(navigator.userAgent)) {
  const hint = document.createElement('div');
  hint.id = 'cleo-debug-hint';
  hint.textContent = 'To debug the scripts, press F12 in this window: they are under Sources ▸ cleo-script://';
  hint.style.cssText = 'position:absolute;left:0;right:0;bottom:28px;text-align:center;font:12px system-ui,sans-serif;letter-spacing:0;color:#77736b';
  document.getElementById('cleo-loading')?.appendChild(hint);
}

function announce(): void {
  setLoadingText('Building the game in the editor…');
  send({ type: 'hello', state });
  void tryBoot();
}

if (!session || !channel) {
  showError('This page runs a game started from the editor: Play ▸ Play in window.');
} else if (navigator.locks) {
  // A lock granted while this page is held by a debugger (VS Code's attach holds a fresh page with
  // Page.waitForDebugger until its breakpoints are in) cannot call back: the request rejects with "the
  // provided callback is no longer runnable", and the page would never say hello. So ask again, once it runs.
  const request = (name: string, granted: () => Promise<void> | void, attempt = 0): void => {
    navigator.locks.request(name, granted).catch(() => {
      if (attempt < 20) setTimeout(() => request(name, granted, attempt + 1), 100);
    });
  };
  // Held for this page's whole life, and only then hello: the editor watches it to learn the page is gone
  // with no help from this page's JavaScript, which a breakpoint or a crash would have stopped.
  request(gameLockName(session), () => {
    announce();
    return new Promise<void>(() => {});
  });
  // The editor holds this one for the session. It comes to us only when the editor has let go: it was
  // closed or reloaded, or it ended the session.
  request(ownerLockName(session), () => { stop(); });
} else {
  announce();
}

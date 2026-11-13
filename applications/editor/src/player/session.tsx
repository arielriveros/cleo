// Play in window: the game page (play.html). The editor opens it in a window of its own — a BrowserWindow
// the desktop shell creates, or a popup on the web — so the game runs in ANOTHER renderer process than the
// editor. That is the point: a script that stops at a breakpoint, a hang, a crash, all stay in here.
//
// The page boots the same runtime as a published game (boot.tsx) from a packed game.bin the editor leaves
// in the play-session store, but with the Logger on, its rows forwarded to the editor's Console, and the
// scripts compiled from source. The editor drives it over the play channel (features/playWindow/protocol.ts).

import { AudioManager, CleoEngine } from 'cleo';
import { readBackendPreference } from '@cleo/app-kit/renderer/backendPreference';
import { bootPlayer, hideLoadingWhenSmooth, setLoadingText, showError, type PlayerHandle } from './boot';
import { createPhysicsWorker } from '../workers/physicsWorkerHost';
import { PLAY_CHANNEL, SESSION_PARAM, encodeLogEntry, gameLockName, isMessageFor, ownerLockName, type GameEvent, type GameState, type RemoteLogOp } from '../features/playWindow/protocol';
import { getPlaySession } from '../features/playWindow/sessionStore';

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
  queue({ op: 'add', entry: encodeLogEntry({ id: `uncaught-${uncaught++}`, method: 'error', data: [e.error ?? e.message], scope: 'Uncaught', timestamp: Date.now() }) });
});
window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
  queue({ op: 'add', entry: encodeLogEntry({ id: `uncaught-${uncaught++}`, method: 'error', data: ['Unhandled promise rejection:', e.reason], scope: 'Uncaught', timestamp: Date.now() }) });
});

// ---- Boot ------------------------------------------------------------------------------------------

function fail(err: unknown): void {
  send({ type: 'failed', message: String((err as any)?.message ?? err), ...((err as any)?.stack ? { stack: String((err as any).stack) } : {}) });
  showError(err);
}

async function boot(buffer: ArrayBuffer): Promise<void> {
  booting = true;
  setState({ phase: 'booting' });
  setLoadingText('Starting…');
  try {
    handle = await bootPlayer({
      buffer,
      logging: true,
      // The editor's own graphics API, so the game draws as it does in the editor's viewport.
      graphicsBackend: readBackendPreference(),
      physicsWorkerFactory: createPhysicsWorker,
      onSceneStarted: name => setState({ phase: handle?.engine.isPaused ? 'paused' : 'running', scene: name }),
      onError: fail,
    });
    setState({ phase: handle.engine.isPaused ? 'paused' : 'running', scene: handle.currentSceneName() });
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
      const buffer = await getPlaySession(session).catch(() => null);
      if (buffer) { await boot(buffer); return; }
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

function announce(): void {
  setLoadingText('Building the game in the editor…');
  send({ type: 'hello', state });
  void tryBoot();
}

if (!session || !channel) {
  showError('This page runs a game started from the editor: Play ▸ Play in window.');
} else if (navigator.locks) {
  // Held for this page's whole life, and only then hello: the editor watches it to learn the page is gone
  // with no help from this page's JavaScript, which a breakpoint or a crash would have stopped.
  void navigator.locks.request(gameLockName(session), () => {
    announce();
    return new Promise<void>(() => {});
  });
  // The editor holds this one for the session. It comes to us only when the editor has let go: it was
  // closed or reloaded, or it ended the session.
  void navigator.locks.request(ownerLockName(session), () => { stop(); });
} else {
  announce();
}

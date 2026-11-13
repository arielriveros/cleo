// Play in window: the editor's one controller (playWindowController.ts) wired to the real platform — the
// desktop shell's play window or a web popup, the project worker's packer, Web Locks, the engine's log bus.

import { useSyncExternalStore } from 'react';
import { CleoEngine, Logger } from 'cleo';
import { toast } from '@cleo/app-kit/feedback/toastStore';
import { WindowPlayController, type WindowPlayEnv, type WindowPlaySnapshot } from './playWindowController';
import { PLAY_CHANNEL, SESSION_PARAM, gameLockName, newSessionId, ownerLockName } from './protocol';
import { desktopPlay } from './desktopPlay';
import { deletePlaySession, purgeStalePlaySessions } from './sessionStore';
import { playPackJob } from '../../workers/workerClient';

/** The URL of the game page for a session, on this origin (web only: the desktop shell builds its own). */
export function playPageUrl(sessionId: string, base: string): string {
  return new URL(`play.html?${SESSION_PARAM}=${encodeURIComponent(sessionId)}`, base).toString();
}

function browserEnv(): WindowPlayEnv {
  const desktop = desktopPlay();
  // A desktop shell too old to have a play window: never fall back to `window.open` there — the shell's
  // window-open handler would hand the game the editor's preload, file-system IPC and all.
  const oldShell = !desktop && typeof (window as any).cleoDesktop === 'object';
  const locks: LockManager | undefined = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  let windowEvents: ((sessionId: string, event: 'closed' | 'crashed', detail?: string) => void) | null = null;

  return {
    newSessionId,
    openChannel(onMessage) {
      const channel = new BroadcastChannel(PLAY_CHANNEL);
      channel.onmessage = event => onMessage(event.data);
      return { post: message => channel.postMessage(message), close: () => channel.close() };
    },
    openWindow(sessionId, size) {
      if (desktop) {
        void desktop.open({ sessionId, ...size }).then(
          result => { if (!result.ok) windowEvents?.(sessionId, 'crashed', result.error ?? 'the window did not open'); },
          error => windowEvents?.(sessionId, 'crashed', String(error?.message ?? error)),
        );
        return true;
      }
      if (oldShell) return false;
      // noopener: a popup that keeps its opener stays in the opener's browsing-context group, and Chrome then
      // keeps it in the EDITOR's process — the very thing this is for. It also means `window.open` returns
      // null whatever happens, so a blocked popup is noticed by the missing hello instead.
      window.open(playPageUrl(sessionId, document.baseURI), '_blank',
        `popup,noopener,noreferrer,width=${size.width},height=${size.height}`);
      return true;
    },
    closeWindow(sessionId) { if (desktop) void desktop.close(sessionId).catch(() => {}); },
    focusWindow(sessionId) { if (desktop) void desktop.focus(sessionId).catch(() => {}); },
    popupsCanBeBlocked: !desktop,
    pack: (data, sessionId) => playPackJob(data, sessionId),
    dropSession: sessionId => deletePlaySession(sessionId),
    holdOwnerLock(sessionId) {
      if (!locks) return null;
      let release: () => void = () => {};
      const held = new Promise<void>(resolve => { release = resolve; });
      void locks.request(ownerLockName(sessionId), () => held).catch(() => {});
      return () => release();
    },
    watchGameLock(sessionId, gone) {
      if (!locks) return false;
      // Granted only once the page holding it is gone. Returning at once lets go again, so the next page
      // (a reload) can take it.
      void locks.request(gameLockName(sessionId), () => { gone(); }).catch(() => {});
      return true;
    },
    onWindowEvent(cb) {
      windowEvents = cb;
      const off = desktop?.onEvent(event => {
        if (event.type === 'process')
          Logger.info(`The game window runs in renderer process ${event.pid} (the editor's is ${event.editorPid})`, 'Play');
        else if (event.type === 'closed') cb(event.sessionId, 'closed');
        else cb(event.sessionId, 'crashed', event.reason);
      });
      return () => { windowEvents = null; off?.(); };
    },
    emitLog(kind, entry) {
      // Through the engine's own log bus, so every consumer gets it: the Console's store and the agent
      // bridge's log reader both listen there.
      if (kind === 'add') CleoEngine.eventEmitter.emit('LOG', entry);
      else CleoEngine.eventEmitter.emit('LOG_UPDATE', entry);
    },
    notify(tone, message) {
      if (tone === 'error') { toast.error(message); Logger.error(message, 'Play'); }
      else if (tone === 'warning') { toast.warning(message); Logger.warn(message, 'Play'); }
      else toast.info(message);
    },
    log: message => Logger.info(message, 'Play'),
    now: () => performance.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

let controller: WindowPlayController | null = null;

/** The editor's Play-in-window controller, created on first use. */
export function windowPlay(): WindowPlayController {
  if (controller) return controller;
  controller = new WindowPlayController(browserEnv());
  // The editor closing or reloading takes its game window along. The owner lock does the same on its own
  // when the page dies without running this (a crash), so this is the fast path, not the only one.
  window.addEventListener('pagehide', () => controller?.stopForUnload());
  // Bytes a crashed window or a killed editor left behind.
  void purgeStalePlaySessions().catch(() => {});
  return controller;
}

/** Whether a game is running (or being built) in a window — in-editor Play waits for it to end. */
export function isWindowPlayActive(): boolean {
  return controller?.getSnapshot().active ?? false;
}

export function useWindowPlay(): WindowPlaySnapshot {
  const c = windowPlay();
  return useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
}

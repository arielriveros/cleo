// Debugging from VS Code (Options ▸ Editor ▸ Scripts ▸ Debug scripts with ▸ VS Code; desktop only).
//
// The desktop app serves a debug port that offers only the game windows (app-kit/desktop/debugPort.js), and
// VS Code's JavaScript debugger attaches there with the workspace's "Attach to the Cleo game" configuration
// (scriptWorkspace/scaffold.ts launchConfiguration). A game window has one debugger connection, so while VS
// Code is chosen Cleo's own debugger stays off: this module turns the port on and off with the preference and
// keeps what the editor must know — is VS Code connected, has it got its breakpoints in on a new game, does
// it hold the game stopped (a stopped page does not hear the editor's Pause or Restart).

import { useSyncExternalStore } from 'react';
import { editorPrefsStore, getEditorPrefs } from '../options/editorPrefs';
import { desktopDebugPort, type PlayWindowEvent } from '../playWindow/desktopPlay';

export interface VsCodeDebugStatus {
  /** The preference says VS Code and this shell has the port. */
  enabled: boolean;
  listening: boolean;
  port: number;
  /** Debugger connections open on the port (VS Code is attached while this is above zero). */
  clients: number;
  /** Why the port could not open (another program on it, …). */
  error?: string;
  /** Play sessions VS Code holds stopped at a breakpoint. */
  stopped: readonly string[];
}

let status: VsCodeDebugStatus = { enabled: false, listening: false, port: 0, clients: 0, stopped: [] };
const listeners = new Set<() => void>();
/** Sessions VS Code has finished setting up on (its breakpoints are in). */
const ready = new Set<string>();
const readyWaiters = new Map<string, (() => void)[]>();
let resumedListener: ((sessionId: string) => void) | null = null;

function set(patch: Partial<VsCodeDebugStatus>): void {
  status = { ...status, ...patch };
  for (const l of listeners) l();
}

export function getVsCodeDebugStatus(): VsCodeDebugStatus { return status; }

export function subscribeVsCodeDebug(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useVsCodeDebug(): VsCodeDebugStatus {
  return useSyncExternalStore(subscribeVsCodeDebug, getVsCodeDebugStatus, getVsCodeDebugStatus);
}

/**
 * VS Code debugging asked for by `npm run debug` (the project's `cleo` CLI): on for this session whatever the
 * preference says, which is left as the user set it.
 */
let sessionOverride = false

/** Whether games playing in a window are VS Code's to debug now (and Cleo's own debugger stays off). */
export function vscodeDebugging(): boolean {
  return (getEditorPrefs().scriptDebugWith === 'vscode' || sessionOverride) && !!desktopDebugPort();
}

/** Turn VS Code debugging on (or back to the preference) for this session. Resolves with the port's state. */
export async function setVsCodeDebugOverride(on: boolean): Promise<VsCodeDebugStatus> {
  sessionOverride = on
  await apply()
  return getVsCodeDebugStatus()
}

/** Turn the port on, off or onto another port, as the preferences say. */
async function apply(): Promise<void> {
  const bridge = desktopDebugPort();
  const prefs = getEditorPrefs();
  const enabled = !!bridge && (prefs.scriptDebugWith === 'vscode' || sessionOverride);
  if (!bridge) { set({ enabled: false, listening: false, port: 0, clients: 0, error: undefined }); return; }
  const r = await bridge.debugPort({ enabled, port: prefs.vscodeDebugPort }).catch(e => ({ ok: false, error: String(e?.message ?? e) } as { ok: boolean; port?: number; error?: string }));
  set({ enabled, listening: enabled && r.ok, port: enabled && r.ok ? r.port ?? prefs.vscodeDebugPort : 0, error: enabled && !r.ok ? r.error : undefined, ...(enabled ? {} : { clients: 0 }) });
}

let installed = false;
/** Follow the preference from now on. Idempotent. */
export function installVsCodeDebug(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  let last = '';
  const sync = () => {
    const prefs = getEditorPrefs();
    const key = `${prefs.scriptDebugWith}:${prefs.vscodeDebugPort}`;
    if (key === last) return;
    last = key;
    void apply();
  };
  editorPrefsStore.subscribe(sync);
  sync();
}

/** Called when VS Code lets a stopped game go: Play in window asks the game for its state again. */
export function onVsCodeResumed(fn: ((sessionId: string) => void) | null): void { resumedListener = fn; }

/** The desktop shell's events about the port (routed here by windowPlay.ts). */
export function onVsCodeEvent(event: PlayWindowEvent): void {
  switch (event.type) {
    case 'vscode-status':
      set({ listening: event.listening, port: event.port, clients: event.clients });
      break;
    case 'vscode-ready': {
      ready.add(event.sessionId);
      for (const resolve of readyWaiters.get(event.sessionId) ?? []) resolve();
      readyWaiters.delete(event.sessionId);
      break;
    }
    case 'vscode-paused':
      if (!status.stopped.includes(event.sessionId)) set({ stopped: [...status.stopped, event.sessionId] });
      break;
    case 'vscode-resumed':
      if (status.stopped.includes(event.sessionId)) set({ stopped: status.stopped.filter(id => id !== event.sessionId) });
      resumedListener?.(event.sessionId);
      break;
  }
}

/**
 * Resolves when VS Code has its breakpoints in on this session's window, so a breakpoint in onStart is
 * there when it runs — at once when VS Code is not connected at all, and never later than `capMs`.
 */
export function waitForVsCode(sessionId: string, capMs = 3000): Promise<void> {
  if (ready.has(sessionId) || status.clients === 0) return Promise.resolve();
  return new Promise(resolve => {
    const list = readyWaiters.get(sessionId) ?? [];
    list.push(resolve);
    readyWaiters.set(sessionId, list);
    setTimeout(resolve, capMs);
  });
}

export function stoppedInVsCode(sessionId: string | null | undefined): boolean {
  return !!sessionId && status.stopped.includes(sessionId);
}

/** Let a game stopped in VS Code go (VS Code sees it resume). */
export async function releaseVsCode(sessionId: string): Promise<void> {
  await desktopDebugPort()?.vscodeRelease(sessionId).catch(() => ({ ok: false }));
}

/** A session ended: forget what VS Code had of it. */
export function forgetVsCodeSession(sessionId: string): void {
  ready.delete(sessionId);
  readyWaiters.delete(sessionId);
  if (status.stopped.includes(sessionId)) set({ stopped: status.stopped.filter(id => id !== sessionId) });
}

// The script debugger wired to the real platform: the desktop shell's relay to the game window
// (desktopPlay.ts desktopDebug), the breakpoint store, the debugger's switches, and the editor's scripts.
// Play in window (windowPlay.ts) hands its session hooks to `scriptDebugger()` and routes the shell's
// debugger events here.

import { useSyncExternalStore } from 'react';
import { Logger } from 'cleo';
import { DebugController, type DebugEnv, type DebugSnapshot } from './debugController';
import { getBreakpoints, subscribeBreakpoints } from './breakpoints';
import { getDebugPrefs, subscribeDebugPrefs } from './debugPrefs';
import { desktopDebug, desktopPlay } from '../playWindow/desktopPlay';
import { openScriptAt } from '../nodeInspector/scriptEditor/scriptReveal';

/**
 * The editor's scripts as the debugger needs them, registered by EngineContext (which owns the library and
 * the open tabs' buffers).
 */
export interface ScriptSourceProvider {
  /** Every script's SAVED source by module id: what a build packs. */
  saved(): ReadonlyMap<string, string>;
  /** A script's text now: its open tab's buffer, else saved. */
  current(moduleId: string): string | undefined;
  /** The script asset at a module id. */
  assetIdOf(moduleId: string): string | undefined;
}

let sources: ScriptSourceProvider | null = null;
export function setScriptSourceProvider(provider: ScriptSourceProvider | null): void { sources = provider; }

/** The script asset at a module id, if the project has one there. */
export function scriptSourceAssetId(moduleId: string): string | undefined { return sources?.assetIdOf(moduleId); }

let pingGame: () => void = () => {};
/** Play in window's "ask the game for its state", set by windowPlay.ts (which imports this module). */
export function setGamePing(fn: () => void): void { pingGame = fn; }

function browserEnv(): DebugEnv {
  return {
    async send(sessionId, method, params) {
      const bridge = desktopDebug();
      if (!bridge) throw new Error('No debugger in this shell');
      const r = await bridge.debug(sessionId, method, params);
      if (!r.ok) throw new Error(r.error ?? 'The command failed');
      return r.result;
    },
    async attach(sessionId, options) {
      const bridge = desktopDebug();
      return !!bridge && (await bridge.debugAttach(sessionId, options)).ok;
    },
    breakpoints: getBreakpoints,
    prefs: getDebugPrefs,
    savedSources: () => sources?.saved() ?? new Map(),
    currentSource: moduleId => sources?.current(moduleId),
    raiseEditor: () => { void desktopDebug()?.raiseEditor().catch(() => {}); },
    focusGame: sessionId => { void desktopPlay()?.focus(sessionId).catch(() => {}); },
    ping: () => pingGame(),
    reveal(moduleId, line) {
      const assetId = sources?.assetIdOf(moduleId);
      if (assetId) openScriptAt(assetId, line, { inEditor: true });
    },
    log: message => Logger.warn(message, 'Debugger'),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

let controller: DebugController | null = null;

/** Whether this editor can debug a game at all: the desktop app, with a shell that relays the debugger. */
export function canDebugScripts(): boolean {
  return !!desktopDebug();
}

/** The editor's script debugger, created on first use. */
export function scriptDebugger(): DebugController {
  if (controller) return controller;
  const c = controller = new DebugController(browserEnv());
  // Breakpoints and switches changed anywhere (the gutter, the panel) reach the running game.
  subscribeBreakpoints(() => { void c.requestSync(); });
  let prefs = getDebugPrefs();
  subscribeDebugPrefs(() => {
    const next = getDebugPrefs();
    if (next.pauseOnExceptions !== prefs.pauseOnExceptions) c.setPauseOnExceptions(next.pauseOnExceptions);
    if (next.breakpointsActive !== prefs.breakpointsActive) c.setBreakpointsActive(next.breakpointsActive);
    prefs = next;
  });
  if (typeof window !== 'undefined') installDebugKeys(c);
  return c;
}

/**
 * The debugger's keys, the browser devtools' own: F8 continue / pause, F10 step over, F11 step into,
 * Shift+F11 step out. Only while a game is being debugged — otherwise F8 is the script editor's "next
 * problem". Capture phase, so the script editor never sees them then.
 */
function installDebugKeys(c: DebugController): void {
  window.addEventListener('keydown', e => {
    const phase = c.getSnapshot().phase;
    if ((phase !== 'paused' && phase !== 'running') || e.ctrlKey || e.altKey || e.metaKey) return;
    const paused = phase === 'paused';
    if (e.key === 'F8' && !e.shiftKey) { if (paused) c.resume(); else c.pause(); }
    else if (paused && e.key === 'F10' && !e.shiftKey) c.stepOver();
    else if (paused && e.key === 'F11') { if (e.shiftKey) c.stepOut(); else c.stepInto(); }
    else return;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}

export function useScriptDebugger(): DebugSnapshot {
  const c = scriptDebugger();
  return useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
}

// The debugger's two switches: stop on script exceptions (on unless turned off) and breakpoints on. A
// person's way of working, not the project's, so per machine in localStorage, like the Play target.

import { useSyncExternalStore } from 'react';

export interface DebugPrefs {
  /** The game stops where a script throws (Debugger panel toggle). On by default. */
  pauseOnExceptions: boolean;
  /** Breakpoints stop the game; off lets it run past every one without removing them. */
  breakpointsActive: boolean;
}

const KEY = 'cleo_debug_prefs_v1';
const DEFAULTS: DebugPrefs = { pauseOnExceptions: true, breakpointsActive: true };
const listeners = new Set<() => void>();
let cached: DebugPrefs | null = null;

export function parseDebugPrefs(raw: string | null): DebugPrefs {
  try {
    const v = raw ? JSON.parse(raw) : {};
    return {
      pauseOnExceptions: typeof v?.pauseOnExceptions === 'boolean' ? v.pauseOnExceptions : DEFAULTS.pauseOnExceptions,
      breakpointsActive: typeof v?.breakpointsActive === 'boolean' ? v.breakpointsActive : DEFAULTS.breakpointsActive,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function getDebugPrefs(): DebugPrefs {
  if (cached) return cached;
  try { cached = parseDebugPrefs(localStorage.getItem(KEY)); } catch { cached = { ...DEFAULTS }; }
  return cached;
}

export function setDebugPrefs(patch: Partial<DebugPrefs>): void {
  cached = { ...getDebugPrefs(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(cached)); } catch { /* lasts until reload */ }
  for (const listener of listeners) listener();
}

export function subscribeDebugPrefs(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => { if (e.key === KEY) { cached = null; listener(); } };
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(listener); window.removeEventListener('storage', onStorage); };
}

export function useDebugPrefs(): DebugPrefs {
  return useSyncExternalStore(subscribeDebugPrefs, getDebugPrefs, getDebugPrefs);
}

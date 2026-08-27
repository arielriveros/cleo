// The code editors' theme preference: one value shared by every code surface, held in a module-level store
// read through useSyncExternalStore. Persisted; defaults to dark.
import { useSyncExternalStore } from 'react';

export type CodeThemeName = 'light' | 'dark';

const KEY = 'cleo.codeEditor.theme'; // 'cleo.<feature>.<key>', as in Collapsable

function load(): CodeThemeName {
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

// Read once at init, not on every getSnapshot.
let current: CodeThemeName = load();
const listeners = new Set<() => void>();

export const codeThemeStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },

  // Must return a primitive: a fresh object on each call sends useSyncExternalStore into an infinite loop.
  getSnapshot(): CodeThemeName {
    return current;
  },

  set(name: CodeThemeName): void {
    if (name === current) return;
    current = name;
    try { localStorage.setItem(KEY, name); } catch { /* ignore */ }
    listeners.forEach((listener) => listener());
  },
};

/** The current code-editor theme. Re-renders the caller when any code editor changes it. */
export function useCodeTheme(): CodeThemeName {
  return useSyncExternalStore(codeThemeStore.subscribe, codeThemeStore.getSnapshot);
}

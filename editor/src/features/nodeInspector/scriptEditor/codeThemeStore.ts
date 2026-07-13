// The code editors' theme preference. One value, shared by every code surface: flipping the theme in the
// script editor also flips the GLSL editor, which plain component state cannot do — the two have no common
// ancestor short of the inspector. So this follows logStore.ts: a module-level store read through
// useSyncExternalStore.
//
// The preference is persisted; the theme itself defaults to dark, like the rest of the editor.
import { useSyncExternalStore } from 'react';
import type { CodeThemeName } from './codeMirrorTheme';

export type { CodeThemeName };

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

  // Returns a primitive, so there is no snapshot to memoize: it is returning a *fresh object* each call
  // that sends useSyncExternalStore into an infinite loop, and a string can't.
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

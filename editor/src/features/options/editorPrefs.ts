// Editor preferences: how THIS USER likes the editor to behave, on this machine, across every project —
// as opposed to project options (input map, publish defaults, engine runtime), which travel with the
// project. A module-level store read through useSyncExternalStore, persisted to localStorage, the same
// shape as codeThemeStore.
//
// Pure apart from localStorage, so the engine-facing readers (the gizmo snap, the editor camera) can read
// the current value synchronously every frame without a React render in the loop.
import { useSyncExternalStore } from 'react';

/** Where a script opens when you double-click it, press ✎ on a script slot, or create one. */
export type ScriptOpener = 'builtin' | 'vscode';

export interface EditorPrefs {
  scriptOpenWith: ScriptOpener;
  /**
   * The command the desktop shell runs to open a script folder + file: `code` (VSCode), `cursor`,
   * `codium`… Validated again on the desktop side, which only accepts a bare command name.
   */
  externalEditorCommand: string;
  /** Multiplies the editor camera's fly / pan / lift speed. */
  cameraFlySpeed: number;
  /** Multiplies the editor camera's mouse-look rate. */
  cameraLookSensitivity: number;
  /** Ctrl-held gizmo snap steps. */
  snapTranslate: number;
  snapRotateDeg: number;
  snapScale: number;
}

export const DEFAULT_EDITOR_PREFS: EditorPrefs = {
  scriptOpenWith: 'builtin',
  externalEditorCommand: 'code',
  cameraFlySpeed: 1,
  cameraLookSensitivity: 1,
  snapTranslate: 1,
  snapRotateDeg: 15,
  snapScale: 0.1,
};

const KEY = 'cleo_editor_prefs_v1';
const COMMAND = /^[\w.+-]+$/;   // the desktop side's SAFE_COMMAND

/** A stored blob read tolerantly: unknown keys dropped, bad values back to the default. */
export function parseEditorPrefs(raw: unknown): EditorPrefs {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const pos = (v: unknown, d: number, min = 1e-3, max = 1e4) =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : d;
  const d = DEFAULT_EDITOR_PREFS;
  return {
    scriptOpenWith: o.scriptOpenWith === 'vscode' ? 'vscode' : 'builtin',
    externalEditorCommand: typeof o.externalEditorCommand === 'string' && COMMAND.test(o.externalEditorCommand)
      ? o.externalEditorCommand : d.externalEditorCommand,
    cameraFlySpeed: pos(o.cameraFlySpeed, d.cameraFlySpeed, 0.05, 50),
    cameraLookSensitivity: pos(o.cameraLookSensitivity, d.cameraLookSensitivity, 0.05, 10),
    snapTranslate: pos(o.snapTranslate, d.snapTranslate),
    snapRotateDeg: pos(o.snapRotateDeg, d.snapRotateDeg, 0.1, 180),
    snapScale: pos(o.snapScale, d.snapScale),
  };
}

function load(): EditorPrefs {
  try { return parseEditorPrefs(JSON.parse(localStorage.getItem(KEY) ?? 'null')); }
  catch { return { ...DEFAULT_EDITOR_PREFS }; }
}

// Read once at init; replaced (never mutated) on every change, so the snapshot identity is stable
// between changes, which useSyncExternalStore requires.
let current: EditorPrefs = load();
const listeners = new Set<() => void>();

export const editorPrefsStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  getSnapshot(): EditorPrefs { return current; },
  set(patch: Partial<EditorPrefs>): void {
    const next = parseEditorPrefs({ ...current, ...patch });
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    current = next;
    try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* private mode: session-only */ }
    listeners.forEach(l => l());
  },
  reset(): void {
    current = { ...DEFAULT_EDITOR_PREFS };
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
    listeners.forEach(l => l());
  },
};

/** The current preferences, synchronously — for per-frame readers outside React. */
export function getEditorPrefs(): EditorPrefs { return current; }

/** The current preferences; re-renders the caller when any of them changes. */
export function useEditorPrefs(): EditorPrefs {
  return useSyncExternalStore(editorPrefsStore.subscribe, editorPrefsStore.getSnapshot);
}

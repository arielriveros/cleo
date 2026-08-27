import { createContext, useContext } from 'react';

/**
 * Per-category visibility of the viewport's debug/helper overlays, split into an independent EDITOR
 * channel (authoring) and RUNTIME channel (in-editor Play). The state lives in EngineProvider; the
 * reconcilers read it via a ref, and toggling emits DEBUG_VISIBILITY_CHANGED so they re-run.
 * Every helper is an `__editor__`/`__debug__`-named node, which buildGameData strips from any build.
 */

export type DebugCategory =
  | 'colliders'
  | 'triggers'
  | 'lights'
  | 'cameras'
  | 'probes'
  | 'boundingBoxes'
  | 'skeleton'
  | 'animation'
  | 'grid';

export type DebugChannel = 'editor' | 'runtime';

export interface DebugCategoryState { editor: boolean; runtime: boolean; }
export type DebugVisibility = Record<DebugCategory, DebugCategoryState>;

export interface DebugCategoryMeta {
  key: DebugCategory;
  label: string;
  /** False for editor-chrome that has no meaning in the running game (the reference grid). */
  runtimeAvailable: boolean;
}

/** Menu order + labels; grid last. */
export const DEBUG_CATEGORIES: DebugCategoryMeta[] = [
  { key: 'colliders', label: 'Collision wireframes', runtimeAvailable: true },
  { key: 'triggers', label: 'Trigger volumes', runtimeAvailable: true },
  { key: 'lights', label: 'Light icons', runtimeAvailable: true },
  { key: 'cameras', label: 'Camera frustums', runtimeAvailable: true },
  { key: 'probes', label: 'Light probes', runtimeAvailable: true },
  { key: 'boundingBoxes', label: 'Bounding boxes', runtimeAvailable: true },
  { key: 'skeleton', label: 'Skeletons', runtimeAvailable: true },
  // Runtime is the point of this one: a blend driven by MEASURED motion reads 0 everywhere in the editor,
  // because the editor has no physics. Play is the only place its inputs are real.
  { key: 'animation', label: 'Animation blend', runtimeAvailable: true },
  // Runtime-capable even though the grid is renderer chrome rather than a scene node: EngineContext's
  // reconcile asserts `setGridVisible` from whichever channel is in force, so Play honours this switch.
  { key: 'grid', label: 'Reference grid', runtimeAvailable: true },
];

// These categories default to Editor-on; every other overlay defaults off and is opted into. Runtime is
// off for all.
const EDITOR_ON_BY_DEFAULT = new Set<DebugCategory>(['colliders', 'triggers', 'lights', 'cameras', 'probes', 'grid']);

export function defaultDebugVisibility(): DebugVisibility {
  const out = {} as DebugVisibility;
  for (const { key } of DEBUG_CATEGORIES) out[key] = { editor: EDITOR_ON_BY_DEFAULT.has(key), runtime: false };
  return out;
}

const STORAGE_KEY = 'cleo_debug_visibility_v1';

/** Load persisted settings, filling in any category added since the blob was written. */
export function loadDebugVisibility(): DebugVisibility {
  const base = defaultDebugVisibility();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw);
    for (const { key } of DEBUG_CATEGORIES) {
      const s = saved?.[key];
      if (s && typeof s === 'object') {
        if (typeof s.editor === 'boolean') base[key].editor = s.editor;
        if (typeof s.runtime === 'boolean') base[key].runtime = s.runtime;
      }
    }
  } catch { /* corrupt blob → defaults */ }
  return base;
}

export function saveDebugVisibility(v: DebugVisibility): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(v)); } catch { /* quota/private-mode: skip */ }
}

export interface DebugVisibilityContextValue {
  visibility: DebugVisibility;
  setCategory: (key: DebugCategory, channel: DebugChannel, value: boolean) => void;
}

export const DebugVisibilityContext = createContext<DebugVisibilityContextValue | null>(null);

/** Read the debug-overlay visibility slice. Provided by EngineProvider. */
export function useDebugVisibility(): DebugVisibilityContextValue {
  const ctx = useContext(DebugVisibilityContext);
  if (!ctx) throw new Error('useDebugVisibility must be used within an EngineProvider');
  return ctx;
}

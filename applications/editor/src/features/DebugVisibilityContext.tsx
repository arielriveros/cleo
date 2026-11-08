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
  | 'icons'
  | 'boundingBoxes'
  | 'skeleton'
  | 'animation'
  | 'navMesh'
  | 'foliageColliders'
  | 'giProbes'
  | 'particles'
  | 'gameUi'
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
  // Every marker the editor draws for a node that has no look of its own: the billboards of lights,
  // sounds (and a selected spatial sound's falloff sphere), light probes, exposure volumes, decals,
  // particle systems, force fields and navmeshes, and the camera bodies. Only the icons: a selected
  // decal's or volume's box is drawn regardless, like the navmesh bake volume, since selecting the node
  // is the request to see it.
  { key: 'icons', label: 'Editor icons', runtimeAvailable: true },
  { key: 'boundingBoxes', label: 'Bounding boxes', runtimeAvailable: true },
  { key: 'skeleton', label: 'Skeletons', runtimeAvailable: true },
  // Runtime is the point of this one: a blend driven by MEASURED motion reads 0 everywhere in the editor,
  // because the editor has no physics. Play is the only place its inputs are real.
  { key: 'animation', label: 'Animation blend', runtimeAvailable: true },
  // Worth having at runtime as well as in the editor: a bake can look right standing still and be
  // wrong the moment an agent tries to cross a seam, and the overlay is how you see which.
  { key: 'navMesh', label: 'Navigation mesh', runtimeAvailable: true },
  // The colliders foliage props get in Play, drawn on the scattered instances near the camera — the same
  // disc and cap the physics uses — so a trunk collider can be checked against the trunks it stands on.
  { key: 'foliageColliders', label: 'Foliage colliders', runtimeAvailable: true },
  // Every GI Volume's probes, lit by the light each holds. Renderer chrome (asserted from EngineContext's
  // reconcile, like the grid); a selected volume shows its own probes with this off.
  { key: 'giProbes', label: 'GI probes', runtimeAvailable: true },
  // Not an overlay: whether particle systems SIMULATE while authoring, like Niagara's realtime toggle.
  // Editor only — a playing game always simulates them.
  { key: 'particles', label: 'Preview particles', runtimeAvailable: false },
  // The game's UI nodes over the viewport. Off while authoring the scene, where a HUD only hides the world
  // being edited; always on in UI mode (the subject there) and in Play (the game draws its own UI).
  { key: 'gameUi', label: 'Game UI', runtimeAvailable: false },
  // Runtime-capable even though the grid is renderer chrome rather than a scene node: EngineContext's
  // reconcile asserts `setGridVisible` from whichever channel is in force, so Play honours this switch.
  { key: 'grid', label: 'Reference grid', runtimeAvailable: true },
];

// These categories default to Editor-on; every other overlay defaults off and is opted into. Runtime is
// off for all.
const EDITOR_ON_BY_DEFAULT = new Set<DebugCategory>(['colliders', 'triggers', 'icons', 'foliageColliders', 'particles', 'grid']);

/**
 * The rows `icons` replaced, one per kind of marker. A blob saved before it has these instead: the one
 * switch is on in a channel if any of them was.
 */
const ICON_ROWS_BEFORE = ['lights', 'cameras', 'probes', 'exposureVolumes', 'decals', 'sounds', 'effects'] as const;

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
    if (saved && typeof saved === 'object' && !saved.icons) {
      const old = ICON_ROWS_BEFORE.map(k => saved[k]).filter(s => s && typeof s === 'object');
      if (old.length) {
        base.icons.editor = old.some(s => s.editor === true);
        base.icons.runtime = old.some(s => s.runtime === true);
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

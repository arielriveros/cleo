import type { Scene, Renderer, RenderSettings } from 'cleo';
import { Logger } from 'cleo';
import { buildGameData } from '../features/publish/buildGameData';
import type { ScriptAsset } from './scripts';
import { idbGet, idbSet, idbDelete } from './idb';
import { saveToStorage } from '../workers/workerClient';
import type { BodyDescription, ShapeDescription } from '../features/EngineContext';
import type { UIState } from './UIModel';

// Storage keys. The project blob lives in IndexedDB (scenes embed base64 textures and exceed the
// ~5MB localStorage quota). The dock layout lives in localStorage under its own key — see
// features/layout/DockLayout.tsx.
export const PROJECT_KEY = 'cleo_project';

// Small editor-level settings persisted alongside the scene.
export interface ProjectPrefs {
  dimension?: '2D' | '3D';
  selectedNode?: string | null;
}

// The stored blob = the runtime game data ({ scene, textures?, ui, config? }) plus editor prefs.
export interface SavedProject {
  scene: any;
  textures?: any;
  ui?: { version: number; elements: any[] };
  config?: { graphics?: { clearColor?: number[] }; render?: RenderSettings };
  prefs?: ProjectPrefs;
  savedAt?: number;
}

type EngineMaps = {
  scene: Scene;
  scripts: Map<string, string>;
  bodies: Map<string, BodyDescription>;
  triggers: Map<string, { shapes: ShapeDescription[] }>;
};

/**
 * Persist the whole project (scene + scripts/bodies/triggers + UI + editor prefs) to IndexedDB.
 * Uses the same buildGameData path as Export so textures are embedded (useCache=false).
 * Returns true on success; warns (and returns false) on failure.
 *
 * The IndexedDB write runs in the project worker, so the structured clone of a scene carrying embedded
 * base64 textures no longer lands on the main thread. buildGameData itself still does — Scene.serialize
 * reads live engine objects and encodes textures via a canvas, neither of which a worker can touch.
 */
export async function saveProject(params: {
  scene: Scene;
  scripts: Map<string, string>;
  scriptAssets?: ScriptAsset[];
  bodies: Map<string, BodyDescription>;
  triggers: Map<string, { shapes: ShapeDescription[] }>;
  ui: { version: number; elements: any[] };
  settings?: RenderSettings;
  prefs?: ProjectPrefs;
}): Promise<boolean> {
  try {
    const gameData = await buildGameData({
      scene: params.scene,
      scripts: params.scripts,
      scriptAssets: params.scriptAssets,
      bodies: params.bodies,
      triggers: params.triggers,
      ui: params.ui,
      settings: params.settings,
      // The texture payloads live in the texture store, so the project blob does NOT embed them. It used
      // to base64 every texture in the project on every save. Export and Publish still embed (useCache
      // defaults to false) because those outputs have to be self-contained.
      useCache: true,
    });
    const payload: SavedProject = { ...gameData, prefs: params.prefs, savedAt: Date.now() };
    await saveToStorage(PROJECT_KEY, payload);
    return true;
  } catch (e: any) {
    Logger.error(`Failed to save project: ${e?.message || e}`, 'Editor');
    return false;
  }
}

/** Read the saved project from IndexedDB (migrating a legacy localStorage save once), or null. */
export async function loadProject(): Promise<SavedProject | null> {
  try {
    const existing = await idbGet<SavedProject>(PROJECT_KEY);
    if (existing) return existing;
    // One-time migration of an older, smaller localStorage save into IndexedDB.
    const raw = localStorage.getItem(PROJECT_KEY);
    if (raw) {
      const migrated = JSON.parse(raw) as SavedProject;
      try { await idbSet(PROJECT_KEY, migrated); localStorage.removeItem(PROJECT_KEY); } catch { /* keep localStorage copy if migration write fails */ }
      return migrated;
    }
    return null;
  } catch {
    return null;
  }
}

/** Remove the saved project. */
export async function clearProject(): Promise<void> {
  try { await idbDelete(PROJECT_KEY); } catch { /* ignore */ }
  try { localStorage.removeItem(PROJECT_KEY); } catch { /* ignore */ }
}

/**
 * Apply a saved/imported game-data JSON into an existing scene: restore the UI, move each node's
 * script/body/trigger into the editor maps (the source of truth for Play/Publish) and strip them
 * from the tree so they don't run in edit mode, then parse the tree into the scene.
 * Shared by the Import button and startup restore.
 */
// Pull each node's script/body/trigger out of a serialized tree into the editor side-maps (the source
// of truth for Play/Publish) and strip them from the tree so they don't run in edit mode. Mutates the
// tree in place. Shared by applyGameData and the multi-scene publish path (which runs it on a temp tree
// before re-serializing a closed scene).
export function extractNodeState(root: any, maps: Pick<EngineMaps, 'scripts' | 'bodies' | 'triggers'>): void {
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.script === 'string' && node.script.trim()) maps.scripts.set(node.id, node.script);
    if (node.body) maps.bodies.set(node.id, node.body);
    if (node.trigger) maps.triggers.set(node.id, node.trigger);
    delete node.script; delete node.scripts; delete node.body; delete node.trigger;
    (node.children ?? []).forEach(visit);
  };
  visit(root);
}

export function applyGameData(json: any, deps: EngineMaps & { setUI: (s: UIState) => void; renderer?: Renderer }): void {
  if (!json) return;
  // UI (top-level `ui`, or legacy `scene.ui`).
  if (json.ui) deps.setUI({ version: json.ui.version ?? 1, elements: json.ui.elements ?? [] });
  else if (json.scene?.ui) deps.setUI({ version: json.scene.ui.version ?? 1, elements: json.scene.ui.elements ?? [] });

  // Restore the saved renderer look so the editor (and its Play mode) matches what was last saved.
  if (deps.renderer && json.config?.render) deps.renderer.applyRenderSettings(json.config.render);

  if (json.scene) extractNodeState(json.scene, deps);

  // Does this payload carry its own textures? An imported/exported scene.json does (it must be
  // self-contained); a saved project does NOT — its textures come from the texture store, preloaded into
  // the TextureManager before this runs. Scene.parse's second argument means "skip restoring textures",
  // so it is the inverse of "textures are embedded here".
  const embedded = Array.isArray(json.textures) && json.textures.length > 0;
  deps.scene.parse(json, !embedded);
}

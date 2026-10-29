import type { Scene, Renderer, RenderSettings, InputMap } from 'cleo';
import { Logger, InputSystem } from 'cleo';
import { buildGameData } from '../features/publish/buildGameData';
import type { ScriptAsset } from './scripts';
import { idbGet, idbSet, idbDelete } from './idb';
import { saveToStorage } from '../workers/workerClient';
import type { BodyDescription, ShapeDescription } from '../features/EngineContext';
import { migrateGameDataUI } from './uiMigration';

// Storage keys. The project blob must live in IndexedDB: scenes embed base64 textures and exceed the
// ~5MB localStorage quota. The dock layout has its own localStorage key — see features/layout/DockLayout.tsx.
export const PROJECT_KEY = 'cleo_project';

// Small editor-level settings persisted alongside the scene.
export interface ProjectPrefs {
  dimension?: '2D' | '3D';
  selectedNode?: string | null;
}

// The stored blob = the runtime game data ({ scene, textures?, config? }) plus editor prefs.
export interface SavedProject {
  scene: any;
  textures?: any;
  /** LEGACY, read-only: `migrateGameDataUI` reads it out of older blobs. Never written. */
  ui?: { version: number; elements: any[] };
  config?: { graphics?: { clearColor?: number[] }; render?: RenderSettings; input?: InputMap };
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
 * Persist the whole project (scene + scripts/bodies/triggers + editor prefs) to IndexedDB.
 * Returns true on success; warns and returns false on failure.
 * The IndexedDB write runs in the project worker; buildGameData cannot, since Scene.serialize reads live
 * engine objects and encodes textures via a canvas.
 */
export async function saveProject(params: {
  scene: Scene;
  scripts: Map<string, string>;
  scriptAssets?: ScriptAsset[];
  bodies: Map<string, BodyDescription>;
  triggers: Map<string, { shapes: ShapeDescription[] }>;
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
      settings: params.settings,
      // Payloads live in the texture store, so the project blob does NOT embed them. Export and Publish
      // still embed (useCache defaults to false) because those outputs must be self-contained.
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
    // One-time migration of a legacy localStorage save into IndexedDB.
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
 * Pull each node's script/body/trigger out of a serialized tree into the editor side-maps — the source of
 * truth for Play/Publish — and strip them from the tree so they do not run in edit mode.
 * Mutates the tree in place.
 */
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

/**
 * Apply a saved or imported game-data JSON into an existing scene: migrate legacy UI, move each node's
 * script/body/trigger into the editor maps, then parse the tree into the scene.
 */
export function applyGameData(json: any, deps: EngineMaps & { renderer?: Renderer }): void {
  if (!json) return;
  // Fold any legacy UI blob into real nodes BEFORE the tree is read, and drop the key.
  migrateGameDataUI(json);

  // Restore the saved renderer look so the editor and its Play mode match the last save.
  if (deps.renderer && json.config?.render) deps.renderer.applyRenderSettings(json.config.render);

  // The IMPORT/legacy path for bindings only. The live editor reads the project-scoped inputMap key
  // instead — this is what carries an input map in from an exported bundle or an older saved blob.
  if (json.config?.input) InputSystem.instance.setMap(json.config.input);

  if (json.scene) extractNodeState(json.scene, deps);

  // An imported/exported scene.json carries its own textures; a saved project does not (they come from
  // the texture store, preloaded before this runs). Scene.parse's second argument is "skip restoring
  // textures", i.e. the inverse of this flag.
  const embedded = Array.isArray(json.textures) && json.textures.length > 0;
  deps.scene.parse(json, !embedded);
}

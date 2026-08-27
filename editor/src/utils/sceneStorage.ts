import type { RenderSettings } from 'cleo';
import { Logger } from 'cleo';
import { idbGet, idbSet, idbDelete } from './idb';
import { saveToStorage } from '../workers/workerClient';
import { loadProject, ProjectPrefs } from './projectStorage';
import { cryptoRandomId } from './ids';
import { metaKey, sceneKey, scenePrefix } from './storageKeys';

// Multi-scene project storage: a small meta record (scene list, which scene is main, which was last open)
// plus one kv blob per scene. One key per scene, never a single array — a scene blob embeds full vertex
// data, so an array key rewrites every scene's megabytes on each save.
//
// The legacy single-scene blob under 'cleo_project' is migrated on first boot and left in place as a
// rollback backstop.

// Key names live in storageKeys.ts and are produced by functions, never constants. Re-exported here.
export { sceneKey, scenePrefix };

/** Asset ids a scene references, captured at save time so delete warnings can see closed scenes. */
export interface SceneRefs {
  materialIds: string[];
  modelIds: string[];
  /** Pre-rename spelling of `modelIds`, present in metas written before the mesh->model rename. */
  meshIds?: string[];
  templateIds: string[];
  terrainMaterialIds: string[];
  tilesetIds: string[];
  textureIds: string[];
}

export interface SceneMeta {
  id: string;
  name: string;
  updatedAt: number;
  thumbnail?: string;
  refs?: SceneRefs;
  /**
   * The camera rig this scene is authored with: '2D' is an orthographic pan/zoom, '3D' is free-fly.
   * Optional rather than a ProjectMeta.version bump, so it stays compatible both ways: a reader falls back
   * to ProjectPrefs.dimension and then '3D', and the next scene save persists it.
   */
  dimension?: '2D' | '3D';
}

export interface ProjectMeta {
  version: 2;
  mainSceneId: string;
  openSceneId: string;
  scenes: SceneMeta[];
  prefs?: ProjectPrefs;
}

// The per-scene blob: the buildGameData output (scripts/bodies/triggers embedded per node, textures NOT —
// they live in the texture store) plus save-time metadata.
export interface SceneAssetData {
  scene: any;
  ui?: { version: number; elements: any[] };
  config?: { graphics?: { clearColor?: number[] }; render?: RenderSettings };
  /** "kind:assetId" -> content hash of each referenced asset at save time (gates on-open resync). */
  assetHashes?: Record<string, string>;
  /** Which hashAsset format `assetHashes` was produced by. Absent = 1. See ASSET_HASH_VERSION. */
  assetHashVersion?: number;
  savedAt: number;
}

export async function loadProjectMeta(): Promise<ProjectMeta | null> {
  try {
    return await idbGet<ProjectMeta>(metaKey());
  } catch {
    return null;
  }
}

/** Meta is tiny — write it directly, no need to round-trip through the worker. */
export async function saveProjectMeta(meta: ProjectMeta): Promise<void> {
  await idbSet(metaKey(), meta);
}

export async function loadSceneData(id: string): Promise<SceneAssetData | null> {
  try {
    return await idbGet<SceneAssetData>(sceneKey(id));
  } catch {
    return null;
  }
}

/** Scene blobs are chunky — write through the project worker like the legacy project blob did. */
export async function saveSceneData(id: string, data: SceneAssetData): Promise<void> {
  await saveToStorage(sceneKey(id), data);
}

export async function deleteSceneData(id: string): Promise<void> {
  await idbDelete(sceneKey(id));
}

/**
 * One-time migration of the legacy single-scene project ('cleo_project') into the multi-scene layout: the
 * blob becomes the "Main" scene, set as both main and open. Null when there is no legacy project.
 */
export async function migrateLegacyProject(): Promise<ProjectMeta | null> {
  const legacy = await loadProject();
  if (!legacy || !legacy.scene) return null;
  const id = cryptoRandomId();
  const data: SceneAssetData = {
    scene: legacy.scene,
    ui: legacy.ui,
    config: legacy.config,
    savedAt: legacy.savedAt ?? Date.now(),
  };
  // A legacy blob may embed textures. Dropping them is safe — the original load path already registered
  // them in the TextureManager, and the texture store owns them from here on.
  await idbSet(sceneKey(id), data);
  const meta: ProjectMeta = {
    version: 2,
    mainSceneId: id,
    openSceneId: id,
    scenes: [{ id, name: 'Main', updatedAt: data.savedAt }],
    prefs: legacy.prefs,
  };
  await saveProjectMeta(meta);
  Logger.info('Migrated legacy project to multi-scene storage', 'Editor');
  return meta;
}

/** Meta for a brand-new project: a single empty "Main" scene (blob written on first save). */
export function createFreshProjectMeta(): ProjectMeta {
  const id = cryptoRandomId();
  return {
    version: 2,
    mainSceneId: id,
    openSceneId: id,
    scenes: [{ id, name: 'Main', updatedAt: Date.now() }],
  };
}

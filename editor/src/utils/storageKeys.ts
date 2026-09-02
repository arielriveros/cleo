// The one place every IndexedDB `kv` key name is written down. A key literal missed at one call site reads
// or writes the WRONG PROJECT's data with no error, so keys are produced by FUNCTIONS here and never by
// exported constants — a function can change its scoping without any call site changing.
//
// `KEYS` below holds the raw, unscoped names and is for migration passes only; everything else goes
// through the accessors, which namespace by project (projectScope).

import { scoped } from './projectScope';

/** Raw, unscoped kv key names. Only storage-level code (migration, project deletion) should read these. */
export const KEYS = {
  projectMeta: 'cleo_project_meta',
  /** Scene blobs are one key each, `cleo_scene:<id>` — see sceneStorage for why. */
  scenePrefix: 'cleo_scene:',
  vfs: 'cleo_vfs',
  /** Pre-multi-scene single blob. Deliberately never scoped: it is the rollback backstop. */
  legacyProject: 'cleo_project',
  materials: 'cleo_materials',
  terrainMaterials: 'cleo_terrain_materials',
  templates: 'cleo_templates',
  /** Pre-sharding single array of model assets. Still READ, to migrate it; never written again. */
  models: 'cleo_models',
  /** Model assets are one key each, `cleo_model:<id>` — see modelStore for why. */
  modelPrefix: 'cleo_model:',
  scripts: 'cleo_scripts',
  animationFields: 'cleo_animation_fields',
  animations: 'cleo_animations',
  tilesets: 'cleo_tilesets',
  /**
   * The two halves of the image/texture split. Metadata only — image BYTES stay in the `textures`
   * IndexedDB object store, keyed by image id (see textureStore.ts), never in these arrays.
   */
  images: 'cleo_images',
  textures: 'cleo_textures',
  /**
   * The two halves of the audio-source/sound-sample split. Metadata only — audio BYTES stay in the
   * `audio` IndexedDB object store, keyed by audio-source id (see audioStore.ts), never in these arrays.
   */
  audioSources: 'cleo_audio_sources',
  soundSamples: 'cleo_sound_samples',
  /**
   * The project's input action map. Deliberately NOT a LibName: every LibName is read as an array by
   * the bundle importer (idbGet<any[]> then append), and an object stored under one would corrupt an
   * import. Being in MIGRATABLE_KEYS is enough for project duplication and workspace migration.
   */
  inputMap: 'cleo_input_map',
} as const;

/** The asset libraries, as `usePersistedLibrary` and the bundle importer address them. */
export type LibName = 'materials' | 'terrainMaterials' | 'templates' | 'models' | 'scripts' | 'animationFields' | 'animations' | 'tilesets' | 'images' | 'textures' | 'audioSources' | 'soundSamples';

export const LIB_NAMES: readonly LibName[] = [
  'materials', 'terrainMaterials', 'templates', 'models', 'scripts', 'animationFields', 'animations', 'tilesets',
  'images', 'textures', 'audioSources', 'soundSamples',
];

/**
 * Every fixed-name key that belongs to ONE project's data.
 *
 * Scene blobs are absent on purpose — they are `<prefix><sceneId>` and have to be found with a prefix scan
 * (idbKeysByPrefix), not enumerated. `legacyProject` is absent because it is workspace-wide legacy state.
 */
export const MIGRATABLE_KEYS: readonly string[] =
  [KEYS.projectMeta, KEYS.vfs, KEYS.inputMap, ...LIB_NAMES.map(n => KEYS[n])];

// Every accessor takes an optional project id; omitted means "the open project". The two callers that pass
// one explicitly — importing a bundle into a project that is not open, and deleting one — must do so
// rather than repointing the active project, which would misroute in-flight debounced writes.

export function metaKey(projectId?: string): string {
  return scoped(KEYS.projectMeta, projectId);
}

/** `p:<project>:cleo_scene:` — the prefix a scene-blob scan (idbKeysByPrefix) must use. */
export function scenePrefix(projectId?: string): string {
  return scoped(KEYS.scenePrefix, projectId);
}

export function sceneKey(id: string, projectId?: string): string {
  return scenePrefix(projectId) + id;
}

/** `p:<project>:cleo_model:` — the prefix a model-shard scan (idbKeysByPrefix) must use. */
export function modelPrefix(projectId?: string): string {
  return scoped(KEYS.modelPrefix, projectId);
}

export function modelKey(id: string, projectId?: string): string {
  return modelPrefix(projectId) + id;
}

export function vfsKey(projectId?: string): string {
  return scoped(KEYS.vfs, projectId);
}

export function libKey(name: LibName, projectId?: string): string {
  return scoped(KEYS[name], projectId);
}

/**
 * The input action map. Project-wide, not per-scene — unlike `config.render`, which each scene carries
 * its own copy of. Two scenes disagreeing about what `Jump` is bound to would be a bug nobody could
 * explain, so bindings live at the project level and are written into a published build once.
 */
export function inputMapKey(projectId?: string): string {
  return scoped(KEYS.inputMap, projectId);
}

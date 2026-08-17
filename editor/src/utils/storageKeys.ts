// The one place every IndexedDB `kv` key name is written down.
//
// The nine key literals used to be duplicated between bundleImport's own LIB_KEYS map and inline strings at
// each usePersistedLibrary/idbGet call in EngineContext, with PROJECT_META_KEY / SCENE_KEY_PREFIX / VFS_KEY
// declared in two further modules. That was survivable while there was exactly one project — every key was a
// constant. It stops being survivable the moment keys have to carry a project id, because a literal missed in
// one call site reads or writes the WRONG PROJECT's data with no error.
//
// So keys are produced by FUNCTIONS here, never by exported constants: a function can start scoping its
// result without any call site changing. `KEYS` below holds the raw, unscoped names and is what a migration
// pass consumes; everything else goes through the accessors, which namespace by project (projectScope).

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
  models: 'cleo_models',
  scripts: 'cleo_scripts',
  animationFields: 'cleo_animation_fields',
} as const;

/** The six asset libraries, as `usePersistedLibrary` and the bundle importer address them. */
export type LibName = 'materials' | 'terrainMaterials' | 'templates' | 'models' | 'scripts' | 'animationFields';

export const LIB_NAMES: readonly LibName[] = [
  'materials', 'terrainMaterials', 'templates', 'models', 'scripts', 'animationFields',
];

/**
 * Every fixed-name key that belongs to ONE project's data.
 *
 * Scene blobs are absent on purpose — they are `<prefix><sceneId>` and have to be found with a prefix scan
 * (idbKeysByPrefix), not enumerated. `legacyProject` is absent because it is workspace-wide legacy state.
 */
export const MIGRATABLE_KEYS: readonly string[] = [KEYS.projectMeta, KEYS.vfs, ...LIB_NAMES.map(n => KEYS[n])];

// Every accessor takes an optional project id. Omitted it means "the open project", which is what all but
// two call sites want; the exceptions are importing a bundle INTO a project that is not open, and deleting
// one. Passing the id explicitly there is safer than briefly repointing the active project, which would send
// any in-flight debounced write from the old project into the new one.

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

export function vfsKey(projectId?: string): string {
  return scoped(KEYS.vfs, projectId);
}

export function libKey(name: LibName, projectId?: string): string {
  return scoped(KEYS[name], projectId);
}

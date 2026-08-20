// The project registry: what projects exist, which one is open, and how to create, switch to and delete one.
//
// A project owns EVERYTHING — its scenes, all six asset libraries, its folder layout and its texture
// payloads — under the key prefix `p:<id>:`. Nothing is shared between projects, which is why deleting one
// is a prefix sweep rather than a graph walk, and why switching is a page reload rather than a state swap.
//
// The registry itself is the only kv record that is NOT scoped: it is the thing that says which scopes exist.

import { Logger } from 'cleo';
import { idbGet, idbSet, idbDelete, idbKeysByPrefix } from './idb';
import { KEYS, MIGRATABLE_KEYS, libKey, metaKey, scenePrefix, vfsKey } from './storageKeys';
import { projectPrefix, setActiveProjectId } from './projectScope';
import { MIGRATABLE_LS_KEYS, lsKey, projectLsKeys } from './lsScope';
import { deleteProjectTextures, migrateUnscopedTextures } from './textureStore';
import { createFreshProjectMeta } from './sceneStorage';
import { EMPTY_VFS } from './vfs';
import { cryptoRandomId } from './ids';

export type ProjectRecord = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Data URL of the project's main scene thumbnail, shown on its card in the browser. */
  thumbnail?: string;
  /**
   * This project has already had its shot at the pre-multi-scene `cleo_project` blob (or was created after
   * that format died). Without it, migrateLegacyProject — which runs inside setupInitialScene, i.e. once per
   * project — would import the same legacy scene into every project the user creates.
   */
  legacyMigrated?: boolean;
  /** Set while the one-time migration of an existing install is in flight; cleared when it completes. */
  migrating?: boolean;
};

/** Registry of all projects. Unscoped — this is what defines the scopes. */
const REGISTRY_KEY = 'cleo_projects';
/**
 * The open project's id.
 *
 * localStorage because it must be readable SYNCHRONOUSLY: every scoped key is produced during render or from
 * sync module code. Mirrored into IndexedDB as well, so a browser that clears localStorage recovers the last
 * project instead of silently minting a second "Default Project" beside the user's real data.
 */
const ACTIVE_KEY = 'cleo_active_project';
/** A project whose wipe was deferred to the next boot — see deleteProject. */
const PENDING_DELETE_KEY = 'cleo_pending_project_delete';

let legacyImportAllowed = false;

/** May the open project consume the legacy single-scene `cleo_project` blob? Only the migrated one may. */
export function activeProjectAllowsLegacyImport(): boolean {
  return legacyImportAllowed;
}

export async function loadProjects(): Promise<ProjectRecord[]> {
  try {
    return (await idbGet<ProjectRecord[]>(REGISTRY_KEY)) ?? [];
  } catch {
    return [];
  }
}

export async function saveProjects(list: ProjectRecord[]): Promise<void> {
  await idbSet(REGISTRY_KEY, list);
}

async function writeActiveId(id: string): Promise<void> {
  try { localStorage.setItem(ACTIVE_KEY, id); } catch { /* ignore */ }
  try { await idbSet(ACTIVE_KEY, id); } catch { /* the localStorage copy is the authoritative one */ }
}

/** Copy every key of one project's data into another project's prefix. Used by migration and duplication. */
async function copyProjectKeys(from: string | null, toPrefix: string): Promise<void> {
  const fromPrefix = from === null ? '' : projectPrefix(from);
  for (const name of MIGRATABLE_KEYS) {
    const value = await idbGet<any>(fromPrefix + name);
    if (value !== null && value !== undefined) await idbSet(toPrefix + name, value);
  }
  for (const key of await idbKeysByPrefix(fromPrefix + KEYS.scenePrefix)) {
    // Only same-level keys: an unscoped scan would also match every project's already-scoped scene blobs.
    if (fromPrefix === '' && key.startsWith('p:')) continue;
    const value = await idbGet<any>(key);
    if (value !== null && value !== undefined) await idbSet(toPrefix + key.slice(fromPrefix.length), value);
  }
}

/** Is there pre-multi-project data sitting at the unscoped keys? */
async function hasLegacyWorkspace(): Promise<boolean> {
  if (await idbGet(KEYS.projectMeta)) return true;
  if (await idbGet(KEYS.legacyProject)) return true;
  for (const name of MIGRATABLE_KEYS) {
    const value = await idbGet<any>(name);
    if (Array.isArray(value) ? value.length > 0 : !!value) return true;
  }
  const scenes = await idbKeysByPrefix(KEYS.scenePrefix);
  return scenes.some(k => !k.startsWith('p:'));
}

/**
 * Fold an existing single-project install into the registry as "Default Project".
 *
 * Ordering is chosen so a crash is survivable: the record is written FIRST (with `migrating`), the data is
 * COPIED rather than moved, and the originals are deleted LAST. An interrupted run therefore leaves harmless
 * duplicates at the old keys, and the next boot sees `migrating` and finishes into the same project — rather
 * than leaving data that belongs to a project nothing points at.
 */
async function migrateWorkspace(existing?: ProjectRecord): Promise<ProjectRecord> {
  const now = Date.now();
  const record: ProjectRecord = existing ?? {
    id: cryptoRandomId(), name: 'Default Project', createdAt: now, updatedAt: now, migrating: true,
  };
  if (!existing) await saveProjects([...(await loadProjects()), record]);

  const prefix = projectPrefix(record.id);
  await copyProjectKeys(null, prefix);
  await migrateUnscopedTextures(prefix);
  for (const name of MIGRATABLE_LS_KEYS) {
    try {
      const value = localStorage.getItem(name);
      if (value !== null) localStorage.setItem(lsKey(name, record.id), value);
    } catch { /* ignore */ }
  }

  // Point the editor at the new home before removing the old one, so a crash between the two still boots.
  await writeActiveId(record.id);

  for (const name of MIGRATABLE_KEYS) await idbDelete(name);
  for (const key of await idbKeysByPrefix(KEYS.scenePrefix)) {
    if (!key.startsWith('p:')) await idbDelete(key);
  }
  for (const name of MIGRATABLE_LS_KEYS) {
    try { localStorage.removeItem(name); } catch { /* ignore */ }
  }

  const done = { ...record, migrating: false, updatedAt: now };
  await saveProjects((await loadProjects()).map(p => (p.id === done.id ? done : p)));
  Logger.info('Existing workspace moved into "Default Project"', 'Editor');
  return done;
}

/** Erase every trace of a project: kv keys, texture payloads, localStorage, registry entry. */
async function wipeProject(id: string): Promise<void> {
  for (const key of await idbKeysByPrefix(projectPrefix(id))) await idbDelete(key);
  await deleteProjectTextures(id);
  for (const key of projectLsKeys(id)) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }
  await saveProjects((await loadProjects()).filter(p => p.id !== id));
}

/**
 * Resolve which project to open, migrating an existing install if this is the first multi-project boot.
 *
 * Must complete before anything else touches storage — see the boot gate in app.tsx. Returns the registry
 * and the open project's id, or null when there is nothing to open (a fresh install, which lands on the
 * project launcher instead of silently creating something).
 */
export async function initProjects(): Promise<{ projects: ProjectRecord[]; activeId: string | null }> {
  // A delete that was deferred to avoid racing the editor's own debounced writers. Do it before anything can
  // read — or re-create — the keys involved.
  let pendingDelete: string | null = null;
  try { pendingDelete = localStorage.getItem(PENDING_DELETE_KEY); } catch { /* ignore */ }
  if (pendingDelete) {
    try { localStorage.removeItem(PENDING_DELETE_KEY); } catch { /* ignore */ }
    await wipeProject(pendingDelete);
    Logger.info('Deleted project', 'Editor');
  }

  let projects = await loadProjects();

  const interrupted = projects.find(p => p.migrating);
  if (interrupted) {
    const done = await migrateWorkspace(interrupted);
    projects = (await loadProjects()).map(p => (p.id === done.id ? done : p));
  } else if (!projects.length && await hasLegacyWorkspace()) {
    await migrateWorkspace();
    projects = await loadProjects();
  }

  if (!projects.length) return { projects, activeId: null };

  let activeId: string | null = null;
  try { activeId = localStorage.getItem(ACTIVE_KEY); } catch { /* ignore */ }
  if (!activeId || !projects.some(p => p.id === activeId)) activeId = await idbGet<string>(ACTIVE_KEY);
  if (!activeId || !projects.some(p => p.id === activeId)) {
    activeId = [...projects].sort((a, b) => b.updatedAt - a.updatedAt)[0].id;
  }

  setActiveProjectId(activeId);
  await writeActiveId(activeId);
  legacyImportAllowed = !projects.find(p => p.id === activeId)?.legacyMigrated;
  return { projects, activeId };
}

/** Create an empty project. Does not switch to it — the caller decides (openProject reloads). */
export async function createProject(name: string): Promise<ProjectRecord> {
  const now = Date.now();
  const record: ProjectRecord = {
    id: cryptoRandomId(),
    name: name.trim() || 'Untitled Project',
    createdAt: now,
    updatedAt: now,
    // A project born here has no business importing the pre-multi-scene blob.
    legacyMigrated: true,
  };
  const id = record.id;
  // No scene blob: setupInitialScene already handles "meta exists, blob absent" by creating an empty scene,
  // which keeps the "a project always has at least one scene" invariant without writing megabytes here.
  await idbSet(metaKey(id), createFreshProjectMeta());
  await idbSet(vfsKey(id), EMPTY_VFS);
  // The libraries tolerate a missing key, but writing them makes the project visible to a prefix scan —
  // which is what deletion and duplication walk.
  await idbSet(libKey('materials', id), []);
  await idbSet(libKey('terrainMaterials', id), []);
  await idbSet(libKey('templates', id), []);
  await idbSet(libKey('models', id), []);
  await idbSet(libKey('scripts', id), []);
  await idbSet(libKey('animationFields', id), []);
  await saveProjects([...(await loadProjects()), record]);
  return record;
}

export async function renameProject(id: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  // Metadata only. Nothing in storage is keyed by name — that is the whole point of id-based namespacing.
  await saveProjects((await loadProjects()).map(p => (p.id === id ? { ...p, name: trimmed } : p)));
}

/** Record a project's latest activity (and its cover image) for the browser's ordering and cards. */
export async function touchProject(id: string, thumbnail?: string): Promise<void> {
  const list = await loadProjects();
  if (!list.some(p => p.id === id)) return;
  await saveProjects(list.map(p => (p.id === id ? { ...p, updatedAt: Date.now(), thumbnail: thumbnail ?? p.thumbnail } : p)));
}

/** Open a project: point the pointer at it and reload. */
export async function openProject(id: string): Promise<void> {
  await writeActiveId(id);
  Logger.info('Opening project — reloading', 'Editor');
  window.location.reload();
}

/**
 * Delete a project.
 *
 * A project that is not open can be wiped immediately. The OPEN one cannot: the editor's debounced writers
 * (400 ms per asset library, 500 ms for textures) would fire after the wipe and re-create the very keys just
 * removed. So the id is parked in localStorage, the pointer is moved to another project, and the page
 * reloads — initProjects performs the wipe before anything can write again.
 */
export async function deleteProject(id: string, isActive: boolean): Promise<void> {
  if (!isActive) {
    await wipeProject(id);
    return;
  }
  const remaining = (await loadProjects()).filter(p => p.id !== id);
  const next = remaining.length
    ? [...remaining].sort((a, b) => b.updatedAt - a.updatedAt)[0]
    : await createProject('Untitled Project');
  try { localStorage.setItem(PENDING_DELETE_KEY, id); } catch { /* ignore */ }
  await openProject(next.id);
}

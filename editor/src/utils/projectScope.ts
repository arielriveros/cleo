// Which project the editor is currently working in, and the key prefix that isolates its data.
//
// Deliberately a module singleton rather than React state. The consumers are `utils/*` modules and
// render-time code — `sceneKey()`, `vfsKey()`, the six library keys passed to usePersistedLibrary — none of
// which can await anything. Making the active project asynchronous would turn every key producer into a
// promise, which is a far larger change than the feature itself.
//
// It is set exactly once, by initProjects(), before <EngineProvider> is mounted (see the boot gate in
// app.tsx). Switching projects is a page reload, not a reassignment: TextureManager, the IndexedDB handle,
// the log/progress stores, the engine and the dockview tree are all module-level state that a live swap
// would have to unpick.

let activeId = '';

export function setActiveProjectId(id: string): void {
  activeId = id;
}

export function activeProjectId(): string {
  return activeId;
}

/** The key prefix owning one project's data. Everything under it dies together when it is deleted. */
export function projectPrefix(id: string = activeId): string {
  return `p:${id}:`;
}

/**
 * Namespace a storage key to a project.
 *
 * THROWS when no project is open, on purpose. The alternative is a silent write to `p::cleo_materials` — a
 * shared, invisible bucket that every project would read from and none would own. A hard failure here means
 * "something read storage before the boot gate ran", which is a bug with one correct fix.
 */
export function scoped(key: string, id: string = activeId): string {
  if (!id) throw new Error(`Cleo storage key "${key}" was requested before a project was opened`);
  return projectPrefix(id) + key;
}

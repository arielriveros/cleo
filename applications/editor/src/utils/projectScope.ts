// Which project the editor is currently working in, and the key prefix that isolates its data.
//
// A module singleton, not React state: the consumers are `utils/*` key producers called from render-time
// code, none of which can await. Set only by utils/projects.ts activateProject: at boot, before
// <EngineProvider> mounts (the boot gate in app.tsx), and when another project opens in the running editor
// (features/projects/projectSwitch.ts) — then only once the last project's providers are unmounted and its
// writes drained (utils/projectLifecycle.ts), so a write computing its key late still names its own project.

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
 * THROWS when no project is open: the alternative is a silent write to `p::cleo_materials`, a shared
 * bucket every project reads from and none owns. A throw here means storage was touched before the boot gate.
 */
export function scoped(key: string, id: string = activeId): string {
  if (!id) throw new Error(`Cleo storage key "${key}" was requested before a project was opened`);
  return projectPrefix(id) + key;
}

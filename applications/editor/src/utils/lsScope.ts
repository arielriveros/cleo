// Project-scoped localStorage keys. Only what belongs to the PROJECT (panel layout, open documents) goes
// through here; what belongs to the PERSON (themes, collapsed sections, debug flags) does not.
//
// The project id is a PREFIX, never a suffix, so deleting a project is one sweep over `localStorage` for
// keys starting with `p:<id>:` and needs no inventory of key names.

import { projectPrefix, scoped } from './projectScope';

/** Per-project localStorage key names, unprefixed. */
export const LS_KEYS = {
  dockLayout: 'cleo_dock_layout_v5',
  dockBottomTab: 'cleo_dock_bottom_tab',
  editorTabs: 'cleo_editor_tabs_v1',
} as const;

/** The names above, for the migration that moves an existing install's keys under its Default Project. */
export const MIGRATABLE_LS_KEYS: readonly string[] = Object.values(LS_KEYS);

// Via `scoped`, so this THROWS rather than writing to a shared `p::` bucket when no project is open.
export function lsKey(name: string, projectId?: string): string {
  return scoped(name, projectId);
}

/** Every stored key belonging to a project — the delete sweep. */
export function projectLsKeys(projectId: string): string[] {
  const prefix = projectPrefix(projectId);
  const out: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) out.push(key);
    }
  } catch { /* ignore */ }
  return out;
}

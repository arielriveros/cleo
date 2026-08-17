// Project-scoped localStorage keys.
//
// Some of what the editor keeps in localStorage is a property of the PERSON (code-editor theme, which
// inspector sections they leave collapsed, debug flags) and some is a property of the PROJECT (the panel
// layout, which documents were open). Only the second kind goes through here.
//
// The project id is a PREFIX, not a suffix, so deleting a project is one sweep over `localStorage` for keys
// starting with `p:<id>:` — no inventory of key names to keep in sync with whoever adds the next one.

import { projectPrefix, scoped } from './projectScope';

/** Per-project localStorage key names, unprefixed. */
export const LS_KEYS = {
  dockLayout: 'cleo_dock_layout_v5',
  dockBottomTab: 'cleo_dock_bottom_tab',
  editorTabs: 'cleo_editor_tabs_v1',
} as const;

/** The names above, for the migration that moves an existing install's keys under its Default Project. */
export const MIGRATABLE_LS_KEYS: readonly string[] = Object.values(LS_KEYS);

// Via `scoped`, so this throws rather than writing to a shared `p::` bucket if it is ever reached before a
// project is open. Every caller lives inside the boot gate, so that should be unreachable — but a layout or
// session bleeding between projects is exactly the kind of bug that would go unnoticed for a long time.
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

// Where the editor's Play keeps a game's saves: IndexedDB 'cleo-play-saves' on the editor's origin, one
// namespace per project. Play in the editor and Play in window share it (both run on this origin), and the
// Saves panel reads it. A database of its own, never the editor's 'cleo': a game page must not hold the
// project's database open, and wiping Play saves must never touch a project.
//
// Imports nothing but 'cleo': the Play-in-window game page (player/session.tsx) uses it too.

import { createIndexedDbSaveStore, type SaveStore } from 'cleo';

export const PLAY_SAVES_DB = 'cleo-play-saves';

/** The store a project's Play saves live in. Every write and delete is announced on 'cleo-saves'. */
export function playSaveStore(projectId: string): SaveStore {
  return createIndexedDbSaveStore({ dbName: PLAY_SAVES_DB, namespace: projectId || 'project', notify: true });
}

/** Delete every Play save a project made (the project is being deleted). */
export async function deleteProjectPlaySaves(projectId: string): Promise<void> {
  if (!projectId) return;
  const store = playSaveStore(projectId);
  for (const save of await store.list()) await store.delete(save.slot);
}

/** What the editor tells a Play-in-window game about saving, in its pack's `config.playSaves`. */
export interface PlaySavesConfig {
  /** The project, whose Play saves the game reads and writes. */
  namespace: string;
  /** Start from this save instead of a fresh game (Saves ▸ Play from save). */
  fromSlot?: string;
}

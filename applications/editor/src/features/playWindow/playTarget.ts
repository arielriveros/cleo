// Where Play runs: in the editor's viewport (the editor's own process), or in a window of its own (its own
// process — see playWindowController.ts). A property of the machine and of how this person works, not of
// the project, so it lives in localStorage beside the other per-machine choices and never in a project file.

import { useSyncExternalStore } from 'react'

export type PlayTarget = 'editor' | 'window'

const KEY = 'cleo_play_target'
const listeners = new Set<() => void>()

/** The stored target; 'editor' when nothing (or something unknown) is stored. */
export function readPlayTarget(): PlayTarget {
  try {
    return localStorage.getItem(KEY) === 'window' ? 'window' : 'editor'
  } catch {
    return 'editor'
  }
}

export function writePlayTarget(target: PlayTarget): void {
  try {
    // Only the non-default is stored, so going back to "in editor" also clears the key.
    if (target === 'editor') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, target)
  } catch { /* no storage: the choice lasts until reload */ }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  // Another editor tab on this origin changing it.
  const onStorage = (e: StorageEvent) => { if (e.key === KEY) listener() }
  window.addEventListener('storage', onStorage)
  return () => { listeners.delete(listener); window.removeEventListener('storage', onStorage) }
}

export function usePlayTarget(): PlayTarget {
  return useSyncExternalStore(subscribe, readPlayTarget, () => 'editor' as PlayTarget)
}

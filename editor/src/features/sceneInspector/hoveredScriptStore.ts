import { useSyncExternalStore } from 'react'

// Shared "which script is being hovered" state, so hovering one node's script icon (or a script asset card
// in the Assets explorer) can tint every node icon that references the SAME script asset light-blue. A tiny
// external store rather than context: both the scene tree and the assets explorer read it, and it changes on
// pointer move — keeping it out of React state avoids re-rendering their providers on every hover.

let hovered: string | null = null
const listeners = new Set<() => void>()

export const hoveredScriptStore = {
  get: (): string | null => hovered,
  set: (id: string | null): void => {
    if (hovered === id) return
    hovered = id
    listeners.forEach(l => l())
  },
  subscribe: (l: () => void): (() => void) => {
    listeners.add(l)
    return () => { listeners.delete(l) }
  },
}

/** The script asset id currently hovered anywhere (scene tree icon or Assets card), or null. */
export function useHoveredScript(): string | null {
  return useSyncExternalStore(hoveredScriptStore.subscribe, hoveredScriptStore.get, () => null)
}

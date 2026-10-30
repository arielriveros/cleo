import { useSyncExternalStore } from 'react'

// Shared "which script is being hovered" state, so hovering one node's script icon (or a script asset card
// in the Assets explorer) tints every node icon referencing the SAME script asset. An external store rather
// than context: it changes on pointer move, and React state would re-render both providers every hover.

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

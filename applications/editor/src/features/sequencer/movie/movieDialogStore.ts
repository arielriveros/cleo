// Whether the Render Movie dialog is open. A store rather than the Sequencer panel's own state: the render
// switches to the scene tab (Play's session), which hides the panel, and the dialog must outlive that.
// RenderMovieHost (mounted once, in Editor.tsx) shows it.

import { useSyncExternalStore } from 'react'

let open = false
const listeners = new Set<() => void>()
const publish = () => { for (const l of listeners) l() }

export function openRenderMovie(): void { if (!open) { open = true; publish() } }
export function closeRenderMovie(): void { if (open) { open = false; publish() } }

export function useRenderMovieOpen(): boolean {
  return useSyncExternalStore(
    l => { listeners.add(l); return () => { listeners.delete(l) } },
    () => open,
  )
}

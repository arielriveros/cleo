// What Play's fullscreen takes. A module of its own with no imports, so what reads it (the viewport panel, the tests)
// does not load the UI kit, and through it the whole engine, to get a string and a lookup.

/**
 * Marks the element Play goes fullscreen with: the viewport panel, holding the engine's canvas AND what is drawn
 * over it as DOM (the game UI, the touch controls). Fullscreen shows only the fullscreen element's subtree, so
 * the canvas's own wrapper alone would leave the HUD behind.
 */
export const PLAY_SURFACE_ATTR = 'data-cleo-play-surface'

/** What goes fullscreen for the viewport `el`: the play surface round it, else `el` itself. */
export function playFullscreenTarget<T extends { closest(selector: string): unknown }>(el: T): T {
  return (el.closest(`[${PLAY_SURFACE_ATTR}]`) as T | null) ?? el
}

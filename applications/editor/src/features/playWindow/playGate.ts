// When Play and Simulate may START a game: only once the project is open.
//
// Opening a project reloads the page, and until the project's scene is parsed into it the editor's scene is
// the bare boot scene (the root, nothing else); a scene switch swaps it the same way. A game started then
// plays that scene under no id: Play in window's "Scene" with one node. A game already running is never
// held here: resuming, continuing, pausing and stopping it go on as usual.

export interface PlayGateState {
  /** The engine's `isSceneReady`: the project's first scene parse has run. */
  sceneReady: boolean
  /** The open scene's id: '' until the project's scene list is read. */
  openSceneId: string
  /** The load on screen, if any: the boot, a scene opening, an import, an example install. */
  load: { title: string; finished: boolean } | null
}

/** Why a new game cannot start now, as a tooltip, or null when it can. */
export function playBlockedReason({ sceneReady, openSceneId, load }: PlayGateState): string | null {
  if (!sceneReady || !openSceneId) return 'The project is still opening'
  // "Opening "Crypt"", "Reading game.cleo", "Installing The Valley": Play is back once it is done.
  if (load && !load.finished) return `${load.title.replace(/…$/, '')}: Play is available once it is done`
  return null
}

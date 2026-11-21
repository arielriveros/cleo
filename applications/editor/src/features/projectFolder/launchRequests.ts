// A launch that asked to PLAY the project it opens (`npm run play` / `npm run debug` starting the editor):
// kept until the project has loaded, then taken by the command host that starts Play in window.

export interface LaunchPlayRequest { id: string; play: boolean; debug: boolean }

let pending: LaunchPlayRequest | null = null
const listeners = new Set<() => void>()

export function setLaunchPlayRequest(request: LaunchPlayRequest): void {
  if (!request.play && !request.debug) return
  pending = request
  for (const fn of listeners) fn()
}

/** The request for project `id`, once: a request for another project stays for that one. */
export function takeLaunchPlayRequest(id: string): LaunchPlayRequest | null {
  if (!pending || pending.id !== id) return null
  const r = pending
  pending = null
  return r
}

export function onLaunchPlayRequest(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

// A module store that lets an edit made in an external IDE reach an already-open Monaco script tab.
// It cannot go through props: MonacoScriptEditor is uncontrolled and builds its model once from
// `initialSource`, so it subscribes to the revision counter here and replaces its model when bumped.

type Listener = () => void

const listeners = new Set<Listener>()
const sources = new Map<string, string>()
let revision = 0

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The counter is the snapshot: useSyncExternalStore needs a stable, comparable value. */
export function getRevision(): number {
  return revision
}

/** The last source pushed in from outside for this script, if any. */
export function externalSourceOf(scriptId: string): string | undefined {
  return sources.get(scriptId)
}

/** Publish a source that arrived from the workspace folder, waking any open editor for that script. */
export function pushExternalSource(scriptId: string, source: string): void {
  sources.set(scriptId, source)
  revision++
  for (const listener of listeners) listener()
}

/** Drop a script's pending external source once an editor has taken it (or the script is gone). */
export function clearExternalSource(scriptId: string): void {
  sources.delete(scriptId)
}

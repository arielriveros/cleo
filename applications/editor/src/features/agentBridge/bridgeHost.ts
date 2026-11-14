import type { Node, Scene } from 'cleo'
import type { useCleoEngine } from '../EngineContext'
import type { useHistory } from '../HistoryContext'
import { resolveNodeRef } from './nodeRefs'
import { round } from './inspect'

// What every agent command stands on: the editor it acts in, and the checks and waits they share. Each
// command reads the editor through `getHost()`, which returns the LATEST render's context, never a closure
// from when the link opened: library arrays are React state, and a command that waited (a capture, a Play
// start, a tab switch) must see what changed meanwhile.

export interface BridgeHost {
  engine: ReturnType<typeof useCleoEngine>
  history: ReturnType<typeof useHistory>
}
export type GetHost = () => BridgeHost

export type { CommandResult } from './bridgeClient'

/** The agent cancelled the call (Esc in Claude Code): the command stopped where it was. */
export class CancelledError extends Error {
  constructor(what = 'The call') { super(`${what} was cancelled by the agent.`) }
}

export function throwIfAborted(signal: AbortSignal | undefined, what?: string): void {
  if (signal?.aborted) throw new CancelledError(what)
}

export function ready(getHost: GetHost): BridgeHost {
  const h = getHost()
  if (!h.engine.instance || !h.engine.isSceneReady)
    throw new Error('The editor is still loading the project; try again in a few seconds.')
  return h
}

/** What reads look at: the running game during Play/Simulate, the active tab's scene otherwise. */
export function readScene(h: BridgeHost): Scene {
  return h.engine.isPlayMode && h.engine.instance ? h.engine.instance.scene : h.engine.editorScene
}

/**
 * The tabs whose scene is the document they edit: the open scene, a template's nodes, a model's. Every other
 * tab shows a throwaway preview (a material on a sphere, a clip on a character) or no viewport at all, and
 * its `editorScene` is that preview or the hidden main scene: an edit there is lost or lands unseen.
 */
const EDITABLE_TABS = new Set(['scene', 'template', 'model'])

/** What edits change. Never the play scene (Stop throws it away), nor a preview tab's staging scene. */
export function editScene(h: BridgeHost): Scene {
  if (h.engine.isPlayMode)
    throw new Error('The game is running, and edits to it are discarded on Stop. Call play_control {"action":"stop"} first.')
  const tab = h.engine.activeTab
  // A Sequencer tab shows the open scene but keys property changes into its sequence; an edit from here would
  // bypass that and change the scene without it being recorded anywhere.
  if (tab?.kind === 'sequence')
    throw new Error('A Sequencer tab is active: it keys changes rather than editing the scene. Switch first: workspace {"action":"switchTab","tab":"scene"}.')
  if (tab && !EDITABLE_TABS.has(tab.kind))
    throw new Error(`The active tab is the ${tab.kind} "${tab.title}", whose viewport is a preview, not a document: an edit there `
      + 'would be lost. Switch first: workspace {"action":"switchTab","tab":"scene"} (or open a template or model with workspace openAsset).')
  return h.engine.editorScene
}

/** The scene tab is active (in any of its sub-modes): where a placed template instance is read-only. */
export function inSceneTab(h: BridgeHost): boolean {
  return (h.engine.activeTab?.kind ?? 'scene') === 'scene'
}

export const sleep = (ms: number) => new Promise<void>(r => window.setTimeout(r, ms))

/** Wait for `test` to hold, polling every 50 ms; throws after `ms`, or when the agent cancels. */
export async function until(test: () => boolean, ms: number, what: string, signal?: AbortSignal): Promise<void> {
  const end = Date.now() + ms
  while (!test()) {
    throwIfAborted(signal)
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`)
    await sleep(50)
  }
}

export function byName<T extends { name: string }>(list: readonly T[], name: string): T | undefined {
  return list.find(x => x.name === name) ?? list.find(x => x.name.toLowerCase() === name.toLowerCase())
}

export function notFound(kind: string, name: string, list: readonly { name: string }[]): Error {
  const names = list.map(x => `"${x.name}"`).slice(0, 30).join(', ')
  return new Error(`No ${kind} named "${name}". ${list.length ? `Available: ${names}${list.length > 30 ? ', …' : ''}.` : `The project has none.`}`)
}

export const vec = (v: ArrayLike<number>) => Array.from(v, x => round(x))

/** A node ref in `scene`; "@selected" is the editor's selection (taken now unless the caller fixed it). */
export function refIn(h: BridgeHost, scene: Scene, ref: string, aliases?: ReadonlyMap<string, Node>, selectedId: string | null = h.engine.selectedNode): Node {
  return resolveNodeRef(scene, ref, aliases, selectedId)
}

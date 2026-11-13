import { emptySequence, parseSequence } from 'cleo'
import type { Node, Scene, SequenceData, SequenceNode } from 'cleo'
import { cryptoRandomId } from './ids'

/**
 * A SEQUENCE asset (`.sequence`): a named, reusable cinematic timeline — the engine's `SequenceData` with an id
 * and a name, so the library, the explorer, the Sequencer tab and Sequence nodes can address it.
 *
 * ## Embedded, not referenced
 *
 * Same model as particle systems (utils/particleSystems.ts): `SequenceNode.sequence` stays what plays, a full
 * copy, and `sequenceId` records which asset it mirrors. A published game therefore plays the copy inside the
 * serialized scene and ships no sequence library. {@link reembedSequences} carries a saved edit out to the
 * nodes that hold an older copy; opening or publishing a scene does the same through `resyncScene`.
 */
export interface SequenceAsset {
  id: string
  name: string
  sequence: SequenceData
}

/**
 * Name of the editor-owned Sequence node a Sequencer tab previews through. The `__editor__` marker keeps it out
 * of the Scene panel, saves, undo and dirty tracking. It never carries a `sequenceId`, so neither re-embedding
 * nor the referenced-asset collectors take it for a link.
 */
export const SEQUENCE_PREVIEW_NODE_NAME = '__editor__SequencePreview'

/** A new asset. `sequence` is COPIED (through the tolerant parser), never adopted. */
export function buildSequenceAsset(name = 'New Sequence', sequence?: SequenceData): SequenceAsset {
  const data = sequence ? parseSequence(structuredClone(sequence)) : emptySequence(name)
  data.name = name
  return { id: cryptoRandomId(), name, sequence: data }
}

/** A stored asset read back through the engine's parser, sharing nothing with the library. */
export function toRuntimeSequence(asset: SequenceAsset): SequenceData {
  const data = parseSequence(structuredClone(asset.sequence))
  data.name = asset.name
  return data
}

/** The user's Sequence nodes in a live scene: never the Sequencer's own preview node. */
export function sequenceNodesOf(scene: Scene | null | undefined): SequenceNode[] {
  if (!scene) return []
  return Array.from(scene.sequences ?? []).filter(n => !(n as Node).isEditorOwned) as SequenceNode[]
}

/**
 * Push the library into every linked Sequence node of a live scene, so a saved edit reaches the nodes that
 * embedded an older copy. Returns how many changed (compared by value, so an identical copy is left alone and
 * nothing is marked unsaved for it).
 */
export function reembedSequences(scene: Scene | null | undefined, assets: SequenceAsset[]): number {
  let count = 0
  for (const node of sequenceNodesOf(scene)) {
    const id = node.sequenceId
    if (!id) continue
    const asset = assets.find(a => a.id === id)
    if (!asset) continue
    const next = toRuntimeSequence(asset)
    if (JSON.stringify(node.sequence) === JSON.stringify(next)) continue
    node.sequence = next
    count++
  }
  return count
}

/**
 * Clear every link to a deleted asset. The embedded copy stays: deleting a library entry must not blank a
 * cinematic the scene still plays.
 */
export function detachSequence(scene: Scene | null | undefined, id: string): boolean {
  let changed = false
  for (const node of sequenceNodesOf(scene)) {
    if (node.sequenceId !== id) continue
    node.sequenceId = null
    changed = true
  }
  return changed
}

/** Sequence ASSET ids a live scene's nodes link. */
export function sequenceIdsInScene(scene: Scene | null | undefined): Set<string> {
  const ids = new Set<string>()
  for (const node of sequenceNodesOf(scene)) if (node.sequenceId) ids.add(node.sequenceId)
  return ids
}

/** The first of a scene's Sequence nodes that links `id`, the node a Sequencer tab takes bindings from. */
export function firstNodeLinking(scene: Scene | null | undefined, id: string): SequenceNode | null {
  return sequenceNodesOf(scene).find(n => n.sequenceId === id) ?? null
}

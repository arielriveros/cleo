import { subtreeOf, topMostIds, type VfsEntry, type VfsIndex } from '../../utils/vfs'
import type { DialogOptions } from '../dialogs/dialogStore'

// The decision half of the asset explorer's delete, extracted from useFileManagerBridge's SVAR
// interceptor so it can be tested without a file manager, a VfsProvider or a DOM.
//
// It matters that this is pure and idempotent: the interceptor is SYNCHRONOUS and the confirmation is
// not, so a delete that needs confirming is cancelled outright and re-issued after the user answers.
// The second pass carries `skipProvider`, which returns from the interceptor's first line — so whatever
// this produced on pass one has to still be valid on pass two.

export interface DeletePlan {
  /** Top-most, resolvable ids only — the batch actually safe to hand to SVAR. */
  ids: string[]
  /** Every vfs entry under `ids`, i.e. everything whose asset must be deleted. */
  entries: VfsEntry[]
  /** The subset still referenced by something in the project. */
  inUse: VfsEntry[]
}

/**
 * Everything the interceptor decides before it touches React or the SVAR store.
 *
 * `resolves` filters to ids the tree can still dereference: DataTree.remove purges a folder's subtree
 * from the id pool then dereferences `_pool.get(nextId)` blind, so an unresolvable id throws and
 * half-applies the batch. `topMostIds` drops anything nested under another member for the same reason.
 */
export function planDelete(
  vfs: VfsIndex,
  rawIds: unknown,
  resolves: (id: string) => boolean,
  isReferenced: (entry: VfsEntry) => boolean,
): DeletePlan {
  const ids = topMostIds(Array.isArray(rawIds) ? rawIds : []).filter(resolves)
  if (!ids.length) return { ids, entries: [], inUse: [] }
  const { entries } = subtreeOf(vfs, ids)
  return { ids, entries, inUse: entries.filter(isReferenced) }
}

/**
 * The confirmation for a batch that is still referenced. The whole list, unlike the window.confirm
 * string this replaces, which had to stop at six and append "…and N more".
 *
 * `describe` is injected rather than imported so this module stays free of assetKinds, which reaches
 * CleoEngine and the GL thumbnail renderers and cannot be loaded by the node test suite.
 */
export function inUseDialogOptions(
  inUse: VfsEntry[],
  describe: (entry: VfsEntry) => string,
): DialogOptions {
  const one = inUse.length === 1
  return {
    title: one ? 'This asset is still in use' : `${inUse.length} of these assets are still in use`,
    message: one ? 'Deleting it cannot be undone.' : 'Deleting them cannot be undone.',
    details: inUse.map(describe),
    confirmLabel: 'Delete anyway',
    tone: 'danger',
  }
}

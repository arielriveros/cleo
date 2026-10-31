// Keeping a SVAR file manager's store in step with a tree the app owns.
//
// SVAR re-initialises its store (collapsing every open folder) whenever its `data` prop changes, so an
// explorer passes `data` ONCE, at mount, and pushes every later change through the store's own actions.
// That diff is here, shared by the editor's asset explorer and the Creator's library explorer.

import { useEffect, useRef } from 'react'
import type { IApi } from '@svar-ui/react-filemanager'
import { Logger } from 'cleo'
import { ancestorsOf, baseOf, dirOf, topMostIds } from './paths'

/** One node of the tree as the file manager takes it: folders first, shallowest first, never '/'. */
export type FmEntity = { id: string; type: 'file' | 'folder'; date?: Date; size?: number }

/**
 * Run a store action without letting a failure escape.
 * `api.exec` is async, so a throw inside a handler surfaces as an unhandled rejection rather than at the
 * call site; for `delete-files` that leaves SVAR's tree half-mutated. Both shapes are caught here.
 */
export function safeExec(api: IApi, action: string, cfg: any): void {
  try {
    const result = api.exec(action as any, cfg) as unknown
    if (result && typeof (result as Promise<unknown>).catch === 'function') {
      (result as Promise<unknown>).catch(err =>
        Logger.error(`Asset explorer: "${action}" failed — ${err}`, 'Editor'))
    }
  } catch (err) {
    Logger.error(`Asset explorer: "${action}" failed — ${err}`, 'Editor')
  }
}

/**
 * Push changes the explorer didn't make into SVAR's tree. Diffing against the live tree rather than
 * re-passing `data` keeps the sidebar's open folders and the current path intact.
 *
 * `fingerprint` names a file's thumbnail (any string that changes when it is re-rendered): SVAR memoizes a
 * card's preview against the entity object's identity, so a changed thumbnail swaps the entity out.
 */
export function useSyncTreeToStore(
  apiRef: React.MutableRefObject<IApi | null>,
  want: FmEntity[],
  fingerprint?: (id: string) => string | undefined,
): void {
  const thumbsRef = useRef(new Map<string, string>())
  const fingerprintRef = useRef(fingerprint)
  fingerprintRef.current = fingerprint

  useEffect(() => {
    const api = apiRef.current
    if (!api) return

    let have = new Set((api.serialize('/') ?? []).map(e => e.id))

    const create = (id: string, file: Record<string, unknown>) => {
      // A node `getFile` resolves but `serialize` never listed is an orphan in SVAR's id pool; creating
      // over it renames ours to '<name>.new' and loops create/delete forever. Reclaim it instead.
      if (api.getFile(id)) safeExec(api, 'delete-files', { ids: [id], skipProvider: true })

      const cfg: any = { file, parent: dirOf(id), skipProvider: true }
      safeExec(api, 'create-file', cfg)
      if (cfg.newId && cfg.newId !== id)
        Logger.warn(`Asset explorer: "${id}" collided in the tree and landed on "${cfg.newId}"`, 'Editor')
      have.add(cfg.newId ?? id)
    }

    // FileTree.add dereferences the parent with no guard (`byId(parent).data`), so a file whose folder is
    // not in the tree throws. Create the ancestors on the spot.
    const ensureFolders = (id: string) => {
      for (const folder of ancestorsOf(id)) {
        if (have.has(folder)) continue
        create(folder, { name: baseOf(folder), type: 'folder' })
      }
    }

    const add = (e: FmEntity) => {
      ensureFolders(e.id)
      if (have.has(e.id)) return
      create(e.id, { name: baseOf(e.id), type: e.type, size: e.size, date: e.date })
    }

    for (const e of want.filter(e => !have.has(e.id))) add(e)

    // A folder holding something in `want` is wanted too even when the index forgot to list it, or the
    // sweep below deletes the parent of the files this pass just created.
    const wanted = new Set([...want.map(e => e.id), ...want.flatMap(e => ancestorsOf(e.id))])
    // Top-most, still-resolvable ids only: DataTree.remove purges a folder's subtree from its pool, then
    // dereferences the next id blind.
    const stale = topMostIds(Array.from(have).filter(id => !wanted.has(id))).filter(id => !!api.getFile(id))
    if (stale.length) {
      safeExec(api, 'delete-files', { ids: stale, skipProvider: true })
      have = new Set((api.serialize('/') ?? []).map(e => e.id)) // subtrees went with their folders
    }

    const thumbs = thumbsRef.current
    const fp = fingerprintRef.current
    if (fp) {
      for (const e of want) {
        if (e.type !== 'file') continue
        const print = fp(e.id)
        if (print === undefined) continue
        const previous = thumbs.get(e.id)
        thumbs.set(e.id, print)
        if (previous !== undefined && previous !== print && have.has(e.id)) {
          if (api.getFile(e.id)) safeExec(api, 'delete-files', { ids: [e.id], skipProvider: true })
          have.delete(e.id)
          add(e)
        }
      }
    }
    for (const id of Array.from(thumbs.keys())) if (!wanted.has(id)) thumbs.delete(id)
  }, [apiRef, want])
}

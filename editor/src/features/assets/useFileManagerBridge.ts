import { useCallback, useEffect, useRef } from 'react'
import type { IApi } from '@svar-ui/react-filemanager'
import { Logger } from 'cleo'
import { startTask, StepStatus } from '../progress/progressStore'
import { useCleoEngine } from '../EngineContext'
import { useVfs } from './VfsContext'
import {
  applyCreateFolder, applyDelete, applyMoveOne, applyMoves, buildFileManagerData,
  ancestorsOf, baseOf, dirOf, ensureExt, remapSubtree, stemOf, subtreeOf, topMostIds,
  withAncestors, VfsEntry, VfsIndex,
} from '../../utils/vfs'
import {
  deleteAsset, deleteConsequence, duplicateAsset, openAsset, regenerateThumbnail, renameAsset, thumbnailOf,
} from './assetKinds'
import {
  collectReferencedMaterialIds, collectReferencedModelIds, collectReferencedTemplateIds,
  collectReferencedTerrainMaterialIds, collectReferencedTextureIds, collectReferencedScriptIds,
  collectReferencedAnimationFieldIds,
  collectReferencedTilesetIds,
} from '../../utils/references'

export const FM_MODE_KEY = 'cleo_assets_view_mode'

// Bridges the SVAR file manager's actions onto the asset libraries.
// The tree is uncontrolled: re-passing `data` calls store.init() and collapses every open folder.
// intercept() runs before the store mutates; on() runs after and is the only place `newId`/`newIds` exist
// (SVAR dedupes colliding names by appending '.new').

export function useFileManagerBridge() {
  const { mainScene, instance } = useCleoEngine()
  const { vfs, setVfs, libs, pathIndexRef, landingFolderRef, depsRef } = useVfs()

  const apiRef = useRef<IApi | null>(null)
  const vfsRef = useRef<VfsIndex>(vfs)
  vfsRef.current = vfs
  const libsRef = useRef(libs)
  libsRef.current = libs
  const sceneRef = useRef(mainScene)
  sceneRef.current = mainScene
  const engineRef = useRef(instance)
  engineRef.current = instance
  const refreshingRef = useRef(false)

  /**
   * Re-render the thumbnail of every asset shown in `folder` (the breadcrumb refresh button).
   * Sequential: each capture drives the shared renderer, and `depsRef.current` must carry the previous
   * iteration's write before the next one reads it.
   */
  const refreshFolderThumbnails = useCallback(async (folder: string) => {
    const engine = engineRef.current
    if (!engine || !folder || refreshingRef.current) return

    const targets = vfsRef.current.entries.filter(e =>
      dirOf(e.path) === folder && (e.kind === 'material' || e.kind === 'terrainMaterial' || e.kind === 'model'))
    if (!targets.length) return

    refreshingRef.current = true

    const task = startTask({
      title: 'Refreshing thumbnails',
      steps: targets.map(e => ({ name: baseOf(e.path), status: 'pending' as StepStatus })),
      cancellable: true,
    })

    let done = 0
    try {
      for (let i = 0; i < targets.length; i++) {
        const entry = targets[i]
        if (task.cancelled) { task.setStep(i, { status: 'skipped', detail: 'Cancelled' }); continue }

        task.setStep(i, { status: 'running', detail: 'Rendering preview' })
        try {
          if (await regenerateThumbnail(entry.kind, entry.assetId, engine, depsRef.current)) {
            done++
            task.setStep(i, { status: 'done' })
          } else {
            task.setStep(i, { status: 'skipped', detail: 'Nothing to render' })
          }
        } catch (err) {
          Logger.error(`Could not refresh the thumbnail for ${baseOf(entry.path)}: ${err}`, 'Editor')
          task.setStep(i, { status: 'failed', error: String(err) })
        }
      }
      if (done) Logger.info(`Refreshed ${done} thumbnail${done === 1 ? '' : 's'}`, 'Editor')
    } finally {
      task.finish()
      refreshingRef.current = false
    }
  }, [depsRef])

  /** Is this asset still used by the scene (or by a mesh asset)? Drives the extra delete confirmation. */
  const isReferenced = useCallback((entry: VfsEntry): boolean => {
    const scene = sceneRef.current
    const l = libsRef.current
    switch (entry.kind) {
      case 'material': return collectReferencedMaterialIds(scene, l.models).has(entry.assetId)
      case 'terrainMaterial': return collectReferencedTerrainMaterialIds(scene).has(entry.assetId)
      case 'template': return collectReferencedTemplateIds(scene).has(entry.assetId)
      case 'model': return collectReferencedModelIds(scene).has(entry.assetId)
      case 'script': return collectReferencedScriptIds(scene).has(entry.assetId)
      case 'animationField': return collectReferencedAnimationFieldIds(scene).has(entry.assetId)
      case 'tileset': return collectReferencedTilesetIds(scene).has(entry.assetId)
      case 'texture':
        return collectReferencedTextureIds(scene, l.materials, l.models, l.templates, l.terrainMaterials, l.tilesets)
          .has(entry.assetId)
      default: return false
    }
  }, [])

  const init = useCallback((api: IApi) => {
    apiRef.current = api

    // --- create ------------------------------------------------------------------------------------
    // SVAR reports each dropped OS file as a create-file carrying a File; those are rejected because
    // AssetsExplorer's own capture-phase drop handler ingests files (SVAR's directory walker flattens
    // folders and breaks multi-file model bundles). Folders are all that is left.
    api.intercept('create-file', (cfg: any) => {
      if (cfg.skipProvider) return true
      if (cfg.file?.file instanceof File) return false
      if (cfg.file?.type !== 'folder') return false
      return true
    })

    api.on('create-file', (cfg: any) => {
      if (!cfg.newId) return
      if (cfg.file?.type === 'folder') {
        // The sidebar does not re-read a parent's children when a folder is added inside it; re-opening
        // the parent forces the redraw.
        api.exec('open-tree-folder', { id: dirOf(cfg.newId), mode: true })
      }
      if (cfg.skipProvider) return
      setVfs(v => applyCreateFolder(v, cfg.newId))
    })

    // --- rename ------------------------------------------------------------------------------------
    // Pin the extension before the store sees it: it encodes the asset's kind.
    api.intercept('rename-file', (cfg: any) => {
      if (cfg.skipProvider) return true
      const name = (cfg.name ?? '').trim().replace(/\//g, '-')
      if (!name) return false
      const entry = pathIndexRef.current.get(cfg.id)
      cfg.name = entry ? ensureExt(name, entry.kind) : name
      return true
    })

    api.on('rename-file', (cfg: any) => {
      if (cfg.skipProvider) return
      const oldPath: string = cfg.id
      const newPath: string | undefined = cfg.newId
      if (!newPath || newPath === oldPath) return

      const entry = pathIndexRef.current.get(oldPath)
      if (entry) {
        setVfs(v => applyMoveOne(v, oldPath, newPath))
        renameAsset(entry.kind, entry.assetId, stemOf(newPath), depsRef.current)
      } else {
        setVfs(v => remapSubtree(v, oldPath, newPath)) // a folder: its whole subtree moves with it
      }
    })

    // --- delete ------------------------------------------------------------------------------------
    // SVAR shows its own confirmation; returning false here cancels before the tree mutates.
    api.intercept('delete-files', (cfg: any) => {
      if (cfg.skipProvider) return true

      // DataTree.remove purges a folder's subtree from the id pool then dereferences `_pool.get(nextId)`
      // blind: pass top-most, still-resolvable ids only or the batch throws and half-applies.
      const ids = topMostIds(Array.isArray(cfg.ids) ? cfg.ids : []).filter(id => !!api.getFile(id))
      if (!ids.length) return false
      cfg.ids = ids

      const { entries } = subtreeOf(vfsRef.current, ids)

      const inUse = entries.filter(isReferenced)
      if (inUse.length) {
        const lines = inUse.slice(0, 6).map(e => `  • ${baseOf(e.path)} — ${deleteConsequence(e.kind)}`)
        const more = inUse.length > 6 ? `\n  …and ${inUse.length - 6} more` : ''
        const ok = window.confirm(
          `${inUse.length} of the ${inUse.length === 1 ? 'asset' : 'assets'} you're deleting ${inUse.length === 1 ? 'is' : 'are'} still in use:\n\n${lines.join('\n')}${more}\n\nDelete anyway?`,
        )
        if (!ok) return false
      }

      for (const e of entries) deleteAsset(e.kind, e.assetId, depsRef.current)
      setVfs(v => applyDelete(v, ids))
      return true
    })

    // --- move (cut/paste, and our own drag-to-folder) ------------------------------------------------
    api.on('move-files', (cfg: any) => {
      if (cfg.skipProvider || !cfg.newIds) return
      const pairs: [string, string][] = cfg.ids.map((id: string, i: number) => [id, cfg.newIds[i]])

      // A name collision makes SVAR rename the file ('Rock.mat' -> 'Rock.new.mat'), so the record's name
      // must follow the path it actually landed on.
      const renames: [VfsEntry, string][] = []
      for (const [from, to] of pairs) {
        const entry = pathIndexRef.current.get(from)
        if (entry && stemOf(from) !== stemOf(to)) renames.push([entry, stemOf(to)])
      }

      setVfs(v => applyMoves(v, pairs))
      for (const [entry, stem] of renames) renameAsset(entry.kind, entry.assetId, stem, depsRef.current)
    })

    // --- copy (duplicate) ---------------------------------------------------------------------------
    // The store has already cloned the tree nodes; we mint a real, independent asset behind each new file.
    api.on('copy-files', (cfg: any) => {
      if (cfg.skipProvider || !cfg.newIds) return
      const current = vfsRef.current
      const folderSet = new Set(current.folders)

      const newFolders: string[] = []
      const newEntries: VfsEntry[] = []

      cfg.ids.forEach((from: string, i: number) => {
        const to: string = cfg.newIds[i]
        if (!to) return

        if (folderSet.has(from)) {
          const { entries, folders } = subtreeOf(current, [from])
          newFolders.push(...folders.map(f => to + f.slice(from.length)))
          for (const e of entries) newEntries.push({ ...e, path: to + e.path.slice(from.length) })
        } else {
          const e = pathIndexRef.current.get(from)
          if (e) newEntries.push({ ...e, path: to })
        }
      })

      const cloned: VfsEntry[] = []
      for (const e of newEntries) {
        const newAssetId = duplicateAsset(e.kind, e.assetId, stemOf(e.path), depsRef.current)
        if (newAssetId) cloned.push({ ...e, assetId: newAssetId, created: Date.now() })
      }

      setVfs(v => ({
        ...v,
        // The folder set must stay closed under its ancestors, or the next store sync creates a file
        // under a folder that is not there.
        folders: withAncestors([...v.folders, ...newFolders, ...cloned.flatMap(e => ancestorsOf(e.path))]),
        entries: [...v.entries, ...cloned],
      }))
    })

    // --- open (double click) ------------------------------------------------------------------------
    api.on('open-file', (cfg: any) => {
      const entry = pathIndexRef.current.get(cfg.id)
      if (!entry) return
      // Models and textures have no editor of their own — show the preview pane instead.
      if (!openAsset(entry.kind, entry.assetId, depsRef.current)) api.exec('show-preview', { mode: true })
    })

    // --- refresh ------------------------------------------------------------------------------------
    // The breadcrumb refresh icon is the only thing that execs 'request-data' (lazy loading is unused
    // here), so it is repurposed to re-capture the viewed folder's thumbnails.
    api.on('request-data', (cfg: any) => { void refreshFolderThumbnails(cfg?.id) })

    // --- ambient state ------------------------------------------------------------------------------
    // Assets created outside the explorer (a mesh import, "New Material") land in the folder being browsed.
    api.on('set-path', (cfg: any) => { if (cfg.id) landingFolderRef.current = cfg.id })
    api.on('set-mode', (cfg: any) => {
      try { if (cfg.mode) localStorage.setItem(FM_MODE_KEY, cfg.mode) } catch { /* ignore */ }
    })
  }, [isReferenced, setVfs, pathIndexRef, depsRef, landingFolderRef, refreshFolderThumbnails])

  useSyncVfsToStore(apiRef, vfs, libs, pathIndexRef, depsRef)

  return { init, apiRef }
}

/** Cheap fingerprint of an asset's thumbnail — enough to notice it was re-rendered without holding a
 *  second copy of every base64 image. */
function thumbFingerprint(entry: VfsEntry, deps: ReturnType<typeof useVfs>['depsRef']['current']): string {
  const thumb = thumbnailOf(entry.kind, entry.assetId, deps)
  if (!thumb) return ''
  return `${thumb.length}:${thumb.slice(-24)}`
}

/**
 * Run a store action without letting a failure escape.
 * `api.exec` is async, so a throw inside a handler surfaces as an unhandled rejection rather than at the
 * call site; for `delete-files` that leaves SVAR's tree half-mutated. Both shapes are caught here.
 */
function safeExec(api: IApi, action: string, cfg: any): void {
  try {
    const result = api.exec(action, cfg) as unknown
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
 */
function useSyncVfsToStore(
  apiRef: React.MutableRefObject<IApi | null>,
  vfs: VfsIndex,
  libs: ReturnType<typeof useVfs>['libs'],
  pathIndexRef: ReturnType<typeof useVfs>['pathIndexRef'],
  depsRef: ReturnType<typeof useVfs>['depsRef'],
) {
  const thumbsRef = useRef(new Map<string, string>())

  useEffect(() => {
    const api = apiRef.current
    if (!api) return

    const want = buildFileManagerData(vfs, libs)
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

    const add = (e: (typeof want)[number]) => {
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

    // SVAR memoizes a card's preview against the entity object's identity; swap the entity out so a
    // re-rendered thumbnail is picked up.
    const thumbs = thumbsRef.current
    for (const e of want) {
      if (e.type !== 'file') continue
      const entry = pathIndexRef.current.get(e.id)
      if (!entry) continue
      const fp = thumbFingerprint(entry, depsRef.current)
      const previous = thumbs.get(e.id)
      thumbs.set(e.id, fp)
      if (previous !== undefined && previous !== fp && have.has(e.id)) {
        if (api.getFile(e.id)) safeExec(api, 'delete-files', { ids: [e.id], skipProvider: true })
        have.delete(e.id)
        add(e)
      }
    }
    for (const id of Array.from(thumbs.keys())) if (!wanted.has(id)) thumbs.delete(id)
  }, [apiRef, vfs, libs, pathIndexRef, depsRef])
}

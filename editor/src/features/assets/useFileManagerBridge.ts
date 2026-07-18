import { useCallback, useEffect, useRef } from 'react'
import type { IApi } from '@svar-ui/react-filemanager'
import { Logger } from 'cleo'
import { startTask, StepStatus } from '../progress/progressStore'
import { useCleoEngine } from '../EngineContext'
import { useVfs } from './VfsContext'
import {
  applyCreateFolder, applyDelete, applyMoveOne, applyMoves, buildFileManagerData,
  ancestorsOf, baseOf, dirOf, ensureExt, remapSubtree, stemOf, subtreeOf, VfsEntry, VfsIndex,
} from '../../utils/vfs'
import {
  deleteAsset, deleteConsequence, duplicateAsset, openAsset, regenerateThumbnail, renameAsset, thumbnailOf,
} from './assetKinds'
import {
  collectReferencedMaterialIds, collectReferencedModelIds, collectReferencedTemplateIds,
  collectReferencedTerrainMaterialIds, collectReferencedTextureIds, collectReferencedScriptIds,
} from '../../utils/references'

export const FM_MODE_KEY = 'cleo_assets_view_mode'

// Bridges the SVAR file manager's actions onto the asset libraries.
//
// The tree is *uncontrolled*: SVAR's own FileTree is the source of truth for what's on screen, and we
// mirror its events into the VfsIndex. (Re-passing `data` would call store.init() and rebuild the tree,
// collapsing every open folder on every action.) Assets created outside the explorer are pushed into the
// tree by useSyncVfsToStore below.
//
// intercept() runs BEFORE the store mutates — that's where a mutation can be vetoed or its payload fixed.
// on() runs AFTER, which is the only place `newId`/`newIds` exist: SVAR dedupes colliding names by
// appending '.new', so the path an action actually produced is never known up front.

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
   *
   * Thumbnails are baked at import/save time, so they go stale whenever the thing behind them changes —
   * a texture re-imported under the same id, a material edited outside its editor. Refresh re-captures
   * them from the assets' own data. Sequential on purpose: each capture drives the shared renderer, and
   * `depsRef.current` has to carry the previous iteration's write before the next one reads it.
   */
  const refreshFolderThumbnails = useCallback(async (folder: string) => {
    const engine = engineRef.current
    if (!engine || !folder || refreshingRef.current) return

    const targets = vfsRef.current.entries.filter(e =>
      dirOf(e.path) === folder && (e.kind === 'material' || e.kind === 'terrainMaterial' || e.kind === 'model'))
    if (!targets.length) return

    refreshingRef.current = true

    // Each capture is a full GL frame, so a folder of assets is a genuinely long operation. It used to run
    // with nothing on screen until a Logger line at the very end.
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
      case 'texture':
        return collectReferencedTextureIds(scene, l.materials, l.models, l.templates, l.terrainMaterials)
          .has(entry.assetId)
      default: return false
    }
  }, [])

  const init = useCallback((api: IApi) => {
    apiRef.current = api

    // --- create ------------------------------------------------------------------------------------
    // SVAR has no upload action: its <Uploader> reports each dropped OS file as a create-file carrying a
    // File. We reject those — AssetsExplorer's own capture-phase drop handler ingests files instead, since
    // SVAR's directory walker flattens folders and would break multi-file model bundles. Blank files have
    // no meaning here either, so folders are all that's left.
    api.intercept('create-file', (cfg: any) => {
      if (cfg.skipProvider) return true
      if (cfg.file?.file instanceof File) return false
      if (cfg.file?.type !== 'folder') return false
      return true
    })

    api.on('create-file', (cfg: any) => {
      if (!cfg.newId) return
      if (cfg.file?.type === 'folder') {
        // The sidebar tree doesn't re-read a parent's children when a folder is added inside it (the
        // store mutates its FileTree in place, and the tree only redraws on a counter bump) — the user
        // would have to collapse/expand the parent by hand. Re-opening the parent forces the redraw and
        // conveniently reveals the new folder.
        api.exec('open-tree-folder', { id: dirOf(cfg.newId), mode: true })
      }
      if (cfg.skipProvider) return
      setVfs(v => applyCreateFolder(v, cfg.newId))
    })

    // --- rename ------------------------------------------------------------------------------------
    // Pin the extension before the store sees it: it encodes the asset's kind, so letting the user edit it
    // would silently reclassify the asset.
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
    // SVAR already shows its own "are you sure"; only add a second dialog when something would actually
    // break. Returning false here cancels before the tree mutates.
    api.intercept('delete-files', (cfg: any) => {
      if (cfg.skipProvider) return true
      const { entries } = subtreeOf(vfsRef.current, cfg.ids)

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
      setVfs(v => applyDelete(v, cfg.ids))
      return true
    })

    // --- move (cut/paste, and our own drag-to-folder) ------------------------------------------------
    api.on('move-files', (cfg: any) => {
      if (cfg.skipProvider || !cfg.newIds) return
      const pairs: [string, string][] = cfg.ids.map((id: string, i: number) => [id, cfg.newIds[i]])

      // A collision in the target folder makes SVAR rename the file ('Rock.mat' -> 'Rock.new.mat'), so the
      // record's name has to follow the path it actually landed on.
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
          // Copying a folder: re-anchor its whole subtree under the new prefix.
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
        folders: [...new Set([...v.folders, ...newFolders, ...cloned.flatMap(e => ancestorsOf(e.path))])],
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
    // The breadcrumb refresh icon is the *only* thing that execs 'request-data' (SVAR's own lazy-loading
    // is not used here — the tree is fully in memory), so it can be repurposed: re-capture the thumbnail
    // of every asset in the folder being viewed. useSyncVfsToStore notices the new images and swaps the
    // cards' entities so SVAR drops its memoized previews.
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

/** Cheap fingerprint of an asset's thumbnail — enough to notice it was re-rendered, without holding on to
 *  a second copy of every base64 image. */
function thumbFingerprint(entry: VfsEntry, deps: ReturnType<typeof useVfs>['depsRef']['current']): string {
  const thumb = thumbnailOf(entry.kind, entry.assetId, deps)
  if (!thumb) return ''
  return `${thumb.length}:${thumb.slice(-24)}`
}

/**
 * Push changes the explorer didn't make into SVAR's tree — a mesh imported from the left sidebar, a
 * material saved from its editor tab, a texture registered when a project loads. Diffing against the live
 * tree (rather than re-passing `data`) is what keeps the sidebar's open folders and the current path intact.
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
    const have = new Set((api.serialize('/') ?? []).map(e => e.id))

    const add = (e: (typeof want)[number]) => api.exec('create-file', {
      file: { name: baseOf(e.id), type: e.type, size: e.size, date: e.date },
      parent: dirOf(e.id),
      skipProvider: true,
    })

    // Parents first: FileTree.add resolves the parent eagerly, so a child added before its folder is lost.
    const missing = want
      .filter(e => !have.has(e.id))
      .sort((a, b) => a.id.split('/').length - b.id.split('/').length)
    for (const e of missing) add(e)

    const wanted = new Set(want.map(e => e.id))
    const stale = Array.from(have).filter(id => !wanted.has(id))
    if (stale.length) api.exec('delete-files', { ids: stale, skipProvider: true })

    // SVAR memoizes a card's preview against the entity object's identity, so re-saving a material (which
    // re-renders its thumbnail) would keep showing the old image forever. Swap the entity out to invalidate it.
    const thumbs = thumbsRef.current
    for (const e of want) {
      if (e.type !== 'file') continue
      const entry = pathIndexRef.current.get(e.id)
      if (!entry) continue
      const fp = thumbFingerprint(entry, depsRef.current)
      const previous = thumbs.get(e.id)
      thumbs.set(e.id, fp)
      if (previous !== undefined && previous !== fp && have.has(e.id)) {
        api.exec('delete-files', { ids: [e.id], skipProvider: true })
        add(e)
      }
    }
    for (const id of Array.from(thumbs.keys())) if (!wanted.has(id)) thumbs.delete(id)
  }, [apiRef, vfs, libs, pathIndexRef, depsRef])
}

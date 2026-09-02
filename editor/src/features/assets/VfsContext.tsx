import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Logger, TextureManager, isDerivedTextureId } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import { useAssetLibrary } from '../AssetLibraryContext'
import { idbGet, idbSet } from '../../utils/idb'
import {
  EMPTY_VFS, LibSnapshot, VfsEntry, VfsIndex, vfsKey,
  AssetKind, indexByPath, reconcileVfs, repairVfs,
} from '../../utils/vfs'
import { AssetDeps, sizeOfAsset } from './assetKinds'
import { reconcileTextureAssets } from '../../utils/textureAssets'
import type { LiveTexture } from '../../utils/textureAssets'

// Owns the asset explorer's virtual filesystem: the folder layout, persisted to IndexedDB under
// `cleo_vfs`, and the reconciliation that keeps it in step with the five flat asset libraries.
// Mounted above <Editor> so it keeps reconciling while the Assets tab is hidden.

// Built-in textures the explorer must never show. `__packed__` ids are engine-derived channel packs,
// rebuilt from the source maps on demand, so they are not assets and have no bytes to store.
function isUserTexture(id: string): boolean {
  return !(id.includes('__editor__') || id.includes('__debug__') || isDerivedTextureId(id) || id === 'Null')
}

type VfsContextValue = {
  vfs: VfsIndex
  setVfs: React.Dispatch<React.SetStateAction<VfsIndex>>
  libs: LibSnapshot
  /** path -> entry, rebuilt whenever the index changes. */
  pathIndex: Map<string, VfsEntry>
  /** Same map behind a ref, for the DOM-level drag-out handlers (which register once). */
  pathIndexRef: React.MutableRefObject<Map<string, VfsEntry>>
  /**
   * Folder path -> the single AssetKind it holds, for folders that hold exactly one. Absent means mixed
   * or empty. Read through a ref because the file manager captures its icon callback on FIRST render and
   * never rebuilds it.
   */
  folderKindsRef: React.MutableRefObject<Map<string, AssetKind>>
  /** The folder the user is browsing — where assets created outside the explorer land. */
  landingFolderRef: React.MutableRefObject<string>
  /** Everything the per-kind adapters need, behind a ref so event handlers can register once. */
  depsRef: React.MutableRefObject<AssetDeps>
  /** True once the index and every IndexedDB library have loaded: the file manager may now mount. */
  ready: boolean
}

const VfsContext = createContext<VfsContextValue | null>(null)

export function useVfs(): VfsContextValue {
  const ctx = useContext(VfsContext)
  if (!ctx) throw new Error('useVfs must be used within a VfsProvider')
  return ctx
}

export function VfsProvider({ children }: { children: React.ReactNode }) {
  const engine = useCleoEngine()
  const { eventEmitter, isSceneReady, texturesPreloaded, sceneList } = engine
  // The five libraries come from the split-out slice, so reconciliation re-runs on library changes only.
  const {
    assetsLoaded,
    materials, terrainMaterials, templates, models, scriptAssets, animationFields, animations, tilesets,
    images, textures, addImage, addTextureAsset,
  } = useAssetLibrary()

  const [vfs, setVfs] = useState<VfsIndex>(EMPTY_VFS)
  const vfsLoadedRef = useRef(false)
  const [vfsLoaded, setVfsLoaded] = useState(false)

  // Textures live in the TextureManager singleton, not React state; mirror their ids here and refresh on
  // the events that add/remove them.
  const [textureIds, setTextureIds] = useState<string[]>([])
  useEffect(() => {
    const refresh = () => {
      const ids = Array.from(TextureManager.Instance.textures.keys()).filter(isUserTexture)
      setTextureIds(prev => (prev.length === ids.length && prev.every((id, i) => id === ids[i]) ? prev : ids))
    }
    refresh()
    eventEmitter.on('TEXTURES_CHANGED', refresh)
    eventEmitter.on('SCENE_CHANGED', refresh)
    return () => { eventEmitter.off('TEXTURES_CHANGED', refresh); eventEmitter.off('SCENE_CHANGED', refresh) }
  }, [eventEmitter])

  /**
   * Derive the Image and Texture records from what is actually registered in the TextureManager.
   *
   * THIS IS THE IMAGE/TEXTURE MIGRATION, and it is a continuous reconciler rather than a one-shot
   * versioned pass on purpose: the same code covers the first boot after the upgrade, a model import, an
   * atlas import, a scene parse and a bundle import, instead of six call-site edits plus a marker key
   * that a bundle written by an older build would slip straight past. It mints only for an id that has no
   * record, so running it on every library change is idempotent.
   *
   * Gated on the same conditions as `pruneTextures` below, and for the same reason: before the libraries
   * have finished their IndexedDB reads every live texture LOOKS new, and minting against two empty
   * arrays would produce a duplicate record set that then loses to the real read. `assetsLoaded` now
   * waits on the image and texture libraries too (see EngineContext's predicate).
   */
  useEffect(() => {
    if (!assetsLoaded || !texturesPreloaded || !isSceneReady) return
    const tm = TextureManager.Instance
    const live: LiveTexture[] = textureIds.map(id => {
      const texture = tm.getTexture(id)
      const source = tm.getSource(id)
      return {
        id,
        config: texture?.config,
        width: texture?.width ?? 0,
        height: texture?.height ?? 0,
        source: source ? { mime: source.mime, byteLength: source.bytes.byteLength } : null,
      }
    })
    const next = reconcileTextureAssets(live, images, textures)
    if (!next.changed) return
    // Added one at a time through the library actions rather than by replacing the arrays: those actions
    // are what the persistence hook and the live-GPU retune are wired to.
    for (const image of next.images) if (!images.some(i => i.id === image.id)) addImage(image)
    for (const texture of next.textures) if (!textures.some(t => t.id === texture.id)) addTextureAsset(texture)
  }, [assetsLoaded, texturesPreloaded, isSceneReady, textureIds, images, textures, addImage, addTextureAsset])

  const libs: LibSnapshot = useMemo(
    () => ({ materials, terrainMaterials, templates, models, scripts: scriptAssets, animationFields, animations, tilesets, scenes: sceneList, images, textures, textureIds }),
    [materials, terrainMaterials, templates, models, scriptAssets, animationFields, animations, tilesets, sceneList, images, textures, textureIds],
  )

  const depsRef = useRef<AssetDeps>(null as any)
  depsRef.current = {
    materials, terrainMaterials, templates, models, scripts: scriptAssets, animationFields, animations, tilesets,
    images, textures,
    scenes: sceneList,
    addImage: engine.addImage,
    updateImage: engine.updateImage,
    removeImage: engine.removeImage,
    addTextureAsset: engine.addTextureAsset,
    updateTextureAsset: engine.updateTextureAsset,
    removeTextureAsset: engine.removeTextureAsset,
    addMaterial: engine.addMaterial,
    updateMaterial: engine.updateMaterial,
    removeMaterial: engine.removeMaterial,
    addTerrainMaterial: engine.addTerrainMaterial,
    updateTerrainMaterial: engine.updateTerrainMaterial,
    removeTerrainMaterial: engine.removeTerrainMaterial,
    addTemplate: engine.addTemplate,
    updateTemplate: engine.updateTemplate,
    removeTemplate: engine.removeTemplate,
    addModel: engine.addModel,
    updateModel: engine.updateModel,
    removeModel: engine.removeModel,
    addScriptAsset: engine.addScriptAsset,
    updateScriptAsset: engine.updateScriptAsset,
    removeScriptAsset: engine.removeScriptAsset,
    addAnimationField: engine.addAnimationField,
    updateAnimationField: engine.updateAnimationField,
    removeAnimationField: engine.removeAnimationField,
    addAnimation: engine.addAnimation,
    updateAnimation: engine.updateAnimation,
    removeAnimation: engine.removeAnimation,
    addTileset: engine.addTileset,
    updateTileset: engine.updateTileset,
    removeTileset: engine.removeTileset,
    createScene: engine.createScene,
    renameScene: engine.renameScene,
    deleteScene: engine.deleteScene,
    duplicateScene: engine.duplicateScene,
    openScene: engine.openScene,
    setMainScene: engine.setMainScene,
    enterMaterialEditor: engine.enterMaterialEditor,
    enterTerrainMaterialEditor: engine.enterTerrainMaterialEditor,
    enterTemplateEditor: engine.enterTemplateEditor,
    enterScriptEditor: engine.enterScriptEditor,
    enterModelEditor: engine.enterModelEditor,
    enterAnimationFieldEditor: engine.enterAnimationFieldEditor,
    enterTilesetEditor: engine.enterTilesetEditor,
    enterTextureEditor: engine.enterTextureEditor,
    emit: (event, payload) => eventEmitter.emit(event as any, payload),
  }

  const landingFolderRef = useRef<string>('/')

  // Initial read; on a first run this stays EMPTY_VFS and the reconcile below lands every existing asset
  // at the root. Everything off disk goes through repairVfs first: a stored index with a missing ancestor
  // folder or a twice-claimed path makes FileTree.add dereference an absent parent on every load.
  useEffect(() => {
    (async () => {
      try {
        const stored = await idbGet<VfsIndex>(vfsKey())
        if (stored?.entries) {
          const { next, notes } = repairVfs(stored)
          if (notes.length) {
            Logger.warn(`Repaired the asset index on load: ${notes.join('; ')}`, 'Editor')
            idbSet(vfsKey(), next).catch(e => console.warn('Failed to persist the repaired asset index:', e))
          }
          setVfs(next)
        }
      } catch (e) { console.warn('Failed to load the asset index:', e) }
      finally { vfsLoadedRef.current = true; setVfsLoaded(true) }
    })()
  }, [])

  // Index assets created outside the explorer, follow renames, and (once the libraries have loaded) drop
  // entries whose asset is gone. Pruning is irreversible once the debounced write lands, and `assetsLoaded`
  // can flip a commit BEFORE the library values reach this component; pruning against libraries that
  // merely look empty deletes the whole folder layout, so require at least one asset to be present.
  const librariesPopulated = !!(materials.length || terrainMaterials.length || templates.length
    || models.length || scriptAssets.length || animationFields.length || animations.length || tilesets.length)

  useEffect(() => {
    if (!vfsLoaded) return
    setVfs(prev => {
      const { next, changed } = reconcileVfs(prev, libs, {
        landingFolder: landingFolderRef.current,
        prune: assetsLoaded && librariesPopulated,
        // Textures have no library to look "populated"; preload settling is the equivalent signal.
        // `isSceneReady` on top of it: restoring the initial scene registers more textures.
        pruneTextures: assetsLoaded && texturesPreloaded && isSceneReady,
        sizeOf: (kind: AssetKind, assetId: string) => sizeOfAsset(kind, assetId, depsRef.current),
      })
      return changed ? next : prev
    })
  }, [vfsLoaded, libs, assetsLoaded, librariesPopulated, texturesPreloaded, isSceneReady])

  // Persist, debounced: texture registration is chatty while a project or a mesh import loads.
  useEffect(() => {
    if (!vfsLoaded) return
    const timer = window.setTimeout(() => {
      idbSet(vfsKey(), vfs).catch(e => console.warn('Failed to persist the asset index:', e))
    }, 300)
    return () => window.clearTimeout(timer)
  }, [vfs, vfsLoaded])

  const pathIndex = useMemo(() => indexByPath(vfs), [vfs])
  const pathIndexRef = useRef(pathIndex)
  pathIndexRef.current = pathIndex

  /**
   * Which folders hold exactly one kind of asset.
   *
   * Judged on DIRECT children only, ignoring subfolders — which is what makes `/Textures/Source` (all
   * images) read as images while `/Textures` (all .tex, with the images nested one level down) reads as
   * textures. Counting descendants would make both of them mixed.
   */
  const folderKinds = useMemo(() => {
    const kinds = new Map<string, AssetKind | null>()
    for (const e of vfs.entries) {
      const dir = e.path.slice(0, Math.max(1, e.path.lastIndexOf('/')))
      const seen = kinds.get(dir)
      // null marks "already mixed", so a third entry cannot un-mix it.
      if (seen === undefined) kinds.set(dir, e.kind)
      else if (seen !== e.kind) kinds.set(dir, null)
    }
    const only = new Map<string, AssetKind>()
    for (const [dir, kind] of kinds) if (kind) only.set(dir, kind)
    return only
  }, [vfs.entries])

  const folderKindsRef = useRef(folderKinds)
  folderKindsRef.current = folderKinds

  // Latched: the file manager keeps its tree, open folders and current path in its own store, so a flicker
  // back to false would remount it and lose all of that.
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (!ready && vfsLoaded && assetsLoaded && isSceneReady) setReady(true)
  }, [ready, vfsLoaded, assetsLoaded, isSceneReady])

  const value: VfsContextValue = {
    vfs, setVfs, libs, pathIndex, pathIndexRef, folderKindsRef, landingFolderRef, depsRef, ready,
  }

  return <VfsContext.Provider value={value}>{children}</VfsContext.Provider>
}

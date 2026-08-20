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

// Owns the asset explorer's virtual filesystem: the folder layout, persisted to IndexedDB under
// `cleo_vfs`, and the reconciliation that keeps it in step with the five flat asset libraries.
//
// It lives above <Editor> rather than inside the explorer so it keeps reconciling while the Assets tab is
// hidden (renderer mode collapses the whole bottom bar) — otherwise an import made from the left sidebar
// wouldn't be indexed until the user happened to look at the explorer.

// Built-in textures the explorer must never show. `__packed__` ids are engine-derived channel packs
// (e.g. metallic + roughness + occlusion combined into one texture): they are rebuilt from the source
// maps on demand, so they are not assets and have no bytes to store.
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
  // The five libraries come from the split-out slice, so reconciliation re-runs on library changes
  // rather than on every unrelated EngineContext update.
  const {
    assetsLoaded,
    materials, terrainMaterials, templates, models, scriptAssets, animationFields, tilesets,
  } = useAssetLibrary()

  const [vfs, setVfs] = useState<VfsIndex>(EMPTY_VFS)
  const vfsLoadedRef = useRef(false)
  const [vfsLoaded, setVfsLoaded] = useState(false)

  // Textures aren't React state — they live in the TextureManager singleton — so mirror their ids here and
  // refresh on the events that add/remove them.
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

  const libs: LibSnapshot = useMemo(
    () => ({ materials, terrainMaterials, templates, models, scripts: scriptAssets, animationFields, tilesets, scenes: sceneList, textureIds }),
    [materials, terrainMaterials, templates, models, scriptAssets, animationFields, tilesets, sceneList, textureIds],
  )

  const depsRef = useRef<AssetDeps>(null as any)
  depsRef.current = {
    materials, terrainMaterials, templates, models, scripts: scriptAssets, animationFields, tilesets,
    scenes: sceneList,
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
    emit: (event, payload) => eventEmitter.emit(event as any, payload),
  }

  const landingFolderRef = useRef<string>('/')

  // Initial read. On a first run this stays EMPTY_VFS, and the reconcile below lands every existing asset
  // at the root — that is the whole migration.
  //
  // Everything that comes off disk goes through repairVfs first. A stored index can be structurally
  // broken — an entry whose ancestor folder is missing, a path claimed twice — and the file manager does
  // not survive that: FileTree.parse quietly unlinks the orphan, the store sync then tries to create it,
  // and FileTree.add dereferences the absent parent. Since the damage is persisted, the explorer would
  // throw on every load until the index is fixed, which is what this does.
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

  // Index assets created outside the explorer, follow renames made in the material/template editors, and
  // (once the libraries have actually loaded) drop entries whose asset is gone.
  // Pruning is destructive and irreversible once the debounced write below lands, so `assetsLoaded` is not
  // trusted on its own. It flips from imperative refs set the moment each IndexedDB read resolves, which
  // can be a commit BEFORE the library values themselves reach this component — and pruning against
  // libraries that merely look empty deletes the user's entire folder layout for every non-texture kind.
  // (Textures are exempt inside reconcileVfs and scenes come from their own list, which is why those two
  // were the only survivors when this fired.) Requiring at least one asset to be present costs nothing:
  // with every library empty there is, by definition, nothing that needs pruning.
  const librariesPopulated = !!(materials.length || terrainMaterials.length || templates.length
    || models.length || scriptAssets.length || animationFields.length || tilesets.length)

  useEffect(() => {
    if (!vfsLoaded) return
    setVfs(prev => {
      const { next, changed } = reconcileVfs(prev, libs, {
        landingFolder: landingFolderRef.current,
        prune: assetsLoaded && librariesPopulated,
        // Textures have no library of their own to look "populated"; the preload settling is the
        // equivalent signal. `isSceneReady` on top of it because restoring the initial scene registers
        // more textures (a legacy ModelAsset re-registers its embedded ones when it is instantiated),
        // and pruning between those two points would drop entries that were about to be filled in.
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

  // Latched: the file manager keeps its tree, open folders and current path in its own store, so it must
  // mount exactly once. Anything that made `ready` flicker back to false would remount it and lose all of that.
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (!ready && vfsLoaded && assetsLoaded && isSceneReady) setReady(true)
  }, [ready, vfsLoaded, assetsLoaded, isSceneReady])

  const value: VfsContextValue = {
    vfs, setVfs, libs, pathIndex, pathIndexRef, landingFolderRef, depsRef, ready,
  }

  return <VfsContext.Provider value={value}>{children}</VfsContext.Provider>
}

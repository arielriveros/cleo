import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { assetGraph, assetKey, engineEventBus } from 'cleo'
import type { AssetEdge, AssetRef } from 'cleo'
import { useCleoEngine, SCENE_TAB_ID } from '../EngineContext'
import { useAssetLibrary } from '../AssetLibraryContext'
import { useDocument } from '../DocumentContext'
import { edgesOfAsset, edgesOfScene } from '../../utils/assetEdges'
import { buildSceneRefs } from '../../utils/references'
import { structurallyChanged } from '../../utils/assetHash'
import { assetIdOfTab } from '../../utils/tabState'
import type { AssetKind } from '../../utils/vfs'

// Keeps the engine's `assetGraph` in step with the asset libraries, and turns a change into the two things
// the editor actually needs: an auto-applied refresh, or a stale-tab banner.
//
// WHY THE DIFF IS BY OBJECT IDENTITY. Every library update action is immutable — `updateMaterial(id,
// { ...a, name })` — so a new object identity IS the change signal, exactly, for free. That is what makes
// dirty-marking automatic: not one `touch()` hand-placed in each of the thirteen setters (which the next
// setter would forget), but one diff that cannot be bypassed.
//
// LOAD-BEARING: the update actions must keep producing a NEW object. They all do today. An in-place
// mutation would make this diff blind and the graph would silently stop propagating.

/**
 * Kinds whose change cannot be applied in place.
 *
 * A model or template change re-instantiates placed copies (`syncModelInstances` /
 * `syncTemplateInstances`), which mints fresh node ids and drops per-instance state — animation state, the
 * transform delta, authored variables. Doing that under someone mid-edit is the one propagation that has
 * to ask first, so these raise a banner instead of applying.
 *
 * Everything else refreshes in place and stays silent: a texture's settings are pushed to the live
 * TextureManager entry, a material is re-applied to the nodes wearing it, a terrain material is re-applied
 * to its layers. Those paths already exist and already run from the save handlers.
 */
const REBUILD_KINDS = new Set<string>(['model', 'template'])

export type AssetGraphContextValue = {
  /** Bumped whenever the graph's shape changes, so views can re-derive without diffing it themselves. */
  version: number
  /** Tab id -> the changed assets it depends on. Only ever holds {@link REBUILD_KINDS} origins. */
  staleTabs: Map<string, AssetRef[]>
  /** Stop reporting this tab as stale, without reloading it. */
  dismissStale: (tabId: string) => void
  /** References pointing at an asset that does not exist. Recomputed when `version` moves. */
  dangling: AssetEdge[]
}

const AssetGraphContext = createContext<AssetGraphContextValue | null>(null)

export function useAssetGraph(): AssetGraphContextValue {
  const ctx = useContext(AssetGraphContext)
  if (!ctx) throw new Error('useAssetGraph must be used within an AssetGraphProvider')
  return ctx
}

export function AssetGraphProvider({ children }: { children: React.ReactNode }) {
  const { sceneList, openSceneId, editorScene, eventEmitter, instance: engine } = useCleoEngine()
  const { tabs } = useDocument()
  const {
    assetsLoaded,
    materials, terrainMaterials, templates, models, scriptAssets, animationFields, animations,
    tilesets, aiBrains, images, textures, audioSources, soundSamples, rigs,
  } = useAssetLibrary()

  const [version, setVersion] = useState(0)
  const [staleTabs, setStaleTabs] = useState<Map<string, AssetRef[]>>(() => new Map())

  // Read through a ref: the SCENE_CHANGED listener registers once per open scene and must not capture
  // the libraries as they were on that render.
  const libsRef = useRef({ soundSamples, models, rigs })
  libsRef.current = { soundSamples, models, rigs }

  /** The asset object last indexed, per key. The other half of the identity diff. */
  const indexed = useRef(new Map<string, any>())

  // Read through refs: the ASSET_CHANGED listener registers once and must not capture a stale tab list.
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const openSceneIdRef = useRef(openSceneId)
  openSceneIdRef.current = openSceneId

  // --- build and diff ---------------------------------------------------------------------------------
  useEffect(() => {
    // Before the IndexedDB reads settle every library is [], and indexing that would report the whole
    // project as deleted on the next pass.
    if (!assetsLoaded) return

    const seen = new Set<string>()
    const touched: AssetRef[] = []
    let changed = false

    const visit = (kind: AssetKind, asset: { id: string }) => {
      if (!asset?.id) return
      const key = assetKey(kind, asset.id)
      seen.add(key)

      const previous = indexed.current.get(key)
      if (previous === asset) return
      indexed.current.set(key, asset)
      assetGraph.setEdges({ kind, id: asset.id }, edgesOfAsset(kind, asset))
      changed = true

      // First sight is an INDEX, not a change. Everything is new at boot, and an asset just imported has
      // no dependents to notify — cascading either would mark every open tab stale for nothing.
      if (previous === undefined) return
      // The thumbnail write-back that follows every material and model save rewrites the record without
      // changing anything referenced. Without this gate each save cascades twice, and the second pass
      // re-raises the banner moments after it was dismissed.
      if (structurallyChanged(previous, asset)) touched.push({ kind, id: asset.id })
    }

    for (const m of materials) visit('material', m)
    for (const m of terrainMaterials) visit('terrainMaterial', m)
    for (const t of templates) visit('template', t)
    for (const m of models) visit('model', m)
    for (const s of scriptAssets) visit('script', s)
    for (const f of animationFields) visit('animationField', f)
    for (const a of animations) visit('animation', a)
    for (const r of rigs) visit('rig', r)
    for (const t of tilesets) visit('tileset', t)
    for (const b of aiBrains) visit('aiBrain', b)
    for (const i of images) visit('image', i)
    for (const t of textures) visit('texture', t)
    for (const a of audioSources) visit('audioSource', a)
    for (const s of soundSamples) visit('soundSample', s)
    // Closed scenes read their save-time `refs` snapshot — see edgesOfScene. No stored blob is ever walked.
    // The OPEN scene is skipped: its edges are re-derived live below, from the scene itself, so it is
    // correct without a save. Letting this pass run for it too would overwrite that with the stored list.
    for (const s of sceneList) {
      if (s.id === openSceneId) continue
      visit('scene', s)
    }

    for (const key of [...indexed.current.keys()]) {
      if (seen.has(key)) continue
      const ref = assetGraph.refOf(key)
      indexed.current.delete(key)
      if (!ref) continue
      // The node goes; its INCOMING edges stay, so whatever still points at it reports as dangling rather
      // than quietly losing the reference.
      assetGraph.removeNode(ref)
      touched.push(ref)
      changed = true
    }

    for (const ref of touched) assetGraph.touch(ref)
    if (changed) setVersion(v => v + 1)
  }, [
    assetsLoaded, materials, terrainMaterials, templates, models, scriptAssets, animationFields,
    animations, rigs, tilesets, aiBrains, images, textures, audioSources, soundSamples, sceneList, openSceneId,
  ])

  // --- the open scene, live ---------------------------------------------------------------------------
  // A scene enters the graph through the `refs` snapshot written when it was SAVED, which means the scene
  // being edited right now would show a stale — and, for anything saved by an older build, a wrong —
  // reference list until the user saved it. Re-derive it from the live scene instead.
  useEffect(() => {
    if (!assetsLoaded || !openSceneId) return

    const rederive = () => {
      const scene = editorScene
      if (!scene) return
      assetGraph.setEdges(
        { kind: 'scene', id: openSceneId },
        edgesOfScene(buildSceneRefs(scene, engine?.renderer?.getRenderSettings?.(), libsRef.current.soundSamples, libsRef.current.models, libsRef.current.rigs) as any),
      )
      setVersion(v => v + 1)
    }

    rederive()
    // Trailing-edge debounce, and it is mandatory rather than tidiness: SCENE_CHANGED has ~80 emit sites
    // and fires on every frame of a gizmo drag. 300 ms is the cadence VfsContext already uses for the same
    // kind of work on the same event.
    let timer = 0
    const onChange = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(rederive, 300)
    }
    eventEmitter.on('SCENE_CHANGED', onChange)
    return () => {
      window.clearTimeout(timer)
      eventEmitter.off('SCENE_CHANGED', onChange)
    }
    // Deliberately NOT `touch()`ing the scene: that would cascade staleness to the scene tab on every
    // edit, and the scene is the thing being edited.
  }, [assetsLoaded, openSceneId, editorScene, eventEmitter, engine])

  // --- route the cascade ------------------------------------------------------------------------------
  useEffect(() => {
    const onAssetChanged = ({ origin, affected }: { origin: AssetRef; affected: AssetRef[] }) => {
      if (!REBUILD_KINDS.has(origin.kind)) return

      const affectedKeys = new Set(affected.map(r => assetKey(r.kind, r.id)))
      const additions: [string, AssetRef][] = []

      for (const tab of tabsRef.current) {
        // The scene tab edits no asset of its own; what makes it stale is the OPEN scene depending on the
        // change, which the graph knows through that scene's saved refs.
        if (tab.kind === 'scene') {
          const sceneId = openSceneIdRef.current
          if (sceneId && affectedKeys.has(assetKey('scene', sceneId))) additions.push([tab.id, origin])
          continue
        }
        const assetId = assetIdOfTab(tab)
        if (!assetId) continue
        // Every TabKind that owns an asset is spelled exactly as its AssetKind ('material', 'model',
        // 'soundSample', …), so the tab kind IS the asset kind. The two that are not — 'scene' (handled
        // above) and 'animation' (no id field, so `assetIdOfTab` already returned null) — never reach here.
        const tabKey = assetKey(tab.kind as AssetKind, assetId)
        // The tab that made the change is not stale because of it — it IS the change. Mirrors the
        // `exceptTabId` argument the sync* functions already take. Compared on the whole KEY, not the id:
        // an image and the texture reading it deliberately share one id (see images.ts).
        if (tabKey === assetKey(origin.kind as AssetKind, origin.id)) continue
        if (affectedKeys.has(tabKey)) additions.push([tab.id, origin])
      }

      if (!additions.length) return
      setStaleTabs(prev => {
        const next = new Map(prev)
        for (const [tabId, ref] of additions) {
          const list = next.get(tabId) ?? []
          if (list.some(r => r.kind === ref.kind && r.id === ref.id)) continue
          next.set(tabId, [...list, ref])
        }
        return next
      })
    }

    // The ENGINE bus, not the editor's own emitter: `assetGraph.touch` emits there, because the graph is
    // engine-side and must be able to announce itself without knowing an editor exists.
    engineEventBus.on('ASSET_CHANGED', onAssetChanged)
    return () => { engineEventBus.off('ASSET_CHANGED', onAssetChanged) }
  }, [])

  // A closed tab cannot be reloaded, so holding its staleness would leak the entry forever.
  useEffect(() => {
    setStaleTabs(prev => {
      if (!prev.size) return prev
      const live = new Set(tabs.map(t => t.id))
      const next = new Map([...prev].filter(([id]) => live.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [tabs])

  const dismissStale = useCallback((tabId: string) => {
    setStaleTabs(prev => {
      if (!prev.has(tabId)) return prev
      const next = new Map(prev)
      next.delete(tabId)
      return next
    })
  }, [])

  const dangling = useMemo(() => assetGraph.dangling(), [version])

  const value = useMemo<AssetGraphContextValue>(
    () => ({ version, staleTabs, dismissStale, dangling }),
    [version, staleTabs, dismissStale, dangling],
  )

  return <AssetGraphContext.Provider value={value}>{children}</AssetGraphContext.Provider>
}

export { SCENE_TAB_ID }

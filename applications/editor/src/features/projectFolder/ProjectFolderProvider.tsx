import { useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { Logger } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import { useAssetLibrary } from '../AssetLibraryContext'
import { useVfs } from '../assets/VfsContext'
import { useProjectName } from '../projects/useProjectName'
import { activeProjectId } from '../../utils/projectScope'
import { folderSink } from './folderSink'
import { folderSession, onFolderChange, scheduleStateSave, takeFolderChanges } from './folderSession'
import { getProjectBridge, type FolderChange } from './desktopProject'
import { installProjectSdk } from './sdkInstall'
import { regenerateThumbnail } from '../assets/assetKinds'
import type { AssetKind } from '../../utils/vfs'
import { queuePlay, setPlayStarter } from './controlHost'
import { takeLaunchPlayRequest } from './launchRequests'
import { setVsCodeDebugOverride } from '../scriptDebugger/vscodeAttach'
import { playBlockedReason } from '../playWindow/playGate'
import { windowPlay } from '../playWindow/windowPlay'
import { currentLoad } from '@cleo/app-kit/feedback/loadingStore'

// A folder project's link between the mounted editor and its folder: what the editor holds goes to the
// folder (folderSink), and what changed in the folder outside the editor is counted for the status chip,
// which offers a reload. Renders nothing; a project that is not a folder (the web build) skips it all.
//
// Mounted inside VfsProvider: it reads the explorer index as well as every library.

/** Changes on disk the editor has not taken in yet. A reload reads the folder again and clears them. */
const external = { files: new Set<string>(), rootMissing: false, version: 0 }
const externalListeners = new Set<() => void>()
const bumpExternal = () => { external.version++; for (const fn of externalListeners) fn() }

export function useExternalChanges(): { count: number; rootMissing: boolean; rels: string[] } {
  const version = useSyncExternalStore(fn => { externalListeners.add(fn); return () => { externalListeners.delete(fn) } }, () => external.version)
  return useMemo(() => ({ count: external.files.size, rootMissing: external.rootMissing, rels: [...external.files] }), [version])
}

export function clearExternalChanges(): void {
  external.files.clear()
  external.rootMissing = false
  bumpExternal()
}

function takeIn(changes: FolderChange[]): void {
  for (const c of changes) {
    if (c.rootMissing) external.rootMissing = true
    if (c.rootRestored) external.rootMissing = false
    for (const f of c.files?.added ?? []) external.files.add(f.rel)
    for (const f of c.files?.changed ?? []) external.files.add(f.rel)
    for (const rel of c.files?.removed ?? []) external.files.add(rel)
  }
  bumpExternal()
}

/**
 * The live lane: an edit to a script's source that the editor already knows — the everyday case of writing
 * code in VS Code — is taken in at once, the open script tab included, with no reload. Everything else (a
 * new, moved or deleted file, any other kind, a script edit with a changed meta) waits for Reload, which reads
 * the folder through the same path an open does.
 */
async function takeChanges(adopt: (id: string, source: string) => { replacedUnsaved: boolean }): Promise<void> {
  const changes = takeFolderChanges()
  if (!changes.length) return
  const s = folderSession()
  const bridge = getProjectBridge()
  if (!s || !bridge) { takeIn(changes); return }
  const rest: FolderChange[] = []
  const live: { rel: string; sha: string; guid: string }[] = []
  for (const c of changes) {
    const other: FolderChange = { ...c, files: c.files ? { added: [...c.files.added], changed: [], removed: [...c.files.removed] } : undefined }
    for (const f of c.files?.changed ?? []) {
      const known = s.state.get(f.rel)
      if (known?.kind === 'script' && known.guid && f.rel.endsWith('.ts') && !s.blocked.has(f.rel)) live.push({ rel: f.rel, sha: f.sha, guid: known.guid })
      else other.files!.changed.push(f)
    }
    rest.push(other)
  }
  if (live.length) {
    const res = await bridge.read(s.root, live.map(l => l.rel))
    const byRel = new Map(res.ok ? res.files.map(f => [f.rel, f.data]) : [])
    for (const l of live) {
      const data = byRel.get(l.rel)
      if (!data) { rest.push({ files: { added: [], changed: [{ rel: l.rel, sha: l.sha, size: 0, mtimeMs: 0 }], removed: [] } }); continue }
      const source = new TextDecoder().decode(data)
      // Agreed first: the record the adopt makes encodes to exactly this file, so the push writes nothing.
      const prev = s.state.get(l.rel)!
      s.state.set(l.rel, { ...prev, sha: l.sha })
      const { replacedUnsaved } = adopt(l.guid, source)
      if (replacedUnsaved) Logger.warn(`${l.rel} changed on disk; its unsaved edits in the script tab were replaced`, 'Editor')
    }
    scheduleStateSave()
  }
  takeIn(rest)
}

export function ProjectFolderProvider({ children }: { children: ReactNode }) {
  const session = folderSession()
  return session ? <ProjectFolderLink>{children}</ProjectFolderLink> : <>{children}</>
}

function ProjectFolderLink({ children }: { children: ReactNode }) {
  const engine = useCleoEngine()
  const lib = useAssetLibrary()
  const { vfs, ready } = useVfs()
  const name = useProjectName(activeProjectId())

  // The engine's adopt function, through a ref: the subscription below is made once.
  const adoptRef = useRef(engine.adoptExternalScriptSource)
  adoptRef.current = engine.adoptExternalScriptSource

  useEffect(() => {
    folderSink.attach()
    clearExternalChanges()
    let chain = Promise.resolve()
    // Changes are handled in order, one batch at a time: a live script edit must land before the next one.
    const handle = () => { chain = chain.then(() => takeChanges(adoptRef.current)).catch(() => {}) }
    handle()
    const off = onFolderChange(handle)
    return () => { off(); folderSink.detach() }
  }, [])

  useEffect(() => {
    folderSink.setInputs({
      vfs,
      libs: {
        materials: lib.materials, terrainMaterials: lib.terrainMaterials, templates: lib.templates, models: lib.models,
        scripts: lib.scriptAssets, animationFields: lib.animationFields, animations: lib.animations, rigs: lib.rigs,
        tilesets: lib.tilesets, aiBrains: lib.aiBrains, animControllers: lib.animControllers, boneMasks: lib.boneMasks,
        poseAssets: lib.poseAssets, particleSystems: lib.particleSystems, sequences: lib.sequences,
        audioSources: lib.audioSources, soundSamples: lib.soundSamples, images: lib.images, textures: lib.textures,
      },
      scenes: engine.sceneList,
      mainSceneId: engine.mainSceneId || null,
      name: name || folderSession()?.project.name || 'Project',
      settings: engine.projectSettings ?? null,
      inputMap: engine.inputMap ?? null,
    })
  }, [vfs, lib, engine.sceneList, engine.mainSceneId, engine.projectSettings, engine.inputMap, name])

  // Armed once the project has finished loading: before that, libraries still empty would read as deletions.
  const loaded = ready && lib.assetsLoaded && engine.texturesPreloaded && engine.audioPreloaded && engine.isSceneReady
  useEffect(() => { if (loaded) folderSink.arm() }, [loaded])

  // The project's `cleo` package (types, CLI, the headless runtime), in the background.
  useEffect(() => {
    const root = folderSession()?.root
    if (root) void installProjectSdk(root)
  }, [])

  // Thumbnails are not in the folder (they are rendered, and a render differs between machines), so a project
  // read from a folder this cache never saw shows kind icons until they are drawn again — here, one at a time,
  // once the project has loaded, for the kinds whose card is a render.
  const { depsRef } = useVfs()
  useEffect(() => {
    if (!loaded) return
    let cancelled = false
    void (async () => {
      const e = engineRef.current
      const deps = depsRef.current
      if (!e.instance || !deps) return
      const todo: [AssetKind, string][] = [
        ...lib.materials.filter(a => !a.thumbnail).map(a => ['material', a.id] as [AssetKind, string]),
        ...lib.terrainMaterials.filter(a => !(a as any).thumbnail).map(a => ['terrainMaterial', a.id] as [AssetKind, string]),
        ...lib.models.filter(a => !a.thumbnail).map(a => ['model', a.id] as [AssetKind, string]),
        ...lib.particleSystems.filter(a => !(a as any).thumbnail).map(a => ['particleSystem', a.id] as [AssetKind, string]),
      ]
      for (const [kind, id] of todo) {
        if (cancelled) return
        try { await regenerateThumbnail(kind, id, e.instance, depsRef.current) } catch { /* the icon stays */ }
        await new Promise(r => setTimeout(r, 60))
      }
    })()
    return () => { cancelled = true }
    // Once per load: a record saved later renders its own thumbnail.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded])

  // `npm run play` / `npm run debug` (and a launch that asked to play): once loaded, this project can play.
  const engineRef = useRef(engine)
  engineRef.current = engine
  useEffect(() => {
    const s = folderSession()
    if (!loaded || !s) return
    const launch = takeLaunchPlayRequest(activeProjectId())
    if (launch) queuePlay(s.root, launch.debug)
    return setPlayStarter(s.root, async debug => {
      let port: number | undefined
      if (debug) {
        const status = await setVsCodeDebugOverride(true)
        if (!status.listening) return { ok: false, error: status.error ?? 'the VS Code debug port did not open' }
        port = status.port
      }
      // The same gate Play has: a project still opening would play its empty boot scene.
      const deadline = Date.now() + 60_000
      for (;;) {
        const e = engineRef.current
        if (!playBlockedReason({ sceneReady: e.isSceneReady, openSceneId: e.openSceneId, load: currentLoad() })) break
        if (Date.now() > deadline) return { ok: false, error: 'the project did not finish opening' }
        await new Promise(r => setTimeout(r, 250))
      }
      const e = engineRef.current
      const publish = e.projectSettings.publish
      windowPlay().start(e.buildWindowPlayData, {
        width: publish.width, height: publish.height,
        title: publish.title.trim() || folderSession()?.project.name || 'Cleo Game',
      })
      return { ok: true, port }
    })
  }, [loaded])

  // An inspection handle for the desktop's end-to-end harness (app-kit/desktop/tools/projectFolderE2E.mjs) and
  // for the console: the session, the sink's status, and the library actions an edit would use.
  useEffect(() => {
    const handle = { session: () => folderSession(), sink: folderSink, library: lib, armed: loaded, flush: () => folderSink.flushNow() }
    ;(globalThis as any).__cleoProjectFolder = handle
    return () => { if ((globalThis as any).__cleoProjectFolder === handle) delete (globalThis as any).__cleoProjectFolder }
  }, [lib, loaded])

  return <>{children}</>
}

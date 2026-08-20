import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Logger } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import { useVfs } from '../assets/VfsContext'
import { deleteAsset } from '../assets/assetKinds'
import { activeProjectId } from '../../utils/projectScope'
import { scriptWorkspaceOf, setScriptWorkspace } from '../../utils/projects'
import { buildScriptAsset, defaultScriptClass, type ScriptAsset } from '../../utils/scripts'
import {
  advanceState, buildDesiredMirror, planPull, planPush, vfsPathOfRel,
  type ExternalChange, type MirrorState, type PullPlan,
} from '../../utils/scriptMirror'
import {
  applyAdd, applyCreateFolder, applyDelete, applyMoveOne, ancestorsOf, stemOf,
  type VfsIndex,
} from '../../utils/vfs'
import { cryptoRandomId } from '../../utils/ids'
import { getScriptsBridge, hasScriptWorkspace } from './desktopScripts'
import { buildManifest, buildScaffold, readManifest, staticScaffold } from './scaffold'
import { clearExternalSource } from './externalSourceStore'

// Keeps the project's script library and a folder on disk in step, so scripts can be edited in VSCode.
//
// The two directions are deliberately asymmetric. Editor -> disk is DERIVED: a debounced effect over
// (vfs, scriptAssets) recomputes what should be on disk and writes the difference, so every origin is
// covered at once -- a Monaco save, an explorer rename, a duplicate, a bundle import, a merge remap --
// rather than each having to remember to call us. Disk -> editor is an EVENT: the main process reports a
// coalesced changeset, which planPull turns into renames/updates/creates/deletes.
//
// `agreedRef` is the state both sides last agreed on and the pivot for both plans. Keeping it in a ref
// rather than state matters: it is written from an async apply and read by the next push, and a render
// in between would plan against a stale mirror and rewrite files that are already correct.

export type WorkspaceStatus = 'off' | 'connecting' | 'live' | 'paused' | 'error'

/** An external edit that arrived while the same script had unsaved changes in the editor. */
export type ScriptConflict = { scriptId: string; name: string; external: string; mine: string }

type ScriptWorkspaceValue = {
  status: WorkspaceStatus
  rootPath: string | null
  message: string | null
  conflicts: ScriptConflict[]
  /** Pick a folder, scaffold it and start syncing. */
  setup: () => Promise<void>
  /** Stop syncing and forget the folder (the files on disk are left alone). */
  disconnect: () => Promise<void>
  /** Open the workspace in the external editor, optionally selecting one script's file. */
  openInEditor: (scriptId?: string) => Promise<void>
  /** Rewrite every file from the library, discarding whatever is on disk. Resolves a paused workspace. */
  resync: () => Promise<void>
  /** Apply the deletions a paused changeset was holding back. */
  applyPendingDeletions: () => Promise<void>
  /** Resolve a conflict by taking one side. */
  resolveConflict: (scriptId: string, keep: 'external' | 'mine') => void
  available: boolean
}

const ScriptWorkspaceContext = createContext<ScriptWorkspaceValue | null>(null)

export function useScriptWorkspace(): ScriptWorkspaceValue {
  const ctx = useContext(ScriptWorkspaceContext)
  if (!ctx) throw new Error('useScriptWorkspace must be used within a ScriptWorkspaceProvider')
  return ctx
}

const PUSH_DEBOUNCE_MS = 250

export function ScriptWorkspaceProvider({ children }: { children: React.ReactNode }) {
  const engine = useCleoEngine()
  const { vfs, setVfs, depsRef, ready } = useVfs()
  const { scriptAssets, adoptExternalScriptSource, renameScriptAsset, addScriptAsset } = engine

  const [status, setStatus] = useState<WorkspaceStatus>('off')
  const [rootPath, setRootPath] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [conflicts, setConflicts] = useState<ScriptConflict[]>([])

  const agreedRef = useRef<MirrorState>(new Map())
  const rootRef = useRef<string | null>(null)
  const typesHashRef = useRef('')
  const statusRef = useRef<WorkspaceStatus>('off')
  const pushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pushingRef = useRef(false)
  const pendingDeletionsRef = useRef<PullPlan | null>(null)
  /** Fingerprint of the last manifest written, so an unchanged one is not rewritten on every push. */
  const manifestRef = useRef('')
  // The last change reported while paused, so "Apply deletions" has something to act on.

  const available = hasScriptWorkspace()

  const setStatusBoth = useCallback((next: WorkspaceStatus, msg: string | null = null) => {
    statusRef.current = next
    setStatus(next)
    setMessage(msg)
  }, [])

  /* --------------------------------------------------------------------- */
  /* Editor -> disk                                                         */
  /* --------------------------------------------------------------------- */

  /** Latest library + layout, read through refs so the push effect never plans against a stale render. */
  const vfsRef = useRef<VfsIndex>(vfs)
  vfsRef.current = vfs
  const scriptsRef = useRef<ScriptAsset[]>(scriptAssets)
  scriptsRef.current = scriptAssets

  const push = useCallback(async () => {
    const bridge = getScriptsBridge()
    const root = rootRef.current
    if (!bridge || !root || statusRef.current !== 'live' || pushingRef.current) return

    const desired = buildDesiredMirror(vfsRef.current, scriptsRef.current)
    const plan = planPush(agreedRef.current, desired)
    const manifest = buildManifest(activeProjectId(), plan.next, typesHashRef.current)
    const fingerprint = JSON.stringify(manifest)

    // The manifest has to be written even when no FILE changes -- it is the identity record, and the
    // cases that leave the file plan empty are exactly the ones that move it: a script created or edited
    // on disk is already in the right place, so only the id -> path mapping is new. Skipping it there
    // left the workspace with no manifest at all, and the next connect would read those files as brand
    // new, mint fresh asset ids and break `__scriptId` on every node using them.
    if (!plan.filesChanged && fingerprint === manifestRef.current) return

    pushingRef.current = true
    try {
      const res = await bridge.apply(root, {
        deletes: plan.deletes,
        renames: plan.renames,
        writes: plan.writes,
        manifest,
      })
      if (!res.ok) { setStatusBoth('error', res.error ?? 'Could not write to the script workspace.'); return }
      agreedRef.current = plan.next
      manifestRef.current = fingerprint
    } finally {
      pushingRef.current = false
    }
  }, [setStatusBoth])

  const schedulePush = useCallback(() => {
    if (pushTimerRef.current) clearTimeout(pushTimerRef.current)
    pushTimerRef.current = setTimeout(() => { void push() }, PUSH_DEBOUNCE_MS)
  }, [push])

  useEffect(() => {
    if (status !== 'live') return
    schedulePush()
  }, [vfs, scriptAssets, status, schedulePush])

  /* --------------------------------------------------------------------- */
  /* Disk -> editor                                                         */
  /* --------------------------------------------------------------------- */

  /**
   * Place a file that appeared on disk into the VFS at the folder it lives in, minting the asset.
   * Returns the new script id so the agreed state can adopt it.
   */
  const createFromFile = useCallback((rel: string, source: string, baseType: ScriptAsset['baseType']): string => {
    const path = vfsPathOfRel(rel)
    const name = stemOf(path) || 'Script'
    const asset = buildScriptAsset(name, baseType, source || defaultScriptClass(name, baseType), cryptoRandomId())
    addScriptAsset(asset)
    setVfs(v => {
      // The folders the file sits in may not exist in the index yet -- an IDE can create a directory
      // the editor has never seen.
      let next = v
      for (const folder of ancestorsOf(path)) next = applyCreateFolder(next, folder)
      return applyAdd(next, { path, kind: 'script', assetId: asset.id, created: Date.now() })
    })
    return asset.id
  }, [addScriptAsset, setVfs])

  const applyPull = useCallback((plan: PullPlan) => {
    const createdIds = new Map<string, string>()
    const raised: ScriptConflict[] = []

    for (const r of plan.renames) {
      const target = vfsPathOfRel(r.to)
      setVfs(v => {
        let next = v
        for (const folder of ancestorsOf(target)) next = applyCreateFolder(next, folder)
        return applyMoveOne(next, vfsPathOfRel(r.from), target)
      })
      renameScriptAsset(r.scriptId, stemOf(target))
      if (r.sourceChanged) {
        const res = adoptExternalScriptSource(r.scriptId, r.source)
        if (res.replacedUnsaved) raised.push(conflictFor(r.scriptId, r.source))
      }
    }

    for (const u of plan.updates) {
      const res = adoptExternalScriptSource(u.scriptId, u.source)
      if (res.replacedUnsaved) raised.push(conflictFor(u.scriptId, u.source))
    }

    for (const c of plan.creates) createdIds.set(c.rel, createFromFile(c.rel, c.source, c.baseType))

    for (const d of plan.deletes) {
      // The explorer's own delete path, so unlinking every node that referenced the script (and whatever
      // history that records) behaves identically to deleting the card in the Assets tab.
      deleteAsset('script', d.scriptId, depsRef.current)
      setVfs(v => applyDelete(v, [vfsPathOfRel(d.rel)]))
      clearExternalSource(d.scriptId)
    }

    agreedRef.current = advanceState(agreedRef.current, plan, createdIds)
    if (raised.length) setConflicts(prev => [...prev.filter(c => !raised.some(r => r.scriptId === c.scriptId)), ...raised])

    function conflictFor(scriptId: string, external: string): ScriptConflict {
      const asset = scriptsRef.current.find(a => a.id === scriptId)
      return {
        scriptId,
        name: asset?.name ?? 'Script',
        external,
        mine: engine.getScriptTabSource(scriptId) ?? asset?.source ?? '',
      }
    }
  }, [adoptExternalScriptSource, createFromFile, depsRef, engine, renameScriptAsset, setVfs])

  const onExternalChange = useCallback((change: ExternalChange) => {
    if (statusRef.current !== 'live' && statusRef.current !== 'paused') return

    const plan = planPull(agreedRef.current, change)
    if (plan.paused) {
      // Nothing is applied. A vanished folder or a pile of deletions is far more likely to be a git
      // checkout or a moved directory than an intent to drop scripts from every node using them.
      pendingDeletionsRef.current = plan
      setStatusBoth('paused', plan.pauseReason ?? 'Script sync paused.')
      Logger.warn(`Script workspace paused: ${plan.pauseReason}`, 'Editor')
      return
    }
    applyPull(plan)
  }, [applyPull, setStatusBoth])

  // Held in a ref so the IPC subscription below is registered once and never re-registered on a render.
  const onExternalChangeRef = useRef(onExternalChange)
  onExternalChangeRef.current = onExternalChange

  useEffect(() => {
    const bridge = getScriptsBridge()
    if (!bridge) return
    return bridge.onChange(({ root, change }) => {
      if (root !== rootRef.current) return // a workspace from a previous session, already torn down
      onExternalChangeRef.current(change)
    })
  }, [])

  /* --------------------------------------------------------------------- */
  /* Connecting                                                             */
  /* --------------------------------------------------------------------- */

  /**
   * Attach to `root`: scaffold it, recover what a previous session agreed with it, reconcile whatever
   * changed while we were away, then go live.
   */
  const connect = useCallback(async (root: string, announce: boolean) => {
    const bridge = getScriptsBridge()
    if (!bridge) return
    setStatusBoth('connecting')

    const opened = await bridge.open(root)
    if (!opened.ok) { setStatusBoth('error', opened.error ?? 'Could not open the script workspace.'); return }

    const restored = readManifest(opened.manifest, activeProjectId())
    agreedRef.current = restored?.state ?? new Map()

    // The declaration payload only moves when the engine is rebuilt, so skip ~100 writes when it has not.
    const scaffold = await buildScaffold()
    typesHashRef.current = scaffold.typesHash
    const stale = !restored || restored.typesHash !== scaffold.typesHash
    const written = await bridge.writeScaffold(root, stale ? scaffold.files : staticScaffold())
    if (!written.ok) { setStatusBoth('error', written.error ?? 'Could not write the workspace scaffolding.'); return }

    rootRef.current = root
    setRootPath(root)
    statusRef.current = 'live'
    setStatus('live')
    setMessage(null)

    // Whatever the folder holds now is a changeset against what we last agreed with it -- which covers
    // edits made while the editor was closed. Reusing the pull path means the bulk-delete guard applies
    // to those too, so a folder emptied out of session pauses rather than gutting the library.
    const knownRels = new Set([...agreedRef.current.values()].map(v => v.rel))
    const present = new Map(opened.files.map(f => [f.rel, f.source]))
    onExternalChangeRef.current({
      added: opened.files.filter(f => !knownRels.has(f.rel)).map(f => ({ rel: f.rel, source: f.source })),
      changed: opened.files.filter(f => knownRels.has(f.rel)).map(f => ({ rel: f.rel, source: f.source })),
      removed: [...knownRels].filter(rel => !present.has(rel)),
    })

    // Then push whatever the library has that the folder does not.
    await push()
    if (announce) Logger.info(`Scripts are mirrored to ${root}`, 'Editor')
  }, [push, setStatusBoth])

  const setup = useCallback(async () => {
    const bridge = getScriptsBridge()
    if (!bridge) return
    const picked = await bridge.pickFolder()
    if (!picked.ok || !picked.path) return
    await setScriptWorkspace(activeProjectId(), picked.path)
    await connect(picked.path, true)
  }, [connect])

  const disconnect = useCallback(async () => {
    const bridge = getScriptsBridge()
    const root = rootRef.current
    if (bridge && root) await bridge.close(root)
    await setScriptWorkspace(activeProjectId(), undefined)
    rootRef.current = null
    agreedRef.current = new Map()
    manifestRef.current = ''
    pendingDeletionsRef.current = null
    setRootPath(null)
    setConflicts([])
    setStatusBoth('off')
  }, [setStatusBoth])

  /** Reconnect at boot when this project already has a workspace and the folder is still there. */
  useEffect(() => {
    if (!ready || !available) return
    let cancelled = false
    void (async () => {
      const saved = await scriptWorkspaceOf(activeProjectId())
      if (cancelled || !saved.path) return
      const bridge = getScriptsBridge()
      const stat = await bridge?.exists(saved.path)
      if (cancelled) return
      if (!stat?.exists) {
        setStatusBoth('paused', `The script workspace folder is missing: ${saved.path}`)
        setRootPath(saved.path)
        return
      }
      await connect(saved.path, false)
    })()
    return () => { cancelled = true }
  }, [ready, available, connect, setStatusBoth])

  /* --------------------------------------------------------------------- */
  /* Recovery actions                                                       */
  /* --------------------------------------------------------------------- */

  const resync = useCallback(async () => {
    const root = rootRef.current
    const bridge = getScriptsBridge()
    if (!root || !bridge) return
    // Forget the agreement entirely, so planPush treats every script as new and rewrites the folder.
    pendingDeletionsRef.current = null
    agreedRef.current = new Map()
    manifestRef.current = ''
    statusRef.current = 'live'
    setStatus('live')
    setMessage(null)
    await bridge.open(root) // re-arm the watcher if the folder vanished and came back
    await push()
    Logger.info('Script workspace rewritten from the editor', 'Editor')
  }, [push])

  const applyPendingDeletions = useCallback(async () => {
    const plan = pendingDeletionsRef.current
    pendingDeletionsRef.current = null
    statusRef.current = 'live'
    setStatus('live')
    setMessage(null)
    // A root-missing pause carries an empty plan, so applying it is a harmless no-op.
    if (plan) applyPull({ ...plan, paused: false })
    await push()
  }, [applyPull, push])

  const resolveConflict = useCallback((scriptId: string, keep: 'external' | 'mine') => {
    setConflicts(prev => {
      const hit = prev.find(c => c.scriptId === scriptId)
      if (hit && keep === 'mine') {
        // The external edit was already adopted when it arrived, so keeping the editor's version means
        // putting it back -- which the derived push then mirrors to disk.
        adoptExternalScriptSource(scriptId, hit.mine)
      }
      return prev.filter(c => c.scriptId !== scriptId)
    })
  }, [adoptExternalScriptSource])

  const openInEditor = useCallback(async (scriptId?: string) => {
    const bridge = getScriptsBridge()
    const root = rootRef.current
    if (!bridge || !root) return
    // Make sure the file the IDE is about to open is the current one.
    await push()
    const rel = scriptId ? agreedRef.current.get(scriptId)?.rel : undefined
    const saved = await scriptWorkspaceOf(activeProjectId())
    const res = await bridge.launch(root, rel, saved.command)
    if (!res.ok) Logger.error(`Could not open the script workspace: ${res.error}`, 'Editor')
  }, [push])

  const value = useMemo<ScriptWorkspaceValue>(() => ({
    status, rootPath, message, conflicts, available,
    setup, disconnect, openInEditor, resync, applyPendingDeletions, resolveConflict,
  }), [status, rootPath, message, conflicts, available,
    setup, disconnect, openInEditor, resync, applyPendingDeletions, resolveConflict])

  return <ScriptWorkspaceContext.Provider value={value}>{children}</ScriptWorkspaceContext.Provider>
}

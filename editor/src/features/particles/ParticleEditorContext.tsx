import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { ParticleSystemNode, type ParticleSystemDef } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import { useDocument } from '../DocumentContext'
import { useHistory } from '../HistoryContext'
import { PARTICLE_PREVIEW_NODE_NAME, type ParticleSystemAsset } from '../../utils/particleSystems'
import { renderParticleSystemThumbnail } from '../../utils/particleThumbnails'

// The particle authoring session: the working copy of the `.vfx` asset open in the active tab.
//
// Shaped like ClipContext — an immutable working copy in React state, every edit a new object pushed onto
// the tab's undo stack, the library touched only on save. Unlike a clip, every edit is ALSO pushed into the
// tab's preview node at once, and `ParticleSystemNode.setSystem` swaps parameters in under the running
// simulation whenever the pools keep their shape — so dragging a slider bends a live effect rather than
// restarting it sixty times a second.

interface ParticleEditorSession {
  /** The library asset the active tab edits, or null when the active tab is not a particle system. */
  asset: ParticleSystemAsset | null
  /** The working copy. Null exactly when `asset` is. */
  system: ParticleSystemDef | null
  /** The asset's (possibly renamed, unsaved) name. */
  name: string
  /** The emitter whose stack is shown, by id — never by index, which shifts on delete and reorder. */
  emitterId: string | null
  selectEmitter: (id: string | null) => void
  /**
   * Adopt `next` as the working copy and put it on the undo stack. `coalesceKey` merges a burst of
   * edits under one key (a slider drag) into one undo step.
   */
  commit: (next: ParticleSystemDef, label: string, coalesceKey?: string) => void
  rename: (name: string) => void
  save: () => void
  dirty: boolean
  /** The tab's live preview node, looked up fresh: tab switches replace the scene under it. */
  previewNode: () => ParticleSystemNode | null
}

const EMPTY: ParticleEditorSession = {
  asset: null, system: null, name: '', emitterId: null, selectEmitter: () => {},
  commit: () => {}, rename: () => {}, save: () => {}, dirty: false, previewNode: () => null,
}

const ParticleEditorContext = createContext<ParticleEditorSession>(EMPTY)

export function useParticleEditor(): ParticleEditorSession {
  return useContext(ParticleEditorContext)
}

export function ParticleEditorProvider({ children }: { children: React.ReactNode }) {
  const {
    particleSystems, editingParticleSystemId, saveParticleSystem, registerParticleSystemApply, activeTab, instance,
    updateParticleSystem,
  } = useCleoEngine()
  const { markTabDirty, dirtyTabs } = useDocument()
  const { push } = useHistory()

  const [system, setSystem] = useState<ParticleSystemDef | null>(null)
  const [name, setName] = useState('')
  const [emitterId, setEmitterId] = useState<string | null>(null)
  const loadedIdRef = useRef<string | null>(null)
  // The working copy right now, for mutators that run between renders (see ClipContext.assetRef).
  const systemRef = useRef<ParticleSystemDef | null>(null)
  systemRef.current = system

  const asset = editingParticleSystemId
    ? particleSystems.find(p => p.id === editingParticleSystemId) ?? null
    : null
  const tabId = activeTab.kind === 'particleSystem' ? activeTab.id : null

  const previewNode = useCallback((): ParticleSystemNode | null => {
    const scene = instance?.scene
    if (!scene) return null
    for (const node of scene.particleSystems)
      if (node.name === PARTICLE_PREVIEW_NODE_NAME) return node
    return null
  }, [instance])

  // Adopt the tab's asset when the tab changes to a different one — not on every library update, or a
  // save would throw away the working copy that produced it.
  useEffect(() => {
    if (!asset) { loadedIdRef.current = null; systemRef.current = null; setSystem(null); return }
    if (loadedIdRef.current === asset.id) return
    loadedIdRef.current = asset.id
    const copy: ParticleSystemDef = JSON.parse(JSON.stringify(asset.system))
    systemRef.current = copy
    setSystem(copy)
    setName(asset.name)
    setEmitterId(prev => (prev && copy.emitters.some(e => e.id === prev) ? prev : copy.emitters[0]?.id ?? null))
  }, [asset])

  /** Adopt a working copy without recording it — undo and redo use this too. */
  const restore = useCallback((next: ParticleSystemDef, label: string) => {
    systemRef.current = next
    setSystem(next)
    previewNode()?.setSystem(next)
    if (tabId) markTabDirty(tabId, label)
  }, [tabId, markTabDirty, previewNode])

  const commit = useCallback((next: ParticleSystemDef, label: string, coalesceKey?: string) => {
    const before = systemRef.current
    if (!before || next === before) return
    restore(next, label)
    push({ label, coalesceKey, undo: () => restore(before, label), redo: () => restore(next, label) })
  }, [restore, push])

  const rename = useCallback((next: string) => {
    setName(next)
    if (tabId) markTabDirty(tabId, 'Rename')
  }, [tabId, markTabDirty])

  const save = useCallback(() => {
    const current = systemRef.current
    if (!asset || !current) return
    const saved: ParticleSystemAsset = { ...asset, name: name.trim() || asset.name, system: JSON.parse(JSON.stringify(current)) }
    saveParticleSystem(saved)
    // The card follows the save, rendered from what was saved. Not awaited: the save is done either way.
    if (instance) renderParticleSystemThumbnail(instance, saved)
      .then(thumbnail => { if (thumbnail) updateParticleSystem(saved.id, { ...saved, thumbnail }) })
      .catch(() => { /* the kind glyph stays */ })
  }, [asset, name, saveParticleSystem, instance, updateParticleSystem])

  // Ctrl+S and Save All reach this session through the save orchestrator.
  useEffect(() => {
    if (!tabId || !asset) return
    registerParticleSystemApply({ tabId, apply: save })
    return () => registerParticleSystemApply(null)
  }, [tabId, asset, save, registerParticleSystemApply])

  const value = useMemo<ParticleEditorSession>(() => ({
    asset, system, name, emitterId, selectEmitter: setEmitterId, commit, rename, save,
    dirty: !!(tabId && dirtyTabs[tabId]), previewNode,
  }), [asset, system, name, emitterId, commit, rename, save, tabId, dirtyTabs, previewNode])

  return <ParticleEditorContext.Provider value={value}>{children}</ParticleEditorContext.Provider>
}

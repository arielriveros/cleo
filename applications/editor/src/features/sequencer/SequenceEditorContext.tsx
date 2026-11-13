import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  Logger, SequenceNode, asDerived, captureVisibility, compilePropertyPath, keyableProperties, markEditorOwned, sameKeyValue,
} from 'cleo'
import type { KeyableProperty, Node, SequenceData } from 'cleo'
import { toast } from '@cleo/app-kit/feedback/toastStore'
import { useCleoEngine } from '../EngineContext'
import { useHistory } from '../HistoryContext'
import { SCENE_TAB_ID } from '../engineContextTypes'
import type { EditorTab } from '../engineContextTypes'
import { SEQUENCE_PREVIEW_NODE_NAME, firstNodeLinking, toRuntimeSequence } from '../../utils/sequenceAssets'
import type { SequenceAsset } from '../../utils/sequenceAssets'
import { useSequencePreview, type SequencePreview } from './useSequencePreview'
import { onSequencePreviewsResumed, registerSequencePreview, sequencePreviewsSuspended, setSequenceKeying } from './previewRegistry'
import { registerSequenceWorkingCopies } from './workingCopies'
import { conflictingTrack, keyProperties, type KeyChange } from './autoKey'

// Sequencer mode: a `.sequence` asset edited in its own tab, over the OPEN scene.
//
// The tab owns no scene. While it is active the editor shows the scene the scene tab has open, and an
// editor-owned Sequence node (the preview HOST, never saved) plays this tab's working copy against it, borrowing
// the slot bindings of the Sequence node the tab was opened from. The Sequencer panel edits the working copy;
// the Keys card reads it; and AUTO-KEY turns every property change the user makes to a node — in the inspector,
// with the gizmo, on the tree's eye — into a key at the playhead instead of an edit of the scene.
//
// Working copies are kept PER TAB, so switching away and back loses nothing, and Save All reaches any of them.
// Leaving the tab puts the scene back exactly as authored (the preview's restore), removes the host, and the
// next activation rebuilds it once the tab is fully in place (TAB_APPLIED).

interface TabDoc {
  assetId: string
  draft: SequenceData
  /** The playhead, kept while the tab is away. */
  time: number
  contextNodeId: string | null
}

/** What auto-key captured as an interaction started: the node's keyable values, and the time to key at. */
interface Capture {
  nodeId: string
  t: number
  props: Map<string, KeyableProperty>
  /** Puts the node's whole subtree's own visibility flags back (a `visible` write recurses into children). */
  restoreVisibility: (() => void) | null
}

export interface SequenceEditorValue {
  /** The active Sequencer tab's id, or null when the active tab is not one. */
  tabId: string | null
  asset: SequenceAsset | null
  /** The working copy. */
  seq: SequenceData | null
  /** The preview host: the editor-owned Sequence node playing the working copy in the open scene. */
  host: SequenceNode | null
  preview: SequencePreview
  /** Record `next` as one undo step. `before`: what to undo to, when a drag already showed `next` live. */
  commit: (label: string, next: SequenceData, before?: SequenceData, coalesceKey?: string) => Promise<void>
  /** Show `next` without recording it (a drag in progress). */
  live: (next: SequenceData) => void
  /** The slot whose node (through the host's bindings, the slot's own nodeId or its path) is `node`. */
  slotOfNode: (node: Node) => string | undefined
  /** Finish a field edit in progress (it keys at the time it started) before the playhead moves. */
  settleEdits: () => void
}

const SequenceEditorContext = createContext<SequenceEditorValue | null>(null)
/** Bumped after every paused seek: what the node inspector re-reads its values on. */
const SequenceRevisionContext = createContext(0)

export function useSequenceEditor(): SequenceEditorValue {
  const ctx = useContext(SequenceEditorContext)
  if (!ctx) throw new Error('useSequenceEditor must be used within a SequenceEditorProvider')
  return ctx
}

/** The preview revision, or 0 outside Sequencer mode. */
export function useSequenceRevision(): number {
  return useContext(SequenceRevisionContext)
}

/** A node's name path from the scene root, the slot's fallback binding ("Buildings/Long House"). */
export function namePathOf(node: Node, root: Node): string {
  const parts: string[] = []
  for (let n: Node | null = node; n && n !== root; n = n.parent) parts.unshift(n.name)
  return parts.join('/')
}

/** Marks the panels whose edits auto-key (Properties, the scene tree): an interaction starts with a press there. */
export const KEYING_ROOT_ATTR = 'data-sequence-keying'

const isFieldFocused = () => {
  const el = document.activeElement as HTMLElement | null
  return !!el && !!el.closest(`[${KEYING_ROOT_ATTR}]`) && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

export function SequenceEditorProvider({ children }: { children: React.ReactNode }) {
  const {
    activeTab, tabs, editorScene, withoutDirty, isDirtySuppressed, eventEmitter, markTabDirty, clearTabDirty,
    registerSequenceApply, saveSequence, sequences, isPlayMode, selectedNode, dirtyTabs,
  } = useCleoEngine()
  const history = useHistory()

  const docs = useRef(new Map<string, TabDoc>())
  const [, setVersion] = useState(0)
  const bump = useCallback(() => setVersion(v => v + 1), [])
  const [revision, setRevision] = useState(0)

  const tabId = activeTab.kind === 'sequence' ? activeTab.id : null
  const tabIdRef = useRef(tabId)
  tabIdRef.current = tabId
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const sequencesRef = useRef(sequences)
  sequencesRef.current = sequences
  const sceneRef = useRef(editorScene)
  sceneRef.current = editorScene
  const playRef = useRef(isPlayMode)
  playRef.current = isPlayMode

  /** The tab's document, made from the library asset the first time the tab is shown. */
  const docOf = useCallback((tab: EditorTab | undefined): TabDoc | null => {
    if (!tab || tab.kind !== 'sequence' || !tab.sequenceId) return null
    let doc = docs.current.get(tab.id)
    if (!doc || doc.assetId !== tab.sequenceId) {
      const asset = sequencesRef.current.find(q => q.id === tab.sequenceId)
      if (!asset) return null
      doc = { assetId: asset.id, draft: toRuntimeSequence(asset), time: 0, contextNodeId: tab.sequenceContextNodeId ?? null }
      docs.current.set(tab.id, doc)
    }
    if (tab.sequenceContextNodeId && doc.contextNodeId !== tab.sequenceContextNodeId) doc.contextNodeId = tab.sequenceContextNodeId
    return doc
  }, [])

  const doc = docOf(activeTab)
  const asset = doc ? sequences.find(q => q.id === doc.assetId) ?? null : null

  // Closed tabs drop their working copies.
  useEffect(() => {
    const live = new Set(tabs.map(t => t.id))
    for (const id of [...docs.current.keys()]) if (!live.has(id)) docs.current.delete(id)
  }, [tabs])

  // ---- the preview host ----------------------------------------------------------------------------------

  const [host, setHost] = useState<SequenceNode | null>(null)
  const hostRef = useRef<SequenceNode | null>(null)
  /** The tab the host plays for, so its stop can keep that tab's playhead. */
  const hostTabRef = useRef<string | null>(null)
  const preview = useSequencePreview(host, editorScene, withoutDirty)
  const previewRef = useRef(preview)
  previewRef.current = preview
  const wantApplyRef = useRef(false)
  const unregisterStop = useRef<(() => void) | null>(null)
  const captureRef = useRef<Capture | null>(null)

  // Stable: the callbacks below are held by the preview registry and by event listeners across renders.
  const withoutDirtyRef = useRef(withoutDirty)
  withoutDirtyRef.current = withoutDirty
  const wrap = useCallback(<T,>(fn: () => T): T => withoutDirtyRef.current(() => asDerived(fn)), [])

  /** Hand the scene back and take the host out (the registered stopper: tab switch, save, Play, openScene). */
  const stopAndRemove = useCallback(() => {
    const h = hostRef.current
    const owner = hostTabRef.current ? docs.current.get(hostTabRef.current) : undefined
    if (owner) owner.time = previewRef.current.timeRef.current
    previewRef.current.stop()
    captureRef.current = null
    if (h) {
      hostRef.current = null
      hostTabRef.current = null
      setSequenceKeying(false)
      wrap(() => { if (h.parent) h.parent.removeChild(h) })
      setHost(null)
    }
    unregisterStop.current?.()
    unregisterStop.current = null
  }, [wrap])

  /** Put the active tab's host in the open scene, playing its working copy, and show the playhead. */
  const activate = useCallback(() => {
    const id = tabIdRef.current
    if (!id || playRef.current || sequencePreviewsSuspended()) return
    const d = docOf(tabsRef.current.find(t => t.id === id))
    if (!d) return
    const scene = sceneRef.current
    let h = hostRef.current
    if (h && (h.scene !== scene || hostTabRef.current !== id)) { stopAndRemove(); h = null }
    if (!h) {
      const ctxNode = d.contextNodeId ? scene.getNodeById(d.contextNodeId) : null
      const borrow = ctxNode instanceof SequenceNode && !ctxNode.isEditorOwned ? ctxNode : firstNodeLinking(scene, d.assetId)
      h = markEditorOwned(new SequenceNode(SEQUENCE_PREVIEW_NODE_NAME, {
        sequence: structuredClone(d.draft), bindings: borrow ? { ...borrow.bindings } : {},
      })) as SequenceNode
      wrap(() => scene.addNode(h!))
      hostRef.current = h
      hostTabRef.current = id
      setSequenceKeying(true)
      unregisterStop.current = registerSequencePreview(stopAndRemove)
      setHost(h)
    }
    wantApplyRef.current = true
    bump()
  }, [docOf, stopAndRemove, wrap, bump])

  // Once the host is the preview's node (a render later), seek it to the tab's playhead.
  useEffect(() => {
    if (!wantApplyRef.current || !host || hostRef.current !== host) return
    wantApplyRef.current = false
    const d = hostTabRef.current ? docs.current.get(hostTabRef.current) : undefined
    preview.seek(d?.time ?? 0)
    setRevision(r => r + 1)
  })

  // Activation: after the tab is fully applied (applyActiveTab stops every preview on its way), and when a save
  // releases its hold. Leaving is the registered stopper's job.
  useEffect(() => {
    const onApplied = (id: string) => {
      if (tabsRef.current.find(t => t.id === id)?.kind === 'sequence') activate()
    }
    eventEmitter.on('TAB_APPLIED', onApplied)
    const offResume = onSequencePreviewsResumed(() => { if (tabIdRef.current) activate() })
    return () => { eventEmitter.off('TAB_APPLIED', onApplied); offResume() }
  }, [eventEmitter, activate])

  // Never leave a host behind on unmount (only then: a cleanup keyed on the callback would run on every render
  // that rebuilt it, and take the host away as soon as it was added).
  const stopAndRemoveRef = useRef(stopAndRemove)
  stopAndRemoveRef.current = stopAndRemove
  useEffect(() => () => stopAndRemoveRef.current(), [])

  // ---- editing the working copy -------------------------------------------------------------------------

  /** Make `data` the working copy of `id` and show it. */
  const setDraft = useCallback((id: string, data: SequenceData) => {
    const d = docs.current.get(id)
    if (!d) return
    d.draft = data
    const h = hostRef.current
    if (h && hostTabRef.current === id) {
      wrap(() => { h.sequence = data })
      previewRef.current.refresh()
    }
    bump()
  }, [wrap, bump])

  // A clean working copy follows its asset when the library changes under it (a rename, a bundle import);
  // an edited one is the user's and is kept.
  useEffect(() => {
    for (const [id, d] of docs.current) {
      if (dirtyTabs[id]) continue
      const a = sequences.find(q => q.id === d.assetId)
      if (!a) continue
      const next = toRuntimeSequence(a)
      if (JSON.stringify(next) !== JSON.stringify(d.draft)) setDraft(id, next)
    }
  }, [sequences]) // eslint-disable-line react-hooks/exhaustive-deps

  const commit = useCallback(async (label: string, next: SequenceData, before?: SequenceData, coalesceKey?: string) => {
    const id = tabIdRef.current
    const d = id ? docs.current.get(id) : undefined
    if (!id || !d) return
    const prev = before ?? d.draft
    setDraft(id, next)
    markTabDirty(id, 'sequence-edit')
    history.push({
      label: `Sequence: ${label}`,
      undo: () => { setDraft(id, prev); markTabDirty(id, 'sequence-undo') },
      redo: () => { setDraft(id, next); markTabDirty(id, 'sequence-redo') },
      ...(coalesceKey ? { coalesceKey } : {}),
    })
  }, [setDraft, markTabDirty, history])

  const live = useCallback((next: SequenceData) => {
    const id = tabIdRef.current
    if (id) setDraft(id, next)
  }, [setDraft])

  const slotOfNode = useCallback((node: Node): string | undefined => {
    const h = hostRef.current
    const d = hostTabRef.current ? docs.current.get(hostTabRef.current) : undefined
    if (!h || !d) return undefined
    return d.draft.slots.find(s => h.resolveSlot(s.id) === node)?.id
  }, [])

  // ---- saving, and Play -------------------------------------------------------------------------------

  useEffect(() => {
    registerSequenceApply({
      save: (id: string) => {
        const tab = tabsRef.current.find(t => t.id === id)
        if (!tab || tab.kind !== 'sequence') return false
        const a = sequencesRef.current.find(q => q.id === tab.sequenceId)
        if (!a) return false
        const d = docs.current.get(id)
        if (!d) { clearTabDirty(id); return true }
        saveSequence({ ...a, sequence: { ...structuredClone(d.draft), name: a.name } })
        return true
      },
    })
    return () => registerSequenceApply(null)
  }, [registerSequenceApply, saveSequence, clearTabDirty])

  useEffect(() => registerSequenceWorkingCopies(() => {
    const out = new Map<string, SequenceData>()
    for (const d of docs.current.values()) out.set(d.assetId, d.draft)
    return out
  }), [])

  // ---- auto-key -----------------------------------------------------------------------------------------

  const selectedRef = useRef(selectedNode)
  selectedRef.current = selectedNode
  const draggingRef = useRef(false)
  const pendingRef = useRef(false)
  /** The pending change named the captured node (so a change with nothing keyable was a scene edit). */
  const namedRef = useRef(false)
  const warnedRef = useRef(new Set<string>())

  /** Take what the node looks like now, before the user changes it, and the time a change will key at. */
  const capture = useCallback((nodeId: string | null) => {
    if (!tabIdRef.current || !hostRef.current || !nodeId) { captureRef.current = null; return }
    const node = sceneRef.current.getNodeById(nodeId)
    if (!node || node.isEditorOwned) { captureRef.current = null; return }
    captureRef.current = {
      nodeId, t: previewRef.current.timeRef.current,
      props: new Map(keyableProperties(node).map(p => [p.path, p])),
      restoreVisibility: captureVisibility(node),
    }
  }, [])

  /** Diff the captured node and key what changed. Returns whether anything was keyed. */
  const keyChanges = useCallback((): boolean => {
    pendingRef.current = false
    const cap = captureRef.current
    const id = tabIdRef.current
    const d = id ? docs.current.get(id) : undefined
    const h = hostRef.current
    if (!cap || !d || !h) return false
    const node = sceneRef.current.getNodeById(cap.nodeId)
    if (!node) return false
    const changes: KeyChange[] = []
    for (const p of keyableProperties(node)) {
      const b = cap.props.get(p.path)
      if (b && !sameKeyValue(b.value, p.value)) changes.push({ path: p.path, valueType: p.valueType, before: b.value, after: p.value })
    }
    if (!changes.length) return false

    const slotId = slotOfNode(node)
    // A path track drives this node's position and rotation every frame: a key under it would never show.
    const refused = changes.filter(c => conflictingTrack(d.draft, slotId, c.path))
    const keyed = changes.filter(c => !refused.includes(c))
    // Put what the user changed back first, so the player records the AUTHORED value as its original for a
    // property it has not touched before (a stop must restore the scene as it was, not the edit).
    wrap(() => {
      for (const c of changes) {
        if (c.path === 'visible' && cap.restoreVisibility) cap.restoreVisibility()
        else compilePropertyPath(node, c.path).set(c.before)
      }
    })
    if (refused.length) {
      const track = conflictingTrack(d.draft, slotId, refused[0].path)!
      toast.info(`"${node.name}" ${refused.map(c => c.path).join(' and ')} follow the "${track.name}" path track: move its points instead.`)
    }
    if (keyed.length) {
      const result = keyProperties(d.draft, {
        id: node.id, name: node.name, nodeType: node.nodeType, path: namePathOf(node, sceneRef.current.root),
      }, keyed, cap.t, slotId)
      const paths = keyed.map(c => c.path)
      void commit(`Key ${node.name} ${paths.join(', ')}`, result.seq, undefined, `key:${node.id}:${paths.join('|')}:${cap.t}`)
      if (result.blended) toast.info('Keyed inside an ease or under an overlapping section: the frame blends, so it shows less than the value keyed.')
    } else {
      previewRef.current.refresh()
    }
    // What the node shows now (the keyed values, re-applied) is the next change's "before". Same time: an
    // interaction in progress (a slider drag) keeps keying where it started.
    const t = cap.t
    capture(cap.nodeId)
    if (captureRef.current) captureRef.current.t = t
    return keyed.length > 0
  }, [wrap, slotOfNode, commit, capture])

  const settleEdits = useCallback(() => {
    if (isFieldFocused()) (document.activeElement as HTMLElement).blur()
    if (pendingRef.current) keyChanges()
  }, [keyChanges])

  // Interactions start with a press (or a focus) inside a keying panel, or a gizmo drag.
  useEffect(() => {
    if (!tabId) return
    const onPress = (e: Event) => {
      const el = e.target as HTMLElement | null
      if (!el?.closest?.(`[${KEYING_ROOT_ATTR}]`)) return
      // A press inside a field already being edited is part of the same interaction.
      if (captureRef.current && pendingRef.current) return
      capture(selectedRef.current)
    }
    document.addEventListener('pointerdown', onPress, true)
    document.addEventListener('focusin', onPress, true)
    return () => {
      document.removeEventListener('pointerdown', onPress, true)
      document.removeEventListener('focusin', onPress, true)
    }
  }, [tabId, capture])

  useEffect(() => {
    if (!tabId) return
    const onDragStart = (p: { nodeId?: string | null } | undefined) => {
      draggingRef.current = true
      if (previewRef.current.playing) previewRef.current.pause()
      capture(p?.nodeId ?? selectedRef.current)
    }
    const onDragEnd = () => {
      draggingRef.current = false
      // The gizmo can end its drag as it unmounts on the way out of the tab: that change is not this tab's.
      if (!tabIdRef.current || !hostRef.current) { captureRef.current = null; return }
      keyChanges()
    }
    const onChanged = (e?: { node?: Node; kind?: string; editorOwned?: boolean; scene?: unknown }) => {
      if (!tabIdRef.current || !hostRef.current || playRef.current || isDirtySuppressed()) return
      if (e?.editorOwned) return
      if (e?.scene !== undefined && e.scene !== sceneRef.current) return
      if (draggingRef.current) return
      // The tree's eye toggles visibility of any node, selected or not.
      if (e?.kind === 'visibility' && e.node && captureRef.current?.nodeId !== e.node.id) {
        const n = e.node
        const props = new Map(keyableProperties(n).map(p => [p.path, p]))
        props.set('visible', { path: 'visible', valueType: 'bool', value: !n.authoredVisible })
        captureRef.current = { nodeId: n.id, t: previewRef.current.timeRef.current, props, restoreVisibility: null }
      }
      // A change with no interaction open is nothing the user did here (a tab switch, a re-embed).
      if (!captureRef.current) return
      const named = e?.node && e.node.id === captureRef.current.nodeId ? e.node : null
      if (named) namedRef.current = true
      if (pendingRef.current) return
      pendingRef.current = true
      queueMicrotask(() => {
        if (!pendingRef.current) return
        const keyed = keyChanges()
        // The node the user is editing changed, and none of it was a keyable property: it changed the scene
        // itself (a control the Sequencer lock does not cover). Not lost silently: the scene is left unsaved.
        if (!keyed && namedRef.current && captureRef.current) {
          const node = sceneRef.current.getNodeById(captureRef.current.nodeId)
          markTabDirty(SCENE_TAB_ID, 'sequence-unkeyed')
          if (node && !warnedRef.current.has(node.id)) {
            warnedRef.current.add(node.id)
            Logger.warn(`"${node.name}" changed in a way Sequencer mode can't key: the scene itself changed (it is marked unsaved).`, 'Editor')
          }
        }
        namedRef.current = false
      })
    }
    eventEmitter.on('GIZMO_DRAG_START', onDragStart)
    eventEmitter.on('GIZMO_DRAG_END', onDragEnd)
    eventEmitter.on('SCENE_CHANGED', onChanged)
    return () => {
      eventEmitter.off('GIZMO_DRAG_START', onDragStart)
      eventEmitter.off('GIZMO_DRAG_END', onDragEnd)
      eventEmitter.off('SCENE_CHANGED', onChanged)
    }
  }, [tabId, eventEmitter, capture, keyChanges, isDirtySuppressed, markTabDirty])

  // A new selection is a new subject: what was captured belongs to the old one.
  useEffect(() => { captureRef.current = null }, [selectedNode, tabId])

  // ---- the inspector's refresh ------------------------------------------------------------------------

  // Preview writes raise no events, so the inspector re-reads on this revision: after every paused seek, and
  // when playback pauses. Never while a field has focus (it would lose what is being typed).
  const seekRaw = preview.seek
  const seek = useCallback((t: number) => {
    seekRaw(t)
    captureRef.current = null
    if (!previewRef.current.playing && !isFieldFocused()) setRevision(r => r + 1)
  }, [seekRaw])
  const wasPlaying = useRef(false)
  useEffect(() => {
    if (wasPlaying.current && !preview.playing && !isFieldFocused()) setRevision(r => r + 1)
    wasPlaying.current = preview.playing
  }, [preview.playing])

  const wrappedPreview = useMemo<SequencePreview>(() => ({ ...preview, seek }), [preview, seek])

  const value = useMemo<SequenceEditorValue>(() => ({
    tabId, asset, seq: doc?.draft ?? null, host, preview: wrappedPreview, commit, live, slotOfNode, settleEdits,
  }), [tabId, asset, doc?.draft, host, wrappedPreview, commit, live, slotOfNode, settleEdits])

  return (
    <SequenceEditorContext.Provider value={value}>
      <SequenceRevisionContext.Provider value={tabId ? revision : 0}>
        {children}
      </SequenceRevisionContext.Provider>
    </SequenceEditorContext.Provider>
  )
}

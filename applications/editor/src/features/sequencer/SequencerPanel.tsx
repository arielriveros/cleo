import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isTextEntryEvent } from 'cleo'
import type { SequenceData, SequenceSlot, SequenceTrack } from 'cleo'
import {
  Button, ContextMenu, MenuItem, Popover, FilmIcon, LoopIcon, PauseIcon, PilotIcon, PlayIcon, SnapIcon, StepBackIcon,
  StepForwardIcon, StopIcon, ToEndIcon, ToStartIcon, cn,
} from '@cleo/app-kit/ui'
import { TimeRuler, fitZoom, formatTimecode, snapTime, startPointerDrag, timeToX, xToTime, zoomStep } from '@cleo/app-kit/timeline'
import { promptDialog } from '@cleo/app-kit/feedback/dialogStore'
import { toast } from '@cleo/app-kit/feedback/toastStore'
import { useCleoEngine } from '../EngineContext'
import { useAssetLibrary } from '../AssetLibraryContext'
import { settableProps } from '../agentBridge/inspect'
import { SequenceIcon } from '../sceneInspector/nodeIcons'
import * as E from './sequenceEdits'
import { downloadSequence, pickSequenceFile } from './sequenceFile'
import { namePathOf, useSequenceEditor } from './SequenceEditorContext'
import { newSectionInit, slotTrackOffers } from './slotTargets'
import SequenceDetails, { type Selection } from './SequenceDetails'
import { openRenderMovie } from './movie/movieDialogStore'

// The Sequencer: the timeline of the `.sequence` asset the active Sequencer tab edits, docked in the bottom strip
// of Sequencer mode (the only mode that shows it). The working copy, its preview over the open scene and the
// auto-key that turns property changes into keys live in SequenceEditorProvider.
//
//   toolbar   transport (start, frame back, play, frame forward, end, loop), the time, snap, zoom, Pilot,
//             + Track, export and import, and Render (movie/RenderMovieDialog.tsx)
//   outliner  one group per slot (its tracks under it) and one for the sequence's own tracks
//   lanes     sections as blocks (drag to move, edges to trim, top corners to ease), keys as diamonds,
//             markers on the ruler; the ruler scrubs
//   details   whatever is selected, editable
//
// Every edit goes through `commit`: a new SequenceData made the tab's working copy and pushed onto its undo
// stack as one step (see sequenceEdits.ts). A drag shows live and records once, on release.

const OUTLINER_W = 210
const RULER_H = 24
const ROW_H = 26
const GROUP_H = 22
const GUTTER = 10
const ZOOM_KEY = 'cleo_sequencer_zoom'
const EDGE_PX = 6
/** A sequence runs for minutes: let the zoom go far enough out to show all of one. */
const MIN_ZOOM = 1

type Row =
  | { kind: 'group'; key: string; label: string; detail?: string; slot?: SequenceSlot }
  | { kind: 'track'; key: string; track: SequenceTrack }

const TRACK_COLORS: Record<SequenceTrack['type'], string> = {
  path: 'bg-primary/55 border-primary',
  cameraCut: 'bg-warning/45 border-warning',
  property: 'bg-success/50 border-success',
  event: 'bg-highlight/50 border-highlight',
  preset: 'bg-axis-z/45 border-axis-z',
  foliage: 'bg-axis-y/40 border-axis-y',
  script: 'bg-node-ui/35 border-node-ui',
  animation: 'bg-axis-x/35 border-axis-x',
  audio: 'bg-success-fg/30 border-success-fg',
  spawn: 'bg-danger/35 border-danger',
  possess: 'bg-muted/30 border-muted',
}

const trackLabel = (t: SequenceTrack): string => {
  if (t.name) return t.name
  if (t.type === 'path') return 'Path'
  if (t.type === 'cameraCut') return 'Camera cut'
  if (t.type === 'event') return 'Events'
  if (t.type === 'preset') return 'Presets'
  if (t.type === 'foliage') return t.layers === 'all' ? 'Foliage (all layers)' : `Foliage (${t.layers.length} layer${t.layers.length === 1 ? '' : 's'})`
  if (t.type === 'script') return t.slot ? 'Script' : 'Director script'
  if (t.type === 'animation') return t.animSlot && t.animSlot !== 'Sequence' ? `Animation (${t.animSlot})` : 'Animation'
  if (t.type === 'audio') return 'Audio'
  if (t.type === 'spawn') return 'Spawn'
  if (t.type === 'possess') return 'Possess'
  return t.target ? `${t.target}.${t.path}` : t.path
}

/**
 * The slot a track drives, when it drives one (a renderer or game property, the cut, events, spawns and the
 * director's script do not).
 */
const slotOf = (t: SequenceTrack): string | undefined =>
  t.type === 'cameraCut' || t.type === 'event' || t.type === 'spawn' || (t.type === 'property' && t.target) ? undefined : t.slot || undefined

/** What a section block reads: its label, else what it does. */
function sectionText(seq: SequenceData, t: SequenceTrack, s: any): string {
  if (s.label) return s.label
  if (t.type === 'cameraCut') return seq.slots.find(sl => sl.id === s.slot)?.name ?? s.slot
  if (t.type === 'path') return `${s.points?.length ?? 0} points`
  if (t.type === 'preset') return s.from ? `${s.from} → ${s.preset}` : `→ ${s.preset}`
  if (t.type === 'foliage') return ['density', 'cull', 'billboard', 'shadows'].filter(c => s[c]).join(' · ')
  if (t.type === 'script') return `${s.method}()`
  if (t.type === 'animation') return s.clip
  if (t.type === 'audio') return 'Audio'
  if (t.type === 'spawn') return s.template
  if (t.type === 'possess') return seq.slots.find(sl => sl.id === s.pawn)?.name ?? s.pawn
  return ''
}

export default function SequencerPanel({ active }: { active: boolean }) {
  const { editorScene, eventEmitter } = useCleoEngine()
  const { templates } = useAssetLibrary()
  const templateNames = useMemo(() => templates.map(t => t.name), [templates])
  const ed = useSequenceEditor()
  const [, setVersion] = useState(0)
  const bump = useCallback(() => setVersion(v => v + 1), [])
  const [sel, setSel] = useState<Selection>(null)
  const [snap, setSnap] = useState(true)
  const [pxPerSec, setPxPerSec] = useState(() => Number(localStorage.getItem(ZOOM_KEY)) || 40)
  const [menu, setMenu] = useState<{ x: number; y: number; items: { label: string; danger?: boolean; run: () => void }[] } | null>(null)
  const lanesRef = useRef<HTMLDivElement>(null)
  const rulerRef = useRef<HTMLDivElement>(null)
  const outlinerRef = useRef<HTMLDivElement>(null)
  const playheadRef = useRef<HTMLDivElement>(null)
  const playheadHeadRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ left: 0, width: 800 })
  useEffect(() => { try { localStorage.setItem(ZOOM_KEY, String(pxPerSec)) } catch { /* quota */ } }, [pxPerSec])

  // The preview host: the editor-owned Sequence node playing the working copy in the open scene. It resolves
  // the slots (through the borrowed bindings, each slot's own node and its path).
  const node = ed.host
  const seq = ed.seq
  const preview = ed.preview
  const commit = ed.commit
  const live = ed.live
  const targetId = ed.tabId

  // Re-read on structure (a bound node renamed or removed), which changes what the outliner shows.
  useEffect(() => {
    const on = (e: any) => { if (!e || e.kind === 'structure' || e.kind === 'name') bump() }
    eventEmitter.on('SCENE_CHANGED', on)
    return () => { eventEmitter.off('SCENE_CHANGED', on) }
  }, [eventEmitter, bump])
  // A new tab, a new timeline: nothing of the old one stays selected.
  useEffect(() => { setSel(null) }, [targetId])

  // ---- rows ---------------------------------------------------------------------------------------------

  const rows = useMemo<Row[]>(() => {
    if (!seq) return []
    const out: Row[] = []
    // Slots a spawn fills while it lives: unbound in the editor, and that is fine.
    const spawned = new Set(seq.tracks.flatMap(t => (t.type === 'spawn' ? t.sections.map(s => s.bindAs) : [])))
    for (const slot of seq.slots) {
      const bound = node?.resolveSlot(slot.id)
      const detail = bound ? bound.name : slot.path ? `(${slot.path})` : spawned.has(slot.id) ? '(spawned)' : '(unbound)'
      out.push({ kind: 'group', key: `slot:${slot.id}`, label: slot.name, detail, slot })
      for (const t of seq.tracks) if (slotOf(t) === slot.id) out.push({ kind: 'track', key: t.id, track: t })
    }
    const own = seq.tracks.filter(t => { const slot = slotOf(t); return !slot || !seq.slots.some(s => s.id === slot) })
    if (own.length) {
      out.push({ kind: 'group', key: 'sequence', label: 'Sequence' })
      for (const t of own) out.push({ kind: 'track', key: t.id, track: t })
    }
    return out
  }, [seq, node])

  const rowTop = useMemo(() => {
    const tops: number[] = []
    let y = 0
    for (const r of rows) { tops.push(y); y += r.kind === 'group' ? GROUP_H : ROW_H }
    return { tops, height: y }
  }, [rows])

  const duration = seq?.duration ?? 10
  const fps = seq?.fps ?? 30
  const contentW = timeToX(duration, pxPerSec, GUTTER) + 200
  const x = (t: number) => timeToX(t, pxPerSec, GUTTER)
  const tAt = (clientX: number) => {
    const el = lanesRef.current
    if (!el) return 0
    return xToTime(clientX, el.getBoundingClientRect().left, el.scrollLeft, pxPerSec, GUTTER)
  }
  const snapped = (t: number, except?: E.SectionRef) =>
    snap && seq ? snapTime(t, [...E.snapTargets(seq, except), preview.timeRef.current], pxPerSec, 6, fps) : t

  // ---- the playhead, drawn every frame without re-rendering -------------------------------------------

  useEffect(() => {
    let raf = 0
    const tick = () => {
      const left = `${timeToX(preview.timeRef.current, pxPerSec, GUTTER)}px`
      if (playheadRef.current) playheadRef.current.style.left = left
      if (playheadHeadRef.current) playheadHeadRef.current.style.left = left
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [pxPerSec, preview.timeRef])

  // Keep the ruler and the outliner scrolled with the lanes, and know the visible range for the ruler.
  const onLanesScroll = () => {
    const el = lanesRef.current
    if (!el) return
    if (rulerRef.current) rulerRef.current.scrollLeft = el.scrollLeft
    if (outlinerRef.current) outlinerRef.current.scrollTop = el.scrollTop
    setView({ left: el.scrollLeft, width: el.clientWidth })
  }
  useEffect(() => { onLanesScroll() }, [pxPerSec, targetId])

  // Ctrl+wheel zooms about the pointer. A native listener: React's wheel handler is passive and cannot stop
  // the page zooming.
  useEffect(() => {
    const el = lanesRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const t = xToTime(e.clientX, el.getBoundingClientRect().left, el.scrollLeft, pxPerSec, GUTTER)
      const next = zoomStep(pxPerSec, e.deltaY, 1.15, MIN_ZOOM)
      setPxPerSec(next)
      // Keep the time under the pointer where it is.
      requestAnimationFrame(() => { el.scrollLeft = Math.max(0, timeToX(t, next, GUTTER) - (e.clientX - el.getBoundingClientRect().left)) })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [pxPerSec, targetId])

  const fit = () => { const el = lanesRef.current; if (el) setPxPerSec(fitZoom(el.clientWidth, duration, GUTTER, 40, MIN_ZOOM)) }

  // ---- pointer interactions ---------------------------------------------------------------------------

  const scrubFrom = (e: React.PointerEvent) => {
    if (!seq) return
    e.preventDefault()
    // A field still being typed in keys at the time it was started, not where the ruler is about to go.
    ed.settleEdits()
    preview.pause()
    const go = (clientX: number) => {
      const t = tAt(clientX)
      preview.seek(Math.min(duration, snap ? Math.round(t * fps) / fps : t))
    }
    go(e.clientX)
    startPointerDrag(e, { threshold: 0, onMove: (_dx, _dy, ev) => go(ev.clientX) })
  }

  /** Press on a section: a click selects it, a drag moves or trims it (or sets an ease, from a top corner). */
  const pressSection = (e: React.PointerEvent, track: SequenceTrack, sectionId: string) => {
    if (!seq || e.button !== 0) return
    e.stopPropagation()
    const ref = { trackId: track.id, sectionId }
    const s = E.findSection(seq, ref)
    if (!s) return
    const el = e.currentTarget as HTMLElement
    const r = el.getBoundingClientRect()
    const local = e.clientX - r.left, fromTop = e.clientY - r.top
    const mode: 'move' | 'start' | 'end' | 'easeIn' | 'easeOut' =
      fromTop < 7 && local < 14 ? 'easeIn' : fromTop < 7 && r.width - local < 14 ? 'easeOut'
        : local < EDGE_PX ? 'start' : r.width - local < EDGE_PX ? 'end' : 'move'
    setSel({ kind: 'section', ...ref })
    const before = seq
    let last: SequenceData | null = null
    startPointerDrag(e, {
      onMove: (dx) => {
        const dt = dx / pxPerSec
        let next: SequenceData
        if (mode === 'move') {
          const start = snapped(s.start + dt, ref)
          next = E.moveSection(before, ref, start - s.start)
        } else if (mode === 'start') next = E.trimSectionStart(before, ref, snapped(s.start + dt, ref))
        else if (mode === 'end') next = E.trimSectionEnd(before, ref, snapped(s.end + dt, ref))
        else if (mode === 'easeIn') next = E.patchSection(before, ref, { easeIn: Math.max(0, Math.min(s.end - s.start, (s.easeIn ?? 0) + dt)) })
        else next = E.patchSection(before, ref, { easeOut: Math.max(0, Math.min(s.end - s.start, (s.easeOut ?? 0) - dt)) })
        last = next
        live(next)
      },
      onEnd: (moved) => {
        if (!moved || !last) return
        const label = mode === 'move' ? 'Move section' : mode === 'start' || mode === 'end' ? 'Trim section' : 'Ease section'
        void commit(label, last, before)
      },
    })
  }

  /** Press on a property key: select, or drag to retime it inside its section. */
  const pressKey = (e: React.PointerEvent, track: SequenceTrack, sectionId: string, index: number) => {
    if (!seq || e.button !== 0) return
    e.stopPropagation()
    const ref = { trackId: track.id, sectionId }
    const s = E.findSection(seq, ref)
    const key = s?.curve?.keys[index]
    if (!s || !key) return
    setSel({ kind: 'key', ...ref, index })
    const before = seq
    let last: SequenceData | null = null, lastIndex = index
    startPointerDrag(e, {
      onMove: (dx) => {
        const t = snapped(s.start + key.t + dx / pxPerSec) - s.start
        const next = E.moveSectionKey(before, ref, index, Math.max(0, Math.min(s.end - s.start, t)))
        const moved = E.findSection(next, ref)?.curve?.keys ?? []
        lastIndex = moved.findIndex(k => Math.abs(k.t - Math.max(0, Math.min(s.end - s.start, t))) < 1e-9)
        last = next
        live(next)
      },
      onEnd: (moved) => {
        if (!moved || !last) return
        if (lastIndex >= 0) setSel({ kind: 'key', ...ref, index: lastIndex })
        void commit('Move key', last, before)
      },
    })
  }

  const pressEvent = (e: React.PointerEvent, track: SequenceTrack, index: number) => {
    if (!seq || e.button !== 0 || track.type !== 'event') return
    e.stopPropagation()
    const key = track.keys[index]
    setSel({ kind: 'event', trackId: track.id, index })
    const before = seq
    let last: SequenceData | null = null
    startPointerDrag(e, {
      onMove: (dx) => { last = E.patchEventKey(before, track.id, index, { t: snapped(key.t + dx / pxPerSec) }); live(last) },
      onEnd: (moved) => { if (moved && last) void commit('Move event', last, before) },
    })
  }

  const pressMarker = (index: number, e: React.PointerEvent) => {
    if (!seq) return
    const m = seq.markers[index]
    setSel({ kind: 'marker', index })
    const before = seq
    let last: SequenceData | null = null
    startPointerDrag(e, {
      onMove: (dx) => { last = E.patchMarker(before, index, { t: snapped(m.t + dx / pxPerSec) }); live(last) },
      onEnd: (moved) => { if (moved && last) void commit('Move marker', last, before) },
    })
  }

  /** Double-click on a track's empty lane: a new section there (an event key, on an event track). */
  const addAt = (track: SequenceTrack, clientX: number) => {
    if (!seq) return
    const t = snapped(tAt(clientX))
    if (track.type === 'event') {
      void commit('Add event', E.addEventKey(seq, track.id, { t, name: 'event' }))
      return
    }
    void addSectionAt(track, t, Math.min(5, Math.max(1, duration - t)))
  }

  /**
   * A new section on `track` from `t`, shaped for its type (a preset to blend to, a clip, a template, a pawn: see
   * slotTargets.ts), selected.
   */
  const addSectionAt = async (track: SequenceTrack, t: number, length: number) => {
    if (!seq || !node) return
    const init = await newSectionInit(node, seq, track, templateNames)
    if (!init) return
    const r = E.addSection(seq, track.id, t, length, init)
    if (r) { setSel({ kind: 'section', ...r.ref }); await commit('Add section', r.seq) }
  }

  /** The tracks a slot's node can take beyond Path and Property (slotTargets.ts). */
  const extraTracksFor = (slot: SequenceSlot) => (node ? slotTrackOffers(node, slot) : [])

  // ---- commands ------------------------------------------------------------------------------------------

  const selectedSectionRef = (): E.SectionRef | null =>
    sel && (sel.kind === 'section' || sel.kind === 'key') ? { trackId: sel.trackId, sectionId: sel.sectionId } : null

  const razor = () => {
    const ref = selectedSectionRef()
    if (!seq || !ref) { toast.info('Select a section, put the playhead inside it, then press S.'); return }
    const r = E.splitSection(seq, ref, preview.timeRef.current)
    if (!r) return
    setSel({ kind: 'section', ...r.right })
    void commit('Split section', r.seq)
  }

  const duplicate = () => {
    const ref = selectedSectionRef()
    if (!seq || !ref) return
    const r = E.duplicateSection(seq, ref)
    if (r) { setSel({ kind: 'section', ...r.copy }); void commit('Duplicate section', r.seq) }
  }

  const removeSelection = () => {
    if (!seq || !sel) return
    if (sel.kind === 'section') void commit('Delete section', E.deleteSection(seq, sel))
    else if (sel.kind === 'key') void commit('Delete key', E.deleteSectionKey(seq, sel, sel.index))
    else if (sel.kind === 'event') void commit('Delete event', E.deleteEventKey(seq, sel.trackId, sel.index))
    else if (sel.kind === 'marker') void commit('Delete marker', E.deleteMarker(seq, sel.index))
    else if (sel.kind === 'track') void commit('Delete track', E.deleteTrack(seq, sel.trackId))
    else if (sel.kind === 'slot') void commit('Delete slot', E.deleteSlot(seq, sel.slotId))
    setSel(null)
  }

  const addMarker = async () => {
    if (!seq) return
    const name = await promptDialog({ title: 'Add marker', defaultValue: `Marker ${seq.markers.length + 1}`, confirmLabel: 'Add' })
    if (name) void commit('Add marker', E.addMarker(seq, preview.timeRef.current, name))
  }

  const frame = 1 / fps
  const step = (dt: number) => { ed.settleEdits(); preview.pause(); preview.seek(Math.round((preview.timeRef.current + dt) * fps) / fps) }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!active || !seq || isTextEntryEvent(e.nativeEvent) || e.altKey || e.metaKey) return
    const k = e.key
    if (e.ctrlKey) {
      if (k === 'd' || k === 'D') { e.preventDefault(); duplicate() }
      return
    }
    if (k === ' ') { e.preventDefault(); preview.toggle() }
    else if (k === 'k' || k === 'K') preview.pause()
    else if (k === 'l' || k === 'L') preview.play()
    else if (k === 'j' || k === 'J') step(-1)
    else if (k === ',') step(-frame)
    else if (k === '.') step(frame)
    else if (k === 'Home') { e.preventDefault(); preview.pause(); preview.seek(0) }
    else if (k === 'End') { e.preventDefault(); preview.pause(); preview.seek(duration) }
    else if (k === 's' || k === 'S') razor()
    else if (k === 'm' || k === 'M') void addMarker()
    else if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); removeSelection() }
  }

  // ---- + Track and slots --------------------------------------------------------------------------------

  const addTrack = async (track: Omit<SequenceTrack, 'id'>, label: string) => {
    if (!seq) return
    const id = E.newId('track')
    await commit(label, E.addTrack(seq, { ...track, id } as SequenceTrack))
    setSel({ kind: 'track', trackId: id })
  }

  const addPropertyTrack = async (slot: SequenceSlot | null, target?: 'renderer' | 'game') => {
    if (!seq) return
    const bound = slot ? node?.resolveSlot(slot.id) : null
    const hint = bound ? Object.keys(settableProps(bound)).slice(0, 12).join(', ') : target === 'game' ? 'timeScale' : 'ssrMaxDistance, exposure'
    const path = await promptDialog({
      title: slot ? `Property of ${slot.name}` : `Property of the ${target}`,
      message: `A dotted path from ${slot ? 'the bound node' : `the ${target}`}. For example: ${hint}`,
      placeholder: slot ? 'camera.fov' : 'timeScale', confirmLabel: 'Add',
    })
    if (!path) return
    const current = bound ? (path.split('.').reduce<any>((o, p) => (o == null ? o : o instanceof Map ? o.get(p) : o[p]), bound)) : undefined
    const valueType = typeof current === 'boolean' ? 'bool' : typeof current === 'string' ? 'string'
      : (Array.isArray(current) || ArrayBuffer.isView(current)) ? 'vector' : 'number'
    await addTrack({ type: 'property', path, valueType, sections: [], ...(slot ? { slot: slot.id } : { target }) } as any, 'Add property track')
  }

  const addSlot = async (nodeId?: string) => {
    if (!seq || !node) return
    const bound = nodeId ? editorScene.getNodeById(nodeId) : null
    if (bound) {
      // Already a slot's node: select that slot instead of a second one for the same node.
      const existing = seq.slots.find(s => node.resolveSlot(s.id) === bound)
      if (existing) { setSel({ kind: 'slot', slotId: existing.id }); return }
    }
    const name = bound?.name ?? await promptDialog({ title: 'Add slot', defaultValue: 'Actor', confirmLabel: 'Add' })
    if (!name) return
    const id = E.slotIdFor(seq, name)
    // The binding is the sequence's own (`nodeId`, with the name path as the fallback another scene can use).
    const next = E.addSlot(seq, {
      id, name, ...(bound ? { nodeType: bound.nodeType, nodeId: bound.id, path: namePathOf(bound, editorScene.root) } : {}),
    })
    await commit('Add slot', next)
    setSel({ kind: 'slot', slotId: id })
  }

  const onOutlinerDrop = (e: React.DragEvent) => {
    const id = e.dataTransfer.getData('text/cleo-node')
    if (!id) return
    e.preventDefault()
    void addSlot(id)
  }

  const importFile = async () => {
    if (!seq) return
    try {
      const data = await pickSequenceFile()
      if (data) { await commit('Import', data); setSel(null) }
    } catch (e) {
      toast.error(String((e as Error).message ?? e))
    }
  }

  // ---- render ------------------------------------------------------------------------------------------

  if (!node || !seq) {
    return (
      <div className='flex h-full items-center justify-center gap-3 text-ui-sm text-muted'>
        <span className='h-4 w-4'><SequenceIcon /></span>
        <span>{targetId ? 'Opening the sequence over the open scene…' : 'Open a sequence asset to edit its timeline here.'}</span>
      </div>
    )
  }

  const selectedTrack = (t: SequenceTrack) => sel && 'trackId' in sel && sel.trackId === t.id
  const from = Math.max(0, (view.left - GUTTER) / pxPerSec), to = (view.left + view.width) / pxPerSec

  const transportButton = (title: string, icon: React.ReactNode, onClick: () => void, on?: boolean) => (
    <Button size='icon' variant='ghost' active={on} title={title} onClick={onClick}><span className='block h-3.5 w-3.5'>{icon}</span></Button>
  )

  return (
    <div className='flex h-full min-h-0 flex-col outline-none' tabIndex={0} onKeyDown={onKeyDown}>
      {/* Toolbar */}
      <div className='flex shrink-0 items-center gap-1 border-b border-border px-2 py-1'>
        <span className='mr-1 max-w-[160px] truncate text-ui-sm text-fg' title={ed.asset?.name ?? seq.name}>{ed.asset?.name ?? seq.name}</span>
        {transportButton('To the start (Home)', <ToStartIcon />, () => { preview.pause(); preview.seek(0) })}
        {transportButton('Back one frame (,)', <StepBackIcon />, () => step(-frame))}
        {transportButton(preview.playing ? 'Pause (Space)' : 'Play the preview (Space)', preview.playing ? <PauseIcon /> : <PlayIcon />, preview.toggle)}
        {transportButton('Forward one frame (.)', <StepForwardIcon />, () => step(frame))}
        {transportButton('To the end (End)', <ToEndIcon />, () => { preview.pause(); preview.seek(duration) })}
        {transportButton('To the start, and stop playing', <StopIcon />, () => { preview.pause(); preview.seek(0) })}
        {transportButton('Loop the preview', <LoopIcon />, () => preview.setLoop(!preview.loop), preview.loop)}
        <span className='ml-1 w-[150px] text-ui-xs tabular-nums text-muted'>
          {formatTimecode(preview.time, fps)} / {formatTimecode(duration, fps)}
        </span>
        <span className='whitespace-nowrap text-ui-xs text-sequence' title='Every property change made to a node now is keyed at the playhead. The scene tab shows the scene as authored.'>keying at {formatTimecode(preview.time, fps)}</span>
        <div className='flex-1' />
        {transportButton('Pilot: look through the shot camera', <PilotIcon />, () => preview.setPilot(!preview.pilot), preview.pilot)}
        {transportButton('Snap to frames, edges, keys and markers', <SnapIcon />, () => setSnap(!snap), snap)}
        <Button size='sm' variant='ghost' title='Zoom out' onClick={() => setPxPerSec(p => zoomStep(p, 1, 1.4, MIN_ZOOM))}>−</Button>
        <Button size='sm' variant='ghost' title='Zoom in (Ctrl+wheel)' onClick={() => setPxPerSec(p => zoomStep(p, -1, 1.4, MIN_ZOOM))}>+</Button>
        <Button size='sm' variant='ghost' title='Fit the whole sequence' onClick={fit}>Fit</Button>
        <Popover trigger={<span>+ Track</span>} align='right' title='Add a track'>
          {close => (
            <div className='w-[220px]'>
              <MenuItem disabled={seq.tracks.some(t => t.type === 'cameraCut')} onClick={() => { close(); void addTrack({ type: 'cameraCut', sections: [] } as any, 'Add camera cut track') }}>Camera cut</MenuItem>
              <MenuItem onClick={() => { close(); void addTrack({ type: 'event', keys: [] } as any, 'Add event track') }}>Events</MenuItem>
              <MenuItem title="Calls a method of the Sequence node's own script over each section" onClick={() => { close(); void addTrack({ type: 'script', sections: [] } as any, 'Add director script track') }}>Director script</MenuItem>
              <MenuItem title='Spawns a template over each section (in Play only)' onClick={() => { close(); void addTrack({ type: 'spawn', sections: [] } as any, 'Add spawn track') }}>Spawn</MenuItem>
              <MenuItem onClick={() => { close(); void addPropertyTrack(null, 'renderer') }}>Renderer property…</MenuItem>
              <MenuItem onClick={() => { close(); void addPropertyTrack(null, 'game') }}>Game property…</MenuItem>
              {seq.slots.map(slot => (
                <div key={slot.id} className='mt-1 border-t border-border-subtle pt-1'>
                  <div className='px-2 text-ui-xs text-dim'>{slot.name}</div>
                  <MenuItem onClick={() => { close(); void addTrack({ type: 'path', slot: slot.id, sections: [] } as any, 'Add path track') }}>Path</MenuItem>
                  <MenuItem onClick={() => { close(); void addPropertyTrack(slot) }}>Property…</MenuItem>
                  {extraTracksFor(slot).map(x => (
                    <MenuItem key={x.label} onClick={() => { close(); void addTrack(x.track, x.undo) }}>{x.label}</MenuItem>
                  ))}
                </div>
              ))}
              <div className='mt-1 border-t border-border-subtle pt-1'>
                <MenuItem onClick={() => { close(); void addSlot() }}>Slot…</MenuItem>
              </div>
            </div>
          )}
        </Popover>
        <Button size='sm' variant='ghost' title='Save the sequence as a .sequence.json file' onClick={() => downloadSequence(seq)}>Export</Button>
        <Button size='sm' variant='ghost' title='Replace the sequence with a .sequence.json file' onClick={importFile}>Import</Button>
        <Button size='sm' variant='ghost' title='Render the sequence to a movie: MP4, or PNG frames' onClick={() => { preview.pause(); openRenderMovie() }}>
          <span className='mr-1 inline-block h-3.5 w-3.5'><FilmIcon /></span>Render…
        </Button>
      </div>

      <div className='flex min-h-0 flex-1'>
        <div className='flex min-w-0 flex-1 flex-col'>
          {/* Header row: the outliner's corner and the ruler */}
          <div className='flex shrink-0' style={{ height: RULER_H }}>
            <div className='flex shrink-0 items-center gap-1 border-b border-r border-border bg-surface-raised px-2 text-ui-xs text-dim' style={{ width: OUTLINER_W }}>
              <span className='flex-1'>{seq.slots.length} slots · {seq.tracks.length} tracks</span>
              <Button size='sm' variant='ghost' title='Add a slot (or drop a node from the scene tree here)' onClick={() => void addSlot()}>+ Slot</Button>
            </div>
            <div ref={rulerRef} className='relative min-w-0 flex-1 overflow-hidden'>
              <div className='relative h-full' style={{ width: contentW }}>
                <TimeRuler from={from} to={to} pxPerSec={pxPerSec} gutter={GUTTER} height={RULER_H}
                  onPointerDown={scrubFrom}
                  markers={seq.markers.map((m, i) => ({ ...m, selected: sel?.kind === 'marker' && sel.index === i }))}
                  onMarkerPointerDown={pressMarker} />
                <div className='absolute bottom-0 top-0 bg-scrim/40' style={{ left: x(duration), right: 0 }} />
                <div ref={playheadHeadRef} className='pointer-events-none absolute top-0 h-full w-px bg-danger' />
              </div>
            </div>
          </div>

          <div className='flex min-h-0 flex-1'>
            {/* Outliner */}
            <div ref={outlinerRef} className='shrink-0 overflow-hidden border-r border-border' style={{ width: OUTLINER_W }}
              onDragOver={e => { if (e.dataTransfer.types.includes('text/cleo-node')) e.preventDefault() }} onDrop={onOutlinerDrop}
              onWheel={e => { if (lanesRef.current) lanesRef.current.scrollTop += e.deltaY }}>
              <div style={{ height: rowTop.height + 40 }}>
                {rows.map(r => r.kind === 'group' ? (
                  <div key={r.key}
                    className={cn('flex cursor-pointer items-center gap-1 truncate border-b border-border/40 bg-surface px-2 text-ui-xs',
                      sel?.kind === 'slot' && r.slot && sel.slotId === r.slot.id ? 'text-highlight' : 'text-muted')}
                    style={{ height: GROUP_H }} title={r.detail ? `${r.label} → ${r.detail}` : r.label}
                    onClick={() => r.slot && setSel({ kind: 'slot', slotId: r.slot.id })}
                    onContextMenu={e => {
                      if (!r.slot) return
                      e.preventDefault()
                      const slot = r.slot
                      setMenu({ x: e.clientX, y: e.clientY, items: [
                        { label: 'Add path track', run: () => void addTrack({ type: 'path', slot: slot.id, sections: [] } as any, 'Add path track') },
                        { label: 'Add property track…', run: () => void addPropertyTrack(slot) },
                        ...extraTracksFor(slot).map(x => ({ label: `Add ${x.label.toLowerCase()} track`, run: () => void addTrack(x.track, x.undo) })),
                        { label: 'Delete slot and its tracks', danger: true, run: () => void commit('Delete slot', E.deleteSlot(seq, slot.id)) },
                      ] })
                    }}>
                    <span className='truncate font-medium'>{r.label}</span>
                    {r.detail && <span className='truncate text-dim'>{r.detail}</span>}
                  </div>
                ) : (
                  <div key={r.key}
                    className={cn('flex cursor-pointer items-center gap-1 border-b border-border/40 pl-4 pr-1 text-ui-xs',
                      selectedTrack(r.track) ? 'bg-selected/40 text-fg' : 'text-muted hover:text-fg', r.track.muted && 'opacity-50')}
                    style={{ height: ROW_H }} onClick={() => setSel({ kind: 'track', trackId: r.track.id })}
                    onContextMenu={e => {
                      e.preventDefault()
                      const t = r.track
                      setMenu({ x: e.clientX, y: e.clientY, items: [
                        { label: t.muted ? 'Unmute' : 'Mute', run: () => void commit(t.muted ? 'Unmute track' : 'Mute track', E.patchTrack(seq, t.id, { muted: !t.muted })) },
                        { label: 'Add section at the playhead', run: () => { if (t.type === 'event') void commit('Add event', E.addEventKey(seq, t.id, { t: preview.timeRef.current, name: 'event' })); else void addSectionAt(t, preview.timeRef.current, 5) } },
                        { label: 'Delete track', danger: true, run: () => void commit('Delete track', E.deleteTrack(seq, t.id)) },
                      ] })
                    }}>
                    <span className={cn('inline-block h-2 w-2 shrink-0 rounded-sm border', TRACK_COLORS[r.track.type])} />
                    <span className='min-w-0 flex-1 truncate'>{trackLabel(r.track)}</span>
                    <button className='px-1 text-dim hover:text-fg' title={r.track.muted ? 'Unmute' : 'Mute'}
                      onClick={e => { e.stopPropagation(); void commit(r.track.muted ? 'Unmute track' : 'Mute track', E.patchTrack(seq, r.track.id, { muted: !r.track.muted })) }}>
                      {r.track.muted ? 'M' : 'm'}
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Lanes */}
            <div ref={lanesRef} className='relative min-w-0 flex-1 overflow-auto' onScroll={onLanesScroll}
              onPointerDown={e => { if (e.target === e.currentTarget) setSel(null) }}>
              <div className='relative' style={{ width: contentW, height: rowTop.height + 40 }}>
                <div className='absolute bottom-0 top-0 bg-scrim/30' style={{ left: x(duration), right: 0 }} />
                {rows.map((r, i) => r.kind === 'group' ? (
                  <div key={r.key} className='absolute inset-x-0 border-b border-border/40 bg-surface/60' style={{ top: rowTop.tops[i], height: GROUP_H }} />
                ) : (
                  <div key={r.key} className={cn('absolute inset-x-0 border-b border-border/30', selectedTrack(r.track) && 'bg-selected/10', r.track.muted && 'opacity-50')}
                    style={{ top: rowTop.tops[i], height: ROW_H }}
                    onDoubleClick={e => { if (e.target === e.currentTarget) addAt(r.track, e.clientX) }}
                    onPointerDown={e => { if (e.target === e.currentTarget) setSel({ kind: 'track', trackId: r.track.id }) }}>
                    {r.track.type === 'event' ? r.track.keys.map((k, ki) => (
                      <div key={ki} title={`${k.name ?? k.method ?? 'event'} at ${k.t.toFixed(2)} s${k.method ? ` · calls ${k.method}()` : ''}`}
                        className={cn('absolute top-1/2 flex -translate-x-1/2 -translate-y-1/2 cursor-grab items-center gap-1')}
                        style={{ left: x(k.t) }} onPointerDown={e => pressEvent(e, r.track, ki)}>
                        <span className={cn('block h-2.5 w-2.5 rotate-45 border', TRACK_COLORS.event,
                          sel?.kind === 'event' && sel.trackId === r.track.id && sel.index === ki && 'ring-2 ring-fg')} />
                        <span className='whitespace-nowrap text-ui-xs text-dim'>{k.name ?? k.method}</span>
                      </div>
                    )) : (r.track.sections as any[]).map(s => {
                      const isSel = sel?.kind === 'section' && sel.trackId === r.track.id && sel.sectionId === s.id
                      const w = Math.max(4, (s.end - s.start) * pxPerSec)
                      const ein = Math.min(w, (s.easeIn ?? 0) * pxPerSec), eout = Math.min(w, (s.easeOut ?? 0) * pxPerSec)
                      const text = sectionText(seq, r.track, s)
                      return (
                        <div key={s.id} title={`${text || trackLabel(r.track)}: ${s.start.toFixed(2)}–${s.end.toFixed(2)} s${s.hold ? ', then holds until resumed' : ''} · drag to move, edges to trim, top corners to ease`}
                          className={cn('absolute top-[3px] overflow-hidden rounded-sm border text-ui-xs text-fg', TRACK_COLORS[r.track.type],
                            isSel && 'ring-2 ring-fg', 'cursor-grab')}
                          style={{ left: x(s.start), width: w, height: ROW_H - 6 }}
                          onPointerDown={e => pressSection(e, r.track, s.id)}
                          onContextMenu={e => {
                            e.preventDefault()
                            const ref = { trackId: r.track.id, sectionId: s.id }
                            setSel({ kind: 'section', ...ref })
                            setMenu({ x: e.clientX, y: e.clientY, items: [
                              { label: 'Split at the playhead (S)', run: () => { const res = E.splitSection(seq, ref, preview.timeRef.current); if (res) void commit('Split section', res.seq) } },
                              { label: 'Duplicate (Ctrl+D)', run: () => { const res = E.duplicateSection(seq, ref); if (res) void commit('Duplicate section', res.seq) } },
                              { label: s.whenFinished === 'restore' ? 'When finished: keep' : 'When finished: restore', run: () => void commit('When finished', E.patchSection(seq, ref, { whenFinished: s.whenFinished === 'restore' ? 'keep' : 'restore' })) },
                              { label: 'Delete', danger: true, run: () => void commit('Delete section', E.deleteSection(seq, ref)) },
                            ] })
                          }}>
                          {/* Ease ramps, and the corner grips that set them. */}
                          {ein > 0 && <div className='pointer-events-none absolute inset-y-0 left-0 bg-gradient-to-r from-black/45 to-transparent' style={{ width: ein }} />}
                          {eout > 0 && <div className='pointer-events-none absolute inset-y-0 right-0 bg-gradient-to-l from-black/45 to-transparent' style={{ width: eout }} />}
                          <div className='pointer-events-none absolute left-0 top-0 h-0 w-0 border-l-[7px] border-t-[7px] border-l-transparent border-t-white/70' style={{ left: ein }} />
                          <div className='pointer-events-none absolute right-0 top-0 h-0 w-0 border-r-[7px] border-t-[7px] border-r-transparent border-t-white/70' style={{ right: eout }} />
                          <span className='pointer-events-none absolute left-2 top-[3px] whitespace-nowrap'>{text}</span>
                          {/* A hold: playback waits at the section's end for the script's resume(). */}
                          {r.track.type === 'script' && s.hold && (
                            <span className='pointer-events-none absolute right-1.5 top-1/2 block h-2.5 w-2.5 -translate-y-1/2 text-fg'><PauseIcon /></span>
                          )}
                          {r.track.type === 'property' && s.curve?.keys.map((k: any, ki: number) => (
                            <span key={ki} title={`Key at ${(s.start + k.t).toFixed(2)} s: ${JSON.stringify(k.v)}`}
                              className={cn('absolute top-1/2 block h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 cursor-grab border border-white/80 bg-white/60',
                                sel?.kind === 'key' && sel.sectionId === s.id && sel.index === ki && 'bg-highlight ring-1 ring-fg')}
                              style={{ left: k.t * pxPerSec }} onPointerDown={e => pressKey(e, r.track, s.id, ki)} />
                          ))}
                        </div>
                      )
                    })}
                  </div>
                ))}
                <div ref={playheadRef} className='pointer-events-none absolute bottom-0 top-0 w-px bg-danger' />
              </div>
            </div>
          </div>
        </div>

        {/* Details */}
        <div className='w-[300px] shrink-0 overflow-y-auto border-l border-border'>
          <SequenceDetails node={node} seq={seq} sel={sel} setSel={setSel} commit={commit} live={live} preview={preview} scene={editorScene} />
        </div>
      </div>

      <ContextMenu at={menu} onClose={() => setMenu(null)}>
        {close => menu?.items.map((item, i) => (
          <MenuItem key={i} danger={item.danger} onClick={() => { close(); item.run() }}>{item.label}</MenuItem>
        ))}
      </ContextMenu>
    </div>
  )
}

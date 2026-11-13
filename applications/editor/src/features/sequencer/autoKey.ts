import type { PropertySection, PropertyTrack, PropertyValueType, SequenceData, SequenceKey, SequenceSlot } from 'cleo'
import { editSequence, newId, slotIdFor } from './sequenceEdits'

// Sequencer mode's auto-key, as a pure edit: "this node's property went from `before` to `after` at time t"
// becomes a key at t on the property track for that node and path, creating the slot, the track and its section
// when they are not there yet. Like every edit in sequenceEdits it returns a NEW sequence.
//
// A NEW track starts with a key at 0 holding `before`, so the first change at 2 s animates from what the
// scene had to the new value over 0..2 s (the cube moving from the origin), rather than snapping at 2 s.

/** The node a key is for. `path` is its name path from the scene root (the slot's fallback binding). */
export interface KeyNode { id: string; name: string; path?: string; nodeType?: string }

export interface KeyChange {
  path: string
  valueType: PropertyValueType
  before: SequenceKey['v']
  after: SequenceKey['v']
}

export interface KeyResult {
  seq: SequenceData
  slotId: string
  /** Whether a key landed where the frame does not show exactly what was keyed: inside an ease or under an
   *  overlapping section, where sections blend. */
  blended: boolean
}

/** Property paths a Path track drives on its subject: keying them would be overwritten every frame. */
const PATH_DRIVEN = new Set(['position', 'rotation'])

/** The track that already drives `path` on `slotId` in a way a key can't override, or null. */
export function conflictingTrack(seq: SequenceData, slotId: string | undefined, path: string): { id: string; name: string } | null {
  if (!slotId || !PATH_DRIVEN.has(path)) return null
  const t = seq.tracks.find(tr => tr.type === 'path' && tr.slot === slotId && !tr.muted)
  return t ? { id: t.id, name: t.name ?? 'Path' } : null
}

/** The slot bound to `node` by id in the sequence itself (the Sequencer's own binding). */
export function slotForNode(seq: SequenceData, nodeId: string): SequenceSlot | undefined {
  return seq.slots.find(s => s.nodeId === nodeId)
}

/** Turn each angle of `v` by whole turns so it is the nearest to `ref`'s: a gizmo turn past 180° keeps going. */
export function unwrapEuler(v: number[], ref: unknown): number[] {
  if (!Array.isArray(ref)) return v
  return v.map((a, i) => {
    const r = typeof ref[i] === 'number' ? ref[i] : a
    let x = a
    while (x - r > 180) x -= 360
    while (x - r < -180) x += 360
    return Math.round(x * 1e6) / 1e6
  })
}

const copy = (v: SequenceKey['v']): SequenceKey['v'] => (Array.isArray(v) ? v.slice() : v)

function setKey(section: PropertySection, local: number, v: SequenceKey['v']) {
  const keys = section.curve.keys
  const t = Math.max(0, Math.round(local * 1e6) / 1e6)
  const at = keys.findIndex(k => Math.abs(k.t - t) < 1e-4)
  if (at >= 0) keys[at] = { ...keys[at], t: keys[at].t, v: copy(v) }
  else keys.push({ t, v: copy(v) })
  keys.sort((a, b) => a.t - b.t)
}

/**
 * The section of `track` a key at `t` belongs in: the one covering t (the latest-starting, when several
 * overlap), else the nearest one stretched to reach t. Stretching a section's START keeps its keys where they
 * were on the timeline (they are section-local, so they shift by the stretch).
 */
function sectionFor(track: PropertyTrack, t: number): { section: PropertySection; overlapping: boolean } | null {
  const sections = track.sections
  if (!sections.length) return null
  const covering = sections.filter(s => t >= s.start - 1e-6 && t <= s.end + 1e-6)
  if (covering.length) {
    const section = covering.reduce((a, b) => (b.start >= a.start ? b : a))
    return { section, overlapping: covering.length > 1 }
  }
  let best: PropertySection | null = null, bestGap = Infinity
  for (const s of sections) {
    const gap = t < s.start ? s.start - t : t - s.end
    if (gap < bestGap) { best = s; bestGap = gap }
  }
  if (!best) return null
  if (t > best.end) best.end = t
  else {
    const shift = best.start - t
    best.start = t
    for (const k of best.curve.keys) k.t = Math.round((k.t + shift) * 1e6) / 1e6
  }
  return { section: best, overlapping: false }
}

/** Whether `t` falls inside a section's ease-in or ease-out ramp. */
function inEase(s: PropertySection, t: number): boolean {
  return (!!s.easeIn && t < s.start + s.easeIn - 1e-6) || (!!s.easeOut && t > s.end - s.easeOut + 1e-6)
}

/**
 * Key `changes` of `node` at sequence time `t`. `slotId` is the slot that already resolves to the node (the
 * caller finds it through the preview, which also knows the playing node's own bindings); without one, the slot
 * bound to the node's id is used, or a new one is made for it.
 */
export function keyProperties(seq: SequenceData, node: KeyNode, changes: KeyChange[], t: number, slotId?: string): KeyResult {
  let usedSlot = slotId && seq.slots.some(s => s.id === slotId) ? slotId : slotForNode(seq, node.id)?.id
  let blended = false
  const next = editSequence(seq, d => {
    if (!usedSlot) {
      usedSlot = slotIdFor(d, node.name)
      d.slots.push({
        id: usedSlot, name: node.name, nodeId: node.id,
        ...(node.nodeType ? { nodeType: node.nodeType } : {}),
        ...(node.path ? { path: node.path } : {}),
      })
    }
    for (const change of changes) {
      let track = d.tracks.find((tr): tr is PropertyTrack =>
        tr.type === 'property' && tr.slot === usedSlot && !tr.target && tr.path === change.path)
      const isRotation = change.path === 'rotation' && change.valueType === 'vector'
      if (!track) {
        track = { id: newId('track'), type: 'property', slot: usedSlot!, path: change.path, valueType: change.valueType, sections: [] }
        d.tracks.push(track)
      }
      const found = sectionFor(track, t)
      if (!found) {
        // A new track: one section over the whole timeline, from what the scene had at 0 to the new value at t.
        const after = isRotation ? unwrapEuler(change.after as number[], change.before) : change.after
        const keys: SequenceKey[] = t > 1e-4 ? [{ t: 0, v: copy(change.before) }, { t: Math.round(t * 1e6) / 1e6, v: copy(after) }]
          : [{ t: 0, v: copy(after) }]
        track.sections.push({ id: newId('section'), start: 0, end: Math.max(d.duration, t), curve: { keys } })
        continue
      }
      const { section, overlapping } = found
      if (overlapping || inEase(section, t)) blended = true
      const after = isRotation ? unwrapEuler(change.after as number[], change.before) : change.after
      setKey(section, t - section.start, after)
    }
    if (t > d.duration) d.duration = Math.ceil(t * d.fps - 1e-6) / d.fps
  })
  return { seq: next, slotId: usedSlot!, blended }
}

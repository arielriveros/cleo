import { evaluateKeyedNumber, evaluateKeyedStep, evaluateKeyedVector, FOLIAGE_CHANNELS } from 'cleo'
import type {
  AnimationSection, AudioSection, CameraCutSection, EventKey, FoliageChannel, FoliageSection, PathSection, PossessSection,
  PresetSection, PropertySection, ScriptSection, SectionBase, SequenceCurve, SequenceData, SequenceKey, SequenceSlot,
  SequenceTrack, SpawnSection,
} from 'cleo'

// The Sequencer's edits, as pure functions over SequenceData. Each returns a NEW sequence and never touches the
// one it was given: the panel assigns the result to the node (`node.sequence = next`), and the undo recorder
// diffs the node's serialized snapshot, which only works when the old snapshot is not mutated in place.
//
// Section keys are SECTION-local (seconds from the section's start), so moving a section moves its animation.
// Trimming a section's start keeps every key where it was on the timeline: the keys shift by the trim.

/** Shortest a section may be trimmed to, seconds. */
export const MIN_SECTION = 1 / 30

export interface SectionRef { trackId: string; sectionId: string }

type AnySection = SectionBase & Partial<PathSection & PropertySection & CameraCutSection & PresetSection & FoliageSection
  & ScriptSection & AnimationSection & AudioSection & SpawnSection & PossessSection>

/**
 * Which of a section's curves a key edit is on: a property's value curve, one of a Foliage section's channels, or
 * an Audio section's volume.
 */
export type CurveField = 'curve' | FoliageChannel | 'volume'
type SectionTrack = Extract<SequenceTrack, { sections: unknown[] }>

/** The method a new script section calls until it is renamed (an empty one is not a section: the parse drops it). */
export const DEFAULT_SCRIPT_METHOD = 'onSequenceSection'

let idCounter = 0
/** A fresh id with `prefix`, unique within the session and across reloads (time-based). */
export function newId(prefix: string): string {
  idCounter = (idCounter + 1) % 1e6
  return `${prefix}:${Date.now().toString(36)}${idCounter.toString(36)}`
}

/** Apply `fn` to a deep copy of `seq` and return the copy. */
export function editSequence(seq: SequenceData, fn: (draft: SequenceData) => void): SequenceData {
  const draft = structuredClone(seq)
  fn(draft)
  return draft
}

export function findTrack(seq: SequenceData, trackId: string): SequenceTrack | undefined {
  return seq.tracks.find(t => t.id === trackId)
}

function sectionsOf(track: SequenceTrack | undefined): AnySection[] | null {
  return track && 'sections' in track ? (track as SectionTrack).sections as AnySection[] : null
}

export function findSection(seq: SequenceData, ref: SectionRef): AnySection | undefined {
  return sectionsOf(findTrack(seq, ref.trackId))?.find(s => s.id === ref.sectionId)
}

const sortSections = (track: SequenceTrack) => { sectionsOf(track)?.sort((a, b) => a.start - b.start) }

/** Grow the sequence's duration so it covers `t`. */
function cover(draft: SequenceData, t: number) {
  if (t > draft.duration) draft.duration = Math.ceil(t * draft.fps) / draft.fps
}

// ---- curves -------------------------------------------------------------------------------------------

/** The section-local curves a section carries (property values, path progress, roll, fov, look progress, volume). */
function curvesOf(s: AnySection): SequenceCurve[] {
  const out: SequenceCurve[] = []
  if (s.curve) out.push(s.curve)
  if (s.progress) out.push(s.progress as SequenceCurve)
  if (s.roll) out.push(s.roll as SequenceCurve)
  if (s.fov) out.push(s.fov as SequenceCurve)
  if (s.look && s.look.mode === 'path' && s.look.progress) out.push(s.look.progress as SequenceCurve)
  for (const c of FOLIAGE_CHANNELS) if (s[c]) out.push(s[c] as SequenceCurve)
  if (s.volume) out.push(s.volume as SequenceCurve)
  return out
}

/** Shift every key of a curve by `dt` seconds, dropping none (a key before 0 still shapes the curve's start). */
function shiftCurve(curve: SequenceCurve, dt: number) {
  for (const k of curve.keys) k.t = Math.round((k.t + dt) * 1e6) / 1e6
}

/**
 * A section whose start moved by `dt` seconds with its media left where it was on the timeline: an Animation
 * section's clip starts `dt * speed` clip seconds later, an Audio section's sample `dt` seconds later. Never
 * before the clip's or the sample's own start (growing past it slides the media instead).
 */
function rebaseMedia(type: SequenceTrack['type'], s: AnySection, dt: number) {
  const set = (key: 'clipStart' | 'offset', v: number) => {
    const r = Math.round(v * 1e6) / 1e6
    if (r > 0) s[key] = r
    else delete s[key]
  }
  if (type === 'animation') set('clipStart', (s.clipStart ?? 0) + dt * (s.speed ?? 1))
  else if (type === 'audio') set('offset', (s.offset ?? 0) + dt)
}

/** The value of a curve at `t`, of the same kind its keys hold. */
export function curveValueAt(curve: SequenceCurve, t: number): SequenceKey['v'] {
  const first = curve.keys[0]?.v
  if (typeof first === 'number') return evaluateKeyedNumber(curve, t)
  if (Array.isArray(first)) return evaluateKeyedVector(curve, t, new Array(first.length).fill(0))
  return evaluateKeyedStep(curve as SequenceCurve<string | boolean>, t, first as string | boolean)
}

/**
 * Split a curve at `t`: the part up to it, and the part from it re-based to start at 0. Both halves get a key
 * at the cut carrying the value there, so neither changes shape at its new end.
 */
export function splitCurve(curve: SequenceCurve, t: number): [SequenceCurve, SequenceCurve] {
  const v = curveValueAt(curve, t)
  const at = curve.keys.find(k => Math.abs(k.t - t) < 1e-6)
  const interp = (at ?? [...curve.keys].reverse().find(k => k.t < t))?.interp
  const before = curve.keys.filter(k => k.t < t - 1e-6).map(k => ({ ...k }))
  const after = curve.keys.filter(k => k.t > t + 1e-6).map(k => ({ ...k, t: Math.round((k.t - t) * 1e6) / 1e6 }))
  const cut = (time: number): SequenceKey => ({ t: time, v: Array.isArray(v) ? v.slice() : v, ...(interp ? { interp } : {}) })
  return [{ keys: [...before, cut(t)] }, { keys: [cut(0), ...after] }]
}

// ---- sections -----------------------------------------------------------------------------------------

/** Move a section by `dt` seconds (never before 0). Its keys go with it. */
export function moveSection(seq: SequenceData, ref: SectionRef, dt: number): SequenceData {
  return editSequence(seq, d => {
    const s = findSection(d, ref)
    if (!s) return
    const span = s.end - s.start
    s.start = Math.max(0, s.start + dt)
    s.end = s.start + span
    cover(d, s.end)
    sortSections(findTrack(d, ref.trackId)!)
  })
}

/**
 * Move a section's start to `start`, keeping its end and every key's place on the timeline. An Animation or
 * Audio section keeps its clip or sample there too: trimming the head skips what was cut off.
 */
export function trimSectionStart(seq: SequenceData, ref: SectionRef, start: number): SequenceData {
  return editSequence(seq, d => {
    const s = findSection(d, ref)
    if (!s) return
    const track = findTrack(d, ref.trackId)!
    const next = Math.min(s.end - MIN_SECTION, Math.max(0, start))
    const dt = next - s.start
    s.start = next
    for (const c of curvesOf(s)) shiftCurve(c, -dt)
    rebaseMedia(track.type, s, dt)
    sortSections(track)
  })
}

/** Move a section's end to `end`. */
export function trimSectionEnd(seq: SequenceData, ref: SectionRef, end: number): SequenceData {
  return editSequence(seq, d => {
    const s = findSection(d, ref)
    if (!s) return
    s.end = Math.max(s.start + MIN_SECTION, end)
    cover(d, s.end)
  })
}

/**
 * Set any of a section's plain fields (eases, label, when finished, a cut's slot, a path's look, a script's method,
 * a clip, a template...). A field set to undefined, or to its default (an empty name, off, 0), is dropped, as the
 * parse would.
 */
export function patchSection(seq: SequenceData, ref: SectionRef, patch: Partial<AnySection>): SequenceData {
  return editSequence(seq, d => {
    const s = findSection(d, ref)
    if (!s) return
    Object.assign(s, structuredClone(patch))
    const fields = s as unknown as Record<string, unknown>
    for (const key of Object.keys(fields)) if (fields[key] === undefined) delete fields[key]
    for (const key of ['easeIn', 'easeOut', 'clipStart', 'offset'] as const) if (s[key] !== undefined && !(s[key]! > 0)) delete s[key]
    for (const key of ['hold', 'loop'] as const) if (s[key] === false) delete s[key]
    for (const key of ['parent', 'name', 'bindAs'] as const) if (s[key] === '') delete s[key]
    if (s.end < s.start + MIN_SECTION) s.end = s.start + MIN_SECTION
    cover(d, s.end)
    sortSections(findTrack(d, ref.trackId)!)
  })
}

/**
 * Cut a section in two at sequence time `t` (the razor). Property, path and cut sections all split; a path's
 * two halves keep the same spline, each with its share of the progress (re-based), so the camera does not move.
 * An Animation section's right half starts its clip where the cut is (clipStart + (t - start) * speed), an Audio
 * section's its sample (offset + (t - start)), with the volume curve split like any other; script, spawn and
 * possess sections split plainly, and a script section's hold stays on the right half (it holds at the end).
 * Returns the sequence and the new right-hand section's ref, or null when `t` is not inside the section.
 */
export function splitSection(seq: SequenceData, ref: SectionRef, t: number): { seq: SequenceData; right: SectionRef } | null {
  const s0 = findSection(seq, ref)
  if (!s0 || t <= s0.start + MIN_SECTION || t >= s0.end - MIN_SECTION) return null
  // A preset blend is one eased move from one look to the next: halving it would change the picture.
  if (findTrack(seq, ref.trackId)?.type === 'preset') return null
  const rightId = newId('section')
  const next = editSequence(seq, d => {
    const track = findTrack(d, ref.trackId)!
    const list = sectionsOf(track)!
    const s = list.find(x => x.id === ref.sectionId)!
    const local = t - s.start
    const span = s.end - s.start
    const right: AnySection = structuredClone(s)
    right.id = rightId
    right.start = t
    s.end = t
    delete s.easeOut
    delete right.easeIn
    delete s.hold
    if (s.curve) [s.curve, right.curve] = splitCurve(s.curve, local)
    for (const c of FOLIAGE_CHANNELS)
      if (s[c]) [s[c], right[c]] = splitCurve(s[c] as SequenceCurve, local) as [any, any]
    if (s.volume) [s.volume, right.volume] = splitCurve(s.volume as SequenceCurve, local) as [SequenceCurve<number>, SequenceCurve<number>]
    rebaseMedia(track.type, right, local)
    if (s.points) {
      // Progress absent means linear over the whole section: make it explicit before splitting it.
      const progress = (s.progress ?? { keys: [{ t: 0, v: 0, interp: 'linear' }, { t: span, v: 1 }] }) as SequenceCurve
      ;[s.progress, right.progress] = splitCurve(progress, local) as [SequenceCurve<number>, SequenceCurve<number>]
      if (s.roll) [s.roll, right.roll] = splitCurve(s.roll as SequenceCurve, local) as [SequenceCurve<number>, SequenceCurve<number>]
      if (s.fov) [s.fov, right.fov] = splitCurve(s.fov as SequenceCurve, local) as [SequenceCurve<number>, SequenceCurve<number>]
      if (s.look?.mode === 'path' && s.look.progress && right.look?.mode === 'path')
        [s.look.progress, right.look.progress] = splitCurve(s.look.progress as SequenceCurve, local) as [SequenceCurve<number>, SequenceCurve<number>]
    }
    list.splice(list.indexOf(s) + 1, 0, right)
  })
  return { seq: next, right: { trackId: ref.trackId, sectionId: rightId } }
}

/** A copy of a section placed right after it on the same track. Returns the copy's ref. */
export function duplicateSection(seq: SequenceData, ref: SectionRef): { seq: SequenceData; copy: SectionRef } | null {
  const s0 = findSection(seq, ref)
  if (!s0) return null
  const id = newId('section')
  const next = editSequence(seq, d => {
    const list = sectionsOf(findTrack(d, ref.trackId))!
    const s = list.find(x => x.id === ref.sectionId)!
    const copy: AnySection = { ...structuredClone(s), id, start: s.end, end: s.end + (s.end - s.start) }
    list.push(copy)
    cover(d, copy.end)
    sortSections(findTrack(d, ref.trackId)!)
  })
  return { seq: next, copy: { trackId: ref.trackId, sectionId: id } }
}

export function deleteSection(seq: SequenceData, ref: SectionRef): SequenceData {
  return editSequence(seq, d => {
    const list = sectionsOf(findTrack(d, ref.trackId))
    if (!list) return
    const i = list.findIndex(s => s.id === ref.sectionId)
    if (i >= 0) list.splice(i, 1)
  })
}

/**
 * A new section on a track, shaped for its type, from `start` for `length` seconds. Returns its ref, or null when
 * the track takes no sections or the section would not survive the parse (a preset blend with no preset, an
 * animation with no clip, a spawn with no template, a possession with no pawn): pass those in `init`.
 */
export function addSection(seq: SequenceData, trackId: string, start: number, length: number,
                           init: Partial<AnySection> = {}): { seq: SequenceData; ref: SectionRef } | null {
  const track = findTrack(seq, trackId)
  if (!track || !('sections' in track)) return null
  const id = newId('section')
  const from = Math.max(0, start)
  const section = shapeSection(seq, track, { id, start: from, end: from + Math.max(MIN_SECTION, length) }, init)
  if (!section) return null
  const next = editSequence(seq, d => {
    const t = findTrack(d, trackId)!
    sectionsOf(t)!.push(structuredClone(section))
    cover(d, section.end)
    sortSections(t)
  })
  return { seq: next, ref: { trackId, sectionId: id } }
}

/** A new section for `t`'s type from `base` and `init`, or null when it lacks what the parse requires of it. */
function shapeSection(seq: SequenceData, t: SequenceTrack, base: SectionBase, init: Partial<AnySection>): AnySection | null {
  let s: AnySection
  switch (t.type) {
    case 'path': s = { ...base, points: [[0, 2, 0], [0, 2, 10]], look: { mode: 'ahead' }, ...init }; break
    case 'cameraCut': s = { ...base, slot: seq.slots.find(sl => sl.nodeType === 'camera')?.id ?? seq.slots[0]?.id ?? '', ...init }; break
    case 'preset': s = { ...base, preset: '', ...init }; break
    // Foliage: one channel to start from, at the layers' own density (1 = as authored).
    case 'foliage': s = { ...base, density: { keys: [{ t: 0, v: 1 }] }, ...init }; break
    case 'script': s = { ...base, method: DEFAULT_SCRIPT_METHOD, ...init }; break
    case 'animation': s = { ...base, clip: '', ...init }; break
    // Audio: the sample from its start, at the node's own volume (eased by the section).
    case 'audio': s = { ...base, ...init }; break
    case 'spawn': s = { ...base, template: '', ...init }; break
    // Possess: another slot than the controller's own.
    case 'possess': s = { ...base, pawn: seq.slots.find(sl => sl.id !== t.slot)?.id ?? '', ...init }; break
    case 'property': s = { ...base, curve: { keys: [{ t: 0, v: defaultValue(t.valueType) }] }, ...init }; break
    default: return null
  }
  const required = t.type === 'preset' ? s.preset : t.type === 'script' ? s.method : t.type === 'animation' ? s.clip
    : t.type === 'spawn' ? s.template : t.type === 'possess' ? s.pawn : 'ok'
  return typeof required === 'string' && required.trim() ? s : null
}

function defaultValue(valueType: string): SequenceKey['v'] {
  return valueType === 'vector' ? [0, 0, 0] : valueType === 'bool' ? false : valueType === 'string' ? '' : 0
}

// ---- keys ---------------------------------------------------------------------------------------------

/** A section's curve `field`, created when `create` and the field is a Foliage channel or the volume it does not have yet. */
function curveField(s: AnySection | undefined, field: CurveField, create = false): SequenceCurve | undefined {
  if (!s) return undefined
  if (field !== 'curve' && !s[field] && create) (s as any)[field] = { keys: [] }
  return s[field] as SequenceCurve | undefined
}

/**
 * Add (or replace) a key at section-local time `t` on a section's curve: a property's (`field` 'curve'), a
 * Foliage section's channel or an Audio section's volume, which is created by its first key.
 */
export function setSectionKey(seq: SequenceData, ref: SectionRef, t: number, v: SequenceKey['v'],
                              interp?: SequenceKey['interp'], field: CurveField = 'curve'): SequenceData {
  return editSequence(seq, d => {
    const curve = curveField(findSection(d, ref), field, true)
    if (!curve) return
    const keys = curve.keys
    const at = keys.findIndex(k => Math.abs(k.t - t) < 1e-4)
    const key: SequenceKey = { t: Math.max(0, t), v: Array.isArray(v) ? v.slice() : v, ...(interp ? { interp } : {}) }
    if (at >= 0) keys[at] = { ...keys[at], ...key }
    else keys.push(key)
    keys.sort((a, b) => a.t - b.t)
  })
}

/** Move key `index` of a section's curve `field` to section-local time `t`. */
export function moveSectionKey(seq: SequenceData, ref: SectionRef, index: number, t: number, field: CurveField = 'curve'): SequenceData {
  return editSequence(seq, d => {
    const keys = curveField(findSection(d, ref), field)?.keys
    if (!keys || !keys[index]) return
    keys[index].t = Math.max(0, t)
    keys.sort((a, b) => a.t - b.t)
  })
}

export function patchSectionKey(seq: SequenceData, ref: SectionRef, index: number, patch: Partial<SequenceKey>,
                                field: CurveField = 'curve'): SequenceData {
  return editSequence(seq, d => {
    const keys = curveField(findSection(d, ref), field)?.keys
    if (!keys || !keys[index]) return
    Object.assign(keys[index], structuredClone(patch))
    keys.sort((a, b) => a.t - b.t)
  })
}

export function deleteSectionKey(seq: SequenceData, ref: SectionRef, index: number, field: CurveField = 'curve'): SequenceData {
  return editSequence(seq, d => {
    const s = findSection(d, ref)
    const keys = curveField(s, field)?.keys
    if (!keys || !keys[index]) return
    // A Foliage channel's last key takes the channel with it (the layers' own value again), the volume's the
    // volume (the node's own).
    if (field !== 'curve' && keys.length <= 1) { delete (s as any)[field]; return }
    // A property curve keeps at least one key: an empty one would read as "no value".
    if (keys.length <= 1) return
    keys.splice(index, 1)
  })
}

// ---- path points --------------------------------------------------------------------------------------

export function setPathPoint(seq: SequenceData, ref: SectionRef, index: number, point: [number, number, number]): SequenceData {
  return editSequence(seq, d => {
    const points = findSection(d, ref)?.points
    if (points && points[index]) points[index] = [point[0], point[1], point[2]]
  })
}

/** Insert a path point (after `after`, or at the end). */
export function addPathPoint(seq: SequenceData, ref: SectionRef, point: [number, number, number], after?: number): SequenceData {
  return editSequence(seq, d => {
    const points = findSection(d, ref)?.points
    if (!points) return
    const at = after === undefined ? points.length : Math.min(points.length, after + 1)
    points.splice(at, 0, [point[0], point[1], point[2]])
  })
}

export function deletePathPoint(seq: SequenceData, ref: SectionRef, index: number): SequenceData {
  return editSequence(seq, d => {
    const points = findSection(d, ref)?.points
    if (points && points.length > 1) points.splice(index, 1)
  })
}

// ---- events -------------------------------------------------------------------------------------------

export function addEventKey(seq: SequenceData, trackId: string, key: EventKey): SequenceData {
  return editSequence(seq, d => {
    const t = findTrack(d, trackId)
    if (t?.type !== 'event') return
    t.keys.push(structuredClone(key))
    t.keys.sort((a, b) => a.t - b.t)
    cover(d, key.t)
  })
}

export function patchEventKey(seq: SequenceData, trackId: string, index: number, patch: Partial<EventKey>): SequenceData {
  return editSequence(seq, d => {
    const t = findTrack(d, trackId)
    if (t?.type !== 'event' || !t.keys[index]) return
    Object.assign(t.keys[index], structuredClone(patch))
    for (const k of ['name', 'method', 'slot', 'args'] as const) if ((t.keys[index] as any)[k] === '' || (t.keys[index] as any)[k] === undefined) delete (t.keys[index] as any)[k]
    t.keys[index].t = Math.max(0, t.keys[index].t)
    t.keys.sort((a, b) => a.t - b.t)
    cover(d, t.keys.at(-1)?.t ?? 0)
  })
}

export function deleteEventKey(seq: SequenceData, trackId: string, index: number): SequenceData {
  return editSequence(seq, d => {
    const t = findTrack(d, trackId)
    if (t?.type === 'event') t.keys.splice(index, 1)
  })
}

// ---- tracks and slots ---------------------------------------------------------------------------------

/** Track types that drive one slot's node and are nothing without it. */
const SLOT_TRACKS: ReadonlySet<SequenceTrack['type']> = new Set(['path', 'preset', 'foliage', 'animation', 'audio', 'possess'])

/**
 * Add a track, shaped as the parse keeps it: its sections (or keys) present, empty optional fields dropped (a
 * script track with no slot calls the director; an animation track with no action slot plays in 'Sequence'). A
 * track the parse would drop — one that needs a slot and names none, a property with no path or target — is
 * refused: the sequence comes back unchanged.
 */
export function addTrack(seq: SequenceData, track: SequenceTrack): SequenceData {
  const slot = (track as { slot?: unknown }).slot
  const hasSlot = typeof slot === 'string' && slot.length > 0
  if (SLOT_TRACKS.has(track.type) && !hasSlot) return seq
  if (track.type === 'property' && (!track.path || (!track.target && !hasSlot))) return seq
  return editSequence(seq, d => {
    const t = structuredClone(track) as SequenceTrack & { sections?: unknown[]; keys?: unknown[]; slot?: string; animSlot?: string }
    if (t.type === 'event') t.keys ??= []
    else t.sections ??= []
    if (t.type === 'script' && !t.slot) delete t.slot
    if (t.type === 'animation' && !t.animSlot) delete t.animSlot
    d.tracks.push(t)
  })
}

export function patchTrack(seq: SequenceData, trackId: string, patch: Partial<SequenceTrack>): SequenceData {
  return editSequence(seq, d => {
    const t = findTrack(d, trackId)
    if (t) Object.assign(t, structuredClone(patch))
    if (t && (t as any).muted === false) delete (t as any).muted
  })
}

export function deleteTrack(seq: SequenceData, trackId: string): SequenceData {
  return editSequence(seq, d => { d.tracks = d.tracks.filter(t => t.id !== trackId) })
}

/** A slot id from a name: lower camel, unique within the sequence. */
export function slotIdFor(seq: SequenceData, name: string): string {
  const base = name.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : ''))
    .replace(/^./, c => c.toLowerCase()) || 'slot'
  let id = base, n = 2
  while (seq.slots.some(s => s.id === id)) id = `${base}${n++}`
  return id
}

export function addSlot(seq: SequenceData, slot: SequenceSlot): SequenceData {
  return editSequence(seq, d => { if (!d.slots.some(s => s.id === slot.id)) d.slots.push({ ...slot }) })
}

export function patchSlot(seq: SequenceData, slotId: string, patch: Partial<SequenceSlot>): SequenceData {
  return editSequence(seq, d => {
    const s = d.slots.find(x => x.id === slotId)
    if (!s) return
    Object.assign(s, patch)
    if (!s.path) delete s.path
    if (!s.nodeType) delete s.nodeType
  })
}

/**
 * Remove a slot and every track that drives it. Cut sections naming it go too, and possessions of it; a spawn
 * that was parented to it or filled it spawns at the scene root, filling nothing.
 */
export function deleteSlot(seq: SequenceData, slotId: string): SequenceData {
  return editSequence(seq, d => {
    d.slots = d.slots.filter(s => s.id !== slotId)
    d.tracks = d.tracks.filter(t => !('slot' in t) || (t as { slot?: string }).slot !== slotId)
    for (const t of d.tracks) {
      if (t.type === 'cameraCut') t.sections = t.sections.filter(s => s.slot !== slotId)
      if (t.type === 'event') t.keys = t.keys.filter(k => k.slot !== slotId)
      if (t.type === 'possess') t.sections = t.sections.filter(s => s.pawn !== slotId)
      if (t.type === 'spawn') for (const s of t.sections) { if (s.parent === slotId) delete s.parent; if (s.bindAs === slotId) delete s.bindAs }
    }
  })
}

// ---- markers and timing -------------------------------------------------------------------------------

export function addMarker(seq: SequenceData, t: number, name: string): SequenceData {
  return editSequence(seq, d => {
    d.markers.push({ t: Math.max(0, t), name })
    d.markers.sort((a, b) => a.t - b.t)
  })
}

export function patchMarker(seq: SequenceData, index: number, patch: Partial<{ t: number; name: string }>): SequenceData {
  return editSequence(seq, d => {
    const m = d.markers[index]
    if (!m) return
    Object.assign(m, patch)
    m.t = Math.max(0, m.t)
    d.markers.sort((a, b) => a.t - b.t)
  })
}

export function deleteMarker(seq: SequenceData, index: number): SequenceData {
  return editSequence(seq, d => { d.markers.splice(index, 1) })
}

export function patchSequence(seq: SequenceData, patch: Partial<Pick<SequenceData, 'name' | 'duration' | 'fps' | 'loop' | 'clock'>>): SequenceData {
  return editSequence(seq, d => {
    Object.assign(d, patch)
    d.duration = Math.max(MIN_SECTION, d.duration)
    d.fps = Math.min(240, Math.max(1, Math.round(d.fps)))
  })
}

/** Every time a drag may snap to: section edges, event keys, markers, 0 and the end. */
export function snapTargets(seq: SequenceData, except?: SectionRef): number[] {
  const out = [0, seq.duration]
  for (const t of seq.tracks) {
    if (t.type === 'event') { for (const k of t.keys) out.push(k.t); continue }
    for (const s of t.sections) if (!(except && except.trackId === t.id && except.sectionId === s.id)) out.push(s.start, s.end)
  }
  for (const m of seq.markers) out.push(m.t)
  return out
}

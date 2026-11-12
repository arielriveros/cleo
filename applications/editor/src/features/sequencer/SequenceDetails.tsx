import { useEffect, useRef, useState } from 'react'
import { CleoEngine, Game, compilePropertyPath } from 'cleo'
import type { SequenceNode } from 'cleo'
import type { PathLook, PathSection, Scene, SequenceData, SequenceKey, SequenceTrack } from 'cleo'
import { Button, NumberInput, PropertyRow, PropertyTable, Select, TextInput, Toggle, VectorInput } from '@cleo/app-kit/ui'
import NodeRefInput from '../nodeInspector/NodeRefInput'
import { useCleoEngine } from '../EngineContext'
import * as E from './sequenceEdits'
import type { SequencePreview } from './useSequencePreview'

// The Sequencer's right-hand column: the selected section, key, event, track, slot or marker, editable, or the
// sequence's own settings when nothing is selected. Continuous edits (typing a number, dragging a vector) show
// at once and are recorded as ONE undo step once they settle (`useSettledCommit`).

export type Selection =
  | { kind: 'section'; trackId: string; sectionId: string }
  | { kind: 'key'; trackId: string; sectionId: string; index: number }
  | { kind: 'event'; trackId: string; index: number }
  | { kind: 'track'; trackId: string }
  | { kind: 'slot'; slotId: string }
  | { kind: 'marker'; index: number }
  | null

type Commit = (label: string, next: SequenceData, before?: SequenceData) => Promise<void>
type Vec3 = [number, number, number]

interface Props {
  node: SequenceNode
  seq: SequenceData
  sel: Selection
  setSel: (s: Selection) => void
  commit: Commit
  preview: SequencePreview
  scene: Scene
}

/**
 * Edits that arrive in a stream (each keystroke, each drag step): applied live, recorded as one step 400 ms
 * after the last one, against the sequence as it was before the first.
 */
function useSettledCommit(node: SequenceNode, commit: Commit, preview: SequencePreview) {
  const { withoutDirty } = useCleoEngine()
  const pending = useRef<{ before: SequenceData; next: SequenceData; label: string; timer: number } | null>(null)
  const flush = () => {
    const p = pending.current
    if (!p) return
    pending.current = null
    window.clearTimeout(p.timer)
    void commit(p.label, p.next, p.before)
  }
  useEffect(() => flush, []) // eslint-disable-line react-hooks/exhaustive-deps
  return (label: string, next: SequenceData) => {
    if (!pending.current) pending.current = { before: node.sequence, next, label, timer: 0 }
    else { pending.current.next = next; window.clearTimeout(pending.current.timer) }
    withoutDirty(() => { node.sequence = next })
    preview.refresh()
    pending.current.timer = window.setTimeout(flush, 400)
  }
}

const round = (v: number) => Math.round(v * 1000) / 1000

/** The editor camera's pose, for "from viewport". */
function viewportPose(scene: Scene): { pos: Vec3; ahead: Vec3 } | null {
  const cam = scene.pinnedCamera
  if (!cam) return null
  const p = cam.worldPosition, f = cam.worldForward
  return { pos: [round(p[0]), round(p[1]), round(p[2])], ahead: [round(p[0] + f[0] * 10), round(p[1] + f[1] * 10), round(p[2] + f[2] * 10)] }
}

/** The object a property track's path starts from. */
function propertyRoot(node: SequenceNode, track: SequenceTrack): unknown {
  if (track.type !== 'property') return null
  if (track.target === 'renderer') return CleoEngine.instance?.renderer ?? null
  if (track.target === 'game') return Game
  return track.slot ? node.resolveSlot(track.slot) : null
}

/** A key value editor for a property track's value type. */
function ValueInput({ type, value, onChange }: { type: string; value: SequenceKey['v']; onChange: (v: SequenceKey['v']) => void }) {
  if (type === 'bool') return <Toggle checked={!!value} onChange={v => onChange(v)} />
  if (type === 'string') return <TextInput value={String(value ?? '')} onChange={v => onChange(v)} />
  if (type === 'vector') {
    const arr = Array.isArray(value) ? value : [0, 0, 0]
    return <VectorInput value={arr} labels={arr.length === 4 ? ['R', 'G', 'B', 'A'] : undefined} step={0.01} onChange={v => onChange(v)} />
  }
  return <NumberInput value={typeof value === 'number' ? value : 0} step={0.01} onChange={v => onChange(v)} />
}

export default function SequenceDetails({ node, seq, sel, setSel, commit, preview, scene }: Props) {
  const settle = useSettledCommit(node, commit, preview)
  const [, force] = useState(0)

  // ---- nothing selected: the sequence --------------------------------------------------------------------
  if (!sel) {
    return (
      <div className='p-2'>
        <div className='mb-1 text-ui-sm text-fg'>Sequence</div>
        <PropertyTable columns={['40%', '60%']}>
          <PropertyRow label='Name'><TextInput value={seq.name} onChange={v => settle('Rename sequence', E.patchSequence(seq, { name: v }))} /></PropertyRow>
          <PropertyRow label='Duration'><NumberInput value={seq.duration} step={0.5} onChange={v => settle('Duration', E.patchSequence(seq, { duration: v }))} /></PropertyRow>
          <PropertyRow label='Frame rate'><NumberInput value={seq.fps} step={1} onChange={v => settle('Frame rate', E.patchSequence(seq, { fps: v }))} /></PropertyRow>
          <PropertyRow label='Loop'><Toggle checked={seq.loop} onChange={v => void commit('Loop', E.patchSequence(seq, { loop: v }))} /></PropertyRow>
          <PropertyRow label='Clock' divider={false}>
            <Select value={seq.clock} onChange={e => void commit('Clock', E.patchSequence(seq, { clock: e.target.value as 'game' | 'real' }))}>
              <option value='game'>Game time (follows time scale)</option>
              <option value='real'>Real time</option>
            </Select>
          </PropertyRow>
        </PropertyTable>
        <div className='mt-3 text-ui-xs text-dim'>
          {seq.markers.length} markers. Double-click an empty lane to add a section; S splits the selected section at
          the playhead; M adds a marker; Space plays the preview.
        </div>
      </div>
    )
  }

  // ---- slot -------------------------------------------------------------------------------------------------
  if (sel.kind === 'slot') {
    const slot = seq.slots.find(s => s.id === sel.slotId)
    if (!slot) return null
    return (
      <div className='p-2'>
        <div className='mb-1 text-ui-sm text-fg'>Slot</div>
        <PropertyTable columns={['40%', '60%']}>
          <PropertyRow label='Name'><TextInput value={slot.name} onChange={v => settle('Rename slot', E.patchSlot(seq, slot.id, { name: v }))} /></PropertyRow>
          <PropertyRow label='Node'>
            <NodeRefInput value={node.bindings[slot.id] ?? null} scene={scene} filter={n => n !== node}
              placeholder={slot.path ? `(finds "${slot.path}")` : '(unbound)'}
              onChange={id => { node.bind(slot.id, id); preview.refresh(); force(x => x + 1) }} />
          </PropertyRow>
          <PropertyRow label='Fallback path'>
            <TextInput value={slot.path ?? ''} placeholder='Parent/Child' onChange={v => settle('Slot path', E.patchSlot(seq, slot.id, { path: v }))} />
          </PropertyRow>
          <PropertyRow label='Node type' divider={false}>
            <TextInput value={slot.nodeType ?? ''} placeholder='camera, node…' onChange={v => settle('Slot type', E.patchSlot(seq, slot.id, { nodeType: v }))} />
          </PropertyRow>
        </PropertyTable>
        <Button size='sm' variant='ghost' className='mt-2' onClick={() => { void commit('Delete slot', E.deleteSlot(seq, slot.id)); setSel(null) }}>Delete slot and its tracks</Button>
      </div>
    )
  }

  // ---- marker -----------------------------------------------------------------------------------------------
  if (sel.kind === 'marker') {
    const m = seq.markers[sel.index]
    if (!m) return null
    return (
      <div className='p-2'>
        <div className='mb-1 text-ui-sm text-fg'>Marker</div>
        <PropertyTable columns={['40%', '60%']}>
          <PropertyRow label='Name'><TextInput value={m.name} onChange={v => settle('Rename marker', E.patchMarker(seq, sel.index, { name: v }))} /></PropertyRow>
          <PropertyRow label='Time' divider={false}><NumberInput value={m.t} step={0.1} onChange={v => settle('Move marker', E.patchMarker(seq, sel.index, { t: v }))} /></PropertyRow>
        </PropertyTable>
        <div className='mt-2 flex gap-1'>
          <Button size='sm' onClick={() => preview.seek(m.t)}>Go to</Button>
          <Button size='sm' variant='ghost' onClick={() => { void commit('Delete marker', E.deleteMarker(seq, sel.index)); setSel(null) }}>Delete</Button>
        </div>
      </div>
    )
  }

  const track = E.findTrack(seq, sel.trackId)
  if (!track) return null

  // ---- event key -------------------------------------------------------------------------------------------
  if (sel.kind === 'event' && track.type === 'event') {
    const k = track.keys[sel.index]
    if (!k) return null
    const patch = (p: Parameters<typeof E.patchEventKey>[3]) => settle('Edit event', E.patchEventKey(seq, track.id, sel.index, p))
    return (
      <div className='p-2'>
        <div className='mb-1 text-ui-sm text-fg'>Event</div>
        <PropertyTable columns={['40%', '60%']}>
          <PropertyRow label='Time'><NumberInput value={k.t} step={0.1} onChange={v => patch({ t: v })} /></PropertyRow>
          <PropertyRow label='Name'><TextInput value={k.name ?? ''} onChange={v => patch({ name: v })} /></PropertyRow>
          <PropertyRow label='Method'><TextInput value={k.method ?? ''} placeholder='openGate' onChange={v => patch({ method: v })} /></PropertyRow>
          <PropertyRow label='On'>
            <Select value={k.slot ?? ''} onChange={e => patch({ slot: e.target.value || undefined })}>
              <option value=''>The director (this node's script)</option>
              {seq.slots.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </PropertyRow>
          <PropertyRow label='Arguments' divider={false}>
            <TextInput value={k.args ? JSON.stringify(k.args) : ''} placeholder='[1, "two"]'
              onChange={v => { try { const a = v.trim() ? JSON.parse(v) : undefined; if (a === undefined || Array.isArray(a)) patch({ args: a }) } catch { /* still typing */ } }} />
          </PropertyRow>
        </PropertyTable>
      </div>
    )
  }

  // ---- track ------------------------------------------------------------------------------------------------
  if (sel.kind === 'track') {
    return (
      <div className='p-2'>
        <div className='mb-1 text-ui-sm text-fg'>Track</div>
        <PropertyTable columns={['40%', '60%']}>
          <PropertyRow label='Name'><TextInput value={track.name ?? ''} placeholder={track.type} onChange={v => settle('Rename track', E.patchTrack(seq, track.id, { name: v || undefined }))} /></PropertyRow>
          <PropertyRow label='Muted'><Toggle checked={!!track.muted} onChange={v => void commit('Mute track', E.patchTrack(seq, track.id, { muted: v }))} /></PropertyRow>
          {track.type === 'property' && <>
            <PropertyRow label='Path'><TextInput value={track.path} onChange={v => settle('Property path', E.patchTrack(seq, track.id, { path: v } as any))} /></PropertyRow>
            <PropertyRow label='Value' divider={false}>
              <Select value={track.valueType} onChange={e => void commit('Value type', E.patchTrack(seq, track.id, { valueType: e.target.value } as any))}>
                <option value='number'>Number</option><option value='vector'>Vector</option><option value='bool'>On / off</option><option value='string'>Text</option>
              </Select>
            </PropertyRow>
          </>}
        </PropertyTable>
        <div className='mt-2 flex flex-wrap gap-1'>
          {track.type !== 'event' && (
            <Button size='sm' onClick={() => {
              const r = E.addSection(seq, track.id, preview.timeRef.current, 5)
              if (r) { void commit('Add section', r.seq); setSel({ kind: 'section', ...r.ref }) }
            }}>Add section at the playhead</Button>
          )}
          {track.type === 'event' && (
            <Button size='sm' onClick={() => void commit('Add event', E.addEventKey(seq, track.id, { t: preview.timeRef.current, name: 'event' }))}>Add event at the playhead</Button>
          )}
          <Button size='sm' variant='ghost' onClick={() => { void commit('Delete track', E.deleteTrack(seq, track.id)); setSel(null) }}>Delete track</Button>
        </div>
      </div>
    )
  }

  // ---- section (and a key inside it) -----------------------------------------------------------------------
  const ref = { trackId: sel.trackId, sectionId: (sel as { sectionId: string }).sectionId }
  const s = E.findSection(seq, ref)
  if (!s) return null
  const span = s.end - s.start
  const local = Math.min(span, Math.max(0, preview.timeRef.current - s.start))

  return (
    <div className='p-2'>
      <div className='mb-1 text-ui-sm text-fg'>{track.type === 'path' ? 'Path section' : track.type === 'cameraCut' ? 'Shot' : 'Property section'}</div>
      <PropertyTable columns={['40%', '60%']}>
        <PropertyRow label='Label'><TextInput value={s.label ?? ''} onChange={v => settle('Label', E.patchSection(seq, ref, { label: v || undefined }))} /></PropertyRow>
        <PropertyRow label='Start'><NumberInput value={round(s.start)} step={0.1} onChange={v => settle('Trim section', E.trimSectionStart(seq, ref, v))} /></PropertyRow>
        <PropertyRow label='End'><NumberInput value={round(s.end)} step={0.1} onChange={v => settle('Trim section', E.trimSectionEnd(seq, ref, v))} /></PropertyRow>
        <PropertyRow label='Ease in'><NumberInput value={s.easeIn ?? 0} step={0.1} min={0} onChange={v => settle('Ease section', E.patchSection(seq, ref, { easeIn: v }))} /></PropertyRow>
        <PropertyRow label='Ease out'><NumberInput value={s.easeOut ?? 0} step={0.1} min={0} onChange={v => settle('Ease section', E.patchSection(seq, ref, { easeOut: v }))} /></PropertyRow>
        <PropertyRow label='When finished' divider={false}>
          <Select value={s.whenFinished ?? ''} onChange={e => void commit('When finished', E.patchSection(seq, ref, { whenFinished: (e.target.value || undefined) as any }))}>
            <option value=''>{track.type === 'cameraCut' ? 'Restore (default)' : 'Keep (default)'}</option>
            <option value='keep'>Keep its last value</option>
            <option value='restore'>Restore what was there</option>
          </Select>
        </PropertyRow>
      </PropertyTable>

      {track.type === 'cameraCut' && (
        <PropertyTable columns={['40%', '60%']} className='mt-2'>
          <PropertyRow label='Camera' divider={false}>
            <Select value={s.slot ?? ''} onChange={e => void commit('Shot camera', E.patchSection(seq, ref, { slot: e.target.value }))}>
              {seq.slots.map(sl => <option key={sl.id} value={sl.id}>{sl.name}</option>)}
            </Select>
          </PropertyRow>
        </PropertyTable>
      )}

      {track.type === 'path' && <PathFields seq={seq} sref={ref} s={s as PathSection} scene={scene} settle={settle} commit={commit} />}

      {track.type === 'property' && s.curve && (
        <div className='mt-2'>
          <div className='mb-1 flex items-center gap-1 text-ui-xs text-dim'>
            <span className='flex-1'>Keys (seconds into the section)</span>
            <Button size='sm' onClick={() => {
              const root = propertyRoot(node, track)
              const v = root ? compilePropertyPath(root as object, track.path).get() : undefined
              const value = ArrayBuffer.isView(v) ? Array.from(v as unknown as ArrayLike<number>) : Array.isArray(v) ? v.slice() : v
              if (value === undefined) return
              void commit('Key value', E.setSectionKey(seq, ref, round(local), value as SequenceKey['v']))
            }} title="Add a key at the playhead holding the target's current value">Key current value</Button>
          </div>
          {s.curve.keys.map((k, i) => {
            const selected = sel.kind === 'key' && sel.index === i
            return (
              <div key={i} className={`mb-1 flex items-center gap-1 rounded px-1 ${selected ? 'bg-selected/40' : ''}`} onClick={() => setSel({ kind: 'key', ...ref, index: i })}>
                <NumberInput className='w-[56px]' value={k.t} step={0.1} onChange={v => settle('Move key', E.moveSectionKey(seq, ref, i, v))} />
                <div className='min-w-0 flex-1'><ValueInput type={track.valueType} value={k.v} onChange={v => settle('Edit key', E.patchSectionKey(seq, ref, i, { v }))} /></div>
                {(track.valueType === 'number' || track.valueType === 'vector') && (
                  <Select className='w-[64px]' value={k.interp ?? 'auto'} onChange={e => void commit('Key interpolation', E.patchSectionKey(seq, ref, i, { interp: e.target.value as any }))}>
                    <option value='auto'>auto</option><option value='linear'>linear</option><option value='cubic'>cubic</option><option value='constant'>step</option>
                  </Select>
                )}
                <Button size='sm' variant='ghost' title='Delete key' onClick={e => { e.stopPropagation(); void commit('Delete key', E.deleteSectionKey(seq, ref, i)) }}>×</Button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** A path section's points, look target and progress. */
function PathFields({ seq, sref, s, scene, settle, commit }: {
  seq: SequenceData; sref: E.SectionRef; s: PathSection; scene: Scene
  settle: (label: string, next: SequenceData) => void; commit: Commit
}) {
  const look: PathLook = s.look ?? { mode: 'ahead' }
  const setLook = (next: PathLook) => void commit('Path look', E.patchSection(seq, sref, { look: next }))
  const fromViewport = () => viewportPose(scene)
  return (
    <div className='mt-2'>
      <div className='mb-1 flex items-center gap-1 text-ui-xs text-dim'>
        <span className='flex-1'>Points ({s.points.length})</span>
        <Button size='sm' title='Append the editor camera position as a new point'
          onClick={() => { const p = fromViewport(); if (p) void commit('Add path point', E.addPathPoint(seq, sref, p.pos)) }}>Add from viewport</Button>
      </div>
      {s.points.map((pt, i) => (
        <div key={i} className='mb-1 flex items-center gap-1'>
          <span className='w-4 text-right text-ui-xs text-dim'>{i + 1}</span>
          <div className='min-w-0 flex-1'><VectorInput value={pt} step={0.1} onChange={v => settle('Move path point', E.setPathPoint(seq, sref, i, v as Vec3))} /></div>
          <Button size='sm' variant='ghost' title='Move this point to the editor camera'
            onClick={() => { const p = fromViewport(); if (p) void commit('Move path point', E.setPathPoint(seq, sref, i, p.pos)) }}>View</Button>
          <Button size='sm' variant='ghost' title='Delete point' disabled={s.points.length <= 1}
            onClick={() => void commit('Delete path point', E.deletePathPoint(seq, sref, i))}>×</Button>
        </div>
      ))}

      <PropertyTable columns={['40%', '60%']} className='mt-2'>
        <PropertyRow label='Look'>
          <Select value={look.mode} onChange={e => {
            const mode = e.target.value
            const ahead = fromViewport()?.ahead ?? [0, 0, 0]
            if (mode === 'ahead') setLook({ mode: 'ahead', distance: 6 })
            else if (mode === 'point') setLook({ mode: 'point', point: ahead })
            else if (mode === 'slot') setLook({ mode: 'slot', slot: seq.slots[0]?.id ?? '' })
            else setLook({ mode: 'path', points: s.points.map(p => [p[0], p[1], p[2]]) })
          }}>
            <option value='ahead'>Ahead along the path</option>
            <option value='point'>At a point</option>
            <option value='slot'>At a node (slot)</option>
            <option value='path'>Along a second path</option>
          </Select>
        </PropertyRow>
        {look.mode === 'ahead' && (
          <PropertyRow label='Distance' divider={false}>
            <NumberInput value={look.distance ?? 6} step={0.5} onChange={v => settle('Path look', E.patchSection(seq, sref, { look: { mode: 'ahead', distance: v } }))} />
          </PropertyRow>
        )}
        {look.mode === 'point' && (
          <PropertyRow label='Point' divider={false}>
            <div className='flex items-center gap-1'>
              <div className='min-w-0 flex-1'><VectorInput value={look.point} step={0.1} onChange={v => settle('Path look', E.patchSection(seq, sref, { look: { mode: 'point', point: v as Vec3 } }))} /></div>
              <Button size='sm' variant='ghost' title='Where the editor camera looks, 10 m ahead'
                onClick={() => { const p = fromViewport(); if (p) setLook({ mode: 'point', point: p.ahead }) }}>View</Button>
            </div>
          </PropertyRow>
        )}
        {look.mode === 'slot' && (
          <PropertyRow label='Node' divider={false}>
            <Select value={look.slot} onChange={e => setLook({ ...look, slot: e.target.value })}>
              {seq.slots.map(sl => <option key={sl.id} value={sl.id}>{sl.name}</option>)}
            </Select>
          </PropertyRow>
        )}
        {look.mode === 'path' && (
          <PropertyRow label='Look points' divider={false}>
            <span className='text-ui-xs text-dim'>{look.points.length} points{look.progress ? `, ${look.progress.keys.length} timing keys` : ', timed with the camera'}</span>
          </PropertyRow>
        )}
      </PropertyTable>

      <div className='mt-2 text-ui-xs text-dim'>
        {s.progress ? `Progress: ${s.progress.keys.length} keys` : 'Progress: constant speed'}
        {s.roll ? ` · roll ${s.roll.keys.length} keys` : ''}{s.fov ? ` · field of view ${s.fov.keys.length} keys` : ''}
      </div>
      <div className='mt-1 flex flex-wrap gap-1'>
        <Button size='sm' variant='ghost' title='Ease the move in and out'
          onClick={() => void commit('Ease path', E.patchSection(seq, sref, { progress: { keys: [{ t: 0, v: 0 }, { t: s.end - s.start, v: 1 }] } }))}>Ease in and out</Button>
        <Button size='sm' variant='ghost' title='The same speed all along'
          onClick={() => void commit('Constant speed', E.patchSection(seq, sref, { progress: { keys: [{ t: 0, v: 0, interp: 'linear' }, { t: s.end - s.start, v: 1 }] } }))}>Constant speed</Button>
      </div>
    </div>
  )
}


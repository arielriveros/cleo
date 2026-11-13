import { useEffect, useRef, useState } from 'react'
import { mat4, vec3 } from 'gl-matrix'
import { CleoEngine, Game, compilePropertyPath, sequencePresetsFor, FOLIAGE_CHANNELS } from 'cleo'
import type { SequenceNode } from 'cleo'
import type {
  AnimationSection, AudioSection, FoliageChannel, FoliageSection, FoliageTrack, PathLook, PathSection, PossessSection,
  PresetSection, Scene, ScriptSection, SequenceCurve, SequenceData, SequenceKey, SequenceTrack, SpawnSection,
} from 'cleo'
import { Button, ComboSelect, NumberInput, PropertyRow, PropertyTable, Select, TextInput, Toggle, VectorInput, cn } from '@cleo/app-kit/ui'
import NodeRefInput from '../nodeInspector/NodeRefInput'
import { useCleoEngine } from '../EngineContext'
import { useAssetLibrary } from '../AssetLibraryContext'
import * as E from './sequenceEdits'
import { animatorNodeOf, clipNamesOf, newSectionInit, pawnSlotsFor } from './slotTargets'
import type { SequencePreview } from './useSequencePreview'
import { namePathOf } from './SequenceEditorContext'

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
  /** Show a sequence without recording it (a stream of edits not yet settled). */
  live: (next: SequenceData) => void
  preview: SequencePreview
  scene: Scene
}

/**
 * Edits that arrive in a stream (each keystroke, each drag step): applied live, recorded as one step 400 ms
 * after the last one, against the sequence as it was before the first.
 */
function useSettledCommit(seq: SequenceData, commit: Commit, live: (next: SequenceData) => void) {
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
    if (!pending.current) pending.current = { before: seq, next, label, timer: 0 }
    else { pending.current.next = next; window.clearTimeout(pending.current.timer) }
    live(next)
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

/** The preset list a Preset track's node blends between, or none. */
function presetsOf(node: SequenceNode, track: SequenceTrack) {
  return track.type === 'preset' ? sequencePresetsFor(node.resolveSlot(track.slot) ?? null) : null
}

/** The layer names of a Foliage track's landscape. */
function layerNamesOf(node: SequenceNode, track: SequenceTrack): string[] {
  if (track.type !== 'foliage') return []
  const foliage: { name: string }[] = (node.resolveSlot(track.slot) as { terrain?: { foliage?: { name: string }[] } } | null)?.terrain?.foliage ?? []
  return foliage.map(l => l.name)
}

/** The editor camera's position, in `parent`'s space when given (a spawn under a slot's node). */
function viewportPointIn(scene: Scene, parent: { worldTransform: mat4 } | null): Vec3 | null {
  const pose = viewportPose(scene)
  if (!pose || !parent) return pose?.pos ?? null
  const inv = mat4.invert(mat4.create(), parent.worldTransform)
  if (!inv) return pose.pos
  const p = vec3.transformMat4(vec3.create(), pose.pos, inv)
  return [round(p[0]), round(p[1]), round(p[2])]
}

/** A section's heading in the details, by its track's type. */
const SECTION_TITLES: Record<SequenceTrack['type'], string> = {
  path: 'Path section', cameraCut: 'Shot', property: 'Property section', event: 'Event', preset: 'Preset blend',
  foliage: 'Foliage section', script: 'Script section', animation: 'Animation section', audio: 'Audio section',
  spawn: 'Spawn', possess: 'Possession',
}

/** What "keep" and "restore" do once the timeline leaves a section of each type, and which it does unset. */
interface FinishLabels { unset: string; keep: string; restore: string }
const FINISH_DEFAULT: FinishLabels = { unset: 'Keep (default)', keep: 'Keep its last value', restore: 'Restore what was there' }
const FINISH: Partial<Record<SequenceTrack['type'], FinishLabels>> = {
  cameraCut: { ...FINISH_DEFAULT, unset: 'Restore (default)' },
  animation: { unset: 'Fade the clip out (default)', keep: 'Let the clip play out', restore: 'Fade the clip out' },
  audio: { unset: 'Stop the sound (default)', keep: 'Let the sound play on', restore: 'Stop the sound' },
  spawn: { unset: 'Remove it (default)', keep: 'Leave it in the scene', restore: 'Remove it' },
  possess: { unset: 'Hand the pawn back (default)', keep: 'Keep the pawn', restore: 'Hand the pawn back' },
}

/** A method name a script can declare. */
const isMethodName = (text: string) => /^[A-Za-z_$][\w$]*$/.test(text.trim())

/** Arguments typed as JSON: an array, nothing (none), or null while the text is not one yet. */
function parseArgs(text: string): unknown[] | undefined | null {
  if (!text.trim()) return undefined
  try { const a = JSON.parse(text); return Array.isArray(a) ? a : null } catch { return null }
}

/**
 * A text field over a draft: what is typed stays in the box, and only text `valid` accepts is handed on (an
 * empty method would drop the section, half-typed JSON is not arguments yet). Flagged while the draft is not
 * valid; back to the stored value on leaving the field. Key it by what it edits, so a new selection starts clean.
 */
function DraftInput({ value, valid, onChange, placeholder, title, invalidTitle }: {
  value: string; valid: (text: string) => boolean; onChange: (text: string) => void
  placeholder?: string; title?: string; invalidTitle?: string
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const ok = draft === null || valid(draft)
  return (
    <TextInput value={draft ?? value} placeholder={placeholder} title={ok ? title : invalidTitle ?? title}
      className={cn(!ok && 'border-danger text-danger-fg')}
      onChange={text => { setDraft(text); if (valid(text)) onChange(text) }}
      onBlur={() => setDraft(null)} />
  )
}

/** A call's arguments as JSON (`[1, "two"]`), handed on once the text is an array (or empty: none). */
function ArgsInput({ value, onChange }: { value: unknown[] | undefined; onChange: (args: unknown[] | undefined) => void }) {
  return (
    <DraftInput value={value ? JSON.stringify(value) : ''} placeholder='[1, "two"]'
      title='Passed on in ctx.args, as a JSON array' invalidTitle='Not a JSON array yet'
      valid={text => parseArgs(text) !== null} onChange={text => onChange(parseArgs(text) ?? undefined)} />
  )
}

/**
 * One of a section's curves as a table of keys (section seconds, value, interpolation), with a Key button that
 * adds one at the playhead: a Foliage channel, an Audio section's volume.
 */
function KeyTable({ seq, sref, field, curve, label, hint, unset, isBool, newKey, clampValue, local, settle, commit }: {
  seq: SequenceData; sref: E.SectionRef; field: E.CurveField; curve: SequenceCurve | undefined
  label: string; hint: string; unset: string; isBool?: boolean
  /** The value a key added at section time `t` starts with. */
  newKey: (t: number) => SequenceKey['v']
  clampValue?: (v: number) => number
  local: number; settle: (label: string, next: SequenceData) => void; commit: Commit
}) {
  return (
    <div className='mt-2'>
      <div className='mb-1 flex items-center gap-1 text-ui-xs text-dim' title={hint}>
        <span className='flex-1'>{label}{curve ? '' : ` (${unset})`}</span>
        <Button size='sm' title={`Add a ${label.toLowerCase()} key at the playhead`}
          onClick={() => void commit(`Key ${label.toLowerCase()}`, E.setSectionKey(seq, sref, round(local), newKey(round(local)), undefined, field))}>Key</Button>
      </div>
      {curve?.keys.map((k, i) => (
        <div key={i} className='mb-1 flex items-center gap-1 px-1'>
          <NumberInput className='w-[56px]' value={k.t} step={0.1} onChange={v => settle('Move key', E.moveSectionKey(seq, sref, i, v, field))} />
          <div className='min-w-0 flex-1'>
            <ValueInput type={isBool ? 'bool' : 'number'} value={k.v}
              onChange={v => settle('Edit key', E.patchSectionKey(seq, sref, i, { v: clampValue && typeof v === 'number' ? clampValue(v) : v }, field))} />
          </div>
          {!isBool && (
            <Select className='w-[64px]' value={k.interp ?? 'auto'} onChange={e => void commit('Key interpolation', E.patchSectionKey(seq, sref, i, { interp: e.target.value as any }, field))}>
              <option value='auto'>auto</option><option value='linear'>linear</option><option value='cubic'>cubic</option><option value='constant'>step</option>
            </Select>
          )}
          <Button size='sm' variant='ghost' title='Delete key' onClick={() => void commit('Delete key', E.deleteSectionKey(seq, sref, i, field))}>×</Button>
        </div>
      ))}
    </div>
  )
}

const FOLIAGE_LABELS: Record<FoliageChannel, { label: string; hint: string }> = {
  density: { label: 'Density', hint: "× the layers' instances drawn: 1 all of them, 0.1 one in ten (a nested subset, spread evenly)" },
  cull: { label: 'Draw distance', hint: "× the layers' draw distance: 0.15 brings a 450 m forest in to under 70 m, nearest trees kept" },
  billboard: { label: 'Impostor distance', hint: "× where the layers turn into their impostor cards" },
  shadows: { label: 'Shadows', hint: 'Whether the layers cast shadows, switched where the key says' },
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

export default function SequenceDetails({ node, seq, sel, setSel, commit, live, preview, scene }: Props) {
  const settle = useSettledCommit(seq, commit, live)
  const [, force] = useState(0)
  const { templates } = useAssetLibrary()
  const templateNames = templates.map(t => t.name)

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
            {/* The sequence's own binding (`nodeId`), with the node's name path as the fallback another scene
                finds it by. A Sequence node's per-scene overrides are on its card, in the scene tab. */}
            <NodeRefInput value={slot.nodeId ?? null} scene={scene} filter={n => n !== node && !n.isEditorOwned}
              placeholder={slot.path ? `(finds "${slot.path}")` : '(unbound)'}
              onChange={id => {
                const bound = id ? scene.getNodeById(id) : null
                void commit('Bind slot', E.patchSlot(seq, slot.id, bound
                  ? { nodeId: bound.id, path: namePathOf(bound, scene.root), nodeType: slot.nodeType ?? bound.nodeType }
                  : { nodeId: undefined }))
              }} />
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
            <ArgsInput key={`${track.id}:${sel.index}`} value={k.args} onChange={args => patch({ args })} />
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
          {track.type === 'preset' && (
            <PropertyRow label='Presets' divider={false}>
              <span className='text-ui-xs text-dim'>{presetsOf(node, track)?.length ?? 0} on {node.resolveSlot(track.slot)?.name ?? 'the unbound slot'}</span>
            </PropertyRow>
          )}
          {track.type === 'foliage' && <FoliageLayersRow node={node} seq={seq} track={track} commit={commit} />}
          {track.type === 'script' && (
            <PropertyRow label='Calls' divider={false}>
              <Select value={track.slot ?? ''} title='Whose script the sections call'
                onChange={e => void commit('Script target', E.patchTrack(seq, track.id, { slot: e.target.value || undefined } as any))}>
                <option value=''>The director (this node's script)</option>
                {seq.slots.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </PropertyRow>
          )}
          {track.type === 'animation' && (() => {
            const owner = animatorNodeOf(node.resolveSlot(track.slot)) as { name?: string } | null
            const clips = clipNamesOf(node.resolveSlot(track.slot))
            return <>
              <PropertyRow label='Action slot'>
                <TextInput value={track.animSlot ?? ''} placeholder='Sequence' title="The animator's action slot the clips play in (a masked one keeps the legs on locomotion)"
                  onChange={v => settle('Action slot', E.patchTrack(seq, track.id, { animSlot: v || undefined } as any))} />
              </PropertyRow>
              <PropertyRow label='Clips' divider={false}>
                <span className='text-ui-xs text-dim'>{owner ? `${clips.length} on ${owner.name ?? 'its animator'}` : node.resolveSlot(track.slot) ? 'No animator on the bound node' : 'The slot is unbound'}</span>
              </PropertyRow>
            </>
          })()}
          {(track.type === 'audio' || track.type === 'possess') && (
            <PropertyRow label={track.type === 'audio' ? 'Sound' : 'Controller'} divider={false}>
              <span className='text-ui-xs text-dim'>{node.resolveSlot(track.slot)?.name ?? 'The slot is unbound'}</span>
            </PropertyRow>
          )}
          {track.type === 'property' && <>
            <PropertyRow label='Path'><TextInput value={track.path} onChange={v => settle('Property path', E.patchTrack(seq, track.id, { path: v } as any))} /></PropertyRow>
            <PropertyRow label='Value' divider={false}>
              <Select value={track.valueType} onChange={e => void commit('Value type', E.patchTrack(seq, track.id, { valueType: e.target.value } as any))}>
                <option value='number'>Number</option><option value='vector'>Vector</option><option value='bool'>On / off</option><option value='string'>Text</option>
              </Select>
            </PropertyRow>
          </>}
        </PropertyTable>
        {track.type === 'spawn' && <div className='mt-2 text-ui-xs text-dim'>Spawns in Play only: the editor's preview spawns nothing.</div>}
        {track.type === 'script' && <div className='mt-2 text-ui-xs text-dim'>Scripts run in Play only: the editor's preview calls nothing.</div>}
        {track.type === 'audio' && <div className='mt-2 text-ui-xs text-dim'>Sounds stay quiet while you edit: the track is heard in Play.</div>}
        <div className='mt-2 flex flex-wrap gap-1'>
          {track.type !== 'event' && (
            <Button size='sm' onClick={async () => {
              const at = preview.timeRef.current
              const init = await newSectionInit(node, seq, track, templateNames)
              const r = init ? E.addSection(seq, track.id, at, 5, init) : null
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
  const finish = FINISH[track.type] ?? FINISH_DEFAULT
  // A script section's method is told when it is left (its exit): there is nothing for the sequence to keep.
  const hasFinish = track.type !== 'script'

  return (
    <div className='p-2'>
      <div className='mb-1 text-ui-sm text-fg'>{SECTION_TITLES[track.type]}</div>
      <PropertyTable columns={['40%', '60%']}>
        <PropertyRow label='Label'><TextInput value={s.label ?? ''} onChange={v => settle('Label', E.patchSection(seq, ref, { label: v || undefined }))} /></PropertyRow>
        <PropertyRow label='Start'><NumberInput value={round(s.start)} step={0.1} onChange={v => settle('Trim section', E.trimSectionStart(seq, ref, v))} /></PropertyRow>
        <PropertyRow label='End'><NumberInput value={round(s.end)} step={0.1} onChange={v => settle('Trim section', E.trimSectionEnd(seq, ref, v))} /></PropertyRow>
        <PropertyRow label='Ease in'><NumberInput value={s.easeIn ?? 0} step={0.1} min={0} onChange={v => settle('Ease section', E.patchSection(seq, ref, { easeIn: v }))} /></PropertyRow>
        <PropertyRow label='Ease out' divider={hasFinish}><NumberInput value={s.easeOut ?? 0} step={0.1} min={0} onChange={v => settle('Ease section', E.patchSection(seq, ref, { easeOut: v }))} /></PropertyRow>
        {hasFinish && (
          <PropertyRow label='When finished' divider={false}>
            <Select value={s.whenFinished ?? ''} onChange={e => void commit('When finished', E.patchSection(seq, ref, { whenFinished: (e.target.value || undefined) as any }))}>
              <option value=''>{finish.unset}</option>
              <option value='keep'>{finish.keep}</option>
              <option value='restore'>{finish.restore}</option>
            </Select>
          </PropertyRow>
        )}
      </PropertyTable>

      {track.type === 'script' && (() => {
        const ss = s as ScriptSection
        const who = track.slot ? (seq.slots.find(sl => sl.id === track.slot)?.name ?? track.slot) : 'the director'
        return <>
          <PropertyTable columns={['40%', '60%']} className='mt-2'>
            <PropertyRow label='Method'>
              <DraftInput key={`${s.id}:method`} value={ss.method} placeholder={E.DEFAULT_SCRIPT_METHOD}
                title='Called with a context on entering the section, every frame inside it and on leaving it'
                invalidTitle='A method name: letters, digits and _, not starting with a digit'
                valid={isMethodName} onChange={v => settle('Script method', E.patchSection(seq, ref, { method: v.trim() }))} />
            </PropertyRow>
            <PropertyRow label='Arguments'>
              <ArgsInput key={`${s.id}:args`} value={ss.args} onChange={args => settle('Script arguments', E.patchSection(seq, ref, { args }))} />
            </PropertyRow>
            <PropertyRow label='Hold at the end' divider={false}>
              <Toggle checked={!!ss.hold} title='Playback waits at the end of this section until the method calls ctx.resume()'
                onChange={v => void commit('Hold', E.patchSection(seq, ref, { hold: v }))} />
            </PropertyRow>
          </PropertyTable>
          <div className='mt-2 text-ui-xs text-dim'>
            Calls {ss.method}(ctx) on {who}{ss.hold ? ', then waits at the end until ctx.resume()' : ''}. Scripts run in Play only.
          </div>
        </>
      })()}

      {track.type === 'animation' && (() => {
        const an = s as AnimationSection
        const clips = clipNamesOf(node.resolveSlot(track.slot))
        return (
          <PropertyTable columns={['40%', '60%']} className='mt-2'>
            <PropertyRow label='Clip'>
              {clips.length > 0
                ? <ComboSelect value={an.clip} noun='clip' allowEmpty={false} allowCustom choices={clips.map(value => ({ value }))}
                    title='The clip played as an action over the controller' onChange={v => { if (v.trim()) void commit('Clip', E.patchSection(seq, ref, { clip: v.trim() })) }} />
                : <DraftInput key={`${s.id}:clip`} value={an.clip} title="The clip's name (the bound node shows no clips here)"
                    valid={v => v.trim().length > 0} onChange={v => settle('Clip', E.patchSection(seq, ref, { clip: v.trim() }))} />}
            </PropertyRow>
            <PropertyRow label='Clip start'>
              <NumberInput value={an.clipStart ?? 0} step={0.1} min={0} title="Clip seconds at the section's start"
                onChange={v => settle('Clip start', E.patchSection(seq, ref, { clipStart: Math.max(0, v) }))} />
            </PropertyRow>
            <PropertyRow label='Speed'>
              <NumberInput value={an.speed ?? 1} step={0.1} min={0} title='Clip seconds per sequence second'
                onChange={v => settle('Clip speed', E.patchSection(seq, ref, { speed: Math.max(0, v) }))} />
            </PropertyRow>
            <PropertyRow label='Loop' divider={false}>
              <Toggle checked={!!an.loop} onChange={v => void commit('Loop clip', E.patchSection(seq, ref, { loop: v }))} />
            </PropertyRow>
          </PropertyTable>
        )
      })()}

      {track.type === 'audio' && (() => {
        const au = s as AudioSection
        return <>
          <PropertyTable columns={['40%', '60%']} className='mt-2'>
            <PropertyRow label='Offset' divider={false}>
              <NumberInput value={au.offset ?? 0} step={0.1} min={0} title="Seconds into the sample at the section's start"
                onChange={v => settle('Audio offset', E.patchSection(seq, ref, { offset: Math.max(0, v) }))} />
            </PropertyRow>
          </PropertyTable>
          <KeyTable seq={seq} sref={ref} field='volume' curve={au.volume as SequenceCurve | undefined} label='Volume'
            hint="× the sound node's volume over the section, 0 to 1 (times the eases)" unset='full'
            newKey={t => (au.volume ? E.curveValueAt(au.volume as SequenceCurve, t) : 1)} clampValue={v => Math.min(1, Math.max(0, v))}
            local={local} settle={settle} commit={commit} />
        </>
      })()}

      {track.type === 'spawn' && <SpawnFields node={node} seq={seq} sref={ref} s={s as SpawnSection} scene={scene}
        templates={templateNames} settle={settle} commit={commit} />}

      {track.type === 'possess' && (() => {
        const ps = s as PossessSection
        const pawns = pawnSlotsFor(node, seq, track.slot)
        return (
          <PropertyTable columns={['40%', '60%']} className='mt-2'>
            <PropertyRow label='Pawn' divider={false}>
              <Select value={ps.pawn} title='The slot whose character the controller takes over'
                onChange={e => void commit('Pawn', E.patchSection(seq, ref, { pawn: e.target.value }))}>
                {!pawns.some(p => p.id === ps.pawn) && <option value={ps.pawn}>{ps.pawn} (missing)</option>}
                {pawns.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </PropertyRow>
          </PropertyTable>
        )
      })()}

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

      {track.type === 'preset' && (() => {
        const list = presetsOf(node, track) ?? []
        const ps = s as PresetSection
        return (
          <PropertyTable columns={['40%', '60%']} className='mt-2'>
            <PropertyRow label='Blend to'>
              <Select value={ps.preset} onChange={e => void commit('Preset', E.patchSection(seq, ref, { preset: e.target.value }))}>
                {!list.some(p => p.id === ps.preset) && <option value={ps.preset}>{ps.preset} (unknown)</option>}
                {list.map(p => <option key={p.id} value={p.id} title={p.description}>{p.label}</option>)}
              </Select>
            </PropertyRow>
            <PropertyRow label='From' divider={false}>
              <Select value={ps.from ?? ''} onChange={e => void commit('Preset start', E.patchSection(seq, ref, { from: e.target.value || undefined }))}>
                <option value=''>Where the last blend ended</option>
                {list.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
              </Select>
            </PropertyRow>
          </PropertyTable>
        )
      })()}

      {track.type === 'foliage' && FOLIAGE_CHANNELS.map(channel => {
        const { label, hint } = FOLIAGE_LABELS[channel]
        return (
          <KeyTable key={channel} seq={seq} sref={ref} field={channel} curve={(s as FoliageSection)[channel] as SequenceCurve | undefined}
            label={label} hint={hint} unset='as authored' isBool={channel === 'shadows'} newKey={() => (channel === 'shadows' ? true : 1)}
            local={local} settle={settle} commit={commit} />
        )
      })}

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

/** A spawn section's template, where it appears, under what, and the slot it fills. */
function SpawnFields({ node, seq, sref, s, scene, templates, settle, commit }: {
  node: SequenceNode; seq: SequenceData; sref: E.SectionRef; s: SpawnSection; scene: Scene; templates: string[]
  settle: (label: string, next: SequenceData) => void; commit: Commit
}) {
  const patch = (label: string, p: Partial<SpawnSection>) => void commit(label, E.patchSection(seq, sref, p))
  const parentNode = s.parent ? node.resolveSlot(s.parent) : null
  const slotOptions = seq.slots.map(sl => <option key={sl.id} value={sl.id}>{sl.name}</option>)
  const vectorRow = (label: string, key: 'position' | 'rotation', note: string, extra?: React.ReactNode) => (
    <div className='mt-2'>
      <div className='mb-1 flex items-center gap-1 text-ui-xs text-dim'>
        <span className='flex-1'>{label}{s[key] ? note : " (the template's own)"}</span>
        {extra}
        {s[key] && <Button size='sm' variant='ghost' title="Back to the template's own" onClick={() => patch(`Spawn ${label.toLowerCase()}`, { [key]: undefined })}>×</Button>}
      </div>
      <VectorInput value={s[key] ?? [0, 0, 0]} step={key === 'rotation' ? 1 : 0.1}
        onChange={v => settle(`Spawn ${label.toLowerCase()}`, E.patchSection(seq, sref, { [key]: v.slice(0, 3) as Vec3 }))} />
    </div>
  )
  return (
    <div className='mt-2'>
      <PropertyTable columns={['40%', '60%']}>
        <PropertyRow label='Template'>
          {templates.length > 0
            ? <ComboSelect value={s.template} noun='template' allowEmpty={false} allowCustom choices={templates.map(value => ({ value }))}
                title='The template instantiated while the section is in' onChange={v => { if (v.trim()) patch('Spawn template', { template: v.trim() }) }} />
            : <DraftInput key={`${s.id}:template`} value={s.template} title="The template's name (the project has none yet)"
                valid={v => v.trim().length > 0} onChange={v => settle('Spawn template', E.patchSection(seq, sref, { template: v.trim() }))} />}
        </PropertyRow>
        <PropertyRow label='Name'>
          <TextInput value={s.name ?? ''} placeholder="The template's own" onChange={v => settle('Spawn name', E.patchSection(seq, sref, { name: v || undefined }))} />
        </PropertyRow>
        <PropertyRow label='Parent'>
          <Select value={s.parent ?? ''} title="Spawn under this slot's node instead of the scene root"
            onChange={e => patch('Spawn parent', { parent: e.target.value || undefined })}>
            <option value=''>The scene root</option>
            {slotOptions}
          </Select>
        </PropertyRow>
        <PropertyRow label='Fills slot' divider={false}>
          <Select value={s.bindAs ?? ''} title='The slot the spawned node fills while it lives, so other tracks drive it'
            onChange={e => patch('Spawn slot', { bindAs: e.target.value || undefined })}>
            <option value=''>None</option>
            {slotOptions}
          </Select>
        </PropertyRow>
      </PropertyTable>
      {vectorRow('Position', 'position', s.parent ? ' (local to the parent)' : '',
        <Button size='sm' title={s.parent ? "The editor camera's position, in the parent's space" : "The editor camera's position"}
          onClick={() => { const p = viewportPointIn(scene, parentNode); if (p) patch('Spawn position', { position: p }) }}>Set from viewport</Button>)}
      {vectorRow('Rotation', 'rotation', ' (degrees)')}
    </div>
  )
}

/** A Foliage track's layers: every layer, or the ones ticked. */
function FoliageLayersRow({ node, seq, track, commit }: { node: SequenceNode; seq: SequenceData; track: FoliageTrack; commit: Commit }) {
  const names = layerNamesOf(node, track)
  const all = track.layers === 'all'
  const chosen = new Set(all ? names : track.layers)
  const set = (layers: string[] | 'all') => void commit('Foliage layers', E.patchTrack(seq, track.id, { layers } as any))
  return <>
    <PropertyRow label='All layers' divider={all}>
      <Toggle checked={all} onChange={v => set(v ? 'all' : names.slice())} />
    </PropertyRow>
    {!all && (
      <PropertyRow label='Layers' divider={false}>
        <div className='flex flex-col gap-0.5'>
          {names.length === 0 && <span className='text-ui-xs text-dim'>The slot is not a landscape with foliage.</span>}
          {names.map(n => (
            <Toggle key={n} label={n} checked={chosen.has(n)}
              onChange={v => set(v ? [...(track.layers as string[]), n] : (track.layers as string[]).filter(x => x !== n))} />
          ))}
          {(track.layers as string[]).filter(n => !names.includes(n)).map(n => (
            <span key={n} className='text-ui-xs text-warning' title='No layer of this name on the landscape'>{n} (missing)</span>
          ))}
        </div>
      </PropertyRow>
    )}
  </>
}

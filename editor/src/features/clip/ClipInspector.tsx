import { useMemo, useState } from 'react'
import { useCleoEngine } from '../EngineContext'
import { useClip } from './ClipContext'
import Collapsable from '../../components/Collapsable'
import BonePose from './BonePose'
import { promptDialog } from '../dialogs/dialogStore'
import { Toggle } from '../../components/ui'
import type { StoredClip, StoredClipEdit } from '../../utils/animationAssets'

// The clip editor's inspector: which clip is on screen, what its root motion does, and its edit stack.
//
// The stack is the reason this feature exists. Every entry is re-applied by `applyClipEdits` on every
// resolve rather than written into the keyframes, so it is reversible, and one entry can be pushed onto
// many clips at once — which is what makes "hold a torch in all thirty locomotion clips" a single gesture
// instead of thirty re-bakes.

const EDIT_LABEL: Record<StoredClipEdit['kind'], string> = {
  mirror: 'Mirror',
  inPlace: 'In place',
  poseOffset: 'Pose offset',
  trim: 'Trim',
  timeScale: 'Retime',
}

/**
 * The order edits actually run in, which is NOT this list's order — `applyClipEdits` sorts by a fixed rank
 * so a clip cannot change because the artist dragged a row. Shown so the rows read in the order they take
 * effect, and there is deliberately no reorder handle.
 */
const EDIT_RANK: Record<StoredClipEdit['kind'], number> = { trim: 0, mirror: 1, poseOffset: 2, inPlace: 3, timeScale: 4 }

/** How each edit describes itself in one line, so the stack is readable without expanding a row. */
function summarize(e: StoredClipEdit): string {
  switch (e.kind) {
    case 'mirror': return e.axis ? `across ${e.axis.toUpperCase()}` : 'auto axis'
    case 'inPlace': return `${e.strip ?? 'xz'}${e.keepYaw ? ', keep turn' : ''}`
    case 'poseOffset': return `${e.poseId ? 'shared pose' : `${e.bones?.length ?? 0} bone(s)`}${e.weight !== undefined && e.weight !== 1 ? ` @ ${Math.round(e.weight * 100)}%` : ''}`
    case 'trim': return `${e.start.toFixed(2)}s – ${e.end.toFixed(2)}s`
    case 'timeScale': return e.duration ? `to ${e.duration.toFixed(2)}s` : `x${(e.scale ?? 1).toFixed(2)}`
  }
}

export default function ClipInspector() {
  const { editingAnimationId, modelsForClip, setClipPreviewModel, clipPreviewModelId, activeTab, rigs } = useCleoEngine()
  const { asset, clip, clipName, selectClip, patchClip, setEdits, addEditToClips, save, saveAs, dirty } = useClip()
  const [batchOpen, setBatchOpen] = useState(false)
  const [batchPicked, setBatchPicked] = useState<Set<string>>(new Set())

  const rig = useMemo(() => (asset?.rigId ? rigs.find(r => r.id === asset.rigId) : undefined), [asset?.rigId, rigs])
  const poses = rig?.poses ?? []

  if (!asset) return <div className='p-3 text-xs text-gray-400'>No animation open.</div>

  const edits = clip?.edits ?? []
  const characters = modelsForClip(asset)
  const previewId = clipPreviewModelId(activeTab.id)

  const sortedEdits = edits
    .map((e, i) => ({ e, i }))
    .sort((a, b) => EDIT_RANK[a.e.kind] - EDIT_RANK[b.e.kind])

  const replaceEdit = (index: number, next: StoredClipEdit) =>
    setEdits(edits.map((e, i) => (i === index ? next : e)))
  const removeEdit = (index: number) => setEdits(edits.filter((_, i) => i !== index))
  const addEdit = (e: StoredClipEdit) => setEdits([...edits, e])

  /**
   * Root motion as ONE decision with three answers, because that is what it is. `rootMotion` drives the
   * character from the clip's root delta at runtime; an `inPlace` edit removes the same motion from the
   * curves instead. They are opposites, so a radio rather than two toggles that can both be on.
   */
  const hasInPlace = edits.some(e => e.kind === 'inPlace' && e.enabled !== false)
  const rootMode: 'mesh' | 'character' | 'inPlace' = hasInPlace ? 'inPlace' : clip?.rootMotion ? 'character' : 'mesh'
  const setRootMode = (mode: 'mesh' | 'character' | 'inPlace') => {
    if (!clip || !clipName) return
    const withoutInPlace = (clip.edits ?? []).filter(e => e.kind !== 'inPlace')
    const next: StoredClip = mode === 'inPlace'
      ? { ...clip, rootMotion: undefined, edits: [...withoutInPlace, { kind: 'inPlace', strip: 'xz' }] }
      : { ...clip, rootMotion: mode === 'character' ? true : undefined, edits: withoutInPlace }
    patchClip(clipName, next, 'Root motion')
  }

  const section = 'text-xs text-gray-300'
  const btn = 'px-2 py-0.5 rounded bg-control hover:bg-control-hover border border-control-hover text-white text-xs'

  return (
    <div className='flex flex-col gap-2 p-2 text-xs'>
      <div className='flex items-center gap-2'>
        <span className='font-semibold text-white truncate' title={asset.name}>{asset.name}</span>
        {dirty && <span className='text-highlight' title='Unsaved changes'>●</span>}
        <button className={btn + ' ml-auto'} onClick={save} disabled={!dirty} title='Save this animation (Ctrl+S)'>Save</button>
        <button
          className={btn}
          title='Save the edited clips as a NEW .anim asset, leaving this one exactly as it was'
          onClick={() => {
            void promptDialog({
              title: 'Save as a new animation',
              message: 'The clips and their edits are copied to a new .anim asset on the same rig. This one is left unchanged.',
              defaultValue: `${asset.name} copy`,
              // Names are how a `.anim` is found in the asset tree, so an empty one is refused here rather
              // than minting an unnamed asset the user then has to hunt for.
              validate: v => (v.trim() ? null : 'Give the new animation a name.'),
            }).then(name => { if (name?.trim()) saveAs(name.trim()) })
          }}>Save As…</button>
      </div>

      <Collapsable title='Clips'>
        <div className='flex flex-col gap-0.5'>
          {asset.clips.length === 0 && <div className='text-gray-400'>This asset has no clips.</div>}
          {asset.clips.map(c => (
            <button
              key={c.name}
              className={`text-left px-2 py-1 rounded ${c.name === clipName ? 'bg-control-hover text-white' : 'hover:bg-control text-gray-300'}`}
              onClick={() => selectClip(c.name)}>
              {c.name}
              {!!c.edits?.filter(e => e.enabled !== false).length &&
                <span className='ml-1 text-highlight' title={`${c.edits.filter(e => e.enabled !== false).length} edit(s)`}>✦</span>}
            </button>
          ))}
        </div>
      </Collapsable>

      {characters.length > 1 && (
        <Collapsable title='Preview character'>
          <select
            className='w-full bg-control text-white border border-control-hover rounded px-2 py-1'
            value={previewId ?? ''}
            onChange={e => setClipPreviewModel(activeTab.id, e.target.value)}
            title='Which character on this rig to preview the clip on'>
            {characters.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </Collapsable>
      )}

      {clip && <BonePose />}

      {clip && (
        <Collapsable title='Root motion'>
          <div className='flex flex-col gap-1'>
            {([
              ['mesh', 'Leave in the clip', 'The mesh travels and the character node stays put — the raw import.'],
              ['character', 'Drive the character', 'Extract the root delta at runtime and move the character with it.'],
              ['inPlace', 'Bake in place', 'Remove the travel from the curves; a script drives movement instead. Vertical motion is kept, so a jump keeps its arc.'],
            ] as const).map(([mode, label, hint]) => (
              <label key={mode} className='flex items-start gap-2 cursor-pointer' title={hint}>
                <input type='radio' className='mt-0.5' checked={rootMode === mode} onChange={() => setRootMode(mode)} />
                <span className={rootMode === mode ? 'text-white' : 'text-gray-300'}>{label}</span>
              </label>
            ))}
          </div>
        </Collapsable>
      )}

      {clip && (
        <Collapsable title={`Edits${edits.length ? ` (${edits.length})` : ''}`}>
          <div className='flex flex-col gap-1'>
            <p className='text-gray-400 leading-snug'>
              Applied every time the clip is played, never written into the keyframes — remove one and the
              original is back. Rows run in the order shown, whatever order they were added in.
            </p>

            {sortedEdits.map(({ e, i }) => (
              <div key={i} className='border border-border rounded p-1.5 flex flex-col gap-1'>
                <div className='flex items-center gap-2'>
                  <Toggle
                    checked={e.enabled !== false}
                    onChange={on => replaceEdit(i, { ...e, enabled: on || undefined } as StoredClipEdit)} />
                  <span className={e.enabled === false ? 'text-gray-500 line-through' : 'text-white'}>{EDIT_LABEL[e.kind]}</span>
                  <span className='text-gray-400 truncate'>{summarize(e)}</span>
                  <button className='ml-auto text-gray-400 hover:text-red-400' title='Remove this edit' onClick={() => removeEdit(i)}>✕</button>
                </div>

                {e.kind === 'mirror' && (
                  <label className='flex items-center gap-1 text-gray-300' title='Which axis separates left from right. Auto measures it from the rig rather than assuming X.'>
                    axis
                    <select className='bg-control text-white border border-control-hover rounded px-1'
                      value={e.axis ?? ''} onChange={ev => replaceEdit(i, { ...e, axis: (ev.target.value || undefined) as any })}>
                      <option value=''>auto</option><option value='x'>X</option><option value='y'>Y</option><option value='z'>Z</option>
                    </select>
                  </label>
                )}

                {e.kind === 'inPlace' && (
                  <div className='flex items-center gap-2 flex-wrap text-gray-300'>
                    <label className='flex items-center gap-1' title='Which travel to remove. "xz" keeps vertical motion, so a jump keeps its arc.'>
                      strip
                      <select className='bg-control text-white border border-control-hover rounded px-1'
                        value={e.strip ?? 'xz'} onChange={ev => replaceEdit(i, { ...e, strip: ev.target.value as any })}>
                        <option value='xz'>horizontal</option><option value='all'>all</option><option value='y'>vertical only</option>
                      </select>
                    </label>
                    <Toggle label='keep turn' checked={!!e.keepYaw}
                      onChange={on => replaceEdit(i, { ...e, keepYaw: on || undefined })} />
                  </div>
                )}

                {e.kind === 'timeScale' && (
                  <label className='flex items-center gap-1 text-gray-300' title='Playback speed of the clip itself. Root-motion speed scales with it.'>
                    scale
                    <input className='w-[64px] bg-control text-white border border-control-hover rounded px-1'
                      type='number' step='0.05' min='0.01' value={e.scale ?? 1}
                      onChange={ev => replaceEdit(i, { ...e, scale: Math.max(0.01, parseFloat(ev.target.value) || 1), duration: undefined })} />
                  </label>
                )}

                {e.kind === 'trim' && (
                  <div className='flex items-center gap-2 text-gray-300'>
                    <label className='flex items-center gap-1'>from
                      <input className='w-[64px] bg-control text-white border border-control-hover rounded px-1'
                        type='number' step='0.05' min='0' value={e.start}
                        onChange={ev => replaceEdit(i, { ...e, start: Math.max(0, parseFloat(ev.target.value) || 0) })} /></label>
                    <label className='flex items-center gap-1'>to
                      <input className='w-[64px] bg-control text-white border border-control-hover rounded px-1'
                        type='number' step='0.05' min='0' value={e.end}
                        onChange={ev => replaceEdit(i, { ...e, end: Math.max(0, parseFloat(ev.target.value) || 0) })} /></label>
                  </div>
                )}

                {e.kind === 'poseOffset' && (
                  <div className='flex items-center gap-2 flex-wrap text-gray-300'>
                    <label className='flex items-center gap-1' title='A pose stored on this clip’s rig. Editing it updates every clip that references it.'>
                      pose
                      <select className='bg-control text-white border border-control-hover rounded px-1 max-w-[130px]'
                        value={e.poseId ?? ''} onChange={ev => replaceEdit(i, { ...e, poseId: ev.target.value || undefined })}>
                        <option value=''>— none —</option>
                        {poses.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    </label>
                    <label className='flex items-center gap-1' title='How much of the pose to apply.'>
                      weight
                      <input className='w-[56px] bg-control text-white border border-control-hover rounded px-1'
                        type='number' step='0.05' min='0' max='1' value={e.weight ?? 1}
                        onChange={ev => replaceEdit(i, { ...e, weight: Math.max(0, Math.min(1, parseFloat(ev.target.value) || 0)) })} />
                    </label>
                  </div>
                )}
              </div>
            ))}

            <div className='flex items-center gap-1 flex-wrap pt-1'>
              <button className={btn} title='Swap left and right' onClick={() => addEdit({ kind: 'mirror' })}>+ Mirror</button>
              <button className={btn} title='Remove the root travel' onClick={() => addEdit({ kind: 'inPlace', strip: 'xz' })}>+ In place</button>
              <button className={btn} title='Add a pose on top of the clip' onClick={() => addEdit({ kind: 'poseOffset', poseId: poses[0]?.id })}>+ Pose</button>
              <button className={btn} title='Keep only part of the clip' onClick={() => addEdit({ kind: 'trim', start: 0, end: Math.max(0.1, clipLength(clip)) })}>+ Trim</button>
              <button className={btn} title='Speed the clip up or slow it down' onClick={() => addEdit({ kind: 'timeScale', scale: 1 })}>+ Retime</button>
            </div>

            {asset.clips.length > 1 && (
              <button className={btn + ' mt-1'} onClick={() => { setBatchPicked(new Set()); setBatchOpen(v => !v) }}
                title='Add the selected clip’s newest edit to several clips at once'>
                {batchOpen ? 'Cancel' : 'Apply an edit to other clips…'}
              </button>
            )}

            {batchOpen && edits.length > 0 && (
              <div className='border border-border rounded p-1.5 flex flex-col gap-1'>
                <div className='text-gray-400'>Copy “{EDIT_LABEL[edits[edits.length - 1].kind]}” onto:</div>
                {asset.clips.filter(c => c.name !== clipName).map(c => (
                  <label key={c.name} className='flex items-center gap-2 cursor-pointer'>
                    <input type='checkbox' checked={batchPicked.has(c.name)} onChange={ev => {
                      const next = new Set(batchPicked)
                      if (ev.target.checked) next.add(c.name); else next.delete(c.name)
                      setBatchPicked(next)
                    }} />
                    <span className='text-gray-300'>{c.name}</span>
                  </label>
                ))}
                <button className={btn} disabled={batchPicked.size === 0}
                  onClick={() => { addEditToClips([...batchPicked], edits[edits.length - 1]); setBatchOpen(false) }}>
                  Apply to {batchPicked.size} clip{batchPicked.size === 1 ? '' : 's'}
                </button>
              </div>
            )}
          </div>
        </Collapsable>
      )}
    </div>
  )
}

/** The clip's length, from its samplers — there is no authored duration field. */
function clipLength(clip: StoredClip): number {
  let max = 0
  for (const s of clip.samplers) if (s.input.length) max = Math.max(max, s.input[s.input.length - 1])
  return max
}

import { useMemo, useState } from 'react'
import { useCleoEngine } from '../EngineContext'
import { useAssetLibrary } from '../AssetLibraryContext'
import { posesForRig } from '../../utils/poseAssets'
import { useClip } from './ClipContext'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import BonePose from './BonePose'
import { promptDialog } from '@cleo/app-kit/feedback/dialogStore'
import { Button, DocScope, NumberInput, SegmentedControl, Select, Toggle } from '@cleo/app-kit/ui'
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

  const { poseAssets } = useAssetLibrary()
  const rig = useMemo(() => (asset?.rigId ? rigs.find(r => r.id === asset.rigId) : undefined), [asset?.rigId, rigs])
  // The rig's own (legacy) poses plus every pose asset on it — the same union a clip resolves against.
  const poses = useMemo(() => posesForRig(rig, poseAssets), [rig, poseAssets])

  if (!asset) return <div className='p-3 text-ui text-muted'>No animation open.</div>

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

  const num = 'w-[64px] px-1 py-0'

  return (
    // The clip editor's own section first: its "Clips" is this asset's clip list, not the Animator's panel.
    <DocScope page='editor/animation' section='the-clip-editor'>
      <div className='flex flex-col gap-2 p-2 text-ui'>
        <div className='flex items-center gap-2'>
          <span className='font-semibold text-fg truncate' title={asset.name}>{asset.name}</span>
          {dirty && <span className='text-highlight' title='Unsaved changes'>●</span>}
          <Button size='sm' className='ml-auto' onClick={save} disabled={!dirty} title='Save this animation (Ctrl+S)'>Save</Button>
          <Button
            size='sm'
            title='Save the edited clips as a NEW .anim asset, leaving this one exactly as it was'
            onClick={() => {
              void promptDialog({
                title: 'Save as a new animation',
                message: 'The clips and their edits are copied to a new .anim asset on the same skeleton. This one is left unchanged.',
                defaultValue: `${asset.name} copy`,
                // Names are how a `.anim` is found in the asset tree, so an empty one is refused here rather
                // than minting an unnamed asset the user then has to hunt for.
                validate: v => (v.trim() ? null : 'Give the new animation a name.'),
              }).then(name => { if (name?.trim()) saveAs(name.trim()) })
            }}>Save As…</Button>
        </div>

        <Collapsable title='Clips'>
          <div className='flex flex-col gap-0.5'>
            {asset.clips.length === 0 && <div className='text-muted'>This asset has no clips.</div>}
            {asset.clips.map(c => (
              <button
                key={c.name}
                className={`text-left px-2 py-1 rounded ${c.name === clipName ? 'bg-control-hover text-fg' : 'hover:bg-control text-muted'}`}
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
            <Select
              className='w-full'
              value={previewId ?? ''}
              onChange={e => setClipPreviewModel(activeTab.id, e.target.value)}
              title='Which character on this skeleton to preview the clip on'>
              {characters.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>
          </Collapsable>
        )}

        {clip && <BonePose />}

        {clip && (
          <Collapsable title='Root motion'>
            {/* Was a radio group: re-picking the current answer must stay a no-op, or re-choosing "Bake in place"
                would reset that edit's strip/keep-turn settings. */}
            <SegmentedControl<'mesh' | 'character' | 'inPlace'>
              className='flex w-full flex-col items-stretch' itemClassName='justify-start'
              value={rootMode} onChange={mode => { if (mode !== rootMode) setRootMode(mode) }}
              options={[
                { value: 'mesh', label: 'Leave in the clip', doc: 'editor/animation#root-motion::Leave in the clip' },
                { value: 'character', label: 'Drive the character', doc: 'editor/animation#root-motion::Drive the character' },
                { value: 'inPlace', label: 'Bake in place', doc: 'editor/animation#root-motion::Bake in place' },
              ]} />
          </Collapsable>
        )}

        {clip && (
          <Collapsable title={`Edits${edits.length ? ` (${edits.length})` : ''}`} doc='Edits'>
            <div className='flex flex-col gap-1'>
              {sortedEdits.map(({ e, i }) => (
                <div key={i} className='border border-border rounded p-1.5 flex flex-col gap-1'>
                  <div className='flex items-center gap-2'>
                    <Toggle
                      checked={e.enabled !== false}
                      onChange={on => replaceEdit(i, { ...e, enabled: on || undefined } as StoredClipEdit)} />
                    <span className={e.enabled === false ? 'text-dim line-through' : 'text-fg'}>{EDIT_LABEL[e.kind]}</span>
                    <span className='text-muted truncate'>{summarize(e)}</span>
                    <Button variant='remove' size='sm' className='ml-auto px-1 py-0' title='Remove this edit' onClick={() => removeEdit(i)}>✕</Button>
                  </div>

                  {e.kind === 'mirror' && (
                    <label className='flex items-center gap-1 text-muted' title='Which axis separates left from right. Auto measures it from the skeleton rather than assuming X.'>
                      axis
                      <Select className='px-1 py-0'
                        value={e.axis ?? ''} onChange={ev => replaceEdit(i, { ...e, axis: (ev.target.value || undefined) as any })}>
                        <option value=''>auto</option><option value='x'>X</option><option value='y'>Y</option><option value='z'>Z</option>
                      </Select>
                    </label>
                  )}

                  {e.kind === 'inPlace' && (
                    <div className='flex items-center gap-2 flex-wrap text-muted'>
                      <label className='flex items-center gap-1' title='Which travel to remove. "xz" keeps vertical motion, so a jump keeps its arc.'>
                        strip
                        <Select className='px-1 py-0'
                          value={e.strip ?? 'xz'} onChange={ev => replaceEdit(i, { ...e, strip: ev.target.value as any })}>
                          <option value='xz'>horizontal</option><option value='all'>all</option><option value='y'>vertical only</option>
                        </Select>
                      </label>
                      <Toggle label='keep turn' checked={!!e.keepYaw}
                        onChange={on => replaceEdit(i, { ...e, keepYaw: on || undefined })} />
                    </div>
                  )}

                  {e.kind === 'timeScale' && (
                    <label className='flex items-center gap-1 text-muted' title='Playback speed of the clip itself. Root-motion speed scales with it.'>
                      scale
                      <NumberInput className={num}
                        step='0.05' min='0.01' value={e.scale ?? 1}
                        onChange={v => replaceEdit(i, { ...e, scale: Math.max(0.01, v || 1), duration: undefined })} />
                    </label>
                  )}

                  {e.kind === 'trim' && (
                    <div className='flex items-center gap-2 text-muted'>
                      <label className='flex items-center gap-1'>from
                        <NumberInput className={num}
                          step='0.05' min='0' value={e.start}
                          onChange={v => replaceEdit(i, { ...e, start: Math.max(0, v) })} /></label>
                      <label className='flex items-center gap-1'>to
                        <NumberInput className={num}
                          step='0.05' min='0' value={e.end}
                          onChange={v => replaceEdit(i, { ...e, end: Math.max(0, v) })} /></label>
                    </div>
                  )}

                  {e.kind === 'poseOffset' && (
                    <div className='flex items-center gap-2 flex-wrap text-muted'>
                      <label className='flex items-center gap-1' title='A pose stored on this clip’s skeleton. Editing it updates every clip that references it.'>
                        pose
                        <Select className='px-1 py-0 max-w-[130px]'
                          value={e.poseId ?? ''} onChange={ev => replaceEdit(i, { ...e, poseId: ev.target.value || undefined })}>
                          <option value=''>— none —</option>
                          {poses.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </Select>
                      </label>
                      <label className='flex items-center gap-1' title='How much of the pose to apply.'>
                        weight
                        <NumberInput className='w-[56px] px-1 py-0'
                          step='0.05' min='0' max='1' value={e.weight ?? 1}
                          onChange={v => replaceEdit(i, { ...e, weight: Math.max(0, Math.min(1, v)) })} />
                      </label>
                    </div>
                  )}
                </div>
              ))}

              <div className='flex items-center gap-1 flex-wrap pt-1'>
                <Button size='sm' title='Swap left and right' onClick={() => addEdit({ kind: 'mirror' })}>+ Mirror</Button>
                <Button size='sm' title='Remove the root travel' onClick={() => addEdit({ kind: 'inPlace', strip: 'xz' })}>+ In place</Button>
                <Button size='sm' title='Add a pose on top of the clip' onClick={() => addEdit({ kind: 'poseOffset', poseId: poses[0]?.id })}>+ Pose</Button>
                <Button size='sm' title='Keep only part of the clip' onClick={() => addEdit({ kind: 'trim', start: 0, end: Math.max(0.1, clipLength(clip)) })}>+ Trim</Button>
                <Button size='sm' title='Speed the clip up or slow it down' onClick={() => addEdit({ kind: 'timeScale', scale: 1 })}>+ Retime</Button>
              </div>

              {asset.clips.length > 1 && (
                <Button size='sm' className='mt-1' onClick={() => { setBatchPicked(new Set()); setBatchOpen(v => !v) }}
                  title='Add the selected clip’s newest edit to several clips at once'>
                  {batchOpen ? 'Cancel' : 'Apply an edit to other clips…'}
                </Button>
              )}

              {batchOpen && edits.length > 0 && (
                <div className='border border-border rounded p-1.5 flex flex-col gap-1'>
                  <div className='text-muted'>Copy “{EDIT_LABEL[edits[edits.length - 1].kind]}” onto:</div>
                  {asset.clips.filter(c => c.name !== clipName).map(c => (
                    <Toggle key={c.name} className='text-muted' label={c.name} checked={batchPicked.has(c.name)} onChange={on => {
                      const next = new Set(batchPicked)
                      if (on) next.add(c.name); else next.delete(c.name)
                      setBatchPicked(next)
                    }} />
                  ))}
                  <Button size='sm' disabled={batchPicked.size === 0}
                    onClick={() => { addEditToClips([...batchPicked], edits[edits.length - 1]); setBatchOpen(false) }}>
                    Apply to {batchPicked.size} clip{batchPicked.size === 1 ? '' : 's'}
                  </Button>
                </div>
              )}
            </div>
          </Collapsable>
        )}
      </div>
    </DocScope>
  )
}

/** The clip's length, from its samplers — there is no authored duration field. */
function clipLength(clip: StoredClip): number {
  let max = 0
  for (const s of clip.samplers) if (s.input.length) max = Math.max(max, s.input[s.input.length - 1])
  return max
}

import { useCleoEngine } from '../EngineContext'
import { useClip } from './ClipContext'
import { useClipAssetEdit } from '../animation/useClipEvents'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { Button, DocScope, Hint, SegmentedControl, Select } from '@cleo/app-kit/ui'

// The Clip Player's inspector: which clip is on screen, which character plays it, and whether its root
// motion drives the character. The clip's events are on the Timeline. Motion itself — keys, poses, retiming —
// is authored in Cleo Creator ▸ Motion; the editor only plays clips and places their events.
//
// A clip may still carry an edit stack from before (mirror, trim, pose offset…). It keeps resolving — the
// engine's `applyClipEdits` is untouched — and this panel says so, with one way out: remove it.

type RootMode = 'mesh' | 'character'

export default function ClipInspector() {
  const { modelsForClip, setClipPreviewModel, clipPreviewModelId, activeTab } = useCleoEngine()
  const { asset, clip, clipName, selectClip, creatorManaged } = useClip()
  const editClip = useClipAssetEdit()

  if (!asset) return <div className='p-3 text-ui text-muted'>No animation open.</div>

  const characters = modelsForClip(asset)
  const previewId = clipPreviewModelId(activeTab.id)

  const edits = clip?.edits ?? []
  const applied = edits.filter(e => e.enabled !== false).length
  // A legacy In place edit strips the travel and clears `rootMotion` when the clip resolves, so while one is
  // on the stack the choice below would not take effect.
  const bakedInPlace = edits.some(e => e.kind === 'inPlace' && e.enabled !== false)
  const rootMode: RootMode = clip?.rootMotion && !bakedInPlace ? 'character' : 'mesh'
  // Cleo Creator rewrites its clips on every sync and keeps only their events, so nothing else is offered.
  const locked = creatorManaged || bakedInPlace

  const setRootMode = (mode: RootMode) => {
    if (!clip || !clipName || mode === rootMode) return
    editClip(asset.id, clipName, { rootMotion: mode === 'character' ? true : undefined }, 'Root motion')
  }
  const removeEdits = () => {
    if (clip && clipName) editClip(asset.id, clipName, { edits: undefined }, 'Remove legacy edits')
  }

  return (
    <DocScope page='editor/animation' section='the-clip-player'>
      <div className='flex flex-col gap-2 p-2 text-ui'>
        <div className='flex items-center gap-2'>
          <span className='font-semibold text-fg truncate' title={asset.name}>{asset.name}</span>
          {creatorManaged && (
            <span className='ml-auto text-ui-xs text-highlight shrink-0'
              title='Synced from Cleo Creator. Its events can be edited here; everything else is re-made by the next sync.'>Cleo Creator</span>
          )}
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
                {!!c.events?.length && <span className='ml-1 text-ui-xs text-highlight' title={`${c.events.length} event(s)`}>▾{c.events.length}</span>}
              </button>
            ))}
            {clip && edits.length > 0 && (
              <div className='mt-1 flex items-center gap-2 text-ui-sm text-muted'>
                <span className='flex-1' title={edits.map(e => e.kind).join(', ')}>
                  {applied} legacy edit{applied === 1 ? '' : 's'} applied
                </span>
                <Button size='sm' variant='subtle' className='px-1.5 py-0' disabled={creatorManaged}
                  title='Play the clip as it was imported, without its old edit stack'
                  onClick={removeEdits}>Remove</Button>
              </div>
            )}
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

        {clip && (
          <Collapsable title='Root motion'>
            <SegmentedControl<RootMode>
              className='flex w-full flex-col items-stretch' itemClassName='justify-start'
              value={rootMode} onChange={setRootMode}
              options={[
                { value: 'mesh', label: 'Leave in the clip', doc: 'editor/animation#root-motion::Leave in the clip', disabled: locked },
                { value: 'character', label: 'Drive the character', doc: 'editor/animation#root-motion::Drive the character', disabled: locked },
              ]} />
            {bakedInPlace && <Hint>A legacy In place edit removes this clip’s travel. Remove the legacy edits to choose.</Hint>}
          </Collapsable>
        )}

        <Hint>Motion is authored in Cleo Creator ▸ Motion.</Hint>
      </div>
    </DocScope>
  )
}

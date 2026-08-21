import { useState } from 'react'
import { useAssetLibrary } from '../AssetLibraryContext'
import { useEditorSessions } from '../EditorSessionsContext'
import { cn, TextInput, Hint } from '../../components/ui'

// Linking shared `.anim` assets to a model — the animation half of what TextureInspector does for maps.
//
// The whole shared-clip stack already existed (a `.anim` stores its clips in the SOURCE rig's space and is
// retargeted per model at use), and the asset explorer already emits `text/cleo-animation` when one is
// dragged out — but nothing consumed it, and nothing displayed a model's `animationIds`. The only way to
// attach a clip was to import a file, which meant re-importing the same walk for every character.
//
// The link lives on the MODEL asset, deliberately: that is what makes one stored walk play on every
// placement of a character rather than on the one node that happened to be selected.

export default function AnimationAssetPicker(props: {
  /** The model asset to link to, or null when the node has no asset yet. */
  modelId: string | null
  /** Called before linking when `modelId` is null — adopts the node into the library. See adoptModelAsset. */
  onNeedModel?: () => Promise<string | null>
  className?: string
}) {
  const { models, animations } = useAssetLibrary()
  const { linkAnimationToModel, unlinkAnimationFromModel } = useEditorSessions()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [dragOver, setDragOver] = useState(false)

  const asset = props.modelId ? models.find(m => m.id === props.modelId) : undefined
  const linkedIds = asset?.animationIds ?? []

  const link = async (animationId: string) => {
    setOpen(false)
    setQuery('')
    // A node that never came from the library has nothing to hang the link on; adopt it first rather than
    // making the user go and create a model asset by hand.
    const modelId = props.modelId ?? (await props.onNeedModel?.()) ?? null
    if (modelId) linkAnimationToModel(modelId, animationId)
  }

  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('text/cleo-animation')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDragOver(true)
  }
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    const id = e.dataTransfer.getData('text/cleo-animation')
    if (id) void link(id)
  }

  const candidates = animations.filter(a =>
    !linkedIds.includes(a.id) && a.name.toLowerCase().includes(query.trim().toLowerCase()))

  const row = 'w-full flex items-center gap-2 px-2 py-1 text-left text-xs'

  return (
    <div
      className={cn('flex flex-col gap-1 rounded border-2 border-dashed p-1.5',
        dragOver ? 'border-selected bg-border/30' : 'border-border', props.className)}
      onDragOver={onDragOver}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      {linkedIds.map(id => {
        const anim = animations.find(a => a.id === id)
        return (
          <div key={id} className={cn(row, 'rounded bg-control/40')}>
            <span className='truncate flex-1' title={anim?.name ?? id}>
              {/* A link outlives the asset it names (deleting an animation while the model is closed is
                  normal), so a dangling id is shown rather than silently dropped — otherwise the only
                  symptom is clips that stopped appearing. */}
              {anim ? anim.name : `${id} — missing`}
            </span>
            {anim && <span className='text-[10px] text-muted shrink-0'>{anim.clips.length} clip{anim.clips.length === 1 ? '' : 's'}</span>}
            <button
              className='text-danger px-1 shrink-0'
              title='Unlink this animation — its clips are removed from every placement of this model'
              onClick={() => props.modelId && unlinkAnimationFromModel(props.modelId, id)}
            >✕</button>
          </div>
        )
      })}

      <div className='relative'>
        <button
          className='w-full rounded border border-control-hover px-2 py-1 text-xs hover:bg-control'
          onClick={() => setOpen(o => !o)}
          title='Play clips from an animation already in the library'
        >
          + Link Animation…
        </button>
        {open && (
          <div className='absolute left-0 right-0 top-full mt-1 z-[9999] rounded-md border border-border bg-surface-raised shadow-lg p-2 flex flex-col gap-2'>
            <TextInput placeholder='Search animations…' value={query} onChange={setQuery} autoFocus />
            <div className='max-h-56 overflow-auto rounded border border-border bg-surface'>
              {candidates.map(a => (
                <button key={a.id} className={cn(row, 'hover:bg-control')} onClick={() => void link(a.id)}>
                  <span className='truncate flex-1'>{a.name}</span>
                  <span className='text-[10px] text-muted shrink-0'>{a.clips.length}</span>
                </button>
              ))}
              {candidates.length === 0 && (
                <div className='px-2 py-3 text-xs text-muted'>
                  {animations.length === 0 ? 'No animations in the library yet — import one.' : 'No matches'}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {linkedIds.length === 0 && !open && (
        <Hint>…or drag an animation from the <b>Assets</b> tab here.</Hint>
      )}
    </div>
  )
}

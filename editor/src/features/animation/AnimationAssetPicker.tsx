import { useState } from 'react'
import { useAssetLibrary } from '../AssetLibraryContext'
import { useEditorSessions } from '../EditorSessionsContext'
import { cn, TextInput, Hint, Toggle } from '../../components/ui'
import { useAssetDrop } from '../../utils/useAssetDrop'

// Links shared `.anim` assets to a RIG. The link lives on the rig, not on a model or a node, so one stored
// clip plays on every character built on that armature — and on every placement of each of them.
//
// It also carries the per-clip ROOT MOTION toggle. That control existed only in the Animation editor's
// Clips panel, which is gated to `mode === 'animation'` and opened from a placed model — so once clips
// moved onto the rig, the one place you would look for them had no way to set it. Same writer
// (`editSharedClip`), same wording, so the two cannot drift.

export default function AnimationAssetPicker(props: {
  /** The rig asset to link to, or null when the node has no rig yet. */
  rigId: string | null
  /** Called before linking when `rigId` is null — adopts the node into the library. See adoptModelAsset. */
  onNeedRig?: () => Promise<string | null>
  className?: string
}) {
  const { rigs, animations } = useAssetLibrary()
  const { linkAnimationToRig, unlinkAnimationFromRig, editSharedClip } = useEditorSessions()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const asset = props.rigId ? rigs.find(r => r.id === props.rigId) : undefined
  const linkedIds = asset?.animationIds ?? []

  const link = async (animationId: string) => {
    setOpen(false)
    setQuery('')
    // A node with no rig has nothing to hang the link on, so resolve one first.
    const rigId = props.rigId ?? (await props.onNeedRig?.()) ?? null
    if (rigId) linkAnimationToRig(rigId, animationId)
  }

  const { dragOver, dropProps } = useAssetDrop('text/cleo-animation', id => void link(id),
    { dropEffect: 'copy', stopPropagation: true })

  const candidates = animations.filter(a =>
    !linkedIds.includes(a.id) && a.name.toLowerCase().includes(query.trim().toLowerCase()))

  const row = 'w-full flex items-center gap-2 px-2 py-1 text-left text-xs'

  /**
   * Root motion on one clip of one asset.
   *
   * Written straight onto the `.anim` asset, which is what makes it stick for every character on the rig
   * — `editSharedClip` patches the asset, drops its retarget cache and re-applies it to each of them.
   * The wording is copied verbatim from the Animation editor's Clips panel, deliberately.
   */
  const rootMotionToggle = (animationId: string, clip: { name: string; rootMotion?: boolean }) => (
    <span
      className='shrink-0'
      title='Root motion — apply this clip&#39;s root bone translation/rotation to the character (body if it has one) instead of playing it in place'
    >
      <Toggle
        checked={!!clip.rootMotion}
        onChange={on => editSharedClip(animationId, clip.name, { rootMotion: on })}
      />
    </span>
  )

  return (
    <div
      className={cn('flex flex-col gap-1 rounded border-2 border-dashed p-1.5',
        dragOver ? 'border-selected bg-border/30' : 'border-border', props.className)}
      {...dropProps}
    >
      {linkedIds.map(id => {
        const anim = animations.find(a => a.id === id)
        return (
          <div key={id} className='flex flex-col'>
            <div className={cn(row, 'rounded bg-control/40')}>
              <span className='truncate flex-1' title={anim?.name ?? id}>
                {/* A link outlives the asset it names (deleting an animation while the model is closed is
                    normal), so a dangling id is shown rather than silently dropped — otherwise the only
                    symptom is clips that stopped appearing. */}
                {anim ? anim.name : `${id} — missing`}
              </span>
              {/* One clip is the overwhelmingly common case (an imported .fbx holds exactly one), so its
                  toggle sits on this row rather than in a nested list of one. */}
              {anim?.clips.length === 1 && rootMotionToggle(id, anim.clips[0])}
              {anim && anim.clips.length !== 1 && (
                <span className='text-[10px] text-muted shrink-0'>{anim.clips.length} clips</span>
              )}
              <button
                className='text-danger px-1 shrink-0'
                title='Unlink this animation — its clips are removed from every placement of this model'
                onClick={() => props.rigId && unlinkAnimationFromRig(props.rigId, id)}
              >✕</button>
            </div>
            {anim && anim.clips.length > 1 && anim.clips.map(clip => (
              <div key={clip.name} className={cn(row, 'pl-4 opacity-90')}>
                <span className='truncate flex-1' title={clip.name}>{clip.name}</span>
                {rootMotionToggle(id, clip)}
              </div>
            ))}
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

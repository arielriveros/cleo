import { useState } from 'react'
import { useAssetLibrary } from '../AssetLibraryContext'
import { useEditorSessions } from '../EditorSessionsContext'
import { cn, TextInput, Hint } from '../../components/ui'
import { useAssetDrop } from '../../utils/useAssetDrop'

// Links shared `.anim` assets to a RIG. The link lives on the rig, not on a model or a node, so one stored
// clip plays on every character built on that armature — and on every placement of each of them.
//
// It used to carry a per-clip ROOT MOTION toggle, duplicated from the state machine's Clips panel. Both
// are gone: root motion is now one three-way choice in the CLIP EDITOR, beside the in-place bake it is
// the opposite of. Two independent toggles in two places could express states that mean nothing (drive
// the character from travel that has been baked out of the curves), and neither surface could show the
// other half of the decision. The ✎ on each row is the way there.

export default function AnimationAssetPicker(props: {
  /** The rig asset to link to, or null when the node has no rig yet. */
  rigId: string | null
  /** Called before linking when `rigId` is null — adopts the node into the library. See adoptModelAsset. */
  onNeedRig?: () => Promise<string | null>
  className?: string
}) {
  const { rigs, animations } = useAssetLibrary()
  const { linkAnimationToRig, unlinkAnimationFromRig, enterClipEditor } = useEditorSessions()
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
   * Root motion used to be a toggle on every one of these rows, and there was a second copy of it in the
   * state machine's Clips panel. It is now one three-way choice in the CLIP EDITOR, next to the in-place
   * bake it is the opposite of — a clip either leaves its travel alone, drives the character with it, or
   * has it removed from the curves, and two independent toggles could express combinations that mean
   * nothing. Open the `.anim` from the asset tree, or with the button on this row.
   */
  const openClip = (animationId: string) => (
    <button
      className='text-muted hover:text-white px-1 shrink-0'
      title='Open this animation in the clip editor — root motion, mirroring, trimming and retiming live there'
      onClick={() => enterClipEditor(animationId)}
    >✎</button>
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
              {anim && anim.clips.length !== 1 && (
                <span className='text-[10px] text-muted shrink-0'>{anim.clips.length} clips</span>
              )}
              {anim && openClip(id)}
              <button
                className='text-danger px-1 shrink-0'
                title='Unlink this animation — its clips are removed from every placement of this model'
                onClick={() => props.rigId && unlinkAnimationFromRig(props.rigId, id)}
              >✕</button>
            </div>
            {anim && anim.clips.length > 1 && anim.clips.map(clip => (
              <div key={clip.name} className={cn(row, 'pl-4 opacity-90')}>
                <span className='truncate flex-1' title={clip.name}>{clip.name}</span>
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

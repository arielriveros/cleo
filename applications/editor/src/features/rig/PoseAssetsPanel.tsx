import { useEffect, useState } from 'react'
import { useCleoEngine } from '../EngineContext'
import { useAssetLibrary } from '../AssetLibraryContext'
import { useRig } from './RigContext'
import { Button, Hint, SectionTitle, TextInput, cn } from '@cleo/app-kit/ui'
import { poseAssetFromRig } from '../../utils/poseAssets'
import type { RigPose } from '../../utils/rigAssets'
import { getAnimationTarget } from '../animation/skeleton'
import { poseBoneLocal } from './boneTrs'
import { pinKey, useCreatorPins } from '../creator/creatorPins'

// The rig's POSES: named static poses of this skeleton, held in Pose assets — listed, previewed on the
// character, renamed and deleted here. Every pose can be held by an animator state.
//
// Poses are authored in Cleo Creator ▸ Motion: each Creator pose syncs into /Creator/Poses as a pose asset
// on its skeleton's rig, and is read-only here (the next sync would undo an edit).
//
// Poses made before pose assets existed live on the rig itself. They keep working (a clip resolves a
// pose id against both), and "Move into a pose asset" turns them into one without touching any clip.

export default function PoseAssetsPanel() {
  const { editorScene, skeletonTargetId } = useCleoEngine()
  const { poseAssets, addPoseAsset, updatePoseAsset, removePoseAsset } = useAssetLibrary()
  const { asset, patch, focus } = useRig()
  const pins = useCreatorPins()
  // A pose double-clicked in Assets opens expanded — read from the session, since the request is made
  // before the rig editor (and this panel) is mounted.
  const [open, setOpen] = useState<string | null>(focus?.kind === 'pose' ? focus.id : null)
  /** The pose pinned on the preview character, so its row can show it and a second click can clear it. */
  const [previewing, setPreviewing] = useState<string | null>(null)

  useEffect(() => { if (focus?.kind === 'pose') setOpen(focus.id) }, [focus])

  if (!asset) return null
  const mine = poseAssets.filter(p => p.rigId === asset.id)
  const target = getAnimationTarget(editorScene, skeletonTargetId)

  // Bone name -> node index on the preview skeleton. A pose stores names, so this is how it finds bones.
  const nodeOfName = () => {
    const map = new Map<string, number>()
    for (const [nodeIndex, name] of target?.skin.nodeNames ?? []) map.set(name, nodeIndex)
    return map
  }

  /** Pin a pose on the preview character, through the animator's editor-only bone overrides. */
  const preview = (pose: RigPose) => {
    if (!target) return
    const animator = target.animator
    animator.clearBoneLocalOverrides()
    if (previewing === pose.id) { setPreviewing(null); return }
    // Paused, so the clip under the pose holds still: the pose is judged against one frame.
    animator.pause()
    const nodes = nodeOfName()
    for (const bone of pose.bones) {
      const node = nodes.get(bone.name)
      if (node === undefined) continue
      const rest = animator.boneRestTransform(node)
      if (rest) animator.setBoneLocalOverride(node, poseBoneLocal(rest, bone))
    }
    setPreviewing(pose.id)
  }

  const legacy = asset.poses ?? []

  const migrate = () => {
    const moved = poseAssetFromRig(asset)
    if (!moved) return
    addPoseAsset(moved)
    // Ids are kept, so every clip referencing one of these still resolves — against the asset now.
    patch({ ...asset, poses: [] })
    setOpen(moved.id)
  }

  return (
    <div>
      <SectionTitle title='Poses' className='mb-1' />

      {legacy.length > 0 && (
        <div className='mb-1 flex flex-col gap-1 rounded border border-warning/40 bg-warning/10 p-2'>
          <Hint>{legacy.length} pose{legacy.length === 1 ? '' : 's'} stored on the rig itself (older projects).</Hint>
          <Button variant='subtle' className='py-1' onClick={migrate}
            title='Clips that use them keep working: pose ids are preserved'>Move into a pose asset</Button>
        </div>
      )}

      {mine.length === 0 && legacy.length === 0 && <Hint>No poses on this skeleton. Make them in Cleo Creator ▸ Motion.</Hint>}

      <div className='flex flex-col gap-1'>
        {mine.map(pa => {
          const managed = pins.folders.has(pinKey('pose', pa.id))
          return (
            <div key={pa.id} className={cn('rounded border', pa.id === open ? 'border-highlight' : 'border-control')}>
              <div className='flex items-center gap-1 p-1'>
                <button className='text-ui-sm px-1 text-muted hover:text-fg' onClick={() => setOpen(pa.id === open ? null : pa.id)}>{pa.id === open ? '▾' : '▸'}</button>
                {managed
                  ? <span className='flex-1 truncate text-ui-sm text-fg' title='Synced from Cleo Creator — edit it there'>{pa.name}</span>
                  : <TextInput className='flex-1' value={pa.name} onChange={v => updatePoseAsset(pa.id, { ...pa, name: v })} />}
                <span className='text-ui-xs text-muted shrink-0'>{pa.poses.length}</span>
                {!managed && (
                  <Button variant='remove' size='sm' className='px-1 py-0 shrink-0'
                    title='Delete this pose asset. States holding its poses report the missing pose.'
                    onClick={() => removePoseAsset(pa.id)}>✕</Button>
                )}
              </div>
              {pa.id === open && (
                <div className='flex flex-col gap-1 p-1 pt-0'>
                  {pa.poses.length === 0 && <Hint>Empty.</Hint>}
                  {pa.poses.map(pose => (
                    <div key={pose.id} className='flex items-center gap-1'>
                      <Button variant='ghost' size='sm' active={previewing === pose.id}
                        className={cn('text-ui-sm px-1 py-0 shrink-0', previewing === pose.id ? 'text-highlight' : 'text-muted')}
                        disabled={!target}
                        title={previewing === pose.id ? 'Stop previewing this pose' : 'Show this pose on the preview character'}
                        onClick={() => preview(pose)}>◉</Button>
                      {managed
                        ? <span className='flex-1 truncate text-ui-sm text-fg'>{pose.name}</span>
                        : <TextInput className='flex-1' value={pose.name}
                            title='Rename. Clips and states reference poses by id, so a rename cannot break them.'
                            onChange={v => updatePoseAsset(pa.id, { ...pa, poses: pa.poses.map(p => (p.id === pose.id ? { ...p, name: v } : p)) })} />}
                      <span className='text-ui-xs text-muted shrink-0' title={pose.bones.map(b => b.name).join(', ')}>
                        {pose.bones.length} bone{pose.bones.length === 1 ? '' : 's'}
                      </span>
                      {!managed && (
                        <Button variant='remove' size='sm' className='px-1 py-0 shrink-0'
                          onClick={() => updatePoseAsset(pa.id, { ...pa, poses: pa.poses.filter(p => p.id !== pose.id) })}>✕</Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {previewing && (
        <Button variant='ghost' size='sm' className='w-full text-ui-sm mt-1'
          onClick={() => { target?.animator.clearBoneLocalOverrides(); setPreviewing(null) }}>Clear pose preview</Button>
      )}
    </div>
  )
}

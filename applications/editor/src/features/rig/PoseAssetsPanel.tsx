import { useEffect, useState } from 'react'
import { Logger } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import { useAssetLibrary } from '../AssetLibraryContext'
import { useRig } from './RigContext'
import { Button, Hint, SectionTitle, TextInput, cn } from '@cleo/app-kit/ui'
import { buildPoseAsset, newPose, poseAssetFromRig } from '../../utils/poseAssets'
import type { RigPose } from '../../utils/rigAssets'
import type { StoredPoseBone } from '../../utils/animationAssets'
import { getAnimationTarget } from '../animation/skeleton'
import { poseBoneLocal, poseDeltaOf } from '../clip/boneTrs'
import { promptDialog } from '@cleo/app-kit/feedback/dialogStore'

// The rig's POSES: named static poses of this skeleton, held in Pose assets.
//
// A pose is authored in the CLIP editor — that is where a character is posed bone by bone — and saved
// into a pose asset on this rig. Here they are managed: renamed, deleted, grouped. Every pose can be
// layered onto a clip (a `poseOffset` edit) or held by a controller state.
//
// Poses made before pose assets existed live on the rig itself. They keep working (a clip resolves a
// pose id against both), and "Move into a pose asset" turns them into one without touching any clip.

export default function PoseAssetsPanel() {
  const { eventEmitter, editorScene, skeletonTargetId } = useCleoEngine()
  const { poseAssets, addPoseAsset, updatePoseAsset, removePoseAsset } = useAssetLibrary()
  const { asset, patch } = useRig()
  const [open, setOpen] = useState<string | null>(null)
  /** The pose pinned on the preview character, so its row can show it and a second click can clear it. */
  const [previewing, setPreviewing] = useState<string | null>(null)

  useEffect(() => {
    const onFocus = (e: { kind: string; id: string }) => { if (e?.kind === 'pose') setOpen(e.id) }
    eventEmitter.on('FOCUS_RIG_ASSET', onFocus)
    return () => { eventEmitter.off('FOCUS_RIG_ASSET', onFocus) }
  }, [eventEmitter])

  if (!asset) return null
  const mine = poseAssets.filter(p => p.rigId === asset.id)
  const target = getAnimationTarget(editorScene, skeletonTargetId)

  // Bone name -> node index on the preview skeleton. A pose stores names, so this is how it finds bones.
  const nodeOfName = () => {
    const map = new Map<string, number>()
    for (const [nodeIndex, name] of target?.skin.nodeNames ?? []) map.set(name, nodeIndex)
    return map
  }

  /** Pin a pose on the preview character, through the same editor override the bone gizmo uses. */
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

  /**
   * Capture what the preview character is showing right now — a paused clip frame, or a previewed pose —
   * as a new pose. Every bone away from its rest is kept, by name.
   */
  const capture = async () => {
    if (!target) return
    const animator = target.animator
    animator.pause()
    const bones: StoredPoseBone[] = []
    for (const j of target.skin.joints) {
      const name = target.skin.nodeNames?.get(j.nodeIndex)
      const local = animator.boneLocalTransform(j.nodeIndex)
      const rest = animator.boneRestTransform(j.nodeIndex)
      if (!name || !local || !rest) continue
      const delta = poseDeltaOf(local, rest)
      if (delta) bones.push({ name, ...delta })
    }
    if (!bones.length) {
      Logger.info('Nothing to capture: every bone is at rest. Pause a clip on a frame (or pose bones) first.', 'Editor')
      return
    }
    const into = mine.find(p => p.id === open) ?? mine[0]
    const name = await promptDialog({
      title: 'Capture pose',
      message: `${bones.length} bone${bones.length === 1 ? '' : 's'} differ from rest in the preview. They will be saved into "${into?.name ?? `${asset.name} Poses`}".`,
      defaultValue: 'Pose',
      validate: v => (v.trim() ? null : 'Give the pose a name.'),
    })
    if (!name?.trim()) return
    const pose = newPose(name.trim(), bones)
    if (into) {
      updatePoseAsset(into.id, { ...into, poses: [...into.poses, pose] })
      setOpen(into.id)
    } else {
      const created = buildPoseAsset(`${asset.name} Poses`, asset.id, [pose])
      addPoseAsset(created)
      setOpen(created.id)
    }
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

      <div className='flex flex-col gap-1'>
        {mine.map(pa => (
          <div key={pa.id} className={cn('rounded border', pa.id === open ? 'border-highlight' : 'border-control')}>
            <div className='flex items-center gap-1 p-1'>
              <button className='text-ui-sm px-1 text-muted hover:text-fg' onClick={() => setOpen(pa.id === open ? null : pa.id)}>{pa.id === open ? '▾' : '▸'}</button>
              <TextInput className='flex-1' value={pa.name} onChange={v => updatePoseAsset(pa.id, { ...pa, name: v })} />
              <span className='text-ui-xs text-muted shrink-0'>{pa.poses.length}</span>
              <Button variant='remove' size='sm' className='px-1 py-0 shrink-0'
                title='Delete this pose asset. Clips and states using its poses report the missing pose.'
                onClick={() => removePoseAsset(pa.id)}>✕</Button>
            </div>
            {pa.id === open && (
              <div className='flex flex-col gap-1 p-1 pt-0'>
                {pa.poses.length === 0 && <Hint>Empty — save a pose into it from a clip’s editor.</Hint>}
                {pa.poses.map(pose => (
                  <div key={pose.id} className='flex items-center gap-1'>
                    <Button variant='ghost' size='sm' active={previewing === pose.id}
                      className={cn('text-ui-sm px-1 py-0 shrink-0', previewing === pose.id ? 'text-highlight' : 'text-muted')}
                      disabled={!target}
                      title={previewing === pose.id ? 'Stop previewing this pose' : 'Show this pose on the preview character'}
                      onClick={() => preview(pose)}>◉</Button>
                    <TextInput className='flex-1' value={pose.name}
                      title='Rename. Clips and states reference poses by id, so a rename cannot break them.'
                      onChange={v => updatePoseAsset(pa.id, { ...pa, poses: pa.poses.map(p => (p.id === pose.id ? { ...p, name: v } : p)) })} />
                    <span className='text-ui-xs text-muted shrink-0' title={pose.bones.map(b => b.name).join(', ')}>
                      {pose.bones.length} bone{pose.bones.length === 1 ? '' : 's'}
                    </span>
                    <Button variant='remove' size='sm' className='px-1 py-0 shrink-0'
                      onClick={() => updatePoseAsset(pa.id, { ...pa, poses: pa.poses.filter(p => p.id !== pose.id) })}>✕</Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className='flex gap-1 mt-1'>
        <Button variant='subtle' className='flex-1 py-1.5' disabled={!target} onClick={() => void capture()}
          title='Save what the preview character shows now — pause a clip on a frame first — as a new pose'
        >Capture pose</Button>
        <Button variant='subtle' className='flex-1 py-1.5'
          onClick={() => { const created = buildPoseAsset(`${asset.name} Poses`, asset.id); addPoseAsset(created); setOpen(created.id) }}
        >+ New pose asset</Button>
      </div>
      {previewing && (
        <Button variant='ghost' size='sm' className='w-full text-ui-sm mt-1'
          onClick={() => { target?.animator.clearBoneLocalOverrides(); setPreviewing(null) }}>Clear pose preview</Button>
      )}
    </div>
  )
}

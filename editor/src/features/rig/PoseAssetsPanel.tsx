import { useEffect, useState } from 'react'
import { useCleoEngine } from '../EngineContext'
import { useAssetLibrary } from '../AssetLibraryContext'
import { useRig } from './RigContext'
import { Button, Hint, TextInput, cn, sectionTitleClass } from '../../components/ui'
import { buildPoseAsset, poseAssetFromRig } from '../../utils/poseAssets'

// The rig's POSES: named static poses of this skeleton, held in Pose assets.
//
// A pose is authored in the CLIP editor — that is where a character is posed bone by bone — and saved
// into a pose asset on this rig. Here they are managed: renamed, deleted, grouped. Every pose can be
// layered onto a clip (a `poseOffset` edit) or held by a controller state.
//
// Poses made before pose assets existed live on the rig itself. They keep working (a clip resolves a
// pose id against both), and "Move into a pose asset" turns them into one without touching any clip.

export default function PoseAssetsPanel() {
  const { eventEmitter } = useCleoEngine()
  const { poseAssets, addPoseAsset, updatePoseAsset, removePoseAsset } = useAssetLibrary()
  const { asset, patch } = useRig()
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    const onFocus = (e: { kind: string; id: string }) => { if (e?.kind === 'pose') setOpen(e.id) }
    eventEmitter.on('FOCUS_RIG_ASSET', onFocus)
    return () => { eventEmitter.off('FOCUS_RIG_ASSET', onFocus) }
  }, [eventEmitter])

  if (!asset) return null
  const mine = poseAssets.filter(p => p.rigId === asset.id)
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
      <div className={cn(sectionTitleClass, 'mb-1')}>Poses</div>
      <Hint className='mb-1'>
        Pose bones in a clip’s editor and save them as a pose. A pose can ride on any clip, or be held by a controller state.
      </Hint>

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
              <button className='text-[11px] px-1 text-muted' onClick={() => setOpen(pa.id === open ? null : pa.id)}>{pa.id === open ? '▾' : '▸'}</button>
              <TextInput className='flex-1' value={pa.name} onChange={v => updatePoseAsset(pa.id, { ...pa, name: v })} />
              <span className='text-[10px] text-muted shrink-0'>{pa.poses.length}</span>
              <button className='text-danger px-1 shrink-0'
                title='Delete this pose asset. Clips and states using its poses report the missing pose.'
                onClick={() => removePoseAsset(pa.id)}>✕</button>
            </div>
            {pa.id === open && (
              <div className='flex flex-col gap-1 p-1 pt-0'>
                {pa.poses.length === 0 && <Hint>Empty — save a pose into it from a clip’s editor.</Hint>}
                {pa.poses.map(pose => (
                  <div key={pose.id} className='flex items-center gap-1'>
                    <TextInput className='flex-1' value={pose.name}
                      title='Rename. Clips and states reference poses by id, so a rename cannot break them.'
                      onChange={v => updatePoseAsset(pa.id, { ...pa, poses: pa.poses.map(p => (p.id === pose.id ? { ...p, name: v } : p)) })} />
                    <span className='text-[10px] text-muted shrink-0' title={pose.bones.map(b => b.name).join(', ')}>
                      {pose.bones.length} bone{pose.bones.length === 1 ? '' : 's'}
                    </span>
                    <button className='text-danger px-1 shrink-0'
                      onClick={() => updatePoseAsset(pa.id, { ...pa, poses: pa.poses.filter(p => p.id !== pose.id) })}>✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <Button variant='subtle' className='w-full py-1.5 mt-1'
        onClick={() => { const created = buildPoseAsset(`${asset.name} Poses`, asset.id); addPoseAsset(created); setOpen(created.id) }}
      >+ New pose asset</Button>
    </div>
  )
}

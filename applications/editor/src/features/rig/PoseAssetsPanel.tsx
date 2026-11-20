import { useEffect } from 'react'
import { useCleoEngine } from '../EngineContext'
import { useAssetLibrary } from '../AssetLibraryContext'
import { useRig } from './RigContext'
import { Button, Hint, SectionTitle } from '@cleo/app-kit/ui'
import { findPose, poseAssetFromRig } from '../../utils/poseAssets'
import PoseLibrary from './PoseLibrary'
import { poseEditStore } from './poseEditStore'
import { pinKey, useCreatorPins } from '../creator/creatorPins'

// The rig's POSES, in the Skeleton part: the pose mode (PoseLibrary) on the preview character, each pose shown by
// itself. The Animator part mounts the same list with the character's layers on (StateMachineEditor's Poses).
//
// Poses made before pose assets existed live on the rig itself. They keep working (a clip resolves a pose id
// against both), and "Move into a pose asset" turns them into one without touching any clip.

export default function PoseAssetsPanel() {
  const { skeletonTargetId } = useCleoEngine()
  const { poseAssets, addPoseAsset } = useAssetLibrary()
  const { asset, patch, focus } = useRig()
  const pins = useCreatorPins()

  // A pose double-clicked in Assets opens for editing (read from the session: the request is made before the
  // rig editor, and this panel, is mounted).
  const focused = focus?.kind === 'pose' ? focus.id : null
  useEffect(() => {
    if (!focused) return
    const asPose = findPose(poseAssets, focused)
    const asAsset = poseAssets.find(a => a.id === focused)
    const ref = asPose ? { assetId: asPose.asset.id, poseId: asPose.pose.id } : asAsset?.poses[0] ? { assetId: asAsset.id, poseId: asAsset.poses[0].id } : null
    if (ref) poseEditStore.edit(ref, pins.folders.has(pinKey('pose', ref.assetId)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus])

  if (!asset) return null
  const legacy = asset.poses ?? []

  const migrate = () => {
    const moved = poseAssetFromRig(asset)
    if (!moved) return
    addPoseAsset(moved)
    // Ids are kept, so every clip referencing one of these still resolves — against the asset now.
    patch({ ...asset, poses: [] })
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

      <PoseLibrary rigId={asset.id} rigName={asset.name} targetId={skeletonTargetId} layered={false} />
    </div>
  )
}

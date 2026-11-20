import { useCallback, useRef } from 'react'
import { reembedPoses } from '../../utils/animationControllers'
import { lookupPose, resolvePoseBones, type PoseAsset, type PoseRef } from '../../utils/poseAssets'
import { useAssetLibrary } from '../AssetLibraryContext'
import { useHistory } from '../HistoryContext'
import type { AnimationTarget } from '../animation/skeleton'
import { poseBoneLocal } from './boneTrs'
import type { PoseView } from './poseEditStore'

/**
 * Show a pose on the preview character, from `assets` (the library, or a draft of it while a bone is dragged):
 *
 *   layered   the character's machine with its poses re-resolved from `assets` and swapped in WITHOUT restarting
 *             it (`updateStateMachine`): every layer stays on, the hold under its aim, Steady and hand IK
 *   alone     `ref` pinned by itself through the animator's editor overrides (what the Skeleton part shows)
 */
export function showPose(target: AnimationTarget, assets: PoseAsset[], ref: PoseRef | null, view: PoseView): void {
  const animator = target.animator
  animator.clearBoneLocalOverrides()
  if (view === 'layered' || !ref) {
    const next = reembedPoses(animator.getStateMachine(), assets)
    if (next) animator.updateStateMachine(next)
    return
  }
  const pose = lookupPose(assets, ref)
  if (!pose) return
  const nodes = new Map<string, number>()
  for (const [nodeIndex, name] of target.skin.nodeNames ?? []) nodes.set(name, nodeIndex)
  // Paused, so the clip under the pose holds still: the pose is judged against one frame.
  animator.pause()
  for (const bone of resolvePoseBones(assets, pose).bones) {
    const node = nodes.get(bone.name)
    if (node === undefined) continue
    const rest = animator.boneRestTransform(node)
    if (rest) animator.setBoneLocalOverride(node, poseBoneLocal(rest, bone))
  }
}

/**
 * Write one Pose asset (a new one, or an edit) as one undo step. Hand-built, as the clip editor's are: the scene
 * recorder cannot see a library asset. The whole asset is snapshotted: it is small, and an undo then restores it
 * exactly, variants and all.
 */
export function usePoseAssetEdit() {
  const { poseAssets, addPoseAsset, updatePoseAsset, removePoseAsset } = useAssetLibrary()
  const { push } = useHistory()
  const assetsRef = useRef(poseAssets)
  assetsRef.current = poseAssets
  return useCallback((next: PoseAsset | { removed: string }, label: string) => {
    const id = 'removed' in next ? next.removed : next.id
    const before = assetsRef.current.find(a => a.id === id) ?? null
    const put = (a: PoseAsset | null, had: boolean) => {
      if (!a) removePoseAsset(id)
      else if (had) updatePoseAsset(a.id, a)
      else addPoseAsset(a)
    }
    const after = 'removed' in next ? null : next
    put(after, !!before)
    push({
      label,
      undo: () => put(before, !!after),
      redo: () => put(after, !!before),
    })
  }, [addPoseAsset, updatePoseAsset, removePoseAsset, push])
}

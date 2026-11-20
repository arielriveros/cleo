import { useEffect, useRef, useState } from 'react'
import { mat4, quat, vec3 } from 'gl-matrix'
import { Node, decomposeTRS, markEditorOwned } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import { useAssetLibrary } from '../AssetLibraryContext'
import { getAnimationTarget, computeBindMatrices, computeJointWorldMatrices } from '../animation/skeleton'
import TransformGizmo from '../gizmo/TransformGizmo'
import type { TransformPatch } from '@cleo/app-kit/gizmo/gizmoDrag'
import { lookupPose, type PoseAsset } from '../../utils/poseAssets'
import { parentFrameTurn, turnPoseBone, withPose } from '../../utils/poseEdit'
import { poseEditStore, usePoseEdit } from './poseEditStore'
import { showPose, usePoseAssetEdit } from './posePreview'

/**
 * Turning a bone of the POSE being edited (the pose mode: PoseLibrary), with the rotate gizmo.
 *
 * The proxy trick of the socket gizmo: an invisible, editor-owned node parked on the selected joint, dragged by
 * the gizmo, and read back. What is read back is a TURN, not a bone transform: the drag's world turn
 * (`proxy now x inverse(proxy at the start)`) in the bone's parent frame (`parentFrameTurn`), pre-multiplied onto
 * the pose's stored bone (`turnPoseBone`): exact wherever the pose drives the bone, and for a variant it lands
 * in what the variant changes from its base. The parent frame is the one the character is SHOWING (the joint's
 * world turn and its final local, `Animator.posedLocal`), so under the layers (Steady, an aim added on top) the
 * bone turns the way it is dragged.
 *
 * Mid-drag the edit is a draft, shown on the character (`showPose`: every layer on, or the pose alone); on
 * pointer-up it goes into the library as one undo step, and every animator and blend space holding the pose
 * follows. Named with a capital G so the raycaster cannot pick the proxy (see the socket gizmo).
 */
const POSE_GIZMO_PROXY_NAME = '__editor__poseGizmoProxy'

export default function PoseGizmo({ viewportRef }: { viewportRef: React.RefObject<HTMLDivElement> }) {
  const { editorScene, mainScene, skeletonTargetId, eventEmitter, withoutDirty } = useCleoEngine()
  const { poseAssets } = useAssetLibrary()
  const { editing, readOnly, view } = usePoseEdit()
  const write = usePoseAssetEdit()
  const [jointIndex, setJointIndex] = useState(-1)
  const [proxyId, setProxyId] = useState<string | null>(null)
  const proxyRef = useRef<Node | null>(null)
  const assetsRef = useRef(poseAssets)
  assetsRef.current = poseAssets
  /** The drag in flight: where it started, and the draft it has made so far. */
  const dragRef = useRef<{ start: quat; parent: quat; asset: PoseAsset; bone: string; draft: PoseAsset | null } | null>(null)
  const cacheRef = useRef<{ skin: unknown; bind: any[] } | null>(null)

  useEffect(() => {
    const onJoint = (i: number) => setJointIndex(typeof i === 'number' ? i : -1)
    eventEmitter.on('SELECT_JOINT', onJoint)
    return () => { eventEmitter.off('SELECT_JOINT', onJoint) }
  }, [eventEmitter])

  // One proxy per preview scene, under withoutDirty (see the socket gizmo); never in the game scene.
  useEffect(() => {
    if (!editorScene || editorScene === mainScene) return
    const proxy = markEditorOwned(new Node(POSE_GIZMO_PROXY_NAME))
    withoutDirty(() => editorScene.addNode(proxy))
    proxyRef.current = proxy
    setProxyId(proxy.id)
    return () => {
      proxyRef.current = null
      setProxyId(null)
      try { withoutDirty(() => editorScene.removeNode(proxy)) } catch { /* the scene went with the tab */ }
    }
  }, [editorScene, mainScene])

  const worldsOf = () => {
    const target = getAnimationTarget(editorScene, skeletonTargetId)
    if (!target) return null
    if (cacheRef.current?.skin !== target.skin) cacheRef.current = { skin: target.skin, bind: computeBindMatrices(target.skin) }
    return { target, worlds: computeJointWorldMatrices(target.node, target.animator, target.skin, cacheRef.current.bind) }
  }
  const turnOf = (m: mat4) => { const q = quat.create(); decomposeTRS(m, vec3.create(), q, vec3.create()); return q }

  // Park the proxy on the selected joint, except mid-drag, when the gizmo owns it.
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const proxy = proxyRef.current
      const at = worldsOf()
      if (proxy && at && jointIndex >= 0 && jointIndex < at.target.skin.joints.length && !dragRef.current) {
        const w = at.worlds[jointIndex]
        proxy.setPosition(mat4.getTranslation(vec3.create(), w) as any)
        proxy.setQuaternion(turnOf(w) as any)
        proxy.setScale([1, 1, 1] as any)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorScene, skeletonTargetId, jointIndex])

  // The drag ends on pointer-up wherever it happens: the draft becomes one undo step in the library.
  useEffect(() => {
    const up = () => {
      const drag = dragRef.current
      dragRef.current = null
      if (drag?.draft) write(drag.draft, `Turn ${drag.bone.replace(/^.*:/, '')}`)
    }
    window.addEventListener('pointerup', up)
    return () => window.removeEventListener('pointerup', up)
  }, [write])

  const onTransformChange = (_nodeId: string, patch: TransformPatch) => {
    const proxy = proxyRef.current
    const at = worldsOf()
    const ref = poseEditStore.get().readOnly ? null : poseEditStore.get().editing
    if (!proxy || !at || !ref || jointIndex < 0 || patch.kind !== 'rotation') return
    const nodeIndex = at.target.skin.joints[jointIndex].nodeIndex
    const bone = at.target.skin.nodeNames?.get(nodeIndex)
    const asset = assetsRef.current.find(a => a.id === ref.assetId)
    if (!bone || !asset || !lookupPose(assetsRef.current, ref)) return
    if (!dragRef.current) {
      // The parent frame as the character shows it: the joint's world turn without its final local's.
      const world = turnOf(at.worlds[jointIndex])
      const local = at.target.animator.posedLocal(nodeIndex)
      const parent = local ? quat.multiply(quat.create(), world, quat.invert(quat.create(), turnOf(local))) : world
      dragRef.current = { start: world, parent, asset, bone, draft: null }
    }
    const drag = dragRef.current
    proxy.setQuaternion(patch.localQuat as any)
    proxy.updateTransforms?.()
    const now = quat.normalize(quat.create(), proxy.quaternion as any)
    const worldTurn = quat.multiply(quat.create(), now, quat.invert(quat.create(), drag.start))
    const turn = parentFrameTurn(worldTurn, drag.parent)
    drag.draft = withPose(drag.asset, ref.poseId, p => ({ ...p, bones: turnPoseBone(p.bones, bone, turn) }))
    const draftLib = assetsRef.current.map(a => (a.id === drag.asset.id ? drag.draft! : a))
    showPose(at.target, draftLib, ref, view)
  }

  if (!proxyId || jointIndex < 0 || !editing || readOnly) return null
  return <TransformGizmo selectedNodeId={proxyId} onTransformChange={onTransformChange} viewportRef={viewportRef} mode='rotation' />
}

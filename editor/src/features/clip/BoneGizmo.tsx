import { useEffect, useRef, useState } from 'react'
import { mat4, quat, vec3 } from 'gl-matrix'
import { Node, skeletonTopology, type SkeletonTopology } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import { getAnimationTarget, computeBindMatrices, computeJointWorldMatrices } from '../animation/skeleton'
import TransformGizmo from '../gizmo/TransformGizmo'
import type { TransformPatch } from '../gizmo/gizmoDrag'

/**
 * Posing a bone with the transform gizmo.
 *
 * The gizmo works on a scene NODE — it reads a world transform off one and hands back a local patch — and
 * a bone is not one. Rather than fork it (exact ray solving, local/world spaces, the drag readout, pointer
 * capture: none of it is bone-specific), this parks an invisible PROXY node on the selected joint, lets
 * the gizmo drag that, and converts the result back into the bone's local transform.
 *
 * The proxy lives in the tab's throwaway preview scene, so it is never serialized and never reaches a
 * library asset. It is parented to the scene root, which is identity, so its local transform IS its world
 * transform — that is what lets the gizmo's patch be read as a world pose directly.
 *
 * The conversion back is the only real maths here, and it is the accumulation `_recomputePose` performs,
 * run backwards:
 *
 *     jointWorld[j] = jointWorld[parent] x (non-joint chain) x local[j]
 *
 * so `local[j] = inverse(jointWorld[parent] x chain) x desiredWorld`. The chain is the `$AssimpFbx$` pivot
 * nodes an FBX import leaves between two bones; skipping them lands the pose in the wrong frame on exactly
 * the rigs that are hardest to debug. A root joint has no parent joint, so its base is the MODEL NODE's
 * world transform, which `computeJointWorldMatrices` has already multiplied in.
 */
export default function BoneGizmo({ viewportRef }: { viewportRef: React.RefObject<HTMLDivElement> }) {
  const { editorScene, skeletonTargetId, eventEmitter } = useCleoEngine()
  const [jointIndex, setJointIndex] = useState(-1)
  const proxyRef = useRef<Node | null>(null)
  const [proxyId, setProxyId] = useState<string | null>(null)
  /** Set between the gizmo's first patch and the pointer coming up, so the sync loop stands down. */
  const draggingRef = useRef(false)
  /**
   * Topology and inverted bind matrices, cached on the SKIN.
   *
   * Both are derived and both are needed every frame by the sync loop below. `computeBindMatrices` inverts
   * one matrix per joint, so recomputing it per frame is a hundred matrix inversions a frame for one
   * invisible proxy — and the skin does not change while a tab is open.
   */
  const cacheRef = useRef<{ skin: unknown; topo: SkeletonTopology; bind: any[] } | null>(null)

  useEffect(() => {
    const onJoint = (i: number) => setJointIndex(typeof i === 'number' ? i : -1)
    eventEmitter.on('SELECT_JOINT', onJoint)
    return () => { eventEmitter.off('SELECT_JOINT', onJoint) }
  }, [eventEmitter])

  // One proxy per scene, created on demand and torn down with the tab.
  useEffect(() => {
    if (!editorScene) return
    const proxy = new Node('__boneGizmoProxy')
    editorScene.addNode(proxy)
    proxyRef.current = proxy
    setProxyId(proxy.id)
    return () => {
      proxyRef.current = null
      setProxyId(null)
      try { proxy.remove() } catch { /* the scene may already be gone with the tab */ }
    }
  }, [editorScene])

  const cacheOf = (skin: any) => {
    const hit = cacheRef.current
    if (hit && hit.skin === skin) return hit
    const next = { skin, topo: skeletonTopology(skin), bind: computeBindMatrices(skin) }
    cacheRef.current = next
    return next
  }

  /** World transform of everything ABOVE joint `j` — its parent joint, plus any non-joint pivots between. */
  const parentWorldOf = (jointIndex: number): mat4 => {
    const target = getAnimationTarget(editorScene, skeletonTargetId)!
    const { topo, bind } = cacheOf(target.skin)
    const worlds = computeJointWorldMatrices(target.node, target.animator, target.skin, bind)
    const parent = topo.parentJoint[jointIndex]
    const out = parent >= 0
      ? mat4.clone(worlds[parent])
      : mat4.clone(target.node.worldTransform as any)
    for (const nodeIndex of topo.parentChain[jointIndex]) {
      // Read the LIVE local, not the rest: a pivot can be animated, and on an assimp FBX it usually is.
      const local = target.animator.boneLocalTransform(nodeIndex)
      if (local) mat4.multiply(out, out, local)
    }
    return out
  }

  // Park the proxy on the selected joint. Skipped mid-drag — the gizmo owns the proxy then, and writing
  // over it every frame would fight the pointer.
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const proxy = proxyRef.current
      const target = getAnimationTarget(editorScene, skeletonTargetId)
      if (proxy && target && jointIndex >= 0 && jointIndex < target.skin.joints.length && !draggingRef.current) {
        const worlds = computeJointWorldMatrices(target.node, target.animator, target.skin, cacheOf(target.skin).bind)
        const w = worlds[jointIndex]
        proxy.setPosition(mat4.getTranslation(vec3.create(), w) as any)
        proxy.setQuaternion(quat.normalize(quat.create(), mat4.getRotation(quat.create(), w)) as any)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [editorScene, skeletonTargetId, jointIndex])

  // A drag ends on pointerup wherever it happens, including outside the viewport.
  useEffect(() => {
    const up = () => { draggingRef.current = false }
    window.addEventListener('pointerup', up)
    return () => window.removeEventListener('pointerup', up)
  }, [])

  /** The gizmo moved the proxy: read its world pose back onto the bone. */
  const onTransformChange = (_nodeId: string, patch: TransformPatch) => {
    const proxy = proxyRef.current
    const target = getAnimationTarget(editorScene, skeletonTargetId)
    if (!proxy || !target || jointIndex < 0) return
    draggingRef.current = true

    if (patch.kind === 'position') proxy.setPosition(patch.local as any)
    else if (patch.kind === 'scale') proxy.setScale(patch.local as any)
    else proxy.setQuaternion(patch.localQuat as any)
    proxy.updateTransforms?.()

    const nodeIndex = target.skin.joints[jointIndex].nodeIndex
    // Scale is taken from the bone's CURRENT local, not the proxy: the proxy carries whatever scale the
    // joint's world matrix had, and round-tripping that through a move or rotate drag would slowly drift
    // the bone's size. Only an explicit scale drag should change it.
    const current = target.animator.boneLocalTransform(nodeIndex) ?? mat4.create()
    const scale = patch.kind === 'scale'
      ? (patch.local as vec3)
      : mat4.getScaling(vec3.create(), current)

    const desired = mat4.fromRotationTranslationScale(
      mat4.create(),
      quat.normalize(quat.create(), proxy.quaternion as any),
      proxy.position as any,
      scale)

    const parentWorld = parentWorldOf(jointIndex)
    const inv = mat4.invert(mat4.create(), parentWorld)
    if (!inv) return   // a degenerate parent (zero scale somewhere up the chain) — leave the bone alone
    const local = mat4.multiply(mat4.create(), inv, desired)
    target.animator.setBoneLocalOverride(nodeIndex, local)
  }

  if (!proxyId || jointIndex < 0) return null
  return <TransformGizmo selectedNodeId={proxyId} onTransformChange={onTransformChange} viewportRef={viewportRef} />
}

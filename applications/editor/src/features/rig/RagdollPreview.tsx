import { useEffect, useRef, useState } from 'react'
import { mat4 } from 'gl-matrix'
import {
  autoHumanoidProfile, markEditorOwned, parseRagdollProfile, ragdollLayout, ragdollPartPose,
  type ModelNode, type RagdollProfile, type Skin,
} from 'cleo'
import { useCleoEngine } from '../EngineContext'
import { useRig } from './RigContext'
import { getAnimationTarget } from '../animation/skeleton'
import { wireModel } from '../../utils/editorHelpers'
import { jointLines, partLines } from '../../utils/ragdollWire'

// The rig editor's ragdoll overlay: every part's collider and every joint's limit, drawn on the preview
// character in its CURRENT pose -- so scrubbing a clip shows where each body would spawn -- plus the Test
// Drop that hands the preview character to physics over a temporary floor.
//
// Wireframes are editor-owned nodes of the throwaway preview scene, never saved.

/** Highlight one part (its index in the profile), or null. Emitted by the Ragdoll panel. */
export const RAGDOLL_SELECT_PART = 'RAGDOLL_SELECT_PART'
/** 'drop' | 'reset' — run or end the test fall. */
export const RAGDOLL_TEST = 'RAGDOLL_TEST'
/** Emitted with `true` while a test fall is running. */
export const RAGDOLL_TEST_STATE = 'RAGDOLL_TEST_STATE'
/** Show / hide the colliders (boolean). */
export const RAGDOLL_SHOW = 'RAGDOLL_SHOW'

/** The profile a rig falls with: its authored one, else the automatic humanoid one (null: generic). */
export function rigRagdollProfile(authored: unknown, skin: Skin | null | undefined): { profile: RagdollProfile | null; authored: boolean } {
  const parsed = parseRagdollProfile(authored)
  if (parsed && parsed.parts.length) return { profile: parsed, authored: true }
  return { profile: skin ? autoHumanoidProfile(skin) : null, authored: false }
}

const COLLIDER: [number, number, number] = [0.35, 0.85, 1]
const SELECTED: [number, number, number] = [1, 0.6, 0.2]
const LIMIT: [number, number, number] = [1, 0.85, 0.3]

export default function RagdollPreview() {
  const { editorScene, skeletonTargetId, eventEmitter, withoutDirty, instance } = useCleoEngine()
  const { asset } = useRig()
  const [selected, setSelected] = useState<number | null>(null)
  const [show, setShow] = useState(true)
  const testRef = useRef<{ node: ModelNode; ground: unknown; animations: boolean | null } | null>(null)

  const target = getAnimationTarget(editorScene, skeletonTargetId)
  const key = JSON.stringify(asset?.ragdoll ?? null)

  useEffect(() => {
    const onSelect = (i: number | null) => setSelected(typeof i === 'number' ? i : null)
    const onShow = (v: boolean) => setShow(!!v)
    eventEmitter.on(RAGDOLL_SELECT_PART, onSelect)
    eventEmitter.on(RAGDOLL_SHOW, onShow)
    return () => { eventEmitter.off(RAGDOLL_SELECT_PART, onSelect); eventEmitter.off(RAGDOLL_SHOW, onShow) }
  }, [eventEmitter])

  // ----- the test fall ----------------------------------------------------------------------------
  const endTest = () => {
    const test = testRef.current
    testRef.current = null
    if (!test) return
    const physics = instance?.physics
    try {
      physics?.stopRagdoll(test.node)
      if (test.ground) physics?.removeBody(test.ground as never)
    } catch { /* the preview scene may already be gone */ }
    if (test.animations !== null && test.node.scene) test.node.scene.animationsEnabled = test.animations
    test.node.animator?.showBindPose()
    eventEmitter.emit(RAGDOLL_TEST_STATE, false)
  }

  useEffect(() => {
    const onTest = (what: 'drop' | 'reset') => {
      endTest()
      if (what !== 'drop' || !target || !instance) return
      const { profile } = rigRagdollProfile(asset?.ragdoll, target.skin)
      const physics = instance.physics
      // The floor under the preview character's feet: its lowest joint in the current pose.
      const fbm = target.animator.getFinalBoneMatrices()
      let floor = Infinity
      const world = target.node.worldTransform
      const bind = mat4.create(), m = mat4.create()
      target.skin.joints.forEach((j, i) => {
        // Joint world position = nodeWorld * finalBoneMatrix * inverse(inverseBind), translation.
        if (!mat4.invert(bind, j.inverseBindMatrix as mat4)) return
        mat4.multiply(m, world, fbm[i])
        mat4.multiply(m, m, bind)
        if (Number.isFinite(m[13])) floor = Math.min(floor, m[13])
      })
      const ground = physics.addGroundPlane(Number.isFinite(floor) ? floor - 0.05 : 0)
      physics.startRagdoll(target.node, { profile: profile ?? null })
      // A preview scene does not run animators on its own (the transport poses them), and the ragdoll
      // reaches the skin through the animator's update -- so let it run for the fall.
      const scene = target.node.scene
      const animations = scene ? scene.animationsEnabled : null
      if (scene) scene.animationsEnabled = true
      testRef.current = { node: target.node, ground, animations }
      eventEmitter.emit(RAGDOLL_TEST_STATE, true)
    }
    eventEmitter.on(RAGDOLL_TEST, onTest)
    return () => { eventEmitter.off(RAGDOLL_TEST, onTest) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventEmitter, target?.node, key, instance])

  // Leaving the rig tab (or swapping the preview model) ends a running test.
  useEffect(() => () => endTest(), [target?.node]) // eslint-disable-line react-hooks/exhaustive-deps

  // ----- the wireframes ---------------------------------------------------------------------------
  useEffect(() => {
    if (!target || !show) return
    const scene = target.node.scene
    if (!scene) return
    const { profile } = rigRagdollProfile(asset?.ragdoll, target.skin)
    if (!profile) return
    const layout = ragdollLayout(target.skin, profile)

    type Placed = { node: ModelNode; part: number }
    const placed: Placed[] = []
    withoutDirty(() => {
      layout.parts.forEach((lp, i) => {
        const collider = wireModel(`__editor__ragdoll_part_${i}`, partLines(lp), i === selected ? SELECTED : COLLIDER)
        markEditorOwned(collider)
        scene.addNode(collider)
        placed.push({ node: collider, part: i })
        // The limits of the joints this part is the PARENT of: they are fixed in this part's frame.
        const children = layout.parts.filter(c => c.parent === i)
        if (!children.length) return
        const merged = { positions: [] as [number, number, number][], indices: [] as number[] }
        for (const c of children) {
          const l = jointLines(c, lp, Math.max(c.length * 0.45, c.radius * 3))
          const base = merged.positions.length
          merged.positions.push(...l.positions)
          merged.indices.push(...l.indices.map(x => x + base))
        }
        const limits = wireModel(`__editor__ragdoll_limits_${i}`, merged, LIMIT)
        markEditorOwned(limits)
        scene.addNode(limits)
        placed.push({ node: limits, part: i })
      })
    })

    let raf = 0
    const place = () => {
      const fbm = target.animator.getFinalBoneMatrices()
      const world = target.node.worldTransform
      for (const p of placed) {
        const lp = layout.parts[p.part]
        const pose = ragdollPartPose(target.skin, lp, world, fbm[lp.joint])
        p.node.setPosition([pose.center[0], pose.center[1], pose.center[2]])
        p.node.setQuaternion([pose.rotation[0], pose.rotation[1], pose.rotation[2], pose.rotation[3]])
        p.node.setUniformScale(pose.scale)
      }
      raf = requestAnimationFrame(place)
    }
    place()
    return () => {
      cancelAnimationFrame(raf)
      withoutDirty(() => { for (const p of placed) { try { scene.removeNode(p.node) } catch { /* scene gone */ } } })
    }
  // `key` stands for the working copy's profile.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.node, key, selected, show])

  return null
}

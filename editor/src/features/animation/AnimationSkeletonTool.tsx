import { useEffect, useRef } from 'react'
import { useCleoEngine } from '../EngineContext'
import { Raycaster, Vec, skeletonTopology } from 'cleo'
import { getAnimationTarget, bonePairsOf, computeBindMatrices, computeJointWorldMatrices, worldPositionOf } from './skeleton'

// Viewport overlay for the Animation Editor: per-instance world matrices packed into flat Float32Arrays
// each frame and submitted to renderer.setSkeletonOverlay, drawn always-on-top. Joint picking is a CPU
// ray-sphere test that emits SELECT_JOINT.

const JOINT_COLOR: [number, number, number] = [0.25, 0.6, 1.0]
const SELECTED_COLOR: [number, number, number] = [1.0, 0.85, 0.1]
const IK_MARKER_COLOR: [number, number, number] = [0.2, 0.95, 0.45]
const BONE_COLOR: [number, number, number] = [0.85, 0.85, 0.9]
const JOINT_SCREEN_SIZE = 0.02 // sphere radius as a fraction of the distance metric (constant on screen)

interface Props { viewportRef: React.RefObject<HTMLDivElement> }

export default function AnimationSkeletonTool({ viewportRef }: Props) {
  const { instance, editorScene, animationTargetId, eventEmitter } = useCleoEngine()

  const jointMatricesRef = useRef<Float32Array>(new Float32Array(0))
  const boneMatricesRef = useRef<Float32Array>(new Float32Array(0))
  const highlightMatRef = useRef<Float32Array>(new Float32Array(16))
  const bonePairsRef = useRef<[number, number][]>([]) // [childJoint, parentJoint] per bone slot
  const jointPosRef = useRef<Float32Array>(new Float32Array(0)) // 3 per joint (for picking)
  const jointRadiusRef = useRef<Float32Array>(new Float32Array(0))
  const bindMatsRef = useRef<any[]>([])
  const selectedRef = useRef<number | null>(null)
  // Joints the IK rig has given a role to. Rebuilt on ANIM_IK_CHANGED, never polled per frame.
  const markerMatRef = useRef<Float32Array>(new Float32Array(0))
  const ikJointsRef = useRef<number[]>([])

  const computeScale = (worldPos: ArrayLike<number>): number => {
    const cam = instance?.scene?.activeCamera?.camera
    if (!cam) return 0.05
    if (cam.type === 'orthographic') return Math.max((cam.top - cam.bottom) * JOINT_SCREEN_SIZE, 1e-3)
    const camPos = cam.position
    const dx = camPos[0] - worldPos[0], dy = camPos[1] - worldPos[1], dz = camPos[2] - worldPos[2]
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
    const halfFov = (cam.fov * Math.PI / 180) / 2
    return Math.max(dist * Math.tan(halfFov) * JOINT_SCREEN_SIZE, 1e-3)
  }

  // Allocate the flat instance buffers when the target skeleton changes.
  useEffect(() => {
    const target = getAnimationTarget(editorScene, animationTargetId)
    if (!instance || !editorScene || !target) return
    const { skin } = target
    const n = skin.joints.length

    const bonePairs = bonePairsOf(skin)

    bonePairsRef.current = bonePairs
    bindMatsRef.current = computeBindMatrices(skin)
    jointMatricesRef.current = new Float32Array(n * 16)
    boneMatricesRef.current = new Float32Array(bonePairs.length * 16)
    jointPosRef.current = new Float32Array(n * 3)
    jointRadiusRef.current = new Float32Array(n)
    selectedRef.current = null

    return () => { instance.renderer.setSkeletonOverlay(null) }
  }, [instance, editorScene, animationTargetId])

  // Per-frame: repack instance matrices from the live posed skeleton and submit the overlay.
  useEffect(() => {
    if (!instance || !editorScene) return
    let raf = 0
    const IDENT_Q = Vec.quat.create()
    const q = Vec.quat.create()
    const up: [number, number, number] = [0, 1, 0]
    const mid: [number, number, number] = [0, 0, 0]
    const scl: [number, number, number] = [0, 0, 0]
    const posv: [number, number, number] = [0, 0, 0]

    const tick = () => {
      const target = getAnimationTarget(editorScene, animationTargetId)
      const jointMats = jointMatricesRef.current
      if (target && jointMats.length) {
        const n = target.skin.joints.length
        const jm = jointMats, bm = boneMatricesRef.current
        const jpos = jointPosRef.current, jrad = jointRadiusRef.current
        const mats = computeJointWorldMatrices(target.node, target.animator, target.skin, bindMatsRef.current)

        for (let i = 0; i < n; i++) {
          const pos = worldPositionOf(mats[i])
          const s = computeScale(pos)
          jpos[i * 3] = pos[0]; jpos[i * 3 + 1] = pos[1]; jpos[i * 3 + 2] = pos[2]
          jrad[i] = s
          posv[0] = pos[0]; posv[1] = pos[1]; posv[2] = pos[2]
          scl[0] = s; scl[1] = s; scl[2] = s
          Vec.mat4.fromRotationTranslationScale(jm.subarray(i * 16, i * 16 + 16) as any, IDENT_Q as any, posv as any, scl as any)
        }

        const pairs = bonePairsRef.current
        for (let b = 0; b < pairs.length; b++) {
          const [ci, pi] = pairs[b]
          const cx = jpos[ci * 3], cy = jpos[ci * 3 + 1], cz = jpos[ci * 3 + 2]
          const px = jpos[pi * 3], py = jpos[pi * 3 + 1], pz = jpos[pi * 3 + 2]
          const dx = px - cx, dy = py - cy, dz = pz - cz
          const len = Math.hypot(dx, dy, dz)
          const out = bm.subarray(b * 16, b * 16 + 16) as any
          if (len > 1e-5) {
            const s = jrad[ci]
            Vec.quat.rotationTo(q, up as any, [dx / len, dy / len, dz / len] as any)
            mid[0] = (cx + px) / 2; mid[1] = (cy + py) / 2; mid[2] = (cz + pz) / 2
            scl[0] = s * 0.35; scl[1] = len; scl[2] = s * 0.35
            Vec.mat4.fromRotationTranslationScale(out, q as any, mid as any, scl as any)
          } else {
            Vec.mat4.identity(out)
            // collapse to a zero-scale so a degenerate bone is invisible
            out[0] = out[5] = out[10] = 0
          }
        }

        // Mark the joints the IK rig uses so its chain is visible on the skeleton.
        const ikJoints = ikJointsRef.current
        if (markerMatRef.current.length < ikJoints.length * 16) markerMatRef.current = new Float32Array(ikJoints.length * 16)
        const mm = markerMatRef.current
        let markerCount = 0
        for (const j of ikJoints) {
          if (j < 0 || j >= n) continue   // a rig can outlive the bone it names
          const s = jrad[j] * 1.35
          posv[0] = jpos[j * 3]; posv[1] = jpos[j * 3 + 1]; posv[2] = jpos[j * 3 + 2]
          scl[0] = s; scl[1] = s; scl[2] = s
          Vec.mat4.fromRotationTranslationScale(mm.subarray(markerCount * 16, markerCount * 16 + 16) as any, IDENT_Q as any, posv as any, scl as any)
          markerCount++
        }

        // Highlight the selected joint (scaled up a bit).
        const sel = selectedRef.current
        let highlight: Float32Array | null = null
        if (sel !== null && sel < n) {
          const s = jrad[sel] * 1.5
          posv[0] = jpos[sel * 3]; posv[1] = jpos[sel * 3 + 1]; posv[2] = jpos[sel * 3 + 2]
          scl[0] = s; scl[1] = s; scl[2] = s
          Vec.mat4.fromRotationTranslationScale(highlightMatRef.current as any, IDENT_Q as any, posv as any, scl as any)
          highlight = highlightMatRef.current
        }

        instance.renderer.setSkeletonOverlay({
          jointMatrices: jm, jointCount: n, jointColor: JOINT_COLOR,
          boneMatrices: bm, boneCount: pairs.length, boneColor: BONE_COLOR,
          markerMatrices: markerCount > 0 ? mm : null, markerCount, markerColor: IK_MARKER_COLOR,
          highlightMatrix: highlight, highlightColor: SELECTED_COLOR,
        })
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [instance, editorScene, animationTargetId])

  // Sync highlight with joint selections (from the tree or a previous viewport click).
  useEffect(() => {
    const onSelectJoint = (index: number | null) => { selectedRef.current = index }
    eventEmitter.on('SELECT_JOINT', onSelectJoint)
    return () => { eventEmitter.off('SELECT_JOINT', onSelectJoint) }
  }, [eventEmitter])

  // Which joints the IK rig names. Recomputed on rig or target change only, never per frame.
  useEffect(() => {
    const refresh = () => {
      const target = getAnimationTarget(editorScene, animationTargetId)
      const rig = target?.skin?.ikRig
      if (!target || !rig) { ikJointsRef.current = []; return }
      // Must be the shared topology's map, not a local copy: a copy drifts from the hierarchy the
      // Animator actually poses.
      const jointOfNode = skeletonTopology(target.skin).jointOfNode
      const out: number[] = []
      const push = (node: number | undefined) => {
        if (node === undefined || node < 0) return
        const j = jointOfNode.get(node)
        if (j !== undefined) out.push(j)
      }
      push(rig.hips)
      for (const leg of rig.feet ?? []) { push(leg.thigh); push(leg.shin); push(leg.foot); push(leg.toe) }
      ikJointsRef.current = out
    }
    refresh()
    eventEmitter.on('ANIM_IK_CHANGED', refresh)
    return () => { eventEmitter.off('ANIM_IK_CHANGED', refresh) }
  }, [eventEmitter, editorScene, animationTargetId])

  // Click a joint: CPU ray-sphere test against the joint world positions; nearest along the ray wins.
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0 || !instance?.scene) return
      if ((event.target as HTMLElement)?.closest?.('[data-cleo-overlay]')) return
      const jpos = jointPosRef.current, jrad = jointRadiusRef.current
      const n = jrad.length
      if (!n) return
      const activeCamera = instance.scene.activeCamera
      if (!activeCamera) return
      const rect = viewport.getBoundingClientRect()
      const x = event.clientX - rect.left, y = event.clientY - rect.top
      const ray = Raycaster.screenToRay(x, y, rect.width, rect.height, activeCamera.camera)
      const ro = ray.origin
      const rd = Vec.vec3.normalize(Vec.vec3.create(), ray.direction as any)

      let best = Infinity, bestJoint = -1
      for (let i = 0; i < n; i++) {
        const cx = jpos[i * 3], cy = jpos[i * 3 + 1], cz = jpos[i * 3 + 2]
        const ox = cx - ro[0], oy = cy - ro[1], oz = cz - ro[2]
        const t = ox * rd[0] + oy * rd[1] + oz * rd[2]
        if (t < 0 || t >= best) continue
        const dx = cx - (ro[0] + rd[0] * t), dy = cy - (ro[1] + rd[1] * t), dz = cz - (ro[2] + rd[2] * t)
        const r = jrad[i]
        if (dx * dx + dy * dy + dz * dz <= r * r) { best = t; bestJoint = i }
      }

      if (bestJoint >= 0) {
        event.preventDefault()
        event.stopPropagation()
        selectedRef.current = bestJoint
        eventEmitter.emit('SELECT_JOINT', bestJoint)
      }
    }

    viewport.addEventListener('mousedown', onMouseDown)
    return () => { viewport.removeEventListener('mousedown', onMouseDown) }
  }, [instance, viewportRef, eventEmitter])

  return null
}

import { useEffect } from 'react'
import { useCleoEngine } from './EngineContext'
import { usePlayback } from './PlaybackContext'
import { useDebugVisibility } from './DebugVisibilityContext'
import { ModelNode, AnimatedModel, Vec } from 'cleo'
import type { Skin } from 'cleo'
import { bonePairsOf, computeBindMatrices, computeJointWorldMatrices, worldPositionOf } from './animation/skeleton'

// Skeleton/bone overlay for the MAIN viewport, distinct from the Animation Editor's AnimationSkeletonTool,
// which owns the overlay while that mode is up — this one must not run in animation mode or the two fight.
// Packs every skinned model in the live scene into renderer.setSkeletonOverlay's single instanced buffer.

const JOINT_COLOR: [number, number, number] = [0.25, 0.6, 1.0]
const BONE_COLOR: [number, number, number] = [0.85, 0.85, 0.9]
const JOINT_SCREEN_SIZE = 0.02

const bindCache = new WeakMap<Skin, any[]>()

export default function DebugSkeletonOverlay() {
  const { instance, editorMode } = useCleoEngine()
  const { isPlayMode } = usePlayback()
  const { visibility } = useDebugVisibility()

  const active = editorMode !== 'animation' &&
    (isPlayMode ? visibility.skeleton.runtime : visibility.skeleton.editor)

  useEffect(() => {
    if (!instance || !active) {
      instance?.renderer.setSkeletonOverlay(null)
      return
    }
    let raf = 0
    const IDENT_Q = Vec.quat.create()
    const q = Vec.quat.create()
    const up: [number, number, number] = [0, 1, 0]

    const scaleAt = (pos: ArrayLike<number>): number => {
      const cam = instance.scene?.activeCamera?.camera
      if (!cam) return 0.05
      if (cam.type === 'orthographic') return Math.max((cam.top - cam.bottom) * JOINT_SCREEN_SIZE, 1e-3)
      const c = cam.position
      const dist = Math.hypot(c[0] - pos[0], c[1] - pos[1], c[2] - pos[2])
      const halfFov = (cam.fov * Math.PI / 180) / 2
      return Math.max(dist * Math.tan(halfFov) * JOINT_SCREEN_SIZE, 1e-3)
    }

    const tick = () => {
      const scene = instance.scene
      if (scene) {
        // Gather every skinned model's joints into one flat instance buffer.
        const jointMatList: Float32Array[] = []
        const boneMatList: Float32Array[] = []
        let jointCount = 0, boneCount = 0

        for (const node of scene.nodes) {
          if (!(node instanceof ModelNode)) continue
          const model = node.model
          if (!(model instanceof AnimatedModel) || !model.hasSkin || !model.skin || !node.animator) continue
          const skin = model.skin
          let bind = bindCache.get(skin)
          if (!bind) { bind = computeBindMatrices(skin); bindCache.set(skin, bind) }
          const pairs = bonePairsOf(skin)
          const mats = computeJointWorldMatrices(node, node.animator, skin, bind)
          const n = skin.joints.length

          const jm = new Float32Array(n * 16)
          const jpos = new Float32Array(n * 3)
          const posv: [number, number, number] = [0, 0, 0]
          const scl: [number, number, number] = [0, 0, 0]
          for (let i = 0; i < n; i++) {
            const pos = worldPositionOf(mats[i])
            const s = scaleAt(pos)
            jpos[i * 3] = pos[0]; jpos[i * 3 + 1] = pos[1]; jpos[i * 3 + 2] = pos[2]
            posv[0] = pos[0]; posv[1] = pos[1]; posv[2] = pos[2]
            scl[0] = s; scl[1] = s; scl[2] = s
            Vec.mat4.fromRotationTranslationScale(jm.subarray(i * 16, i * 16 + 16) as any, IDENT_Q as any, posv as any, scl as any)
          }

          const bm = new Float32Array(pairs.length * 16)
          for (let b = 0; b < pairs.length; b++) {
            const [ci, pi] = pairs[b]
            const cx = jpos[ci * 3], cy = jpos[ci * 3 + 1], cz = jpos[ci * 3 + 2]
            const px = jpos[pi * 3], py = jpos[pi * 3 + 1], pz = jpos[pi * 3 + 2]
            const dx = px - cx, dy = py - cy, dz = pz - cz
            const len = Math.hypot(dx, dy, dz)
            const out = bm.subarray(b * 16, b * 16 + 16) as any
            if (len > 1e-5) {
              const s = scaleAt([cx, cy, cz])
              Vec.quat.rotationTo(q, up as any, [dx / len, dy / len, dz / len] as any)
              Vec.mat4.fromRotationTranslationScale(out, q as any, [(cx + px) / 2, (cy + py) / 2, (cz + pz) / 2] as any, [s * 0.35, len, s * 0.35] as any)
            } else {
              Vec.mat4.identity(out); out[0] = out[5] = out[10] = 0
            }
          }

          jointMatList.push(jm); boneMatList.push(bm)
          jointCount += n; boneCount += pairs.length
        }

        if (jointCount > 0) {
          const joints = new Float32Array(jointCount * 16)
          const bones = new Float32Array(boneCount * 16)
          let jo = 0, bo = 0
          for (const a of jointMatList) { joints.set(a, jo); jo += a.length }
          for (const a of boneMatList) { bones.set(a, bo); bo += a.length }
          instance.renderer.setSkeletonOverlay({
            jointMatrices: joints, jointCount, jointColor: JOINT_COLOR,
            boneMatrices: bones, boneCount, boneColor: BONE_COLOR,
            highlightMatrix: null,
          })
        } else {
          instance.renderer.setSkeletonOverlay(null)
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(raf); instance.renderer.setSkeletonOverlay(null) }
  }, [instance, active])

  return null
}

import { mat4 } from 'gl-matrix'
import { AnimatedModel, Geometry, Material, ModelNode } from 'cleo'
import type { Skin } from 'cleo'
import { loadSkin, type StoredSkin } from '../../utils/animationAssets'

// A stand-in character for a skeleton with no mesh, so the rig and clip editors can show a rig that no
// model uses yet.
//
// Those tabs draw bones through the SKINNED NODE they are given (`skinnedId`): the bone overlay, the joint
// tree and the transport all read its Animator. A rig without a character had no such node, so the tab
// logged "showing the skeleton on its own" and then showed nothing. The proxy is a real AnimatedModel over
// the rig's skin — one degenerate triangle bound to joint 0 — which renders nothing itself but carries an
// Animator exactly like a character's.

/** The proxy's node name. Editor-owned by its `__editor__` prefix, and deliberately free of "gizmo". */
export const SKELETON_PROXY_NAME = '__editor__skeletonProxy'

export interface SkeletonProxy {
  node: ModelNode
  /** Centre and radius of the bind pose, for framing the camera. */
  center: [number, number, number]
  radius: number
}

const toMat4 = (a: number[]) => {
  const m = mat4.create()
  for (let i = 0; i < 16 && i < a.length; i++) m[i] = a[i]
  return m
}

/**
 * The bounds of a skin's bind pose: each joint's bind position is the translation of its inverse
 * inverse-bind matrix. Skeletons are routinely authored in centimetres, which is why the fixed
 * "a metre-tall box at the origin" framing lost them.
 */
export function bindPoseBounds(skin: Pick<Skin, 'joints'>): { center: [number, number, number]; radius: number } | null {
  if (!skin.joints.length) return null
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  const world = mat4.create()
  for (const j of skin.joints) {
    if (!mat4.invert(world, j.inverseBindMatrix)) continue
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], world[12 + k])
      hi[k] = Math.max(hi[k], world[12 + k])
    }
  }
  if (!isFinite(lo[0])) return null
  const center: [number, number, number] = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]
  const radius = Math.max(0.05, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2)
  return { center, radius }
}

/**
 * Build the proxy for a stored skin, or null when it has no joints. Not added to any scene: the caller
 * adds it under its (editor-owned) preview holder, inside `withoutDirty`.
 */
export function buildSkeletonProxy(stored: StoredSkin | null | undefined): SkeletonProxy | null {
  const skin = loadSkin(stored, toMat4) as Skin | null
  const bounds = skin ? bindPoseBounds(skin) : null
  if (!skin || !bounds) return null
  // Three coincident vertices: zero area, so nothing is ever rasterized, but the skinned program still
  // gets the joint and weight attributes it binds.
  const geometry = new Geometry(
    new Float32Array(9), new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), new Float32Array(6),
    [], [], new Uint32Array([0, 1, 2]))
  const jointIndices = new Float32Array(12)
  const jointWeights = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])
  const model = new AnimatedModel(geometry, Material.Basic({ color: [1, 1, 1] }, { castShadow: false }),
    skin, jointIndices, jointWeights, [])
  return { node: new ModelNode(SKELETON_PROXY_NAME, model), ...bounds }
}

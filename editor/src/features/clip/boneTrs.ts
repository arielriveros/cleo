import { mat4, quat, vec3 } from 'gl-matrix'
import { decomposeTRS, eulerFromQuatDeg } from 'cleo'

// A bone's local matrix as the numbers a person edits, shared by the Bone panel and the bone gizmo.
//
// Every read goes through `decomposeTRS`, never `mat4.getRotation`: gl-matrix divides by the scale
// unguarded, so one zero-scale axis turns the rotation into NaN — and the next edit writes that NaN back
// into the pin, exploding the bone and everything under it.

/** A local matrix split into metres, degrees, and a scale factor. */
export type Trs = { t: [number, number, number]; r: [number, number, number]; s: [number, number, number] }

/** The smallest scale magnitude a pose may carry. At 0 the matrix no longer has a rotation to read back. */
const MIN_SCALE = 1e-4

/** Keep a scale factor off zero, preserving its sign (a mirrored axis stays mirrored). */
export function safeScale(v: number): number {
  if (!Number.isFinite(v)) return 1
  return (v < 0 ? -1 : 1) * Math.max(Math.abs(v), MIN_SCALE)
}

export function decomposeBone(m: mat4): Trs {
  const t = vec3.create(), q = quat.create(), s = vec3.create()
  decomposeTRS(m, t, q, s)
  const e = eulerFromQuatDeg(vec3.create(), q)
  return { t: [t[0], t[1], t[2]], r: [e[0], e[1], e[2]], s: [s[0], s[1], s[2]] }
}

export function composeBone(trs: Trs): mat4 {
  const q = quat.fromEuler(quat.create(), trs.r[0], trs.r[1], trs.r[2])
  const s = vec3.fromValues(safeScale(trs.s[0]), safeScale(trs.s[1]), safeScale(trs.s[2]))
  return mat4.fromRotationTranslationScale(mat4.create(), q, trs.t, s)
}

/**
 * A bone's LOCAL matrix from a desired WORLD position and rotation, keeping `localScale` as the bone's own.
 *
 * Solved piece by piece, never as `inverse(parentWorld) x TRS(worldPos, worldRot, localScale)`: that
 * mixes a world pose with a local scale, and the inverse then divides the parent's WORLD scale out of it.
 * Under the 0.01 armature an FBX rig carries, every drag handed the bone a 100x scale and blew the
 * limb — and everything under it — apart. Null when the parent is degenerate.
 */
export function boneLocalFromWorld(parentWorld: mat4, worldPos: vec3, worldRot: quat, localScale: vec3): mat4 | null {
  const inv = mat4.invert(mat4.create(), parentWorld)
  if (!inv) return null
  const t = vec3.transformMat4(vec3.create(), worldPos, inv)
  const pr = boneRotation(parentWorld)
  const r = quat.multiply(quat.create(), quat.invert(quat.create(), pr), worldRot)
  quat.normalize(r, r)
  const s = vec3.fromValues(safeScale(localScale[0]), safeScale(localScale[1]), safeScale(localScale[2]))
  return mat4.fromRotationTranslationScale(mat4.create(), r, t, s)
}

/** A local matrix's rotation as a unit quaternion, NaN-free. */
export function boneRotation(m: mat4): quat {
  const q = quat.create()
  decomposeTRS(m, vec3.create(), q, vec3.create())
  return q
}

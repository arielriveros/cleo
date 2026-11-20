import { mat4, quat, vec3 } from 'gl-matrix'
import { decomposeTRS } from 'cleo'

// A stored pose bone onto a live bone, for the Skeleton part's pose preview.
//
// Read through `decomposeTRS`, never `mat4.getRotation`: gl-matrix divides by the scale unguarded, so one
// zero-scale axis in a rest matrix turns the rotation into NaN and explodes the bone and everything under it.

/** One bone of a stored pose: a delta from rest, the form pose states and pose assets hold. */
export type PoseDelta = { rotation?: number[]; translation?: number[] }

/**
 * A bone's LOCAL matrix holding `delta` on top of `rest`: `rotation = delta x rest`, `translation = rest +
 * delta`, in the PARENT frame. The rest's scale is kept. The same composition `Animator._poseClip` plays a
 * pose state with.
 */
export function poseBoneLocal(rest: mat4, delta: PoseDelta): mat4 {
  const t = vec3.create(), r = quat.create(), s = vec3.create()
  decomposeTRS(rest, t, r, s)
  if (delta.rotation) {
    const d = quat.fromValues(delta.rotation[0], delta.rotation[1], delta.rotation[2], delta.rotation[3])
    quat.normalize(r, quat.multiply(r, d, r))
  }
  if (delta.translation) vec3.add(t, t, vec3.fromValues(delta.translation[0], delta.translation[1], delta.translation[2]))
  return mat4.fromRotationTranslationScale(mat4.create(), r, t, s)
}

/** A local matrix's rotation as a unit quaternion, NaN-free. */
export function boneRotation(m: mat4): quat {
  const q = quat.create()
  decomposeTRS(m, vec3.create(), q, vec3.create())
  return q
}

/**
 * A bone's pose as a delta from its rest, in the PARENT frame: `rotation = local x inverse(rest)`, `translation =
 * local - rest`: the inverse of {@link poseBoneLocal}, what capturing a pose stores. Parts below the noise floor
 * are omitted, and null means "at rest": a bone that only came along for the ride is not stored.
 */
export function poseDeltaOf(local: mat4, rest: mat4): PoseDelta | null {
  const restRot = boneRotation(rest)
  const rot = boneRotation(local)
  const delta = quat.normalize(quat.create(), quat.multiply(quat.create(), rot, quat.invert(quat.create(), restRot)))
  if (delta[3] < 0) quat.scale(delta, delta, -1)
  const dt = vec3.subtract(vec3.create(), mat4.getTranslation(vec3.create(), local), mat4.getTranslation(vec3.create(), rest))
  const out: PoseDelta = {}
  if (Math.abs(quat.getAxisAngle(vec3.create(), delta)) > 1e-4) out.rotation = [delta[0], delta[1], delta[2], delta[3]]
  if (vec3.length(dt) > 1e-5) out.translation = [dt[0], dt[1], dt[2]]
  return out.rotation || out.translation ? out : null
}

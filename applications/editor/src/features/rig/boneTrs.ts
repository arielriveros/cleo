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

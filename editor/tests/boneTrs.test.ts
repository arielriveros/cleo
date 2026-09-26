import { describe, it, expect } from 'vitest'
import { mat4, quat, vec3 } from 'gl-matrix'
import { boneLocalFromWorld } from '../src/features/clip/boneTrs'

// The bone gizmo drags a WORLD pose and must write back a LOCAL one. Solved as one matrix,
// `inverse(parentWorld) x TRS(worldPos, worldRot, localScale)`, the parent's world scale was divided out
// of a scale that was never world — under an FBX rig's 0.01 armature every drag made the bone 100x.

const expectMatClose = (a: mat4, b: mat4) => { for (let i = 0; i < 16; i++) expect(a[i]).toBeCloseTo(b[i], 5) }

/** The world pose a local produces under `parent` — what the proxy node would be parked on. */
function worldPoseOf(parent: mat4, local: mat4) {
  const pos = mat4.getTranslation(vec3.create(), mat4.multiply(mat4.create(), parent, local))
  const rot = quat.multiply(quat.create(), rotOf(parent), rotOf(local))
  return { pos, rot }
}
/** Uniform-scale matrices only: gl-matrix's getRotation is exact there. */
const rotOf = (m: mat4) => quat.normalize(quat.create(), mat4.getRotation(quat.create(), m))

describe('boneLocalFromWorld', () => {
  it('recovers the local under a 0.01-scaled armature instead of a 100x one', () => {
    const parent = mat4.fromRotationTranslationScale(mat4.create(),
      quat.fromEuler(quat.create(), -90, 0, 0), [0, 1, 0], [0.01, 0.01, 0.01])
    const local = mat4.fromRotationTranslationScale(mat4.create(),
      quat.fromEuler(quat.create(), 10, 35, -20), [5, 20, -3], [1, 1, 1])
    const { pos, rot } = worldPoseOf(parent, local)

    const solved = boneLocalFromWorld(parent, pos, rot, [1, 1, 1])!
    expect(mat4.getScaling(vec3.create(), solved)[0]).toBeCloseTo(1, 5)
    expectMatClose(solved, local)
  })

  it('keeps the local scale it is given, mirrored included', () => {
    const parent = mat4.fromScaling(mat4.create(), [2, 2, 2])
    const solved = boneLocalFromWorld(parent, [0, 0, 0], quat.create(), [-1.5, 1, 1])!
    expect(solved[0]).toBeCloseTo(-1.5, 6)
  })

  it('returns null under a degenerate parent', () => {
    const parent = mat4.fromScaling(mat4.create(), [0, 1, 1])
    expect(boneLocalFromWorld(parent, [0, 0, 0], quat.create(), [1, 1, 1])).toBeNull()
  })
})

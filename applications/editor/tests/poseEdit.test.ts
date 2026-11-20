import { describe, it, expect } from 'vitest'
import { mat4, quat } from 'gl-matrix'
import { buildPoseAsset, composePoseBones, resolvePoseBones, type PoseAsset } from '../src/utils/poseAssets'
import { freePoseName, independentPose, newVariant, parentFrameTurn, projectPoseAsset, setPoseBoneRotation, turnPoseBone, withPose } from '../src/utils/poseEdit'
import { poseBoneLocal, poseDeltaOf } from '../src/features/rig/boneTrs'

// The pose mode's pure part: a turn dragged in WORLD space lands in the pose (or a variant) as a parent-frame
// pre-multiplication, exactly what the animator then shows.

const axis = (a: [number, number, number], deg: number) => { const q = quat.setAxisAngle(quat.create(), a, deg * Math.PI / 180); return [q[0], q[1], q[2], q[3]] }
const Y: [number, number, number] = [0, 1, 0], X: [number, number, number] = [1, 0, 0], Z: [number, number, number] = [0, 0, 1]
const q = (v: number[]) => quat.fromValues(v[0], v[1], v[2], v[3])
const apart = (a: number[], b: number[]) => 2 * Math.acos(Math.min(1, Math.abs(quat.dot(q(a), q(b))))) * 180 / Math.PI

describe('pose editing', () => {
  it('turns a bone in its parent frame, so its world turn is the one dragged', () => {
    // A bone whose parent faces 30 degrees round Y in the world (under a 0.01 armature: rotations only).
    const parent = axis(Y, 30)
    const delta = axis(X, 20)
    const worldTurn = axis(Z, 15)
    const turned = turnPoseBone([{ name: 'Spine2', rotation: delta }], 'Spine2', parentFrameTurn(worldTurn, parent))
    // World turn of the bone before and after: parent x delta x rest (rest identity).
    const before = quat.multiply(quat.create(), q(parent), q(delta))
    const after = quat.multiply(quat.create(), q(parent), q(turned[0].rotation!))
    const applied = quat.multiply(quat.create(), after, quat.invert(quat.create(), before))
    expect(apart(Array.from(applied), worldTurn)).toBeLessThan(0.05)
  })

  it('adds a bone the pose did not hold, and drops one set back to its rest', () => {
    const bones = turnPoseBone([], 'Head', axis(Y, 10))
    expect(bones.map(b => b.name)).toEqual(['Head'])
    expect(setPoseBoneRotation(bones, 'Head', [0, 0, 0, 1])).toEqual([])
    expect(setPoseBoneRotation([{ name: 'Hips', rotation: axis(Y, 5), translation: [0, 1, 0] }], 'Hips', [0, 0, 0, 1])).toEqual([{ name: 'Hips', translation: [0, 1, 0] }])
  })

  it('turns a variant by what the drag adds, so its resolved pose turns by it too', () => {
    const lib: PoseAsset[] = [buildPoseAsset('P', 'rig', [{ id: 'aim', name: 'Aim', bones: [{ name: 'Spine2', rotation: axis(Y, 20) }] }], 'p')]
    const variant = newVariant({ asset: lib[0], pose: lib[0].poses[0] }, 'Up')
    expect(variant.bones).toEqual([])
    const turn = axis(X, -25)
    const edited = { ...variant, bones: turnPoseBone(variant.bones, 'Spine2', turn) }
    const resolved = resolvePoseBones([{ ...lib[0], poses: [...lib[0].poses, edited] }], edited).bones[0].rotation!
    expect(apart(resolved, Array.from(quat.multiply(quat.create(), q(turn), q(axis(Y, 20)))))).toBeLessThan(0.05)
  })

  it('makes a variant independent as it looks', () => {
    const base = { id: 'aim', name: 'Aim', bones: [{ name: 'Spine2', rotation: axis(Y, 20) }] }
    const v = { id: 'v', name: 'Up', baseRef: { assetId: 'p', poseId: 'aim' }, bones: [{ name: 'Spine2', rotation: axis(X, -30) }] }
    const lib = [buildPoseAsset('P', 'rig', [base, v], 'p')]
    const own = independentPose(lib, v)
    expect(own.baseRef).toBeUndefined()
    expect(own.bones).toEqual(composePoseBones(base.bones, v.bones))
  })

  it('puts new poses of a Creator skeleton in its own project asset, and names them freely', () => {
    const creator = buildPoseAsset('Creator Aim', 'rig', [], 'cr_x')
    const home = projectPoseAsset([creator], 'rig', 'Mannequin', id => id.startsWith('cr_'))
    expect(home.isNew).toBe(true)
    expect(home.asset.name).toBe('Mannequin Poses')
    const mine = buildPoseAsset('Mine', 'rig', [{ id: 'a', name: 'Pose', bones: [] }], 'mine')
    expect(projectPoseAsset([creator, mine], 'rig', 'Mannequin', id => id.startsWith('cr_')).asset.id).toBe('mine')
    expect(freePoseName(mine, 'Pose')).toBe('Pose 2')
    expect(withPose(mine, 'a', () => null).poses).toEqual([])
  })

  it('captures a bone off its rest and back', () => {
    const rest = mat4.fromRotationTranslation(mat4.create(), q(axis(Y, 90)), [0, 10, 0])
    const local = poseBoneLocal(rest, { rotation: axis(X, 33) })
    const delta = poseDeltaOf(local, rest)!
    expect(apart(delta.rotation!, axis(X, 33))).toBeLessThan(1e-3)
    expect(delta.translation).toBeUndefined()
    expect(poseDeltaOf(rest, rest)).toBeNull()
  })
})

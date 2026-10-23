import { describe, it, expect } from 'vitest'
import { mat4, quat } from 'gl-matrix'
import { buildBoneMapping, applyManualMapping } from 'cleo'
import type { Animation, Skin } from 'cleo'
import { skeletonLayout, retargetView } from '../src/utils/retargetView'

// The bone mapper draws both skeletons in one front view and colours every bone by what the retarget will
// actually do with it. The layout must come out the same way up and the same way round for any rig, and the
// colours must come from the engine's plan.

type Spec = { name: string; parent: number; t: [number, number, number] }

/** A skin with real inverse bind matrices from the given local translations. */
function skin(bones: Spec[]): Skin {
  const world: mat4[] = []
  const nodeTransforms = new Map<number, mat4>()
  bones.forEach((b, i) => {
    const local = mat4.fromTranslation(mat4.create(), b.t)
    nodeTransforms.set(i, local)
    world[i] = b.parent >= 0 ? mat4.multiply(mat4.create(), world[b.parent], local) : local
  })
  return {
    joints: bones.map((b, i) => ({ nodeIndex: i, inverseBindMatrix: mat4.invert(mat4.create(), world[i])!, parentIndex: b.parent >= 0 ? b.parent : undefined })),
    nodeParents: new Map(bones.flatMap((b, i) => (b.parent >= 0 ? [[i, b.parent] as [number, number]] : []))),
    nodeTransforms,
    nodeNames: new Map(bones.map((b, i) => [i, b.name])),
  } as Skin
}

/** A small humanoid. `axes` permutes [lateral, up, depth] so the same body can be stored Y-up or Z-up. */
const body = (prefix: string, axes: (v: [number, number, number]) => [number, number, number]): Spec[] => [
  { name: `${prefix}Hips`, parent: -1, t: axes([0, 100, 0]) },
  { name: `${prefix}Spine`, parent: 0, t: axes([0, 20, 0]) },
  { name: `${prefix}LeftShoulder`, parent: 1, t: axes([10, 20, 0]) },
  { name: `${prefix}LeftArm`, parent: 2, t: axes([15, 0, 0]) },
  { name: `${prefix}RightShoulder`, parent: 1, t: axes([-10, 20, 0]) },
  { name: `${prefix}RightArm`, parent: 4, t: axes([-15, 0, 0]) },
  { name: `${prefix}LeftUpLeg`, parent: 0, t: axes([10, 0, 0]) },
  { name: `${prefix}LeftLeg`, parent: 6, t: axes([0, -50, 0]) },
  { name: `${prefix}LeftFoot`, parent: 7, t: axes([0, -45, 0]) },
]
const yUp = (v: [number, number, number]) => v
const zUp = (v: [number, number, number]): [number, number, number] => [-v[0], v[2], v[1]] // left is -X, up is Z

describe('skeletonLayout', () => {
  it('stands any rig upright, unit height, with the character\'s left on +x', () => {
    for (const axes of [yUp, zUp]) {
      const l = skeletonLayout(skin(body('', axes)))
      const by = (name: string) => l.joints.find(j => j.name === name)!
      expect(Math.min(...l.joints.map(j => j.y))).toBeCloseTo(0, 6)
      expect(Math.max(...l.joints.map(j => j.y))).toBeCloseTo(1, 6)
      expect(by('LeftArm').x).toBeGreaterThan(0)
      expect(by('RightArm').x).toBeLessThan(0)
      expect(by('Hips').y).toBeGreaterThan(by('LeftFoot').y)
      expect(by('LeftArm').parent).toBe(l.byNode.get(2))
    }
  })
})

describe('skeletonLayout — a T-pose wider than it is tall', () => {
  it('stands up by hips → head, not by the widest axis', () => {
    const wide: Spec[] = [
      { name: 'Hips', parent: -1, t: [0, 100, 0] },
      { name: 'Spine', parent: 0, t: [0, 20, 0] },
      { name: 'Head', parent: 1, t: [0, 30, 0] },
      { name: 'LeftArm', parent: 1, t: [15, 15, 0] },
      { name: 'LeftHand', parent: 3, t: [110, 0, 0] },
      { name: 'RightArm', parent: 1, t: [-15, 15, 0] },
      { name: 'RightHand', parent: 5, t: [-110, 0, 0] },
      { name: 'LeftFoot', parent: 0, t: [10, -95, 0] },
    ]
    const l = skeletonLayout(skin(wide))
    const by = (name: string) => l.joints.find(j => j.name === name)!
    expect(by('Head').y).toBeGreaterThan(by('Hips').y)
    expect(by('LeftFoot').y).toBeCloseTo(0, 6)
    expect(by('LeftHand').x).toBeGreaterThan(0.5) // the arms are wide, not tall
    expect(Math.abs(by('LeftHand').y - by('RightHand').y)).toBeLessThan(1e-6)
  })
})

describe('retargetView', () => {
  const src = skin(body('mixamorig:', yUp))
  // The target has no clavicles: the shoulders' motion must fold into the arms, which hang off the spine.
  const full = body('', yUp)
  const names = full.filter(b => !b.name.includes('Shoulder')).map(b => b.name)
  const tgtSkin = skin(names.map(n => {
    const spec = full.find(b => b.name === n)!
    const parentName = n.endsWith('Arm') ? 'Spine' : spec.parent >= 0 ? full[spec.parent].name : null
    return { ...spec, parent: parentName ? names.indexOf(parentName) : -1 }
  }))

  const q = Array.from(quat.create())
  const clip = (nodes: number[]): Animation => ({
    name: 'c',
    samplers: nodes.map(() => ({ input: [0], output: q.slice(), interpolation: 'LINEAR' as const })),
    channels: nodes.map((n, i) => ({ samplerIndex: i, targetNodeIndex: n, targetPath: 'rotation' as const })),
  })

  it('colours mapped, merged, lost and static source bones, and driven/rest target bones', () => {
    const c = clip([0, 1, 2, 3, 8])
    const m = buildBoneMapping([c], src, tgtSkin)
    const v = retargetView(m, src, tgtSkin)
    expect(v.source.get(0)).toBe('auto')     // hips
    expect(v.source.get(2)).toBe('merged')   // LeftShoulder folds into LeftArm
    expect(v.source.get(3)).toBe('auto')     // LeftArm
    expect(v.source.get(4)).toBe('static')   // RightShoulder: no clip animates it
    expect(v.target.get(names.indexOf('RightArm'))).toBe('rest')
    expect(v.target.get(names.indexOf('LeftArm'))).toBe('merged')
    expect(v.links.find(l => l.source === 2)).toEqual({ source: 2, target: names.indexOf('LeftArm'), merged: true })
  })

  it('shows a bone dropped on purpose as dropped, not merged', () => {
    const c = clip([0, 1, 2, 3])
    const m = applyManualMapping(buildBoneMapping([c], src, tgtSkin), 2, null)
    expect(retargetView(m, src, tgtSkin).source.get(2)).toBe('dropped')
  })
})

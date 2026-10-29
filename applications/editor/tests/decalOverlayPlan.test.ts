import { describe, it, expect } from 'vitest'
import { DecalNode, Node, LightProbeNode, Vec, markEditorOnly } from 'cleo'
import { planDecalBox, decalBoxFrame, decalBoxLines } from '../src/utils/decalOverlayPlan'

/**
 * The selected decal's viewport box, decided without a GPU. The helper can not copy the node's
 * `worldScale`/`worldQuaternion` — a column length is never negative and a mirrored matrix has no
 * rotation — so these pin that the frame it builds reproduces the decal's own `volumeMatrix`, and above
 * all that the arrow's axis (local -Y, the projection direction) lands exactly where the decal projects.
 */

/** World position of a unit-box local point, through the helper's frame (T * R * S). */
function throughFrame(frame: ReturnType<typeof decalBoxFrame>, p: [number, number, number]): Vec.vec3 {
  const m = Vec.mat4.fromRotationTranslationScale(Vec.mat4.create(), frame.quaternion, frame.center, frame.scale)
  return Vec.vec3.transformMat4(Vec.vec3.create(), Vec.vec3.fromValues(...p), m)
}

/** The same point through the decal's own volume matrix — the ground truth. */
function throughVolume(decal: DecalNode, p: [number, number, number]): Vec.vec3 {
  return Vec.vec3.transformMat4(Vec.vec3.create(), Vec.vec3.fromValues(...p), decal.volumeMatrix)
}

function expectClose(a: ArrayLike<number>, b: ArrayLike<number>) {
  for (let i = 0; i < 3; i++) expect(a[i]).toBeCloseTo(b[i], 5)
}

const CORNERS: [number, number, number][] = []
for (let i = 0; i < 8; i++) CORNERS.push([(i & 1) ? 0.5 : -0.5, (i & 2) ? 0.5 : -0.5, (i & 4) ? 0.5 : -0.5])

describe('planDecalBox: selection of a real decal is the only gate', () => {
  it('plans nothing without a selection, or for a node that is not a decal', () => {
    expect(planDecalBox(null)).toBeNull()
    expect(planDecalBox(undefined)).toBeNull()
    expect(planDecalBox(new Node('plain'))).toBeNull()
    expect(planDecalBox(new LightProbeNode('probe', { size: [4, 4, 4] }))).toBeNull()
  })

  it('plans a box for a selected decal', () => {
    const decal = new DecalNode('decal', { size: [2, 1, 2] })
    decal.updateTransforms()
    const frame = planDecalBox(decal)
    expect(frame).not.toBeNull()
    expectClose(frame!.scale, [2, 1, 2])
  })

  it('never plans one for an editor-owned decal (the landscape brush)', () => {
    const brush = new DecalNode('__editor__terrainBrush', { size: [4, 1, 4] })
    expect(planDecalBox(brush)).toBeNull()
    const flagged = new DecalNode('cursor')
    markEditorOnly(flagged)
    expect(planDecalBox(flagged)).toBeNull()
  })
})

describe('decalBoxFrame: the helper box matches the decal volume', () => {
  it('scales each axis by size x the node scale, not uniformly', () => {
    const decal = new DecalNode('decal', { size: [2, 1, 4] })
    decal.setPosition([3, 1, -2]).setScale([1, 3, 0.5])
    decal.updateTransforms()
    const frame = decalBoxFrame(decal.volumeMatrix)
    expectClose(frame.center, [3, 1, -2])
    expectClose(frame.scale, [2, 3, 2])
    for (const c of CORNERS) expectClose(throughFrame(frame, c), throughVolume(decal, c))
  })

  it('follows the node rotation', () => {
    const decal = new DecalNode('decal', { size: [2, 0.5, 3] })
    decal.setRotation([30, 45, -20])
    decal.updateTransforms()
    const frame = decalBoxFrame(decal.volumeMatrix)
    for (const c of CORNERS) expectClose(throughFrame(frame, c), throughVolume(decal, c))
  })

  it('follows a transformed parent', () => {
    const parent = new Node('parent')
    parent.setPosition([10, 0, 0]).setRotation([0, 90, 0]).setUniformScale(2)
    const decal = new DecalNode('decal', { size: [1, 1, 3] })
    decal.setPosition([0, 2, 0])
    parent.addChild(decal)
    parent.updateTransforms()
    const frame = decalBoxFrame(decal.volumeMatrix)
    for (const c of CORNERS) expectClose(throughFrame(frame, c), throughVolume(decal, c))
  })

  it('keeps a real rotation and the true projection direction when the node is mirrored', () => {
    for (const scale of [[-1, 1, 1], [1, -1, 1], [1, 1, -1]] as [number, number, number][]) {
      const decal = new DecalNode('decal', { size: [2, 1, 2] })
      decal.setScale(scale).setRotation([0, 30, 0])
      decal.updateTransforms()
      expect(decal.mirrored).toBe(true)

      const frame = decalBoxFrame(decal.volumeMatrix)
      expect(Vec.quat.length(frame.quaternion)).toBeCloseTo(1, 6)
      expect(Array.from(frame.scale).every(s => s > 0)).toBe(true)
      // The arrow runs along local Y: both ends must land exactly where the decal's own box puts them,
      // mirror or not, so it always points the way the decal projects.
      expectClose(throughFrame(frame, [0, -0.5, 0]), throughVolume(decal, [0, -0.5, 0]))
      expectClose(throughFrame(frame, [0, 0.5, 0]), throughVolume(decal, [0, 0.5, 0]))
    }
  })

  it('floors a collapsed axis to a visible sliver instead of a degenerate scale', () => {
    const decal = new DecalNode('decal', { size: [2, 1, 2] })
    decal.setScale([1, 0, 1])
    decal.updateTransforms()
    const frame = decalBoxFrame(decal.volumeMatrix)
    expect(frame.scale[1]).toBeGreaterThan(0)
    expect(Number.isFinite(frame.quaternion[0])).toBe(true)
  })
})

describe('decalBoxLines: the wireframe', () => {
  const { positions, indices } = decalBoxLines()

  it('is a line list: index pairs, every one addressing a real vertex', () => {
    expect(indices.length % 2).toBe(0)
    for (const i of indices) expect(i).toBeLessThan(positions.length)
  })

  it('draws all 12 edges of the unit cube, each once', () => {
    const cubeEdges = new Set<string>()
    for (let s = 0; s < indices.length; s += 2) {
      const a = positions[indices[s]], b = positions[indices[s + 1]]
      const onCorner = (p: number[]) => p.every(v => Math.abs(v) === 0.5)
      if (!onCorner(a) || !onCorner(b)) continue
      // Adjacent corners differ in exactly one coordinate.
      expect(a.filter((v, k) => v !== b[k]).length).toBe(1)
      cubeEdges.add([a, b].map(p => p.join(',')).sort().join('|'))
    }
    expect(cubeEdges.size).toBe(12)
  })

  it('carries a shaft down the Y axis, and an arrowhead whose tip is below its barbs (pointing -Y)', () => {
    const segs: [number[], number[]][] = []
    for (let s = 0; s < indices.length; s += 2) segs.push([positions[indices[s]], positions[indices[s + 1]]])
    const onAxis = (p: number[]) => p[0] === 0 && p[2] === 0
    expect(segs.some(([a, b]) => onAxis(a) && onAxis(b) && a[1] === 0.5 && b[1] === -0.5)).toBe(true)

    const barbs = segs.filter(([a, b]) => !onAxis(a) && onAxis(b))
    expect(barbs.length).toBe(4)
    for (const [barb, tip] of barbs) expect(tip[1]).toBeLessThan(barb[1])
    // Every line stays inside the unit box, so it scales with the decal rather than poking out of it.
    for (const p of positions) for (const v of p) expect(Math.abs(v)).toBeLessThanOrEqual(0.5)
  })
})

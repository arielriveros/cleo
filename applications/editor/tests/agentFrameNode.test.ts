import { describe, expect, it } from 'vitest'
import { Camera, CameraNode, Scene, type Node } from 'cleo'
import { vec3 } from 'gl-matrix'
import { frameNode, frameOrtho } from '../src/features/agentBridge/capture'
import { frameKeepingView } from '../src/features/viewport/frameNode'

// Framing a node for the agent's captures (agentBridge/capture.ts) in an orthographic view: a split
// viewport's Top or Front pane, or the 2D view, keeps the axis it looks along and zooms to fit.

function orthoCamera(rotation: [number, number, number], position: [number, number, number], opts: { up?: [number, number, number]; detail?: number; size?: [number, number] } = {}) {
  const scene = new Scene()
  const node = new CameraNode('__editor__CameraPane1', new Camera({ far: 10000 }))
  node.camera.type = 'orthographic'
  node.camera.up = vec3.fromValues(...(opts.up ?? [0, 1, 0]))
  node.camera.detailDistance = opts.detail ?? 0
  const [w, h] = opts.size ?? [100, 100]
  node.camera.resize(w, h)
  scene.addNode(node)
  node.setPosition(position).setRotation(rotation)
  scene.root.updateTransforms(null)
  return { scene, node }
}

const top = (detail = 100, size: [number, number] = [100, 100]) =>
  orthoCamera([90, 0, 0], [0, 100, 0], { up: [0, 0, 1], detail, size })

const close = (a: ArrayLike<number>, b: number[]) => b.forEach((v, i) => expect(a[i]).toBeCloseTo(v, 5))

describe('frameOrtho', () => {
  it('centres the box under a Top view at its standoff, without turning it', () => {
    const { node } = top()
    frameOrtho(node, [5, 2, -3], [2, 1, 4])
    close(node.position, [5, 102, -3])
    close(node.rotation, [90, 0, 0])
    // Top looks down Y: the screen holds X and Z, and Z (4) is the larger half.
    expect(node.camera.top).toBeCloseTo(4 * 1.15, 5)
    expect(node.camera.bottom).toBeCloseTo(-4 * 1.15, 5)
    expect(node.camera.left).toBeCloseTo(-4 * 1.15, 5)
  })

  it('fits a wide box against the view\'s aspect', () => {
    // A 2:1 view shows twice as much across as up and down: a 10 m half-width needs a 5 m half-height.
    const { node } = top(100, [200, 100])
    frameOrtho(node, [0, 0, 0], [10, 1, 2])
    expect(node.camera.top).toBeCloseTo(5 * 1.15, 5)
  })

  it('keeps the depth of a camera that measures detail from itself (the 2D view)', () => {
    const { node } = orthoCamera([0, 180, 0], [0, 0, 10])
    frameOrtho(node, [3, 1, 0], [1, 0.5, 0])
    close(node.position, [3, 1, 10])
    // Looking along -Z the screen holds X (1 m half) and Y (0.5 m): the width decides on a square view.
    expect(node.camera.top).toBeCloseTo(1.15, 5)
  })

  it('backs off until the whole box is past the near plane', () => {
    const { node } = top()
    frameOrtho(node, [0, 0, 0], [5, 150, 5])
    expect(node.position[1]).toBeCloseTo(150 + node.camera.near * 2, 5)
  })

  it('never zooms in past a quarter metre on a point', () => {
    const { node } = top()
    frameOrtho(node, [0, 0, 0], [0, 0, 0])
    expect(node.camera.top).toBeCloseTo(0.25, 5)
  })
})

describe('frameNode', () => {
  const boxNode = (min: number[], max: number[]) =>
    ({ getBoundingBox: () => ({ min, max }), children: [], worldPosition: [0, 0, 0] }) as unknown as Node

  it('frames an orthographic camera along its own axis, whatever yaw and pitch say', () => {
    const { node } = orthoCamera([0, 90, 0], [0, 0, 0], { detail: 100 })
    frameNode(node, boxNode([-1, 0, -1], [1, 4, 1]), 35, 25)
    close(node.rotation, [0, 90, 0])
    // Right looks along +X: the node's centre (0, 2, 0) is 100 m ahead, and its 2 m half-height fills the view.
    close(node.position, [-100, 2, 0])
    expect(node.camera.top).toBeCloseTo(2 * 1.15, 5)
  })

  it('still orbits a perspective camera', () => {
    const { node } = orthoCamera([0, 0, 0], [0, 0, 0])
    node.camera.type = 'perspective'
    frameNode(node, boxNode([-1, -1, -1], [1, 1, 1]), 35, 25)
    expect(node.rotation[0]).toBeCloseTo(25, 4)
    expect(node.rotation[1]).toBeCloseTo(35, 4)
  })
})

describe('frameKeepingView (View ▸ Frame Selected)', () => {
  const boxNode = (min: number[], max: number[]) =>
    ({ getBoundingBox: () => ({ min, max }), children: [], worldPosition: [0, 0, 0] }) as unknown as Node

  it('moves a perspective camera along its own view until the node fits, never turning it', () => {
    const { node, scene } = orthoCamera([20, 30, 0], [7, 8, 9])
    node.camera.type = 'perspective'
    frameKeepingView(node, boxNode([9, -1, 4], [11, 1, 6]))
    close(node.rotation, [20, 30, 0])
    scene.root.updateTransforms(null)
    // The node's centre (10, 0, 5) is straight ahead of the camera now.
    const p = node.worldPosition, f = node.worldForward
    const to = [10 - p[0], 0 - p[1], 5 - p[2]]
    const d = Math.hypot(to[0], to[1], to[2])
    close(to.map(v => v / d), [f[0], f[1], f[2]])
    // Far enough back to fit the 1.73 m radius in the 60 degree view, with the margin.
    expect(d).toBeCloseTo((Math.sqrt(3) / Math.sin(Math.PI / 6)) * 1.15, 3)
  })

  it('slides and zooms an orthographic camera, as the agent framing does', () => {
    const { node } = orthoCamera([90, 0, 0], [0, 100, 0], { up: [0, 0, 1], detail: 100 })
    frameKeepingView(node, boxNode([4, 0, -2], [6, 2, 2]))
    close(node.rotation, [90, 0, 0])
    close(node.position, [5, 101, 0])
    expect(node.camera.top).toBeCloseTo(2 * 1.15, 5)
  })
})

import { describe, it, expect, afterEach } from 'vitest'
import { Node, Scene, Vec } from 'cleo'
import type { ModelNode, ColliderPart, PartShape } from 'cleo'
import {
  bodyShapeDescriptions, ensureLiveTriggerOverlay, dropLiveTriggerOverlay, tickLiveTriggers,
  LIVE_TRIGGERS, LIVE_TRIGGER_COLORS, type LiveTrigger, type LiveTriggerSource,
} from '../src/utils/liveTriggerOverlay'

// The live trigger overlay draws what physics is testing during Play: a hitbox appears and vanishes on the
// frames its animation events switch it, a hurtbox blinks out for a roll's i-frames. These pin its three
// promises — shapes drawn as built, membership rebuilt only when the physics trigger set changes, and the
// per-frame show/hide/tint — without a GPU: the wire builder is stubbed.

const scenes: Scene[] = []
const newScene = () => { const s = new Scene(); scenes.push(s); return s }
afterEach(() => { while (scenes.length) scenes.pop()!.dispose() })

const v = (x: number, y: number, z: number) => ({ x, y, z })
const q = (x = 0, y = 0, z = 0, w = 1) => ({ x, y, z, w })

const part = (shape: PartShape, offset: [number, number, number], rotation: [number, number, number, number] = [0, 0, 0, 1]): ColliderPart =>
  ({ shape, offset, rotation, boundingRadius: 1 })
const cylinder = (r: number, h: number, segments: number): PartShape =>
  ({ kind: 'cylinder', radiusTop: r, radiusBottom: r, height: h, segments, hull: null })
const sphere = (r: number): PartShape => ({ kind: 'sphere', radius: r })

/** The engine's capsule as cannon simulates it: a cylinder plus two end spheres. */
function capsuleParts(r: number, cyl: number): ColliderPart[] {
  return [part(cylinder(r, cyl, 12), [0, 0.9, 0]), part(sphere(r), [0, 0.9 + cyl / 2, 0]), part(sphere(r), [0, 0.9 - cyl / 2, 0])]
}

function trigger(id: number, owner: Node | null, extra: Partial<LiveTrigger> = {}): LiveTrigger {
  return {
    id, enabled: true, detectTriggers: false, continuous: false, shapeVersion: 0, owner,
    position: v(0, 0, 0), quaternion: q(), ...extra,
  }
}

/** A stand-in wire: a plain node carrying the material properties the overlay tints. */
function stubBuilder() {
  const built: { shapes: unknown[]; color: number[]; node: any }[] = []
  const build = (shapes: unknown[], color: [number, number, number]) => {
    const node: any = new Node('wire')
    node.model = { material: { properties: new Map<string, unknown>([['color', color]]) } }
    node.disposed = false
    node.dispose = () => { node.disposed = true }
    built.push({ shapes, color, node })
    return node as ModelNode
  }
  return { build, built }
}

describe('bodyShapeDescriptions', () => {
  it('turns the engine capsule back into one capsule, at its built size', () => {
    const shapes = bodyShapeDescriptions(capsuleParts(0.3, 1.2))
    expect(shapes).toEqual([{ type: 'capsule', offset: [0, 0.9, 0], rotation: [0, 0, 0], radius: 0.3, height: 1.8, numSegments: 12 }])
  })

  it('gives boxes their full extents and keeps a lone sphere and a capless cylinder', () => {
    const shapes = bodyShapeDescriptions([
      part({ kind: 'box', halfExtents: [0.5, 1, 1.5] }, [1, 0, 0]), part(sphere(0.2), [0, 2, 0]), part(cylinder(0.4, 2, 8), [0, 0, 0]),
    ])
    expect(shapes.map(s => s.type)).toEqual(['box', 'cylinder', 'sphere'])
    expect(shapes[0]).toMatchObject({ width: 1, height: 2, depth: 3, offset: [1, 0, 0] })
    expect(shapes[2]).toMatchObject({ radius: 0.2, offset: [0, 2, 0] })
  })

  it('reads a blade capsule lying along X (a rotated cylinder) as a rotated capsule', () => {
    // Trigger.setCapsule([0,0,0], [1,0,0], 0.05): +Y turned onto +X is -90° about Z.
    const s = Math.SQRT1_2
    const shapes = bodyShapeDescriptions([
      part(cylinder(0.05, 1, 8), [0.5, 0, 0], [0, 0, -s, s]), part(sphere(0.05), [0, 0, 0]), part(sphere(0.05), [1, 0, 0]),
    ])
    expect(shapes).toHaveLength(1)
    expect(shapes[0].type).toBe('capsule')
    expect(shapes[0].rotation.map(r => Math.round(r))).toEqual([0, 0, -90])
  })
})

describe('the live trigger overlay', () => {
  function setup() {
    const scene = newScene()
    const owner = new Node('Hurtbox')
    owner.setPosition(Vec.vec3.fromValues(3, 0, -2))
    scene.addNode(owner)
    scene.root.updateTransforms()
    const t = trigger(7, owner)
    let overlapping = false
    const source: LiveTriggerSource & { version: number; set: Set<LiveTrigger> } = {
      set: new Set([t]), version: 1,
      get triggers() { return this.set },
      get triggerVersion() { return this.version },
      isTriggerOverlapping: () => overlapping,
      colliderParts: () => capsuleParts(0.3, 1.2),
    }
    const { build, built } = stubBuilder()
    const root = ensureLiveTriggerOverlay(scene, source, build)
    return { scene, owner, t, source, build, built, root, setOverlapping: (o: boolean) => { overlapping = o } }
  }

  it('builds one wire per trigger, placed on its node, and only rebuilds when the trigger set changes', () => {
    const { root, source, build, built, t } = setup()
    expect(root.name).toBe(LIVE_TRIGGERS)
    tickLiveTriggers(root, source, build)
    expect(built).toHaveLength(1)
    const wire = built[0].node
    expect(Array.from(wire.position)).toEqual([3, 0, -2])
    expect(built[0].color).toEqual(LIVE_TRIGGER_COLORS.zone)
    for (let i = 0; i < 5; i++) tickLiveTriggers(root, source, build)
    expect(built).toHaveLength(1)

    // Reshaped: rebuilt once, the old wire disposed.
    t.shapeVersion++; source.version++
    tickLiveTriggers(root, source, build)
    expect(built).toHaveLength(2)
    expect(wire.disposed).toBe(true)
  })

  it('hides a disabled trigger the same frame, without rebuilding it', () => {
    const { root, source, build, built, t } = setup()
    tickLiveTriggers(root, source, build)
    t.enabled = false
    tickLiveTriggers(root, source, build)
    expect(built[0].node.visible).toBe(false)
    t.enabled = true
    tickLiveTriggers(root, source, build)
    expect(built[0].node.visible).toBe(true)
    expect(built).toHaveLength(1)
  })

  it('drops the wire of a trigger that left the world', () => {
    const { root, source, build, built, t } = setup()
    tickLiveTriggers(root, source, build)
    source.set.delete(t); source.version++
    tickLiveTriggers(root, source, build)
    expect(built[0].node.disposed).toBe(true)
    expect(root.children).toHaveLength(0)
  })

  it('tints by kind, and yellow while overlapping', () => {
    const { root, source, build, built, t, setOverlapping } = setup()
    t.continuous = true; t.detectTriggers = true
    tickLiveTriggers(root, source, build)
    const color = () => built[0].node.model.material.properties.get('color')
    expect(color()).toEqual(LIVE_TRIGGER_COLORS.swept)
    setOverlapping(true)
    tickLiveTriggers(root, source, build)
    expect(color()).toEqual(LIVE_TRIGGER_COLORS.overlapping)
    setOverlapping(false)
    tickLiveTriggers(root, source, build)
    expect(color()).toEqual(LIVE_TRIGGER_COLORS.swept)
  })

  it('is idempotent, and dropping it removes the root and stops the ticking', () => {
    const { scene, root, source, build } = setup()
    expect(ensureLiveTriggerOverlay(scene, source, build)).toBe(root)
    expect(scene.getNodesByName(LIVE_TRIGGERS)).toHaveLength(1)
    dropLiveTriggerOverlay(scene)
    expect(scene.getNodesByName(LIVE_TRIGGERS)).toHaveLength(0)
  })
})

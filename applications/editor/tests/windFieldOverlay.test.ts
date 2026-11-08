import { describe, it, expect, afterEach } from 'vitest'
import { Node, Scene, WindNode, ForceFieldNode, CameraNode, Camera, MAX_WIND_SOURCES, packWindSources, windFieldClock } from 'cleo'
import type { ModelNode } from 'cleo'
import {
  ARROW_GRID, TRACER_POINTS, WIND_FIELD_OVERLAY, WIND_LUT_HEIGHT, WIND_LUT_WIDTH, LineBuffer, WindTracers,
  buildWindLut, dropWindFieldOverlay, edgeFade, ensureWindFieldOverlay, sourceGlyph, vertexLayout, windGridCentre,
  windGridSpacing, windLutUv, windOverlayWanted, writeArrow, type TracerRegion,
} from '../src/utils/windFieldOverlay'

// The wind field overlay samples the field itself, every frame, and writes three preallocated line meshes.
// These pin what it promises without a GPU: a grid that stays put in the world, arrows that say where the
// air goes and how hard, tracers that ride it, glyphs that say what each source does, and an overlay that is
// up exactly when the eye menu or the selection asks for it. The wire builder is stubbed.

const scenes: Scene[] = []
const newScene = () => { const s = new Scene(); scenes.push(s); return s }
afterEach(() => { while (scenes.length) scenes.pop()!.dispose(); windFieldClock.time = 0 })

/** A stand-in line node: the packed layout a Basic wireframe gets, and a mesh that records its uploads. */
function stubBuilder() {
  const uploads = new Map<string, Float32Array>()
  const build = (name: string) => {
    const node: any = new Node(name)
    node.vertexAttributes = ['position', 'uv']
    node.initialized = true
    node.model = { mesh: { updateVertexData: (d: Float32Array) => uploads.set(name, d.slice()) } }
    node.dispose = () => { node.disposed = true }
    return node as ModelNode
  }
  return { build, uploads }
}

function sceneWithCamera(): Scene {
  const scene = newScene()
  const cam = new CameraNode('cam', new Camera({ type: 'perspective' }))
  scene.addNode(cam)
  cam.camera.position = [0, 10, 0] as any
  cam.camera.eye = [0, 0, -10] as any
  return scene
}

describe('the grid', () => {
  it('spaces arrows by a power of two from the camera height, 1 to 16 m', () => {
    expect(windGridSpacing(0)).toBe(1)
    expect(windGridSpacing(10)).toBe(4)
    expect(windGridSpacing(30)).toBe(8)
    expect(windGridSpacing(1000)).toBe(16)
    for (const h of [2, 7, 13, 40, 77]) expect(Math.log2(windGridSpacing(h)) % 1).toBe(0)
  })

  it('holds its spacing while the camera hovers near a boundary', () => {
    const s = windGridSpacing(9.5)
    expect(windGridSpacing(11.5, s)).toBe(s)
    expect(windGridSpacing(9.0, s)).toBe(s)
    expect(windGridSpacing(30, s)).not.toBe(s)
  })

  it('is snapped to the spacing, so arrows stay put in the world as the camera moves', () => {
    const a = windGridCentre(10.3, -4.2, 0, -1, 4)
    const b = windGridCentre(10.9, -4.6, 0, -1, 4)
    expect(a[0] % 4).toBe(0)
    expect(a).toEqual(b)
    // Ahead of the camera: looking down -Z puts the centre at smaller z.
    expect(a[1]).toBeLessThan(-4.2)
  })

  it('fades out over the grid\'s outer edge', () => {
    expect(edgeFade(0, 0, 10)).toBe(1)
    expect(edgeFade(6.9, 0, 10)).toBe(1)
    expect(edgeFade(10, 3, 10)).toBe(0)
    expect(edgeFade(0, 8.5, 10)).toBeGreaterThan(0)
    expect(edgeFade(0, 8.5, 10)).toBeLessThan(1)
  })
})

describe('colour and layout', () => {
  it('reads the lookup at texel centres: speed across, opacity down', () => {
    expect(windLutUv(0, 0)).toEqual([0.5 / WIND_LUT_WIDTH, 0.5 / WIND_LUT_HEIGHT])
    expect(windLutUv(1000, 1)).toEqual([(WIND_LUT_WIDTH - 0.5) / WIND_LUT_WIDTH, (WIND_LUT_HEIGHT - 0.5) / WIND_LUT_HEIGHT])
  })

  it('the lookup ramps calm blue to gale red, transparent at the top row and opaque at the bottom', () => {
    const lut = buildWindLut()
    const px = (x: number, y: number) => Array.from(lut.slice((y * WIND_LUT_WIDTH + x) * 4, (y * WIND_LUT_WIDTH + x) * 4 + 4))
    const calm = px(0, WIND_LUT_HEIGHT - 1), gale = px(WIND_LUT_WIDTH - 1, WIND_LUT_HEIGHT - 1)
    expect(calm[2]).toBeGreaterThan(calm[0])
    expect(gale[0]).toBeGreaterThan(gale[2])
    expect(px(10, 0)[3]).toBe(0)
    expect(calm[3]).toBe(255)
  })

  it('finds position and uv in whatever layout the mesh was packed with', () => {
    expect(vertexLayout(['position', 'uv'])).toEqual({ stride: 5, position: 0, uv: 3 })
    expect(vertexLayout(['position', 'normal', 'uv'])).toEqual({ stride: 8, position: 0, uv: 6 })
    expect(vertexLayout(['position', 'normal'])).toBeNull()
    const buf = new LineBuffer(2)
    buf.bind(['position', 'normal', 'uv'])
    buf.set(1, 1, 2, 3, 0, 1)
    expect(Array.from(buf.data.slice(8, 11))).toEqual([1, 2, 3])
    expect(buf.data[8 + 4]).toBe(1)   // the normal points up
  })
})

describe('arrows', () => {
  const read = (buf: LineBuffer, i: number) => Array.from(buf.data.slice(i * 5, i * 5 + 3))

  it('point the way the air goes, centred on where it was measured, longer for faster air', () => {
    const buf = new LineBuffer(8)
    buf.bind(['position', 'uv'])
    writeArrow(buf, 0, 0, 1, 0, [4, 0, 0], 2, 1)
    writeArrow(buf, 4, 0, 1, 0, [12, 0, 0], 2, 1)
    const [tail, tip] = [read(buf, 0), read(buf, 1)]
    expect(tip[0]).toBeGreaterThan(tail[0])
    expect(tail[0] + tip[0]).toBeCloseTo(0, 9)
    expect(read(buf, 5)[0] - read(buf, 4)[0]).toBeGreaterThan(tip[0] - tail[0])
    // The barbs sit behind the tip, either side.
    expect(read(buf, 2)[0]).toBeLessThan(tip[0])
    expect(read(buf, 2)[2]).toBeCloseTo(-read(buf, 3)[2], 9)
  })

  it('still air draws nothing', () => {
    const buf = new LineBuffer(4)
    buf.bind(['position', 'uv'])
    writeArrow(buf, 0, 5, 1, 5, [0, 0, 0], 2, 1)
    for (let i = 0; i < 4; i++) {
      expect(read(buf, i)).toEqual([0, 0, 0])
      expect(buf.data[i * 5 + 4]).toBe(windLutUv(0, 0)[1])
    }
  })
})

describe('tracers', () => {
  const region: TracerRegion = { cx: 0, cz: 0, half: 40, ground: () => 0 }
  const steady = (_x: number, _y: number, _z: number, out: number[]) => { out[0] = 5; out[1] = 0; out[2] = 0; return out }

  it('are seeded: the same field always draws the same streaks', () => {
    const a = new WindTracers(16, 3), b = new WindTracers(16, 3)
    for (let i = 0; i < 30; i++) { a.step(1 / 30, steady, region); b.step(1 / 30, steady, region) }
    expect(Array.from(a.trail)).toEqual(Array.from(b.trail))
  })

  it('ride the air and leave a trail behind them', () => {
    const t = new WindTracers(1, 5)
    t.step(0, steady, region)            // seeded
    t.life[0] = 100; t.age[0] = 0
    const x0 = t.trail[0]
    for (let i = 0; i < 12; i++) t.step(0.05, steady, region)
    expect(t.trail[0] - x0).toBeCloseTo(5 * 0.6, 4)
    // Older points lag behind the head, downwind is +X.
    expect(t.trail[4]).toBeLessThan(t.trail[0])
    expect(t.trail[(TRACER_POINTS - 1) * 4]).toBeLessThanOrEqual(t.trail[4])
  })

  it('are reborn when they blow out of the area, never left stranded outside it', () => {
    const t = new WindTracers(8, 9)
    const gale = (_x: number, _y: number, _z: number, out: number[]) => { out[0] = 300; out[1] = 0; out[2] = 0; return out }
    for (let i = 0; i < 20; i++) t.step(0.1, gale, region)
    for (let i = 0; i < 8; i++) expect(Math.abs(t.trail[i * TRACER_POINTS * 4])).toBeLessThanOrEqual(region.half * 1.1)
  })

  it('stay off the ground', () => {
    const t = new WindTracers(4, 2)
    const down = (_x: number, _y: number, _z: number, out: number[]) => { out[0] = 0; out[1] = -50; out[2] = 0; return out }
    for (let i = 0; i < 10; i++) t.step(0.1, down, region)
    for (let i = 0; i < 4; i++) expect(t.trail[i * TRACER_POINTS * 4 + 1]).toBeGreaterThanOrEqual(0.3 - 1e-6)
  })
})

describe('source glyphs', () => {
  const glyphOf = (field: ForceFieldNode) => {
    field.affectsWind = true
    const out = new Float32Array(MAX_WIND_SOURCES * 16)
    packWindSources([field], out)
    return sourceGlyph(out, 0)
  }
  const len = (s: number[]) => Math.hypot(s[0], s[2])

  it('a blast\'s spokes point out, an inflow\'s in', () => {
    const blast = glyphOf(new ForceFieldNode('b', { kind: 'radial', shape: 'sphere', radius: 10, strength: -8 }))
    const inflow = glyphOf(new ForceFieldNode('i', { kind: 'radial', shape: 'sphere', radius: 10, strength: 8 }))
    // The spokes follow the 96 outline segments; each is a shaft then its two barbs.
    const shaft = (g: ReturnType<typeof sourceGlyph>) => g.segments[96]
    expect(len(shaft(blast).slice(3))).toBeGreaterThan(len(shaft(blast).slice(0, 3)))
    expect(len(shaft(inflow).slice(3))).toBeLessThan(len(shaft(inflow).slice(0, 3)))
  })

  it('every kind draws inside the segment budget, with its outline', () => {
    for (const kind of ['directional', 'radial', 'vortex', 'turbulence', 'drag'] as const) {
      const sphere = glyphOf(new ForceFieldNode(kind, { kind, shape: 'sphere', radius: 4 }))
      expect(sphere.kind).toBe(kind)
      expect(sphere.segments.length).toBeGreaterThan(96)
      expect(sphere.segments.length).toBeLessThanOrEqual(160)
      const box = glyphOf(new ForceFieldNode(kind, { kind, shape: 'box', extents: [3, 2, 3] }))
      expect(box.segments.length).toBeGreaterThan(12)
    }
  })
})

describe('when it is up', () => {
  it('follows the eye menu, or a selection that is about the wind, in a scene with wind', () => {
    const scene = newScene()
    const other = new Node('prop')
    expect(windOverlayWanted(true, null, scene)).toBe(false)         // nothing to draw
    const wind = new WindNode('wind')
    scene.addNode(wind)
    scene.addNode(other)
    expect(windOverlayWanted(true, null, scene)).toBe(true)
    expect(windOverlayWanted(false, null, scene)).toBe(false)
    expect(windOverlayWanted(false, other, scene)).toBe(false)
    expect(windOverlayWanted(false, wind, scene)).toBe(true)
    const particlesOnly = new ForceFieldNode('push')
    scene.addNode(particlesOnly)
    expect(windOverlayWanted(false, particlesOnly, scene)).toBe(false)
    particlesOnly.affectsWind = true
    expect(windOverlayWanted(false, particlesOnly, scene)).toBe(true)
  })

  it('a wind source alone (no Wind node) is enough to draw', () => {
    const scene = newScene()
    scene.addNode(new ForceFieldNode('whirl', { kind: 'vortex', affectsWind: true }))
    expect(windOverlayWanted(true, null, scene)).toBe(true)
  })

  it('builds once, writes every layer each frame, and drops cleanly', () => {
    const scene = sceneWithCamera()
    scene.addNode(new WindNode('wind', { direction: 0, strength: 1, gustiness: 0, veer: 0 }))
    const { build, uploads } = stubBuilder()
    const root = ensureWindFieldOverlay(scene, { buildWire: build, registerLut: () => {} })
    expect(ensureWindFieldOverlay(scene, { buildWire: build, registerLut: () => {} })).toBe(root)
    expect(root.children.length).toBe(3)
    windFieldClock.time = 1
    root.onUpdate(0, 0)
    const arrows = uploads.get('__debug__windfield_arrows')!
    expect(arrows.length).toBe(ARROW_GRID * ARROW_GRID * 4 * 5)
    // The middle arrow: steady 7 m/s along +X, so its tip is east of its tail and it is opaque.
    const mid = ((ARROW_GRID * ARROW_GRID - 1) / 2) * 4 * 5
    expect(arrows[mid + 5]).toBeGreaterThan(arrows[mid])
    expect(arrows[mid + 5 + 4]).toBeGreaterThan(windLutUv(0, 0.9)[1])
    expect(uploads.has('__debug__windfield_tracers')).toBe(true)
    expect(uploads.has('__debug__windfield_sources')).toBe(true)
    dropWindFieldOverlay(scene)
    expect(scene.getNodesByName(WIND_FIELD_OVERLAY).length).toBe(0)
  })
})

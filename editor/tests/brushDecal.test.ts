import { describe, it, expect, afterEach } from 'vitest'
import { DecalNode, Scene, CleoEngine, brushFalloffWeight, curveWeight, radialDecalWeight, isEditorOnlyNode } from 'cleo'
import type { SceneChange } from 'cleo'
import {
  brushDecalStyle, brushDecalBox, brushColor, strengthAlpha, lookFromSettings, brushCursorYaw,
  MIN_CENTRE_ALPHA, MAX_CENTRE_ALPHA, FOLIAGE_CENTRE_ALPHA,
} from '../src/features/landscape/brushDecal'
import type { BrushLook, BrushTerrain, BrushCurve } from '../src/features/landscape/brushDecal'
import { BrushCursor } from '../src/features/landscape/brushCursor'
import { DEFAULT_BRUSH } from '../src/features/landscape/landscapeBrushStore'

// The landscape brush cursor: the decal under the mouse must SHOW the brush — its weight curve, its
// strength, its tool — and must enclose the ground it lands on. Everything here runs headless; the
// renderer's half (projecting the pattern) is the WGSL twin of radialDecalWeight.

const T_SAMPLES = Array.from({ length: 41 }, (_, i) => i / 40)
const sculpt = (over: Partial<BrushLook> = {}): BrushLook =>
  ({ mode: 'sculpt', tool: 'raise', strength: 8, falloff: 0.5, ...over })

describe('the cursor gradient is the brush weight', () => {
  it('matches the classic soft falloff the terrain sculpts with, at every distance', () => {
    for (const falloff of [0, 0.05, 0.25, 0.5, 0.8, 1]) {
      const p = brushDecalStyle(sculpt({ falloff }))
      for (const t of T_SAMPLES)
        expect(radialDecalWeight(t, p.exponent, p.curve, p.falloff), `t=${t} f=${falloff}`)
          .toBeCloseTo(brushFalloffWeight(t, falloff), 12)
    }
  })

  it('matches curveWeight for every curve the brush offers', () => {
    const curves: BrushCurve[] = ['soft', 'smooth', 'linear', 'sphere', 'tip']
    for (const curve of curves)
      for (const falloff of [0, 0.2, 0.5, 1]) {
        const p = brushDecalStyle(sculpt({ curve, falloff }))
        for (const t of T_SAMPLES)
          expect(radialDecalWeight(t, p.exponent, p.curve, p.falloff), `${curve} t=${t} f=${falloff}`)
            .toBeCloseTo(curveWeight(t, falloff, curve), 12)
      }
  })

  it('draws foliage as the hard disc it scatters and erases in, whatever the falloff', () => {
    for (const erase of [false, true]) {
      const p = brushDecalStyle({ mode: 'foliage', tool: 'foliage', strength: 8, falloff: 0.9, erase })
      for (const t of T_SAMPLES) expect(radialDecalWeight(t, p.exponent, p.curve, p.falloff)).toBe(1)
      expect(p.innerColor[3]).toBe(FOLIAGE_CENTRE_ALPHA)
      expect(p.shape).toBe('circle')
    }
  })

  it('fades the fill out to nothing at the rim, and always draws the rim itself', () => {
    const p = brushDecalStyle(sculpt())
    expect(p.outerColor[3]).toBe(0)
    expect(p.ringColor[3]).toBeGreaterThan(0.5)
    expect(p.ringWidthPx).toBeGreaterThan(0)
    expect(p.emissive).toBe(0)
  })

  it('carries the square shape through', () => {
    expect(brushDecalStyle(sculpt({ shape: 'square' })).shape).toBe('square')
    expect(brushDecalStyle(sculpt()).shape).toBe('circle')
  })
})

describe('strength is opacity', () => {
  it('rises monotonically across the slider, inside the documented band', () => {
    let prev = -Infinity
    for (const s of [0.5, 1, 2, 5, 8, 20, 50]) {
      const a = strengthAlpha(s)
      expect(a).toBeGreaterThan(prev)
      expect(a).toBeGreaterThanOrEqual(MIN_CENTRE_ALPHA)
      expect(a).toBeLessThanOrEqual(MAX_CENTRE_ALPHA)
      prev = a
    }
    expect(strengthAlpha(0.5)).toBeCloseTo(MIN_CENTRE_ALPHA)
    expect(strengthAlpha(50)).toBeCloseTo(MAX_CENTRE_ALPHA)
    expect(strengthAlpha(1e6)).toBeCloseTo(MAX_CENTRE_ALPHA)
  })

  it('reads a strength against its OWN tool range', () => {
    // A blend tool's 0.5 of 1 and a rate tool's 5 of 50 are both "half way" on a log slider at best —
    // what matters is that the same fraction of each range gives the same opacity.
    expect(strengthAlpha(1, [0.05, 1])).toBeCloseTo(strengthAlpha(50, [0.5, 50]))
    expect(brushDecalStyle(sculpt({ strength: 20 })).innerColor[3])
      .toBeGreaterThan(brushDecalStyle(sculpt({ strength: 2 })).innerColor[3])
  })
})

describe('the tool shows in the colour', () => {
  it('gives build, dig, relax and level distinct colours, and every removal red', () => {
    const colour = (look: BrushLook) => brushColor(look).join(',')
    const kinds = ['raise', 'lower', 'smooth', 'flatten'].map(tool => colour(sculpt({ tool })))
    expect(new Set(kinds).size).toBe(4)
    const erase = colour({ mode: 'paint', tool: 'erase', strength: 0.3, falloff: 0.5 })
    expect(colour({ mode: 'paint', tool: 'clearToBase', strength: 0.3, falloff: 0.5 })).toBe(erase)
    expect(colour({ mode: 'foliage', tool: 'foliage', strength: 1, falloff: 0, erase: true })).toBe(erase)
    expect(colour({ mode: 'foliage', tool: 'foliage', strength: 1, falloff: 0 })).not.toBe(erase)
    expect(colour({ mode: 'paint', tool: 'paint', strength: 0.3, falloff: 0.5 })).not.toBe(erase)
  })

  it('still draws a tool it does not know, in the old ring yellow', () => {
    expect(brushColor(sculpt({ tool: 'someFutureTool' }))).toEqual([1, 0.9, 0.2])
  })
})

describe('the brush stores map onto a placement', () => {
  it('maps the landscape brush store, strength range included', () => {
    const look = lookFromSettings({ ...DEFAULT_BRUSH, mode: 'sculpt', sculptTool: 'smooth', curve: 'linear',
                                    shape: 'square', rotation: 30, radius: 7, strengths: { smooth: 0.8 } })
    expect(look).toMatchObject({ mode: 'sculpt', tool: 'smooth', radius: 7, strength: 0.8, curve: 'linear',
                                 shape: 'square', rotation: 30 })
    expect(look.strengthRange).toEqual([0.05, 1])
  })

  it('turns a square cursor the way the terrain turns a square brush', () => {
    // brushWeight maps a world offset into the brush frame with lx = dx·cos r + dz·sin r. A node yawed by θ
    // maps local to world with x = lx·cos θ + lz·sin θ, so θ = -r is its inverse.
    const r = 30, rad = (r * Math.PI) / 180, yaw = (brushCursorYaw(r) * Math.PI) / 180
    const [dx, dz] = [3, -1]
    const lx = dx * Math.cos(rad) + dz * Math.sin(rad), lz = -dx * Math.sin(rad) + dz * Math.cos(rad)
    // Rotate the brush-frame point back to world through the node's yaw (gl-matrix Ry convention).
    const wx = lx * Math.cos(yaw) + lz * Math.sin(yaw), wz = -lx * Math.sin(yaw) + lz * Math.cos(yaw)
    expect(wx).toBeCloseTo(dx, 12)
    expect(wz).toBeCloseTo(dz, 12)
  })
})

/** A 64 m terrain at resolution 33 whose height is an arbitrary function of terrain-local x/z. */
function terrainOf(height: (x: number, z: number) => number, origin: [number, number, number] = [0, 0, 0]): BrushTerrain {
  const size = 64, resolution = 33, e = size / (resolution - 1)
  const node = (v: number) => Math.round(v / e) * e
  return {
    origin, size, resolution,
    // Heights live on the grid nodes, bilinear between them — as Terrain.heightAt.
    heightAt: (x, z) => {
      if (Math.abs(x) > size / 2 || Math.abs(z) > size / 2) return 0
      const x0 = Math.floor(x / e) * e, z0 = Math.floor(z / e) * e
      const fx = (x - x0) / e, fz = (z - z0) / e
      const h = (a: number, b: number) => height(node(a), node(b))
      const top = h(x0, z0) + (h(x0 + e, z0) - h(x0, z0)) * fx
      const bottom = h(x0, z0 + e) + (h(x0 + e, z0 + e) - h(x0, z0 + e)) * fx
      return top + (bottom - top) * fz
    },
  }
}

function coversRelief(terrain: BrushTerrain, point: [number, number, number], radius: number, shape: 'circle' | 'square' = 'circle') {
  const box = brushDecalBox(terrain, point, radius, shape)
  const reach = shape === 'square' ? radius * Math.SQRT2 : radius
  const [ox, oy, oz] = [terrain.origin[0], terrain.origin[1], terrain.origin[2]]
  for (let i = 0; i <= 40; i++)
    for (let j = 0; j <= 40; j++) {
      const x = point[0] - reach + (2 * reach * i) / 40, z = point[2] - reach + (2 * reach * j) / 40
      if (Math.abs(x - ox) > terrain.size / 2 || Math.abs(z - oz) > terrain.size / 2) continue
      const y = oy + terrain.heightAt(x - ox, z - oz)
      expect(Math.abs(y - box.center[1]), `(${x}, ${z})`).toBeLessThan(box.height / 2)
    }
  return box
}

describe('the cursor box encloses the ground under the brush', () => {
  it('on a steep slope, which a flat box at the hit height would cut in half', () => {
    const slope = terrainOf((x) => 0.8 * x)
    const box = coversRelief(slope, [5, 4, 3], 10)
    expect(box.center[0]).toBe(5)
    expect(box.center[2]).toBe(3)
  })

  it('over bumps and a spike between coarse samples', () => {
    const bumpy = terrainOf((x, z) => 3 * Math.sin(x * 0.7) * Math.cos(z * 0.5) + (x === 6 && z === 2 ? 9 : 0))
    coversRelief(bumpy, [4, 1, 1], 8)
    coversRelief(bumpy, [4, 1, 1], 8, 'square')
  })

  it('with the landscape moved away from the origin', () => {
    coversRelief(terrainOf((x, z) => 0.3 * x - 0.2 * z, [100, 20, -50]), [104, 21, -47], 6)
  })

  it('with the brush hanging off the terrain edge', () => {
    const edge = terrainOf((x) => 0.5 * x)
    const box = coversRelief(edge, [30, 15, 0], 12)
    expect(Number.isFinite(box.height)).toBe(true)
  })

  it('pads even flat ground, so the projected surface is never on the box face', () => {
    const box = brushDecalBox(terrainOf(() => 2), [0, 2, 0], 10)
    expect(box.center[1]).toBeCloseTo(2)
    expect(box.height).toBeGreaterThanOrEqual(2)
  })
})

describe('BrushCursor', () => {
  const scenes: Scene[] = []
  afterEach(() => { while (scenes.length) scenes.pop()!.dispose() })

  /** A withoutDirty that records whether each call happened inside it. */
  function harness() {
    const scene = new Scene(); scenes.push(scene)
    let depth = 0, calls = 0
    const withoutDirty = <T,>(fn: () => T): T => { depth++; calls++; try { return fn() } finally { depth-- } }
    const events: { e: SceneChange; inside: boolean }[] = []
    const listener = (e: SceneChange) => events.push({ e, inside: depth > 0 })
    CleoEngine.eventEmitter.on('SCENE_CHANGED', listener)
    const stop = () => CleoEngine.eventEmitter.off('SCENE_CHANGED', listener)
    return { scene, cursor: new BrushCursor(scene, withoutDirty), events, calls: () => calls, stop }
  }
  const flat = terrainOf(() => 0)
  const brush = { ...sculpt(), radius: 6 }
  const decalsIn = (scene: Scene) => [...scene.decals]

  it('projects an editor-only, terrain-only radial decal sized to the brush', () => {
    const h = harness()
    try {
      h.cursor.show(flat, [1, 0, 2], brush)
      const decals = decalsIn(h.scene)
      expect(decals).toHaveLength(1)
      const d = decals[0] as DecalNode
      expect(d.name).toBe('__editor__terrainBrush')
      expect(isEditorOnlyNode(d)).toBe(true)
      expect(d.receivers).toBe('terrain')
      expect(d.pattern).toBe('radial')
      expect(d.visible).toBe(true)
      expect(d.size[0]).toBe(12)
      expect(d.size[2]).toBe(12)
      expect(d.radial).toEqual(brushDecalStyle(brush))
    } finally { h.stop() }
  })

  it('builds and shows it only inside withoutDirty, and a repeat show changes no visibility', () => {
    const h = harness()
    try {
      h.cursor.show(flat, [0, 0, 0], brush)
      const structural = h.events.filter(({ e }) => e.kind === 'structure' || e.kind === 'visibility')
      expect(structural.length).toBeGreaterThan(0)
      expect(structural.every(ev => ev.inside)).toBe(true)
      const before = h.events.length
      h.cursor.show(flat, [3, 0, 3], brush)
      h.cursor.show(flat, [4, 0, 1], brush)
      expect(h.events.slice(before).filter(({ e }) => e.kind === 'visibility')).toHaveLength(0)
      expect(decalsIn(h.scene)).toHaveLength(1)
    } finally { h.stop() }
  })

  it('hides, restyles only while shown, and disposes out of the scene', () => {
    const h = harness()
    try {
      h.cursor.show(flat, [0, 0, 0], brush)
      const d = h.cursor.node!
      h.cursor.restyle({ ...brush, radius: 9, tool: 'lower' })
      expect(d.size[0]).toBe(18)
      expect(d.radial).toEqual(brushDecalStyle({ ...brush, tool: 'lower' }))
      h.cursor.hide()
      expect(d.visible).toBe(false)
      h.cursor.restyle({ ...brush, radius: 2 })
      expect(d.size[0]).toBe(18)           // hidden: left alone until the next show
      h.cursor.dispose()
      expect(d.parent).toBe(null)
      expect(decalsIn(h.scene)).toHaveLength(0)
      h.cursor.dispose()                   // twice is harmless
    } finally { h.stop() }
  })

  it('rebuilds a cursor stranded outside the live tree', () => {
    const h = harness()
    try {
      h.cursor.show(flat, [0, 0, 0], brush)
      const first = h.cursor.node!
      h.scene.removeNode(first)             // what a root swap does to it, as far as the tree can tell
      h.cursor.show(flat, [0, 0, 0], brush)
      expect(h.cursor.node).not.toBe(first)
      expect(decalsIn(h.scene)).toHaveLength(1)
    } finally { h.stop() }
  })

  it('turns a square cursor by the brush rotation', () => {
    const h = harness()
    try {
      h.cursor.show(flat, [0, 0, 0], { ...brush, shape: 'square', rotation: 25 })
      expect(h.cursor.node!.rotation[1]).toBeCloseTo(brushCursorYaw(25))
      h.cursor.show(flat, [0, 0, 0], { ...brush, shape: 'circle', rotation: 25 })
      expect(h.cursor.node!.rotation[1]).toBeCloseTo(0)
    } finally { h.stop() }
  })
})

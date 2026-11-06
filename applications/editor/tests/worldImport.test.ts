import { describe, it, expect } from 'vitest'
import { heightsFromImage } from 'cleo/terrain/heightmapIO'
import { compositeWeights, defaultBlendRule, type TerrainBlendRule } from 'cleo/terrain/terrainLayers'
import {
  GROUND, defaultMapping, mappedSlots, mergeWeights, missingSlotLayers, neutralRule, orientPlane, parseCreatorWorldLink,
  planWorldImport, reapplyMapping, resolveTarget, ruleDeviations, ruleWarnings, serializeCreatorWorldLink, worldChanged,
  type ImportLayer, type ImportSlot, type WorldOrientation,
} from '../src/features/landscape/worldImport'
import { recordStackEdit } from '../src/features/landscape/stackHistory'

// Import world's planner: which world layer lands on which slot of the landscape material, and the masks
// that come out. The masks are pinned by composing them back the way the landscape draws them (over, in
// the material's slot order) and checking the world's weights come back -- whatever order the material
// keeps its slots in.

const layer = (id: string, index: number, kind?: string, name = id): ImportLayer => ({ id, name, index, kind })
const slot = (id: string, manual = true, rule: TerrainBlendRule = defaultBlendRule(), name = id): ImportSlot => ({ id, name, manual, rule })
const NONE: WorldOrientation = { flipX: false, flipY: false, rotate: 0 }

/** A plane from a row-major list, or filled with one value. */
const plane = (n: number, v: number | number[]) => Uint8Array.from(Array.isArray(v) ? v : new Array(n * n).fill(v))

/** The weights a set of alpha planes composites to at texel `t`, bottom to top, the Ground's alpha 1. */
function composite(alphas: Uint8Array[], t: number): number[] {
  const out: number[] = []
  compositeWeights([1, ...alphas.map(a => a[t] / 255)], out)
  return out
}

describe('orientation', () => {
  it('turns and flips a weight plane exactly as the heightmap is turned and flipped', () => {
    // On an N x N image sampled at N points, heightsFromImage hits every sample exactly: what it does to
    // the heights is a pure permutation, and the weight planes must get the same one.
    const N = 5
    const src = Uint8Array.from({ length: N * N }, (_, i) => i * 7 % 251)
    const img = { width: N, height: N, data: Float32Array.from(src, v => v / 255), bitDepth: 8 }
    for (const rotate of [0, 90, 180, 270] as const)
      for (const flipX of [false, true])
        for (const flipY of [false, true]) {
          const o = { flipX, flipY, rotate }
          const heights = heightsFromImage(img, N, { min: 0, max: 1, ...o })
          expect(Array.from(orientPlane(src, N, o)), JSON.stringify(o)).toEqual(Array.from(heights, h => Math.round(h * 255)))
        }
  })

  it('turns clockwise: the top-left corner goes to the top-right at 90°', () => {
    const src = plane(3, [255, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(Array.from(orientPlane(src, 3, { ...NONE, rotate: 90 }))).toEqual([0, 0, 255, 0, 0, 0, 0, 0, 0])
  })
})

describe('merging layers onto slots', () => {
  const slots = [slot('road'), slot('rock'), slot('auto', false)]

  it('sums layers mapped to one slot, and folds unmapped, ignored, missing and automatic targets into the Ground', () => {
    const layers = [layer('base', 0), layer('a', 1), layer('b', 2), layer('c', 3), layer('d', 4), layer('e', 5)]
    const planes = [10, 20, 30, 40, 50, 60].map(v => plane(1, v))
    const mapping = { base: GROUND, a: 'rock', b: 'rock', c: null, d: 'gone', e: 'auto' }
    const [ground, rock] = mergeWeights(layers, planes, 1, slots, mapping, [GROUND, 'rock'])
    expect(rock[0]).toBe(50)
    expect(ground[0]).toBe(10 + 40 + 50 + 60)
    expect(resolveTarget(undefined, slots)).toBe(GROUND)
    expect(resolveTarget('auto', slots)).toBe(GROUND)
    expect(mappedSlots(layers, slots, mapping)).toEqual(['rock'])
  })

  it('clamps a sum past 255 (a tool that does not quantize to exactly 255)', () => {
    const [ground] = mergeWeights([layer('a', 0), layer('b', 1)], [plane(1, 200), plane(1, 100)], 1, [], {}, [GROUND])
    expect(ground[0]).toBe(255)
  })
})

describe('planWorldImport', () => {
  it('converts in the MATERIAL\'s slot order, so the world\'s weights come back whatever order the slots are in', () => {
    // World bottom -> top: grass (base), sand, rock, snow. The material keeps them as snow, rock, sand.
    const layers = [layer('grass', 0), layer('sand', 1), layer('rock', 2), layer('snow', 3)]
    const weights = [[100, 0, 255, 30], [50, 255, 0, 60], [55, 0, 0, 90], [50, 0, 0, 75]]  // per layer, 4 texels
    const planes = weights.map(w => Uint8Array.from(w))
    const slots = [slot('s-snow'), slot('s-rock'), slot('s-sand')]
    const mapping = { grass: GROUND, sand: 's-sand', rock: 's-rock', snow: 's-snow' }
    const plan = planWorldImport({ layers, planes, size: 2, slots, mapping, orientation: NONE, maskResolution: 2 })
    expect(plan.channels.map(c => c.slotId)).toEqual(['s-snow', 's-rock', 's-sand'])
    const alphas = plan.channels.map(c => c.alpha)
    for (let t = 0; t < 4; t++) {
      // composite() is Ground, snow, rock, sand; compare against the world's weights in that order.
      const want = [weights[0][t], weights[3][t], weights[2][t], weights[1][t]].map(w => w / 255)
      const got = composite(alphas, t)
      want.forEach((w, i) => expect(got[i]).toBeCloseTo(w, 1))
    }
  })

  it('fills an undefined alpha from its neighbours instead of leaving a 0 fringe', () => {
    // Left column all "low" (a lower paint slot), right column all "high" (a slot above it). Under the
    // high slot the low slot's alpha means nothing -- nothing below shows -- and is filled from the left,
    // so filtering the masks across the boundary never blends the Ground in.
    const layers = [layer('ground', 0), layer('low', 1), layer('high', 2)]
    const planes = [plane(2, [0, 0, 0, 0]), plane(2, [255, 0, 255, 0]), plane(2, [0, 255, 0, 255])]
    const slots = [slot('low'), slot('high')]
    const plan = planWorldImport({ layers, planes, size: 2, slots, mapping: { ground: GROUND, low: 'low', high: 'high' }, orientation: NONE, maskResolution: 2 })
    const [low, high] = plan.channels.map(c => c.alpha)
    expect(Array.from(high)).toEqual([0, 255, 0, 255])
    expect(Array.from(low)).toEqual([255, 255, 255, 255])
  })

  it('orients, then resamples to the mask resolution', () => {
    const layers = [layer('ground', 0), layer('mark', 1)]
    const mark = plane(2, [255, 0, 0, 0])  // the -X/-Z corner
    const ground = plane(2, [0, 255, 255, 255])
    const plan = planWorldImport({
      layers, planes: [ground, mark], size: 2, slots: [slot('m')], mapping: { ground: GROUND, mark: 'm' },
      orientation: { ...NONE, rotate: 90 }, maskResolution: 4,
    })
    const a = plan.channels[0].alpha
    expect(plan.resolution).toBe(4)
    expect(a).toHaveLength(16)
    // Turned clockwise the marked corner is the top-right one; resampled, its texel is fully the slot.
    expect(a[0 * 4 + 3]).toBe(255)
    expect(a[3 * 4 + 0]).toBe(0)
  })

  it('writes nothing for a world mapped entirely to the Ground', () => {
    const plan = planWorldImport({ layers: [layer('a', 0), layer('b', 1)], planes: [plane(1, 128), plane(1, 127)], size: 1,
      slots: [slot('road')], mapping: {}, orientation: NONE, maskResolution: 1 })
    expect(plan.channels).toEqual([])
  })
})

describe('the default mapping', () => {
  it('matches names first (any case), puts the base on the Ground, then matches kind hints; each slot once', () => {
    const layers = [layer('l0', 0, 'grass', 'Meadow'), layer('l1', 1, 'sand', 'Beach'), layer('l2', 2, 'rock', 'ROCK'),
                    layer('l3', 3, 'rock', 'Cliff'), layer('l4', 4, 'snow', 'Snow')]
    const slots = [slot('s1', true, defaultBlendRule(), 'Rock'), slot('s2', true, defaultBlendRule(), 'Wet sand'),
                   slot('s3', false, defaultBlendRule(), 'Snow')]
    expect(defaultMapping(layers, slots)).toEqual({ l0: GROUND, l1: 's2', l2: 's1', l3: null, l4: null })
  })

  it('lets the base match a slot by name', () => {
    expect(defaultMapping([layer('g', 0, 'grass', 'Grass')], [slot('s', true, defaultBlendRule(), 'grass')])).toEqual({ g: 's' })
  })

  it('offers the ignored layers to Add missing slots, within the room there is', () => {
    const layers = [layer('a', 0), layer('b', 1), layer('c', 2), layer('d', 3)]
    const { add, overflow } = missingSlotLayers(layers, { a: GROUND, b: null, d: 'x' }, 1)
    expect(add.map(l => l.id)).toEqual(['b'])
    expect(overflow.map(l => l.id)).toEqual(['c'])
  })
})

describe('rule warnings', () => {
  const rule = (patch: (r: TerrainBlendRule) => void) => { const r = defaultBlendRule(); patch(r); return r }

  it('flags an automatic slot above an imported surface, and a mapped slot whose rule reshapes its mask', () => {
    const layers = [layer('base', 0), layer('sand', 1), layer('snow', 2)]
    const slots = [
      slot('sand'),
      slot('rocks', false),                                                     // auto, above sand and the Ground
      slot('snow', true, rule(r => { r.elevation.enabled = true; r.noise.amount = 0.3; r.opacity = 0.5; r.heightBlend = 0.2 })),
      slot('off', false, rule(r => { r.opacity = 0 })),                         // covers nothing
    ]
    const warnings = ruleWarnings(layers, slots, { base: GROUND, sand: 'sand', snow: 'snow' })
    expect(warnings).toEqual([
      { slotId: 'rocks', name: 'rocks', kind: 'above', detail: ['Ground', 'sand'] },
      { slotId: 'snow', name: 'snow', kind: 'rule', detail: ['elevation', 'noise', 'opacity', 'height blend'] },
    ])
  })

  it('leaves an automatic slot alone when nothing imported is under it', () => {
    const layers = [layer('a', 0), layer('b', 1)]
    const slots = [slot('auto', false), slot('b')]
    // Every layer on a slot above the automatic one: the Ground takes no weight.
    expect(ruleWarnings(layers, slots, { a: 'b', b: 'b' })).toEqual([])
  })

  it('resets a rule to pass the mask through, keeping the authored numbers', () => {
    const r = rule(r => { r.slope = { enabled: true, min: 20, max: 50, falloff: 3 }; r.noise.amount = 1; r.opacity = 0.2; r.heightBlend = 0.9 })
    const n = neutralRule(r)
    expect(ruleDeviations(n)).toEqual([])
    expect(n.slope).toEqual({ enabled: false, min: 20, max: 50, falloff: 3 })
    expect(r.slope.enabled).toBe(true)  // a copy
  })
})

describe('the __creatorWorld variable', () => {
  it('reads the old <id>@<revision> form', () => {
    expect(parseCreatorWorldLink('world_ab12@7')).toEqual({ id: 'world_ab12', revision: 7 })
  })

  it('round-trips the JSON form', () => {
    const link = { id: 'w1', revision: 3, exportHash: 'h9', mapping: { a: GROUND, b: 'slot_x', c: null },
                   orientation: { flipX: true, flipY: false, rotate: 270 as const }, matchSize: false }
    expect(parseCreatorWorldLink(serializeCreatorWorldLink(link))).toEqual(link)
  })

  it('rejects anything else', () => {
    for (const v of [undefined, '', 'nope', '{"id": 3}', '{broken', 12]) expect(parseCreatorWorldLink(v)).toBeNull()
  })

  it('offers a re-apply by export hash when both sides have one, by revision otherwise', () => {
    const link = { id: 'w', revision: 3, exportHash: 'a' }
    expect(worldChanged(link, { id: 'w', revision: 9, exportHash: 'a' })).toBe(false)  // a preview-only edit
    expect(worldChanged(link, { id: 'w', revision: 3, exportHash: 'b' })).toBe(true)
    expect(worldChanged({ id: 'w', revision: 3 }, { id: 'w', revision: 4, exportHash: 'b' })).toBe(true)
    expect(worldChanged({ id: 'w', revision: 3 }, { id: 'w', revision: 3 })).toBe(false)
    expect(worldChanged(link, { id: 'other', revision: 9 })).toBe(false)
  })

  it('re-applies with the stored mapping, giving layers the world gained since their default', () => {
    const layers = [layer('a', 0), layer('b', 1, 'sand', 'Sand'), layer('new', 2, undefined, 'Road')]
    const slots = [slot('s-sand', true, defaultBlendRule(), 'Sand'), slot('s-road', true, defaultBlendRule(), 'road')]
    expect(reapplyMapping({ a: GROUND, b: null }, layers, slots)).toEqual({ a: GROUND, b: null, new: 's-road' })
  })
})

describe('one undo step for heights and masks', () => {
  it('saves the height field with the mapped channels and puts both back', () => {
    // A stand-in stack holding one channel as a plain array, and a terrain holding the heights.
    let mask = [0, 0, 0, 0]
    const stack = {
      masks: { capacity: 4, fullRegion: () => ({}), readPatch: (channel: number) => ({ channel, data: mask.slice() }) },
      snapshotLayers: () => ({}), restoreLayers: () => {},
      writeMaskPatches: (patches: { data: number[] }[]) => { for (const p of patches) mask = p.data.slice() },
    }
    const terrain: any = { heights: Float32Array.from([1, 2, 3, 4]), layerStack: stack, refreshLayers: () => {} }
    const scene: any = { getNodeById: () => ({ terrain }) }
    const entries: any[] = []
    const put = (t: any, h: Float32Array) => { t.heights = h.slice() }
    recordStackEdit({ scene, nodeId: 'n', label: 'Import world', push: e => entries.push(e), notify: () => {}, channels: [0], heights: put },
      (_s, t: any) => { t.heights = Float32Array.from([9, 9, 9, 9]); mask = [255, 255, 0, 0]; return true })
    expect(entries).toHaveLength(1)
    entries[0].undo()
    expect(Array.from(terrain.heights)).toEqual([1, 2, 3, 4])
    expect(mask).toEqual([0, 0, 0, 0])
    entries[0].redo()
    expect(Array.from(terrain.heights)).toEqual([9, 9, 9, 9])
    expect(mask).toEqual([255, 255, 0, 0])
  })
})

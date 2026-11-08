// The arena: a firing range built only from the engine's primitives (boxes, cylinders, ramps) in flat PBR
// materials, so the whole game can later move to another set. What a level has to bring is small and all of it
// optional: Spawn Points, Cover Points (templates), a nav mesh. Everything else is dressing.
//
//   - a 100 m asphalt yard inside a 6 m wall
//   - a raised deck in the middle (two ramps, a rail, four pillars)
//   - shipping containers (one stacked), jersey barriers, crate stacks, barrels, pillars
//   - flood-light towers (spot lights the volumetric fog lights up)
//
// `arenaLevel()` returns the nodes and the places the scene puts spawns and cover on.

import { group, material, node, pbr, prop, stableId, vars } from './kit.mjs'

const UV = { uvProjection: 'box', uvSpace: 'world', uvWorldSize: 3 }

export const MAT = {
  asphalt: material('level:asphalt', 'Asphalt', pbr([0.17, 0.175, 0.18], { roughness: 0.96, uv: { ...UV, uvWorldSize: 5 } })),
  concrete: material('level:concrete', 'Concrete', pbr([0.44, 0.44, 0.42], { roughness: 0.92, uv: UV })),
  darkConcrete: material('level:dark-concrete', 'Dark Concrete', pbr([0.25, 0.255, 0.26], { roughness: 0.94, uv: UV })),
  steel: material('level:steel', 'Steel', pbr([0.5, 0.52, 0.55], { metallic: 0.85, roughness: 0.5 })),
  red: material('level:container-red', 'Container Red', pbr([0.42, 0.07, 0.05], { metallic: 0.55, roughness: 0.55 })),
  blue: material('level:container-blue', 'Container Blue', pbr([0.06, 0.15, 0.36], { metallic: 0.55, roughness: 0.55 })),
  olive: material('level:container-olive', 'Container Olive', pbr([0.17, 0.22, 0.1], { metallic: 0.55, roughness: 0.55 })),
  wood: material('level:wood', 'Crate Wood', pbr([0.38, 0.26, 0.15], { roughness: 0.88 })),
  hazard: material('level:hazard', 'Hazard Yellow', pbr([0.85, 0.62, 0.04], { roughness: 0.7 })),
  barrel: material('level:barrel', 'Barrel', pbr([0.12, 0.17, 0.34], { metallic: 0.5, roughness: 0.55 })),
  lamp: material('level:lamp', 'Lamp Housing', pbr([0.9, 0.88, 0.8], { emissive: [1, 0.95, 0.8], emissiveIntensity: 2, castShadow: false })),
}

let pieces = 0
const piece = (prefix) => `${prefix}:${pieces++}`

/** The arena. `scale` 1 is the full yard; the minimal scene asks for a small one. */
export function arenaLevel({ half = 50, deck = true, dressing = true } = {}) {
  pieces = 0
  const level = []
  const spawns = [], covers = [], lamps = []
  const add = (n) => { level.push(n); return n }
  const box = (name, x, y, z, sx, sy, sz, mat, rotation = [0, 0, 0], extra = {}) =>
    add(prop(piece('box'), name, 'box', mat, { position: [x, y, z], scale: [sx, sy, sz], rotation, solid: true, ...extra }))
  const cyl = (name, x, y, z, r, h, mat) =>
    add(prop(piece('cyl'), name, 'cylinder', mat, { position: [x, y, z], scale: [r * 2, h, r * 2], solid: true }))
  /** A cover marker `d` metres off a thing, on the side `yaw` faces away from. */
  const cover = (x, z) => covers.push([x, 0, z])

  // ----- the yard and its wall
  box('Ground', 0, -0.25, 0, half * 2, 0.5, half * 2, MAT.asphalt)
  const wall = half + 0.5
  box('Wall North', 0, 3, wall, half * 2 + 2, 6, 1, MAT.darkConcrete)
  box('Wall South', 0, 3, -wall, half * 2 + 2, 6, 1, MAT.darkConcrete)
  box('Wall East', wall, 3, 0, 1, 6, half * 2 + 2, MAT.darkConcrete)
  box('Wall West', -wall, 3, 0, 1, 6, half * 2 + 2, MAT.darkConcrete)
  // A hazard stripe along the foot of the north wall, and one painted lane: dressing the level reads against.
  add(prop(piece('stripe'), 'Hazard Stripe', 'box', MAT.hazard, { position: [0, 0.01, half - 0.6], scale: [half * 2, 0.02, 0.5] }))
  add(prop(piece('lane'), 'Lane Line', 'box', MAT.concrete, { position: [0, 0.01, 0], scale: [0.25, 0.02, half * 1.6] }))

  // ----- the deck
  if (deck) {
    const top = 3.2
    box('Deck', 0, top - 0.3, 0, 22, 0.6, 22, MAT.concrete)
    for (const [sx, sz] of [[-9.5, -9.5], [9.5, -9.5], [-9.5, 9.5], [9.5, 9.5]]) cyl('Deck Pillar', sx, (top - 0.6) / 2, sz, 0.7, top - 0.6, MAT.darkConcrete)
    // Two ramps, on the north and south sides: 14 degrees.
    const run = 13, rise = top, len = Math.hypot(run, rise), tilt = Math.atan2(rise, run) * 180 / Math.PI
    box('Ramp South', 0, rise / 2 - 0.15, -(11 + run / 2), 6, 0.4, len, MAT.concrete, [tilt, 0, 0])
    box('Ramp North', 0, rise / 2 - 0.15, 11 + run / 2, 6, 0.4, len, MAT.concrete, [-tilt, 0, 0])
    // Rails: low walls round the deck's edge, open at the ramps.
    for (const side of [-1, 1]) {
      box('Deck Rail Side', side * 10.8, top + 0.55, 0, 0.4, 1.1, 22, MAT.steel)
      for (const end of [-1, 1]) {
        box('Deck Rail End', side * 6.9, top + 0.55, end * 10.8, 8.4, 1.1, 0.4, MAT.steel)
      }
    }
    // Cover on the deck.
    box('Deck Crate', -5, top + 0.6, -3, 1.2, 1.2, 1.2, MAT.wood, [0, 20, 0])
    box('Deck Crate', 4.5, top + 0.6, 4, 1.6, 1.2, 1.2, MAT.wood, [0, -15, 0])
    box('Deck Block', 0, top + 0.5, 0, 3.6, 1, 1.2, MAT.darkConcrete)
    cover(-5, -3.8); cover(4.5, 3.2); cover(0, 1)
    lamps.push([-9.5, top, -9.5], [9.5, top, 9.5])
  }

  if (!dressing) {
    box('Crate A', 10, 0.6, 8, 1.2, 1.2, 1.2, MAT.wood, [0, 12, 0]); cover(10, 7)
    box('Crate B', -9, 0.6, -6, 1.6, 1.2, 1.6, MAT.wood, [0, -20, 0]); cover(-9, -7)
    box('Barrier', -2, 0.55, 12, 4, 1.1, 0.6, MAT.concrete); cover(-2, 11.5)
    return { level, spawns: [[-14, 0, -14, 45], [14, 0, 14, -135], [-14, 0, 14, 135], [14, 0, -14, -45]], covers, lamps }
  }

  // ----- containers: four around the deck, one stacked
  const containers = [
    ['Container', -28, 0, 14, MAT.red, 0], ['Container', 28, 0, -14, MAT.blue, 0],
    ['Container', 16, 0, 30, MAT.olive, 90], ['Container', -16, 0, -30, MAT.red, 90],
    ['Container', -33, 0, -10, MAT.olive, 20], ['Container', 34, 0, 12, MAT.red, -12],
  ]
  for (const [name, x, , z, mat, yaw] of containers) {
    box(name, x, 1.3, z, 2.5, 2.6, 12, mat, [0, yaw, 0])
    const r = yaw * Math.PI / 180
    // Cover on both long sides.
    cover(x + Math.cos(r) * 2.4, z - Math.sin(r) * 2.4)
    cover(x - Math.cos(r) * 2.4, z + Math.sin(r) * 2.4)
  }
  box('Container (top)', -28, 3.9, 14, 2.5, 2.6, 12, MAT.blue, [0, 0, 0])

  // ----- jersey barriers: short walls in lines and elbows
  const barriers = [
    [-12, -22, 0], [-7, -22, 0], [-2, -22, 0], [8, 22, 0], [13, 22, 0], [18, 22, 0],
    [-36, 28, 90], [-36, 33, 90], [-36, 38, 90], [38, -30, 90], [38, -25, 90],
    [-22, 4, 90], [-22, 9, 90], [24, -4, 90], [24, -9, 90],
  ]
  for (const [x, z, yaw] of barriers) {
    box('Barrier', x, 0.55, z, 4.4, 1.1, 0.6, MAT.concrete, [0, yaw, 0])
    const r = yaw * Math.PI / 180
    cover(x + Math.sin(r) * 0.9 + Math.cos(r) * 0, z + Math.cos(r) * 0.9)
  }

  // ----- crate stacks
  const stacks = [[-20, -14], [22, 16], [4, -34], [-4, 36], [38, 34], [-40, 12], [36, -42], [-34, -38]]
  stacks.forEach(([x, z], i) => {
    box('Crate', x, 0.6, z, 1.2, 1.2, 1.2, MAT.wood, [0, i * 37 % 90, 0])
    box('Crate', x + 1.3, 0.6, z + 0.2, 1.2, 1.2, 1.2, MAT.wood, [0, i * 21 % 60, 0])
    if (i % 2 === 0) box('Crate', x + 0.6, 1.8, z + 0.1, 1.2, 1.2, 1.2, MAT.wood, [0, 12 + i * 9, 0])
    cover(x + 0.6, z + 1.4)
    cover(x + 0.6, z - 1.0)
  })

  // ----- barrels and pillars
  const barrels = [[-8, 30], [-6.8, 30.9], [30, -2], [31.2, -1.2], [-26, -26], [14, -14], [-14, 16], [44, 4]]
  for (const [x, z] of barrels) cyl('Barrel', x, 0.45, z, 0.3, 0.9, MAT.barrel)
  for (const [x, z] of [[-24, 24], [24, -24], [-24, -2], [30, 24]]) {
    cyl('Pillar', x, 2.5, z, 0.8, 5, MAT.darkConcrete)
    cover(x + 1, z)
  }

  // ----- flood-light towers
  for (const [x, z] of [[-44, -44], [44, -44], [-44, 44], [44, 44]]) {
    cyl('Light Pole', x, 4.5, z, 0.18, 9, MAT.steel)
    add(prop(piece('lamphead'), 'Light Head', 'box', MAT.lamp, { position: [x, 9.1, z], scale: [1.2, 0.35, 0.5] }))
    lamps.push([x, 8.8, z])
  }

  // ----- spawn points on a ring of radius 40, facing the middle
  const ring = []
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8
    const x = Math.round(Math.sin(a) * 41 * 10) / 10, z = Math.round(Math.cos(a) * 41 * 10) / 10
    ring.push([x, 0, z, Math.round(Math.atan2(-x, -z) * 180 / Math.PI)])
  }
  spawns.push(...ring)
  return { level, spawns, covers, lamps }
}

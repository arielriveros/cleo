// Where everything in the dungeon goes: the numbers, in one place, read off the structure's floor plans.
//
// Conventions: metres, Y up, the structure's own frame (the glb is placed at the origin), north = -Z. Yaw is
// degrees about +Y and turns a prop's FRONT (+Z, see props.mjs) to face that way: 0 faces south (+Z), 90
// east (+X), 180 north, -90 west. A prop against a wall faces away from it.
//
// The rooms, and the walls they are measured from (the light rig hangs every sconce 0.46 m off its wall):
//   Entry hall      x -6..6, z -8..8, floor 0. Six pillars at x ±3, z -5 / 0 / 5. Doors north and east.
//   Cell corridor   x ±1.25, z -8.3..-20.3; three barred cells each side (x 1.75..5.5, bands of 3 m).
//   Cell room       x -3..3, z -20.3..-26.
//   East corridor   x 6.3..18.3, z ±1.25; the crypt off it to the south (x 10..14, z 1.6..7).
//   Great hall      x 18.6..32.6, z -8..8, nine metres high; a wooden gallery over its east third
//                   (x 26.6..32.6 at 4.5), reached by a stair along the north wall; fireplace in the south wall.
//   South rooms     x 26.6..32.6, z 8.6..14.6, one under the other (floors 0 and 4.5).
//   Stair hall      x 24.6..36.6, z -24..-8.3; eight pillars (x 27.75 / 33.4, z -21 / -17.6 / -14.35 / -11.1).
//   The stair       x 37.2..39.2, from z -16 (floor 0) down to z -23.4 (floor -6); a guard room beside its
//                   foot (x 39.5..43.2, z -24..-15), and the arena's door at z -24.3.
//   Arena hall      x 28..52, z -50..-24.6, floor -6; the round arena (centre 40, -37.3, radius 7.75) one
//                   step up at -5.4; the throne on its dais at z -45.5..-49.2; an oculus over it all.
//   Catacombs       a corridor x 16..27.5 at z -37.3 off the arena hall's west wall, to the ossuary
//                   (x 10.6..15.3, z -40.4..-34).

/** The structure's own glb, and the edits that make it walkable (see structure.mjs, doorways). */
export const STRUCTURE_FILE = 'medieval_dungeon_structure (1).glb'
/** A pillar stands square in front of the catacombs' door on the arena side: it goes. */
export const REMOVE_PIECES = [{ part: 'Pillars', box: [[28.3, -6.3, -38.4], [30.5, 12, -36.3]] }]

/** The lights of the file's rig that are NOT fixtures to dress: sconces on cell bars or behind a pillar. */
export const SKIP_LIGHTS = new Set([12, 58, 68])
/** Metres: the closest two wall torches may hang. The rig's sconces come every few metres. */
export const SCONCE_SPACING = 9

export const SPAWN = { position: [0, 0.05, 6.4], yaw: 180 }

/** The way back up: a ladder on the entry hall's south wall, up to a hatch in the ceiling. */
export const LADDER = { position: [0, 0, 7.95], yaw: 180, ceiling: 4.18 }

export const BONFIRE = { position: [0, 0, -2.5], yaw: 0 }

/** Fires that are not torches: what the rig's other lights stand for. */
export const FIRES = [
  // The rig's hanging lights: an iron cage with a fire in it, chained to the ceiling.
  { kind: 'brazier', key: 'entry', position: [0, 2.7, 0], chainTo: 4.2 },
  { kind: 'brazier', key: 'hall', position: [23, 5.0, 0], chainTo: 9 },
  { kind: 'firePit', key: 'stair-hall-n', position: [30.6, 0, -12.6] },
  { kind: 'firePit', key: 'stair-hall-s', position: [30.6, 0, -19.3] },
  { kind: 'firePit', key: 'guard-room', position: [41.4, -6, -18.8] },
  { kind: 'hearth', key: 'fireplace', position: [22.6, 0.1, 7.4] },
  // Two of the arena's braziers, on opposite corners, and two either side of the throne: tall torches.
  ...[[44.53, -32.77], [35.47, -41.83]].map(([x, z], i) =>
    ({ kind: 'torch', key: `arena-${i}`, position: [x, -5.38, z], scale: 1.25 })),
  { kind: 'torch', key: 'throne-w', position: [37, -6, -45.9], scale: 1.25 },
  { kind: 'torch', key: 'throne-e', position: [43, -6, -45.9], scale: 1.25 },
  // Candles: two of the crypt's corners, the catacombs, the ossuary, and one on each room's table.
  ...[[10.4, 0, 2.4], [13.5, 0, 6.5], [22.3, -6, -36.9], [11.2, -6, -34.6]]
    .map((position, i) => ({ kind: 'candle', key: `floor-${i}`, position })),
  ...[[5.4, 0.82, 2.0], [0.1, 0.82, -23.5], [22.4, 0.82, 2.65], [31.0, 5.32, 6.9]]
    .map((position, i) => ({ kind: 'candle', key: `table-${i}`, position })),
]

/**
 * Moonlight through the windows and the oculus: the rig's spots, as cool shafts. Their range is what reaches
 * the floor below (13 m from the high windows, 14 from the oculus), not the rig's 22-30 m: a spot is lit
 * wherever its cone's bounding sphere reaches, and a long one makes every pixel of a hall pay for it.
 */
export const SHAFTS = { lumens: 4400, oculusLumens: 21500, range: 18, oculusRange: 20 }

// ---------------------------------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------------------------------

/** A weapon on a rack's board: upright, a hand in front of the wall. */
const hang = (weapon, [x, y, z], yaw) => ({ model: weapon, position: [x, y, z], yaw, pose: 'upright' })
/** A weapon lying on the floor. */
const lie = (weapon, [x, y, z], yaw) => ({ model: weapon, position: [x, y, z], yaw, pose: 'lying' })
/** A rack on the wall at `at` (its back on the wall) with two weapons hanging from it. */
const rack = (at, yaw, [a, b]) => {
  const r = yaw * Math.PI / 180
  const along = [Math.cos(r), -Math.sin(r)], out = [Math.sin(r), Math.cos(r)]
  const spot = (s) => [at[0] + along[0] * s + out[0] * 0.13, at[1] - 0.38, at[2] + along[1] * s + out[1] * 0.13]
  return [{ model: 'rack', position: at, yaw }, hang(a, spot(-0.45), yaw), hang(b, spot(0.45), yaw)]
}

export const PROPS = [
  // ----- entry hall -----
  { model: 'table', position: [5.45, 0, 2.5], yaw: 90, size: 'short' },
  { model: 'barrel', position: [-5.4, 0, 7.2], yaw: 30 }, { model: 'barrel', position: [-4.7, 0, 7.45], yaw: 110 },
  { model: 'barrel', position: [-5.45, 0, 6.4], yaw: 200 },
  { model: 'crate', position: [-5.35, 0, 4.4], yaw: 8 }, { model: 'crate', position: [-5.35, 0.7, 4.4], yaw: -6 },
  { model: 'crate', position: [-5.3, 0, 3.5], yaw: 20 },
  // the west cell
  { model: 'bench', position: [-5.65, 0, -5.6], yaw: 90 }, { model: 'crate', position: [-4.2, 0, -7.35], yaw: 30 },
  lie('axe', [-4.6, 0.03, -4.4], 40),
  // ----- the cells off the corridor (seen through their bars) -----
  { model: 'cage', position: [-3.6, 0, -10.0], yaw: 20 },
  { model: 'bench', position: [-5.15, 0, -13.1], yaw: 90 }, { model: 'crate', position: [-2.4, 0, -12.4], yaw: 10 },
  { model: 'coldFire', position: [-3.6, 0, -16.25], yaw: 0 },
  { model: 'barrel', position: [5.0, 0, -9.1], yaw: 0 }, { model: 'barrel', position: [4.3, 0, -8.95], yaw: 70 },
  { model: 'barrel', position: [5.05, 0, -9.9], yaw: 140 },
  { model: 'cage', position: [3.6, 0, -13.1], yaw: -15 },
  { model: 'bench', position: [5.15, 0, -16.25], yaw: -90 }, lie('saber', [3.3, 0.02, -15.4], 70),
  // ----- cell room -----
  { model: 'table', position: [0, 0, -23.4], yaw: 0 },
  { model: 'bench', position: [0, 0, -22.65], yaw: 0 }, { model: 'bench', position: [0, 0, -24.15], yaw: 0 },
  { model: 'bookcase', position: [-2.64, 0, -23.3], yaw: 90 },
  ...rack([0, 1.6, -26.0], 0, ['mace', 'hammer']),
  // ----- great hall -----
  { model: 'table', position: [22.6, 0, -2.6], yaw: 0 }, { model: 'table', position: [22.6, 0, 2.6], yaw: 0 },
  { model: 'bench', position: [22.6, 0, -3.4], yaw: 0 }, { model: 'bench', position: [22.6, 0, -1.8], yaw: 0 },
  { model: 'bench', position: [22.6, 0, 1.8], yaw: 0 }, { model: 'bench', position: [22.6, 0, 3.4], yaw: 0 },
  { model: 'bookcase', position: [18.96, 0, -6.0], yaw: 90 }, { model: 'bookcase', position: [18.96, 0, 6.0], yaw: 90 },
  { model: 'barrel', position: [20.3, 0, 7.4], yaw: 15 }, { model: 'barrel', position: [19.55, 0, 7.5], yaw: 95 },
  { model: 'crate', position: [24.8, 0, 7.45], yaw: 4 },
  ...rack([32.6, 1.6, -1.6], -90, ['axe', 'saber']), ...rack([32.6, 1.6, 1.6], -90, ['mace', 'hammer']),
  { model: 'crate', position: [31.9, 0, 6.9], yaw: 3 }, { model: 'crate', position: [31.95, 0.7, 6.9], yaw: -8 },
  { model: 'crate', position: [32.0, 0, 5.95], yaw: 12 }, { model: 'barrel', position: [31.95, 0, -6.6], yaw: 50 },
  // the gallery over it
  { model: 'bookcase', position: [32.24, 4.5, -5.0], yaw: -90 }, { model: 'bookcase', position: [32.24, 4.5, 5.0], yaw: -90 },
  { model: 'table', position: [31.0, 4.5, 6.9], yaw: 90, size: 'short' },
  { model: 'bench', position: [31.95, 4.5, 0], yaw: -90 },
  { model: 'barrel', position: [31.9, 4.5, -7.2], yaw: 0 }, { model: 'crate', position: [31.2, 4.5, -7.5], yaw: 16 },
  // ----- south rooms -----
  { model: 'crate', position: [32.0, 0, 14.0], yaw: 0 }, { model: 'crate', position: [32.0, 0.7, 14.0], yaw: 9 },
  { model: 'crate', position: [31.15, 0, 14.1], yaw: 15 },
  { model: 'barrel', position: [27.3, 0, 14.0], yaw: 0 }, { model: 'barrel', position: [28.1, 0, 14.2], yaw: 60 },
  { model: 'barrel', position: [27.2, 0, 13.2], yaw: 120 }, { model: 'cage', position: [31.9, 0, 11.0], yaw: 30 },
  { model: 'bookcase', position: [32.24, 4.5, 12.6], yaw: -90 },
  { model: 'bookcase', position: [28.4, 4.5, 14.24], yaw: 180 }, { model: 'bookcase', position: [30.6, 4.5, 14.24], yaw: 180 },
  { model: 'table', position: [31.6, 4.5, 9.6], yaw: 90, size: 'short' }, { model: 'bench', position: [30.75, 4.5, 9.6], yaw: 90, size: 'short' },
  // ----- stair hall -----
  ...rack([24.6, 1.6, -12.1], 90, ['axe', 'mace']), ...rack([24.6, 1.6, -16.3], 90, ['hammer', 'saber']),
  ...rack([24.6, 1.6, -20.5], 90, ['axe', 'hammer']),
  { model: 'crate', position: [25.1, 0, -23.5], yaw: 0 }, { model: 'crate', position: [25.1, 0.7, -23.5], yaw: 11 },
  { model: 'crate', position: [25.9, 0, -23.55], yaw: -7 }, { model: 'barrel', position: [26.65, 0, -23.6], yaw: 0 },
  { model: 'barrel', position: [36.1, 0, -8.85], yaw: 0 }, { model: 'barrel', position: [35.4, 0, -8.8], yaw: 80 },
  { model: 'cage', position: [35.9, 0, -20.0], yaw: 5 },
  // ----- the guard room at the stair's foot -----
  { model: 'bench', position: [42.85, -6, -18.8], yaw: -90 },
  { model: 'crate', position: [42.75, -6, -15.5], yaw: 0 }, { model: 'crate', position: [42.75, -5.3, -15.5], yaw: 14 },
  { model: 'barrel', position: [40.0, -6, -15.45], yaw: 0 }, { model: 'barrel', position: [40.7, -6, -15.4], yaw: 45 },
  // ----- arena hall -----
  { model: 'cage', position: [29.0, -6, -25.6], yaw: 10 }, { model: 'cage', position: [51.0, -6, -25.6], yaw: -20 },
  { model: 'cage', position: [29.0, -6, -49.0], yaw: 40 }, { model: 'cage', position: [51.0, -6, -49.0], yaw: 0 },
  lie('saber', [35.0, -5.97, -29.0], 30), lie('axe', [45.5, -5.97, -45.5], -60),
  lie('mace', [32.0, -5.97, -40.0], 100), lie('hammer', [48.5, -5.97, -33.0], 10),
  // ----- ossuary -----
  { model: 'rock', variant: 2, position: [11.0, -6, -39.9], yaw: 40 }, { model: 'rock', variant: 3, position: [14.85, -6, -34.5], yaw: 200 },
  { model: 'rock', variant: 0, position: [10.9, -6, -36.6], yaw: 120 },
]

/** Breakable barrels (the valley's template): hit one or roll through it. */
export const BREAKABLES = [
  [-5.3, 0, -0.9], [-4.6, 0, -1.5], [5.2, 0, -6.8], [4.4, 0, -7.3], [8.2, 0, 0.8], [25.2, 0, -9.0], [36.0, 0, -23.4],
  [32.0, 0, -6.0], [28.0, 0, 7.3], [32.0, 0, 9.4], [40.1, -6, -16.4], [30.2, -6, -49.0], [49.8, -6, -49.0],
]

// ---------------------------------------------------------------------------------------------------
// Play
// ---------------------------------------------------------------------------------------------------

export const ENEMIES = [
  ['hollow-a', 'Spawn Hollow A', [0, 0, -12.5], 0, 'Hollow'],
  ['hollow-b', 'Spawn Hollow B', [0, 0, -18.0], 0, 'Hollow'],
  ['hollow-c', 'Spawn Hollow C', [25.5, 0, -0.5], -90, 'Hollow'],
  ['hollow-d', 'Spawn Hollow D', [24.5, 0, 5.5], -120, 'Hollow'],
  ['caster', 'Spawn Sorcerer', [28.6, 4.5, -2.0], -90, 'Hollow Sorcerer'],
  ['knight', 'Spawn Elite Knight', [30.6, 0, -16.0], 0, 'Elite Knight'],
  ['hollow-e', 'Spawn Hollow E', [41.4, -6, -21.6], 0, 'Hollow'],
  ['hollow-f', 'Spawn Hollow F', [41.0, -6, -16.8], 180, 'Hollow'],
  ['hollow-g', 'Spawn Hollow G', [21.0, -6, -37.3], 90, 'Hollow'],
  ['hollow-h', 'Spawn Hollow H', [12.6, -6, -37.8], 90, 'Hollow'],
]
export const BOSS = { position: [40, -5.4, -41.5], yaw: 0 }

/** The fog across the arena's door, its +Z into the arena; narrowed to the doorway. */
export const FOG_GATE = { position: [38.4, -6, -24.3], yaw: 180, scale: [0.42, 0.85, 1] }
/** Walking in here starts the fight: the hall inside the fog. */
export const ARENA_ZONE = { position: [40, -6, -37.5], size: [22, 6, 23] }

export const PICKUPS = [
  ['jailer-souls', 'Jailer Souls', [2.2, 0, -21.2], { kind: 'souls', amount: 400, itemName: 'Soul of a Jailer' }],
  ['hall-souls', 'Hall Souls', [31.6, 0, 3.6], { kind: 'souls', amount: 300, itemName: 'Soul of a Lost Undead' }],
  ['estus-shard', 'Estus Shard', [28.4, 4.5, 12.4], { kind: 'flaskShard', amount: 1, itemName: 'Estus Shard' }],
  ['ossuary-souls', 'Ossuary Souls', [13.6, -6, -36.0], { kind: 'souls', amount: 1000, itemName: 'Soul of an Old Hand' }],
  ['boss-reward', 'Boss Reward', [40, -5.4, -37.3], { kind: 'souls', amount: 4000, itemName: 'Soul of the Hollow Warden', hiddenUntilRevealed: true }],
]

export const MESSAGES = [
  ['dungeon-welcome', 'The Dungeon', 'Below the skull, the old keep\'s dungeon.\nRest at the bonfire. The ladder behind you climbs back to the valley.', [1.2, 0, 3.4], 180],
  ['crypt', 'A warden of old', 'Candles still burn for him.\nWhoever lights them has not been seen.', [12, 0, 0.6], 0],
  ['stair', 'Down the stair', 'The keeper waits below.\nIts halberd reaches far: roll inside the swing.', [35.2, 0, -13.4], 90],
  ['warden', 'The Hollow Warden', 'Beyond the fog waits the keeper of this place.\nWhen it bleeds, it rages.', [38.4, -6, -22.6], 180],
]
export const EPILOGUE = { position: [40, -5.4, -44.2], yaw: 0 }

// ---------------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------------

/** Every one of these must be reachable on foot from the spawn, props and all (asserted by the generator). */
export const REACH = {
  'cell room': [0, 0, -24.8], crypt: [12, 0, 1.0], 'great hall': [25, 0, 0], gallery: [29, 4.5, 0], 'south room': [29.6, 0, 12],
  'upper south room': [29.6, 4.5, 12], 'stair hall': [30.6, 0, -16], 'stair foot': [38.2, -6, -23.6], 'guard room': [41.4, -6, -21.6],
  arena: [40, -5.4, -37.3], 'arena hall': [36, -6, -30], catacombs: [20, -6, -37.3], ossuary: [12.5, -6, -38.2], bonfire: [0, 0, -4.2],
  'fog gate': [38.4, -6, -25.4],
}

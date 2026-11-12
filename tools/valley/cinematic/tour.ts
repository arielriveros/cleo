// The Valley Tour: the cinematic the Valley's start menu plays (examples/scripts/ValleyStartMenu.ts).
//
// Written as SHOTS — camera paths through points placed by hand on the valley's own layout (layout.mjs),
// each point with what the camera looks at as it passes — and turned into a sequence (src/sequencer/types.ts)
// by `buildTour`, against the shipped terrain: heights are given above the ground and resolved here, and
// every path is lifted wherever its curve would dip below the clearance.
//
// The shot list follows the plan (C:\Users\ariel\.claude\plans\plan-a-suggested-route-replicated-quiche.md):
//   I    The Valley   campfire, main road, the hamlet, Old House, Granary; then the meadow and the forest  (10:00)
//   II   Light        the Long House from outside, then inside in the afternoon sun (13:40 -> 15:45), the
//                     night falling on the hamlet, and the same house by candlelight  (20:30 -> 21:30)
//   III  Weather      night, dawn, the windmill, the gate notch, back over the valley  (game time x2)
//   IV   Water        across the pond, then up over the whole valley
// Times are sequence seconds on the GAME clock, so Act III, run at time scale 2, takes half as long. Shots
// have durations and follow one another; everything else on the timeline is placed `when(shot, seconds)`, so
// retiming a shot carries its captions, keys and fades with it.

import { Spline3, evaluateKeyedNumber } from '../../../src/core/math'
import type { SequenceData, SequenceKey, SequenceTrack } from '../../../src/sequencer/types'

/** A height above the ground (`h`) or an absolute one (`y`), at x/z. */
type At = { x: number, z: number, h?: number, y?: number }
interface Point extends At { look: At }
interface ShotSpec {
  key: string
  label: string
  /** Seconds on the game clock. */
  dur: number
  points: Point[]
  /** Ease in and out at the ends of the move (default both). */
  ease?: [boolean, boolean]
  /** Lowest the camera may go above the ground on this shot (default 1.2 m). */
  clearance?: number
  /** Inside the Long House: measured against its walls, not the ground (INTERIOR_SHOTS). */
  inside?: boolean
}
export interface Shot extends ShotSpec { start: number, end: number }

/** The Long House's interior frame: centre, and the axes its walls run along (the house is turned -137.51°). */
const LONG_HOUSE = { x: -9, z: 39, yaw: -137.51, floor: 2.69 }
const lh = (lx: number, lz: number, y = LONG_HOUSE.floor + 1.6): At => {
  const a = LONG_HOUSE.yaw * Math.PI / 180
  // Local +Z (the long axis) is (sin, cos); local +X is (cos, -sin).
  return { x: LONG_HOUSE.x + Math.cos(a) * lx + Math.sin(a) * lz, z: LONG_HOUSE.z - Math.sin(a) * lx + Math.cos(a) * lz, y }
}
const at = (x: number, z: number, h: number): At => ({ x, z, h })
const p = (x: number, z: number, h: number, look: At): Point => ({ x, z, h, look })
const py = (where: At, look: At): Point => ({ ...where, look })

/** The middle of the Long House's aisle, in its frame (see the interior shot). */
const AISLE_X = -1.65

const SHOT_LIST: ShotSpec[] = [
  // ---- I: The Valley -----------------------------------------------------------------------------------
  {
    key: 'valley', label: 'The Valley', dur: 30, ease: [true, false],
    points: [
      p(-6.5, 89, 1.7, at(-6.5, 79, 1)),          // behind the campfire, low
      p(-7.5, 85, 4, at(-8, 60, 3)),
      p(-10, 78, 9, at(-20, 52, 4)),               // up, and along the main road
      p(-16, 66, 10, at(-30, 44, 4)),
      p(-24, 55, 12, at(-38, 34, 3)),              // the hamlet's well
      p(-40, 58, 14, at(-38, 34, 3)),
      p(-58, 54, 14, at(-52, 37, 4)),              // the Old House
      p(-73, 40, 13, at(-78, 53, 4)),              // the Granary
    ],
  },
  {
    // A cut to the meadow: low through the grass while it thins out and fills in again, then up and back
    // over the western grove, turning to look east across the whole valley floor, every tree and bush of it
    // in view, while their draw distance closes in to the nearest and opens out again (FOLIAGE below).
    key: 'foliage', label: 'Meadow and forest', dur: 22, ease: [true, true],
    points: [
      p(-62, 16, 2.4, at(-50, -2, 0.8)),
      p(-53, 3, 2.4, at(-48, -14, 1.2)),           // low over the meadow
      p(-50, -12, 4, at(-40, -30, 2)),
      p(-64, -30, 22, at(0, -20, 2)),              // up over the grove, turning east
      p(-92, -46, 34, at(30, -8, 0)),              // the whole valley floor ahead
    ],
  },
  // ---- II: Light ---------------------------------------------------------------------------------------
  {
    key: 'approach', label: 'The Long House', dur: 10, ease: [true, true],
    points: [p(-34, 30, 7, at(-9, 39, 4)), p(-27, 35, 5, at(-9, 39, 4)), p(-22, 40, 4, at(-9, 39, 4))],
  },
  {
    // A cut inside (the doors are gaps in the walls, too narrow to fly through), in the early afternoon, when the
    // sun still reaches the house: from about 15:30 the western ridge (32-34° high) shades it. Until then the sun
    // comes in through the +X wall's door (local z -0.8..0.8), laying a patch on the middle room's floor that
    // the GI volume bounces round the rooms, and through thin slots under the +X windows' eaves. The dolly
    // comes down the aisle and turns to that patch while the hour runs on (HOUR_KEYS), until the ridge's shadow
    // takes it and the room is left to the bounce.
    // Read off the render mesh at camera height: the floor at 2.69 and the ceiling at 6.6; end walls at z -9.4
    // and 8.6; the long -X wall's inner face at x -3.03; and two cross walls, at z -3.25 and 2.9, reaching in
    // from the +X wall only as far as x -0.25. That leaves an aisle x -3.03..-0.25 through all three rooms: the
    // dolly keeps to its middle, about 1.3 m from every wall (tests/valleyProject.test.ts measures it against
    // the house's triangles).
    key: 'interior', label: 'Long House interior', dur: 30, ease: [true, true], inside: true,
    points: [py(lh(AISLE_X, -6.5, 4.2), lh(-1.0, 3, 3.6)), py(lh(AISLE_X, -3.0, 4.2), lh(1.4, 0.8, 3.0)),
             py(lh(AISLE_X, 0.0, 4.2), lh(1.6, 0.0, 2.9)), py(lh(AISLE_X, 2.2, 4.2), lh(1.8, -0.6, 2.9))],
  },
  {
    key: 'night', label: 'Night falls', dur: 10, ease: [true, true],
    points: [p(-20, 46, 3, at(-38, 34, 2)), p(-26, 52, 6, at(-38, 34, 2))],
  },
  {
    // The same house at night, lit by its candles (interiorProps.ts CANDLES): the GI carries their light round
    // the rooms and the interior's exposure opens up to it, as the cut in from the dark street shows. Down the
    // aisle from the middle room, past the low table's pair and the rug, into the kitchen and its table's three.
    key: 'candles', label: 'Candlelight', dur: 14, ease: [true, true], inside: true,
    points: [py(lh(AISLE_X, -1.8, 4.0), lh(1.4, 2.3, 3.25)), py(lh(AISLE_X, 1.0, 4.0), lh(1.4, 4.6, 3.4)),
             py(lh(AISLE_X, 3.8, 3.9), lh(1.55, 6.1, 3.5))],
  },
  // ---- III: Weather (time x2) --------------------------------------------------------------------------
  {
    key: 'night-crane', label: 'Night over the hamlet', dur: 20, ease: [true, true],
    points: [p(-28, 64, 20, at(-38, 34, 3)), p(-36, 58, 45, at(-38, 34, 3))],
  },
  {
    // Low before the Long House's door side: the house, then a slow push and tilt up past its roof into the sky
    // over the eastern rim (the farthest, so the most sky), half the frame by the end, while the clouds gather.
    key: 'cloudy', label: 'Clouds gather', dur: 40, ease: [true, true],
    points: [p(-30.9, 55, 2, { x: 34.2, z: -2.7, y: 28 }), p(-24.6, 56, 2.6, { x: 35.9, z: -0.9, y: 48 })],
  },
  {
    // The first rain on the buildings: from the main road north of the Long House, across it to the Old House.
    // As the ground darkens and the puddles fill (WEATHER_KEYS), the camera comes down the trail to a metre over
    // it at the well square, looking across the puddles to the Old House and its fence: their reflections
    // (screen-space) in the water, the raindrops' rings on it.
    key: 'drizzle', label: 'First rain', dur: 30, ease: [true, true], clearance: 0.9,
    points: [p(-17, 61, 4, at(-26, 40, 4)), p(-23, 55, 3.6, at(-31, 38, 2.5)), p(-28.5, 48, 2.2, at(-38, 35, 1.0)),
             p(-31.2, 42.5, 1.1, at(-44, 34, 0.6))],
  },
  {
    key: 'storm', label: 'Storm at the windmill', dur: 50, ease: [true, true],
    points: [p(5, -8, 9, at(30, -26, 5)), p(30, -26, 13, at(59, -45, 10)), p(44, -28, 15, at(59, -45, 10)),
             p(66, -28, 16, at(59, -45, 10)), p(78, -48, 15, at(59, -45, 10))],
  },
  {
    key: 'snow', label: 'Rain turns to snow', dur: 40, ease: [true, true],
    // West over the northern forest, looking across it and down the valley. The gate notch comes next, from
    // inside it: from out here it is a narrow cut in a cliff, all rock.
    points: [p(55, -75, 30, at(10, -70, 4)), p(32, -88, 26, at(-15, -60, 4)), p(8, -95, 22, at(-35, -45, 4))],
  },
  {
    key: 'melt', label: 'Snow melts', dur: 30, ease: [true, true],
    points: [p(-3, -128, 3, at(-10, 0, 10)), p(4, -118, 8, at(-10, 0, 10))],
  },
  {
    key: 'clearing', label: 'The sky clears', dur: 30, ease: [true, true],
    points: [p(30, -70, 55, at(-10, 20, 0)), p(40, -30, 48, at(-10, 20, 0))],
  },
  // ---- IV: Water ---------------------------------------------------------------------------------------
  {
    // Low across the water toward the windmill: reflections show at a grazing angle, not looking down.
    key: 'pond', label: 'The pond', dur: 25, ease: [true, true], clearance: 0.8,
    points: [p(40, 34, 1, at(59, -45, 10)), p(43, 29, 0.9, at(59, -45, 10)), p(46, 25, 0.9, at(59, -45, 10))],
  },
  {
    // The crane up over the valley, a fade to black, and the Cleo logo and wordmark on it (LOGO_KEYS).
    key: 'finale', label: 'The whole valley', dur: 24, ease: [true, false],
    points: [p(47, 23, 1.2, at(10, 10, 4)), p(58, 52, 30, at(0, 0, 0)), p(64, 90, 85, at(0, 0, 0))],
  },
]

/** The shots on the timeline, each starting where the one before it ends. */
export const SHOTS: Shot[] = (() => {
  let t = 0
  return SHOT_LIST.map(s => { const shot = { ...s, start: t, end: t + s.dur }; t = shot.end; return shot })
})()

export const TOUR_DURATION = SHOTS[SHOTS.length - 1].end
/** The path sections inside the Long House (their ids), which the tests hold to its walls rather than the ground. */
export const INTERIOR_SHOTS = SHOT_LIST.filter(s => s.inside).map(s => `shot:${s.key}`)

/** `dt` seconds into shot `key`. */
export function when(key: string, dt = 0): number {
  const shot = SHOTS.find(s => s.key === key)
  if (!shot) throw new Error(`no shot "${key}"`)
  return shot.start + dt
}
/** `dt` seconds before shot `key` ends. */
export const before = (key: string, dt = 0): number => when(key, SHOTS.find(s => s.key === key)!.dur - dt)

/** Points of interest every tour must pass near (the coverage test reads these). */
export const SECTIONS: { name: string, x: number, z: number }[] = [
  { name: 'Campfire', x: -6.5, z: 79 }, { name: 'Main road', x: -18, z: 64 }, { name: 'Long House', x: -9, z: 39 },
  { name: 'Hamlet well', x: -38, z: 34 }, { name: 'Old House', x: -52, z: 37 }, { name: 'Granary', x: -78, z: 53 },
  { name: 'Western forest', x: -60, z: -40 }, { name: 'Pond', x: 44, z: 22 }, { name: 'Windmill', x: 59, z: -45 },
  { name: 'Side road', x: 30, z: -26 }, { name: 'Gate notch', x: 0, z: -130 },
]

// ---- the overlay and the clock ---------------------------------------------------------------------------

/** Keys over a section, from absolute (sequence) times. */
const keysFrom = (start: number, keys: [number, SequenceKey['v'], SequenceKey['interp']?][]): SequenceKey[] =>
  keys.map(([t, v, interp]) => ({ t: t - start, v, ...(interp ? { interp } : {}) }))

/** An opacity that fades in at `a`, holds, and fades out by `b`. */
const pulse = (a: number, b: number, fade = 1): [number, number, 'linear'][] =>
  [[a, 0, 'linear'], [a + fade, 1, 'linear'], [b - fade, 1, 'linear'], [b, 0, 'linear']]

const TITLES = (): [number, number, string][] => [
  [when('valley', 2), when('valley', 8), 'The Valley'],
]

/** The Cleo logo and wordmark, faded in on the final black and held to the end. */
const LOGO_KEYS = (): [number, number, SequenceKey['interp']][] => [
  [0, 0, 'linear'], [before('finale', 6.5), 0, 'linear'], [before('finale', 5), 1, 'linear'], [TOUR_DURATION, 1, 'linear'],
]
const CAPTIONS = (): [number, number, string][] => [
  [when('valley', 9), when('valley', 15), 'I  ·  The Valley'],
  [when('foliage', 1), when('foliage', 9), 'Foliage density  ·  100%  →  10%  →  100%'],
  [when('foliage', 12), when('foliage', 21), 'Draw distance  ·  trees 450 m  →  70 m  →  450 m'],
  [when('approach', 2), when('approach', 8), 'II  ·  Light'],
  [when('interior', 2), when('interior', 12), 'Dynamic global illumination: the sunlight through the door bounces round the room'],
  [when('candles', 2), when('candles', 11), 'At night, candlelight: the GI carries it round the room, and the eye adapts to it'],
  [when('night-crane', 2), when('night-crane', 10), 'III  ·  Weather  ·  time ×2'],
  [when('cloudy', 3), when('cloudy', 13), 'Clouds gather'],
  [when('drizzle', 3), when('drizzle', 13), 'First rain'],
  [when('drizzle', 17), when('drizzle', 28), 'Wet ground and puddles: screen-space reflections, raindrop ripples'],
  [when('storm', 4), when('storm', 14), 'Storm'],
  [when('snow', 4), when('snow', 14), 'Rain turns to snow'],
  [when('melt', 3), when('melt', 13), 'The snow melts'],
  [when('clearing', 3), when('clearing', 13), 'Clear again'],
  [when('pond', 2), when('pond', 10), 'IV  ·  Water  ·  screen-space reflections'],
]

/**
 * The hour of day across the tour: Act I at ten; Act II from a quarter past one, the interior running on to
 * 15:45 so the ridge's shadow takes the sunlit patch, then, behind a fade, the night; a new day for Act III.
 */
const HOUR_KEYS = (): [number, number, SequenceKey['interp']][] => [
  [0, 10, 'constant'], [when('approach'), 13.25, 'linear'], [when('interior'), 13.65, 'linear'],
  [before('interior', 1), 15.75, 'constant'], [when('night'), 20.5, 'linear'], [when('night-crane'), 23, 'linear'],
  // Midnight to dawn behind the fade (FADE_KEYS): one jump, rather than hours of sky re-bakes.
  [when('night-crane', 14.9), 23.9, 'constant'], [when('night-crane', 15), 6.5, 'linear'], [when('cloudy'), 7, 'linear'],
  [when('drizzle'), 9, 'linear'], [when('pond'), 14, 'linear'], [TOUR_DURATION, 16.5, 'linear'],
]

/**
 * Black over the two jumps in the hour (afternoon to night, midnight to dawn), a dip either side of the
 * candlelit interior (the street to the house and back), and over the very end.
 */
const FADE_KEYS = (): [number, number, SequenceKey['interp']][] => [
  [0, 1, 'linear'], [1.5, 0, 'linear'],
  [before('interior', 1.2), 0, 'linear'], [before('interior', 0.2), 1, 'linear'],
  [when('night', 0.6), 1, 'linear'], [when('night', 1.8), 0, 'linear'],
  [before('night', 0.8), 0, 'linear'], [before('night', 0.1), 1, 'linear'], [when('candles', 0.4), 1, 'linear'], [when('candles', 1.4), 0, 'linear'],
  [before('candles', 0.8), 0, 'linear'], [before('candles', 0.1), 1, 'linear'], [when('night-crane', 0.3), 1, 'linear'], [when('night-crane', 1.3), 0, 'linear'],
  [when('night-crane', 11), 0, 'linear'], [when('night-crane', 14), 1, 'linear'],
  [when('night-crane', 16), 1, 'linear'], [when('night-crane', 19), 0, 'linear'],
  [before('finale', 9), 0, 'linear'], [before('finale', 7), 1, 'linear'], [TOUR_DURATION, 1, 'linear'],
]

// ---- the environment -------------------------------------------------------------------------------------
//
// Act III's weather, as the user asked for it: a clear day and a clear night (Acts I and II), clouds
// gathering, the first light rain, a storm with wind and heavy rain, the rain turning to snow, the snow
// stopping and melting into a wet valley, and a clear day again, all at time x2. The clouds and the wind blend
// from preset to preset (Preset tracks: each blend starts where the last one ended); the Weather node's rain,
// snow, wetness and puddles are keyed (one 'mixed' volume: its snow share turns the rain into snow); and the
// Time of Day's `overcast` greys the light, thickens the mist and dims the sky's fill with the clouds.

type Keys = [number, number, SequenceKey['interp']?][]
/** Keys that ease linearly through every point: `[time, value]` pairs on the tour's clock. */
const ramp = (points: [number, number][]): Keys => points.map(([t, v]) => [t, v, 'linear'])

/** The clouds' presets: clear for Acts I and II (a starry night), then the weather's sky. */
const CLOUD_PRESETS = (): [number, number, string][] => [
  [0, 1.5, 'clear'],                                    // behind the opening fade
  [when('cloudy'), when('cloudy', 15), 'partlyCloudy'],
  [when('cloudy', 18), when('cloudy', 38), 'overcast'],
  [when('drizzle'), when('drizzle', 14), 'rainy'],
  [when('storm'), when('storm', 16), 'stormy'],
  [when('snow', 2), when('snow', 20), 'overcast'],
  [when('melt', 4), when('melt', 26), 'partlyCloudy'],
  [when('clearing', 2), when('clearing', 26), 'clear'],
]

/** The wind's: its own breeze until the rain, a storm's gale, and a calm for the clear day and the pond. */
const WIND_PRESETS = (): [number, number, string][] => [
  [when('drizzle'), when('drizzle', 20), 'windy'],
  [when('storm'), when('storm', 14), 'storm'],
  [when('snow', 4), when('snow', 24), 'breezy'],
  [when('clearing'), when('clearing', 24), 'calm'],
]

/** The Weather node, keyed. */
const WEATHER_KEYS = (): Record<string, Keys> => ({
  precipitationRate: ramp([[0, 0], [when('drizzle', 2), 0], [when('drizzle', 8), 0.3], [when('storm'), 0.3], [when('storm', 12), 1],
                           [when('snow'), 1], [when('snow', 10), 0.6], [when('melt'), 0.6], [when('melt', 8), 0]]),
  precipitationSnowShare: ramp([[0, 0], [when('snow', 4), 0], [when('snow', 28), 1]]),
  // The drizzle soaks the hamlet and fills its puddles by the time the camera is down among them.
  wetness: ramp([[0, 0], [when('drizzle', 2), 0], [when('drizzle', 16), 0.9], [when('storm'), 0.95], [when('storm', 12), 1],
                 [when('melt'), 1], [when('melt', 4), 0.9], [when('clearing'), 0.9], [when('clearing', 28), 0.3]]),
  puddles: ramp([[0, 0], [when('drizzle', 4), 0], [when('drizzle', 18), 1], [when('storm', 24), 1],
                 [when('snow', 10), 1], [when('snow', 35), 0.7], [when('melt'), 0.7], [when('melt', 20), 0.85],
                 [when('clearing'), 0.85], [when('clearing', 28), 0.2]]),
  // A trace of snow from the first frame, behind the opening fade: the landscape bakes its snow layer then,
  // not when the snow starts falling in the middle of a shot.
  snow: ramp([[0, 0.001], [when('snow', 8), 0.001], [when('snow', 38), 0.8], [when('melt', 2), 0.8], [when('melt', 24), 0.001]]),
})

/** How overcast the Time of Day draws the light: with the clouds, a storm's at the storm. */
const OVERCAST_KEYS = (): Keys => ramp([
  [0, 0], [when('cloudy', 5), 0], [when('cloudy', 38), 0.5], [when('drizzle', 14), 0.7], [when('storm'), 0.7], [when('storm', 15), 1],
  [when('snow', 20), 0.8], [when('melt', 26), 0.5], [when('clearing', 2), 0.5], [when('clearing', 26), 0],
])

/**
 * The foliage shot's layers: the grass and undergrowth thin out; the trees' and bushes' draw distance closes
 * in (the trees' 450 m to 70 m, the bushes' 90 m to 14 m) and opens out again.
 */
export const GRASS_LAYERS = ['Meadow Grass A', 'Meadow Grass B', 'Tall Grass', 'Forest Undergrowth A', 'Forest Undergrowth B']
export const TREE_LAYERS = ['Spruce A', 'Spruce B', 'Highland Spruce', 'Oak', 'Shrub A', 'Shrub B', 'Juniper', 'Boxwood']
/** Seconds into the foliage shot: the grass while the camera is low, the distances once it looks out. */
const GRASS_DENSITY: Keys = ramp([[0.5, 1], [3.5, 0.1], [6, 0.1], [8.5, 1]])
const TREE_CULL: Keys = ramp([[13, 1], [15.5, 0.15], [17.5, 0.15], [21, 1]])
const FOLIAGE_SHADOWS: Keys = ramp([[13, 110], [15.5, 30], [17.5, 30], [21, 110]])

/**
 * The storm's lightning: the director's `lightning` (examples/scripts/ValleyTourDirector.ts) over most of the
 * storm shot, with its seed and number of strikes.
 */
const LIGHTNING = () => ({ start: when('storm', 5), end: before('storm', 3), args: [7, 8] })
/**
 * Splashes on the pond as the camera comes over it, before it calms: [time, x, z] (the pond's Water Splash), a few
 * metres ahead of it on the water, where a splash the size of a step reads.
 */
const SPLASHES = (): [number, number, number][] => [[when('pond', 1.2), 41.6, 27.9], [when('pond', 2.4), 43.6, 26.4], [when('pond', 3.4), 40.2, 25.6]]

// ---- build -----------------------------------------------------------------------------------------------

type HeightAt = (x: number, z: number) => number

/** The pond's surface (the Pond Water model's top, layout.mjs POND): the camera's floor over the water. */
const POND = { x: 44, z: 22, r: 10.5, level: 0.47 }

/** What a camera must stay above: the terrain, or the pond's surface where the pond is. */
export function groundWith(heightAt: HeightAt): HeightAt {
  return (x, z) => {
    const h = heightAt(x, z)
    return Math.hypot(x - POND.x, z - POND.z) < POND.r ? Math.max(h, POND.level) : h
  }
}

/** The arc-length fraction of the spline at each control point (sampled finely, by nearest approach). */
function fractionsAt(spline: Spline3, points: number[][]): number[] {
  const samples = 2000, out: number[] = []
  let from = 0
  for (const q of points) {
    let best = from, bestD = Infinity
    for (let i = from; i <= samples; i++) {
      const s = spline.pointAt(i / samples)
      const d = Math.hypot(s[0] - q[0], s[1] - q[1], s[2] - q[2])
      if (d < bestD) { bestD = d; best = i }
    }
    out.push(best / samples)
    from = best
  }
  return out
}

/** Sequence time (section seconds) at which progress reaches `u`, by bisection on the monotone curve. */
function timeAtProgress(progress: { keys: SequenceKey[] }, span: number, u: number): number {
  let lo = 0, hi = span
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2
    if (evaluateKeyedNumber(progress as any, mid) < u) lo = mid; else hi = mid
  }
  return (lo + hi) / 2
}

function resolve(a: At, heightAt: HeightAt): [number, number, number] {
  return [a.x, a.y ?? heightAt(a.x, a.z) + (a.h ?? 0), a.z]
}

/** A shot's camera points, lifted until the whole curve clears the ground by the shot's clearance. */
function cameraPoints(shot: Shot, heightAt: HeightAt): number[][] {
  const pts = shot.points.map(q => resolve(q, heightAt))
  const clearance = shot.clearance ?? 1.2
  for (let pass = 0; pass < 40; pass++) {
    const spline = new Spline3(pts)
    const fr = fractionsAt(spline, pts)
    let worst = 0, worstU = 0
    const steps = Math.max(50, Math.ceil(spline.length))
    for (let i = 0; i <= steps; i++) {
      const s = spline.pointAt(i / steps)
      const deficit = heightAt(s[0], s[2]) + clearance - s[1]
      if (deficit > worst) { worst = deficit; worstU = i / steps }
    }
    if (worst <= 0.01) break
    // Lift the two control points either side of the lowest spot.
    let k = fr.findIndex(f => f >= worstU)
    if (k < 0) k = pts.length - 1
    for (const j of [k - 1, k]) if (j >= 0 && j < pts.length && shot.points[j].y === undefined) pts[j][1] += worst + 0.2
  }
  return pts
}

export function buildTour(terrainAt: HeightAt, options: { pondLevel?: number } = {}): SequenceData {
  const heightAt = groundWith(terrainAt)
  const pondLevel = options.pondLevel ?? terrainAt(44, 22)
  const pathSections = SHOTS.map(shot => {
    const span = shot.end - shot.start
    const [easeIn, easeOut] = shot.ease ?? [true, true]
    const pts = cameraPoints(shot, heightAt)
    const looks = shot.points.map(q => resolve(q.look, heightAt))
    // Progress along the path: flat (eased) where the shot eases, constant speed where it does not.
    const progress = { keys: [
      { t: 0, v: 0, interp: easeIn ? 'auto' as const : 'linear' as const },
      ...(easeIn && easeOut ? [] : [{ t: span * (easeIn ? 0.75 : 0.25), v: easeIn ? 0.75 : 0.25, interp: 'linear' as const }]),
      { t: span, v: 1 },
    ] }
    // The look target rides its own spline, reaching each point's target when the camera passes the point.
    const camFractions = fractionsAt(new Spline3(pts), pts)
    const lookSpline = new Spline3(looks)
    const lookFractions = fractionsAt(lookSpline, looks)
    const lookKeys = camFractions.map((u, i) => ({ t: timeAtProgress(progress, span, u), v: lookFractions[i] }))
      .filter((k, i, all) => i === 0 || k.t > all[i - 1].t + 1e-3)
    const round = (v: number) => Math.round(v * 1000) / 1000
    return {
      id: `shot:${shot.key}`, label: shot.label, start: shot.start, end: shot.end,
      points: pts.map(q => q.map(round)),
      progress,
      look: { mode: 'path', points: looks.map(q => q.map(round)), progress: { keys: lookKeys.map(k => ({ t: round(k.t), v: round(k.v) })) } },
    }
  })

  const D = TOUR_DURATION
  const property = (id: string, slot: string | null, path: string, valueType: string, keys: SequenceKey[],
                    extra: Record<string, unknown> = {}): SequenceTrack => ({
    id, type: 'property', ...(slot ? { slot } : { target: 'game' }), path, valueType,
    sections: [{ id: `${id}:all`, start: 0, end: D, curve: { keys } }], ...extra,
  } as any)
  const textKeys = (items: [number, number, string][]) =>
    [{ t: 0, v: '' }, ...items.map(([a, , s]) => ({ t: a, v: s }))] as SequenceKey[]
  const pulses = (items: [number, number, string][]) =>
    [{ t: 0, v: 0, interp: 'linear' as const }, ...items.flatMap(([a, b]) => pulse(a, b).map(([t, v, i]) => ({ t, v, interp: i })))] as SequenceKey[]
  const presets = (id: string, name: string, slot: string, items: [number, number, string][]): SequenceTrack => ({
    id, name, type: 'preset', slot,
    sections: items.map(([start, end, preset], i) => ({ id: `${id}:${i}`, start, end, preset, label: preset })),
  })
  /** A Foliage track over the foliage shot, its channels keyed in seconds into the shot. */
  const foliage = (id: string, name: string, layers: string[], channels: Record<string, { keys: SequenceKey[] }>): SequenceTrack => ({
    id, name, type: 'foliage', slot: 'landscape', layers,
    sections: [{ id: `${id}:shot`, start: when('foliage'), end: before('foliage'), whenFinished: 'restore', ...channels }],
  } as any)

  const tracks: SequenceTrack[] = [
    { id: 'camera', name: 'Camera', type: 'path', slot: 'camera', sections: pathSections } as any,
    { id: 'cut', name: 'Camera cut', type: 'cameraCut', sections: [{ id: 'cut:all', start: 0, end: D, slot: 'camera' }] },
    property('clock-running', 'clock', 'running', 'bool', [{ t: 0, v: false }]),
    property('clock-hour', 'clock', 'hour', 'number', keysFrom(0, HOUR_KEYS())),
    // Act III runs at twice the game speed: the weather's changes, the rain and the clouds in half the time.
    { id: 'time-scale', name: 'Time scale', type: 'property', target: 'game', path: 'timeScale', valueType: 'number',
      sections: [{ id: 'time-scale:weather', start: when('night-crane'), end: when('pond'), whenFinished: 'restore',
        curve: { keys: keysFrom(when('night-crane'), [
          [when('night-crane'), 1, 'linear'], [when('night-crane', 3), 2, 'linear'],
          [before('clearing', 3), 2, 'linear'], [when('pond'), 1, 'linear']]) } }] } as any,
    property('bar-top', 'barTop', 'opacity', 'number', keysFrom(0, [[0, 0, 'linear'], [1.5, 1, 'linear']])),
    property('bar-bottom', 'barBottom', 'opacity', 'number', keysFrom(0, [[0, 0, 'linear'], [1.5, 1, 'linear']])),
    property('fade', 'fade', 'opacity', 'number', keysFrom(0, FADE_KEYS())),
    property('title-text', 'title', 'text', 'string', textKeys(TITLES())),
    property('title-opacity', 'title', 'opacity', 'number', pulses(TITLES())),
    property('caption-text', 'caption', 'text', 'string', textKeys(CAPTIONS())),
    property('caption-opacity', 'caption', 'opacity', 'number', pulses(CAPTIONS())),
    property('logo-opacity', 'logo', 'opacity', 'number', keysFrom(0, LOGO_KEYS())),
    property('wordmark-opacity', 'wordmark', 'opacity', 'number', keysFrom(0, LOGO_KEYS())),

    // ---- the environment ----
    presets('clouds-presets', 'Clouds', 'clouds', CLOUD_PRESETS()),
    presets('wind-presets', 'Wind', 'wind', WIND_PRESETS()),
    ...Object.entries(WEATHER_KEYS()).map(([path, keys]) =>
      property(`weather-${path}`, 'weather', path, 'number', keysFrom(0, keys))),
    property('clock-overcast', 'clock', 'overcast', 'number', keysFrom(0, OVERCAST_KEYS())),
    // The foliage shot: the grass thins out and fills in again, then the forest's draw distance closes in to
    // the nearest trees and opens out again, and the trees' shadows reach only as far.
    foliage('foliage-grass', 'Grass density', GRASS_LAYERS, { density: { keys: keysFrom(0, GRASS_DENSITY) } }),
    foliage('foliage-trees', 'Draw distance', TREE_LAYERS, { cull: { keys: keysFrom(0, TREE_CULL) } }),
    { id: 'foliage-shadows', name: 'Foliage shadow distance', type: 'property', target: 'renderer', path: 'foliageShadowDistance',
      valueType: 'number', sections: [{ id: 'foliage-shadows:shot', start: when('foliage'), end: before('foliage'), whenFinished: 'restore',
        curve: { keys: keysFrom(0, FOLIAGE_SHADOWS) } }] } as any,
    // The pond: its ripples calm to a mirror, and screen-space reflections reach the windmill and the hamlet.
    { id: 'pond-waves', name: 'Pond calm', type: 'property', slot: 'pond', path: 'model.material.properties.waveStrength',
      valueType: 'number', sections: [{ id: 'pond-waves:shot', start: when('pond'), end: D, whenFinished: 'restore',
        curve: { keys: keysFrom(when('pond'), ramp([[when('pond'), 0.32], [when('pond', 4), 0.08], [when('finale', 4), 0.08], [when('finale', 12), 0.32]])) } }] } as any,
    { id: 'pond-ssr', name: 'Reflection reach', type: 'property', target: 'renderer', path: 'ssrMaxDistance',
      valueType: 'number', sections: [{ id: 'pond-ssr:shot', start: when('pond'), end: D, whenFinished: 'restore',
        curve: { keys: [{ t: 0, v: 400 }] } }] } as any,

    // ---- the director and the spawns ----
    { id: 'lightning', name: 'Lightning', type: 'script',
      sections: [{ id: 'lightning:storm', label: 'Lightning', method: 'lightning', ...LIGHTNING() }] } as any,
    { id: 'pond-splashes', name: 'Pond splashes', type: 'spawn',
      sections: SPLASHES().map(([t, x, z], i) => ({
        id: `pond-splash:${i}`, label: 'Splash', start: t, end: t + 1.5, template: 'Water Splash', name: 'Splash',
        position: [x, Math.round(pondLevel * 1000) / 1000, z],
      })) } as any,
  ]

  return {
    version: 1, name: 'Valley Tour', duration: D, fps: 30, clock: 'game', loop: false,
    slots: [
      { id: 'camera', name: 'Camera', nodeType: 'camera', path: 'Cinematic/Cinematic Camera' },
      { id: 'clock', name: 'Time of Day', path: 'Time of Day' },
      { id: 'barTop', name: 'Letterbox top', nodeType: 'uiPanel' },
      { id: 'barBottom', name: 'Letterbox bottom', nodeType: 'uiPanel' },
      { id: 'fade', name: 'Fade', nodeType: 'uiPanel' },
      { id: 'title', name: 'Title', nodeType: 'uiText' },
      { id: 'caption', name: 'Caption', nodeType: 'uiText' },
      { id: 'logo', name: 'Logo', nodeType: 'uiImage' },
      { id: 'wordmark', name: 'Wordmark', nodeType: 'uiText' },
      { id: 'clouds', name: 'Clouds', nodeType: 'volumetricClouds', path: 'volumetric clouds' },
      { id: 'wind', name: 'Wind', nodeType: 'wind', path: 'Wind' },
      { id: 'weather', name: 'Weather', nodeType: 'weather', path: 'Weather' },
      { id: 'landscape', name: 'Landscape', nodeType: 'landscape', path: 'Landscape' },
      { id: 'pond', name: 'Pond', nodeType: 'model', path: 'Water/Pond Water' },
    ],
    tracks,
    markers: [
      { t: 0, name: 'I · The Valley' }, { t: when('approach'), name: 'II · Light' },
      { t: when('night-crane'), name: 'III · Weather' }, { t: when('pond'), name: 'IV · Water' },
    ],
  }
}

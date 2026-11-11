// The Valley Tour: the cinematic the Valley's start menu plays (examples/scripts/ValleyStartMenu.ts).
//
// Written as SHOTS — camera paths through points placed by hand on the valley's own layout (layout.mjs),
// each point with what the camera looks at as it passes — and turned into a sequence (src/sequencer/types.ts)
// by `buildTour`, against the shipped terrain: heights are given above the ground and resolved here, and
// every path is lifted wherever its curve would dip below the clearance.
//
// The shot list follows the plan (C:\Users\ariel\.claude\plans\plan-a-suggested-route-replicated-quiche.md):
//   I    The Valley   campfire, main road, the hamlet, Old House, Granary, meadow and forest  (10:00)
//   II   Light        the Long House from outside, then inside while the sun goes down  (15:00 -> 20:30)
//   III  Weather      night, dawn, the windmill, the gate notch, back over the valley  (game time x2)
//   IV   Water        across the pond, then up over the whole valley
// Times are sequence seconds on the GAME clock, so Act III, run at time scale 2, takes half as long.

import { Spline3, evaluateKeyedNumber } from '../../../src/core/math'
import type { SequenceData, SequenceKey, SequenceTrack } from '../../../src/sequencer/types'

/** A height above the ground (`h`) or an absolute one (`y`), at x/z. */
type At = { x: number, z: number, h?: number, y?: number }
interface Point extends At { look: At }
interface Shot {
  key: string
  label: string
  start: number
  end: number
  points: Point[]
  /** Ease in and out at the ends of the move (default both). */
  ease?: [boolean, boolean]
  /** Lowest the camera may go above the ground on this shot (default 1.2 m). */
  clearance?: number
}

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

export const TOUR_DURATION = 410

export const SHOTS: Shot[] = [
  // ---- I: The Valley -----------------------------------------------------------------------------------
  {
    key: 'valley', label: 'The Valley', start: 0, end: 75, ease: [true, false],
    points: [
      p(-6.5, 89, 1.7, at(-6.5, 79, 1)),          // behind the campfire, low
      p(-7.5, 85, 4, at(-8, 60, 3)),
      p(-10, 78, 9, at(-20, 52, 4)),               // up, and along the main road
      p(-16, 66, 10, at(-30, 44, 4)),
      p(-24, 55, 12, at(-38, 34, 3)),              // the hamlet's well
      p(-40, 58, 14, at(-38, 34, 3)),
      p(-58, 54, 14, at(-52, 37, 4)),              // the Old House
      p(-73, 40, 13, at(-78, 53, 4)),              // the Granary
      p(-66, 20, 10, at(-50, 0, 2)),
      p(-52, 4, 3, at(-48, -14, 1.5)),             // low over the meadow
      p(-50, -12, 3, at(-58, -28, 3)),
      p(-56, -30, 22, at(-70, -70, 10)),           // up over the forest's edge, looking along it
      p(-66, -52, 40, at(-85, -100, 20)),
    ],
  },
  // ---- II: Light ---------------------------------------------------------------------------------------
  {
    key: 'approach', label: 'The Long House', start: 75, end: 85, ease: [true, true],
    points: [p(-34, 30, 7, at(-9, 39, 4)), p(-27, 35, 5, at(-9, 39, 4)), p(-22, 40, 4, at(-9, 39, 4))],
  },
  {
    // A cut inside (the doors are gaps in the walls, too narrow to fly through), down the house while the sun
    // goes down outside: the light bounced round the rooms follows it (GI volumes, relit). Read off its
    // colliders: floor 2.69, a ceiling at 4.98, end walls at z -9.2 and 8.2 (a door at x 0 in the far one),
    // and two cross walls at z ±3 that span only x 0..3.2, leaving an aisle along x -3..0 through all three
    // rooms. The dolly keeps to that aisle.
    key: 'interior', label: 'Long House interior', start: 85, end: 115, ease: [true, true],
    points: [py(lh(-1.6, -7.8, 4.2), lh(-1.2, 2, 3.6)), py(lh(-1.7, -3, 4.2), lh(-0.6, 6, 3.7)),
             py(lh(-1.6, 2, 4.2), lh(0, 9, 3.8)), py(lh(-1.4, 6.5, 4.2), lh(0.3, 11, 3.8))],
  },
  {
    key: 'night', label: 'Night falls', start: 115, end: 125, ease: [true, true],
    points: [p(-20, 46, 3, at(-38, 34, 2)), p(-26, 52, 6, at(-38, 34, 2))],
  },
  // ---- III: Weather (time x2) --------------------------------------------------------------------------
  {
    key: 'night-crane', label: 'Night over the hamlet', start: 125, end: 145, ease: [true, true],
    points: [p(-28, 64, 20, at(-38, 34, 3)), p(-36, 58, 45, at(-38, 34, 3))],
  },
  {
    key: 'cloudy', label: 'Clouds gather', start: 145, end: 185, ease: [true, true],
    points: [p(24, 74, 34, at(-30, 36, 3)), p(12, 64, 30, at(-30, 36, 3))],
  },
  {
    key: 'drizzle', label: 'First rain', start: 185, end: 215, ease: [true, true], clearance: 0.9,
    points: [p(-24, 14, 1.4, at(-14, -6, 0.5)), p(-18, 2, 1.3, at(-8, -22, 0.8))],
  },
  {
    key: 'storm', label: 'Storm at the windmill', start: 215, end: 265, ease: [true, true],
    points: [p(5, -8, 9, at(30, -26, 5)), p(30, -26, 13, at(59, -45, 10)), p(44, -28, 15, at(59, -45, 10)),
             p(66, -28, 16, at(59, -45, 10)), p(78, -48, 15, at(59, -45, 10))],
  },
  {
    key: 'snow', label: 'Rain turns to snow', start: 265, end: 305, ease: [true, true],
    // West over the northern forest, looking across it and down the valley. The gate notch comes next, from
    // inside it: from out here it is a narrow cut in a cliff, all rock.
    points: [p(55, -75, 30, at(10, -70, 4)), p(32, -88, 26, at(-15, -60, 4)), p(8, -95, 22, at(-35, -45, 4))],
  },
  {
    key: 'melt', label: 'Snow melts', start: 305, end: 335, ease: [true, true],
    points: [p(-3, -128, 3, at(-10, 0, 10)), p(4, -118, 8, at(-10, 0, 10))],
  },
  {
    key: 'clearing', label: 'The sky clears', start: 335, end: 365, ease: [true, true],
    points: [p(30, -70, 55, at(-10, 20, 0)), p(40, -30, 48, at(-10, 20, 0))],
  },
  // ---- IV: Water ---------------------------------------------------------------------------------------
  {
    // Low across the water toward the windmill: reflections show at a grazing angle, not looking down.
    key: 'pond', label: 'The pond', start: 365, end: 390, ease: [true, true], clearance: 0.8,
    points: [p(40, 34, 1, at(59, -45, 10)), p(43, 29, 0.9, at(59, -45, 10)), p(46, 25, 0.9, at(59, -45, 10))],
  },
  {
    key: 'finale', label: 'The whole valley', start: 390, end: 410, ease: [true, false],
    points: [p(47, 23, 1.2, at(10, 10, 4)), p(58, 52, 30, at(0, 0, 0)), p(64, 90, 85, at(0, 0, 0))],
  },
]

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

const TITLES: [number, number, string][] = [[2, 8, 'The Valley'], [392, 404, 'Cleo Engine']]
const CAPTIONS: [number, number, string][] = [
  [9, 15, 'I  ·  The Valley'],
  [77, 83, 'II  ·  Light'],
  [87, 97, 'Dynamic global illumination: the sun goes down, the bounce light follows'],
  [127, 135, 'III  ·  Weather  ·  time ×2'],
  [367, 375, 'IV  ·  Water  ·  screen-space reflections'],
]

/** The hour of day across the tour: Act I at ten, Act II from three into the night, a new day for Act III. */
const HOUR_KEYS: [number, number, SequenceKey['interp']][] = [
  [0, 10, 'constant'], [75, 15, 'linear'], [115, 20.5, 'linear'], [125, 23, 'linear'],
  [139.9, 23.9, 'constant'], [140, 6.5, 'linear'], [145, 7, 'linear'], [185, 9, 'linear'], [365, 14, 'linear'], [410, 16.5, 'linear'],
]

/** Black over the night's jump in the hour, and over the very end. */
const FADE_KEYS: [number, number, SequenceKey['interp']][] = [
  [0, 1, 'linear'], [1.5, 0, 'linear'], [136, 0, 'linear'], [139, 1, 'linear'], [141, 1, 'linear'], [144, 0, 'linear'],
  [404, 0, 'linear'], [410, 1, 'linear'],
]

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

export function buildTour(terrainAt: HeightAt): SequenceData {
  const heightAt = groundWith(terrainAt)
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

  const tracks: SequenceTrack[] = [
    { id: 'camera', name: 'Camera', type: 'path', slot: 'camera', sections: pathSections } as any,
    { id: 'cut', name: 'Camera cut', type: 'cameraCut', sections: [{ id: 'cut:all', start: 0, end: D, slot: 'camera' }] },
    property('clock-running', 'clock', 'running', 'bool', [{ t: 0, v: false }]),
    property('clock-hour', 'clock', 'hour', 'number', keysFrom(0, HOUR_KEYS)),
    // Act III runs at twice the game speed: the weather's changes, the rain and the clouds in half the time.
    { id: 'time-scale', name: 'Time scale', type: 'property', target: 'game', path: 'timeScale', valueType: 'number',
      sections: [{ id: 'time-scale:weather', start: 125, end: 365, whenFinished: 'restore', curve: { keys: keysFrom(125, [
        [125, 1, 'linear'], [128, 2, 'linear'], [362, 2, 'linear'], [365, 1, 'linear']]) } }] } as any,
    property('bar-top', 'barTop', 'opacity', 'number', keysFrom(0, [[0, 0, 'linear'], [1.5, 1, 'linear']])),
    property('bar-bottom', 'barBottom', 'opacity', 'number', keysFrom(0, [[0, 0, 'linear'], [1.5, 1, 'linear']])),
    property('fade', 'fade', 'opacity', 'number', keysFrom(0, FADE_KEYS)),
    property('title-text', 'title', 'text', 'string', textKeys(TITLES)),
    property('title-opacity', 'title', 'opacity', 'number', pulses(TITLES)),
    property('caption-text', 'caption', 'text', 'string', textKeys(CAPTIONS)),
    property('caption-opacity', 'caption', 'opacity', 'number', pulses(CAPTIONS)),
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
    ],
    tracks,
    markers: [
      { t: 0, name: 'I · The Valley' }, { t: 75, name: 'II · Light' }, { t: 125, name: 'III · Weather' }, { t: 365, name: 'IV · Water' },
    ],
  }
}

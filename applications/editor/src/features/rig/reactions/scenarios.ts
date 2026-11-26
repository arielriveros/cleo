// The Reactions bench's scenarios: the props a reaction is tried on (a flight of stairs, a ramp, a ledge, a
// moving vehicle to bail from, a wall), as plain boxes around the preview character, and what starts it. Pure:
// what is built from it lives in ReactionBench.tsx; tests/reactionBench.test.ts checks the geometry.

export type BenchScenario = 'flat' | 'stairs' | 'ramp' | 'ledge' | 'vehicle' | 'wall'

export const BENCH_SCENARIOS: { id: BenchScenario; label: string; doc: string }[] = [
  { id: 'flat', label: 'Flat ground', doc: 'Open ground: shoot it, push it, trip it, throw it.' },
  { id: 'stairs', label: 'Stairs', doc: 'Standing at the top of a flight of stairs, tripped down them.' },
  { id: 'ramp', label: 'Ramp', doc: 'Standing at the top of a slope, tripped down it.' },
  { id: 'ledge', label: 'Ledge', doc: 'Stepping off a ledge: a drop of the height set.' },
  { id: 'vehicle', label: 'Moving vehicle', doc: 'Riding a cart at the speed set, then bailing out of it sideways.' },
  { id: 'wall', label: 'Wall', doc: 'Shoved into a wall.' },
]

export interface BenchOptions {
  stairCount: number
  stairRise: number
  stairRun: number
  rampAngle: number
  ledgeHeight: number
  vehicleSpeed: number
}

export const BENCH_DEFAULTS: BenchOptions = { stairCount: 10, stairRise: 0.18, stairRun: 0.3, rampAngle: 25, ledgeHeight: 3, vehicleSpeed: 10 }

export interface BenchBox {
  center: [number, number, number]
  half: [number, number, number]
  /** About X, degrees (a ramp's slope). */
  pitch?: number
  /** Moves with this velocity (m/s) for as long as the scenario runs (the vehicle). */
  velocity?: [number, number, number]
}

export interface BenchLayout {
  boxes: BenchBox[]
  /** Where the character stands (its feet), facing +Z. */
  start: [number, number, number]
  /** What starts the reaction once it stands there. */
  action: 'none' | 'trip' | 'fall' | 'bail' | 'push'
  /** For 'bail' and 'push': the velocity it is given (m/s). */
  velocity?: [number, number, number]
  /** For 'bail': which way it is thrown out. */
  exit?: [number, number, number]
  /** It stands on the moving prop and rides along with it until the action (the vehicle). */
  rides?: boolean
}

/** The props of a scenario around a character whose feet are at height `floor`, facing +Z. */
export function benchLayout(scenario: BenchScenario, o: BenchOptions = BENCH_DEFAULTS, floor = 0): BenchLayout {
  const ground: BenchBox = { center: [0, floor - 0.5, 0], half: [30, 0.5, 30] }
  switch (scenario) {
    case 'flat':
      return { boxes: [ground], start: [0, floor, 0], action: 'none' }
    case 'stairs': {
      // Down along +Z from a platform `count × rise` high: step i's top is a rise lower than the one before.
      const n = Math.max(1, Math.round(o.stairCount)), rise = Math.max(0.02, o.stairRise), run = Math.max(0.1, o.stairRun)
      const top = floor + n * rise
      const boxes: BenchBox[] = [ground, { center: [0, (floor + top) / 2, -1], half: [1.5, (top - floor) / 2, 1] }]
      for (let i = 1; i < n; i++) {
        const h = top - i * rise
        boxes.push({ center: [0, (floor + h) / 2, (i - 0.5) * run], half: [1.5, (h - floor) / 2, run / 2] })
      }
      return { boxes, start: [0, top, -0.25], action: 'trip' }
    }
    case 'ramp': {
      const angle = Math.max(1, Math.min(60, o.rampAngle)) * Math.PI / 180, length = 8
      const height = Math.sin(angle) * length, depth = Math.cos(angle) * length
      const boxes: BenchBox[] = [
        ground,
        { center: [0, floor + height / 2 - 0.25 * Math.cos(angle), depth / 2 - 0.25 * Math.sin(angle)], half: [1.5, 0.25, length / 2], pitch: angle * 180 / Math.PI },
        { center: [0, floor + height / 2, -1], half: [1.5, height / 2, 1] },
      ]
      return { boxes, start: [0, floor + height, -0.3], action: 'trip' }
    }
    case 'ledge': {
      const h = Math.max(0.2, o.ledgeHeight)
      return { boxes: [ground, { center: [0, floor + h / 2, -1], half: [1.5, h / 2, 1] }], start: [0, floor + h, -0.05], action: 'fall', velocity: [0, 0, 0.8] }
    }
    case 'vehicle': {
      const v = Math.max(0, o.vehicleSpeed)
      // A flat-bed cart 0.9 m high, the character standing on its deck, thrown off its right side.
      return {
        boxes: [ground, { center: [0, floor + 0.45, 0], half: [0.9, 0.45, 2], velocity: [0, 0, v] }],
        start: [0, floor + 0.9, 0], action: 'bail', velocity: [0, 0, v], exit: [1, 0, 0], rides: true,
      }
    }
    case 'wall':
      return { boxes: [ground, { center: [0, floor + 1.25, 1.3], half: [2, 1.25, 0.15] }], start: [0, floor, 0], action: 'push', velocity: [0, 0.3, 2.5] }
  }
}

/** A box's twelve edges as line segments (positions and index pairs), in its own frame. */
export function boxLines(half: readonly number[]): { positions: [number, number, number][]; indices: number[] } {
  const [x, y, z] = half
  const positions: [number, number, number][] = []
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) positions.push([sx * x, sy * y, sz * z])
  const indices: number[] = []
  // Corners differing in exactly one sign are an edge.
  for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) {
    const d = a ^ b
    if (d === 1 || d === 2 || d === 4) indices.push(a, b)
  }
  return { positions, indices }
}

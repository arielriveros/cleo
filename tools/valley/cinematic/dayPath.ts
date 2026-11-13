// The Valley's day, as keys: where the sun is and what follows it, at any hour, turned into property tracks
// a sequence plays — the tour's own day (tour.ts) and the looping Day Cycle Free mode plays (cinematic.ts).
//
// The time of day used to be a script (ValleyDayNight) that moved the sun and its followers every frame from
// one `hour`. That is gone: the same model now runs HERE, offline, and what it computes is written as keys on
// the nodes themselves, so a sequence moves the sun directly, scrubbing in Sequencer mode shows it, and nothing
// runs at play time but the sequence. What it keys:
//
//   - the Sun: its rotation on a spring day's path at `LATITUDE`, its colour (warm and dim at the horizon,
//     white at noon, greyer when overcast) and its illuminance (below the horizon the renderer fades it out
//     and hands the key light to the moon by itself);
//   - the Sky Light's fill, falling to `NIGHT_SKY_LIGHT` at night and dimmed by overcast;
//   - the sky's mist (thick at dawn, burnt off by mid-morning, a veil at night) and its god rays (strongest
//     with a low sun, faded by overcast);
//   - the fog volumes (the pond's mist), `FOG_NIGHT_SCALE` times as dense at night and at dawn.
//
// The light probes follow the sun on their own (LightProbeNode.relightDegrees), and the sky and the GI volumes
// re-bake and relight as it turns, as they always have.

import { kelvinToRgb } from '../../../src/graphics/colorTemperature'
import type { SequenceData, SequenceKey, SequenceSlot, SequenceTrack } from '../../../src/sequencer/types'

export const LATITUDE = 45
export const DECLINATION = 10
/** The sun's illuminance (lux) once it is well up. */
export const SUN_LUX = 79600
/** The Sky Light's intensity at full night, as a share of its daytime one. */
export const NIGHT_SKY_LIGHT = 0.4
/** How many times denser the fog volumes are at night and at dawn than by day. */
export const FOG_NIGHT_SCALE = 3

/** What the scene holds by day, as authored: what the night, the dawn and the overcast move away from. */
export interface DayAuthored {
  skyLight: number
  fog: { density: number; falloff: number; opacity: number }
  godRays: number
  /** Each fog volume: its slot (id, name, name path) and daytime density. */
  fogVolumes: { slot: string; name: string; path: string; density: number }[]
}

export interface DayLook {
  /** The Sun node's rotation, Euler degrees. */
  rotation: [number, number, number]
  color: [number, number, number]
  lux: number
  skyLight: number
  fogDensity: number
  fogFalloff: number
  fogOpacity: number
  godRays: number
  fogVolumes: number[]
}

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

/** Where the sun is at `hour` (any number: it wraps): [east, up, south] as a unit vector (+X, +Y, +Z). */
export function sunPosition(hour: number): [number, number, number] {
  const H = (hour - 12) / 24 * Math.PI * 2
  const L = LATITUDE * Math.PI / 180, d = DECLINATION * Math.PI / 180
  const east = -Math.cos(d) * Math.sin(H)
  const north = Math.cos(L) * Math.sin(d) - Math.sin(L) * Math.cos(d) * Math.cos(H)
  const up = Math.sin(L) * Math.sin(d) + Math.cos(L) * Math.cos(d) * Math.cos(H)
  return [east, up, -north]
}

/** The sun's elevation at `hour`, degrees. */
export const sunElevation = (hour: number) => Math.asin(Math.max(-1, Math.min(1, sunPosition(hour)[1]))) * 180 / Math.PI

/** 0 with the sun 2° up, 1 once it is 10° down: the renderer's own night follows the same light. */
export const nightFactor = (hour: number) => 1 - smooth(-10, 2, sunElevation(hour))

/** Everything the day keys, at `hour` and `overcast` (0 clear .. 1 a storm's). */
export function dayLook(hour: number, overcast: number, a: DayAuthored): DayLook {
  const pos = sunPosition(hour)
  const elevation = sunElevation(hour)
  const night = nightFactor(hour)
  const day = smooth(0, 25, elevation)
  const oc = Math.min(1, Math.max(0, overcast))
  const morning = ((hour % 24) + 24) % 24 < 12

  const travel = [-pos[0], -pos[1], -pos[2]]
  const pitch = Math.asin(-travel[1]) * 180 / Math.PI
  const yaw = Math.atan2(travel[0], travel[2]) * 180 / Math.PI

  const clear = 2100 + 3300 * smooth(-2, 35, elevation)
  const color = kelvinToRgb(clear + (6500 - clear) * 0.8 * oc) as [number, number, number]
  const lux = elevation > 0 ? SUN_LUX * (0.3 + 0.7 * day) : SUN_LUX

  const low = smooth(-12, -2, elevation) * (1 - smooth(4, 14, elevation))
  const mist = Math.max(0.08 * night, low * (morning ? 1 : 0.15), 0.3 * oc)
  const dawn = low
  const gathered = Math.max(night, dawn * (morning ? 1 : 0.4))
  return {
    rotation: [pitch, yaw, 0],
    color: [color[0], color[1], color[2]],
    lux,
    skyLight: a.skyLight * (1 + (NIGHT_SKY_LIGHT - 1) * night) * (1 - 0.35 * oc),
    fogDensity: a.fog.density + (0.002 - a.fog.density) * mist,
    fogFalloff: a.fog.falloff + (0.05 - a.fog.falloff) * mist,
    fogOpacity: a.fog.opacity + (0.6 - a.fog.opacity) * mist,
    godRays: a.godRays * (1 + 1.4 * (1 - smooth(5, 30, elevation)) * (1 - night) - 0.4 * night) * (1 - 0.85 * oc),
    fogVolumes: a.fogVolumes.map(f => f.density * (1 + (FOG_NIGHT_SCALE - 1) * gathered) * (1 + oc)),
  }
}

/** Slots the day's tracks drive. */
export const DAY_SLOTS = { sun: 'sun', skyLight: 'skyLight', sky: 'sky' } as const

interface Channel {
  id: string
  name: string
  slot: string
  path: string
  valueType: 'number' | 'vector'
  of: (l: DayLook) => number | number[]
  /** How far linear interpolation between kept keys may stray from the model before a key is kept. */
  tolerance: number
  /** A relative tolerance (a share of the value), for quantities spanning orders of magnitude. */
  relative?: boolean
}

function channels(a: DayAuthored): Channel[] {
  return [
    { id: 'sun-rotation', name: 'Sun', slot: DAY_SLOTS.sun, path: 'rotation', valueType: 'vector', of: l => l.rotation, tolerance: 0.1 },
    { id: 'sun-color', name: 'Sun colour', slot: DAY_SLOTS.sun, path: 'light.color', valueType: 'vector', of: l => l.color, tolerance: 0.003 },
    { id: 'sun-lux', name: 'Sun lux', slot: DAY_SLOTS.sun, path: 'light.intensity', valueType: 'number', of: l => l.lux, tolerance: 0.005, relative: true },
    { id: 'sky-light', name: 'Sky fill', slot: DAY_SLOTS.skyLight, path: 'intensity', valueType: 'number', of: l => l.skyLight, tolerance: 0.005 },
    { id: 'sky-fog-density', name: 'Mist density', slot: DAY_SLOTS.sky, path: 'fogDensity', valueType: 'number', of: l => l.fogDensity, tolerance: 0.01, relative: true },
    { id: 'sky-fog-falloff', name: 'Mist falloff', slot: DAY_SLOTS.sky, path: 'fogHeightFalloff', valueType: 'number', of: l => l.fogFalloff, tolerance: 0.0005 },
    { id: 'sky-fog-opacity', name: 'Mist opacity', slot: DAY_SLOTS.sky, path: 'fogMaxOpacity', valueType: 'number', of: l => l.fogOpacity, tolerance: 0.003 },
    { id: 'sky-god-rays', name: 'God rays', slot: DAY_SLOTS.sky, path: 'godRayExposure', valueType: 'number', of: l => l.godRays, tolerance: 0.002 },
    ...a.fogVolumes.map((f, i): Channel => ({
      id: `fog-${f.slot}`, name: 'Fog density', slot: f.slot, path: 'density', valueType: 'number', of: l => l.fogVolumes[i], tolerance: 0.01, relative: true,
    })),
  ]
}

const round = (v: number, digits = 5) => { const f = 10 ** digits; return Math.round(v * f) / f }
const values = (v: number | number[]) => (Array.isArray(v) ? v : [v])

/**
 * The day as property tracks over `[0, duration]`, from the hour and the overcast at every moment.
 *
 * `breaks` are the times either curve has a key; between two of them the day is sampled every `step` seconds
 * (or held, where both curves hold, as one 'constant' key, so a jump hidden behind a fade stays a jump), and
 * each track keeps only the samples linear interpolation needs to stay within its tolerance of the model.
 */
export function dayTracks(options: {
  duration: number
  hourAt: (t: number) => number
  overcastAt: (t: number) => number
  breaks: number[]
  step: number
  authored: DayAuthored
}): SequenceTrack[] {
  const { duration, hourAt, overcastAt, step, authored } = options
  const breaks = [...new Set([0, ...options.breaks.filter(t => t > 0 && t < duration), duration])].sort((x, y) => x - y)

  // Sample times, and whether the day holds from each until the next.
  const samples: { t: number; hold: boolean }[] = []
  for (let i = 0; i < breaks.length - 1; i++) {
    const a = breaks[i], b = breaks[i + 1]
    const probe = [a, a + (b - a) * 0.37, a + (b - a) * 0.71, b - 1e-4]
    const holds = probe.every(t => Math.abs(hourAt(t) - hourAt(a)) < 1e-9 && Math.abs(overcastAt(t) - overcastAt(a)) < 1e-9)
    if (holds) { samples.push({ t: a, hold: true }); continue }
    const n = Math.max(1, Math.ceil((b - a) / step))
    for (let k = 0; k < n; k++) samples.push({ t: a + (b - a) * k / n, hold: false })
  }
  samples.push({ t: duration, hold: false })

  const looks = samples.map(s => dayLook(hourAt(s.t), overcastAt(s.t), authored))
  // The sun's yaw runs on through ±180°: unwrap it so a key never spins the long way round. Not across a hold
  // (a jump behind a fade, which nothing interpolates): the next run starts from the yaw as it is.
  for (let i = 1; i < looks.length; i++) {
    if (samples[i - 1].hold) continue
    const prev = looks[i - 1].rotation[1]
    let y = looks[i].rotation[1]
    while (y - prev > 180) y -= 360
    while (y - prev < -180) y += 360
    looks[i].rotation[1] = y
  }

  return channels(authored).map(c => {
    const keys: SequenceKey[] = []
    const at = (i: number) => values(c.of(looks[i]))
    const off = (i: number, from: number, to: number) => {
      // How far the straight line from key `from` to sample `to` misses sample `i`.
      const f = (samples[i].t - samples[from].t) / (samples[to].t - samples[from].t)
      const vi = at(i), va = at(from), vb = at(to)
      return vi.reduce((m, v, j) => {
        const miss = Math.abs(v - (va[j] + (vb[j] - va[j]) * f))
        return Math.max(m, c.relative ? miss / Math.max(1e-9, Math.abs(v)) : miss)
      }, 0)
    }
    let last = -1
    for (let i = 0; i < samples.length; i++) {
      const keep = i === 0 || i === samples.length - 1 || samples[i].hold || samples[i - 1].hold
        || (i + 1 < samples.length && samples[i + 1].hold)
        || (() => { for (let j = last + 1; j <= i; j++) if (off(j, last, i + 1) > c.tolerance) return true; return false })()
      if (!keep) continue
      const v = c.of(looks[i])
      keys.push({ t: round(samples[i].t, 4), v: Array.isArray(v) ? v.map(x => round(x)) : round(v, c.relative ? 8 : 5), interp: samples[i].hold ? 'constant' : 'linear' })
      last = i
    }
    return {
      id: c.id, name: c.name, type: 'property', slot: c.slot, path: c.path, valueType: c.valueType,
      sections: [{ id: `${c.id}:all`, start: 0, end: duration, curve: { keys } }],
    } as SequenceTrack
  })
}

/** The slots the day's tracks drive, found by name path (a Sequence node can bind them too). */
export function daySlots(a: DayAuthored): SequenceSlot[] {
  return [
    { id: DAY_SLOTS.sun, name: 'Sun', nodeType: 'light', path: 'Sun' },
    { id: DAY_SLOTS.skyLight, name: 'Sky Light', nodeType: 'skyLight', path: 'Sky Light' },
    { id: DAY_SLOTS.sky, name: 'Sky', nodeType: 'skyAtmosphere', path: 'sky atmosphere' },
    ...a.fogVolumes.map(f => ({ id: f.slot, name: f.name, nodeType: 'volumetricFog', path: f.path })),
  ]
}

/** Real minutes in Free mode's day. */
export const DAY_MINUTES = 24
/** The hour Free mode's day starts at. */
export const DAY_START_HOUR = 9.5

/**
 * Free mode's day: a whole day and night in `DAY_MINUTES` real minutes from `DAY_START_HOUR`, clear, looping.
 * Sampled every 4 s (the sun moves a degree in that time), then thinned like the tour's.
 */
export function buildDayCycle(a: DayAuthored): SequenceData {
  const duration = DAY_MINUTES * 60
  return {
    version: 1, name: 'Day Cycle', duration, fps: 30, clock: 'game', loop: true,
    slots: daySlots(a),
    tracks: dayTracks({
      duration, step: 4, authored: a, breaks: [],
      hourAt: t => DAY_START_HOUR + 24 * t / duration, overcastAt: () => 0,
    }),
    markers: [{ t: 0, name: 'Morning' }, { t: duration * (12 - DAY_START_HOUR) / 24, name: 'Noon' },
              { t: duration * (20 - DAY_START_HOUR) / 24, name: 'Night' }],
  }
}

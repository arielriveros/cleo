import { defaultEmitter, makeModule, type EmitterDef, type ParticleModule } from 'cleo'

// Starting points for "+ Emitter". Each is an ordinary emitter built from the same module catalogue an
// author would use by hand — nothing here the stack UI cannot show and edit — so a preset doubles as a
// worked example of what the modules do together.

type Params = Record<string, unknown>

function mod(type: string, params: Params = {}): ParticleModule {
  const m = makeModule(type)
  Object.assign(m.params, params)
  return m
}

function emitter(name: string, fields: Partial<EmitterDef>): EmitterDef {
  const base = defaultEmitter(name)
  return { ...base, ...fields, render: { ...base.render, ...(fields.render ?? {}) } }
}

const fade = (peak = 1) => ({ color: [{ t: 0, c: [1, 1, 1] }, { t: 1, c: [1, 1, 1] }], alpha: [{ t: 0, a: 0 }, { t: 0.1, a: peak }, { t: 0.7, a: peak }, { t: 1, a: 0 }] })

export interface EmitterPreset {
  id: string
  label: string
  description: string
  build: () => EmitterDef
}

export const EMITTER_PRESETS: EmitterPreset[] = [
  {
    id: 'blank', label: 'Empty', description: 'Spawn rate, lifetime and a soft sprite — nothing else.',
    build: () => emitter('Emitter', {
      spawn: [mod('spawnRate', { rate: 20 })],
      init: [mod('shape', { shape: 'point' }), mod('lifetime'), mod('velocity', { mode: 'direction', speed: [1, 1] }), mod('size')],
      update: [],
    }),
  },
  {
    id: 'smoke', label: 'Smoke', description: 'Soft lit puffs that rise, swirl and spread.',
    build: () => emitter('Smoke', {
      capacity: 1024,
      spawn: [mod('spawnRate', { rate: 25 })],
      init: [mod('shape', { shape: 'circle', radius: 0.3, thickness: 1 }), mod('lifetime', { range: [3, 5] }),
             mod('velocity', { mode: 'direction', direction: [0, 1, 0], spread: 15, speed: [0.6, 1.2] }),
             mod('size', { range: [0.6, 1] }), mod('rotation', { angle: [0, 360], spin: [-20, 20] }),
             mod('color', { mode: 'between', colorA: [0.55, 0.55, 0.55, 0.6], colorB: [0.35, 0.35, 0.38, 0.6] })],
      update: [mod('drag', { coefficient: 0.4 }), mod('curlNoise', { strength: 0.8, frequency: 0.4, scroll: 0.2 }),
               mod('wind', { velocity: [0.6, 0.3, 0], influence: 0.3 }), mod('forceFields'),
               mod('colorOverLife', { gradient: fade(0.8) }), mod('sizeOverLife', { curve: { keys: [{ t: 0, v: 0.5 }, { t: 1, v: 2.5 }] } })],
      render: { ...defaultEmitter().render, lit: true, softness: 0.6 },
    }),
  },
  {
    id: 'fire', label: 'Fire', description: 'Additive flames: a narrow cone, fast fade, shrinking with height.',
    build: () => emitter('Fire', {
      capacity: 1024,
      spawn: [mod('spawnRate', { rate: 80 })],
      init: [mod('shape', { shape: 'cone', radius: 0.25, angle: 8, thickness: 1 }), mod('lifetime', { range: [0.5, 1.1] }),
             mod('velocity', { mode: 'shape', speed: [1.2, 2.2] }), mod('size', { range: [0.4, 0.7] }),
             mod('rotation', { angle: [0, 360], spin: [-90, 90] }),
             mod('color', { mode: 'constant', colorA: [1, 1, 1, 1], intensity: 4 })],
      update: [mod('curlNoise', { strength: 2, frequency: 1.2, scroll: 1 }), mod('drag', { coefficient: 1 }),
               mod('gravity', { scale: -0.15 }),
               mod('colorOverLife', { gradient: { color: [{ t: 0, c: [1, 0.85, 0.45] }, { t: 0.4, c: [1, 0.35, 0.05] }, { t: 1, c: [0.3, 0.03, 0.01] }], alpha: [{ t: 0, a: 0 }, { t: 0.1, a: 1 }, { t: 0.6, a: 0.6 }, { t: 1, a: 0 }] } }),
               mod('sizeOverLife', { curve: { keys: [{ t: 0, v: 0.7 }, { t: 0.3, v: 1 }, { t: 1, v: 0.2 }] } })],
      render: { ...defaultEmitter().render, blend: 'additive', softness: 0.3 },
    }),
  },
  {
    id: 'sparks', label: 'Sparks', description: 'Hot streaks that fall, bounce off the scene and die.',
    build: () => emitter('Sparks', {
      capacity: 2048,
      spawn: [mod('spawnRate', { rate: 0 }), mod('spawnBurst', { bursts: [{ time: 0, count: 120, cycles: 0, interval: 1.2, probability: 1 }] })],
      init: [mod('shape', { shape: 'sphere', radius: 0.05, thickness: 1 }), mod('lifetime', { range: [1, 2.5] }),
             mod('velocity', { mode: 'direction', direction: [0, 1, 0], spread: 70, speed: [4, 9] }),
             mod('size', { range: [0.03, 0.06] }),
             mod('color', { mode: 'constant', colorA: [1, 0.55, 0.15, 1], intensity: 8 })],
      update: [mod('gravity', { scale: 1 }), mod('drag', { coefficient: 0.3 }),
               mod('collision', { depth: true, restitution: 0.35, friction: 0.3, radius: 0.5, planes: [] }),
               mod('colorOverLife', { gradient: { color: [{ t: 0, c: [1, 1, 1] }, { t: 1, c: [1, 0.3, 0.1] }], alpha: [{ t: 0, a: 1 }, { t: 0.8, a: 1 }, { t: 1, a: 0 }] } })],
      render: { ...defaultEmitter().render, blend: 'additive', alignment: 'velocity', stretch: 1, softness: 0 },
    }),
  },
  {
    id: 'fountain', label: 'Fountain', description: 'Water arcs that land on the ground plane and splash about.',
    build: () => emitter('Fountain', {
      capacity: 4096,
      spawn: [mod('spawnRate', { rate: 400 })],
      init: [mod('shape', { shape: 'cone', radius: 0.08, angle: 10 }), mod('lifetime', { range: [2, 3] }),
             mod('velocity', { mode: 'shape', speed: [6, 7] }), mod('size', { range: [0.04, 0.08] }),
             mod('color', { mode: 'constant', colorA: [0.6, 0.8, 1, 0.7], intensity: 1.2 })],
      update: [mod('gravity', { scale: 1 }),
               mod('collision', { depth: true, planes: [{ point: [0, 0, 0], normal: [0, 1, 0] }], restitution: 0.2, friction: 0.5, radius: 0.5 }),
               mod('colorOverLife', { gradient: fade(1) })],
      render: { ...defaultEmitter().render, alignment: 'velocity', stretch: 0.4, lit: true, softness: 0 },
    }),
  },
  {
    id: 'magic', label: 'Magic', description: 'Glowing motes orbiting a vortex, drawn toward the centre.',
    build: () => emitter('Magic', {
      capacity: 2048,
      spawn: [mod('spawnRate', { rate: 120 })],
      init: [mod('shape', { shape: 'sphere', radius: 1.2, thickness: 0.2 }), mod('lifetime', { range: [1.5, 3] }),
             mod('velocity', { mode: 'radial', speed: [0, 0.3] }), mod('size', { range: [0.05, 0.12] }),
             mod('color', { mode: 'gradient', intensity: 5, gradient: { color: [{ t: 0, c: [0.4, 0.8, 1] }, { t: 0.5, c: [0.6, 0.3, 1] }, { t: 1, c: [1, 0.3, 0.8] }], alpha: [{ t: 0, a: 1 }, { t: 1, a: 1 }] } })],
      update: [mod('vortex', { axis: [0, 1, 0], center: [0, 0, 0], strength: 4, pull: 1.5 }),
               mod('curlNoise', { strength: 0.6, frequency: 1 }), mod('drag', { coefficient: 1.2 }),
               mod('colorOverLife', { gradient: fade(1) }), mod('sizeOverLife', { curve: { keys: [{ t: 0, v: 1 }, { t: 1, v: 0 }] } })],
      render: { ...defaultEmitter().render, blend: 'additive', softness: 0 },
    }),
  },
  {
    id: 'snow', label: 'Snow', description: 'Flakes drifting down through a wide box, fluttering in the wind.',
    build: () => emitter('Snow', {
      capacity: 8192, prewarm: true,
      spawn: [mod('spawnRate', { rate: 600 })],
      init: [mod('shape', { shape: 'box', box: [20, 0.5, 20], offset: [0, 8, 0] }), mod('lifetime', { range: [7, 9] }),
             mod('velocity', { mode: 'direction', direction: [0, -1, 0], speed: [0.8, 1.2] }), mod('size', { range: [0.03, 0.07] }),
             mod('color', { mode: 'constant', colorA: [1, 1, 1, 0.9] })],
      update: [mod('curlNoise', { strength: 0.6, frequency: 0.5, scroll: 0.1 }), mod('wind', { velocity: [0.6, -1, 0.2], influence: 0.5 }),
               mod('collision', { depth: true, kill: true, radius: 0.5 }), mod('colorOverLife', { gradient: fade(0.9) })],
      render: { ...defaultEmitter().render, lit: true, softness: 0 },
    }),
  },
  {
    id: 'rain', label: 'Rain', description: 'Fast streaks that die where they hit the scene.',
    build: () => emitter('Rain', {
      capacity: 8192, prewarm: true,
      spawn: [mod('spawnRate', { rate: 3000 })],
      init: [mod('shape', { shape: 'box', box: [20, 0.5, 20], offset: [0, 12, 0] }), mod('lifetime', { range: [1.2, 1.4] }),
             mod('velocity', { mode: 'direction', direction: [0.1, -1, 0], speed: [10, 12] }), mod('size', { range: [0.015, 0.025] }),
             mod('color', { mode: 'constant', colorA: [0.7, 0.75, 0.85, 0.45] })],
      update: [mod('collision', { depth: true, kill: true, radius: 0.5, thickness: 1 })],
      render: { ...defaultEmitter().render, alignment: 'velocity', stretch: 1.8, lit: true, softness: 0 },
    }),
  },
]

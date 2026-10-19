// The Valley's water material: its GLSL (water.glsl) and the uniforms it declares, with the values the
// pond ships with. Shared by the generator (build.mjs) and tests/valleyWater.test.ts, so the material
// the example carries is exactly the one the tests translate.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export const WATER_SOURCE = fs.readFileSync(path.join(HERE, 'water.glsl'), 'utf8').replace(/\r\n/g, '\n')

/** `{ name, type, value }` per uniform — CustomUniform's shape. Colours are LINEAR. */
export const WATER_UNIFORMS = [
  { name: 'normalMap', type: 'sampler2D', value: '' },
  { name: 'waveScale', type: 'float', value: 0.22 },        // ripple repeats per metre
  { name: 'swellScale', type: 'float', value: 0.035 },      // the broad, slow layer
  { name: 'flowA', type: 'vec2', value: [0.018, 0.011] },   // scroll, repeats per second
  { name: 'flowB', type: 'vec2', value: [-0.013, 0.017] },
  { name: 'waveStrength', type: 'float', value: 0.32 },
  { name: 'reflectivity', type: 'float', value: 1 },
  { name: 'roughness', type: 'float', value: 0.06 },
  { name: 'specularStrength', type: 'float', value: 1 },
  { name: 'refraction', type: 'float', value: 0.35 },
  { name: 'absorption', type: 'vec3', value: [0.45, 0.12, 0.08] },   // per metre, red goes first
  { name: 'turbidity', type: 'float', value: 0.35 },
  { name: 'deepDistance', type: 'float', value: 3 },
  { name: 'shallowColor', type: 'vec3', value: [0.06, 0.16, 0.14] },
  { name: 'deepColor', type: 'vec3', value: [0.012, 0.05, 0.06] },
  { name: 'edgeSoftness', type: 'float', value: 0.06 }, // metres of depth over which the edge fades in
  { name: 'skyColor', type: 'vec3', value: [0.42, 0.6, 0.85] },
  // Interaction ripples, written each frame by the pond's WaterVolume node (see WaterVolumeNode).
  { name: 'rippleSpeed', type: 'float', value: 0.9 },      // m/s a ring spreads at
  { name: 'rippleWidth', type: 'float', value: 0.22 },     // m across a ring
  { name: 'rippleLife', type: 'float', value: 3.5 },       // seconds a ring lasts
  { name: 'rippleStrength', type: 'float', value: 0.35 },
  { name: 'crestBrightness', type: 'float', value: 0.6 },
  ...Array.from({ length: 12 }, (_, i) => ({ name: `ripple${i}`, type: 'vec4', value: [0, 0, -1000, 0] })),
]

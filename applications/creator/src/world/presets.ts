// World Creator presets. Each is a whole document, so picking one replaces the stack; the seed stays
// the artist's, which is how a preset becomes a family of variations.

import type { Preset } from '../core/generator';
import { defaultErosion, defaultLayer, DEFAULT_SETTINGS, type ErosionPass, type WorldDoc } from './worldDoc';
import type { WorldLayer } from './features';

function layer<K extends WorldLayer['kind']>(kind: K, patch: Partial<Extract<WorldLayer, { kind: K }>>): WorldLayer {
  return { ...(defaultLayer(kind) as Extract<WorldLayer, { kind: K }>), ...patch };
}

/**
 * The research doc's exit test for terrain, as a preset: a mountain, a beach, a road and a cliff on one
 * map, eroded, ready to hand to the Editor's landscape import.
 */
export function coastalRange(): WorldDoc {
  return {
    settings: { ...DEFAULT_SETTINGS },
    layers: [
      layer('noise', { name: 'Base relief', fractal: 'fbm', scale: 3, octaves: 6, amplitude: 0.22, offset: 0.12, warp: 0.6 }),
      layer('mountain', { name: 'Main peak', center: [0.35, 0.35], radius: 0.32, height: 0.62, sharpness: 1.6, ridges: 0.7 }),
      layer('ridge', { name: 'Spur', points: [[0.35, 0.35], [0.6, 0.25], [0.88, 0.18]], width: 0.07, height: 0.18 }),
      layer('plateau', { name: 'Sea cliff', center: [0.78, 0.62], radius: 0.13, level: 0.28, falloff: 0.012 }),
      layer('river', { name: 'River', points: [[0.42, 0.55], [0.5, 0.7], [0.45, 0.85], [0.5, 1.0]], bedStart: 0.2, bedEnd: 0.07 }),
      layer('coast', { name: 'Coast', direction: 90, shoreline: 0.82, beach: 0.05, seaLevel: 0.1 }),
      layer('road', { name: 'Coast road', points: [[0.05, 0.7], [0.3, 0.68], [0.6, 0.74], [0.95, 0.7]], width: 0.01, shoulder: 0.025, smoothing: 0.5 }),
    ],
    erosion: [defaultErosion('thermal'), defaultErosion('pipe')],
  };
}

export function rollingHills(): WorldDoc {
  return {
    settings: { ...DEFAULT_SETTINGS, heightScale: 220 },
    layers: [
      layer('noise', { name: 'Hills', fractal: 'billow', scale: 3.5, octaves: 5, gain: 0.45, amplitude: 0.55, warp: 0.8 }),
      layer('noise', { name: 'Detail', fractal: 'fbm', scale: 16, octaves: 4, amplitude: 0.06, offset: -0.03, seed: 9 }),
      layer('valley', { name: 'Vale', points: [[0.0, 0.4], [0.4, 0.55], [1.0, 0.45]], width: 0.18, depth: 0.2 }),
    ],
    erosion: [defaultErosion('droplet'), defaultErosion('thermal')],
  };
}

export function alpineMassif(): WorldDoc {
  return {
    settings: { ...DEFAULT_SETTINGS, heightScale: 1800 },
    layers: [
      layer('noise', { name: 'Ranges', fractal: 'ridged', scale: 2.5, octaves: 8, gain: 0.55, amplitude: 0.85, warp: 0.5 }),
      layer('mountain', { name: 'Summit', center: [0.55, 0.45], radius: 0.25, height: 0.35, sharpness: 2.2, ridges: 0.9 }),
      layer('valley', { name: 'Glacial valley', points: [[0.1, 0.9], [0.4, 0.65], [0.6, 0.6], [0.95, 0.75]], width: 0.16, depth: 0.3 }),
    ],
    erosion: [defaultErosion('pipe'), { ...defaultErosion('thermal'), params: { iterations: 60, talus: 42, rate: 0.5 } } as ErosionPass],
  };
}

export function mesaDesert(): WorldDoc {
  return {
    settings: { ...DEFAULT_SETTINGS, heightScale: 350, seaLevel: 0 },
    layers: [
      layer('noise', { name: 'Ground', fractal: 'fbm', scale: 2, octaves: 5, amplitude: 0.25, warp: 1.2 }),
      layer('plateau', { name: 'Mesa', center: [0.35, 0.4], radius: 0.16, level: 0.6, falloff: 0.02 }),
      layer('plateau', { name: 'Butte', center: [0.7, 0.65], radius: 0.07, level: 0.5, falloff: 0.012 }),
      layer('terrace', { name: 'Strata', steps: 10, sharpness: 0.8, minHeight: 0.15, maxHeight: 0.65 }),
      layer('crater', { name: 'Dry lake', center: [0.75, 0.25], radius: 0.1, depth: 0.08, rim: 0.01 }),
    ],
    erosion: [defaultErosion('thermal'), defaultErosion('droplet')],
  };
}

export const WORLD_PRESETS: readonly Preset<() => WorldDoc>[] = [
  { id: 'coastal-range', label: 'Coastal range (mountain, beach, road, cliff)', params: coastalRange },
  { id: 'alpine', label: 'Alpine massif', params: alpineMassif },
  { id: 'hills', label: 'Rolling hills', params: rollingHills },
  { id: 'mesa', label: 'Mesa desert', params: mesaDesert },
];

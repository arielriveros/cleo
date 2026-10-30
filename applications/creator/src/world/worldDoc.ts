// A World Creator document: the world's frame, the ordered landform stack, and the erosion passes run
// after it. Plain JSON, so it saves, diffs and travels in the export sidecar as-is.

import type { DropletParams, PipeParams, ThermalParams } from './erosion';
import type { LayerKind, WorldLayer } from './features';

export interface WorldSettings {
  /** Samples per side; 2^n + 1 so it matches the engine's terrain grids (257 .. 4097). */
  resolution: number;
  /** World units across the map. */
  size: number;
  /** World units of a normalised height of 1. */
  heightScale: number;
  seed: number;
  /** Normalised sea level, for the preview's water plane and the coast layers' default. */
  seaLevel: number;
}

export type ErosionPass =
  | { id: string; kind: 'thermal'; enabled: boolean; params: ThermalParams }
  | { id: string; kind: 'droplet'; enabled: boolean; params: DropletParams }
  | { id: string; kind: 'pipe'; enabled: boolean; params: PipeParams };

export type ErosionKind = ErosionPass['kind'];

export interface WorldDoc {
  settings: WorldSettings;
  layers: WorldLayer[];
  erosion: ErosionPass[];
}

export const RESOLUTIONS = [257, 513, 1025, 2049, 4097] as const;

let counter = 0;
/** A short id, unique within a session (documents are not merged, so this is enough). */
export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

export const LAYER_LABELS: Record<LayerKind, string> = {
  noise: 'Noise', mountain: 'Mountain', ridge: 'Ridge', valley: 'Valley', river: 'River', road: 'Road',
  plateau: 'Plateau / cliff', terrace: 'Terraces', crater: 'Crater / lake', coast: 'Coast / beach',
};

export const EROSION_LABELS: Record<ErosionKind, string> = {
  thermal: 'Thermal', droplet: 'Hydraulic (droplets)', pipe: 'Hydraulic (virtual pipes)',
};

/** A new layer of `kind` with sensible defaults, centred on the map. */
export function defaultLayer(kind: LayerKind): WorldLayer {
  const base = { id: newId(kind), name: LAYER_LABELS[kind], enabled: true, strength: 1 };
  switch (kind) {
    case 'noise': return { ...base, kind, op: 'add', fractal: 'fbm', scale: 4, octaves: 6, lacunarity: 2, gain: 0.5, warp: 0.4, amplitude: 0.3, offset: 0, seed: 1 };
    case 'mountain': return { ...base, kind, center: [0.5, 0.5], radius: 0.3, height: 0.6, sharpness: 1.4, ridges: 0.6, seed: 2 };
    case 'ridge': return { ...base, kind, points: [[0.2, 0.3], [0.5, 0.4], [0.8, 0.35]], width: 0.08, height: 0.25, sharpness: 1.5 };
    case 'valley': return { ...base, kind, points: [[0.15, 0.7], [0.5, 0.6], [0.85, 0.72]], width: 0.12, depth: 0.15 };
    case 'river': return { ...base, kind, points: [[0.3, 0.05], [0.45, 0.4], [0.55, 0.7], [0.6, 0.98]], width: 0.015, bank: 0.03, bedStart: 0.22, bedEnd: 0.08 };
    case 'road': return { ...base, kind, points: [[0.05, 0.55], [0.35, 0.5], [0.65, 0.58], [0.95, 0.5]], width: 0.012, shoulder: 0.02, smoothing: 0.4 };
    case 'plateau': return { ...base, kind, center: [0.7, 0.3], radius: 0.12, level: 0.45, falloff: 0.015 };
    case 'terrace': return { ...base, kind, steps: 8, sharpness: 0.6, minHeight: 0.2, maxHeight: 0.8 };
    case 'crater': return { ...base, kind, center: [0.3, 0.7], radius: 0.08, depth: 0.12, rim: 0.04 };
    case 'coast': return { ...base, kind, direction: 90, shoreline: 0.8, beach: 0.04, beachHeight: 0.015, seaLevel: 0.1, shelfDepth: 0.08, irregularity: 0.04, seed: 3 };
  }
}

export function defaultErosion(kind: ErosionKind): ErosionPass {
  const id = newId(kind);
  switch (kind) {
    case 'thermal': return { id, kind, enabled: true, params: { iterations: 40, talus: 38, rate: 0.5 } };
    case 'droplet': return {
      id, kind, enabled: true,
      params: { density: 300, inertia: 0.05, capacity: 4, minSlope: 0.01, erosion: 0.3, deposition: 0.3, evaporation: 0.02, gravity: 4, lifetime: 40, radius: 3, seed: 7 },
    };
    case 'pipe': return { id, kind, enabled: true, params: { iterations: 160, rain: 0.012, evaporation: 0.015, capacity: 1.2, dissolve: 0.3, deposit: 0.3, dt: 0.05 } };
  }
}

export const DEFAULT_SETTINGS: WorldSettings = { resolution: 513, size: 2048, heightScale: 600, seed: 1, seaLevel: 0.1 };

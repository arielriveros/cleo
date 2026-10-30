// Starting points for each foliage kind. A preset replaces the kind's parameters (on top of its
// defaults) and leaves the seed alone, so "Spruce" with seed 4 and seed 5 are two spruces.

import { DEFAULT_GRASS, DEFAULT_ROCK, DEFAULT_TREE, type FoliageKind, type GrassParams, type RockParams, type TreeParams } from './foliageParams';

interface PresetOf<K extends FoliageKind, P> { id: string; kind: K; label: string; description: string; params: Partial<P> }

export type FoliagePreset =
  | PresetOf<'grass', GrassParams>
  | PresetOf<'rock', RockParams>
  | PresetOf<'tree', TreeParams>;

export const FOLIAGE_PRESETS: FoliagePreset[] = [
  // --- Grass ---
  { id: 'meadow', kind: 'grass', label: 'Meadow grass', description: 'Knee-high mixed grass with a few dry blades.', params: {} },
  { id: 'tallGrass', kind: 'grass', label: 'Tall grass', description: 'Long, drooping blades in a loose clump.',
    params: { blades: 34, height: 1.05, heightVariance: 0.3, width: 0.026, bend: 0.5, curvature: 2.4, clumpRadius: 0.28, segments: 5, lod1Distance: 8, lod2Distance: 20, cullDistance: 35 } },
  { id: 'lawn', kind: 'grass', label: 'Short lawn', description: 'Dense, short, upright tufts.',
    params: { blades: 90, height: 0.14, heightVariance: 0.25, width: 0.011, bend: 0.12, tilt: 8, clumpRadius: 0.16, segments: 3, dryness: 0.04,
      baseColor: [0.07, 0.19, 0.03, 1], tipColor: [0.25, 0.45, 0.1, 1], lod1Distance: 4, lod2Distance: 10, cullDistance: 18 } },
  { id: 'steppe', kind: 'grass', label: 'Dry steppe', description: 'Sun-bleached, wiry grass.',
    params: { blades: 40, height: 0.6, width: 0.018, bend: 0.35, dryness: 0.7, baseColor: [0.2, 0.18, 0.06, 1], tipColor: [0.55, 0.48, 0.24, 1], translucency: 0.3 } },

  // --- Rock ---
  { id: 'boulder', kind: 'rock', label: 'Boulder', description: 'A weathered, rounded boulder.', params: {} },
  { id: 'cliffShard', kind: 'rock', label: 'Cliff shard', description: 'Tall, fractured, layered stone.',
    params: { size: 2.4, proportions: [0.75, 1.6, 0.65], cuts: 6, cutDepth: 0.2, sharpness: 0.75, noiseAmount: 0.12, strata: 0.45, strataFrequency: 9, flattenBottom: 0.15,
      color: [0.2, 0.2, 0.19, 1], edgeWear: 0.6 } },
  { id: 'pebble', kind: 'rock', label: 'Pebble', description: 'A small smooth river stone.',
    params: { size: 0.22, proportions: [1, 0.55, 0.8], noiseAmount: 0.05, sharpness: 0, cuts: 0, triangles: 500, flattenBottom: 0.1,
      color: [0.27, 0.25, 0.23, 1], edgeWear: 0.2, cavityDirt: 0.2, lod1Distance: 6, lod2Distance: 14, cullDistance: 30 } },
  { id: 'mossy', kind: 'rock', label: 'Mossy stone', description: 'A forest-floor rock with moss on top.',
    params: { moss: 0.65, cuts: 2, color: [0.18, 0.17, 0.16, 1], cavityDirt: 0.65 } },
  { id: 'slab', kind: 'rock', label: 'Slab', description: 'A flat sedimentary slab.',
    params: { size: 2, proportions: [1.4, 0.32, 1], strata: 0.6, strataFrequency: 5, cuts: 3, cutDepth: 0.1, sharpness: 0.5, flattenBottom: 0.4 } },

  // --- Tree ---
  { id: 'oak', kind: 'tree', label: 'Oak', description: 'A broad deciduous tree with a rounded crown.', params: {} },
  { id: 'spruce', kind: 'tree', label: 'Spruce', description: 'A conical conifer with drooping whorls of needles.',
    params: { height: 14, trunkRadius: 0.22, baseSize: 0.08, flare: 0.35, gnarliness: 0.08, crownShape: 'conical', levels: 2, rotate: 222.5, attractionUp: -0.1,
      branches1: 50, length1: 0.3, angle1: 92, curve1: -12, branches2: 6, length2: 0.42, angle2: 55, curve2: 0,
      leafKind: 'needles', leavesPerBranch: 5, leafSize: 0.6, leafSizeVariance: 0.2, leafStart: 0.05, leafNormalBend: 0.5,
      leafColor: [0.04, 0.11, 0.04, 1], leafColorVariation: 0.2, leafTranslucency: 0.25, leafRoughness: 0.75,
      barkPattern: 'plated', barkColor: [0.26, 0.15, 0.1, 1], barkScale: 0.9,
      windStrength: 0.06, windStiffness: 2, windFlutter: 0.2, lod1Distance: 18, lod2Distance: 40, impostorDistance: 55 } },
  { id: 'birch', kind: 'tree', label: 'Birch', description: 'A slender white-barked tree with weeping twigs.',
    params: { height: 13, trunkRadius: 0.14, baseSize: 0.32, flare: 0.25, gnarliness: 0.2, crownShape: 'flame', levels: 2,
      branches1: 24, length1: 0.32, angle1: 38, curve1: -26, branches2: 7, length2: 0.5, angle2: 35, curve2: -30, attractionUp: -0.2,
      leafShape: 'ovate', leafSize: 0.42, leavesPerBranch: 10, leafColor: [0.16, 0.3, 0.06, 1],
      barkPattern: 'papery', barkColor: [0.78, 0.76, 0.7, 1], barkScale: 0.7 } },
  { id: 'maple', kind: 'tree', label: 'Autumn maple', description: 'A round crown in autumn colour.',
    params: { height: 10, trunkRadius: 0.26, crownShape: 'spherical', levels: 2, branches1: 30, length1: 0.48, angle1: 55, leafShape: 'lobed',
      autumn: 0.85, leafSize: 0.5, leafTranslucency: 0.55, barkPattern: 'smooth', barkColor: [0.3, 0.26, 0.22, 1] } },
  { id: 'pine', kind: 'tree', label: 'Scots pine', description: 'A tall bare trunk carrying a high, flat crown.',
    params: { height: 18, trunkRadius: 0.3, baseSize: 0.6, crownShape: 'hemispherical', levels: 2, branches1: 22, length1: 0.32, angle1: 70, curve1: 10,
      branches2: 8, length2: 0.5, angle2: 40, leafKind: 'needles', leafSize: 0.6, leavesPerBranch: 7, leafColor: [0.07, 0.15, 0.05, 1],
      barkPattern: 'plated', barkColor: [0.42, 0.22, 0.12, 1], gnarliness: 0.35, attractionUp: 0.35 } },
  { id: 'sapling', kind: 'tree', label: 'Sapling', description: 'A young tree, a few metres tall.',
    params: { height: 3.2, trunkRadius: 0.05, baseSize: 0.35, levels: 2, branches1: 12, length1: 0.4, branches2: 5, leafSize: 0.32, leavesPerBranch: 7,
      lod1Distance: 8, lod2Distance: 20, impostorDistance: 32, cullDistance: 200 } },
];

/** The kind's parameters with a preset applied over its defaults. */
export function applyPreset(preset: FoliagePreset): GrassParams | RockParams | TreeParams {
  switch (preset.kind) {
    case 'grass': return { ...DEFAULT_GRASS, ...preset.params };
    case 'rock': return { ...DEFAULT_ROCK, ...preset.params };
    default: return { ...DEFAULT_TREE, ...preset.params };
  }
}

export const presetsFor = (kind: FoliageKind) => FOLIAGE_PRESETS.filter(p => p.kind === kind);

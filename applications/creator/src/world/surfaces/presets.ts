// Ready-made surfaces (the Surfaces section's + Add menu) and whole stacks (its biome sets). Rules lean on
// relative height and water-relative height rather than absolute metres, so a preset reads sensibly on a
// 200 m hill country and a 2 km massif alike.

import { surfaceKindInfo, type SurfaceKind } from '../../surfaces/kinds';
import { newCondition, newSurface, type SurfaceLayer } from './surfaceDoc';

const look = (kind: SurfaceKind, tint: [number, number, number] = [1, 1, 1], heightBlend?: number) =>
  ({ kind, tint, tiling: surfaceKindInfo(kind).tiling, heightBlend: heightBlend ?? surfaceKindInfo(kind).heightBlend });

export type SurfacePresetId =
  | 'grass' | 'meadow' | 'seabed' | 'beach' | 'wetSand' | 'riverbed' | 'mud' | 'dirt' | 'forest' | 'rock' | 'cliff' | 'scree' | 'gravel'
  | 'snow' | 'shadedSnow' | 'desertSand' | 'custom';

export const SURFACE_PRESETS: { id: SurfacePresetId; label: string; description: string }[] = [
  { id: 'grass', label: 'Grass', description: 'Ground cover: the usual base.' },
  { id: 'meadow', label: 'Meadow patches', description: 'Lighter grass in noisy patches on gentle ground.' },
  { id: 'seabed', label: 'Seabed', description: 'Sand under the sea and the lakes.' },
  { id: 'beach', label: 'Beach sand', description: 'Low, gentle ground just above the water.' },
  { id: 'wetSand', label: 'Wet sand', description: 'The band right at the waterline, and the shallows.' },
  { id: 'riverbed', label: 'Riverbed', description: 'Pebbles where a lot of water drains and has cut the ground.' },
  { id: 'mud', label: 'Mud', description: 'Wet, flat, low ground.' },
  { id: 'dirt', label: 'Dirt', description: 'Where erosion laid sediment down on gentle ground.' },
  { id: 'forest', label: 'Forest floor', description: 'Leaf litter in large noisy patches, away from the water.' },
  { id: 'rock', label: 'Rock slopes', description: 'Exposed rock on steep ground.' },
  { id: 'cliff', label: 'Cliff', description: 'Banded rock on near-vertical faces.' },
  { id: 'scree', label: 'Scree', description: 'Loose talus thermal erosion piled at the foot of slopes.' },
  { id: 'gravel', label: 'Gravel', description: 'Worn channels and washes.' },
  { id: 'snow', label: 'Snow', description: 'High ground that is not too steep for snow to hold.' },
  { id: 'shadedSnow', label: 'Shaded snow', description: 'Snow lower down on north-facing slopes.' },
  { id: 'desertSand', label: 'Desert sand', description: 'Sand on low, gentle ground.' },
  { id: 'custom', label: 'Custom', description: 'No rules: covers everything until you add conditions.' },
];

export function surfacePreset(id: SurfacePresetId): SurfaceLayer {
  const c = newCondition;
  switch (id) {
    case 'grass': return newSurface('Grass', look('grass'));
    case 'meadow': return newSurface('Meadow', look('grass', [1.15, 1.1, 0.75]), [
      c('slope', { min: 0, max: 20, falloffLow: 0, falloffHigh: 6 }),
      c('noise', { min: 0.55, max: 1, falloffLow: 0.12, noise: { scale: 80, octaves: 4, seed: 3, warp: 0.4 } }),
    ]);
    case 'seabed': return newSurface('Seabed', look('sand', [0.7, 0.68, 0.6]), [
      c('waterDepth', { min: 0.5, max: 10000, falloffLow: 0.5, falloffHigh: 0 }),
    ]);
    case 'beach': return newSurface('Beach sand', look('sand'), [
      c('heightAboveWater', { min: -1.5, max: 3, falloffLow: 0.5, falloffHigh: 2 }),
      c('slope', { min: 0, max: 16, falloffLow: 0, falloffHigh: 6 }),
    ]);
    case 'wetSand': return newSurface('Wet sand', look('sand', [0.62, 0.58, 0.52]), [
      c('shoreDistance', { min: -12, max: 1.5, falloffLow: 4, falloffHigh: 1.5 }),
      c('slope', { min: 0, max: 18, falloffLow: 0, falloffHigh: 6 }),
    ]);
    case 'riverbed': return newSurface('Riverbed', look('pebbles'), [
      c('flowArea', { min: 5.6, max: 9, falloffLow: 0.5, falloffHigh: 0 }),
      c('slope', { min: 0, max: 28, falloffLow: 0, falloffHigh: 6 }),
    ]);
    case 'mud': return newSurface('Mud', look('mud'), [
      c('wetness', { min: 0.6, max: 1, falloffLow: 0.15 }),
      c('slope', { min: 0, max: 10, falloffLow: 0, falloffHigh: 5 }),
      c('waterDepth', { min: 0, max: 0, falloffLow: 0, falloffHigh: 0.3 }),
    ]);
    case 'dirt': return newSurface('Dirt', look('dirt'), [
      c('deposits', { min: 0.25, max: 1, falloffLow: 0.2 }),
      c('slope', { min: 0, max: 26, falloffLow: 0, falloffHigh: 6 }),
    ]);
    case 'forest': return newSurface('Forest floor', look('forest'), [
      c('heightAboveWater', { min: 6, max: 5000, falloffLow: 4 }),
      c('slope', { min: 0, max: 30, falloffLow: 0, falloffHigh: 6 }),
      c('noise', { min: 0.5, max: 1, falloffLow: 0.1, noise: { scale: 140, octaves: 5, seed: 11, warp: 0.6 } }),
    ]);
    case 'rock': return newSurface('Rock slopes', look('rock', [0.7, 0.68, 0.66]), [
      c('slope', { min: 38, max: 90, falloffLow: 7, falloffHigh: 0 }),
    ], { breakup: { amount: 0.6, scale: 18, octaves: 4, seed: 5, warp: 0.4 } });
    case 'cliff': return newSurface('Cliff', look('cliff', [0.75, 0.7, 0.64]), [
      c('slope', { min: 50, max: 90, falloffLow: 5, falloffHigh: 0 }),
    ], { breakup: { amount: 0.4, scale: 12, octaves: 3, seed: 6, warp: 0.2 } });
    case 'scree': return newSurface('Scree', look('gravel', [0.85, 0.83, 0.8]), [
      c('talus', { min: 0.12, max: 1, falloffLow: 0.1 }),
      c('slope', { min: 14, max: 44, falloffLow: 5, falloffHigh: 6 }),
    ]);
    case 'gravel': return newSurface('Gravel', look('gravel'), [
      c('wear', { min: 0.2, max: 1, falloffLow: 0.15 }),
      c('flowArea', { min: 4.5, max: 9, falloffLow: 0.6 }),
    ]);
    case 'snow': return newSurface('Snow', look('snow'), [
      c('relativeHeight', { min: 0.72, max: 1, falloffLow: 0.06, falloffHigh: 0 }),
      c('slope', { min: 0, max: 48, falloffLow: 0, falloffHigh: 8 }),
    ], { breakup: { amount: 0.7, scale: 30, octaves: 5, seed: 7, warp: 0.5 } });
    case 'shadedSnow': return newSurface('Shaded snow', look('snow', [0.92, 0.95, 1]), [
      c('relativeHeight', { min: 0.55, max: 1, falloffLow: 0.08, falloffHigh: 0 }),
      c('aspect', { goal: 0, spread: 50, falloffHigh: 50 }),
      c('slope', { min: 4, max: 42, falloffLow: 2, falloffHigh: 8 }),
    ], { breakup: { amount: 0.7, scale: 24, octaves: 5, seed: 8, warp: 0.5 } });
    case 'desertSand': return newSurface('Desert sand', look('sand', [1.08, 0.96, 0.8]), [
      c('relativeHeight', { min: 0, max: 0.45, falloffLow: 0, falloffHigh: 0.1 }),
      c('slope', { min: 0, max: 14, falloffLow: 0, falloffHigh: 6 }),
    ]);
    case 'custom': return newSurface('Surface', look('dirt'));
  }
}

const stack = (base: SurfaceLayer, ...ids: SurfacePresetId[]) => [base, ...ids.map(surfacePreset)];

export type BiomeId = 'temperate' | 'alpine' | 'desert' | 'tropical';

export const BIOME_SETS: { id: BiomeId; label: string; description: string; make: () => SurfaceLayer[] }[] = [
  { id: 'temperate', label: 'Temperate', description: 'Grass, dirt, forest floor, beaches, mud, riverbeds, rock, scree and snow.',
    make: () => stack(surfacePreset('grass'), 'dirt', 'forest', 'seabed', 'beach', 'mud', 'riverbed', 'rock', 'scree', 'snow') },
  { id: 'alpine', label: 'Alpine', description: 'Meadows under scree, rock, cliffs and snow that lingers on north faces.',
    make: () => stack({ ...surfacePreset('grass'), name: 'Alpine meadow', preview: { ...surfacePreset('grass').preview, tint: [0.95, 1, 0.8] } },
                      'seabed', 'riverbed', 'scree', 'rock', 'cliff', 'shadedSnow', 'snow') },
  { id: 'desert', label: 'Desert', description: 'Sand, gravel washes, dry dirt fans, rock and banded cliffs.',
    make: () => stack({ ...surfacePreset('dirt'), name: 'Hardpan', conditions: [], preview: { ...surfacePreset('dirt').preview, tint: [1.1, 0.95, 0.78] } },
                      'desertSand', 'gravel', 'scree', 'rock', 'cliff') },
  { id: 'tropical', label: 'Tropical coast', description: 'Lush grass and forest down to wide beaches, wet sand and mud.',
    make: () => stack({ ...surfacePreset('grass'), preview: { ...surfacePreset('grass').preview, tint: [0.85, 1.1, 0.75] } },
                      'forest', 'seabed', 'beach', 'wetSand', 'mud', 'rock') },
];

export const defaultSurfaces = (): SurfaceLayer[] => BIOME_SETS[0].make();

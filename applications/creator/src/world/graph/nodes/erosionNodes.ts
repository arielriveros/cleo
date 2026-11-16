// Erosion nodes: the erosion filter (per sample, GPU in the realtime preview) and the three simulations
// (thermal, hydraulic droplets, hydraulic virtual pipes; CPU, pipes on the GPU at export). Simulations
// read and write whole grids over many iterations, so the realtime preview bypasses one that sits after
// the node being dragged and shows the result once it settles.

import { dropletErosion, pipeErosion, thermalErosion, type DropletParams, type PipeParams, type ThermalParams } from '../../erosion';
import { applyErosionFilter, DEFAULT_EROSION_FILTER, filterSeed, MAX_FILTER_OCTAVES, type ErosionFilterParams } from '../../erosionFilter';
import { fspec, ispec, num, plain, type NodeParams, type NodeType } from '../nodeTypes';

/** The node's parameters, complete (missing keys take the defaults). */
export function filterParams(p: NodeParams): ErosionFilterParams {
  const out = { ...DEFAULT_EROSION_FILTER };
  for (const k of Object.keys(out) as (keyof ErosionFilterParams)[]) out[k] = num(p[k], DEFAULT_EROSION_FILTER[k]);
  out.octaves = Math.max(0, Math.min(MAX_FILTER_OCTAVES, Math.round(out.octaves)));
  return out;
}

export const FILTER_PRESETS = [
  { id: 'default', label: 'Balanced', description: 'The filter\'s reference settings: branching gullies, crisp ridges.', params: { ...DEFAULT_EROSION_FILTER } },
  { id: 'soft', label: 'Soft hills', description: 'Shallow, rounded gullies for rolling country.',
    params: { ...DEFAULT_EROSION_FILTER, spacing: 420, depth: 0.12, gullyWeight: 0.7, detail: 1, octaves: 4, peakRounding: 0.4, valleyRounding: 0.3, inputRounding: 0.3 } },
  { id: 'alpine', label: 'Alpine', description: 'Deep, sharp gullies and knife-edge ridges for high mountains.',
    params: { ...DEFAULT_EROSION_FILTER, spacing: 260, depth: 0.3, gullyWeight: 0.4, detail: 2, octaves: 6, peakRounding: 0.02, valleyRounding: 0, onsetInput: 1.6 } },
  { id: 'badlands', label: 'Badlands', description: 'Dense, fine, deeply branching rills on every slope.',
    params: { ...DEFAULT_EROSION_FILTER, spacing: 120, depth: 0.35, gullyWeight: 0.6, detail: 3, octaves: 6, gain: 0.55, assumedSlope: 1, onsetInput: 2, onsetOctave: 1.6 } },
  { id: 'fine', label: 'Fine detail', description: 'Small gullies only: texture on top of a terrain already eroded.',
    params: { ...DEFAULT_EROSION_FILTER, spacing: 80, depth: 0.15, octaves: 4, detail: 1.5 } },
];

const FILTER_SCHEMA = [
  fspec('spacing', 'Gully spacing', 10, 2000, 1, 'Width of the largest gullies.', 'm'),
  fspec('depth', 'Depth', 0, 1, 0.005, 'Gully depth relative to their spacing.'),
  fspec('detail', 'Detail', 0, 5, 0.01, 'How readily finer gullies cut into the ridges and creases of coarser ones.'),
  ispec('octaves', 'Octaves', 0, MAX_FILTER_OCTAVES, 'Levels of ever finer gullies.'),
  fspec('gullyWeight', 'Gully shape', 0, 1, 0.01, 'How much of the gullies\' own rounded shape shows; lower keeps peaks pointy.'),
  fspec('peakRounding', 'Ridge rounding', 0, 2, 0.01, 'Softens the crests between gullies.'),
  fspec('valleyRounding', 'Crease rounding', 0, 2, 0.01, 'Softens the gully floors.'),
  fspec('valleyLevel', 'Valley level', -0.5, 1.5, 0.005, 'Height (fraction of the height scale) the filter treats as valley floor.'),
  fspec('peakLevel', 'Peak level', -0.5, 1.5, 0.005, 'Height it treats as summit.'),
  ispec('seed', 'Seed offset', 0, 9999),
  fspec('gain', 'Persistence', 0.1, 0.9, 0.01, 'Depth kept from one octave to the next.'),
  fspec('lacunarity', 'Lacunarity', 1.2, 3.5, 0.05, 'Spacing divisor from one octave to the next.'),
  fspec('inputRounding', 'Input rounding', 0, 2, 0.01, 'Softens where gullies start on the incoming terrain\'s own peaks and valleys.'),
  fspec('roundingFalloff', 'Rounding per octave', 0.25, 4, 0.01),
  fspec('onsetInput', 'Onset', 0, 6, 0.01, 'How steep the ground must be before gullies start.'),
  fspec('onsetOctave', 'Onset per octave', 0, 6, 0.01, 'How steep a gully must be before the next octave cuts it.'),
  fspec('onsetRidgeInput', 'Ridge map onset', 0, 8, 0.01),
  fspec('onsetRidgeOctave', 'Ridge map onset per octave', 0, 8, 0.01),
  fspec('assumedSlope', 'Assumed slope', 0, 3, 0.01, 'The steepness gullies branch as if they had.'),
  fspec('straighten', 'Straighten', 0, 1, 0.01, '0 follows the real slope\'s steepness; 1 the assumed slope (cleaner branching).'),
  fspec('cellScale', 'Cell size', 0.3, 1.5, 0.01, 'Smaller is noisier, larger distorts on curved slopes.'),
  fspec('normalization', 'Normalization', 0, 1, 0.01),
  fspec('heightBias', 'Height bias', -1, 1, 0.01, 'Lifts or sinks the result by this many times the total gully depth.'),
  fspec('keepAltitude', 'Keep altitude', 0, 1, 0.01, 'Cancels the filter\'s net raising of peaks and lowering of valleys.'),
];

const ADVANCED = ['gain', 'lacunarity', 'inputRounding', 'roundingFalloff', 'onsetInput', 'onsetOctave', 'onsetRidgeInput',
  'onsetRidgeOctave', 'assumedSlope', 'straighten', 'cellScale', 'normalization', 'heightBias', 'keepAltitude'];

const heightIn = { id: 'height', label: 'Height', type: 'height' as const };
const heightOut = { id: 'height', label: 'Height', type: 'height' as const };

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

const sim = (t: Pick<NodeType, 'type' | 'label' | 'description' | 'icon' | 'schema' | 'defaults' | 'evaluate'>): NodeType => ({
  ...t, category: 'erosion', inputs: [heightIn], outputs: [heightOut], sim: true,
});

export const EROSION_NODES: NodeType[] = [
  {
    type: 'erosionFilter', label: 'Erosion filter', category: 'erosion', icon: 'filter',
    description: 'Branching gullies and sharp ridges, fast enough to drag live. Feeds the Ridges and Gullies surface inputs.',
    inputs: [
      heightIn,
      { id: 'strength', label: 'Depth mask', type: 'mask', optional: true },
      { id: 'detail', label: 'Detail mask', type: 'mask', optional: true },
      { id: 'fade', label: 'Peak/valley mask', type: 'mask', optional: true },
    ],
    outputs: [heightOut, { id: 'ridges', label: 'Ridges', type: 'mask' }, { id: 'gullies', label: 'Gullies', type: 'mask' }],
    schema: FILTER_SCHEMA,
    advanced: ADVANCED,
    presets: FILTER_PRESETS,
    defaults: () => ({ ...DEFAULT_EROSION_FILTER }),
    gpu: 'filter',
    exact: () => false,
    evaluate: async (inputs, raw, env) => {
      const p = filterParams(raw);
      const N = env.frame.resolution ** 2;
      const input = inputs.height ?? plain(new Float32Array(N));
      const out = await applyErosionFilter(input, env.frame, p, filterSeed(env.seed, p.seed),
        { strength: inputs.strength?.h ?? null, detail: inputs.detail?.h ?? null, fade: inputs.fade?.h ?? null }, env.ctx);
      // Carved depth as a mask: 1 where the top octave's full depth was cut.
      const full = Math.max(1e-6, p.depth * p.spacing);
      const gullies = new Float32Array(N);
      for (let i = 0; i < N; i++) gullies[i] = clamp01(-out.delta[i] / full);
      return {
        outputs: { height: plain(out.height), ridges: plain(out.ridges), gullies: plain(gullies) },
        filter: { ridges: out.ridges, delta: out.delta },
      };
    },
  },
  sim({
    type: 'thermal', label: 'Thermal erosion', icon: 'thermal',
    description: 'Slopes steeper than the angle of repose slump into scree at their feet (feeds Talus).',
    schema: [ispec('iterations', 'Iterations', 0, 500), fspec('talus', 'Talus angle', 5, 85, 0.5, 'Slopes steeper than this slump.', '°'), fspec('rate', 'Rate', 0, 1, 0.01)],
    defaults: () => ({ iterations: 40, talus: 38, rate: 0.5 }),
    evaluate: async (inputs, p, env) => {
      const before = inputs.height?.h ?? new Float32Array(env.frame.resolution ** 2);
      const h = before.slice();
      await thermalErosion(h, env.frame, p as unknown as ThermalParams, env.ctx);
      return { outputs: { height: plain(h) }, history: { kind: 'thermal', before, after: h } };
    },
  }),
  sim({
    type: 'droplet', label: 'Hydraulic (droplets)', icon: 'droplet',
    description: 'Simulated raindrops cut channels and lay sediment down (feeds Wear and Deposits).',
    schema: [
      fspec('density', 'Droplets', 0, 5000, 10, 'Droplets per 1000 cells.'), fspec('inertia', 'Inertia', 0, 0.95, 0.01), fspec('capacity', 'Capacity', 0, 16, 0.1),
      fspec('minSlope', 'Min slope', 0, 0.2, 0.001), fspec('erosion', 'Erosion', 0, 1, 0.01), fspec('deposition', 'Deposition', 0, 1, 0.01),
      fspec('evaporation', 'Evaporation', 0, 0.5, 0.001), fspec('gravity', 'Gravity', 0, 20, 0.1), ispec('lifetime', 'Lifetime', 1, 200), ispec('radius', 'Brush radius', 1, 8), ispec('seed', 'Seed offset', 0, 9999),
    ],
    defaults: () => ({ density: 300, inertia: 0.05, capacity: 4, minSlope: 0.01, erosion: 0.3, deposition: 0.3, evaporation: 0.02, gravity: 4, lifetime: 40, radius: 3, seed: 7 }),
    evaluate: async (inputs, p, env) => {
      const before = inputs.height?.h ?? new Float32Array(env.frame.resolution ** 2);
      const h = before.slice();
      const params = p as unknown as DropletParams;
      await dropletErosion(h, env.frame, { ...params, seed: params.seed + env.seed * 1013 }, env.ctx);
      return { outputs: { height: plain(h) }, history: { kind: 'hydraulic', before, after: h } };
    },
  }),
  sim({
    type: 'pipe', label: 'Hydraulic (pipes)', icon: 'pipe',
    description: 'Shallow-water erosion: rain flows, carries and drops sediment across the whole map (feeds Flow, Wetness, Wear, Deposits).',
    schema: [
      ispec('iterations', 'Iterations', 0, 3000), fspec('rain', 'Rain', 0, 0.1, 0.0005), fspec('evaporation', 'Evaporation', 0, 0.5, 0.001),
      fspec('capacity', 'Capacity', 0, 8, 0.01), fspec('dissolve', 'Dissolve', 0, 1, 0.01), fspec('deposit', 'Deposit', 0, 1, 0.01), fspec('dt', 'Time step', 0.005, 0.2, 0.001),
    ],
    defaults: () => ({ iterations: 160, rain: 0.012, evaporation: 0.015, capacity: 1.2, dissolve: 0.3, deposit: 0.3, dt: 0.05 }),
    evaluate: async (inputs, p, env) => {
      const before = inputs.height?.h ?? new Float32Array(env.frame.resolution ** 2);
      const h = before.slice();
      const params = p as unknown as PipeParams;
      const gpu = env.pipeGpu;
      const pipe = gpu ? await gpu(h, env.frame, params, env.ctx) : await pipeErosion(h, env.frame, params, env.ctx);
      return { outputs: { height: plain(h) }, history: { kind: 'hydraulic', before, after: h }, pipe, pipeBackend: gpu ? 'gpu' : 'cpu' };
    },
  }),
];

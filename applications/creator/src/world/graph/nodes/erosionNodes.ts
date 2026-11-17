// Erosion nodes: the erosion filter (per sample, GPU in the realtime preview), rivers and valleys (fluvial
// erosion, fluvial.ts) and the three older simulations (thermal, hydraulic droplets, hydraulic virtual pipes;
// CPU, pipes on the GPU at export). Simulations read and write whole grids over many iterations, so the
// realtime preview bypasses one that sits after the node being dragged and shows the result once it settles.
//
// Every simulation runs on its own SIMULATION GRID (simGrid.ts), whatever resolution the world is evaluated
// at, and its parameters are in metres: the preview shows what the export will. The kernels in erosion.ts
// work in grid cells; the nodes convert.

import { cellSize, dropletErosion, pipeErosion, thermalErosion, type DropletParams, type PipeMasks, type PipeParams, type WorldFrame } from '../../erosion';
import { applyErosionFilter, DEFAULT_EROSION_FILTER, filterSeed, MAX_FILTER_OCTAVES, type ErosionFilterParams } from '../../erosionFilter';
import { DEFAULT_FLUVIAL, drainHollows, fluvialErosion } from '../../fluvial';
import { fromSimGrid, onSimGrid, SIM_GRID_OPTIONS, simGridOf, toSimGrid } from '../../simGrid';
import { espec, fspec, ispec, num, plain, type EvalEnv, type NodeParams, type NodeType } from '../nodeTypes';

/** The node's parameters, complete (missing keys take the defaults). */
export function filterParams(p: NodeParams): ErosionFilterParams {
  const out = { ...DEFAULT_EROSION_FILTER };
  for (const k of Object.keys(out) as (keyof ErosionFilterParams)[]) out[k] = num(p[k], DEFAULT_EROSION_FILTER[k]);
  out.octaves = Math.max(0, Math.min(MAX_FILTER_OCTAVES, Math.round(out.octaves)));
  return out;
}

// The looks are filters for land that already drains (Rivers and valleys before them cut its valleys): gullies at
// most about a sixth as deep as they are apart. Deeper, over six octaves, they stood the land up in spikes.
export const FILTER_PRESETS = [
  { id: 'default', label: 'Balanced', description: 'The filter\'s reference settings: branching gullies, crisp ridges.', params: { ...DEFAULT_EROSION_FILTER } },
  { id: 'soft', label: 'Soft hills', description: 'Shallow, rounded gullies for rolling country.',
    params: { ...DEFAULT_EROSION_FILTER, spacing: 420, depth: 0.08, gullyWeight: 0.7, detail: 1, octaves: 4, peakRounding: 0.4, valleyRounding: 0.3, inputRounding: 0.3 } },
  { id: 'alpine', label: 'Alpine', description: 'Deep, sharp gullies and knife-edge ridges for high mountains.',
    params: { ...DEFAULT_EROSION_FILTER, spacing: 160, depth: 0.16, gullyWeight: 0.4, detail: 2, octaves: 6, peakRounding: 0.02, valleyRounding: 0, onsetInput: 1.6 } },
  { id: 'badlands', label: 'Badlands', description: 'Dense, fine, deeply branching rills on every slope.',
    params: { ...DEFAULT_EROSION_FILTER, spacing: 120, depth: 0.18, gullyWeight: 0.6, detail: 3, octaves: 6, gain: 0.55, assumedSlope: 1, onsetInput: 2, onsetOctave: 1.6 } },
  { id: 'fine', label: 'Fine detail', description: 'Small gullies only: texture on top of a terrain already eroded.',
    params: { ...DEFAULT_EROSION_FILTER, spacing: 80, depth: 0.1, octaves: 4, detail: 1.5 } },
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

/** The simulation grid a node runs on, and its frame (the kernels' cells are that grid's). */
function simFrame(p: NodeParams, env: EvalEnv): { G: number; frame: WorldFrame; cell: number } {
  const G = simGridOf(p.grid, 513);
  const frame = { resolution: G, size: env.frame.size, heightScale: env.frame.heightScale };
  return { G, frame, cell: cellSize(frame) };
}

const GRID_SPEC = espec('grid', 'Simulation grid', SIM_GRID_OPTIONS,
  'Samples a side the simulation runs on, whatever the preview or export resolution: finer catches smaller features and takes longer.');

/** Metres, as a whole number of the simulation grid's cells (at least one). */
const inCells = (metres: unknown, fallback: number, cell: number) => Math.max(1, Math.round(num(metres, fallback) / cell));

export const DEFAULT_THERMAL = { reach: 160, talus: 38, rate: 0.5, grid: '513' };
// Tuned on true slopes (the kernel runs in cells, where a step's drop is the slope itself): gravity of 4, a
// figure from heightmaps scaled 0..1, accelerated every droplet into a scouring jet that left the ground pitted.
export const DEFAULT_DROPLET = { density: 300, inertia: 0.05, capacity: 4, minSlope: 0.01, erosion: 0.1, deposition: 0.3, evaporation: 0.02, gravity: 0.25, travel: 160, brush: 16, seed: 7, grid: '513' };
export const DEFAULT_PIPE = { reach: 640, rain: 0.012, evaporation: 0.015, capacity: 1.2, dissolve: 0.3, deposit: 0.3, dt: 0.05, grid: '513' };

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
  {
    type: 'fluvial', label: 'Rivers and valleys', category: 'erosion', icon: 'fluvial',
    description: "Rivers cut the land into valleys that join and fall to the sea or the map's edge; ridges are what is left. Feeds Wear, Deposits and Flow.",
    inputs: [heightIn, { id: 'hardness', label: 'Hardness', type: 'mask', optional: true }],
    outputs: [heightOut, { id: 'flow', label: 'Flow', type: 'mask' }],
    schema: [
      fspec('age', 'Age', 0, 4, 0.01, 'How long the rivers have cut: 0.2 young (valleys near the outlets, the drawn shape kept), 1 mature, 3 the shape the rivers give.'),
      fspec('talus', 'Steepest slope', 10, 70, 0.5, 'The steepest a hillside stands.', '°'),
      fspec('rounding', 'Rounding', 0, 1000, 1, 'How far soil creep rounds crests and creases; also how close the smallest valleys lie.', 'm'),
      GRID_SPEC,
      fspec('concavity', 'Valley profile', 0.3, 0.7, 0.01, 'How fast rivers flatten downstream: higher gives long, flat lower valleys under steep heads.'),
      fspec('channelArea', 'Channels from', 0, 5e6, 1000, 'Drainage area below which the ground barely cuts: more leaves smooth hillsides between fewer, larger valleys.', 'm²'),
      fspec('fill', 'Basin fill', 0, 1, 0.01, 'How far hollows silt up: 1 leaves no closed hollow (no lakes); less leaves the deepest as basins.'),
    ],
    advanced: ['concavity', 'channelArea', 'fill'],
    defaults: () => ({ ...DEFAULT_FLUVIAL, grid: '513' }),
    sim: true,
    readsSea: true,
    evaluate: async (inputs, p, env) => {
      const R = env.frame.resolution, N = R * R;
      const before = inputs.height?.h ?? new Float32Array(N);
      const { G, cell } = simFrame(p, env);
      const kh = env.frame.heightScale;
      const g = toSimGrid(before, R, G);
      for (let i = 0; i < g.length; i++) g[i] *= kh;
      const start = Float64Array.from(g);
      const hard = inputs.hardness ? toSimGrid(inputs.hardness.h, R, G) : null;
      const params = { ...DEFAULT_FLUVIAL };
      for (const k of Object.keys(params) as (keyof typeof params)[]) params[k] = num(p[k], DEFAULT_FLUVIAL[k]);
      const { area } = await fluvialErosion(g, G, cell, (env.seaLevel ?? 0) * kh, params, hard, env.ctx);
      // What it changed, at the evaluated resolution, on the input as it came.
      const change = new Float64Array(G * G);
      for (let i = 0; i < change.length; i++) change[i] = (g[i] - start[i]) / kh;
      const back = fromSimGrid(change, G, R);
      const after = new Float32Array(N);
      for (let i = 0; i < N; i++) after[i] = before[i] + back[i];
      // Flow: the area draining through a point, from a thousand square metres (0) to the whole map (1).
      const lo = 3, hi = Math.max(lo + 1, Math.log10(env.frame.size * env.frame.size));
      const flowG = new Float32Array(G * G);
      for (let i = 0; i < flowG.length; i++) flowG[i] = Math.min(1, Math.max(0, (Math.log10(Math.max(1, area[i])) - lo) / (hi - lo)));
      const flow = fromSimGrid(flowG, G, R);
      for (let i = 0; i < N; i++) flow[i] = Math.min(1, Math.max(0, flow[i]));
      return { outputs: { height: plain(after), flow: plain(flow) }, history: { kind: 'hydraulic', before, after } };
    },
  },
  {
    type: 'drain', label: 'Drain', category: 'erosion', icon: 'drain',
    description: 'Fills every closed hollow to the level it spills at, so water runs off: the pits a filter after Rivers and valleys leaves. Lakes you want go after it.',
    inputs: [heightIn], outputs: [heightOut], schema: [], defaults: () => ({}),
    // A whole-map flood: bypassed while something before it is dragged, as a simulation is.
    sim: true,
    readsSea: true,
    evaluate: (inputs, _p, env) => {
      const N = env.frame.resolution ** 2, kh = env.frame.heightScale;
      const before = inputs.height?.h ?? new Float32Array(N);
      const z = Float64Array.from(before, v => v * kh);
      drainHollows(z, env.frame.resolution, (env.seaLevel ?? 0) * kh);
      return { outputs: { height: plain(Float32Array.from(z, v => v / kh)) } };
    },
  },
  sim({
    type: 'thermal', label: 'Thermal erosion', icon: 'thermal',
    description: 'Slopes steeper than the angle of repose slump into scree at their feet (feeds Talus).',
    schema: [
      fspec('reach', 'Reach', 0, 5000, 1, 'How far scree travels from where it falls.', 'm'),
      fspec('talus', 'Talus angle', 5, 85, 0.5, 'Slopes steeper than this slump.', '°'), fspec('rate', 'Rate', 0, 1, 0.01),
      GRID_SPEC,
    ],
    defaults: () => ({ ...DEFAULT_THERMAL }),
    evaluate: async (inputs, p, env) => {
      const R = env.frame.resolution;
      const before = inputs.height?.h ?? new Float32Array(R * R);
      const { G, frame, cell } = simFrame(p, env);
      // Material moves a cell an iteration at most: the reach in cells is the iterations.
      const params = { iterations: Math.round(num(p.reach, DEFAULT_THERMAL.reach) / cell), talus: num(p.talus, DEFAULT_THERMAL.talus), rate: num(p.rate, DEFAULT_THERMAL.rate) };
      const h = await onSimGrid(before, R, G, g => thermalErosion(g, frame, params, env.ctx));
      return { outputs: { height: plain(h) }, history: { kind: 'thermal', before, after: h } };
    },
  }),
  sim({
    type: 'droplet', label: 'Hydraulic (droplets)', icon: 'droplet',
    description: 'Simulated raindrops cut channels and lay sediment down (feeds Wear and Deposits).',
    schema: [
      fspec('density', 'Droplets', 0, 5000, 10, 'Droplets per 1000 cells of the simulation grid.'), fspec('inertia', 'Inertia', 0, 0.95, 0.01), fspec('capacity', 'Capacity', 0, 16, 0.1),
      fspec('minSlope', 'Min slope', 0, 0.2, 0.001), fspec('erosion', 'Erosion', 0, 1, 0.01), fspec('deposition', 'Deposition', 0, 1, 0.01),
      fspec('evaporation', 'Evaporation', 0, 0.5, 0.001), fspec('gravity', 'Gravity', 0, 20, 0.1),
      fspec('travel', 'Travel', 1, 5000, 1, 'How far a droplet runs before it is spent.', 'm'),
      fspec('brush', 'Brush radius', 1, 200, 0.5, 'How wide a droplet cuts.', 'm'),
      ispec('seed', 'Seed offset', 0, 9999),
      GRID_SPEC,
    ],
    defaults: () => ({ ...DEFAULT_DROPLET }),
    evaluate: async (inputs, p, env) => {
      const R = env.frame.resolution;
      const before = inputs.height?.h ?? new Float32Array(R * R);
      const { G, frame, cell } = simFrame(p, env);
      const d = DEFAULT_DROPLET;
      const params: DropletParams = {
        density: num(p.density, d.density), inertia: num(p.inertia, d.inertia), capacity: num(p.capacity, d.capacity),
        minSlope: num(p.minSlope, d.minSlope), erosion: num(p.erosion, d.erosion), deposition: num(p.deposition, d.deposition),
        evaporation: num(p.evaporation, d.evaporation), gravity: num(p.gravity, d.gravity),
        lifetime: inCells(p.travel, d.travel, cell), radius: inCells(p.brush, d.brush, cell),
        seed: num(p.seed, d.seed) + env.seed * 1013,
      };
      const h = await onSimGrid(before, R, G, g => dropletErosion(g, frame, params, env.ctx));
      return { outputs: { height: plain(h) }, history: { kind: 'hydraulic', before, after: h } };
    },
  }),
  sim({
    type: 'pipe', label: 'Hydraulic (pipes)', icon: 'pipe',
    description: 'Shallow-water erosion: rain flows, carries and drops sediment across the whole map (feeds Flow, Wetness, Wear, Deposits).',
    schema: [
      fspec('reach', 'Reach', 0, 50000, 1, 'How far water runs over the simulation: a cell a step at most.', 'm'),
      fspec('rain', 'Rain', 0, 0.1, 0.0005), fspec('evaporation', 'Evaporation', 0, 0.5, 0.001),
      fspec('capacity', 'Capacity', 0, 8, 0.01), fspec('dissolve', 'Dissolve', 0, 1, 0.01), fspec('deposit', 'Deposit', 0, 1, 0.01), fspec('dt', 'Time step', 0.005, 0.2, 0.001),
      GRID_SPEC,
    ],
    defaults: () => ({ ...DEFAULT_PIPE }),
    evaluate: async (inputs, p, env) => {
      const R = env.frame.resolution;
      const before = inputs.height?.h ?? new Float32Array(R * R);
      const { G, frame, cell } = simFrame(p, env);
      const d = DEFAULT_PIPE;
      const params: PipeParams = {
        iterations: Math.round(num(p.reach, d.reach) / cell), rain: num(p.rain, d.rain), evaporation: num(p.evaporation, d.evaporation),
        capacity: num(p.capacity, d.capacity), dissolve: num(p.dissolve, d.dissolve), deposit: num(p.deposit, d.deposit), dt: num(p.dt, d.dt),
      };
      const gpu = env.pipeGpu;
      let masks: PipeMasks | null = null;
      const h = await onSimGrid(before, R, G, async g => {
        masks = gpu ? await gpu(g, frame, params, env.ctx) : await pipeErosion(g, frame, params, env.ctx);
      });
      const m = masks as unknown as PipeMasks;
      const pipe = G === R ? m : { flow: fromSimGrid(m.flow, G, R), water: fromSimGrid(m.water, G, R) };
      return { outputs: { height: plain(h) }, history: { kind: 'hydraulic', before, after: h }, pipe, pipeBackend: gpu ? 'gpu' : 'cpu' };
    },
  }),
];

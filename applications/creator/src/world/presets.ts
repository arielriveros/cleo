// World Creator presets. Each is a whole document built as a graph; picking one replaces the terrain
// (the graph and the settings) but keeps the artist's seed and surfaces, which is how a preset becomes a
// family of variations. A fresh document of a preset starts with the surfaces that suit it.
//
// The terrain under an erosion filter is kept smooth (few octaves): the filter steers each gully by the
// slope it is given, so fine bumps there turn the gullies cell by cell into noise. The filter adds the
// detail.
//
// The erosion filter sits where the realtime preview can drag it: after the base shapes, the big
// landforms and any simulation (a simulation after it would be skipped while dragging, and its settling
// would visibly change the look), before the roads and rivers (which belong on the eroded ground, and
// which the drag skips until it settles).

import type { Preset } from '../core/generator';
import { GraphBuilder } from './graph/build';
import { FILTER_PRESETS } from './graph/nodes/erosionNodes';
import { OUTPUT_PORT } from './graph/nodeTypes';
import { BIOME_SETS, type BiomeId } from './surfaces/presets';
import { DEFAULT_SETTINGS, worldExtras, type WorldDoc, type WorldSettings } from './worldDoc';

/** The document parts besides the graph, with the surfaces of `biome`. */
const extras = (biome: BiomeId) => ({ ...worldExtras(), surfaces: BIOME_SETS.find(b => b.id === biome)!.make() });

const filter = (id: string, over: Record<string, unknown> = {}) => ({ ...FILTER_PRESETS.find(p => p.id === id)!.params, ...over });

function doc(biome: BiomeId, settings: Partial<WorldSettings>, build: (g: GraphBuilder) => void): WorldDoc {
  const g = new GraphBuilder();
  build(g);
  return { ...extras(biome), settings: { ...DEFAULT_SETTINGS, ...settings }, graph: g.build() };
}

/**
 * The research doc's exit test for terrain, as a preset: a mountain, a beach, a road and a cliff on one
 * map, eroded, ready to hand to the Editor's landscape import.
 */
export function coastalRange(): WorldDoc {
  return doc('temperate', {}, g => {
    const base = g.add('fractal', { fractal: 'fbm', scale: 3, octaves: 3, gain: 0.35, amplitude: 0.22, offset: 0.12, warp: 0.6 }, 'Base relief');
    const peak = g.add('mountain', { center: [0.35, 0.35], radius: 0.32, height: 0.62, sharpness: 1.6, ridges: 0.15 }, 'Main peak');
    const spur = g.add('ridge', { points: [[0.35, 0.35], [0.6, 0.25], [0.88, 0.18]], width: 0.07, height: 0.18 }, 'Spur');
    const cliff = g.add('plateau', { center: [0.78, 0.62], radius: 0.13, level: 0.28, falloff: 0.012 }, 'Sea cliff');
    const coast = g.add('coast', { direction: 90, shoreline: 0.82, beach: 0.05, seaLevel: 0.1 }, 'Coast');
    const erode = g.add('erosionFilter', filter('default', { valleyLevel: 0.1, peakLevel: 0.65 }), 'Erosion');
    const scree = g.add('thermal', { iterations: 30, talus: 40, rate: 0.5 }, 'Scree');
    const river = g.add('river', { points: [[0.42, 0.55], [0.5, 0.7], [0.45, 0.85], [0.5, 1.0]], bedStart: 0.2, bedEnd: 0.07 }, 'River');
    const road = g.add('road', { points: [[0.05, 0.7], [0.3, 0.68], [0.6, 0.74], [0.95, 0.7]], width: 0.01, shoulder: 0.025, smoothing: 0.5 }, 'Coast road');
    const out = g.add('output');
    g.chain(base, peak, spur, cliff, coast, scree, erode, river, road);
    g.link(road, out, OUTPUT_PORT);
  });
}

export function rollingHills(): WorldDoc {
  return doc('temperate', { heightScale: 220 }, g => {
    const hills = g.add('fractal', { fractal: 'billow', scale: 3.5, octaves: 3, gain: 0.35, amplitude: 0.55, warp: 0.8 }, 'Hills');
    const detail = g.add('fractal', { fractal: 'fbm', scale: 8, octaves: 2, amplitude: 0.06, offset: -0.03, seed: 9 }, 'Detail');
    const sum = g.add('combine', { op: 'add', strength: 1 }, 'Hills + detail');
    const vale = g.add('valley', { points: [[0.0, 0.4], [0.4, 0.55], [1.0, 0.45]], width: 0.18, depth: 0.2 }, 'Vale');
    const erode = g.add('erosionFilter', filter('soft', { valleyLevel: 0.05, peakLevel: 0.5 }), 'Erosion');
    const out = g.add('output');
    g.link(hills, sum, 'a').link(detail, sum, 'b');
    g.chain(sum, vale, erode);
    g.link(erode, out, OUTPUT_PORT);
  });
}

export function alpineMassif(): WorldDoc {
  return doc('alpine', { heightScale: 1800 }, g => {
    const ranges = g.add('fractal', { fractal: 'ridged', scale: 2.5, octaves: 3, gain: 0.4, amplitude: 0.85, warp: 0.5 }, 'Ranges');
    const summit = g.add('mountain', { center: [0.55, 0.45], radius: 0.25, height: 0.35, sharpness: 2.2, ridges: 0.2 }, 'Summit');
    const valley = g.add('valley', { points: [[0.1, 0.9], [0.4, 0.65], [0.6, 0.6], [0.95, 0.75]], width: 0.16, depth: 0.3 }, 'Glacial valley');
    const erode = g.add('erosionFilter', filter('alpine', { valleyLevel: 0.15, peakLevel: 0.9 }), 'Erosion');
    const scree = g.add('thermal', { iterations: 60, talus: 42, rate: 0.5 }, 'Scree');
    const out = g.add('output');
    g.chain(ranges, summit, valley, scree, erode);
    g.link(erode, out, OUTPUT_PORT);
  });
}

export function mesaDesert(): WorldDoc {
  return doc('desert', { heightScale: 350, seaLevel: 0 }, g => {
    const ground = g.add('fractal', { fractal: 'fbm', scale: 2, octaves: 3, gain: 0.35, amplitude: 0.25, warp: 1.2 }, 'Ground');
    const mesa = g.add('plateau', { center: [0.35, 0.4], radius: 0.16, level: 0.6, falloff: 0.02 }, 'Mesa');
    const butte = g.add('plateau', { center: [0.7, 0.65], radius: 0.07, level: 0.5, falloff: 0.012 }, 'Butte');
    const strata = g.add('terrace', { steps: 10, sharpness: 0.8, minHeight: 0.15, maxHeight: 0.65 }, 'Strata');
    const erode = g.add('erosionFilter', filter('badlands', { spacing: 160, depth: 0.18, valleyLevel: 0.1, peakLevel: 0.6 }), 'Erosion');
    const lake = g.add('crater', { center: [0.75, 0.25], radius: 0.1, depth: 0.08, rim: 0.01 }, 'Dry lake');
    const out = g.add('output');
    g.chain(ground, mesa, butte, strata, erode, lake);
    g.link(lake, out, OUTPUT_PORT);
  });
}

/** A continent's worth of coast and highlands, eroded twice: broad drainage, then fine gullies. */
export function erodedHighlands(): WorldDoc {
  return doc('temperate', { size: 4096, heightScale: 900 }, g => {
    const land = g.add('continental', { scale: 1.6, coast: 0.42, highlands: 0.75, mountainStart: 0.55 }, 'Continent');
    const ranges = g.add('fractal', { fractal: 'ridged', scale: 4, octaves: 3, gain: 0.35, amplitude: 0.35, warp: 0.3, seed: 12 }, 'Ranges');
    const high = g.add('heightMask', { min: 0.25, max: 2, falloff: 0.2 }, 'Highlands');
    const sum = g.add('combine', { op: 'add', strength: 1 }, 'Ranges on highlands');
    const broad = g.add('erosionFilter', filter('default', { spacing: 700, depth: 0.14, octaves: 4, valleyLevel: 0.05, peakLevel: 0.9 }), 'Broad drainage');
    const fine = g.add('erosionFilter', filter('fine', { spacing: 120, valleyLevel: 0.05, peakLevel: 0.9, seed: 3 }), 'Fine gullies');
    const out = g.add('output');
    g.link(land, high).link(land, sum, 'a').link(ranges, sum, 'b').link(high, sum, 'mask', 'mask');
    g.chain(sum, broad, fine);
    g.link(fine, out, OUTPUT_PORT);
  });
}

/** Soft rock cut to ribbons: dense, deep rills over gentle swells. */
export function badlands(): WorldDoc {
  return doc('desert', { size: 1024, heightScale: 180, seaLevel: 0 }, g => {
    const swell = g.add('fractal', { fractal: 'fbm', scale: 2.5, octaves: 4, amplitude: 0.7, warp: 0.8 }, 'Swells');
    const shape = g.add('remap', { inMin: 0.2, inMax: 0.8, outMin: 0, outMax: 1, power: 1.6 }, 'Steepen');
    const erode = g.add('erosionFilter', filter('badlands', { valleyLevel: 0.1, peakLevel: 0.85 }), 'Rills');
    const out = g.add('output');
    g.chain(swell, shape, erode);
    g.link(erode, out, OUTPUT_PORT);
  });
}

/**
 * An island in open sea: a dome of land a kilometre across rising to a peak, a lake in a basin on its
 * shoulder and a tarn on the other, a stream down the mountain into the lake and a river from the lake down
 * to the sea, eroded. The sea
 * is everything below `seaLevel`; the lake comes out of the water pass (priority flood) where the basin
 * holds water. What the Island example is built from (tools/island/).
 */
export function island(): WorldDoc {
  const world = doc('temperate', { heightScale: 320, seaLevel: 0.1, seed: 7 }, g => {
    const dome = g.add('gradient', { mode: 'radial', from: -0.45, to: 0.42, extent: 0.6, center: [0.5, 0.5] }, 'Island dome');
    const relief = g.add('fractal', { fractal: 'fbm', scale: 3.5, octaves: 3, gain: 0.4, amplitude: 0.11, warp: 1.1, seed: 3 }, 'Coastline relief');
    const land = g.add('combine', { op: 'add', strength: 1 }, 'Land');
    const peak = g.add('mountain', { center: [0.43, 0.4], radius: 0.22, height: 0.48, sharpness: 1.4, ridges: 0.2 }, 'Peak');
    const ridge = g.add('ridge', { points: [[0.43, 0.4], [0.32, 0.52], [0.3, 0.64]], width: 0.06, height: 0.12 }, 'West ridge');
    const basin = g.add('crater', { center: [0.6, 0.58], radius: 0.075, depth: 0.11, rim: 0.025 }, 'Lake basin');
    const tarn = g.add('crater', { center: [0.36, 0.62], radius: 0.045, depth: 0.08, rim: 0.02 }, 'Tarn basin');
    const scree = g.add('thermal', { iterations: 30, talus: 38, rate: 0.5 }, 'Scree');
    const erode = g.add('erosionFilter', filter('soft', { spacing: 200, depth: 0.09, valleyLevel: 0.1, peakLevel: 0.7 }), 'Erosion');
    // The rivers run where the land sends its water (traced over this terrain before they are cut): the stream
    // that feeds the lake, down the mountain's shoulder into it, and the lake's own way out over its rim to the
    // sea. Each bed starts a little under the ground at its head and ends a little under the water it reaches,
    // so the cut is a stream bed, never a canyon, and the upper one stops no water short of the lake.
    const upper = g.add('river', {
      points: [[0.501, 0.4814], [0.5098, 0.4824], [0.5166, 0.4814], [0.5234, 0.4805], [0.5303, 0.4854], [0.5352, 0.4951],
               [0.5391, 0.5059], [0.5449, 0.5176], [0.5527, 0.5215], [0.5576, 0.5283], [0.5625, 0.5352], [0.5674, 0.542],
               [0.5723, 0.5488], [0.5732, 0.5596], [0.5732, 0.5713], [0.5742, 0.5801], [0.5781, 0.5889]],
      width: 0.0035, bank: 0.006, bedStart: 0.565, bedEnd: 0.297,
    }, 'Peak river');
    const lower = g.add('river', {
      points: [[0.666, 0.5957], [0.6719, 0.6035], [0.6738, 0.6152], [0.6816, 0.627], [0.6963, 0.6309], [0.7168, 0.6338],
               [0.7363, 0.6377], [0.7559, 0.6416], [0.7695, 0.6455]],
      width: 0.0045, bank: 0.008, bedStart: 0.2978, bedEnd: 0.0953,
    }, 'Lake outflow');
    const out = g.add('output');
    g.link(dome, land, 'a').link(relief, land, 'b');
    g.chain(land, peak, ridge, basin, tarn, scree, erode, upper, lower);
    g.link(lower, out, OUTPUT_PORT);
  });
  // Small basins count: a tarn of a hectare is a lake here.
  world.water = { ...world.water, lakes: { ...world.water.lakes, minArea: 6000, minDepth: 2 } };
  return world;
}

export const WORLD_PRESETS: readonly Preset<() => WorldDoc>[] = [
  { id: 'island', label: 'Island (sea, lake, rivers)', params: island },
  { id: 'coastal-range', label: 'Coastal range (mountain, beach, road, cliff)', params: coastalRange },
  { id: 'alpine', label: 'Alpine massif', params: alpineMassif },
  { id: 'hills', label: 'Rolling hills', params: rollingHills },
  { id: 'mesa', label: 'Mesa desert', params: mesaDesert },
  { id: 'highlands', label: 'Eroded highlands (two erosion filters)', params: erodedHighlands },
  { id: 'badlands', label: 'Badlands', params: badlands },
];

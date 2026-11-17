// World Creator presets. Each is a whole document built as a graph; picking one replaces the terrain (the
// graph and the settings) and brings the surfaces that suit it unless the document's own have been edited
// (ui/WorldWorkspace.tsx applyPreset). The seed stays the artist's: every preset drains whatever the seed,
// so a seed is a variation of it.
//
// Every preset is built the same way, the way real land is:
//   1. A broad, smooth SHAPE that says where the land stands high: noise with few octaves under a ramp or a
//      dome. Nothing finer than a valley: the next step makes the valleys.
//   2. RIVERS AND VALLEYS (fluvial.ts): the shape is where the land rises, and the rivers cut it into
//      valleys that join and fall to the sea or the map's edge, with ridges left between them and hillsides
//      no steeper than their talus angle. No closed hollows are left (they would all be lakes).
//   3. A fine EROSION FILTER: the gullies too small for the simulation's grid.
//   4. FINISHING: DRAIN (the filter's pits filled, so the only lakes are the ones meant), then a lake basin
//      where one is wanted. Built things (a road) follow ground a seed moves, so they are left to the artist.
//
// And at real proportions: each map is as large as its landscape is (a massif 8 km across, an island 2 km),
// and its relief what such land has, so its slopes are a real landscape's (hill country 5 to 15 degrees on
// average, mountain flanks 25 to 35). tools/world/renderPresets.ts draws them all and prints those figures.

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
 * An island in open sea, a mile and a half across and 280 m high: a massif off its centre, ridges and
 * valleys running from it to a coast of bays and headlands, and a lake in a basin on its north-east valley,
 * fed by the stream from the heights and spilling down to the sea. What the Island example is built from
 * (tools/island/).
 */
export function island(): WorldDoc {
  const world = doc('temperate', { size: 2048, heightScale: 320, seaLevel: 0.1, seed: 7 }, g => {
    const dome = g.add('gradient', { mode: 'radial', from: -0.2, to: 0.4, extent: 0.9, center: [0.5, 0.5] }, 'Island dome');
    const massif = g.add('gradient', { mode: 'radial', from: 0, to: 0.35, extent: 0.3, center: [0.44, 0.42] }, 'Massif');
    const folds = g.add('fractal', { fractal: 'fbm', scale: 2.2, octaves: 4, gain: 0.5, amplitude: 0.7, offset: -0.35, warp: 1.5, seed: 3 }, 'Bays and headlands');
    const land = g.add('combine', { op: 'add', strength: 1 }, 'Land');
    const high = g.add('combine', { op: 'add', strength: 1 }, 'With the massif');
    const rivers = g.add('fluvial', { age: 1, talus: 32, rounding: 20 }, 'Rivers and valleys');
    const onLand = g.add('heightMask', { min: 0.11, max: 2, falloff: 0.02 }, 'On land');
    const gullies = g.add('erosionFilter', filter('fine', { spacing: 50, valleyLevel: 0.1, peakLevel: 1 }), 'Gullies');
    const drain = g.add('drain', {}, 'Drain');
    // A basin deep enough to hold water on a slope this steep, with no rim, so the valley above runs into it,
    // its walls then slumped to scree.
    const basin = g.add('crater', { center: [0.664, 0.379], radius: 0.05, depth: 0.25, rim: 0 }, 'Lake basin');
    const slump = g.add('thermal', { reach: 80, talus: 32, rate: 0.5 }, 'Basin walls');
    const out = g.add('output');
    g.link(dome, land, 'a').link(folds, land, 'b').link(land, high, 'a').link(massif, high, 'b');
    g.chain(high, rivers, gullies, drain, basin, slump);
    g.link(rivers, onLand).link(onLand, gullies, 'strength', 'mask');
    g.link(slump, out, OUTPUT_PORT);
  });
  // A lake of a hectare or two counts.
  world.water = { ...world.water, lakes: { ...world.water.lakes, minArea: 6000, minDepth: 2 } };
  return world;
}

/** A coastal mountain range four kilometres deep: ranges falling straight to the sea, their valleys drowned into bays. */
export function coastalRange(): WorldDoc {
  return doc('temperate', { size: 4096, heightScale: 900, seaLevel: 0.08 }, g => {
    const slope = g.add('gradient', { mode: 'linear', angle: -90, from: -0.25, to: 0.85, extent: 1.1 }, 'Rising inland');
    const ranges = g.add('fractal', { fractal: 'ridged', scale: 2.5, octaves: 4, gain: 0.45, amplitude: 0.55, offset: -0.2, warp: 0.6 }, 'Ranges');
    const folds = g.add('fractal', { fractal: 'fbm', scale: 2, octaves: 3, gain: 0.5, amplitude: 0.3, offset: -0.15, warp: 0.9, seed: 6 }, 'Folds');
    const a = g.add('combine', { op: 'add', strength: 1 }, 'Ranges inland');
    const b = g.add('combine', { op: 'add', strength: 1 }, 'Folded');
    const rivers = g.add('fluvial', { age: 1.2, talus: 35, rounding: 50 }, 'Rivers and valleys');
    const gullies = g.add('erosionFilter', filter('fine', { spacing: 90, valleyLevel: 0.08, peakLevel: 0.9 }), 'Gullies');
    const onLand = g.add('heightMask', { min: 0.085, max: 2, falloff: 0.01 }, 'On land');
    const drain = g.add('drain', {}, 'Drain');
    const out = g.add('output');
    g.link(slope, a, 'a').link(ranges, a, 'b').link(a, b, 'a').link(folds, b, 'b');
    g.chain(b, rivers, gullies, drain);
    g.link(rivers, onLand).link(onLand, gullies, 'strength', 'mask');
    g.link(drain, out, OUTPUT_PORT);
  });
}

/** An alpine massif eight kilometres across and 2.2 km high: sharp ridges, deep valleys, snow on the heights. */
export function alpineMassif(): WorldDoc {
  return doc('alpine', { size: 8192, heightScale: 2200, seaLevel: 0 }, g => {
    const envelope = g.add('fractal', { fractal: 'fbm', scale: 1.5, octaves: 3, gain: 0.5, amplitude: 1.6, offset: -0.45, warp: 0.4, seed: 5 }, 'Massif');
    const ranges = g.add('fractal', { fractal: 'ridged', scale: 3, octaves: 3, gain: 0.45, amplitude: 0.5, offset: -0.1, warp: 0.6 }, 'Ranges');
    const sum = g.add('combine', { op: 'add', strength: 1 }, 'Ranges on the massif');
    const rivers = g.add('fluvial', { age: 1, talus: 35, rounding: 80 }, 'Rivers and valleys');
    const gullies = g.add('erosionFilter', filter('alpine', { valleyLevel: 0.05, peakLevel: 1 }), 'Gullies');
    const drain = g.add('drain', {}, 'Drain');
    const out = g.add('output');
    g.link(envelope, sum, 'a').link(ranges, sum, 'b');
    g.chain(sum, rivers, gullies, drain);
    g.link(drain, out, OUTPUT_PORT);
  });
}

/** Rolling hill country four kilometres across: rounded hills 170 m high, broad vales, streams in every fold. */
export function rollingHills(): WorldDoc {
  return doc('temperate', { size: 4096, heightScale: 170, seaLevel: 0 }, g => {
    const hills = g.add('fractal', { fractal: 'fbm', scale: 8, octaves: 3, gain: 0.5, amplitude: 1.3, offset: -0.15, warp: 0.6 }, 'Hills');
    const rivers = g.add('fluvial', { age: 0.8, talus: 20, rounding: 80, channelArea: 40000 }, 'Rivers and valleys');
    const gullies = g.add('erosionFilter', filter('soft', { valleyLevel: 0, peakLevel: 1 }), 'Gullies');
    const drain = g.add('drain', {}, 'Drain');
    const out = g.add('output');
    g.chain(hills, rivers, gullies, drain);
    g.link(drain, out, OUTPUT_PORT);
  });
}

/**
 * Mesa country four kilometres across: tablelands under a hard caprock, cut back by canyons into mesas and
 * buttes with steep, banded walls over scree.
 */
export function mesaDesert(): WorldDoc {
  const world = doc('desert', { size: 4096, heightScale: 350, seaLevel: 0 }, g => {
    const ground = g.add('fractal', { fractal: 'fbm', scale: 2.5, octaves: 4, gain: 0.5, amplitude: 1.6, offset: -0.1, warp: 0.9 }, 'Ground');
    const tables = g.add('terrace', { steps: 2, sharpness: 0.95, minHeight: 0, maxHeight: 1.2 }, 'Tablelands');
    const strata = g.add('terrace', { steps: 16, sharpness: 0.3, minHeight: 0.05, maxHeight: 1.2 }, 'Strata');
    const cap = g.add('heightMask', { min: 0.55, max: 2, falloff: 0.03 }, 'Caprock');
    const rivers = g.add('fluvial', { age: 0.8, talus: 58, rounding: 6, channelArea: 20000 }, 'Canyons');
    const drain = g.add('drain', {}, 'Drain');
    const out = g.add('output');
    g.chain(ground, tables, strata, rivers, drain);
    g.link(tables, cap).link(cap, rivers, 'hardness', 'mask');
    g.link(drain, out, OUTPUT_PORT);
  });
  // A desert holds no standing water.
  world.water = { ...world.water, lakes: { ...world.water.lakes, enabled: false } };
  return world;
}

/** Old highlands eight kilometres across falling to a coast: broad ridges worn round, long branching valleys. */
export function erodedHighlands(): WorldDoc {
  return doc('temperate', { size: 8192, heightScale: 900, seaLevel: 0.08 }, g => {
    const land = g.add('continental', { scale: 1.4, octaves: 4, coast: 0.35, highlands: 0.9, mountainStart: 0.5 }, 'Land and sea');
    const ranges = g.add('fractal', { fractal: 'ridged', scale: 3, octaves: 3, gain: 0.4, amplitude: 0.35, offset: -0.1, warp: 0.4, seed: 12 }, 'Ranges');
    const high = g.add('heightMask', { min: 0.25, max: 2, falloff: 0.2 }, 'Highlands');
    const sum = g.add('combine', { op: 'add', strength: 1 }, 'Ranges on the highlands');
    const rivers = g.add('fluvial', { age: 1.5, talus: 32, rounding: 100 }, 'Rivers and valleys');
    const gullies = g.add('erosionFilter', filter('fine', { spacing: 160, valleyLevel: 0.08, peakLevel: 1 }), 'Gullies');
    const onLand = g.add('heightMask', { min: 0.085, max: 2, falloff: 0.01 }, 'On land');
    const drain = g.add('drain', {}, 'Drain');
    const out = g.add('output');
    g.link(land, high).link(land, sum, 'a').link(ranges, sum, 'b').link(high, sum, 'mask', 'mask');
    g.chain(sum, rivers, gullies, drain);
    g.link(rivers, onLand).link(onLand, gullies, 'strength', 'mask');
    g.link(drain, out, OUTPUT_PORT);
  });
}

/** Badlands a kilometre across: soft clay cut into a dense maze of steep rills and knife-edged ridges, 70 m deep. */
export function badlands(): WorldDoc {
  return doc('desert', { size: 1024, heightScale: 70, seaLevel: 0 }, g => {
    const swell = g.add('fractal', { fractal: 'fbm', scale: 2.5, octaves: 4, gain: 0.5, amplitude: 1.4, offset: -0.2, warp: 0.8 }, 'Swells');
    const rivers = g.add('fluvial', { age: 1.5, talus: 45, rounding: 6 }, 'Rills and gullies');
    const drain = g.add('drain', {}, 'Drain');
    const out = g.add('output');
    g.chain(swell, rivers, drain);
    g.link(drain, out, OUTPUT_PORT);
  });
}

export const WORLD_PRESETS: readonly Preset<() => WorldDoc>[] = [
  { id: 'island', label: 'Island', description: '2 km of island in open sea, 280 m high: a massif, valleys to the coast, a lake.', params: island },
  { id: 'coastal-range', label: 'Coastal range', description: '4 km of mountains falling to the sea, 900 m: steep ranges, their valleys drowned into bays.', params: coastalRange },
  { id: 'alpine', label: 'Alpine massif', description: '8 km of high mountains, 2.2 km: sharp ridges, deep valleys, snow on the heights.', params: alpineMassif },
  { id: 'hills', label: 'Rolling hills', description: '4 km of hill country, 170 m: rounded hills, broad vales, streams in every fold.', params: rollingHills },
  { id: 'mesa', label: 'Mesa desert', description: '4 km of tablelands under a caprock, 350 m: mesas, buttes and canyons.', params: mesaDesert },
  { id: 'highlands', label: 'Eroded highlands', description: '8 km of old highlands falling to a coast, 900 m: broad worn ridges, long valleys.', params: erodedHighlands },
  { id: 'badlands', label: 'Badlands', description: '1 km of soft clay cut into a maze of steep rills and sharp ridges, 70 m.', params: badlands },
];

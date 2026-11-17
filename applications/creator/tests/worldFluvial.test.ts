import { describe, it, expect } from 'vitest';
import { SILENT_CONTEXT } from '../src/core/generator';
import { dropletErosion, type WorldFrame } from '../src/world/erosion';
import { DEFAULT_FLUVIAL, fluvialErosion, type FluvialParams } from '../src/world/fluvial';
import { generateWorld } from '../src/world/generateWorld';
import { GraphBuilder } from '../src/world/graph/build';
import { nodeKeys } from '../src/world/graph/evaluate';
import { OUTPUT_PORT } from '../src/world/graph/nodeTypes';
import { evaluationOrder } from '../src/world/graph/graphDoc';
import { fromSimGrid, toSimGrid } from '../src/world/simGrid';
import { terrainStats, slopeDegrees, percentile } from '../src/world/terrainStats';
import { normaliseWorld, type WorldDoc } from '../src/world/worldDoc';

// Rivers and valleys (fluvial.ts): the stream power law, solved implicitly up the drainage, on land drawn
// as the uplift. What it must leave is land that DRAINS: no closed hollows, every cell's water reaching
// the sea or the map's edge, channels that steepen upstream as real ones do (Flint's law), hillsides no
// steeper than the talus angle; the relief it was drawn with; and the same valleys at any resolution.

/** An island of `res` samples on 2048 m: a dome folded by noise, 320 m high, the sea at 32 m (metres). */
async function island(res: number): Promise<{ z: Float64Array; cell: number; sea: number }> {
  const g = new GraphBuilder();
  const dome = g.add('gradient', { mode: 'radial', from: -0.4, to: 0.6, extent: 0.55, center: [0.5, 0.5] });
  const relief = g.add('fractal', { fractal: 'fbm', scale: 3.5, octaves: 5, gain: 0.5, amplitude: 0.5, offset: -0.25, warp: 1.1, seed: 3 });
  const land = g.add('combine', { op: 'add', strength: 1 });
  const out = g.add('output');
  g.link(dome, land, 'a').link(relief, land, 'b').link(land, out, OUTPUT_PORT);
  const doc = normaliseWorld({ version: 4, settings: { resolution: res, size: 2048, heightScale: 320, seed: 1, seaLevel: 0.1 }, graph: g.build() });
  const o = await generateWorld(doc, SILENT_CONTEXT, { resolution: res });
  return { z: Float64Array.from(o.heights, h => h * 320), cell: 2048 / (res - 1), sea: 32 };
}

async function eroded(res: number, over: Partial<FluvialParams> = {}, hardness: Float32Array | null = null) {
  const { z, cell, sea } = await island(res);
  const before = Float64Array.from(z);
  const { area } = await fluvialErosion(z, res, cell, sea, { ...DEFAULT_FLUVIAL, rounding: 20, ...over }, hardness);
  return { before, z, area, cell, sea };
}

describe('rivers and valleys', () => {
  it('leaves land that drains: no closed hollows, and channels that steepen upstream', async () => {
    const res = 257;
    const { before, z, cell, sea } = await eroded(res);
    const drawn = terrainStats(Float32Array.from(before), res, cell, sea);
    const after = terrainStats(Float32Array.from(z), res, cell, sea, { hollowDepth: 0.05 });
    expect(after.hollows).toBe(0);
    // Flint's law: slope falls as a power of the area draining through (theta 0.35..0.6 in real rivers);
    // noise has none (the drawn island's is about 0.1).
    expect(drawn.concavity).toBeLessThan(0.2);
    expect(after.concavity).toBeGreaterThan(0.25);
    expect(after.concavity).toBeLessThan(0.8);
  });

  it('holds hillsides to the talus angle, and keeps the height the land was drawn at', async () => {
    const res = 257;
    for (const talus of [30, 38]) {
      const { z, cell } = await eroded(res, { talus, rounding: 0 });
      const slope = slopeDegrees(Float32Array.from(z), res, cell);
      // Central differences read a ridge's two faces together, so a hair past the angle.
      expect(percentile(slope, 0.99)).toBeLessThan(talus + 1.5);
    }
    // The island is a kilometre across and 320 m high: at 40 degrees it can stand as high as it was drawn.
    const { before, z, sea } = await eroded(res, { talus: 40 });
    const top = (a: Float64Array) => percentile(Array.from(a, v => v - sea).filter(v => v > 0), 0.995);
    expect(Math.abs(top(z) / top(before) - 1)).toBeLessThan(0.05);
  });

  it('changes nothing at age 0, and the same land the same way every time', async () => {
    const res = 129;
    const still = await eroded(res, { age: 0 });
    expect(Array.from(still.z)).toEqual(Array.from(still.before));
    const a = await eroded(res), b = await eroded(res);
    expect(Array.from(a.z)).toEqual(Array.from(b.z));
  });

  it('leaves hard rock standing where soft rock is cut', async () => {
    const res = 129;
    // A band of hard rock across the island's middle.
    const hard = new Float32Array(res * res);
    for (let r = 0; r < res; r++) for (let c = 0; c < res; c++) if (Math.abs(r - res / 2) < res / 10) hard[r * res + c] = 1;
    const soft = await eroded(res, { age: 2 });
    const capped = await eroded(res, { age: 2 }, hard);
    // How far the band stands above the land around it.
    const standing = (z: Float64Array) => {
      let a = 0, na = 0, b = 0, nb = 0;
      for (let i = 0; i < res * res; i++) {
        if (z[i] <= 32) continue;
        if (hard[i] > 0) { a += z[i]; na++; } else { b += z[i]; nb++; }
      }
      return a / na - b / nb;
    };
    expect(standing(capped.z)).toBeGreaterThan(standing(soft.z) + 20);
  });

  it('cuts the same valleys whatever resolution the world is evaluated at', async () => {
    const doc = (resolution: number): WorldDoc => {
      const g = new GraphBuilder();
      const land = g.add('fractal', { fractal: 'fbm', scale: 2, octaves: 4, gain: 0.5, amplitude: 1.6, offset: -0.4, warp: 0.5, seed: 4 });
      const rivers = g.add('fluvial', { grid: '129', rounding: 40 });
      const out = g.add('output');
      g.link(land, rivers).link(rivers, out, OUTPUT_PORT);
      return normaliseWorld({ version: 4, settings: { resolution, size: 4096, heightScale: 600, seed: 1, seaLevel: 0 }, graph: g.build() });
    };
    const coarse = await generateWorld(doc(129), SILENT_CONTEXT, { resolution: 129 });
    const fine = await generateWorld(doc(257), SILENT_CONTEXT, { resolution: 257 });
    // At the coarse grid's samples, the fine one (the same simulation, its change interpolated) agrees.
    let sa = 0, sb = 0, sab = 0, saa = 0, sbb = 0;
    const n = 129 * 129;
    for (let r = 0; r < 129; r++) for (let c = 0; c < 129; c++) {
      const a = coarse.heights[r * 129 + c], b = fine.heights[(r * 2) * 257 + c * 2];
      sa += a; sb += b; sab += a * b; saa += a * a; sbb += b * b;
    }
    const corr = (sab / n - (sa / n) * (sb / n)) / Math.sqrt((saa / n - (sa / n) ** 2) * (sbb / n - (sb / n) ** 2));
    expect(corr).toBeGreaterThan(0.995);
  });

  it('is keyed on the sea level, and nothing else is', () => {
    const g = new GraphBuilder();
    const land = g.add('fractal', {});
    const rivers = g.add('fluvial', {});
    const out = g.add('output');
    g.link(land, rivers).link(rivers, out, OUTPUT_PORT);
    const graph = g.build();
    const order = evaluationOrder(graph, out);
    const env = (seaLevel: number) => ({ frame: { resolution: 65, size: 2048, heightScale: 600 }, seed: 1, seaLevel, paintMeta: [] });
    const a = nodeKeys(graph, order, env(0.1)), b = nodeKeys(graph, order, env(0.2));
    expect(a.get(land)).toBe(b.get(land));
    expect(a.get(rivers)).not.toBe(b.get(rivers));
  });
});

describe('the simulation grid', () => {
  it('takes every n-th sample going coarser where grids nest, and interpolates going finer', () => {
    const R = 9, G = 5;
    const h = Float32Array.from({ length: R * R }, (_, i) => i);
    const g = toSimGrid(h, R, G);
    for (let r = 0; r < G; r++) for (let c = 0; c < G; c++) expect(g[r * G + c]).toBe(h[r * 2 * R + c * 2]);
    // A plane comes back a plane (Catmull-Rom reproduces linear functions).
    const plane = Float64Array.from({ length: G * G }, (_, i) => (i % G) * 2 + Math.floor(i / G) * 3);
    const up = fromSimGrid(plane, G, R);
    for (let r = 0; r < R; r++) for (let c = 0; c < R; c++) expect(up[r * R + c]).toBeCloseTo(c + r * 1.5, 4);
  });
});

describe('droplets', () => {
  it('speed up going downhill and cut a long slope all the way down', async () => {
    // A 30 degree plane falling along +x, in cell units (a height of 1 is a cell).
    const res = 65, frame: WorldFrame = { resolution: res, size: 64, heightScale: 1 };
    const h = new Float32Array(res * res);
    for (let r = 0; r < res; r++) for (let c = 0; c < res; c++) h[r * res + c] = (res - c) * Math.tan(Math.PI / 6);
    const before = h.slice();
    await dropletErosion(h, frame, { density: 300, inertia: 0.05, capacity: 4, minSlope: 0.01, erosion: 0.1, deposition: 0.3, evaporation: 0.02, gravity: 0.25, lifetime: 60, radius: 2, seed: 3 });
    // Cut in the lower half too: a droplet that stalled (its speed lost going downhill) cut only where it began.
    let lower = 0;
    for (let r = 4; r < res - 4; r++) for (let c = (res - 1) / 2; c < res - 4; c++) lower += Math.max(0, before[r * res + c] - h[r * res + c]);
    expect(lower).toBeGreaterThan(1);
  });
});

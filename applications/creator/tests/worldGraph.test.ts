import { describe, it, expect } from 'vitest';
import { fnv1a, SILENT_CONTEXT } from '../src/core/generator';
import { applyLayer, LAYER_DEFAULTS, type WorldLayer } from '../src/world/features';
import { dropletErosion, pipeErosion, thermalErosion, type PipeMasks, type WorldFrame } from '../src/world/erosion';
import { computeMasks } from '../src/world/masks';
import { generateWorld } from '../src/world/generateWorld';
import { worldExportHash } from '../src/world/exportWorld';
import { layoutGraph } from '../src/world/graph/build';
import { evaluateGraph, GraphCache } from '../src/world/graph/evaluate';
import { connect, graphKey, outputNode, wouldCycle, type WorldGraph } from '../src/world/graph/graphDoc';
import { graphFromStack, LEGACY_SIM_DEFAULTS, normaliseGraph, type LegacyErosionPass } from '../src/world/graph/migrate';
import { nodeType, NODE_TYPE_LIST } from '../src/world/graph/nodeRegistry';
import { shapePoint, shapeUniform } from '../src/world/graph/nodes/shapes';
import { combinePoint } from '../src/world/graph/nodes/combine';
import type { EvalEnv } from '../src/world/graph/nodeTypes';
import { blankMask, decodeMask, encodeMask, paintHash, sampleMask } from '../src/world/paint';
import { WORLD_PRESETS } from '../src/world/presets';
import { DEFAULT_SETTINGS, normaliseWorld, type WorldDoc } from '../src/world/worldDoc';

const hash = (a: Float32Array) => fnv1a(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
const layer = <K extends WorldLayer['kind']>(kind: K, patch: Partial<Extract<WorldLayer, { kind: K }>>, id: string): WorldLayer =>
  ({ ...LAYER_DEFAULTS[kind](), ...patch, id } as WorldLayer);
const pass = (kind: LegacyErosionPass['kind'], id: string, params: Record<string, unknown> = {}, enabled = true): LegacyErosionPass =>
  ({ id, kind, enabled, params: { ...LEGACY_SIM_DEFAULTS[kind], ...params } });

/** The World Creator's generate() before the graph, verbatim in substance: the reference migration must match. */
async function legacyGenerate(layers: WorldLayer[], erosion: LegacyErosionPass[], settings: WorldDoc['settings']) {
  const resolution = settings.resolution;
  const frame: WorldFrame = { resolution, size: settings.size, heightScale: settings.heightScale };
  const heights = new Float32Array(resolution * resolution);
  for (const l of layers.filter(x => x.enabled)) applyLayer(heights, { resolution, seed: settings.seed }, l);
  const N = heights.length;
  const history = { deposits: new Float32Array(N), wear: new Float32Array(N), talus: new Float32Array(N) };
  let pipe: PipeMasks | null = null;
  const before = new Float32Array(N);
  for (const p of erosion.filter(x => x.enabled)) {
    before.set(heights);
    const params = p.params as never;
    if (p.kind === 'thermal') await thermalErosion(heights, frame, params);
    else if (p.kind === 'droplet') await dropletErosion(heights, frame, { ...(p.params as object), seed: (p.params.seed as number) + settings.seed * 1013 } as never);
    else pipe = await pipeErosion(heights, frame, params);
    const k = settings.heightScale;
    if (p.kind === 'thermal') { for (let i = 0; i < N; i++) { const d = heights[i] - before[i]; if (d > 0) history.talus[i] += d * k; } }
    else for (let i = 0; i < N; i++) { const d = heights[i] - before[i]; if (d > 0) history.deposits[i] += d * k; else if (d < 0) history.wear[i] -= d * k; }
  }
  return { heights, history, masks: computeMasks(heights, frame, pipe) };
}

/** The four presets as they were before the graph (version-2 stacks). */
const LEGACY: { id: string; settings: Partial<WorldDoc['settings']>; layers: WorldLayer[]; erosion: LegacyErosionPass[] }[] = [
  { id: 'coastal', settings: {}, layers: [
    layer('noise', { name: 'Base relief', fractal: 'fbm', scale: 3, octaves: 6, amplitude: 0.22, offset: 0.12, warp: 0.6 }, 'a'),
    layer('mountain', { center: [0.35, 0.35], radius: 0.32, height: 0.62, sharpness: 1.6, ridges: 0.7 }, 'b'),
    layer('ridge', { points: [[0.35, 0.35], [0.6, 0.25], [0.88, 0.18]], width: 0.07, height: 0.18 }, 'c'),
    layer('plateau', { center: [0.78, 0.62], radius: 0.13, level: 0.28, falloff: 0.012 }, 'd'),
    layer('river', { points: [[0.42, 0.55], [0.5, 0.7], [0.45, 0.85], [0.5, 1.0]], bedStart: 0.2, bedEnd: 0.07 }, 'e'),
    layer('coast', { direction: 90, shoreline: 0.82, beach: 0.05, seaLevel: 0.1 }, 'f'),
    layer('road', { points: [[0.05, 0.7], [0.3, 0.68], [0.6, 0.74], [0.95, 0.7]], width: 0.01, shoulder: 0.025, smoothing: 0.5 }, 'g'),
  ], erosion: [pass('thermal', 'h'), pass('pipe', 'i', { iterations: 40 })] },
  { id: 'hills', settings: { heightScale: 220 }, layers: [
    layer('noise', { fractal: 'billow', scale: 3.5, octaves: 5, gain: 0.45, amplitude: 0.55, warp: 0.8 }, 'a'),
    layer('noise', { fractal: 'fbm', scale: 16, octaves: 4, amplitude: 0.06, offset: -0.03, seed: 9 }, 'b'),
    layer('valley', { points: [[0.0, 0.4], [0.4, 0.55], [1.0, 0.45]], width: 0.18, depth: 0.2 }, 'c'),
  ], erosion: [pass('droplet', 'd'), pass('thermal', 'e')] },
  { id: 'alpine', settings: { heightScale: 1800 }, layers: [
    layer('noise', { fractal: 'ridged', scale: 2.5, octaves: 8, gain: 0.55, amplitude: 0.85, warp: 0.5 }, 'a'),
    layer('mountain', { center: [0.55, 0.45], radius: 0.25, height: 0.35, sharpness: 2.2, ridges: 0.9 }, 'b'),
    layer('valley', { points: [[0.1, 0.9], [0.4, 0.65], [0.6, 0.6], [0.95, 0.75]], width: 0.16, depth: 0.3 }, 'c'),
  ], erosion: [pass('pipe', 'd', { iterations: 30 }), pass('thermal', 'e', { iterations: 60, talus: 42 })] },
  { id: 'mesa', settings: { heightScale: 350, seaLevel: 0 }, layers: [
    layer('noise', { fractal: 'fbm', scale: 2, octaves: 5, amplitude: 0.25, warp: 1.2 }, 'a'),
    { ...layer('plateau', { center: [0.35, 0.4], radius: 0.16, level: 0.6, falloff: 0.02 }, 'b'), enabled: false },
    layer('plateau', { center: [0.7, 0.65], radius: 0.07, level: 0.5, falloff: 0.012 }, 'c'),
    layer('terrace', { steps: 10, sharpness: 0.8, minHeight: 0.15, maxHeight: 0.65 }, 'd'),
    layer('crater', { center: [0.75, 0.25], radius: 0.1, depth: 0.08, rim: 0.01 }, 'e'),
  ], erosion: [pass('thermal', 'f'), pass('droplet', 'g', {}, false), pass('droplet', 'h')] },
];

describe('migration from the landform stack', () => {
  for (const legacy of LEGACY) {
    it(`evaluates the "${legacy.id}" stack bit for bit as before`, async () => {
      const settings = { ...DEFAULT_SETTINGS, ...legacy.settings, resolution: 49 };
      const doc = normaliseWorld({ version: 2, settings, layers: legacy.layers, erosion: legacy.erosion });
      expect(doc.version).toBe(4);
      const now = await generateWorld(doc);
      const then = await legacyGenerate(legacy.layers, legacy.erosion, settings);
      expect(hash(now.heights)).toBe(hash(then.heights));
      for (const k of ['deposits', 'wear', 'talus'] as const) expect(hash(now.history[k]), k).toBe(hash(then.history[k]));
      for (const k of Object.keys(then.masks) as (keyof typeof then.masks)[]) expect(hash(now.masks[k]), k).toBe(hash(then.masks[k]));
    });
  }

  it('lays a stack out as one chain into the Output', () => {
    const g = graphFromStack(LEGACY[1].layers, LEGACY[1].erosion);
    expect(g.nodes.map(n => n.type)).toEqual(['noiseLayer', 'noiseLayer', 'valley', 'droplet', 'thermal', 'output']);
    expect(g.edges.length).toBe(5);
    expect(outputNode(g)?.id).toBe('output');
  });

  it('normalising is idempotent', () => {
    const once = normaliseWorld({ version: 2, settings: DEFAULT_SETTINGS, layers: LEGACY[0].layers, erosion: LEGACY[0].erosion });
    expect(normaliseWorld(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });
});

const env = (resolution: number, over: Partial<EvalEnv> = {}): EvalEnv => ({
  frame: { resolution, size: 2048, heightScale: 600 }, seed: 1, paint: {}, paintMeta: [], ctx: SILENT_CONTEXT, ...over,
});

describe('graph evaluation', () => {
  const chain = (): WorldGraph => normaliseGraph({
    nodes: [
      { id: 'n', type: 'fractal', name: 'n', enabled: true, params: { scale: 3 }, x: 0, y: 0 },
      { id: 'm', type: 'mountain', name: 'm', enabled: true, params: {}, x: 0, y: 0 },
      { id: 'f', type: 'erosionFilter', name: 'f', enabled: true, params: { octaves: 3 }, x: 0, y: 0 },
      { id: 'output', type: 'output', name: 'o', enabled: true, params: {}, x: 0, y: 0 },
    ],
    edges: [
      { id: '1', from: { node: 'n', port: 'height' }, to: { node: 'm', port: 'height' } },
      { id: '2', from: { node: 'm', port: 'height' }, to: { node: 'f', port: 'height' } },
      { id: '3', from: { node: 'f', port: 'height' }, to: { node: 'output', port: 'height' } },
    ],
  });

  it('re-runs only the edited node and what reads from it', async () => {
    const cache = new GraphCache();
    const g = chain();
    const first = await evaluateGraph(g, env(33), cache);
    expect([...first.nodes.values()].every(n => n.ran)).toBe(true);
    const edited: WorldGraph = { ...g, nodes: g.nodes.map(n => (n.id === 'm' ? { ...n, params: { ...n.params, height: 0.3 } } : n)) };
    const second = await evaluateGraph(edited, env(33), cache);
    expect(second.nodes.get('n')!.ran).toBe(false);
    expect(second.nodes.get('m')!.ran).toBe(true);
    expect(second.nodes.get('f')!.ran).toBe(true);
    // Moving a node or renaming it is layout: nothing re-runs.
    const moved: WorldGraph = { ...edited, nodes: edited.nodes.map(n => ({ ...n, x: n.x + 50, name: 'renamed' })) };
    const third = await evaluateGraph(moved, env(33), cache);
    expect([...third.nodes.values()].some(n => n.ran)).toBe(false);
    expect(graphKey(moved)).toBe(graphKey(edited));
  });

  it('a disabled node passes its input through', async () => {
    const g = chain();
    const off: WorldGraph = { ...g, nodes: g.nodes.map(n => (n.id === 'f' ? { ...n, enabled: false } : n)) };
    const run = await evaluateGraph(off, env(33));
    expect(hash(run.heights)).toBe(hash(run.nodes.get('m')!.result.outputs.height.h));
  });

  it('records the filter: ridges and carved gullies', async () => {
    const run = await evaluateGraph(chain(), env(33));
    expect(run.history.gullies!.some(v => v > 0)).toBe(true);
    expect(run.history.ridges!.some(v => v !== 0.5)).toBe(true);
  });

  it('refuses edges that would close a loop', () => {
    const g = chain();
    expect(wouldCycle(g, 'f', 'n')).toBe(true);
    expect(connect(g, { node: 'f', port: 'height' }, { node: 'n', port: 'height' }, 'x')).toBe(g);
    // And a stored loop is dropped on load.
    const looped = normaliseGraph({ ...g, edges: [...g.edges, { id: 'loop', from: { node: 'f', port: 'height' }, to: { node: 'm', port: 'height' } }] });
    expect(looped.edges.some(e => e.id === 'loop')).toBe(false);
  });

  it('keeps one Output and drops edges to ports that do not exist', () => {
    const g = normaliseGraph({
      nodes: [{ id: 'a', type: 'output', name: '', enabled: true, params: {}, x: 0, y: 0 }, { id: 'b', type: 'output', name: '', enabled: true, params: {}, x: 0, y: 0 },
              { id: 'c', type: 'fractal', name: '', enabled: true, params: {}, x: 0, y: 0 }],
      edges: [{ id: 'e', from: { node: 'c', port: 'nope' }, to: { node: 'a', port: 'height' } }],
    });
    expect(g.nodes.filter(n => n.type === 'output').length).toBe(1);
    expect(g.edges.length).toBe(0);
  });

  it('every node type evaluates on unconnected inputs to finite outputs of the grid size', async () => {
    for (const t of NODE_TYPE_LIST) {
      const node = { id: 'x', type: t.type, name: t.label, enabled: true, params: t.defaults(), x: 0, y: 0 };
      const res = await t.evaluate({}, t.defaults(), env(17), node);
      for (const o of t.outputs) {
        const f = res.outputs[o.id];
        expect(f, `${t.type}.${o.id}`).toBeDefined();
        expect(f.h.length).toBe(17 * 17);
        expect(f.h.every(Number.isFinite), `${t.type}.${o.id}`).toBe(true);
      }
    }
  });

  it('lays out a graph in columns by depth', () => {
    const g = layoutGraph(chain());
    const x = Object.fromEntries(g.nodes.map(n => [n.id, n.x]));
    expect(x.n).toBeLessThan(x.m);
    expect(x.m).toBeLessThan(x.f);
    expect(x.f).toBeLessThan(x.output);
  });
});

describe('shape nodes', () => {
  const near = (types: [string, Record<string, unknown>][]) => {
    const o = [0, 0, 0], a = [0, 0, 0], b = [0, 0, 0];
    const e = 1e-6;
    for (const [type, params] of types) {
      const s = shapeUniform(type, { ...nodeType(type)!.defaults(), ...params }, 3);
      for (const [u, v] of [[0.21, 0.37], [0.63, 0.12], [0.88, 0.91]]) {
        shapePoint(s, u, v, o);
        const du = (shapePoint(s, u + e, v, a)[0] - shapePoint(s, u - e, v, b)[0]) / (2 * e);
        const dv = (shapePoint(s, u, v + e, a)[0] - shapePoint(s, u, v - e, b)[0]) / (2 * e);
        expect(o[1], `${type} d/du`).toBeCloseTo(du, 3);
        expect(o[2], `${type} d/dv`).toBeCloseTo(dv, 3);
      }
    }
  };

  it('carry exact gradients, warp included', () => {
    near([
      ['fractal', { fractal: 'fbm', warp: 0 }], ['fractal', { fractal: 'fbm', warp: 0.8 }],
      ['fractal', { fractal: 'billow', warp: 0.3 }], ['fractal', { fractal: 'ridged', warp: 0.5 }],
      ['continental', {}], ['gradient', { mode: 'linear', angle: 30 }], ['gradient', { mode: 'radial' }],
    ]);
  });

  it('combine carries the gradient through add and multiply', () => {
    const o = [0, 0, 0];
    combinePoint(0, 1, 1, 2, 3, 4, 5, 6, o);
    expect(o).toEqual([5, 7, 9]);
    combinePoint(4, 0.5, 2, 1, 0, 3, 0, 1, o);
    // a + (a*b - a) * 0.5 = 2 + (6 - 2) / 2 = 4; d/du = 1 + (1*3 + 0 - 1) / 2 = 2; d/dv = 0 + (0 + 2*1 - 0) / 2 = 1.
    expect(o).toEqual([4, 2, 1]);
  });
});

describe('paint masks', () => {
  it('round-trip through a 16-bit PNG with the same hash', async () => {
    const res = 32;
    const px = blankMask(res);
    for (let i = 0; i < px.length; i++) px[i] = (i % res) / (res - 1);
    const bytes = await encodeMask(px, res, false);
    const back = await decodeMask(bytes, false);
    expect(back.resolution).toBe(res);
    expect(paintHash(back.pixels, false)).toBe(paintHash(px, false));
    const signed = px.map(v => v * 2 - 1);
    const sb = await decodeMask(await encodeMask(signed, res, true), true);
    expect(paintHash(sb.pixels, true)).toBe(paintHash(signed, true));
  });

  it('sample onto any grid', () => {
    const px = blankMask(8).fill(0.75);
    expect(sampleMask(px, 8, 17).every(v => Math.abs(v - 0.75) < 1e-6)).toBe(true);
  });

  it('a stroke changes the paint node and its readers, and the export hash', async () => {
    const meta = { id: 'm1', name: 'Mask', resolution: 8, signed: false, hash: paintHash(blankMask(8), false) };
    const doc = normaliseWorld({
      settings: { ...DEFAULT_SETTINGS, resolution: 17 }, paint: [meta],
      graph: {
        nodes: [
          { id: 'p', type: 'paint', name: 'p', enabled: true, params: { mask: 'm1' }, x: 0, y: 0 },
          { id: 'n', type: 'fractal', name: 'n', enabled: true, params: {}, x: 0, y: 0 },
          { id: 'f', type: 'erosionFilter', name: 'f', enabled: true, params: { octaves: 2 }, x: 0, y: 0 },
          { id: 'output', type: 'output', name: 'o', enabled: true, params: {}, x: 0, y: 0 },
        ],
        edges: [
          { id: '1', from: { node: 'n', port: 'height' }, to: { node: 'f', port: 'height' } },
          { id: '2', from: { node: 'p', port: 'mask' }, to: { node: 'f', port: 'strength' } },
          { id: '3', from: { node: 'f', port: 'height' }, to: { node: 'output', port: 'height' } },
        ],
      },
    });
    const off = await generateWorld(doc, SILENT_CONTEXT, { paint: { m1: blankMask(8) } });
    const full = blankMask(8).fill(1);
    const painted = { ...doc, paint: [{ ...meta, hash: paintHash(full, false) }] };
    const on = await generateWorld(painted, SILENT_CONTEXT, { paint: { m1: full } });
    expect(hash(on.heights)).not.toBe(hash(off.heights));
    // An unpainted depth mask switches the filter off: the heights are the noise's.
    const noise = await generateWorld({ ...doc, graph: { ...doc.graph, nodes: doc.graph.nodes.map(n => (n.id === 'f' ? { ...n, enabled: false } : n)) } }, SILENT_CONTEXT, { paint: { m1: blankMask(8) } });
    expect(hash(off.heights)).toBe(hash(noise.heights));
    expect(worldExportHash(painted)).not.toBe(worldExportHash(doc));
  });
});

describe('presets', () => {
  it('every preset is a valid graph whose export hash ignores node positions', async () => {
    for (const p of WORLD_PRESETS) {
      const doc = normaliseWorld(p.params());
      expect(outputNode(doc.graph), p.id).toBeDefined();
      const moved = { ...doc, graph: { ...doc.graph, nodes: doc.graph.nodes.map(n => ({ ...n, x: n.x * 2 + 7, y: -n.y })) } };
      expect(worldExportHash(moved)).toBe(worldExportHash(doc));
      // Its simulations on a grid as small as the world, so the graph is checked rather than the erosion.
      const graph = { ...doc.graph, nodes: doc.graph.nodes.map(n => ('grid' in (nodeType(n.type)?.defaults() ?? {}) ? { ...n, params: { ...n.params, grid: '33' } } : n)) };
      const out = await generateWorld({ ...doc, graph, settings: { ...doc.settings, resolution: 33 } });
      expect(out.heights.every(Number.isFinite), p.id).toBe(true);
    }
  });
});

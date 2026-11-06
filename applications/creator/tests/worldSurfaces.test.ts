import { describe, it, expect } from 'vitest';
import { compositeWeights } from 'cleo/terrain/terrainLayers';
import { decodePngChannels, readWorldManifest, weightPlanesFromImages, weightPlanesToAlphaPlanes } from 'cleo/terrain/splatmapIO';
import { readZip, writeZip } from '../src/core/zip';
import { encodeExrFloat } from '../src/core/exr';
import { distanceTransform } from '../src/world/edt';
import { computeWater, priorityFlood, upstreamArea, WATER_LAKE, WATER_SEA, DEFAULT_LAKES } from '../src/world/lakes';
import { computeFields, fieldNeeds } from '../src/world/fields';
import { generateWorld } from '../src/world/generateWorld';
import { exportWorld, worldExportHash } from '../src/world/exportWorld';
import { buildFields, buildSurfaces } from '../src/world/pipeline';
import { aspectPass, combine, evaluateSurfaces, morph, rangePass } from '../src/world/surfaces/evaluate';
import { newCondition, newSurface } from '../src/world/surfaces/surfaceDoc';
import { alphasToWeights, packSplat } from '../src/world/surfaces/weights';
import { BIOME_SETS } from '../src/world/surfaces/presets';
import { coastalRange } from '../src/world/presets';
import { normaliseWorld, type WorldDoc } from '../src/world/worldDoc';
import type { WorldMasks } from '../src/world/masks';

const small = (doc: WorldDoc, resolution = 65): WorldDoc => ({ ...doc, settings: { ...doc.settings, resolution } });
const flatMasks = (N: number): WorldMasks => ({ slope: new Float32Array(N), curvature: new Float32Array(N).fill(0.5), flow: new Float32Array(N), wetness: new Float32Array(N) });

describe('water: priority flood, sea and lakes', () => {
  it('fills a bowl to its rim as one lake', () => {
    const res = 33, N = res * res;
    const h = new Float32Array(N);
    for (let r = 0; r < res; r++) for (let c = 0; c < res; c++) {
      const d = Math.hypot(c - 16, r - 16);
      h[r * res + c] = d < 10 ? 2 + d * 0.5 : 10; // a bowl: floor 2 m, rim 10 m (lowest rim point 7 m at d=10)
    }
    const w = computeWater(h, res, 10, -100, { ...DEFAULT_LAKES, minArea: 0, minDepth: 0.5 });
    expect(w.lakes.length).toBe(1);
    const lake = w.lakes[0];
    expect(lake.floor).toBeCloseTo(2, 5);
    // The lowest point on the way out is the rim (h = 10 just outside, so the bowl fills to the highest bowl cell below it).
    const spill = priorityFlood(h, res).spill[16 * res + 16];
    expect(lake.level).toBeCloseTo(spill, 5);
    expect(w.kind[16 * res + 16]).toBe(WATER_LAKE);
    expect(w.kind[0]).toBe(0);
  });

  it('lets the sea in from the edges and leaves inland basins to lakes', () => {
    const res = 33, N = res * res;
    const h = new Float32Array(N);
    for (let r = 0; r < res; r++) for (let c = 0; c < res; c++) h[r * res + c] = c * 2 - 10; // a ramp: under the sea on the left
    // An inland pit below sea level, walled off.
    for (let r = 10; r < 15; r++) for (let c = 20; c < 25; c++) h[r * res + c] = -20;
    const w = computeWater(h, res, 5, 0, { ...DEFAULT_LAKES, minArea: 0, minDepth: 0.5 });
    expect(w.kind[16 * res + 0]).toBe(WATER_SEA);
    expect(w.level[16 * res + 0]).toBe(0);
    expect(w.kind[12 * res + 22]).toBe(WATER_LAKE);
    expect(w.kind[16 * res + 30]).toBe(0);
  });

  it('routes upstream area to the outlet', () => {
    const res = 17, N = res * res;
    const h = new Float32Array(N);
    // A V valley sloping to one outlet in the middle of row 0: everything drains through it.
    for (let r = 0; r < res; r++) for (let c = 0; c < res; c++) h[r * res + c] = r * 0.1 + Math.abs(c - 8) + (c === 0 || c === res - 1 || r === res - 1 ? 50 : 0);
    const w = computeWater(h, res, 1, -10, { ...DEFAULT_LAKES, enabled: false });
    const area = upstreamArea(w, 1);
    expect(area[8]).toBeGreaterThan((res - 2) * (res - 2) * 0.9);
    let total = 0;
    for (let i = 0; i < N; i++) if (w.parent[i] < 0) total += area[i];
    expect(total).toBeCloseTo(N, 3);
  });
});

describe('distance transform', () => {
  it('is exact Euclidean to a single feature', () => {
    const res = 41;
    const f = distanceTransform(res, i => i === 20 * res + 20);
    for (const [c, r] of [[0, 0], [40, 20], [25, 33], [20, 20]]) {
      expect(f.distance[r * res + c]).toBeCloseTo(Math.hypot(c - 20, r - 20), 5);
      expect(f.nearest[r * res + c]).toBe(20 * res + 20);
    }
  });

  it('reports no feature as infinity', () => {
    const f = distanceTransform(8, () => false);
    expect(f.distance[5]).toBe(Infinity);
    expect(f.nearest[5]).toBe(-1);
  });
});

describe('fields', () => {
  it('reads the aspect of a tilted plane', () => {
    const res = 33, N = res * res;
    // Rising toward +X: the ground faces west (downhill is -X), 270°.
    const heights = new Float32Array(N);
    for (let r = 0; r < res; r++) for (let c = 0; c < res; c++) heights[r * res + c] = c / res;
    const f = computeFields({ frame: { resolution: res, size: 320, heightScale: 50 }, heights, masks: flatMasks(N), seaLevel: -1e6, lakes: DEFAULT_LAKES },
      { aspect: true, flowArea: false, curvature: new Set(), cavity: new Set() });
    expect(f.aspect![16 * res + 16]).toBeCloseTo(270, 3);
  });

  it('measures the erosion history', async () => {
    const out = await generateWorld(small(coastalRange(), 49));
    const dep = out.history.deposits.reduce((s, v) => s + v, 0);
    const wear = out.history.wear.reduce((s, v) => s + v, 0);
    expect(dep).toBeGreaterThan(0);
    expect(wear).toBeGreaterThan(0);
    expect(out.history.talus.every(v => v >= 0)).toBe(true);
  });

  it('asks only for the fields the enabled rules read', () => {
    const s = [newSurface('base', { kind: 'grass' }), newSurface('a', { kind: 'rock' }, [newCondition('curvature', { scale: 'broad' }), newCondition('aspect')])];
    const n = fieldNeeds(s);
    expect(n.aspect).toBe(true);
    expect([...n.curvature]).toEqual(['broad']);
    expect(n.flowArea).toBe(false);
  });
});

describe('surface rules', () => {
  it('passes inside the range and fades over the falloffs', () => {
    expect(rangePass(5, 0, 10, 2, 2)).toBe(1);
    expect(rangePass(-3, 0, 10, 2, 2)).toBe(0);
    expect(rangePass(-1, 0, 10, 2, 2)).toBeCloseTo(0.5, 5);
    expect(rangePass(11, 0, 10, 2, 2)).toBeCloseTo(0.5, 5);
    expect(rangePass(10.5, 0, 10, 0, 0)).toBe(0);
  });

  it('wraps aspect around north and halves flat ground', () => {
    expect(aspectPass(350, 30, 10, 30, 10)).toBe(1);
    expect(aspectPass(180, 30, 0, 30, 10)).toBe(0);
    expect(aspectPass(180, 0, 0, 30, 10)).toBe(0.5);
  });

  it('combines', () => {
    expect(combine('multiply', 0.5, 0.5)).toBe(0.25);
    expect(combine('add', 0.7, 0.5)).toBe(1);
    expect(combine('subtract', 0.3, 0.5)).toBe(0);
    expect(combine('max', 0.3, 0.5)).toBe(0.5);
    expect(combine('min', 0.3, 0.5)).toBe(0.3);
  });

  it('dilates and erodes a mask', () => {
    const M = 9;
    const p = new Float32Array(M * M);
    p[4 * M + 4] = 1;
    const grown = morph(p, M, 1);
    expect(grown[3 * M + 3]).toBe(1);
    expect(grown[2 * M + 2]).toBe(0);
    expect(morph(grown, M, -1)[4 * M + 4]).toBe(1);
    expect(morph(grown, M, -1)[3 * M + 3]).toBe(0);
  });

  it('places layers by their rules, and a layer can avoid a lower one', () => {
    const res = 33, N = res * res;
    const heights = new Float32Array(N);
    for (let r = 0; r < res; r++) for (let c = 0; c < res; c++) heights[r * res + c] = c / (res - 1); // 0..100 m left to right
    const f = computeFields({ frame: { resolution: res, size: 320, heightScale: 100 }, heights, masks: flatMasks(N), seaLevel: -1e6, lakes: DEFAULT_LAKES },
      { aspect: false, flowArea: false, curvature: new Set(), cavity: new Set() });
    const high = newSurface('high', { kind: 'snow' }, [newCondition('height', { min: 50, max: 1000, falloffLow: 0, falloffHigh: 0 })], { breakup: { amount: 0, scale: 10, octaves: 1, seed: 1, warp: 0 } });
    const notHigh = newSurface('below', { kind: 'rock' }, [newCondition('layer', { layerId: high.id, min: 0.5, max: 1, falloffLow: 0, falloffHigh: 0, invert: true })], { breakup: { amount: 0, scale: 10, octaves: 1, seed: 1, warp: 0 } });
    const surfaces = [newSurface('base', { kind: 'grass' }), high, notHigh];
    const { alphas } = evaluateSurfaces(f, surfaces, 16, { seed: 1 });
    expect(alphas[0]!.every(v => v === 255)).toBe(true);
    expect(alphas[1]![8 * 16 + 1]).toBe(0);
    expect(alphas[1]![8 * 16 + 14]).toBe(255);
    expect(alphas[2]![8 * 16 + 1]).toBe(255);
    expect(alphas[2]![8 * 16 + 14]).toBe(0);
  });
});

describe('weights', () => {
  it('sum to exactly 255 per texel and agree with the stack compositing', () => {
    const M = 32, N = M * M, n = 5;
    const alphas = Array.from({ length: n }, (_, k) => {
      const p = new Uint8Array(N);
      for (let t = 0; t < N; t++) p[t] = k === 0 ? 255 : (t * (k * 37 + 11) + k * 101) % 256;
      return p;
    });
    const w = alphasToWeights(alphas, M);
    const a = new Float64Array(n), ref = new Float64Array(n);
    for (let t = 0; t < N; t++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += w[i][t];
      expect(s).toBe(255);
      for (let i = 0; i < n; i++) a[i] = alphas[i][t] / 255;
      a[0] = 1;
      compositeWeights(a, ref);
      for (let i = 0; i < n; i++) expect(Math.abs(w[i][t] - ref[i] * 255)).toBeLessThanOrEqual(1);
    }
  });

  it('pack four to an image, unused channels zero', () => {
    const w = [new Uint8Array([255]), new Uint8Array([0]), new Uint8Array([0]), new Uint8Array([0]), new Uint8Array([0])];
    const images = packSplat(w, 1);
    expect(images.length).toBe(2);
    expect(Array.from(images[1])).toEqual([0, 0, 0, 0]);
  });

  it('round-trip through the engine importer: weights -> over-alphas -> weights', () => {
    const M = 16, N = M * M;
    const alphas = [new Uint8Array(N).fill(255), Uint8Array.from({ length: N }, (_, t) => (t * 13) % 256), Uint8Array.from({ length: N }, (_, t) => (t * 29 + 7) % 256)];
    const w = alphasToWeights(alphas, M);
    const back = weightPlanesToAlphaPlanes(w, M, M);
    const again = alphasToWeights(back, M);
    for (let i = 0; i < w.length; i++) for (let t = 0; t < N; t++) expect(Math.abs(again[i][t] - w[i][t])).toBeLessThanOrEqual(2);
  });
});

describe('zip and exr writers', () => {
  it('writes a zip the reader reads back', async () => {
    const files = [{ name: 'a.txt', bytes: new TextEncoder().encode('hello hello hello hello') }, { name: 'dir/b.bin', bytes: new Uint8Array([1, 2, 3]) }];
    const back = await readZip(await writeZip(files));
    expect(back.map(f => f.name)).toEqual(['a.txt', 'dir/b.bin']);
    expect(new TextDecoder().decode(back[0].bytes)).toBe('hello hello hello hello');
    expect(Array.from(back[1].bytes)).toEqual([1, 2, 3]);
  });

  it('writes an OpenEXR header and the floats', () => {
    const data = Float32Array.from([1.5, -2, 3.25, 4]);
    const exr = encodeExrFloat(2, 2, data);
    const v = new DataView(exr.buffer);
    expect(v.getInt32(0, true)).toBe(20000630);
    expect(v.getInt32(4, true)).toBe(2);
    const text = new TextDecoder('latin1').decode(exr.subarray(0, 400));
    expect(text).toContain('channels');
    expect(text).toContain('dataWindow');
    // Last scanline's last float.
    expect(v.getFloat32(exr.length - 4, true)).toBe(4);
  });
});

describe('world export v2', () => {
  it('writes splats, weight maps and a manifest the engine reads back', async () => {
    const doc = normaliseWorld(small(coastalRange(), 33));
    doc.output = { ...doc.output, splatResolution: 512, exr: true, masks: ['slope', 'curvature', 'flow', 'wetness', 'water', 'deposits'] };
    const out = await generateWorld(doc);
    const files = await exportWorld(out, doc);
    const names = files.map(f => f.name);
    expect(names.slice(0, 3)).toEqual(['world_height.png', 'world_height.r16', 'world_height.exr']);
    expect(names.slice(3, 7)).toEqual(['world_slope.png', 'world_curvature.png', 'world_flow.png', 'world_wetness.png']);
    expect(names.at(-1)).toBe('world.json');
    const enabled = doc.surfaces.filter(s => s.enabled).length;
    expect(names.filter(n => /_splat_\d\.png$/.test(n)).length).toBe(Math.ceil(enabled / 4));
    expect(names.filter(n => /_weight_\d\d_/.test(n)).length).toBe(enabled);

    const sidecar = JSON.parse(new TextDecoder().decode(files.at(-1)!.bytes));
    expect(sidecar.params.preview).toBeUndefined();
    const manifest = readWorldManifest(sidecar)!;
    expect(manifest.version).toBe(2);
    expect(manifest.layers.length).toBe(enabled);
    expect(manifest.exportHash).toBe(worldExportHash(doc));
    const images = new Map<string, Awaited<ReturnType<typeof decodePngChannels>>>();
    for (const f of files) if (f.name.endsWith('.png')) images.set(f.name, await decodePngChannels(f.bytes));
    const fromSplat = weightPlanesFromImages(manifest, images);
    expect(fromSplat.size).toBe(512);
    for (let t = 0; t < 512 * 512; t += 997) {
      let s = 0;
      for (const p of fromSplat.planes) s += p[t];
      expect(s).toBe(255);
    }
    // The per-layer weight maps say the same as the splat channels.
    const wm = images.get(manifest.layers[1].weightmap!)!;
    expect(Array.from((wm.data as Uint8Array).subarray(0, 64))).toEqual(Array.from(fromSplat.planes[1].subarray(0, 64)));
  });

  it('keeps the export hash when only the preview changes', () => {
    const doc = normaliseWorld(coastalRange());
    const tinted = structuredClone(doc);
    tinted.surfaces[1].preview.tint = [0.2, 0.3, 0.4];
    tinted.preview.water.clarity = 99;
    expect(worldExportHash(tinted)).toBe(worldExportHash(doc));
    const ruled = structuredClone(doc);
    ruled.surfaces[1].conditions[0].min += 1;
    expect(worldExportHash(ruled)).not.toBe(worldExportHash(doc));
  });

  it('builds every biome on a generated world', async () => {
    const base = normaliseWorld(small(coastalRange(), 49));
    const out = await generateWorld(base);
    for (const biome of BIOME_SETS) {
      const doc = { ...base, surfaces: biome.make() };
      const fields = buildFields(out, doc);
      const { alphas } = buildSurfaces(fields, doc, 64);
      expect(alphas.length, biome.id).toBe(doc.surfaces.length);
      expect(alphas.every(a => !a || a.length === 64 * 64)).toBe(true);
    }
  });

  it('migrates a version-1 document', () => {
    const v1 = { settings: { resolution: 257, size: 1000, heightScale: 300, seed: 3, seaLevel: 0.2 }, layers: [], erosion: [] };
    const doc = normaliseWorld(v1);
    expect(doc.version).toBe(2);
    expect(doc.surfaces.length).toBeGreaterThan(3);
    expect(doc.settings.size).toBe(1000);
    expect(doc.preview.quality).toBe('draft');
  });
});

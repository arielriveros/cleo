import { describe, it, expect } from 'vitest';
import { decodePng } from 'cleo/terrain/heightmapIO';
import { fnv1a } from '../src/core/generator';
import { inflateIdat } from '../src/core/png';
import { applyLayer, blend } from '../src/world/features';
import { pipeErosion, thermalErosion, dropletErosion, type WorldFrame } from '../src/world/erosion';
import { slopeMask, curvatureMask, d8FlowMask } from '../src/world/masks';
import { exportWorld, generateWorld } from '../src/world/generateWorld';
import { coastalRange, WORLD_PRESETS } from '../src/world/presets';
import { defaultErosion, defaultLayer, type WorldDoc } from '../src/world/worldDoc';

const small = (doc: WorldDoc, resolution = 65): WorldDoc => ({ ...doc, settings: { ...doc.settings, resolution } });
const sum = (a: Float32Array) => a.reduce((s, v) => s + v, 0);

describe('World Creator generation', () => {
  it('is a deterministic function of the document and its seed', async () => {
    const doc = small(coastalRange());
    const a = await generateWorld(doc);
    const b = await generateWorld(structuredClone(doc));
    expect(fnv1a(new Uint8Array(a.heights.buffer))).toBe(fnv1a(new Uint8Array(b.heights.buffer)));

    const reseeded = await generateWorld({ ...doc, settings: { ...doc.settings, seed: doc.settings.seed + 1 } });
    expect(fnv1a(new Uint8Array(reseeded.heights.buffer))).not.toBe(fnv1a(new Uint8Array(a.heights.buffer)));
  });

  it('builds every preset to finite heights and 0..1 masks', async () => {
    for (const preset of WORLD_PRESETS) {
      const out = await generateWorld(small(preset.params(), 49));
      expect(out.heights.every(Number.isFinite), preset.id).toBe(true);
      for (const [kind, mask] of Object.entries(out.masks))
        expect(mask.every(v => v >= 0 && v <= 1), `${preset.id} ${kind}`).toBe(true);
    }
  });

  it('carves the coastal preset into land, beach and sea', async () => {
    const doc = small(coastalRange(), 97);
    doc.erosion = [];
    const out = await generateWorld(doc);
    const res = out.frame.resolution;
    const sea = doc.settings.seaLevel;
    // The coast layer puts the sea toward +Z (direction 90): the last row is under water, the peak is not.
    const lastRow = out.heights.subarray((res - 1) * res, res * res);
    expect(Math.max(...lastRow)).toBeLessThan(sea);
    expect(Math.max(...out.heights)).toBeGreaterThan(0.5);
  });
});

describe('landform layers', () => {
  const grid = { resolution: 33, seed: 1 };

  it('blends by op and strength', () => {
    expect(blend('add', 1, 2, 1)).toBe(3);
    expect(blend('add', 1, 2, 0.5)).toBe(2);
    expect(blend('max', 1, 0.5, 1)).toBe(1);
    expect(blend('replace', 1, 0.25, 1)).toBe(0.25);
  });

  it('skips disabled layers', () => {
    const h = new Float32Array(33 * 33);
    applyLayer(h, grid, { ...defaultLayer('mountain'), enabled: false });
    expect(sum(h)).toBe(0);
  });

  it('raises a mountain at its centre and leaves the corners alone', () => {
    const h = new Float32Array(33 * 33);
    applyLayer(h, grid, { ...defaultLayer('mountain'), ridges: 0, radius: 0.3 });
    expect(h[16 * 33 + 16]).toBeGreaterThan(0.5);
    expect(h[0]).toBe(0);
  });

  it('never lets a river raise the ground', () => {
    const h = new Float32Array(33 * 33).fill(0.5);
    const before = h.slice();
    applyLayer(h, grid, defaultLayer('river'));
    expect(h.every((v, i) => v <= before[i] + 1e-7)).toBe(true);
    expect(Math.min(...h)).toBeLessThan(0.5);
  });

  it('flattens terraces only inside their band', () => {
    const h = Float32Array.from({ length: 33 * 33 }, (_, i) => i / (33 * 33));
    const t = { ...defaultLayer('terrace'), minHeight: 0.2, maxHeight: 0.8 } as const;
    const out = h.slice();
    applyLayer(out, grid, t);
    for (let i = 0; i < h.length; i++) if (h[i] < 0.2 || h[i] > 0.8) expect(out[i]).toBe(h[i]);
  });
});

describe('erosion', () => {
  const frame: WorldFrame = { resolution: 33, size: 320, heightScale: 100 };
  const cone = () => {
    const h = new Float32Array(33 * 33);
    for (let r = 0; r < 33; r++) for (let c = 0; c < 33; c++) h[r * 33 + c] = Math.max(0, 1 - Math.hypot(r - 16, c - 16) / 12);
    return h;
  };

  it('thermal erosion conserves material and relaxes the steepest slope', async () => {
    const h = cone();
    const before = sum(h);
    const steepBefore = Math.max(...slopeMask(h, frame));
    await thermalErosion(h, frame, { iterations: 30, talus: 30, rate: 0.5 });
    expect(sum(h)).toBeCloseTo(before, 3);
    expect(Math.max(...slopeMask(h, frame))).toBeLessThan(steepBefore);
  });

  it('droplet erosion is seeded and deterministic', async () => {
    const p = { ...defaultErosion('droplet').params, density: 400 } as any;
    const a = cone(), b = cone();
    await dropletErosion(a, frame, p);
    await dropletErosion(b, frame, p);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).not.toEqual(Array.from(cone()));
  });

  it('pipe erosion moves material downhill and reports flow where water ran', async () => {
    const h = cone();
    const peak = h[16 * 33 + 16];
    const masks = await pipeErosion(h, frame, { ...(defaultErosion('pipe').params as any), iterations: 60 });
    expect(h.every(Number.isFinite)).toBe(true);
    expect(h[16 * 33 + 16]).toBeLessThanOrEqual(peak + 1e-6);
    expect(Math.max(...masks.flow)).toBeGreaterThan(0);
  });
});

describe('masks', () => {
  const frame: WorldFrame = { resolution: 17, size: 16, heightScale: 1 };

  it('reads a 45-degree ramp as half-way to vertical', () => {
    // Height rises one world unit per world unit along X.
    const h = Float32Array.from({ length: 17 * 17 }, (_, i) => (i % 17));
    const s = slopeMask(h, frame);
    expect(s[8 * 17 + 8]).toBeCloseTo(0.5, 5);
  });

  it('reads a flat plane as zero slope and neutral curvature', () => {
    const h = new Float32Array(17 * 17).fill(3);
    expect(Math.max(...slopeMask(h, frame))).toBe(0);
    expect(curvatureMask(h, frame).every(v => Math.abs(v - 0.5) < 1e-9)).toBe(true);
  });

  it('accumulates flow at the bottom of a tilted plane', () => {
    const h = Float32Array.from({ length: 17 * 17 }, (_, i) => 17 - Math.floor(i / 17));
    const flow = d8FlowMask(h, 17);
    expect(flow[16 * 17 + 8]).toBeGreaterThan(flow[0]);
  });
});

describe('world export', () => {
  it('writes a 16-bit heightmap the engine decodes back to the same samples, plus masks and a sidecar', async () => {
    const doc = small(coastalRange(), 33);
    doc.erosion = [];
    const out = await generateWorld(doc);
    const files = await exportWorld(out, doc);
    const names = files.map(f => f.name);
    expect(names).toEqual(['world_height.png', 'world_height.r16', 'world_slope.png', 'world_curvature.png', 'world_flow.png', 'world_wetness.png', 'world.json']);

    const png = await decodePng(files[0].bytes);
    expect(png.width).toBe(33);
    expect(png.bitDepth).toBe(16);
    const meta = JSON.parse(new TextDecoder().decode(files[6].bytes));
    const span = meta.output.maxHeight - meta.output.minHeight;
    for (let i = 0; i < out.heights.length; i += 37) {
      const world = meta.output.minHeight + png.data[i] * span;
      expect(world).toBeCloseTo(out.heights[i] * doc.settings.heightScale, 1);
    }

    const mask = await inflateIdat(files[2].bytes);
    expect(mask.width).toBe(33);
    expect(mask.colorType).toBe(0);
    expect(mask.raw.length).toBe(33 * 34);
  });
});

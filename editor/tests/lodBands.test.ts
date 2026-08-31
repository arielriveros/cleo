import { describe, it, expect } from 'vitest';
import { modelAssetDiameter, LOD_CULL_MARGIN } from '../src/utils/models';
import { defaultSpecs } from '../src/features/models/GenerateLodsModal';

/**
 * LOD bands have to be derived from the model's own size.
 *
 * `defaultSpecs` was always written to do that — its own comment says "at distances derived from the
 * model's own size" — but its only caller passed a hardcoded `2`, so every asset got the same
 * 16 / 32 / 64 m ladder. A 25 m oak dropped to half detail closer than its own height, and a 0.4 m fern
 * kept full geometry out to the cull distance. Neither fails; both just render wrong amounts of
 * geometry, which is exactly the class of bug that shows up as "why is this slow".
 *
 * `modelAssetDiameter` reads the SERIALIZED subtree, because the number is wanted while choosing those
 * distances — long before anything is instantiated.
 */

const quad = (size: number, over: any = {}) => ({
  type: 'model', name: 'q', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
  model: {
    geometry: {
      // A box from -size/2 to +size/2 on x and z, 0..size on y — a tree-ish, base-at-origin shape.
      positions: new Float32Array([
        -size / 2, 0, -size / 2, size / 2, 0, -size / 2, size / 2, size, size / 2, -size / 2, size, size / 2,
      ]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    },
  },
  children: [],
  ...over,
});

describe('modelAssetDiameter', () => {
  it('measures the largest extent of a single mesh', () => {
    // Height is the largest extent here (0..size), so the diameter is the height.
    expect(modelAssetDiameter(quad(20))).toBe(20);
  });

  it('spans children laid out around the origin, not just the biggest one', () => {
    // The case a per-child bound gets wrong: two small meshes far apart are a large model.
    const root = {
      type: 'node', name: 'root', position: [0, 0, 0], scale: [1, 1, 1],
      children: [quad(1, { position: [-10, 0, 0] }), quad(1, { position: [10, 0, 0] })],
    };
    expect(modelAssetDiameter(root)).toBeCloseTo(21, 5);
  });

  it('applies node scale', () => {
    expect(modelAssetDiameter(quad(2, { scale: [1, 5, 1] }))).toBeCloseTo(10, 5);
  });

  it('compounds scale down the tree', () => {
    const root = {
      type: 'node', name: 'root', position: [0, 0, 0], scale: [2, 2, 2],
      children: [quad(3)],
    };
    expect(modelAssetDiameter(root)).toBeCloseTo(6, 5);
  });

  it('returns 0 for an asset with no geometry to measure', () => {
    // "Unknown", NOT "tiny" — callers must floor it rather than trust it.
    expect(modelAssetDiameter({ type: 'node', name: 'empty', children: [] })).toBe(0);
    expect(modelAssetDiameter(null)).toBe(0);
    expect(modelAssetDiameter(undefined)).toBe(0);
  });

  it('survives a JSON round trip, where typed arrays become plain arrays', () => {
    // A stored asset has been through JSON; positions come back as number[], not Float32Array.
    const plain = JSON.parse(JSON.stringify({
      ...quad(8),
      model: { geometry: { positions: Array.from(quad(8).model.geometry.positions) } },
    }));
    expect(modelAssetDiameter(plain)).toBe(8);
  });
});

describe('defaultSpecs — the ladder those sizes produce', () => {
  it('scales the bands with the model', () => {
    const oak = defaultSpecs(modelAssetDiameter(quad(25)));
    const fern = defaultSpecs(modelAssetDiameter(quad(0.4)));
    // The oak's first band is now past its own height rather than inside it.
    expect(oak[0].distance).toBeGreaterThan(25);
    // The fern's whole ladder finishes well before the oak's first switch.
    expect(fern[fern.length - 1].distance).toBeLessThan(oak[0].distance);
  });

  it('floors the step so a zero or unmeasurable size still gives an ascending ladder', () => {
    const specs = defaultSpecs(0);
    expect(specs[0].distance).toBeGreaterThan(0);
    for (let i = 1; i < specs.length; i++)
      expect(specs[i].distance).toBeGreaterThan(specs[i - 1].distance);
  });

  it('reduces triangles monotonically', () => {
    const specs = defaultSpecs(modelAssetDiameter(quad(10)));
    for (let i = 1; i < specs.length; i++) expect(specs[i].ratio).toBeLessThan(specs[i - 1].ratio);
  });
});

describe('LOD_CULL_MARGIN', () => {
  it('leaves the coarsest level a band of its own', () => {
    // The failure it exists to prevent: a ladder ending at 64 m against a 65 m cull, where the
    // 10%-triangle level the user waited for is alive for one metre and effectively never drawn.
    const specs = defaultSpecs(2);
    const last = specs[specs.length - 1].distance;
    const cull = Math.round(last * LOD_CULL_MARGIN);
    expect(cull).toBeGreaterThan(last);
    // A band worth having, not a rounding error.
    expect(cull - last).toBeGreaterThan(last * 0.25);
  });
});

import { describe, it, expect } from 'vitest';

// Measuring an asset without stringifying it. The obvious `JSON.stringify(asset).length` is precisely
// what breaks on the assets worth measuring — a large model runs past V8's maximum string length. This
// also has to price the two containers differently: a Float32Array is 4 bytes an element, while the
// plain number[] the serializer used to emit is 8 (PACKED_DOUBLE_ELEMENTS), which is why writing meshes
// out as number arrays doubled every library.

const {
  estimateBytes, estimateAssetBytes, formatBytes, dominantCategory, libraryReport, LARGE_ASSET_BYTES,
} = await import('../src/utils/assetSize');

describe('estimateBytes', () => {
  it('prices a typed array at its real byteLength', () => {
    expect(estimateBytes(new Float32Array(1000))).toBe(4000);
    expect(estimateBytes(new Uint32Array(1000))).toBe(4000);
    expect(estimateBytes(new Float64Array(1000))).toBe(8000);
  });

  it('prices the equivalent number[] at double — the whole reason serialize changed', () => {
    const values = Array.from({ length: 1000 }, (_, i) => i * 0.5);
    expect(estimateBytes(values)).toBe(8000);
    expect(estimateBytes(new Float32Array(values))).toBe(4000);
  });

  it('prices a string at 2 bytes a char', () => {
    expect(estimateBytes('x'.repeat(500))).toBe(1000);
  });

  it('walks nested structures', () => {
    expect(estimateBytes({ a: { b: [new Float32Array(10)] } })).toBe(40);
  });

  it('counts a shared sub-object once', () => {
    const shared = new Float32Array(100);
    expect(estimateBytes({ a: shared, b: shared })).toBe(400);
  });

  it('survives a cycle', () => {
    const a: any = { buf: new Float32Array(10) };
    a.self = a;
    expect(() => estimateBytes(a)).not.toThrow();
    expect(estimateBytes(a)).toBe(40);
  });
});

describe('estimateAssetBytes — where the bytes went', () => {
  const model = (over: any = {}) => ({
    id: 'm', name: 'm', thumbnail: '',
    nodeJson: {
      name: 'holder',
      children: [{
        name: 'part',
        model: {
          geometry: { positions: new Float32Array(300), indices: new Uint32Array(150) },
          jointIndices: new Float32Array(400),
          animations: [{ name: 'walk', samplers: [{ input: new Float32Array(100) }] }],
          material: { type: 'pbr' },
          ...over,
        },
      }],
    },
  });

  it('attributes geometry, joints and clips separately', () => {
    const b = estimateAssetBytes(model());
    expect(b.geometry).toBe(300 * 4 + 150 * 4);
    expect(b.joints).toBe(400 * 4);
    expect(b.clips).toBe(100 * 4 + 'walk'.length * 2); // the buffer plus the clip's own metadata
    expect(b.total).toBe(b.geometry + b.joints + b.clips + b.thumbnail + b.other);
  });

  it('counts the thumbnail, which is a string and easy to forget', () => {
    const b = estimateAssetBytes({ ...model(), thumbnail: 'd'.repeat(1000) });
    expect(b.thumbnail).toBe(2000);
  });

  it('names what dominates — the point of the breakdown', () => {
    expect(dominantCategory(estimateAssetBytes(model()))).toBe('geometry');
    // A model split per sub-mesh used to carry a full copy of every clip; that reads as clip-dominated.
    const clipHeavy = model({ animations: [{ samplers: [{ output: new Float32Array(100000) }] }] });
    expect(dominantCategory(estimateAssetBytes(clipHeavy))).toBe('clips');
  });

  it('handles an asset with no nodeJson at all', () => {
    expect(estimateAssetBytes(null).total).toBe(0);
    expect(estimateAssetBytes({}).total).toBe(0);
  });
});

describe('libraryReport', () => {
  const big = (id: string, floats: number) => ({
    id, name: id, thumbnail: '',
    nodeJson: { model: { geometry: { positions: new Float32Array(floats) } } },
  });

  it('says nothing about a small library', () => {
    const r = libraryReport([big('a', 1000)]);
    expect(r.oversized).toBe(false);
    expect(r.lines).toEqual([]);
  });

  it('names the assets over the threshold, largest first', () => {
    const overBy = LARGE_ASSET_BYTES / 4 + 1;
    const r = libraryReport([big('small', 10), big('huge', overBy * 2), big('large', overBy)]);
    expect(r.oversized).toBe(true);
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0]).toContain('huge');
    expect(r.lines[1]).toContain('large');
    expect(r.lines[0]).toContain('mostly geometry');
  });
});

describe('formatBytes', () => {
  it('reads as a human would write it', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 kB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB');
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.00 GB');
  });
});

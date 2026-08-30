import { describe, it, expect } from 'vitest';

// `JSON.parse(JSON.stringify(x))` builds the whole object as one string first, and V8 caps a string at
// ~512MB. A serialized model writes positions/normals/tangents/bitangents/texCoords/indices as number
// arrays, plus joint attributes and every animation clip for a skinned one — so a large import blew that
// cap and threw `RangeError: Invalid string length` from code that was only trying to COPY the asset.
// IndexedDB persists through structured clone and never builds a string, which is why such an asset
// stored and reloaded fine but could not be opened.
//
// These pin the two behaviour differences that could bite a call site swapped over from the JSON form.

const { deepClone } = await import('../src/utils/deepClone');

describe('deepClone', () => {
  it('copies nested plain data by value, not by reference', () => {
    const src = { a: 1, b: { c: [1, 2, { d: 'x' }] }, e: null };
    const out = deepClone(src);
    expect(out).toEqual(src);
    expect(out.b).not.toBe(src.b);
    expect(out.b.c[2]).not.toBe(src.b.c[2]);
  });

  it('keeps a typed array a typed array — the JSON round trip turned it into an object', () => {
    // Model.serialize uses Array.from for exactly this reason. A payload that slips through with a live
    // Float32Array used to be silently corrupted into {"0":…,"1":…} by the JSON form.
    const out = deepClone({ positions: new Float32Array([1, 2, 3]) });
    expect(out.positions).toBeInstanceOf(Float32Array);
    expect(Array.from(out.positions)).toEqual([1, 2, 3]);
  });

  it('preserves an explicit undefined property instead of dropping the key', () => {
    // A serialized material writes absent texture slots as undefined; readers test the VALUE either way.
    const out = deepClone({ base: 'tex-1', normal: undefined });
    expect('normal' in out).toBe(true);
    expect(out.normal).toBeUndefined();
  });

  it('falls back to the JSON round trip when something is not structured-cloneable', () => {
    // structuredClone throws DataCloneError on a function; the JSON form silently dropped it, and a call
    // site swapped over must not start throwing.
    const out = deepClone({ keep: 1, fn: () => 42 } as any);
    expect(out.keep).toBe(1);
    expect(out.fn).toBeUndefined();
  });

  it('round-trips a serialized-model-shaped object', () => {
    const asset = {
      id: 'm1',
      nodeJson: {
        name: 'holder',
        children: [{
          name: 'part',
          model: {
            geometry: { positions: [0, 1, 2], normals: [], tangents: [], bitangents: [], texCoords: [], indices: [0] },
            material: { type: 'pbr', textures: { base: 'tex-1', normal: undefined } },
            materials: [{ type: 'pbr' }, { type: 'pbr' }],
            submeshes: [{ start: 0, count: 3 }, { start: 3, count: 3 }],
            animations: [{ name: 'walk', duration: 1 }],
          },
          variables: { __materialIds: { type: 'string', value: '["a","b"]' } },
        }],
      },
    };
    const out = deepClone(asset);
    expect(out).toEqual(asset);
    expect(out.nodeJson.children[0].model.submeshes).not.toBe(asset.nodeJson.children[0].model.submeshes);
  });
});

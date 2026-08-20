import { describe, it, expect } from 'vitest';
import { Geometry } from '../src/core/geometry';
import { mergeBlocker, concatJointAttributes, type MergePart } from '../src/graphics/modelMerge';

// Merging the sub-meshes an importer produces into one mesh has two halves that fail in opposite ways.
//
// The geometry half fails LOUDLY if you get index offsetting wrong, and SILENTLY if you get attribute
// presence wrong: `Geometry.getData` drops an attribute whose array is empty, which changes the
// interleaved stride, so an unpadded merge shifts every vertex after the gap onto another vertex's data.
//
// The eligibility half is the opposite: merging parts bound to different skeletons, or with materials
// the renderer would route to different passes, produces something that looks fine until it is drawn.

/** A quad-ish part: `n` vertices at increasing x, indices walking them in triples. */
function part(n: number, opts: { uvs?: boolean; normals?: boolean } = {}): Geometry {
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) positions[i * 3] = i;
  const indices = new Uint32Array(n);
  for (let i = 0; i < n; i++) indices[i] = i;
  return new Geometry(
    positions,
    opts.normals === false ? new Float32Array(0) : new Float32Array(n * 3).fill(1),
    opts.uvs === false ? new Float32Array(0) : new Float32Array(n * 2).fill(0.5),
    new Float32Array(n * 3), // tangents + bitangents supplied so nothing is recomputed
    new Float32Array(n * 3),
    indices,
    false,
  );
}

describe('Geometry.merge', () => {
  it('offsets each part\'s indices by the vertices already emitted', () => {
    const { geometry, ranges } = Geometry.merge([part(3), part(4)]);

    expect(geometry.vertexCount).toBe(7);
    expect(Array.from(geometry.indices)).toEqual([0, 1, 2, /* +3: */ 3, 4, 5, 6]);
    expect(ranges).toEqual([{ start: 0, count: 3 }, { start: 3, count: 4 }]);
  });

  it('lays every part\'s vertices down in order', () => {
    const { geometry } = Geometry.merge([part(2), part(3)]);
    // x coordinates: part A's 0,1 then part B's 0,1,2
    const xs = [0, 1, 2, 3, 4].map(i => geometry.positions[i * 3]);
    expect(xs).toEqual([0, 1, 0, 1, 2]);
  });

  it('zero-pads an attribute a part is missing rather than dropping it', () => {
    // Without padding the merged uv array would be short, `getData` would interleave it against the
    // wrong vertices, and the second half of the mesh would sample garbage.
    const withUvs = part(2);
    const without = part(3, { uvs: false });
    const { geometry } = Geometry.merge([withUvs, without]);

    expect(geometry.uvs.length).toBe(5 * 2);
    expect(Array.from(geometry.uvs.subarray(0, 4))).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect(Array.from(geometry.uvs.subarray(4))).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('drops an attribute only when NO part has it', () => {
    const { geometry } = Geometry.merge([part(2, { uvs: false }), part(3, { uvs: false })]);
    expect(geometry.uvs.length).toBe(0);
    expect(geometry.positions.length).toBe(5 * 3);
  });

  it('keeps three parts consistent', () => {
    const { geometry, ranges } = Geometry.merge([part(2), part(3), part(4)]);
    expect(geometry.vertexCount).toBe(9);
    expect(geometry.indices.length).toBe(9);
    expect(ranges).toEqual([
      { start: 0, count: 2 }, { start: 2, count: 3 }, { start: 5, count: 4 },
    ]);
    // Every index must address a real vertex of the merged buffer.
    for (const i of geometry.indices) expect(i).toBeLessThan(geometry.vertexCount);
  });

  it('passes a single part straight through, with a range covering it', () => {
    const only = part(3);
    const { geometry, ranges } = Geometry.merge([only]);
    expect(geometry).toBe(only);
    expect(ranges).toEqual([{ start: 0, count: 3 }]);
  });

  it('handles an empty list', () => {
    const { geometry, ranges } = Geometry.merge([]);
    expect(geometry.vertexCount).toBe(0);
    expect(ranges).toEqual([]);
  });
});

describe('mergeBlocker', () => {
  const mat = (type = 'pbr', transparent = false) => ({ type, config: { transparent } });
  const skin = { joints: [] };
  const p = (over: Partial<MergePart> = {}): MergePart =>
    ({ materials: [mat()], hasSubmeshes: false, ...over });

  it('allows two opaque parts of the same type on one skeleton', () => {
    expect(mergeBlocker([p({ skin }), p({ skin })])).toBeNull();
  });

  it('allows two static parts of the same type', () => {
    expect(mergeBlocker([p(), p()])).toBeNull();
  });

  it('refuses parts bound to different skeletons', () => {
    // Structurally identical but distinct objects — still two joint index spaces.
    expect(mergeBlocker([p({ skin }), p({ skin: { joints: [] } })])).toMatch(/different skeletons/);
  });

  it('refuses mixed material types', () => {
    expect(mergeBlocker([p(), p({ materials: [mat('blinn_phong')] })])).toMatch(/mixed material types/);
  });

  it('refuses mixing opaque and transparent parts', () => {
    // They would have to be in the opaque and the transparent pass at the same time.
    expect(mergeBlocker([p(), p({ materials: [mat('pbr', true)] })])).toMatch(/opaque and transparent/);
  });

  it('refuses mixing skinned and static parts', () => {
    expect(mergeBlocker([p({ skin }), p()])).toMatch(/skinned and static/);
  });

  it('refuses a part that is already merged', () => {
    expect(mergeBlocker([p(), p({ hasSubmeshes: true })])).toMatch(/already merged/);
  });

  it('refuses fewer than two parts', () => {
    expect(mergeBlocker([p()])).toBe('nothing to merge');
    expect(mergeBlocker([])).toBe('nothing to merge');
  });
});

describe('concatJointAttributes', () => {
  const four = (v: number, n: number) => Float32Array.from({ length: n * 4 }, () => v);

  it("lays each part's 4-floats-per-vertex block down in vertex order", () => {
    const out = concatJointAttributes([four(1, 2), four(2, 3)], [2, 3]);
    expect(out.length).toBe(5 * 4);
    expect(Array.from(out.subarray(0, 8))).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(Array.from(out.subarray(8))).toEqual([2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
  });

  it('zero-pads a part with no joint data, keeping later parts aligned', () => {
    // The invisible failure: without padding, part C bones would land on part B vertices.
    const out = concatJointAttributes([four(1, 1), null, four(3, 1)], [1, 2, 1]);

    expect(out.length).toBe(4 * 4);
    expect(Array.from(out.subarray(0, 4))).toEqual([1, 1, 1, 1]);
    expect(Array.from(out.subarray(4, 12))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]); // the padded part
    expect(Array.from(out.subarray(12))).toEqual([3, 3, 3, 3]);                // still in the right slot
  });

  it('truncates a part that carries more data than it has vertices', () => {
    const out = concatJointAttributes([four(7, 5)], [2]);
    expect(out.length).toBe(2 * 4);
    expect(Array.from(out)).toEqual([7, 7, 7, 7, 7, 7, 7, 7]);
  });
});

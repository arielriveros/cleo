import { describe, it, expect } from 'vitest';

// Undo/redo diffs a node's serialized subtree before and after an interaction. That comparison used to be
// `JSON.stringify(a) === JSON.stringify(b)` — which, for a model node, builds the text of its vertex
// buffers twice. On a real mesh that is minutes of work and then `RangeError: Invalid string length`, so
// merely selecting an imported model wedged the editor.
//
// The replacement has to be exact (a missed change is a lost undo step, a false change is a junk one) and
// has to keep the history's memory bounded, which is what shareBuffers is for.

const { sameSnapshot, shareBuffers } = await import('../src/utils/snapshotDiff');

const nodeJson = (over: any = {}) => ({
  id: 'n1',
  name: 'Rogue',
  position: [0, 0, 0],
  model: {
    geometry: {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
    },
    material: { type: 'pbr', baseColor: [1, 1, 1] },
    ...over,
  },
  children: [],
});

describe('sameSnapshot', () => {
  it('finds two independently serialized copies equal', () => {
    // The common case: nothing was edited, so no undo entry may be pushed. The buffers are DIFFERENT
    // objects with the same bytes, because serialize() copies them.
    expect(sameSnapshot(nodeJson(), nodeJson())).toBe(true);
  });

  it('sees a changed transform', () => {
    const after = nodeJson();
    after.position = [1, 0, 0];
    expect(sameSnapshot(nodeJson(), after)).toBe(false);
  });

  it('sees a changed vertex — a mesh edit is still an undo step', () => {
    const after = nodeJson();
    after.model.geometry.positions[4] = 9;
    expect(sameSnapshot(nodeJson(), after)).toBe(false);
  });

  it('sees a buffer that changed length', () => {
    const after = nodeJson();
    after.model.geometry.indices = new Uint32Array([0, 1, 2, 0, 2, 3]) as any;
    expect(sameSnapshot(nodeJson(), after)).toBe(false);
  });

  it('does not confuse a typed array with the plain array of the same values', () => {
    // They serialize differently and parse differently; treating them as equal would drop a real change.
    const after = nodeJson();
    after.model.geometry.positions = [0, 0, 0, 1, 0, 0, 1, 1, 0] as any;
    expect(sameSnapshot(nodeJson(), after)).toBe(false);
  });

  it('sees an added and a removed key', () => {
    const added = nodeJson();
    (added as any).castShadow = true;
    expect(sameSnapshot(nodeJson(), added)).toBe(false);

    const removed = nodeJson();
    delete (removed as any).name;
    expect(sameSnapshot(nodeJson(), removed)).toBe(false);
  });

  it('sees a change deep in the children', () => {
    const before = nodeJson();
    const after = nodeJson();
    before.children = [nodeJson()] as any;
    after.children = [nodeJson()] as any;
    expect(sameSnapshot(before, after)).toBe(true);
    (after.children as any)[0].position = [5, 0, 0];
    expect(sameSnapshot(before, after)).toBe(false);
  });

  it('handles null, undefined and mismatched types', () => {
    expect(sameSnapshot(null, null)).toBe(true);
    expect(sameSnapshot(null, {})).toBe(false);
    expect(sameSnapshot(undefined, null)).toBe(false);
    expect(sameSnapshot(1, '1')).toBe(false);
    expect(sameSnapshot([1, 2], { 0: 1, 1: 2 })).toBe(false);
  });
});

describe('shareBuffers — what keeps a model’s history affordable', () => {
  it('adopts the previous snapshot’s array when the bytes match', () => {
    const before = nodeJson();
    const after = shareBuffers(nodeJson(), before);
    // Same object, not merely equal: 200 history entries over one mesh must hold ONE copy of it.
    expect(after.model.geometry.positions).toBe(before.model.geometry.positions);
    expect(after.model.geometry.indices).toBe(before.model.geometry.indices);
  });

  it('leaves a genuinely changed buffer alone', () => {
    const before = nodeJson();
    const changed = nodeJson();
    changed.model.geometry.positions[4] = 9;
    const after = shareBuffers(changed, before);
    expect(after.model.geometry.positions).not.toBe(before.model.geometry.positions);
    expect(after.model.geometry.positions[4]).toBe(9);
    // The untouched one still gets shared.
    expect(after.model.geometry.indices).toBe(before.model.geometry.indices);
  });

  it('makes the next comparison an identity check', () => {
    const before = nodeJson();
    const after = shareBuffers(nodeJson(), before);
    expect(sameSnapshot(before, after)).toBe(true);
    expect(after.model.geometry.positions).toBe(before.model.geometry.positions);
  });

  it('never changes what the snapshot MEANS', () => {
    const before = nodeJson();
    const changed = nodeJson();
    changed.position = [1, 2, 3];
    const after = shareBuffers(changed, before);
    expect(sameSnapshot(before, after)).toBe(false);
    expect(after.position).toEqual([1, 2, 3]);
  });

  it('shares through children', () => {
    const before = nodeJson();
    const next = nodeJson();
    before.children = [nodeJson()] as any;
    next.children = [nodeJson()] as any;
    shareBuffers(next, before);
    expect((next.children as any)[0].model.geometry.positions)
      .toBe((before.children as any)[0].model.geometry.positions);
  });

  it('copes with a subtree that changed shape', () => {
    const before = nodeJson();
    const after = nodeJson();
    after.children = [nodeJson()] as any;
    expect(() => shareBuffers(after, before)).not.toThrow();
    expect(sameSnapshot(before, after)).toBe(false);
  });
});

/**
 * The other big payload shape: a foliage rule bakes its prototype mesh as ONE TUPLE PER VERTEX
 * (`[[x,y,z], …]`, see bakeModel in utils/foliageRules.ts), which a flat-array check does not recognise —
 * the outer array's elements are arrays, not numbers. A landscape node's snapshot carries these through
 * `layer.material.foliageInclude`.
 */
describe('the tuple-per-vertex shape', () => {
  const tuples = (n: number, offset = 0) =>
    Array.from({ length: n }, (_, i) => [i + offset, i * 2, i * 3]);

  const landscape = (over: any = {}) => ({
    id: 'terrain',
    terrain: {
      layers: [{
        material: {
          foliageInclude: [{ models: [{ geometry: { positions: tuples(64), normals: tuples(64) } }] }],
        },
      }],
      ...over,
    },
    children: [],
  });

  it('compares tuple payloads by VALUE, not by element reference', () => {
    // The bug this pins: `a[i] !== b[i]` on two arrays is always true, so every interaction over a
    // landscape would push a junk undo entry.
    expect(sameSnapshot(landscape(), landscape())).toBe(true);
  });

  it('still sees a real change inside a tuple', () => {
    const after = landscape();
    after.terrain.layers[0].material.foliageInclude[0].models[0].geometry.positions[10][1] = 999;
    expect(sameSnapshot(landscape(), after)).toBe(false);
  });

  it('sees a tuple array that changed length', () => {
    const after = landscape();
    after.terrain.layers[0].material.foliageInclude[0].models[0].geometry.positions = tuples(63) as any;
    expect(sameSnapshot(landscape(), after)).toBe(false);
  });

  it('shares an unchanged tuple payload', () => {
    const before = landscape();
    const after = shareBuffers(landscape(), before);
    expect(after.terrain.layers[0].material.foliageInclude[0].models[0].geometry.positions)
      .toBe(before.terrain.layers[0].material.foliageInclude[0].models[0].geometry.positions);
  });

  it('does not mistake a skin’s index/value pairs for a buffer', () => {
    // `nodeTransforms` is [index, matrix] and `nodeNames` is [index, name] — the second element is not a
    // number, so neither may be treated as a vertex payload and skipped by the walkers.
    const skin = (name: string) => ({
      model: { skin: { nodeNames: [[0, name], [1, 'Spine']], nodeParents: [[1, 0]] } },
    });
    expect(sameSnapshot(skin('Hips'), skin('Hips'))).toBe(true);
    expect(sameSnapshot(skin('Hips'), skin('Pelvis'))).toBe(false);
  });
});

import { describe, it, expect, beforeAll } from 'vitest';
import { setGLContext } from '../src/graphics/glContext';
import { WebGL2Device } from '../src/graphics/rhi/webgl2/webgl2Device';
import { setDevice } from '../src/graphics/rhi/deviceHandle';
import { Geometry } from '../src/core/geometry';
import { Model } from '../src/graphics/model';
import { AnimatedModel } from '../src/animation/animatedModel';
import { Material } from '../src/graphics/material';
import { mergeModels } from '../src/graphics/modelMerge';

// A merged model holds several materials over index RANGES of one shared mesh (`materials` parallel to
// `submeshes`). Both halves of that pair have to survive a save/load, and nothing covered it before.
//
// The trap this pins: `serialize()` gates the multi-material form on `_submeshes.length > 1`, NOT on the
// material count, and the constructor drops `submeshes` outright when the two arrays disagree in length.
// Combined, a model whose arrays fell out of step would come back with only its first material — and
// with no error, because each half is individually reasonable.

/**
 * A stub context. `Mesh` allocates a VAO and buffers in its constructor and `AnimatedModel` uploads its
 * bone attributes eagerly, so a handful of real entry points get called even though nothing is ever drawn.
 * Unknown members resolve to a no-op function rather than being enumerated, since the exact set is an
 * implementation detail of code these tests are not about.
 *
 * A device is published alongside the context because buffer allocation moved behind the RHI: `Mesh`
 * now asks `device.createBuffer` rather than calling `gl.createBuffer` itself. The device reads the
 * hardware's limits at construction, which against this stub means every `getExtension` returns
 * undefined and it reports a machine with no optional features — exactly right for a test that never
 * draws.
 */
beforeAll(() => {
  let n = 0;
  const constants: Record<string, number> = {
    UNSIGNED_SHORT: 0x1403, UNSIGNED_INT: 0x1405, ARRAY_BUFFER: 0x8892,
    ELEMENT_ARRAY_BUFFER: 0x8893, STATIC_DRAW: 0x88e4, FLOAT: 0x1406, TRIANGLES: 0x0004,
  };
  const objects = new Set(['createVertexArray', 'createBuffer', 'createTexture']);
  const gl = new Proxy({}, {
    get: (_t, key: string) => (key in constants ? constants[key]
      : objects.has(key) ? () => ({ id: ++n })
      : () => undefined),
  });
  setGLContext(gl as any);

  setDevice(new WebGL2Device(gl as unknown as WebGL2RenderingContext));
});

const geometry = () => new Geometry(
  [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0],   // positions
  [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],   // normals
  [0, 0, 1, 0, 0, 1, 1, 1],               // uvs
  [0, 1, 2, 1, 3, 2],                     // indices
);

const twoMaterials = () => [
  Material.Basic({ color: [1, 0, 0], opacity: 1, texture: 'Null' }),
  Material.Basic({ color: [0, 1, 0], opacity: 1, texture: 'Null' }),
];
const twoRanges = () => [{ start: 0, count: 3 }, { start: 3, count: 3 }];

describe('Model — multi-material round trip', () => {
  it('writes both materials and both ranges, and reads them back', () => {
    const model = new Model(geometry(), twoMaterials(), twoRanges());
    expect(model.hasSubmeshes).toBe(true);

    const json = JSON.parse(JSON.stringify(model.serialize()));
    expect(json.materials).toHaveLength(2);
    expect(json.submeshes).toEqual(twoRanges());
    // `material` is written for every model so single-material readers (and older players) keep working.
    expect(json.material).toBeTruthy();

    const back = Model.parse(json);
    expect(back.materials).toHaveLength(2);
    expect(back.submeshes).toEqual(twoRanges());
    expect(back.hasSubmeshes).toBe(true);
    // The alias must still point at slot 0 after a reload, or every single-material reader sees the wrong one.
    expect(back.material).toBe(back.materials[0]);
  });

  it('keeps the two materials distinguishable across the trip', () => {
    const model = new Model(geometry(), twoMaterials(), twoRanges());
    const back = Model.parse(JSON.parse(JSON.stringify(model.serialize())));
    expect(back.materials[0].properties.get('color')).toEqual([1, 0, 0]);
    expect(back.materials[1].properties.get('color')).toEqual([0, 1, 0]);
  });

  it('a single-material model writes no materials/submeshes at all', () => {
    // The shape almost every saved model has; it must not grow fields it never had.
    const model = new Model(geometry(), twoMaterials()[0]);
    const json = JSON.parse(JSON.stringify(model.serialize()));
    expect(json.materials).toBeUndefined();
    expect(json.submeshes).toBeUndefined();
    expect(Model.parse(json).materials).toHaveLength(1);
    expect(Model.parse(json).hasSubmeshes).toBe(false);
  });

  it('drops a submesh list that does not line up with the materials', () => {
    // Documented, deliberate, and now warned about: the model degrades to one whole-buffer draw rather
    // than letting the renderer index past the end of `materials`.
    const model = new Model(geometry(), twoMaterials(), [{ start: 0, count: 6 }]);
    expect(model.submeshes).toEqual([]);
    expect(model.hasSubmeshes).toBe(false);
  });

  it('setting `material` replaces slot 0 and leaves the other submesh alone', () => {
    const model = new Model(geometry(), twoMaterials(), twoRanges());
    const replacement = Material.Basic({ color: [0, 0, 1], opacity: 1, texture: 'Null' });
    model.material = replacement;
    expect(model.materials[0]).toBe(replacement);
    expect(model.materials[1].properties.get('color')).toEqual([0, 1, 0]);
    expect(model.materials).toHaveLength(2);
  });
});

describe('AnimatedModel — multi-material round trip', () => {
  it('writes and reads both materials and both ranges', () => {
    const model = new AnimatedModel(geometry(), twoMaterials(), undefined, undefined, undefined, [], twoRanges());
    expect(model.hasSubmeshes).toBe(true);

    const json = JSON.parse(JSON.stringify(model.serialize()));
    expect(json.materials).toHaveLength(2);
    expect(json.submeshes).toEqual(twoRanges());

    const back = AnimatedModel.parse(json);
    expect(back.materials).toHaveLength(2);
    expect(back.submeshes).toEqual(twoRanges());
    expect(back.material).toBe(back.materials[0]);
  });

  it('a single-material animated model stays single-material', () => {
    const model = new AnimatedModel(geometry(), twoMaterials()[0]);
    const json = JSON.parse(JSON.stringify(model.serialize()));
    expect(json.materials).toBeUndefined();
    expect(AnimatedModel.parse(json).materials).toHaveLength(1);
  });
});

describe('mergeModels — submeshes, and which part each came from', () => {
  // `sources` is what lets the importer stamp one material-asset link per SUBMESH. The two lists must be
  // built by the same rule: the importer used to de-duplicate the assets globally and assume they lined
  // up, but only CONSECUTIVE parts collapse here, so a material used again later gets a second submesh.
  // The lists then drifted and every link after the first repeat landed on the wrong range.
  const partWith = (mat: Material) => new Model(geometry(), mat);

  it('collapses a run of consecutive parts sharing a material, and reports its first part', () => {
    const a = twoMaterials()[0];
    const merged = mergeModels([partWith(a), partWith(a), partWith(a)])!;
    expect(merged.model.materials).toHaveLength(1);
    expect(merged.model.submeshes).toHaveLength(1);
    expect(merged.sources).toEqual([0]);
  });

  it('gives a material that RECURS non-consecutively a second submesh', () => {
    // A, B, A. The third part cannot join the first: their index ranges are not contiguous.
    const [a, b] = twoMaterials();
    const merged = mergeModels([partWith(a), partWith(b), partWith(a)])!;
    expect(merged.model.materials).toEqual([a, b, a]);
    expect(merged.model.submeshes).toHaveLength(3);
    // Without this the importer had 3 submeshes but only 2 assets, so submesh 2 got no link at all.
    expect(merged.sources).toEqual([0, 1, 2]);
  });

  it('still merges a consecutive pair whose material appeared earlier', () => {
    // A, B, A, A — the trailing pair is contiguous and shares a material, so it is ONE submesh. Testing
    // `indexOf` (the first occurrence) instead of the last group made this an extra draw call forever.
    const [a, b] = twoMaterials();
    const merged = mergeModels([partWith(a), partWith(b), partWith(a), partWith(a)])!;
    expect(merged.model.submeshes).toHaveLength(3);
    expect(merged.sources).toEqual([0, 1, 2]);
  });

  it('keeps sources parallel to submeshes for a long alternating run', () => {
    // The shape of a real 30-part import: every submesh must name the part it came from.
    const [a, b] = twoMaterials();
    const parts = Array.from({ length: 8 }, (_, i) => partWith(i % 2 === 0 ? a : b));
    const merged = mergeModels(parts)!;
    expect(merged.model.submeshes).toHaveLength(8);
    expect(merged.sources).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(merged.model.materials).toHaveLength(8);
  });

  it('ranges tile the whole index buffer with no gap or overlap', () => {
    const [a, b] = twoMaterials();
    const merged = mergeModels([partWith(a), partWith(b), partWith(a)])!;
    let at = 0;
    for (const s of merged.model.submeshes) { expect(s.start).toBe(at); at += s.count; }
    expect(at).toBe(merged.model.geometry.indices.length);
  });
});

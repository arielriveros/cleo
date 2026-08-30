import { describe, it, expect } from 'vitest';
import { packBundleAssets, inflateBundleAssets } from '../src/utils/bundleAssets';
import { BUNDLE_FORMAT_VERSION } from '../src/utils/bundle';
import type { BundleData } from '../src/utils/bundle';
import { bytesToBase64, bytesToDataUrl } from '../src/utils/bytes';

/**
 * Round-trip contract for the `assets.bin` an export bundle now carries.
 *
 * The rule this format lives or dies by: inflating must restore the JSON the editor had BEFORE packing,
 * shape included — plain `number[]`, base64 strings, data URLs. Anything else ripples, because
 * `hashAsset` stringifies these objects (a Float32Array stringifies as `{"0":…}`, not `[…]`),
 * `bundleMerge` deep-clones and id-remaps them, and `Scene.parse` reads them. So most of what is
 * asserted here is `toEqual` against the input, and that is the point.
 */

const cube = () => ({
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  tangents: [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0],
  bitangents: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
  texCoords: [0, 0, 1, 0, 1, 1, 0, 1],
  indices: [0, 1, 2, 0, 2, 3],
});

const clip = () => ({
  name: 'Walk',
  samplers: [{ input: [0, 0.5, 1], output: [0, 1, 0, 1, 0, 0, 0, 1, 0], interpolation: 'LINEAR' }],
  channels: [{ samplerIndex: 0, targetNodeIndex: 3, targetPath: 'translation' }],
});

const skin = () => ({
  name: 'Armature',
  joints: [
    { nodeIndex: 0, inverseBindMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], parentIndex: -1 },
    { nodeIndex: 1, inverseBindMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 2, 0, 1], parentIndex: 0 },
  ],
  skeleton: 0,
  nodeParents: [[1, 0]],
  nodeTransforms: [[0, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]]],
  nodeNames: [[0, 'Hips'], [1, 'Spine']],
  ikRig: null,
});

const THUMB = bytesToDataUrl(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), 'image/png');

/** A bundle in the shape bundleExport gathers, with a knob for each payload family. */
function bundleWith(over: Partial<BundleData> = {}): BundleData {
  return {
    manifest: {
      formatVersion: BUNDLE_FORMAT_VERSION,
      kind: 'project',
      createdAt: 0,
      sceneMetas: [{ id: 's1', name: 'Main', updatedAt: 0 }],
    } as any,
    scenes: {},
    libraries: {
      materials: [], terrainMaterials: [], templates: [], models: [],
      scripts: [], animationFields: [], animations: [], tilesets: [],
    },
    vfs: { version: 1, folders: [], entries: [] } as any,
    textures: [],
    ...over,
  };
}

/** Pack a bundle and inflate a fresh copy of the packed JSON, as an export/import round trip does. */
async function roundTrip(bundle: BundleData): Promise<BundleData> {
  const { blob, index } = await packBundleAssets(bundle);
  // Re-parse: the real path writes the JSON into a zip and reads it back, so anything that only survives
  // as a live object reference would pass here otherwise.
  const reparsed: BundleData = JSON.parse(JSON.stringify({
    manifest: bundle.manifest, scenes: bundle.scenes, libraries: bundle.libraries, vfs: bundle.vfs,
  }));
  reparsed.textures = [];
  await inflateBundleAssets(reparsed, blob, JSON.parse(JSON.stringify(index)));
  return reparsed;
}

const modelNode = (extra: any = {}) => ({ model: { geometry: cube(), material: { type: 'blinn' }, ...extra }, children: [] });

describe('assets.bin round-trip', () => {
  it('restores mesh geometry as the plain number arrays it started as', async () => {
    const source = cube();
    const bundle = bundleWith({ scenes: { s1: { scene: { name: 'root', children: [modelNode()] }, savedAt: 0 } as any } });

    const out = await roundTrip(bundle);
    const geometry = (out.scenes.s1.scene as any).children[0].model.geometry;

    expect(geometry).toEqual(source);
    expect(Array.isArray(geometry.positions)).toBe(true);
    // The material is not the packer's business and must come back untouched.
    expect((out.scenes.s1.scene as any).children[0].model.material).toEqual({ type: 'blinn' });
  });

  it('leaves no vertex data behind in the JSON', async () => {
    const bundle = bundleWith({ scenes: { s1: { scene: { name: 'root', children: [modelNode()] }, savedAt: 0 } as any } });
    await packBundleAssets(bundle);

    const json = JSON.stringify(bundle);
    expect(json.includes('"positions"')).toBe(false);
    expect(json.includes('"indices"')).toBe(false);
    // Packed IN PLACE: the key keeps its slot, so the object's key order — and therefore its content
    // hash — survives the round trip. See the header of bundleAssets.ts.
    expect((bundle.scenes.s1.scene as any).children[0].model.geometry).toEqual({ $geo: 'g0' });
    expect(Object.keys((bundle.scenes.s1.scene as any).children[0].model)).toEqual(['geometry', 'material']);
  });

  it('interns one mesh stored in a model asset, a template and a scene into a single copy', async () => {
    // The exact duplication that motivated this: the shipped example carries the same payload three times.
    const bundle = bundleWith({
      scenes: { s1: { scene: { name: 'root', children: [modelNode()] }, savedAt: 0 } as any },
      libraries: {
        ...bundleWith().libraries,
        models: [{ id: 'm1', name: 'Crate', nodeJson: modelNode(), materialIds: [], thumbnail: '' }] as any,
        templates: [{ id: 't1', name: 'Crate', node: modelNode() }] as any,
      },
    });

    const { blob, index } = await packBundleAssets(bundle);

    expect(Object.keys(index.geometries)).toHaveLength(1);
    // 6 chunks (5 attributes + indices) and nothing more: 4-byte aligned, so under 200 bytes total.
    expect(blob.byteLength).toBeLessThan(256);
  });

  it('keeps genuinely different meshes apart', async () => {
    const other = { ...cube(), positions: [9, 9, 9, 1, 0, 0, 1, 1, 0, 0, 1, 0] };
    const bundle = bundleWith({
      scenes: {
        s1: {
          scene: { name: 'root', children: [modelNode(), { model: { geometry: other }, children: [] }] },
          savedAt: 0,
        } as any,
      },
    });

    const { index } = await packBundleAssets(bundle);
    expect(Object.keys(index.geometries)).toHaveLength(2);
  });

  it('narrows indices to 16 bits, widening only when a mesh needs it', async () => {
    // 65535 is the primitive-restart index, so it counts as out of 16-bit range.
    const small = { ...cube(), indices: [0, 1, 2] };
    const large = { ...cube(), indices: [0, 1, 70000] };
    const scene = (g: any) => ({ s1: { scene: { name: 'root', children: [{ model: { geometry: g }, children: [] }] }, savedAt: 0 } as any });

    const packSmall = await packBundleAssets(bundleWith({ scenes: scene(small) }));
    const packLarge = await packBundleAssets(bundleWith({ scenes: scene(large) }));

    expect((Object.values(packSmall.index.geometries)[0] as any).indices.bits).toBe(16);
    expect((Object.values(packLarge.index.geometries)[0] as any).indices.bits).toBe(32);

    const out = await roundTrip(bundleWith({ scenes: scene(large) }));
    expect((out.scenes.s1.scene as any).children[0].model.geometry.indices).toEqual([0, 1, 70000]);
  });

  it('restores nested foliage geometry as tuples, sharing bytes with the flat copy of the same mesh', async () => {
    // The editor's foliage rule baker emits `[[x,y,z], …]` while Model.serialize emits flat arrays.
    // Restoring the wrong shape would change the terrain material's content hash for no reason.
    const flat = cube();
    const nested = {
      positions: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]],
      normals: [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]],
      tangents: [[1, 0, 0], [1, 0, 0], [1, 0, 0], [1, 0, 0]],
      bitangents: [[0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 1, 0]],
      texCoords: [[0, 0], [1, 0], [1, 1], [0, 1]],
      indices: [0, 1, 2, 0, 2, 3],
    };
    const bundle = bundleWith({
      scenes: {
        s1: {
          scene: {
            name: 'root',
            children: [{
              terrain: {
                foliage: [{ kind: 'mesh', name: 'oak', models: [{ geometry: flat, material: {} }] }],
                layers: [{ material: { foliageInclude: [{ kind: 'mesh', name: 'oak', models: [{ geometry: nested, material: {} }] }] } }],
              },
              children: [],
            }],
          },
          savedAt: 0,
        } as any,
      },
    });

    const { blob, index } = await packBundleAssets(bundle);
    // Two records (they restore to different shapes) but only one mesh worth of bytes.
    expect(Object.keys(index.geometries)).toHaveLength(2);
    expect(blob.byteLength).toBeLessThan(256);

    const out = await roundTrip(bundleWith({
      scenes: JSON.parse(JSON.stringify({
        s1: {
          scene: {
            name: 'root',
            children: [{
              terrain: {
                foliage: [{ kind: 'mesh', name: 'oak', models: [{ geometry: flat, material: {} }] }],
                layers: [{ material: { foliageInclude: [{ kind: 'mesh', name: 'oak', models: [{ geometry: nested, material: {} }] }] } }],
              },
              children: [],
            }],
          },
          savedAt: 0,
        },
      })),
    }));
    const t = (out.scenes.s1.scene as any).children[0].terrain;
    expect(t.foliage[0].models[0].geometry).toEqual(flat);
    expect(t.layers[0].material.foliageInclude[0].models[0].geometry).toEqual(nested);
  });

  it('round-trips skins, joint attributes and animation samplers', async () => {
    const model = {
      geometry: cube(),
      material: {},
      skin: skin(),
      jointIndices: [0, 1, 0, 1, 0, 1, 0, 1],
      jointWeights: [1, 0, 0, 0, 0.5, 0.5, 0, 0],
      animations: [clip()],
    };
    // structuredClone into the bundle: packing MUTATES what it is given, so sharing `model` with the
    // expectation below would quietly rewrite the thing being asserted against.
    const bundle = bundleWith({
      scenes: { s1: { scene: { name: 'root', children: [{ model: structuredClone(model), children: [] }] }, savedAt: 0 } as any },
    });

    const packedCopy = structuredClone(bundle) as BundleData;
    await packBundleAssets(packedCopy);
    const packedJson = JSON.stringify(packedCopy);
    // The arrays are gone but the records that held them are still in place, key order intact.
    expect(packedJson.includes('"inverseBindMatrix":[')).toBe(false);
    expect(packedJson.includes('"output":[')).toBe(false);
    expect(packedJson.includes('"inverseBindMatrix"')).toBe(true);

    const out = await roundTrip(bundle);
    expect((out.scenes.s1.scene as any).children[0].model).toEqual(model);
    expect(Object.keys((out.scenes.s1.scene as any).children[0].model)).toEqual(Object.keys(model));
  });

  it('round-trips a shared .anim asset, sharing its bytes with the embedded copy', async () => {
    const embedded = { model: { geometry: cube(), material: {}, animations: [clip()] }, children: [] };
    const bundle = bundleWith({
      scenes: { s1: { scene: { name: 'root', children: [embedded] }, savedAt: 0 } as any },
      libraries: {
        ...bundleWith().libraries,
        animations: [{ id: 'a1', name: 'Walk', clips: [clip()], sourceSkin: skin() }] as any,
      },
    });

    const before = structuredClone(bundle.libraries.animations);
    const out = await roundTrip(bundle);
    expect(out.libraries.animations).toEqual(before);
  });

  it('round-trips terrain heights and splat, byte-exactly including a zero alpha', async () => {
    // Byte-exact matters: the splat's alpha is layer 3's blend weight, which is why this is DEFLATE and
    // not a canvas PNG encode.
    const splat = new Uint8Array(64);
    for (let i = 0; i < 16; i++) { splat[i * 4] = 200; splat[i * 4 + 1] = 55; }
    const heights = new Uint16Array([0, 1234, 65535, 42, 7, 900, 12, 3]);
    const terrain = {
      size: 100, resolution: 3, splatRes: 4, heightFormat: 'u16', heightMin: 0, heightMax: 10,
      heights: bytesToBase64(new Uint8Array(heights.buffer)),
      splat: bytesToBase64(splat),
    };
    const bundle = bundleWith({
      scenes: { s1: { scene: { name: 'root', children: [{ terrain: structuredClone(terrain), children: [] }] }, savedAt: 0 } as any },
    });

    const out = await roundTrip(bundle);
    expect((out.scenes.s1.scene as any).children[0].terrain).toEqual(terrain);
  });

  it('round-trips foliage instance buffers and tilemap cell grids', async () => {
    const instances = bytesToBase64(new Uint8Array(new Float32Array([1, 2, 3, 0.5, 1.25]).buffer));
    const cells = bytesToBase64(new Uint8Array(new Uint32Array([1, 2, 0, 4]).buffer));
    const tint = bytesToBase64(new Uint8Array(new Uint32Array([0xff00ff00, 0, 0, 0]).buffer));
    const scene = {
      name: 'root',
      children: [
        { terrain: { foliage: [{ kind: 'mesh', name: 'grass', instances }] }, children: [] },
        { tilemap: { layers: [{ chunks: [{ cx: 0, cy: 0, count: 3, data: cells, tint }] }] }, children: [] },
      ],
    };
    const bundle = bundleWith({ scenes: { s1: { scene: structuredClone(scene), savedAt: 0 } as any } });

    const out = await roundTrip(bundle);
    expect(out.scenes.s1.scene).toEqual(scene);
  });

  it('round-trips skybox cubemap faces — the one texture family that never reaches the texture store', async () => {
    const face = (n: number) => bytesToDataUrl(new Uint8Array([0x89, 0x50, n]), 'image/png');
    const skybox = {
      faces: {
        positiveX: face(1), negativeX: face(2), positiveY: face(3),
        negativeY: face(4), positiveZ: face(5), negativeZ: face(6),
      },
    };
    const bundle = bundleWith({
      scenes: { s1: { scene: { name: 'root', children: [{ skybox: structuredClone(skybox), children: [] }] }, savedAt: 0 } as any },
    });

    const out = await roundTrip(bundle);
    expect((out.scenes.s1.scene as any).children[0].skybox).toEqual(skybox);
    // Faces keep their order, which is what Skybox.fromBase64 reads them back in.
    expect(Object.keys((out.scenes.s1.scene as any).children[0].skybox.faces)).toEqual(Object.keys(skybox.faces));
  });

  it('round-trips every thumbnail, including the scene metas in the manifest', async () => {
    const bundle = bundleWith({
      libraries: {
        ...bundleWith().libraries,
        materials: [{ id: 'mat', name: 'Rock', material: {}, thumbnail: THUMB }] as any,
        models: [{ id: 'm', name: 'Crate', nodeJson: {}, materialIds: [], thumbnail: THUMB }] as any,
      },
    });
    (bundle.manifest as any).sceneMetas[0].thumbnail = THUMB;

    const packedCopy = structuredClone(bundle) as BundleData;
    await packBundleAssets(packedCopy);
    expect(JSON.stringify(packedCopy).includes('data:image')).toBe(false);

    const out = await roundTrip(bundle);
    expect((out.libraries.materials[0] as any).thumbnail).toBe(THUMB);
    expect((out.libraries.models[0] as any).thumbnail).toBe(THUMB);
    expect((out.manifest as any).sceneMetas[0].thumbnail).toBe(THUMB);
  });

  it('round-trips texture bytes with their mime and config, and gives each its own buffer', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]);
    const bundle = bundleWith({
      textures: [
        { id: 'a', mime: 'image/png', config: { flipY: true, wrapping: 'repeat' }, bytes: png.slice().buffer },
        { id: 'b', mime: 'image/jpeg', config: {}, bytes: new Uint8Array([1, 2, 3]).buffer },
      ],
    });

    const out = await roundTrip(bundle);
    expect(out.textures).toHaveLength(2);
    expect(out.textures[0].id).toBe('a');
    expect(out.textures[0].mime).toBe('image/png');
    expect(out.textures[0].config).toEqual({ flipY: true, wrapping: 'repeat' });
    expect(Array.from(new Uint8Array(out.textures[0].bytes))).toEqual(Array.from(png));
    // Own buffers, not views onto the container: bundleImport wraps these in a Blob and bundleMerge
    // dedupes on byteLength, and a view would make both read the whole (potentially 200 MB) blob.
    expect(out.textures[0].bytes.byteLength).toBe(png.length);
    expect(out.textures[1].bytes.byteLength).toBe(3);
  });

  it('aligns every chunk to 4 bytes, even after an odd-length payload', async () => {
    const bundle = bundleWith({
      scenes: { s1: { scene: { name: 'root', children: [modelNode()] }, savedAt: 0 } as any },
      textures: [
        { id: 'odd', mime: 'image/png', config: {}, bytes: new Uint8Array([1, 2, 3]).buffer },
        { id: 'odd2', mime: 'image/png', config: {}, bytes: new Uint8Array([4, 5, 6, 7, 8]).buffer },
      ],
    });

    const { blob, index } = await packBundleAssets(bundle);
    for (const geometry of Object.values(index.geometries)) {
      for (const chunk of Object.values(geometry) as any[]) if (chunk?.o !== undefined) expect(chunk.o % 4).toBe(0);
    }
    for (const t of index.textures) expect(t.o % 4).toBe(0);
    expect(blob.byteLength % 4).toBe(0);
  });

  it('throws on a truncated blob instead of yielding garbage vertices', async () => {
    const bundle = bundleWith({ scenes: { s1: { scene: { name: 'root', children: [modelNode()] }, savedAt: 0 } as any } });
    const { blob, index } = await packBundleAssets(bundle);

    const truncated = blob.slice(0, blob.byteLength - 8);
    const reparsed: BundleData = JSON.parse(JSON.stringify({
      manifest: bundle.manifest, scenes: bundle.scenes, libraries: bundle.libraries, vfs: bundle.vfs,
    }));
    reparsed.textures = [];
    await expect(inflateBundleAssets(reparsed, truncated, index)).rejects.toThrow(/truncated/);
  });

  it('picks the narrowest float width that loses nothing', async () => {
    // A float32-representable array costs 4 bytes a value; one that is not costs 8. Guessing either way
    // is wrong — forcing f32 silently rewrites values (and with them the asset's content hash), forcing
    // f64 doubles the largest payload in the bundle.
    const f32 = 0.5;
    const f64 = -97.49442258477211;          // straight out of the shipped example's animation samplers
    expect(Math.fround(f64)).not.toBe(f64);  // ...and genuinely not float32-representable

    const scene = (values: number[]) => ({
      s1: {
        scene: {
          name: 'root',
          children: [{
            model: {
              geometry: cube(),
              animations: [{ name: 'A', samplers: [{ input: [0, 1], output: values, interpolation: 'LINEAR' }], channels: [] }],
            },
            children: [],
          }],
        },
        savedAt: 0,
      } as any,
    });

    const narrow = await packBundleAssets(bundleWith({ scenes: scene([f32, f32, f32, f32]) }));
    const wide = await packBundleAssets(bundleWith({ scenes: scene([f64, f64, f64, f64]) }));
    expect(wide.blob.byteLength - narrow.blob.byteLength).toBe(16); // 4 values, 4 bytes wider each

    const out = await roundTrip(bundleWith({ scenes: scene([f64, f32, f64, f32]) }));
    const sampler = (out.scenes.s1.scene as any).children[0].model.animations[0].samplers[0];
    expect(sampler.output).toEqual([f64, f32, f64, f32]);
    expect(sampler.input).toEqual([0, 1]);
  });

  it('keeps float64 precision through the nested-tuple flattening the foliage baker produces', async () => {
    const v = -0.44134953779617336; // a value the foliage baker really emits; not float32-representable
    const nested = {
      positions: [[v, v, v], [1, 0, 0], [1, 1, 0], [0, 1, 0]],
      indices: [0, 1, 2],
    };
    const bundle = bundleWith({
      scenes: {
        s1: {
          scene: {
            name: 'root',
            children: [{ terrain: { foliage: [{ models: [{ geometry: structuredClone(nested) }] }] }, children: [] }],
          },
          savedAt: 0,
        } as any,
      },
    });

    const out = await roundTrip(bundle);
    expect((out.scenes.s1.scene as any).children[0].terrain.foliage[0].models[0].geometry).toEqual(nested);
  });

  it('leaves a bundle with nothing to pack alone', async () => {
    const bundle = bundleWith();
    const { blob, index } = await packBundleAssets(bundle);
    expect(blob.byteLength).toBe(0);
    expect(index.geometries).toEqual({});
    expect(index.textures).toEqual([]);
  });
});

/**
 * `Model.serialize` writes geometry and joint attributes as TYPED arrays (see serializeGeometry in
 * src/graphics/model.ts) — a plain `number[]` costs 8 bytes an element and doubled every stored mesh.
 * The round-trip rule is unchanged by that: inflate must restore the container the value went in as, or
 * an asset's content hash moves just by being exported and imported. The `t` flag on a marker, and
 * `typed` on a geometry record, are what remember it.
 */
describe('assets.bin round-trip — typed arrays', () => {
  const typedCube = () => ({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    tangents: new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0]),
    bitangents: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    texCoords: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  });

  const sceneWith = (model: any) =>
    bundleWith({ scenes: { s1: { scene: { name: 'root', children: [{ model, children: [] }] }, savedAt: 0 } as any } });

  const outModel = (out: BundleData) => (out.scenes.s1.scene as any).children[0].model;

  it('restores typed geometry as typed arrays, with the same values', async () => {
    const source = typedCube();
    const out = await roundTrip(sceneWith({ geometry: typedCube(), material: { type: 'blinn' } }));
    const geometry = outModel(out).geometry;

    expect(geometry.positions).toBeInstanceOf(Float32Array);
    expect(geometry.indices).toBeInstanceOf(Uint32Array);
    expect(Array.from(geometry.positions)).toEqual(Array.from(source.positions));
    expect(Array.from(geometry.indices)).toEqual(Array.from(source.indices));
  });

  it('still restores PLAIN geometry as plain arrays — an older asset must not change shape', async () => {
    const out = await roundTrip(sceneWith({ geometry: cube(), material: { type: 'blinn' } }));
    expect(Array.isArray(outModel(out).geometry.positions)).toBe(true);
  });

  it('packs typed joint attributes instead of leaving them in the JSON as {"0":…}', async () => {
    const bundle = sceneWith({
      geometry: typedCube(),
      material: { type: 'blinn' },
      jointIndices: new Float32Array([0, 1, 2, 3]),
      jointWeights: new Float32Array([1, 0, 0, 0]),
    });
    await packBundleAssets(bundle);
    const json = JSON.stringify(bundle);
    // The bug an `Array.isArray`-only guard causes: the buffer survives as an object literal in the zip.
    expect(json.includes('"0":0')).toBe(false);
    expect(json.includes('$f32')).toBe(true);
  });

  it('restores typed joint attributes as typed arrays', async () => {
    const out = await roundTrip(sceneWith({
      geometry: typedCube(),
      material: { type: 'blinn' },
      jointIndices: new Float32Array([0, 1, 2, 3]),
      jointWeights: new Float32Array([1, 0, 0, 0]),
    }));
    expect(outModel(out).jointIndices).toBeInstanceOf(Float32Array);
    expect(Array.from(outModel(out).jointWeights)).toEqual([1, 0, 0, 0]);
  });

  it('keeps the two containers apart within ONE model — the reason the flag is per payload', async () => {
    // A skinned model carries typed joint data and plain-array animation samplers at the same time.
    const out = await roundTrip(sceneWith({
      geometry: typedCube(),
      material: { type: 'blinn' },
      jointIndices: new Float32Array([0, 1, 2, 3]),
      animations: [clip()],
    }));
    expect(outModel(out).jointIndices).toBeInstanceOf(Float32Array);
    expect(Array.isArray(outModel(out).animations[0].samplers[0].input)).toBe(true);
    expect(outModel(out).animations[0]).toEqual(clip());
  });

  it('interns the same mesh once whichever container it arrived in', async () => {
    // The bytes are identical, so a typed copy and a plain copy must not cost two chunks.
    const bundle = bundleWith({
      scenes: {
        s1: {
          scene: {
            name: 'root',
            children: [
              { model: { geometry: typedCube(), material: { type: 'blinn' } }, children: [] },
              { model: { geometry: cube(), material: { type: 'blinn' } }, children: [] },
            ],
          },
          savedAt: 0,
        } as any,
      },
    });
    const { index } = await packBundleAssets(bundle);
    // Two geometry RECORDS (they restore differently), but the chunk offsets they point at are shared.
    const records = Object.values(index.geometries);
    expect(records).toHaveLength(2);
    expect(records[0].positions!.o).toBe(records[1].positions!.o);
  });
});

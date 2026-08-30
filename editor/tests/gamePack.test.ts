import { describe, it, expect } from 'vitest';
import { packGameBin, PACK_HEADER_BYTES, PLAYER_CONTRACT } from '../src/features/publish/pack';
import { unpackGameBin, inflateSceneGeometry, inflateTerrainData } from '../src/player/unpack';

/**
 * Round-trip contract for the `game.bin` container that publishing emits.
 *
 * This format exists to be read with zero parsing: the player maps typed arrays directly onto the
 * downloaded ArrayBuffer. That makes two classes of bug silent rather than loud — a misaligned or
 * mis-sized chunk yields plausible-looking garbage vertices instead of throwing, and a geometry that
 * aliases another instance's buffer only shows up as a mesh deforming when something else is scaled.
 * Both are covered below.
 */

const model = (geometry: any) => ({ model: { geometry, material: { type: 'blinn' } }, children: [] });

const cube = () => ({
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  tangents: [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0],
  bitangents: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
  texCoords: [0, 0, 1, 0, 1, 1, 0, 1],
  indices: [0, 1, 2, 0, 2, 3],
});

/** A game-data object in the shape buildMultiSceneGameData produces. */
const gameWith = (children: any[], textureBytes: any[] = []) => ({
  version: 2,
  entry: 'main',
  scenes: { main: { name: 'Main', scene: { name: 'root', children } } },
  config: { graphics: { clearColor: [0, 0, 0, 1] }, render: { exposure: 1 } },
  textureBytes,
});

describe('game.bin round-trip', () => {
  it('restores every vertex attribute byte-for-byte', () => {
    const source = cube();
    const { buffer } = packGameBin(gameWith([model(cube())]));
    const game = unpackGameBin(buffer);

    const ref = Object.keys(game.manifest.geometries)[0];
    const geometry = game.geometryFor(ref)!;

    expect(Array.from(geometry.positions!)).toEqual(source.positions);
    expect(Array.from(geometry.normals!)).toEqual(source.normals);
    expect(Array.from(geometry.tangents!)).toEqual(source.tangents);
    expect(Array.from(geometry.bitangents!)).toEqual(source.bitangents);
    expect(Array.from(geometry.texCoords!)).toEqual(source.texCoords);
    expect(Array.from(geometry.indices!)).toEqual(source.indices);
  });

  it('carries scenes, entry and config through the manifest', () => {
    const { buffer } = packGameBin(gameWith([model(cube())]));
    const { manifest } = unpackGameBin(buffer);

    expect(manifest.format).toBe('cleopak');
    expect(manifest.entry).toBe('main');
    expect(manifest.scenes.main.name).toBe('Main');
    expect(manifest.config.render.exposure).toBe(1);
  });

  // The stamp publishing checks against public/player/build.json before it ships a bundle, and the
  // player re-checks at boot. Without it a player built before a packer change renders the game wrong
  // in silence — which is exactly how a month-stale bundle published flat terrain and dead animation
  // fields. Not asserting a literal: the point is that the number travels, not what it currently is.
  it('stamps the player contract into the manifest', () => {
    const { buffer } = packGameBin(gameWith([model(cube())]));
    expect(unpackGameBin(buffer).manifest.contract).toBe(PLAYER_CONTRACT);
  });

  it('replaces inline geometry with a ref and puts it back on inflate', () => {
    const data = gameWith([model(cube())]);
    const { buffer } = packGameBin(data);

    // packGameBin mutates its input, exactly as packAssets did.
    const packedNode = data.scenes.main.scene.children[0] as any;
    expect(packedNode.model.geometry).toBeUndefined();
    expect(typeof packedNode.model.geometryRef).toBe('string');

    const game = unpackGameBin(buffer);
    const scene = game.manifest.scenes.main.scene;
    inflateSceneGeometry(scene, game);

    const node = (scene as any).children[0];
    expect(node.model.geometryRef).toBeUndefined();
    expect(node.model.geometry.positions).toBeInstanceOf(Float32Array);
    expect(node.model.material.type).toBe('blinn'); // untouched by the pack
  });

  it('dedupes identical geometries to one chunk and keeps distinct ones apart', () => {
    const different = { ...cube(), positions: [9, 9, 9, 1, 0, 0, 1, 1, 0, 0, 1, 0] };
    const { buffer } = packGameBin(gameWith([model(cube()), model(cube()), model(different)]));
    const game = unpackGameBin(buffer);

    expect(Object.keys(game.manifest.geometries)).toHaveLength(2);

    const scene = game.manifest.scenes.main.scene as any;
    const refs = scene.children.map((c: any) => c.model.geometryRef);
    expect(refs[0]).toBe(refs[1]);
    expect(refs[0]).not.toBe(refs[2]);
  });

  it('aligns every chunk to 4 bytes so typed-array views are constructible', () => {
    // Odd-length texture payloads are the realistic way to knock the blob out of alignment.
    const textures = [
      { id: 't1', mime: 'image/png', config: { flipY: true }, bytes: new Uint8Array([1, 2, 3]) },
      { id: 't2', mime: 'image/jpeg', config: {}, bytes: new Uint8Array([4, 5, 6, 7, 8]) },
    ];
    const { buffer } = packGameBin(gameWith([model(cube())], textures));
    const { manifest } = unpackGameBin(buffer);

    const manifestLength = new DataView(buffer).getUint32(12, true);
    const blobStart = (PACK_HEADER_BYTES + manifestLength + 3) & ~3;
    expect(blobStart % 4).toBe(0);

    for (const geometry of Object.values(manifest.geometries)) {
      for (const chunk of Object.values(geometry) as any[]) expect(chunk.o % 4).toBe(0);
    }
  });

  it('round-trips texture bytes with their mime and config', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]);
    const { buffer } = packGameBin(gameWith([model(cube())], [
      { id: 'tex-a', mime: 'image/png', config: { flipY: true, wrapping: 'repeat' }, bytes: png },
    ]));
    const { textures } = unpackGameBin(buffer);

    expect(textures).toHaveLength(1);
    expect(textures[0].id).toBe('tex-a');
    expect(textures[0].mime).toBe('image/png');
    expect(textures[0].config).toEqual({ flipY: true, wrapping: 'repeat' });
    expect(Array.from(textures[0].bytes)).toEqual(Array.from(png));
  });

  it('narrows indices to 16 bits, and widens to 32 only when a mesh needs it', () => {
    const small = { ...cube(), indices: [0, 1, 2] };
    // 65535 is the primitive-restart index, so it is deliberately treated as out of 16-bit range.
    const large = { ...cube(), indices: [0, 1, 70000] };

    const packSmall = unpackGameBin(packGameBin(gameWith([model(small)])).buffer);
    const packLarge = unpackGameBin(packGameBin(gameWith([model(large)])).buffer);

    const only = (g: any) => Object.values(g.manifest.geometries)[0] as any;
    expect(only(packSmall).indices.bits).toBe(16);
    expect(only(packLarge).indices.bits).toBe(32);

    const refLarge = Object.keys(packLarge.manifest.geometries)[0];
    expect(Array.from(packLarge.geometryFor(refLarge)!.indices!)).toEqual([0, 1, 70000]);
  });

  it('gives each reference to a shared geometry its own array', () => {
    // Geometry.scale() writes into _positions in place and toFlat() does not copy a Float32Array, so
    // handing two instances the same view would let one scaled mesh deform the other.
    const { buffer } = packGameBin(gameWith([model(cube()), model(cube())]));
    const game = unpackGameBin(buffer);
    const ref = Object.keys(game.manifest.geometries)[0];

    const first = game.geometryFor(ref)!;
    const second = game.geometryFor(ref)!;

    first.positions![0] = 123;
    expect(second.positions![0]).toBe(0);
    expect(second.positions!.buffer).not.toBe(first.positions!.buffer);
  });

  it('rejects a file that is not a Cleo pack', () => {
    expect(() => unpackGameBin(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 0, 0, 0, 0, 0, 0]).buffer))
      .toThrow(/Not a Cleo game pack/);
    expect(() => unpackGameBin(new ArrayBuffer(4))).toThrow(/truncated/);
  });

  it('interns foliage prototype geometry, and dedupes the nested and flat copies of it', async () => {
    // The same mesh reaches the packer twice in two DIFFERENT shapes: the terrain material's foliage
    // rule carries it as nested tuples (utils/foliageRules.ts bakes it that way) while the scattered
    // layer carries the flat Model.serialize() form. Both must normalize to the same bytes, or the
    // dedup silently ships the mesh twice — and `new Float32Array(number[][])` would fill it with NaN.
    const flat = cube();
    const nested = {
      positions: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]],
      normals: [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]],
      tangents: [[1, 0, 0], [1, 0, 0], [1, 0, 0], [1, 0, 0]],
      bitangents: [[0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 1, 0]],
      texCoords: [[0, 0], [1, 0], [1, 1], [0, 1]],
      indices: [0, 1, 2, 0, 2, 3],
    };
    const terrainNode = {
      terrain: {
        foliage: [{ kind: 'mesh', name: 'oak', models: [{ geometry: flat, material: {} }] }],
        layers: [{ material: { foliageInclude: [{ kind: 'mesh', name: 'oak', models: [{ geometry: nested, material: {} }] }] } }],
      },
      children: [],
    };

    const data = gameWith([terrainNode]);
    const { buffer } = packGameBin(data);

    // One chunk for both copies, and no vertex arrays left in the scene trees at all. (The geometry
    // TABLE legitimately keys its chunk refs by attribute name, so only the scenes are checked.)
    const game = unpackGameBin(buffer);
    expect(Object.keys(game.manifest.geometries)).toHaveLength(1);
    expect(JSON.stringify(game.manifest.scenes).includes('"positions"')).toBe(false);

    const scene = game.manifest.scenes.main.scene as any;
    inflateSceneGeometry(scene, game);
    const t = scene.children[0].terrain;
    const fromLayer = t.foliage[0].models[0].geometry;
    const fromRule = t.layers[0].material.foliageInclude[0].models[0].geometry;

    expect(Array.from(fromLayer.positions)).toEqual(flat.positions);
    expect(Array.from(fromRule.positions)).toEqual(flat.positions);
    // Distinct arrays: FoliageLayer builds separate Model objects from each, and Geometry.scale()
    // writes positions in place.
    expect(fromRule.positions.buffer).not.toBe(fromLayer.positions.buffer);
  });

  it('round-trips deflated terrain heights and splat through the blob', async () => {
    const heights = new Uint16Array([0, 1234, 65535, 42, 7, 900, 12, 3]);
    const splat = new Uint8Array(64);
    for (let i = 0; i < 16; i++) { splat[i * 4] = 200; splat[i * 4 + 1] = 55; } // alpha stays 0 on purpose

    const deflate = async (bytes: Uint8Array) => new Uint8Array(await new Response(
      new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());

    const node = {
      terrain: {
        resolution: 3, splatRes: 4, heightFormat: 'u16', heightMin: 0, heightMax: 10,
        heightBytes: await deflate(new Uint8Array(heights.buffer)),
        splatBytes: await deflate(splat),
      },
      children: [],
    };

    const { buffer } = packGameBin(gameWith([node]));
    const game = unpackGameBin(buffer);
    const scene = game.manifest.scenes.main.scene as any;
    await inflateTerrainData(scene, game);

    const t = scene.children[0].terrain;
    expect(Array.from(t.heightsU16)).toEqual(Array.from(heights));
    // Byte-exact including the zero alpha — the reason this is DEFLATE and not a canvas PNG encode.
    expect(Array.from(t.splatData)).toEqual(Array.from(splat));
    expect(t.splatChunk).toBeUndefined();
    expect(t.heightChunk).toBeUndefined();
  });

  it('leaves a terrain with only base64 payloads untouched (old game.bin still loads)', async () => {
    const node = { terrain: { heights: 'AAAA', splat: 'BBBB', splatRes: 2 }, children: [] };
    const { buffer } = packGameBin(gameWith([node]));
    const game = unpackGameBin(buffer);
    const scene = game.manifest.scenes.main.scene as any;
    await inflateTerrainData(scene, game);

    expect(scene.children[0].terrain.heights).toBe('AAAA');
    expect(scene.children[0].terrain.splat).toBe('BBBB');
  });

  it('is dramatically smaller than the JSON it replaces', () => {
    // 3000 vertices of realistic float data — full-precision values (the case the format exists for),
    // which JSON.stringify writes as ~18-char decimal strings but the pack writes as 4 bytes each.
    const f = (i: number) => Math.sin(i) * 12.3456789;
    const big = {
      positions: Array.from({ length: 9000 }, (_, i) => f(i)),
      normals: Array.from({ length: 9000 }, (_, i) => f(i + 1)),
      tangents: Array.from({ length: 9000 }, (_, i) => f(i + 2)),
      bitangents: Array.from({ length: 9000 }, (_, i) => f(i + 3)),
      texCoords: Array.from({ length: 6000 }, (_, i) => f(i + 4)),
      indices: Array.from({ length: 3000 }, (_, i) => i),
    };
    const asJson = JSON.stringify(gameWith([model(big)])).length;
    const asBin = packGameBin(gameWith([model(big)])).buffer.byteLength;

    expect(asBin).toBeLessThan(asJson / 2);
  });
});

/**
 * `Model.serialize` writes vertex buffers and per-vertex bone data as TYPED arrays now (a plain number[]
 * costs 8 bytes an element and doubled every stored mesh). That is invisible to geometry, which was
 * already chunked — but a skinned model's `jointIndices`/`jointWeights` used to ride along in the
 * manifest JSON, where a typed array stringifies as `{"0":…}` and loads back as nothing. They are
 * chunked now, which is what PLAYER_CONTRACT 6 marks.
 */
describe('game.bin — skinned models and typed arrays', () => {
  const typedCube = () => ({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    texCoords: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  });

  const JOINTS = [0, 1, 0, 0, 1, 2, 0, 0, 2, 3, 0, 0, 3, 0, 0, 0];
  const WEIGHTS = [1, 0, 0, 0, 0.5, 0.5, 0, 0, 0.25, 0.75, 0, 0, 1, 0, 0, 0];

  const skinned = (typed: boolean) => ({
    model: {
      geometry: typed ? typedCube() : cube(),
      material: { type: 'pbr' },
      jointIndices: typed ? new Float32Array(JOINTS) : JOINTS.slice(),
      jointWeights: typed ? new Float32Array(WEIGHTS) : WEIGHTS.slice(),
      skin: { name: 'Armature', joints: [{ nodeIndex: 0, inverseBindMatrix: new Float32Array(16), parentIndex: -1 }] },
    },
    children: [],
  });

  it('packs typed geometry byte-for-byte', () => {
    const { buffer } = packGameBin(gameWith([skinned(true)]));
    const game = unpackGameBin(buffer);
    const geometry = game.geometryFor(Object.keys(game.manifest.geometries)[0])!;
    expect(Array.from(geometry.positions!)).toEqual([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    expect(Array.from(geometry.indices!)).toEqual([0, 1, 2, 0, 2, 3]);
  });

  it('restores bone data through the scene inflate', () => {
    const data = gameWith([skinned(true)]);
    const { buffer } = packGameBin(data);
    const game = unpackGameBin(buffer);
    const scene = game.manifest.scenes.main.scene;
    inflateSceneGeometry(scene, game);

    const model = (scene as any).children[0].model;
    expect(Array.from(model.jointIndices)).toEqual(JOINTS);
    expect(Array.from(model.jointWeights)).toEqual(WEIGHTS);
    // The marker must be gone, or AnimatedModel.parse sees a field it does not know.
    expect(model.jointIndicesChunk).toBeUndefined();
    expect(model.jointWeightsChunk).toBeUndefined();
  });

  it('works the same for a model that still carries plain arrays', () => {
    const data = gameWith([skinned(false)]);
    const { buffer } = packGameBin(data);
    const game = unpackGameBin(buffer);
    const scene = game.manifest.scenes.main.scene;
    inflateSceneGeometry(scene, game);
    expect(Array.from((scene as any).children[0].model.jointIndices)).toEqual(JOINTS);
  });

  it('leaves NO typed array in the manifest JSON', () => {
    // The failure this guards: `{"0":0,"1":1,…}` in the manifest, which the player reads as an empty
    // buffer and renders as a character collapsed onto the origin, silently.
    const { buffer } = packGameBin(gameWith([skinned(true)]));
    const game = unpackGameBin(buffer);
    const json = JSON.stringify(game.manifest);
    expect(json.includes('"0":')).toBe(false);
    expect(json.includes('jointIndices"')).toBe(false);
    // The skin's inverse-bind matrices are small enough to stay inline, but as a plain ARRAY.
    const skin = (game.manifest.scenes.main.scene as any).children[0].model.skin;
    expect(Array.isArray(skin.joints[0].inverseBindMatrix)).toBe(true);
  });

  it('is stamped with the contract that introduced the joint chunks', () => {
    const { buffer } = packGameBin(gameWith([skinned(true)]));
    expect(unpackGameBin(buffer).manifest.contract).toBe(PLAYER_CONTRACT);
    expect(PLAYER_CONTRACT).toBeGreaterThanOrEqual(6);
  });
});

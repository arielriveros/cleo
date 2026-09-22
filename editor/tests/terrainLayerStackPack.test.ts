import { describe, it, expect } from 'vitest';
import { packGameBin } from '../src/features/publish/pack';
import { unpackGameBin, inflateSceneGeometry, inflateTerrainData } from '../src/player/unpack';
import { compressTerrainData } from '../src/features/publish/terrainImages';
import { collectPublishedTextureIds } from '../src/utils/references';
import { serializedTerrainLayers, serializedTerrainFoliageRules } from '../src/utils/terrainJson';
import { bytesToBase64 } from 'cleo';

// A landscape saved with the layer stack keeps its layers under `terrain.layerStack` — a base, paint
// layers, and paint MASKS instead of the old splat. Every walker that knew the old shape must know this
// one: the masks must survive publish byte for byte, and a slot's textures and a paint layer's foliage
// must still ship. These pin each of those paths.

const gameWith = (children: any[]) => ({
  version: 2,
  entry: 'main',
  scenes: { main: { name: 'Main', scene: { name: 'root', children } } },
  config: { graphics: { clearColor: [0, 0, 0, 1] }, render: { exposure: 1 } },
  textureBytes: [],
});

const cube = () => ({
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  texCoords: [0, 0, 1, 0, 1, 1, 0, 1],
  indices: [0, 1, 2, 0, 2, 3],
});

/** A serialized landscape material with one extra slot and one mesh foliage rule. */
const landscapeMaterial = (tex: string) => ({
  type: 'basic', terrainMaterial: true, textures: { texture: `${tex}.albedo` },
  slots: [{ id: 's1', name: 'Rock', surfaceMaterialId: 'mat-rock', tiling: 20, material: { type: 'pbr', textures: { normalMap: `${tex}.rock.normal` } } }],
  foliageInclude: [{ kind: 'mesh', name: 'Bush', models: [{ geometry: cube(), material: { type: 'basic', textures: { texture: `${tex}.bush` } } }] }],
});

const stackTerrain = (masks: Uint8Array) => ({
  resolution: 3, size: 10,
  layerStack: {
    layerFormat: 2,
    base: { materialId: 'lm-grass', material: landscapeMaterial('grass') },
    paintLayers: [{ id: 'road', name: 'Road', channel: 0, visible: true, opacity: 1, materialId: 'lm-road', material: landscapeMaterial('road') }],
    maskRes: 8, maskSlices: 1,
    masks: bytesToBase64(masks),
  },
});

describe('the layer stack through publish', () => {
  it('masks survive deflate, pack and unpack byte for byte (alpha included)', async () => {
    // 16x16 texels: past publish's 512-byte threshold, below which a payload stays base64.
    const masks = new Uint8Array(16 * 16 * 4);
    for (let i = 0; i < masks.length; i++) masks[i] = (i * 37) & 255;
    const node = { terrain: stackTerrain(masks), children: [] };
    await compressTerrainData(node);
    expect(typeof (node.terrain.layerStack as any).masks).toBe('undefined');
    expect((node.terrain.layerStack as any).masksBytes).toBeInstanceOf(Uint8Array);

    const { buffer } = packGameBin(gameWith([node]));
    const game = unpackGameBin(buffer);
    const scene = game.manifest.scenes.main.scene as any;
    await inflateTerrainData(scene, game);
    const stack = scene.children[0].terrain.layerStack;
    expect(Array.from(stack.masksData)).toEqual(Array.from(masks));
    expect(stack.masksChunk).toBeUndefined();
  });

  it("interns a PAINT layer's foliage prototypes and restores them", async () => {
    const node = { terrain: stackTerrain(new Uint8Array(8 * 8 * 4)), children: [] };
    const { buffer } = packGameBin(gameWith([node]));
    const game = unpackGameBin(buffer);
    const scene = game.manifest.scenes.main.scene as any;
    inflateSceneGeometry(scene, game);
    const road = scene.children[0].terrain.layerStack.paintLayers[0].material;
    expect(Array.from(road.foliageInclude[0].models[0].geometry.positions)).toEqual(cube().positions);
  });

  it('ships every slot texture of the base and of each paint layer', () => {
    const set = new Set<string>();
    collectPublishedTextureIds({ terrain: stackTerrain(new Uint8Array(4)), children: [] }, set);
    for (const id of ['grass.albedo', 'grass.rock.normal', 'grass.bush', 'road.albedo', 'road.rock.normal', 'road.bush'])
      expect(set.has(id)).toBe(true);
  });
});

describe('serializedTerrainLayers', () => {
  it('reads the stack (base first) and the legacy four slots alike', () => {
    const stack = serializedTerrainLayers(stackTerrain(new Uint8Array(4)))
    expect(stack.map(l => l.materialId)).toEqual(['lm-grass', 'lm-road']);
    const legacy = serializedTerrainLayers({ layers: [{ materialId: 'a', material: {} }, { textureId: 'old.png' }, null] });
    expect(legacy.map(l => [l.materialId, l.textureId])).toEqual([['a', null], [null, 'old.png']]);
    expect(serializedTerrainLayers(null)).toEqual([]);
  });

  it('collects the foliage rules of every layer', () => {
    expect(serializedTerrainFoliageRules(stackTerrain(new Uint8Array(4))).map(r => r.name)).toEqual(['Bush', 'Bush']);
  });
});

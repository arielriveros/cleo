import { describe, it, expect } from 'vitest';
import { packGameBin } from '../editor/src/features/publish/pack';
import { unpackGameBin, inflateTilemapData } from '../editor/src/player/unpack';
import { Tilemap } from '../src/tilemap/tilemap';
import { Tileset } from '../src/tilemap/tileset';
import { CHUNK_SIZE } from '../src/tilemap/chunk';
import { compressTilemapData } from '../editor/src/features/publish/terrainImages';

// The publish round-trip for a tilemap's cell grids: base64 in the editor's blob, DEFLATE in game.bin,
// a pre-decoded Uint32Array on the way back in. Mirrors gamePack's terrain height/splat coverage.

function mapWithTiles(): any {
  const tm = new Tilemap({ kind: 'orthogonal', cellWidth: 1, cellHeight: 1 });
  tm.registerTileset(new Tileset({
    id: 'ts', textureId: 'atlas.png', imageWidth: 64, imageHeight: 64,
    tileWidth: 16, tileHeight: 16, columns: 4, rows: 4,
  }));
  tm.addLayer({ name: 'Ground', tilesetId: 'ts' });
  // A full chunk, so the payload clears the compression threshold.
  tm.fillRect(0, 0, 0, CHUNK_SIZE - 1, CHUNK_SIZE - 1, 3);
  tm.setTile(0, 2, 2, 7, { flipX: true, rot90: true });
  return tm;
}

function sceneWith(tilemapJson: any): any {
  return { name: 'root', id: 'root', type: 'node', children: [
    { name: 'Tilemap', id: 'map', type: 'tilemap', children: [], tilemap: tilemapJson },
  ] };
}

describe('tilemap publish round-trip', () => {
  it('moves deflated cell grids into the blob and back out as a typed array', async () => {
    const source = mapWithTiles();
    const json = JSON.parse(JSON.stringify(source.serialize()));
    const scene = sceneWith(json);

    await compressTilemapData(scene);
    const chunkJson = scene.children[0].tilemap.layers[0].chunks[0];
    expect(chunkJson.data).toBeUndefined();
    expect(chunkJson.dataBytes).toBeInstanceOf(Uint8Array);

    const game = { version: 2, entry: 's', scenes: { s: { name: 's', scene, ui: {} } }, textureBytes: [] };
    const pack = unpackGameBin(packGameBin(game).buffer);

    const outScene = pack.manifest.scenes.s.scene;
    const outChunk = outScene.children[0].tilemap.layers[0].chunks[0];
    // Packed: the bytes left the manifest for the blob.
    expect(outChunk.dataBytes).toBeUndefined();
    expect(outChunk.dataChunk).toBeTruthy();

    await inflateTilemapData(outScene, pack);
    expect(outChunk.cellsU32).toBeInstanceOf(Uint32Array);
    expect(outChunk.dataChunk).toBeUndefined();

    const back = Tilemap.deserialize(outScene.children[0].tilemap);
    expect(back.getTile(0, 0, 0)?.tileIndex).toBe(3);
    expect(back.getTile(0, 2, 2)).toEqual({ tileIndex: 7, flipX: true, flipY: false, rot90: true });
    expect(back.getTile(0, CHUNK_SIZE - 1, CHUNK_SIZE - 1)?.tileIndex).toBe(3);
  });

  it('leaves a tilemap with only base64 payloads untouched, so an older game.bin still loads', async () => {
    const json = JSON.parse(JSON.stringify(mapWithTiles().serialize()));
    const scene = sceneWith(json);
    const game = { version: 2, entry: 's', scenes: { s: { name: 's', scene, ui: {} } }, textureBytes: [] };
    const pack = unpackGameBin(packGameBin(game).buffer);
    const outScene = pack.manifest.scenes.s.scene;

    await inflateTilemapData(outScene, pack);
    const outChunk = outScene.children[0].tilemap.layers[0].chunks[0];
    expect(typeof outChunk.data).toBe('string');

    const back = Tilemap.deserialize(outScene.children[0].tilemap);
    expect(back.getTile(0, 5, 5)?.tileIndex).toBe(3);
  });

  it('carries the embedded tilesets through, so the map needs no asset library to rebuild', async () => {
    const json = JSON.parse(JSON.stringify(mapWithTiles().serialize()));
    const scene = sceneWith(json);
    await compressTilemapData(scene);
    const pack = unpackGameBin(packGameBin(
      { version: 2, entry: 's', scenes: { s: { name: 's', scene, ui: {} } }, textureBytes: [] },
    ).buffer);
    const outScene = pack.manifest.scenes.s.scene;
    await inflateTilemapData(outScene, pack);
    const back = Tilemap.deserialize(outScene.children[0].tilemap);
    expect(back.tilesetById('ts')?.textureId).toBe('atlas.png');
  });

  it('an empty tilemap round-trips without allocating chunks', async () => {
    const tm = new Tilemap({ kind: 'hexagonal', cellWidth: 1, cellHeight: 1.15 });
    tm.addLayer({ name: 'Ground' });
    const scene = sceneWith(JSON.parse(JSON.stringify(tm.serialize())));
    await compressTilemapData(scene);
    const pack = unpackGameBin(packGameBin(
      { version: 2, entry: 's', scenes: { s: { name: 's', scene, ui: {} } }, textureBytes: [] },
    ).buffer);
    const outScene = pack.manifest.scenes.s.scene;
    await inflateTilemapData(outScene, pack);
    const back = Tilemap.deserialize(outScene.children[0].tilemap);
    expect(back.layers[0].chunks.size).toBe(0);
    expect(back.grid.kind).toBe('hexagonal');
  });
});

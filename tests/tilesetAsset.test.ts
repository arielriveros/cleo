import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TILE_SIZE, buildTilesetAsset, gridOf, guessTileSize, resliceTileset, toRuntimeTileset,
} from '../editor/src/utils/tilesets';

// The pure half of the tileset asset: how an atlas is cut into a grid, and what happens to per-tile
// metadata when that grid changes underneath it.

describe('gridOf', () => {
  it('divides a plain atlas', () => {
    expect(gridOf(64, 64, 16, 16)).toEqual({ columns: 4, rows: 4 });
    expect(gridOf(256, 128, 32, 32)).toEqual({ columns: 8, rows: 4 });
  });

  it('accounts for margin and spacing', () => {
    // 5px border each side, 2px between tiles: (100 - 10 + 2) / (10 + 2) = 7.66 -> 7
    expect(gridOf(100, 100, 10, 10, 5, 2)).toEqual({ columns: 7, rows: 7 });
    // Spacing only: (66 + 2) / (16 + 2) = 3.77 -> 3
    expect(gridOf(66, 66, 16, 16, 0, 2)).toEqual({ columns: 3, rows: 3 });
  });

  it('non-square tiles slice independently per axis', () => {
    expect(gridOf(64, 96, 16, 32)).toEqual({ columns: 4, rows: 3 });
  });

  it('never returns less than one tile, whatever the inputs', () => {
    expect(gridOf(8, 8, 64, 64)).toEqual({ columns: 1, rows: 1 });
    expect(gridOf(0, 0, 16, 16)).toEqual({ columns: 1, rows: 1 });
    expect(gridOf(64, 64, 0, 0)).toEqual({ columns: 1, rows: 1 });
    expect(gridOf(64, 64, -8, -8)).toEqual({ columns: 1, rows: 1 });
  });
});

describe('guessTileSize', () => {
  it('picks the largest candidate that still leaves at least a 4x4 grid', () => {
    expect(guessTileSize(256, 256)).toBe(64);   // 64 -> 4x4
    expect(guessTileSize(512, 512)).toBe(64);   // 64 -> 8x8
    expect(guessTileSize(128, 128)).toBe(32);   // 64 would be 2x2
    expect(guessTileSize(64, 64)).toBe(16);     // 32 would be 2x2
  });

  it('respects both axes, not just one', () => {
    // 64 divides 256 but not 96; 32 divides both and leaves 8x3 — too few rows; 16 leaves 16x6.
    expect(guessTileSize(256, 96)).toBe(16);
  });

  it('falls back to the default when nothing divides cleanly', () => {
    expect(guessTileSize(100, 100)).toBe(DEFAULT_TILE_SIZE);
    expect(guessTileSize(37, 91)).toBe(DEFAULT_TILE_SIZE);
  });

  it('falls back on degenerate sizes rather than dividing by zero', () => {
    expect(guessTileSize(0, 0)).toBe(DEFAULT_TILE_SIZE);
    expect(guessTileSize(-64, 64)).toBe(DEFAULT_TILE_SIZE);
  });

  it('a tiny atlas never guesses a size larger than itself', () => {
    expect(guessTileSize(16, 16)).toBe(DEFAULT_TILE_SIZE);
    expect(guessTileSize(32, 32)).toBe(8); // 8 -> 4x4, the only candidate that fits
  });
});

describe('buildTilesetAsset', () => {
  it('derives and stores the grid, and mirrors the texture id for the asset-pack walker', () => {
    const asset = buildTilesetAsset('Sheet', 'sheet.png', 128, 64, { tileWidth: 16, tileHeight: 16 });
    expect(asset.columns).toBe(8);
    expect(asset.rows).toBe(4);
    // referencedTextureIds (textureStore) scans `textureIds`, which is why it is duplicated.
    expect(asset.textureIds).toEqual(['sheet.png']);
  });

  it('an atlas-less tileset is still well-formed', () => {
    const asset = buildTilesetAsset('Empty', '', 0, 0);
    expect(asset.columns).toBe(1);
    expect(asset.rows).toBe(1);
    expect(asset.tiles).toEqual({});
    expect(asset.textureIds).toEqual(['']);
  });
});

describe('resliceTileset', () => {
  const sheet = () => {
    const asset = buildTilesetAsset('Sheet', 'a.png', 64, 64, { tileWidth: 16, tileHeight: 16 }); // 4x4
    asset.tiles[0] = { solid: true };
    asset.tiles[5] = { anchorRow: 1 };
    asset.tiles[15] = { zBias: 0.5 };
    return asset;
  };

  it('recomputes the grid', () => {
    const next = resliceTileset(sheet(), { tileWidth: 32, tileHeight: 32 });
    expect(next.columns).toBe(2);
    expect(next.rows).toBe(2);
  });

  it('drops metadata for tiles the new grid no longer has, and keeps the rest', () => {
    // 4x4 (16 tiles) -> 2x2 (4 tiles): indices 5 and 15 fall off the end.
    const next = resliceTileset(sheet(), { tileWidth: 32, tileHeight: 32 });
    expect(next.tiles[0]).toEqual({ solid: true });
    expect(next.tiles[5]).toBeUndefined();
    expect(next.tiles[15]).toBeUndefined();
  });

  it('keeps everything when the grid grows', () => {
    const next = resliceTileset(sheet(), { tileWidth: 8, tileHeight: 8 }); // 8x8 = 64 tiles
    expect(next.tiles[0]).toEqual({ solid: true });
    expect(next.tiles[5]).toEqual({ anchorRow: 1 });
    expect(next.tiles[15]).toEqual({ zBias: 0.5 });
  });

  it('swapping the atlas re-mirrors textureIds', () => {
    const next = resliceTileset(sheet(), { textureId: 'b.png', imageWidth: 32, imageHeight: 32 });
    expect(next.textureId).toBe('b.png');
    expect(next.textureIds).toEqual(['b.png']);
    expect(next.columns).toBe(2);
  });

  it('does not mutate the original', () => {
    const original = sheet();
    resliceTileset(original, { tileWidth: 32, tileHeight: 32 });
    expect(original.columns).toBe(4);
    expect(original.tiles[15]).toEqual({ zBias: 0.5 });
  });
});

describe('toRuntimeTileset', () => {
  it('carries the slicing and the surviving metadata into the engine model', () => {
    const asset = buildTilesetAsset('Sheet', 'a.png', 64, 64, { tileWidth: 16, tileHeight: 16 });
    asset.tiles[2] = { solid: true, animation: { frames: [2, 3], fps: 4 } };
    asset.terrains.push({ id: 1, name: 'grass', kind: 'blob', tiles: { 0: [4] } });

    const ts = toRuntimeTileset(asset);
    expect(ts.columns).toBe(4);
    expect(ts.tileCount).toBe(16);
    expect(ts.isSolid(2)).toBe(true);
    expect(ts.frameOf(2, 0.3)).toBe(3);
    expect(ts.terrainSet(1)?.tiles[0]).toEqual([4]);
  });
});

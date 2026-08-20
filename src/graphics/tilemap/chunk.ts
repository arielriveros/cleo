// Storage for a tilemap's cells.
//
// The map is unbounded, so cells live in fixed-size chunks allocated on first paint and freed when
// their last tile is erased. A chunk is also the unit of everything expensive downstream: one mesh, one
// batch of colliders, one frustum test, one entry in the serialized blob.

import type { TileMesh } from "./tileMesh";

/**
 * Cells per chunk side. A module constant rather than per-tilemap configuration: the mesh builder's
 * row index, the serializer and the collider merger all bake it in, and making it variable would mean
 * threading it through every one of them for no authoring benefit.
 *
 * 32x32 = 1024 cells -> 4096 vertices per chunk mesh, which keeps the index buffer inside Uint16.
 */
export const CHUNK_SIZE = 32;
export const CHUNK_CELLS = CHUNK_SIZE * CHUNK_SIZE;

/** A cell with no tile in it. Zero on purpose, so a fresh Uint32Array is already an empty chunk. */
export const CELL_EMPTY = 0;

// Packed cell layout (Uint32):
//   bits  0..23  tile index + 1  (0 => empty, so index 0 is a real tile)
//   bit   24     flip X
//   bit   25     flip Y
//   bit   26     rotate 90 (the diagonal flip; combined with the two mirrors this spans all 8 orientations)
// The H/V/D triple is Tiled's encoding, which means an imported .tmx maps across without a conversion table.
const TILE_MASK = 0x00ffffff;
export const FLAG_FLIP_X = 1 << 24;
export const FLAG_FLIP_Y = 1 << 25;
export const FLAG_ROT90 = 1 << 26;
const FLAG_MASK = FLAG_FLIP_X | FLAG_FLIP_Y | FLAG_ROT90;

/** Largest tile index a cell can reference. */
export const MAX_TILE_INDEX = TILE_MASK - 2;

export function packCell(tileIndex: number, flipX = false, flipY = false, rot90 = false): number {
    if (tileIndex < 0) return CELL_EMPTY;
    let v = (Math.min(tileIndex, MAX_TILE_INDEX) + 1) & TILE_MASK;
    if (flipX) v |= FLAG_FLIP_X;
    if (flipY) v |= FLAG_FLIP_Y;
    if (rot90) v |= FLAG_ROT90;
    return v >>> 0;
}

/** Tile index stored in a packed cell, or -1 when the cell is empty. */
export function cellTile(packed: number): number {
    const t = packed & TILE_MASK;
    return t === 0 ? -1 : t - 1;
}

export function cellFlags(packed: number): number { return packed & FLAG_MASK; }
export function cellFlipX(packed: number): boolean { return (packed & FLAG_FLIP_X) !== 0; }
export function cellFlipY(packed: number): boolean { return (packed & FLAG_FLIP_Y) !== 0; }
export function cellRot90(packed: number): boolean { return (packed & FLAG_ROT90) !== 0; }

/** Replace a cell's tile while keeping its orientation bits. */
export function withTile(packed: number, tileIndex: number): number {
    if (tileIndex < 0) return CELL_EMPTY;
    return (((Math.min(tileIndex, MAX_TILE_INDEX) + 1) & TILE_MASK) | (packed & FLAG_MASK)) >>> 0;
}

/**
 * One chunk of cells plus the derived state the renderer hangs off it.
 *
 * `mesh` and `rowIndex` are built lazily by the renderer; the data layer only ever flags them stale.
 * That split is what lets the tilemap be serialized, diffed and unit-tested with no GL in scope.
 *
 * Colliders deliberately do NOT live here: they are the union of every layer at this chunk coordinate,
 * so the Tilemap owns them keyed by chunk position rather than any one layer's chunk.
 */
export interface TileChunk {
    /** Chunk coordinates (cell coordinates divided by CHUNK_SIZE, floored). */
    cx: number;
    cy: number;
    /** Packed cells, row-major within the chunk. */
    cells: Uint32Array;
    /**
     * Per-cell tint/opacity override as packed RGBA8, 0 meaning "no override, use the tileset's". Left
     * null until something actually tints a cell, so the common map pays nothing for the feature.
     */
    tint: Uint32Array | null;
    /** Non-empty cells. The chunk is dropped from its layer when this reaches zero. */
    count: number;
    meshDirty: boolean;
    /** True when any cell in here references an animated tile; gates the per-frame UV patch. */
    animated: boolean;
    mesh: TileMesh | null;
}

export function createChunk(cx: number, cy: number): TileChunk {
    return {
        cx, cy,
        cells: new Uint32Array(CHUNK_CELLS),
        tint: null,
        count: 0,
        meshDirty: true,
        animated: false,
        mesh: null,
    };
}

/**
 * Key for a chunk's position in its layer's Map.
 *
 * Numeric rather than `${cx},${cy}`: a bucket fill writes a cell at a time and would otherwise build and
 * hash a string per write. The cost is a bound of +/-32768 chunks per axis, i.e. +/-1,048,576 cells —
 * far past any hand-authored map, but it is a real ceiling and painting past it would alias onto an
 * existing chunk, so `chunkAt` refuses coordinates outside it.
 */
export const MAX_CHUNK_COORD = 0x7fff;
export function chunkKey(cx: number, cy: number): number {
    return (cx + 0x8000) * 0x10000 + (cy + 0x8000);
}

/** Floor division that stays correct for negative cell coordinates. */
export function chunkCoord(cell: number): number {
    return Math.floor(cell / CHUNK_SIZE);
}

/**
 * Key for a single CELL, for visited-sets during a flood fill.
 *
 * Separate from `chunkKey` because cells span 32768x more ground than chunks do; reusing the chunk key
 * here would alias distant cells onto each other and silently truncate a large fill. The product stays
 * inside Number.MAX_SAFE_INTEGER across the whole addressable range.
 */
export function cellKey(col: number, row: number): number {
    return (col + 0x100000) * 0x200000 + (row + 0x100000);
}

/** Index of a cell within its chunk. */
export function localIndex(col: number, row: number): number {
    const lc = col - chunkCoord(col) * CHUNK_SIZE;
    const lr = row - chunkCoord(row) * CHUNK_SIZE;
    return lr * CHUNK_SIZE + lc;
}

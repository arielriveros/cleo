// Storage for a tilemap's cells: fixed-size chunks allocated on first paint and freed when their last
// tile is erased. A chunk is also the unit of one mesh, one collider batch and one frustum test.

import type { TileMesh } from "./tileMesh";

/**
 * Cells per chunk side. A constant, not configuration — the mesh builder, serializer and collider
 * merger all bake it in. 32x32 gives 4096 vertices, which keeps the index buffer inside Uint16.
 */
export const CHUNK_SIZE = 32;
export const CHUNK_CELLS = CHUNK_SIZE * CHUNK_SIZE;

/** A cell with no tile in it. Zero on purpose, so a fresh Uint32Array is already an empty chunk. */
export const CELL_EMPTY = 0;

// Packed cell layout (Uint32): bits 0..23 tile index + 1 (0 means empty), bit 24 flip X, bit 25 flip Y,
// bit 26 rotate 90. Tiled's H/V/D encoding, so an imported .tmx maps across with no conversion.
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
 * One chunk of cells plus the derived state the renderer hangs off it. `mesh` and `rowIndex` are built
 * lazily by the renderer. Colliders live on the Tilemap — they are the union of every layer here.
 */
export interface TileChunk {
    /** Chunk coordinates (cell coordinates divided by CHUNK_SIZE, floored). */
    cx: number;
    cy: number;
    /** Packed cells, row-major within the chunk. */
    cells: Uint32Array;
    /** Per-cell tint override as packed RGBA8; 0 means none. Null until something tints a cell. */
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
 * Bound on a chunk coordinate. The key is NUMERIC to keep a per-cell bucket fill off string hashing,
 * which costs this ceiling; painting past it would alias onto an existing chunk, so `chunkAt` refuses.
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
 * Key for a single CELL, for flood-fill visited sets. Separate from `chunkKey`, whose range would
 * alias distant cells together and silently truncate a large fill.
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

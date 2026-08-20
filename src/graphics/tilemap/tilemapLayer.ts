// One layer of a tilemap: a sparse grid of chunks plus the draw/collision settings that apply to all
// of them. A tilemap is an ordered stack of these.

import { bytesToBase64, base64ToBytes } from "../../core/base64";
import {
    CELL_EMPTY, CHUNK_SIZE, TileChunk, chunkCoord, chunkKey, createChunk, localIndex, MAX_CHUNK_COORD,
} from "./chunk";

export interface TilemapLayerConfig {
    name: string;
    visible: boolean;
    /** Multiplied into every tile's alpha. */
    opacity: number;
    /**
     * Draw band. Layers sort by this first, and it is also the band SpriteNodes join when the tilemap
     * names this layer as its entity layer — so it is what interleaves characters with scenery.
     */
    order: number;
    /** World-Z nudge, so two layers at the same band don't z-fight. */
    zOffset: number;
    /** Camera-relative scroll factor. [1,1] moves with the world; [0,0] is pinned to the camera. */
    parallax: [number, number];
    /** Asset id of the tileset this layer paints from. */
    tilesetId: string | null;
    /**
     * When true the layer's tiles are depth-sorted by row against sprites instead of drawn as one flat
     * batch. Costs a draw call per populated row, so it is off by default and turned on for the one or
     * two layers that actually hold props characters walk behind.
     */
    ySorted: boolean;
    /**
     * Marks this as a collision layer: every tile on it contributes a collider regardless of whether
     * its tileset marks it solid. The escape hatch for collision that doesn't line up with the art.
     */
    collision: boolean;
}

export function defaultLayerConfig(patch?: Partial<TilemapLayerConfig>): TilemapLayerConfig {
    const cfg: TilemapLayerConfig = {
        name: 'Layer',
        visible: true,
        opacity: 1,
        order: 0,
        zOffset: 0,
        parallax: [1, 1],
        tilesetId: null,
        ySorted: false,
        collision: false,
        ...patch,
    };
    // Re-clone after the spread: a caller's array must not end up shared with the layer, or editing one
    // layer's parallax in the inspector would silently move another's.
    cfg.parallax = patch?.parallax ? [patch.parallax[0], patch.parallax[1]] : [1, 1];
    return cfg;
}

export interface LayerBounds {
    minCol: number; minRow: number; maxCol: number; maxRow: number;
}

export class TilemapLayer {
    public cfg: TilemapLayerConfig;
    public readonly chunks: Map<number, TileChunk> = new Map();

    constructor(cfg?: Partial<TilemapLayerConfig>) {
        this.cfg = defaultLayerConfig(cfg);
    }

    /** Packed cell at (col, row); 0 when empty or outside any allocated chunk. */
    public get(col: number, row: number): number {
        const chunk = this.chunks.get(chunkKey(chunkCoord(col), chunkCoord(row)));
        return chunk ? chunk.cells[localIndex(col, row)] : CELL_EMPTY;
    }

    /**
     * Write a packed cell and return what was there before, which is what the undo diff records.
     * Allocates a chunk on demand and frees it again once its last tile is erased, so an unbounded map
     * only ever costs memory where it was actually painted.
     */
    public set(col: number, row: number, packed: number): number {
        const cx = chunkCoord(col), cy = chunkCoord(row);
        const create = packed !== CELL_EMPTY;
        const chunk = this.chunkAt(cx, cy, create);
        if (!chunk) return CELL_EMPTY;

        const i = localIndex(col, row);
        const prev = chunk.cells[i];
        if (prev === packed) return prev;

        chunk.cells[i] = packed;
        if (prev === CELL_EMPTY) chunk.count++;
        else if (packed === CELL_EMPTY) chunk.count--;
        chunk.meshDirty = true;
        if (packed === CELL_EMPTY && chunk.tint) chunk.tint[i] = 0;
        if (chunk.count === 0) this._freeChunk(chunk);
        return prev;
    }

    /** Per-cell tint override as packed RGBA8, or 0 when the cell defers to its tile's own tint. */
    public getTint(col: number, row: number): number {
        const chunk = this.chunks.get(chunkKey(chunkCoord(col), chunkCoord(row)));
        return chunk?.tint ? chunk.tint[localIndex(col, row)] : 0;
    }

    /** Returns the previous override. Allocates the chunk's tint array on first non-zero write. */
    public setTint(col: number, row: number, rgba: number): number {
        const chunk = this.chunkAt(chunkCoord(col), chunkCoord(row), rgba !== 0);
        if (!chunk) return 0;
        if (!chunk.tint) {
            if (rgba === 0) return 0;
            chunk.tint = new Uint32Array(chunk.cells.length);
        }
        const i = localIndex(col, row);
        const prev = chunk.tint[i];
        if (prev === rgba) return prev;
        chunk.tint[i] = rgba;
        chunk.meshDirty = true;
        return prev;
    }

    public chunkAt(cx: number, cy: number, create: boolean): TileChunk | null {
        if (Math.abs(cx) > MAX_CHUNK_COORD || Math.abs(cy) > MAX_CHUNK_COORD) return null;
        const key = chunkKey(cx, cy);
        let chunk = this.chunks.get(key);
        if (!chunk && create) {
            chunk = createChunk(cx, cy);
            this.chunks.set(key, chunk);
        }
        return chunk ?? null;
    }

    private _freeChunk(chunk: TileChunk): void {
        chunk.mesh?.dispose();
        chunk.mesh = null;
        // Colliders are not freed here: they belong to the Tilemap, keyed by chunk position across every
        // layer, and the write that emptied this chunk has already flagged that key for a rebuild.
        this.chunks.delete(chunkKey(chunk.cx, chunk.cy));
    }

    /** Cell-space extent of everything painted on this layer, or null when it is empty. */
    public bounds(): LayerBounds | null {
        let minCol = Infinity, minRow = Infinity, maxCol = -Infinity, maxRow = -Infinity;
        for (const chunk of this.chunks.values()) {
            if (chunk.count === 0) continue;
            for (let lr = 0; lr < CHUNK_SIZE; lr++) {
                for (let lc = 0; lc < CHUNK_SIZE; lc++) {
                    if (chunk.cells[lr * CHUNK_SIZE + lc] === CELL_EMPTY) continue;
                    const col = chunk.cx * CHUNK_SIZE + lc;
                    const row = chunk.cy * CHUNK_SIZE + lr;
                    if (col < minCol) minCol = col;
                    if (col > maxCol) maxCol = col;
                    if (row < minRow) minRow = row;
                    if (row > maxRow) maxRow = row;
                }
            }
        }
        return isFinite(minCol) ? { minCol, minRow, maxCol, maxRow } : null;
    }

    /** Non-empty cells across the whole layer. */
    public get tileCount(): number {
        let n = 0;
        for (const chunk of this.chunks.values()) n += chunk.count;
        return n;
    }

    public markAllMeshesDirty(): void {
        for (const chunk of this.chunks.values()) chunk.meshDirty = true;
    }

    public serialize(): any {
        const chunks: any[] = [];
        for (const chunk of this.chunks.values()) {
            if (chunk.count === 0) continue;
            const entry: any = {
                cx: chunk.cx,
                cy: chunk.cy,
                count: chunk.count,
                data: bytesToBase64(new Uint8Array(chunk.cells.buffer, chunk.cells.byteOffset, chunk.cells.byteLength)),
            };
            if (chunk.tint && chunk.tint.some(v => v !== 0))
                entry.tint = bytesToBase64(new Uint8Array(chunk.tint.buffer, chunk.tint.byteOffset, chunk.tint.byteLength));
            chunks.push(entry);
        }
        return { ...this.cfg, parallax: [this.cfg.parallax[0], this.cfg.parallax[1]], chunks };
    }

    /**
     * Rebuild a layer from any of the shapes a chunk's cells can arrive in:
     *   `cellsU32`  — a pre-decoded typed array, which is what the published player hands over after
     *                 inflating the blob out of game.bin
     *   `data`      — base64 of the Uint32 buffer, which is what the editor saves
     *   `cells`     — a plain number array, for hand-authored or legacy content
     *   none        — an empty chunk
     * Mirrors Terrain.deserialize's contract deliberately: the publish pipeline swaps the base64 form
     * for the typed-array form and nothing else in the load path needs to know.
     */
    public static parse(json: any): TilemapLayer {
        const layer = new TilemapLayer(json ?? {});
        for (const cj of json?.chunks ?? []) {
            if (!cj) continue;
            const chunk = layer.chunkAt(cj.cx | 0, cj.cy | 0, true);
            if (!chunk) continue;
            const cells = decodeU32(cj.cellsU32 ?? cj.data ?? cj.cells, chunk.cells.length);
            if (cells) chunk.cells.set(cells.subarray(0, chunk.cells.length));
            const tint = decodeU32(cj.tintU32 ?? cj.tint, chunk.cells.length);
            if (tint) {
                chunk.tint = new Uint32Array(chunk.cells.length);
                chunk.tint.set(tint.subarray(0, chunk.cells.length));
            }
            let count = 0;
            for (let i = 0; i < chunk.cells.length; i++) if (chunk.cells[i] !== CELL_EMPTY) count++;
            chunk.count = count;
            if (count === 0) layer.chunks.delete(chunkKey(chunk.cx, chunk.cy));
        }
        return layer;
    }
}

/** Coerce one of the accepted cell encodings into a Uint32Array, or null when there is nothing to read. */
function decodeU32(src: any, expected: number): Uint32Array | null {
    if (!src) return null;
    if (src instanceof Uint32Array) return src;
    if (typeof src === 'string') {
        // base64ToBytes always allocates a fresh buffer at byteOffset 0, so this view is guaranteed to
        // be 4-byte aligned. Floor the element count anyway — a truncated payload must not throw.
        const bytes = base64ToBytes(src);
        return new Uint32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
    }
    if (Array.isArray(src)) {
        const out = new Uint32Array(Math.max(expected, src.length));
        for (let i = 0; i < src.length; i++) out[i] = src[i] >>> 0;
        return out;
    }
    if (ArrayBuffer.isView(src)) {
        const view = src as ArrayBufferView;
        return new Uint32Array(view.buffer, view.byteOffset, Math.floor(view.byteLength / 4));
    }
    if (src instanceof ArrayBuffer) return new Uint32Array(src, 0, Math.floor(src.byteLength / 4));
    return null;
}

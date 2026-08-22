// GPU geometry for one tilemap chunk.
//
// Deliberately NOT built on Geometry/Mesh/Model: per-cell tint and opacity need a colour attribute, and
// Geometry's vertex layout is a fixed position/normal/uv/tangent/bitangent set that Mesh's canonical
// attribute table bakes in. Smuggling colour through the normal slot would work today and be a trap
// forever, so a tilemap chunk owns a small interleaved buffer of its own instead.
//
// Layout, 8 floats per vertex:  position.xy | uv.xy | colour.rgba
//
// On a Y-sorted layer the cells are emitted in depth order and the index buffer is split into BANDS —
// contiguous ranges sharing one sort depth. The renderer then interleaves those bands with sprites
// using one drawElements per band at a byte offset, rather than a draw call per cell. Banding by the
// tile's resolved sort depth (row + anchorRow, plus zBias) rather than by its grid row is what makes a
// two-cell-tall tree sort as one object at its trunk.

import { gl } from '../../graphics/renderer';
import { GLState } from '../../graphics/systems/glState';
import { frameStats } from '../../graphics/renderStats';
import { TILE_VERTEX_LAYOUT } from '../rhi/vertexLayouts';
import { applyVertexLayout } from '../rhi/webgl2/vertexArray';
import { device } from '../rhi/webgl2/webgl2Device';
import type { WebGL2Buffer } from '../rhi/webgl2/webgl2Device';
import { BufferUsage } from '../rhi/types';
import { GridSpec, cellSortY, cellToWorld } from './cellMath';
import { CELL_EMPTY, CHUNK_SIZE, TileChunk, cellFlipX, cellFlipY, cellRot90, cellTile } from './chunk';
import type { TilemapLayer } from './tilemapLayer';
import type { Tileset } from './tileset';

// Derived from the layout rather than restated, so the scratch-buffer arithmetic below cannot drift
// from the attribute offsets the VAO is actually built with. Attribute locations and the stride now
// live in one place: TILE_VERTEX_LAYOUT in rhi/vertexLayouts.ts.
const FLOATS_PER_VERTEX = TILE_VERTEX_LAYOUT.arrayStride / 4;
const MAX_CELLS = CHUNK_SIZE * CHUNK_SIZE;

// Unit-square corners in draw order: bottom-left, bottom-right, top-right, top-left.
const CORNERS: readonly [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];

// Scratch reused across every build; a chunk only keeps its own copy of the vertices when it animates.
const scratchVerts = new Float32Array(MAX_CELLS * 4 * FLOATS_PER_VERTEX);
const scratchIndices = new Uint16Array(MAX_CELLS * 6);
const uvScratch = new Float32Array(4);

/** A contiguous slice of the index buffer that shares one sort depth. */
export interface DepthBand {
    /** World Y this slice sorts at. Always 0 on a layer that is not Y-sorted. */
    sortY: number;
    indexOffset: number;
    indexCount: number;
}

/** One animated cell's place in the vertex buffer, so its UVs can be rewritten without a full rebuild. */
interface AnimatedRef {
    /** Index of this cell's first vertex. */
    vertex: number;
    tileIndex: number;
    flipX: boolean;
    flipY: boolean;
    rot90: boolean;
}

export class TileMesh {
    private _vao: WebGLVertexArrayObject | null = null;
    private _vbo: WebGL2Buffer | null = null;
    private _ibo: WebGL2Buffer | null = null;
    private _indexCount = 0;
    private _vertexCount = 0;
    private _bands: DepthBand[] = [];
    /** Retained only for animated chunks, so `patchAnimatedUVs` has something to rewrite. */
    private _verts: Float32Array | null = null;
    private _animated: AnimatedRef[] = [];
    private _frameKey = -1;

    public get indexCount(): number { return this._indexCount; }
    public get bands(): readonly DepthBand[] { return this._bands; }

    /**
     * Rebuild from the chunk's current cells. Also recomputes `chunk.animated`, which is why the data
     * layer never has to know which tiles animate — it only ever flags `meshDirty`.
     */
    public build(chunk: TileChunk, layer: TilemapLayer, tileset: Tileset, grid: GridSpec, time: number): void {
        this._animated = [];
        this._bands = [];

        // Pass 1: which cells are populated, and (for a Y-sorted layer) what depth each one sorts at.
        const cells: number[] = [];
        const depths: number[] = [];
        const ySorted = layer.cfg.ySorted;
        for (let lr = 0; lr < CHUNK_SIZE; lr++) {
            for (let lc = 0; lc < CHUNK_SIZE; lc++) {
                const li = lr * CHUNK_SIZE + lc;
                const packed = chunk.cells[li];
                if (packed === CELL_EMPTY) continue;
                cells.push(li);
                if (!ySorted) { depths.push(0); continue; }
                const meta = tileset.metaOf(cellTile(packed));
                const col = chunk.cx * CHUNK_SIZE + lc;
                const row = chunk.cy * CHUNK_SIZE + lr;
                depths.push(cellSortY(grid, col, row, meta?.anchorRow ?? 0) + (meta?.zBias ?? 0));
            }
        }

        // Pass 2: emit far-to-near so each band is one contiguous index range. Ties keep their
        // row-major order, which is what makes a rebuild of unchanged cells produce the same buffer.
        const order = cells.map((_, i) => i);
        if (ySorted) order.sort((a, b) => (depths[b] - depths[a]) || (a - b));

        let v = 0, vert = 0, idx = 0;
        let band: DepthBand | null = null;
        const layerAlpha = layer.cfg.opacity;

        for (const oi of order) {
            const li = cells[oi];
            const packed = chunk.cells[li];
            const tile = cellTile(packed);
            if (tile < 0) continue;
            const lc = li % CHUNK_SIZE, lr = (li - lc) / CHUNK_SIZE;
            const col = chunk.cx * CHUNK_SIZE + lc;
            const row = chunk.cy * CHUNK_SIZE + lr;

            if (!band || (ySorted && depths[oi] !== band.sortY)) {
                band = { sortY: depths[oi], indexOffset: idx, indexCount: 0 };
                this._bands.push(band);
            }

            const meta = tileset.metaOf(tile);
            const spanX = Math.max(1, meta?.spanX ?? 1);
            const spanY = Math.max(1, meta?.spanY ?? 1);

            // A multi-cell tile hangs off its placed cell's top-left corner, so the placed cell is always
            // the tile's own top-left — the same frame anchorRow is measured in.
            const centre = cellToWorld(grid, col, row);
            const left = centre[0] - grid.cellWidth * 0.5;
            const top = centre[1] + grid.cellHeight * 0.5;
            const right = left + spanX * grid.cellWidth;
            const bottom = top - spanY * grid.cellHeight;

            if (tileset.isAnimated(tile)) {
                this._animated.push({
                    vertex: vert, tileIndex: tile,
                    flipX: cellFlipX(packed), flipY: cellFlipY(packed), rot90: cellRot90(packed),
                });
            }
            tileset.uvOf(tileset.frameOf(tile, time), uvScratch);

            const override = chunk.tint ? chunk.tint[li] : 0;
            let r = 1, g = 1, b = 1, a = layerAlpha;
            if (override !== 0) {
                r = ((override >>> 24) & 0xff) / 255;
                g = ((override >>> 16) & 0xff) / 255;
                b = ((override >>> 8) & 0xff) / 255;
                a *= (override & 0xff) / 255;
            } else if (meta) {
                if (meta.tint) { r = meta.tint[0]; g = meta.tint[1]; b = meta.tint[2]; }
                if (meta.opacity !== undefined) a *= meta.opacity;
            }

            for (const [ux, uy] of CORNERS) {
                const [s, t] = orientUVFlags(ux, uy, cellRot90(packed), cellFlipX(packed), cellFlipY(packed));
                scratchVerts[v++] = left + ux * (right - left);
                scratchVerts[v++] = bottom + uy * (top - bottom);
                scratchVerts[v++] = uvScratch[0] + s * (uvScratch[2] - uvScratch[0]);
                scratchVerts[v++] = uvScratch[1] + t * (uvScratch[3] - uvScratch[1]);
                scratchVerts[v++] = r; scratchVerts[v++] = g; scratchVerts[v++] = b; scratchVerts[v++] = a;
            }
            scratchIndices[idx++] = vert; scratchIndices[idx++] = vert + 1; scratchIndices[idx++] = vert + 2;
            scratchIndices[idx++] = vert; scratchIndices[idx++] = vert + 2; scratchIndices[idx++] = vert + 3;
            band.indexCount += 6;
            vert += 4;
        }

        chunk.animated = this._animated.length > 0;
        this._vertexCount = vert;
        this._indexCount = idx;
        this._frameKey = -1;
        // Keep the CPU-side copy only where it earns its keep: an animated chunk rewrites UVs in place
        // every few frames, a static one never does and would just hold 128 KB per chunk hostage.
        this._verts = chunk.animated ? scratchVerts.slice(0, v) : null;

        this._upload(scratchVerts.subarray(0, v), scratchIndices.subarray(0, idx));
    }

    private _upload(verts: Float32Array, indices: Uint16Array): void {
        if (!this._vao) {
            this._vao = gl.createVertexArray();
            // COPY_DST on the vertex buffer: an animated chunk rewrites its UVs every frame through
            // `advanceAnimation`, which is what earns it a DYNAMIC_DRAW hint. Indices never change.
            this._vbo = device.createBuffer({ label: 'tileChunk.vertices', size: 0, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
            this._ibo = device.createBuffer({ label: 'tileChunk.indices', size: 0, usage: BufferUsage.INDEX });
        }
        GLState.bindVAO(this._vao);
        device.reallocateBuffer(this._vbo as WebGL2Buffer, verts);

        // The layout is still this chunk's own — a tilemap vertex really is position/uv/colour, not the
        // model vertex — but the attribute binding is no longer a private copy of the same six calls.
        applyVertexLayout(TILE_VERTEX_LAYOUT, (this._vbo as WebGL2Buffer).handle);

        device.reallocateBuffer(this._ibo as WebGL2Buffer, indices);
        GLState.bindVAO(null);
    }

    /**
     * Rewrite the UVs of this chunk's animated cells for `time`.
     *
     * Early-outs unless the resolved frame set actually changed. Without that guard every animated
     * tilemap would issue a bufferSubData per chunk per frame regardless of the animation's fps, which
     * is the difference between a few uploads a second and one per chunk at 60 Hz.
     */
    public patchAnimatedUVs(tileset: Tileset, time: number): void {
        if (!this._verts || this._animated.length === 0) return;

        let key = 17;
        for (const ref of this._animated) key = (Math.imul(key, 31) + tileset.frameOf(ref.tileIndex, time)) | 0;
        if (key === this._frameKey) return;
        this._frameKey = key;

        for (const ref of this._animated) {
            tileset.uvOf(tileset.frameOf(ref.tileIndex, time), uvScratch);
            for (let k = 0; k < 4; k++) {
                const [ux, uy] = CORNERS[k];
                const [s, t] = orientUVFlags(ux, uy, ref.rot90, ref.flipX, ref.flipY);
                const base = (ref.vertex + k) * FLOATS_PER_VERTEX;
                this._verts[base + 2] = uvScratch[0] + s * (uvScratch[2] - uvScratch[0]);
                this._verts[base + 3] = uvScratch[1] + t * (uvScratch[3] - uvScratch[1]);
            }
        }
        GLState.bindVAO(this._vao);
        device.writeBuffer(this._vbo as WebGL2Buffer, 0, this._verts);
        GLState.bindVAO(null);
    }

    public draw(): void {
        if (this._indexCount === 0 || !this._vao) return;
        GLState.bindVAO(this._vao);
        gl.drawElements(gl.TRIANGLES, this._indexCount, gl.UNSIGNED_SHORT, 0);
        frameStats.drawCalls++;
        frameStats.vertices += this._vertexCount;
        frameStats.triangles += this._indexCount / 3;
    }

    /** Draw one contiguous slice of the index buffer — a single depth band on a Y-sorted layer. */
    public drawRange(indexOffset: number, indexCount: number): void {
        if (indexCount <= 0 || !this._vao) return;
        GLState.bindVAO(this._vao);
        gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_SHORT, indexOffset * 2);
        frameStats.drawCalls++;
        frameStats.vertices += indexCount;
        frameStats.triangles += indexCount / 3;
    }

    public dispose(): void {
        if (this._ibo) { this._ibo.destroy(); this._ibo = null; }
        if (this._vbo) { this._vbo.destroy(); this._vbo = null; }
        if (this._vao) {
            // GLState dedupes bindVertexArray by identity, so a deleted VAO left in its cache would make
            // the next bind of that handle a silent no-op.
            if (GLState.currentVAO === this._vao) GLState.reset();
            gl.deleteVertexArray(this._vao);
            this._vao = null;
        }
        this._verts = null;
        this._animated = [];
        this._bands = [];
        this._indexCount = 0;
        this._vertexCount = 0;
    }
}

/**
 * Map a unit-square corner to the tile's texture space under the cell's orientation bits.
 *
 * Diagonal (transpose) first, then the two mirrors — Tiled's order, and the same one `orientShape` in
 * tilemap.ts applies to collider outlines, so art and collision stay in agreement.
 */
function orientUVFlags(ux: number, uy: number, rot90: boolean, flipX: boolean, flipY: boolean): [number, number] {
    let s = ux, t = uy;
    if (rot90) { const tmp = s; s = t; t = tmp; }
    if (flipX) s = 1 - s;
    if (flipY) t = 1 - t;
    return [s, t];
}

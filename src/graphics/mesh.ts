import type { IndexFormat } from './rhi/types';
import { device } from './rhi/deviceHandle';
import type { Buffer as GpuBuffer } from './rhi/resources';
import { BufferUsage } from './rhi/types';
import { createIndexArray, indexFormatFor } from './indexFormat';

/** Interleaved vertex data. `Float32Array` is the fast path — it is uploaded without a copy. */
export type VertexData = Float32Array | number[];
export type IndexData = Uint32Array | Uint16Array | number[];

/** Avoids re-allocating when the caller already produced a Float32Array (Geometry.getData does). */
function asF32(data: VertexData): Float32Array {
    return data instanceof Float32Array ? data : new Float32Array(data);
}

/**
 * A mesh's GPU buffers — interleaved vertices, indices (with optional coarser LOD index sets over the
 * same vertices) and, for a skinned mesh, the bone index/weight streams. Drawn only by recording it
 * through a render pass (`PassEncoder.recordDraw` / `recordInstancedDraw`): the pipeline carries the
 * vertex layout, so a mesh holds no backend state of its own.
 */
export class Mesh {
    private _vertexBuffer: GpuBuffer;
    private _indexBuffer: GpuBuffer | null;
    private _boneIndicesBuffer: GpuBuffer | null;
    private _boneWeightsBuffer: GpuBuffer | null;
    private _vertexCount: number;
    private _indexCount: number;
    // How to read _indexBuffer, chosen per upload by index range: over 65535 vertices needs uint32.
    private _indexFormat: IndexFormat;
    private _isAnimated: boolean;
    // Alternate index buffers over the SAME vertex buffer (level 0 = the base one). Terrain LOD only.
    private _lodBuffers: GpuBuffer[] = [];
    private _lodCounts: number[] = [];
    // Index format per LOD level, parallel to _lodCounts and aliasing level 0 like _lodBuffers does.
    private _lodFormats: IndexFormat[] = [];
    private _lod: number = 0;

    constructor() {
        // COPY_DST because terrain sculpting rewrites the geometry in place through updateVertexData.
        this._vertexBuffer = device.createBuffer({ label: 'mesh.vertices', size: 0, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
        this._indexBuffer = null;
        this._boneIndicesBuffer = null;
        this._boneWeightsBuffer = null;
        this._vertexCount = 0;
        this._indexCount = 0;
        this._indexFormat = 'uint16';
        this._isAnimated = false;
    }

    /**
     * A fresh index buffer for `data`, destroying the one it replaces. `create` can run twice on one Mesh
     * (a model re-uploaded in place), and the old index buffer used to be dropped without a destroy — the
     * device keeps it alive until then, so every respawned enemy leaked one for the rest of the session.
     * LOD index sets alias `_lodBuffers[0]` to the base buffer; they are rebuilt by setLodIndices.
     */
    private _replaceIndexBuffer(data: Uint16Array | Uint32Array): void {
        for (let i = 1; i < this._lodBuffers.length; i++) this._lodBuffers[i].destroy();
        this._lodBuffers = [];
        this._lodCounts = [];
        this._lodFormats = [];
        this._lod = 0;
        this._indexBuffer?.destroy();
        this._indexBuffer = device.createBuffer({ label: 'mesh.indices', size: 0, usage: BufferUsage.INDEX | BufferUsage.COPY_DST });
        this._indexBuffer = device.reallocateBuffer(this._indexBuffer, data);
    }

    public create(vertices: VertexData, vertex_count: number, indices: IndexData | null = null): Mesh {
        // No copy when the caller already has a Float32Array — which Geometry.getData now returns.
        this._vertexBuffer = device.reallocateBuffer(this._vertexBuffer, asF32(vertices));
        this._vertexCount = vertex_count;

        // `indices.length`, not just `indices`: an empty array is truthy and would allocate a
        // zero-length buffer no draw can use.
        if (indices && indices.length > 0) {
            const data = createIndexArray(indices);
            this._indexFormat = indexFormatFor(data);
            this._replaceIndexBuffer(data);
            this._indexCount = indices.length;
        }

        return this;
    }

    /**
     * Re-upload interleaved vertex data into the existing buffer. Expects the same layout and vertex
     * count `create()` used, so the size is unchanged. Used by terrain sculpting.
     */
    public updateVertexData(vertices: VertexData): void {
        device.writeBuffer(this._vertexBuffer, 0, asF32(vertices));
    }

    /**
     * Re-upload part of the interleaved vertex data: `data` (whole vertices, `strideFloats` each) lands
     * at vertex `firstVertex`. For a mesh that changes a few hundred vertices of thousands a frame —
     * skinned cloth — where rewriting the whole buffer would cost more than the simulation.
     */
    public updateVertexRange(firstVertex: number, strideFloats: number, data: Float32Array): void {
        device.writeBuffer(this._vertexBuffer, firstVertex * strideFloats * 4, data);
    }

    public createAnimated(
        vertices: VertexData,
        vertex_count: number,
        boneIndices: VertexData,
        boneWeights: VertexData,
        indices: IndexData | null = null
    ): Mesh {
        // Create and bind main vertex buffer (positions, normals, uvs, tangents, bitangents)
        this._vertexBuffer = device.reallocateBuffer(this._vertexBuffer, new Float32Array(vertices));
        this._vertexCount = vertex_count;

        // Create and bind bone indices buffer
        const boneIndexData = new Int32Array(boneIndices);
        // A re-upload into the same Mesh (a model rebuilt in place) must not orphan the previous buffers:
        // the device keeps every buffer alive until it is destroyed, so each one leaked for the session.
        this._boneIndicesBuffer?.destroy();
        this._boneIndicesBuffer = device.createBuffer({ label: 'mesh.boneIndices', size: 0, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
        this._boneIndicesBuffer = device.reallocateBuffer(this._boneIndicesBuffer, boneIndexData);

        // Create and bind bone weights buffer
        const boneWeightData = new Float32Array(boneWeights);
        this._boneWeightsBuffer?.destroy();
        this._boneWeightsBuffer = device.createBuffer({ label: 'mesh.boneWeights', size: 0, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
        this._boneWeightsBuffer = device.reallocateBuffer(this._boneWeightsBuffer, boneWeightData);

        // `indices.length`, not just `indices`: an empty array is truthy and would allocate a
        // zero-length buffer no draw can use.
        if (indices && indices.length > 0) {
            const data = createIndexArray(indices);
            this._indexFormat = indexFormatFor(data);
            this._replaceIndexBuffer(data);
            this._indexCount = indices.length;
        }

        this._isAnimated = true;

        return this;
    }

    /**
     * Upload coarser index sets over this mesh's existing vertex buffer, for terrain LOD. Level 0 stays
     * the base index buffer; `levels[i]` becomes level i+1, replacing any previous set.
     */
    public setLodIndices(levels: number[][]): void {
        if (!this._indexBuffer) return;

        for (let i = 1; i < this._lodBuffers.length; i++) this._lodBuffers[i].destroy();
        this._lodBuffers = [this._indexBuffer];
        this._lodCounts = [this._indexCount];
        this._lodFormats = [this._indexFormat];
        for (const indices of levels) {
            const data = createIndexArray(indices);
            let buffer = device.createBuffer({ label: 'mesh.lodIndices', size: 0, usage: BufferUsage.INDEX | BufferUsage.COPY_DST });
            buffer = device.reallocateBuffer(buffer, data) as typeof buffer;
            this._lodBuffers.push(buffer);
            this._lodCounts.push(indices.length);
            this._lodFormats.push(indexFormatFor(data));
        }
        this._lod = Math.min(this._lod, this._lodBuffers.length - 1);
    }

    /**
     * Release every GPU object this mesh owns — vertex, index, bone and LOD buffers. Idempotent, and
     * required: dropping the last JS reference frees nothing.
     */
    public dispose(): void {
        // Start at 1: `_lodBuffers[0] === _indexBuffer`, an aliasing other code relies on.
        for (let i = 1; i < this._lodBuffers.length; i++) this._lodBuffers[i].destroy();
        this._lodBuffers = [];
        this._lodCounts = [];
        this._lodFormats = [];
        this._lod = 0;

        if (this._indexBuffer) { this._indexBuffer.destroy(); this._indexBuffer = null; }
        if (this._boneIndicesBuffer) { this._boneIndicesBuffer.destroy(); this._boneIndicesBuffer = null; }
        if (this._boneWeightsBuffer) { this._boneWeightsBuffer.destroy(); this._boneWeightsBuffer = null; }
        if (this._vertexBuffer) { this._vertexBuffer.destroy(); this._vertexBuffer = null!; }

        this._vertexCount = 0;
        this._indexCount = 0;
    }

    public get hasLods(): boolean { return this._lodBuffers.length > 1; }
    public get activeLod(): number { return this._lod; }
    public set activeLod(level: number) {
        this._lod = Math.max(0, Math.min(Math.round(level), Math.max(0, this._lodBuffers.length - 1)));
    }

    /** The device-owned vertex buffer. */
    public get vertexBuffer(): GpuBuffer { return this._vertexBuffer; }
    /** The index buffer, for a draw recorded through the RHI. Read `indexFormat` alongside it. */
    public get indexBuffer(): GpuBuffer | null { return this._indexBuffer; }
    public get indexFormat(): IndexFormat { return this._indexFormat; }
    public get indexCount(): number { return this._indexCount; }

    /** The dedicated bone buffers, for a skinned draw recorded through the RHI. */
    public get boneIndicesBuffer(): GpuBuffer | null { return this._boneIndicesBuffer; }
    public get boneWeightsBuffer(): GpuBuffer | null { return this._boneWeightsBuffer; }
    /** The index buffer for the ACTIVE LOD level. Levels share vertices, so only this binding changes. */
    public get activeIndexBuffer(): GpuBuffer | null {
        return this.hasLods ? this._lodBuffers[this._lod] : this._indexBuffer;
    }
    public get activeIndexCount(): number {
        return this.hasLods ? this._lodCounts[this._lod] : this._indexCount;
    }
    public get activeIndexFormat(): IndexFormat {
        return this.hasLods ? this._lodFormats[this._lod] : this._indexFormat;
    }
    /** Index levels this mesh has: 1 without LODs. Level `lodLevels - 1` is the coarsest. */
    public get lodLevels(): number { return Math.max(1, this._lodBuffers.length); }
    /**
     * One level's index buffer, count and format, whatever `activeLod` says — for a pass that picks its
     * own level (a far shadow cascade drawing terrain coarser than the camera sees it). Clamped.
     */
    public lodIndexBuffer(level: number): GpuBuffer | null {
        return this.hasLods ? this._lodBuffers[this._clampLevel(level)] : this._indexBuffer;
    }
    public lodIndexCount(level: number): number {
        return this.hasLods ? this._lodCounts[this._clampLevel(level)] : this._indexCount;
    }
    public lodIndexFormat(level: number): IndexFormat {
        return this.hasLods ? this._lodFormats[this._clampLevel(level)] : this._indexFormat;
    }
    private _clampLevel(level: number): number {
        return Math.max(0, Math.min(level | 0, this._lodBuffers.length - 1));
    }
    public get vertexCount(): number { return this._vertexCount; }
    public get isAnimated(): boolean { return this._isAnimated; }
}
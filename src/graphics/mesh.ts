// TODO: the six raw-GL draw calls below move onto a RenderPassEncoder with the geometry-pass migration.
import { gl } from './glContext';
import type { PrimitiveTopology, IndexFormat } from './rhi/types';
import { glTopology, glIndexType, indexByteSize } from './rhi/webgl2/glEnums';
import { isTriangleTopology } from './rhi/types';
import { applyVertexLayout, clearVertexLayout, applyReflectedAttribute } from './rhi/webgl2/vertexArray';
// The backend buffer type, not the RHI `Buffer` interface: Mesh builds its own VAO, which needs the
// raw handle.
import { glDevice } from './rhi/webgl2/webgl2Device';
import type { WebGL2Buffer } from './rhi/webgl2/webgl2Device';
import { device } from './rhi/deviceHandle';
import type { Buffer as GpuBuffer } from './rhi/resources';
import { BufferUsage } from './rhi/types';
import {
    MODEL_VERTEX_LAYOUT, BONE_INDEX_LAYOUT, BONE_WEIGHT_LAYOUT,
    packedModelLayout, instanceMatrixLayout, isModelAttribute,
} from './rhi/vertexLayouts';
import { GLState } from './systems/glState';
import { ShaderManager } from './systems/shaderManager';
import { frameStats } from './renderStats';
import { createIndexArray, indexFormatFor } from './indexFormat';

/** Interleaved vertex data. `Float32Array` is the fast path — it is uploaded without a copy. */
export type VertexData = Float32Array | number[];
export type IndexData = Uint32Array | Uint16Array | number[];

/** Avoids re-allocating when the caller already produced a Float32Array (Geometry.getData does). */
function asF32(data: VertexData): Float32Array {
    return data instanceof Float32Array ? data : new Float32Array(data);
}

export class Mesh {
    // This mesh's own VAO — lazy, and null until a legacy draw path needs one. Draws recorded through
    // the RHI use `WebGL2Device.vertexArrayFor` instead.
    private _vertexArray: WebGLVertexArrayObject | null = null;
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
        // STORAGE because `terrainDisplaceCompute.wgsl` writes terrain chunk buffers from a dispatch —
        // the first `var<storage, read_write>` in the engine. It is a usage FLAG, so it costs nothing on
        // a mesh nothing displaces, and WebGL2 ignores it outright (there is no storage-buffer concept
        // there). It has to be declared here rather than added later: a GPUBuffer fixes its usage at
        // creation, so a mesh that might one day be displaced has to ask for it now.
        this._vertexBuffer = device.createBuffer({ label: 'mesh.vertices', size: 0, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST | BufferUsage.STORAGE });
        this._indexBuffer = null;
        this._boneIndicesBuffer = null;
        this._boneWeightsBuffer = null;
        this._vertexCount = 0;
        this._indexCount = 0;
        this._indexFormat = 'uint16';
        this._isAnimated = false;
    }

    /** The VAO, created on first use. WebGL2 only — every caller is a legacy path. */
    private _vao(): WebGLVertexArrayObject {
        if (!this._vertexArray) this._vertexArray = glDevice().createVertexArray();
        return this._vertexArray;
    }

    // Bind this mesh's own VAO before writing an index buffer: ELEMENT_ARRAY_BUFFER is VAO state, so
    // uploading with another mesh's VAO bound would rewrite that mesh's index binding.
    private _bindOwnVAO(): void {
        if (device.backend !== 'webgl2') return;
        GLState.bindVAO(this._vao());
    }

    public create(vertices: VertexData, vertex_count: number, indices: IndexData | null = null): Mesh {
        this._bindOwnVAO();

        // No copy when the caller already has a Float32Array — which Geometry.getData now returns.
        this._vertexBuffer = device.reallocateBuffer(this._vertexBuffer, asF32(vertices));
        this._vertexCount = vertex_count;

        // `indices.length`, not just `indices`: an empty array is truthy and would allocate a
        // zero-length buffer no draw can use.
        if (indices && indices.length > 0) {
            const data = createIndexArray(indices);
            this._indexFormat = indexFormatFor(data);
            this._indexBuffer = device.createBuffer({ label: 'mesh.indices', size: 0, usage: BufferUsage.INDEX | BufferUsage.COPY_DST });
            this._indexBuffer = device.reallocateBuffer(this._indexBuffer, data);
            this._indexCount = indices.length;
        }

        if (device.backend === 'webgl2') GLState.bindVAO(null);

        return this;
    }

    /**
     * Re-upload interleaved vertex data into the existing buffer. Expects the same layout and vertex
     * count `create()` used, so the size is unchanged. Used by terrain sculpting.
     */
    public updateVertexData(vertices: VertexData): void {
        device.writeBuffer(this._vertexBuffer, 0, asF32(vertices));
    }

    public createAnimated(
        vertices: VertexData,
        vertex_count: number,
        boneIndices: VertexData,
        boneWeights: VertexData,
        indices: IndexData | null = null
    ): Mesh {
        this._bindOwnVAO();
        
        // Create and bind main vertex buffer (positions, normals, uvs, tangents, bitangents)
        this._vertexBuffer = device.reallocateBuffer(this._vertexBuffer, new Float32Array(vertices));
        this._vertexCount = vertex_count;

        // Create and bind bone indices buffer
        const boneIndexData = new Int32Array(boneIndices);
        this._boneIndicesBuffer = device.createBuffer({ label: 'mesh.boneIndices', size: 0, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
        this._boneIndicesBuffer = device.reallocateBuffer(this._boneIndicesBuffer, boneIndexData);

        // Create and bind bone weights buffer
        const boneWeightData = new Float32Array(boneWeights);
        this._boneWeightsBuffer = device.createBuffer({ label: 'mesh.boneWeights', size: 0, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
        this._boneWeightsBuffer = device.reallocateBuffer(this._boneWeightsBuffer, boneWeightData);

        // `indices.length`, not just `indices`: an empty array is truthy and would allocate a
        // zero-length buffer no draw can use.
        if (indices && indices.length > 0) {
            const data = createIndexArray(indices);
            this._indexFormat = indexFormatFor(data);
            this._indexBuffer = device.createBuffer({ label: 'mesh.indices', size: 0, usage: BufferUsage.INDEX | BufferUsage.COPY_DST });
            this._indexBuffer = device.reallocateBuffer(this._indexBuffer, data);
            this._indexCount = indices.length;
        }

        this._isAnimated = true;
        if (device.backend === 'webgl2') GLState.bindVAO(null);

        return this;
    }

    /**
     * Upload coarser index sets over this mesh's existing vertex buffer, for terrain LOD. Level 0 stays
     * the base index buffer; `levels[i]` becomes level i+1, replacing any previous set.
     */
    public setLodIndices(levels: number[][]): void {
        if (!this._indexBuffer) return;
        this._bindOwnVAO();

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

        // VAO state, so WebGL2 only. Off it, `activeIndexBuffer` is what callers read instead.
        if (device.backend === 'webgl2') {
            glDevice().bindIndexBuffer(this._lodBuffers[this._lod] as WebGL2Buffer);
            GLState.bindVAO(null);
        }
    }

    /**
     * Release every GPU object this mesh owns — VAO, vertex, index, bone and LOD buffers. Idempotent,
     * and required: dropping the last JS reference frees nothing.
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

        if (this._vertexArray) {
            // GLState dedupes bindVertexArray by identity, so a deleted VAO left cached makes the
            // next bind a no-op.
            if (GLState.currentVAO === this._vertexArray) GLState.reset();
            glDevice().deleteVertexArray(this._vertexArray);
            this._vertexArray = null!;
        }

        this._vertexCount = 0;
        this._indexCount = 0;
    }

    public get hasLods(): boolean { return this._lodBuffers.length > 1; }
    public get activeLod(): number { return this._lod; }
    public set activeLod(level: number) {
        this._lod = Math.max(0, Math.min(Math.round(level), Math.max(0, this._lodBuffers.length - 1)));
    }

    // The three draw methods below issue raw `gl` calls, so reaching them off WebGL2 means the RHI
    // path declined to record. Fail here, naming the path, rather than on an undefined `gl` later.
    private _requireLegacyBackend(path: string): void {
        if (device.backend === 'webgl2') return;
        throw new Error(
            `Mesh.${path} is a WebGL2-only draw path, reached on the ${device.backend} backend ` +
            `(${this._vertexCount} vertices, animated: ${this._isAnimated}, LODs: ${this.hasLods}). ` +
            `The caller should have recorded this draw through the render-pass encoder instead.`);
    }

    public draw(topology: PrimitiveTopology = 'triangle-list'): void {
        this._requireLegacyBackend('draw');
        GLState.bindVAO(this._vao());
        ShaderManager.Instance.flushBound();
        const mode = glTopology(topology);
        const triangles = isTriangleTopology(topology);
        // The element binding is VAO state the last draw may have left on another level.
        if (this.hasLods) {
            glDevice().bindIndexBuffer(this._lodBuffers[this._lod] as WebGL2Buffer);
            const lodCount = this._lodCounts[this._lod];
            gl.drawElements(mode, lodCount, glIndexType(this._lodFormats[this._lod]), 0);
            frameStats.drawCalls++;
            frameStats.vertices += lodCount;
            if (triangles) frameStats.triangles += lodCount / 3;
            return;
        }
        const count = (this._indexBuffer && this._indexCount > 0) ? this._indexCount : this._vertexCount;
        if (this._indexBuffer && this._indexCount > 0)
            gl.drawElements(mode, this._indexCount, glIndexType(this._indexFormat), 0);
        else
            gl.drawArrays(mode, 0, this._vertexCount);
        // Perf stats: every GL draw funnels through here (incl. fullscreen post-process quads).
        frameStats.drawCalls++;
        frameStats.vertices += count;
        if (triangles) frameStats.triangles += count / 3;
    }

    /**
     * Draw one slice of the index buffer — how a multi-material model draws each submesh over its
     * shared vertex buffer. `indexOffset` is in indices, not bytes. LODs are ignored.
     */
    public drawRange(indexOffset: number, indexCount: number, topology: PrimitiveTopology = 'triangle-list'): void {
        if (indexCount <= 0 || !this._indexBuffer || this._indexCount <= 0) return;
        this._requireLegacyBackend('drawRange');
        GLState.bindVAO(this._vao());
        ShaderManager.Instance.flushBound();
        if (this.hasLods) glDevice().bindIndexBuffer(this._lodBuffers[0] as WebGL2Buffer);
        const byteOffset = indexOffset * indexByteSize(this._indexFormat);
        gl.drawElements(glTopology(topology), indexCount, glIndexType(this._indexFormat), byteOffset);
        frameStats.drawCalls++;
        frameStats.vertices += indexCount;
        if (isTriangleTopology(topology)) frameStats.triangles += indexCount / 3;
    }

    public drawInstanced(instanceCount: number, topology: PrimitiveTopology = 'triangle-list'): void {
        this._requireLegacyBackend('drawInstanced');
        GLState.bindVAO(this._vao());
        ShaderManager.Instance.flushBound();
        const mode = glTopology(topology);
        // Always the base index buffer, so `_indexFormat` (level 0's) is the right one to read.
        const count = (this._indexBuffer && this._indexCount > 0) ? this._indexCount : this._vertexCount;
        if (this._indexBuffer && this._indexCount > 0)
            gl.drawElementsInstanced(mode, this._indexCount, glIndexType(this._indexFormat), 0, instanceCount);
        else
            gl.drawArraysInstanced(mode, 0, this._vertexCount, instanceCount);
        // Perf stats: instanced draws (PBR batches + foliage).
        frameStats.drawCalls++;
        frameStats.instancedDrawCalls++;
        frameStats.instances += instanceCount;
        frameStats.vertices += count * instanceCount;
        if (isTriangleTopology(topology)) frameStats.triangles += (count / 3) * instanceCount;
    }

    public initializeVAO(attributes: any): void {
        // Nothing to configure without a VAO — a WebGPU pipeline carries its own vertex layout.
        if (device.backend !== 'webgl2') return;
        GLState.bindVAO(this._vao());

        // Order is the LAYOUT's, never the shader's reflected enumeration — that is driver-dependent,
        // and would interleave the same mesh differently per program. See rhi/vertexLayouts.ts.
        applyVertexLayout(packedModelLayout(attributes), (this._vertexBuffer as WebGL2Buffer).handle);

        // Fallback for any non-standard attribute: trust the reflected layout.
        for (const attr of attributes) {
            if (isModelAttribute(attr.name)) continue;
            // WebGL2-only fallback: `vertexAttribPointer` needs four numbers the model layout omits.
            if (attr.layout) applyReflectedAttribute(attr.location, attr.layout);
        }

        GLState.bindVAO(null);
    }

    public initializeAnimatedVAO(attributes: any): void {
        if (device.backend !== 'webgl2') return;   // see initializeVAO
        if (!this._isAnimated || !this._boneIndicesBuffer || !this._boneWeightsBuffer) {
            throw new Error('Mesh is not animated or bone buffers are not initialized');
        }

        GLState.bindVAO(this._vao());

        // 14 floats, 56-byte stride. Unlike the static path this keeps the WHOLE layout's stride and
        // offsets even for a partial program, because createAnimated always writes all five attributes.
        const declared = new Map<string, number>();
        for (const attr of attributes) declared.set(attr.name as string, attr.location as number);

        // Only the attributes this program declares, at the full layout's offsets.
        applyVertexLayout({
            ...MODEL_VERTEX_LAYOUT,
            attributes: MODEL_VERTEX_LAYOUT.attributes
                .filter(a => declared.has(a.name))
                .map(a => ({ ...a, shaderLocation: declared.get(a.name) as number })),
        }, (this._vertexBuffer as WebGL2Buffer).handle);

        // Fallback for anything unexpected: trust the reflected layout, as the non-animated path does.
        for (const attr of attributes) {
            const name: string = attr.name;
            if (name === 'a_boneIds' || name === 'a_weights') continue; // dedicated buffers, below
            if (MODEL_VERTEX_LAYOUT.attributes.some(a => a.name === name)) continue;
            // WebGL2-only fallback: `vertexAttribPointer` needs four numbers the model layout omits.
            if (attr.layout) applyReflectedAttribute(attr.location, attr.layout);
        }

        // Find the bone attributes in the shader
        let boneIdsLocation = -1;
        let weightsLocation = -1;
        for (let attr of attributes) {
            if (attr.name === 'a_boneIds') boneIdsLocation = attr.location;
            else if (attr.name === 'a_weights') weightsLocation = attr.location;
        }

        // Bone indices must go through the INTEGER pointer (BONE_INDEX_LAYOUT's sint32x4); the float
        // path would convert the bits rather than reinterpret them, skinning every vertex to joint 0.
        if (boneIdsLocation >= 0)
            applyVertexLayout(
                { ...BONE_INDEX_LAYOUT, attributes: [{ ...BONE_INDEX_LAYOUT.attributes[0], shaderLocation: boneIdsLocation }] },
                (this._boneIndicesBuffer as WebGL2Buffer).handle,
            );

        if (weightsLocation >= 0)
            applyVertexLayout(
                { ...BONE_WEIGHT_LAYOUT, attributes: [{ ...BONE_WEIGHT_LAYOUT.attributes[0], shaderLocation: weightsLocation }] },
                (this._boneWeightsBuffer as WebGL2Buffer).handle,
            );

        GLState.bindVAO(null);
    }

    /**
     * Configure this mesh's VAO to read a per-instance mat4 from `buffer` at locations
     * `baseLocation..baseLocation+3`. The caller uploads the matrices before `drawInstanced`.
     */
    public setupInstanceMatrixBuffer(buffer: GpuBuffer, baseLocation: number = 5): void {
        // Nothing to configure without a VAO — a WebGPU pipeline carries its own vertex layout.
        if (device.backend !== 'webgl2') return;
        GLState.bindVAO(this._vao());
        // Neither API has a mat4 vertex format; both take one as four consecutive vec4 slots.
        applyVertexLayout(instanceMatrixLayout(baseLocation), (buffer as WebGL2Buffer).handle);
    }

    /**
     * Undo {@link setupInstanceMatrixBuffer}. Must be called after instanced draws: locations left
     * enabled with divisor 1 corrupt a later non-instanced draw of the same mesh.
     */
    public teardownInstanceMatrixBuffer(baseLocation: number = 5): void {
        // Nothing to configure without a VAO — a WebGPU pipeline carries its own vertex layout.
        if (device.backend !== 'webgl2') return;
        GLState.bindVAO(this._vao());
        clearVertexLayout(instanceMatrixLayout(baseLocation));
    }

    /** Null until a legacy draw or `initializeVAO` has needed one — see `_vao`. */
    public get vertexArray(): WebGLVertexArrayObject | null { return this._vertexArray; }
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
    public get vertexCount(): number { return this._vertexCount; }
    public get isAnimated(): boolean { return this._isAnimated; }
}
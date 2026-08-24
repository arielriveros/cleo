// The last raw GL in this file is the six draw calls below. They stay because a draw belongs on a
// render-pass encoder (`RenderPassEncoder.drawIndexed`), not on a device method invented to hold it —
// and moving Mesh onto the encoder is the geometry-pass migration, not this one.
import { gl } from './glContext';
import type { PrimitiveTopology, IndexFormat } from './rhi/types';
import { glTopology, isTriangleTopology, glIndexType, indexByteSize } from './rhi/webgl2/glEnums';
import { applyVertexLayout, clearVertexLayout, applyReflectedAttribute } from './rhi/webgl2/vertexArray';
// The backend buffer type, not the RHI `Buffer` interface: Mesh still builds its own VAO, which is a
// WebGL2-only construct that needs the raw handle. It becomes `Buffer` once render pipelines take over
// vertex-layout ownership and the VAO disappears (M5).
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
    /**
     * This mesh's own VAO — LAZY, and null until a legacy path needs one.
     *
     * It exists only for `draw`/`drawRange`/`drawInstanced` and the `initializeVAO` family. Draws
     * recorded through the RHI never touch it: `WebGL2Device.vertexArrayFor` builds and caches its own,
     * keyed by pipeline and buffer set. Creating it eagerly in the constructor was what made `new Mesh()`
     * the first thing to fail on a WebGPU device — a `WebGLVertexArrayObject` for a backend that has no
     * such concept, allocated before anything had decided whether a legacy draw would ever happen.
     */
    private _vertexArray: WebGLVertexArrayObject | null = null;
    private _vertexBuffer: GpuBuffer;
    private _indexBuffer: GpuBuffer | null;
    private _boneIndicesBuffer: GpuBuffer | null;
    private _boneWeightsBuffer: GpuBuffer | null;
    private _vertexCount: number;
    private _indexCount: number;
    // How to read _indexBuffer — uint16 or uint32, chosen per upload by index range. Meshes over 65535
    // vertices need the wider type; narrowing them was silently scrambling geometry. Held as the RHI's
    // format rather than the GL enum, so the only place the two meet is the draw call itself.
    private _indexFormat: IndexFormat;
    private _isAnimated: boolean;
    // Alternate index buffers over the SAME vertex buffer (level 0 = the base one). Terrain LOD only.
    private _lodBuffers: GpuBuffer[] = [];
    private _lodCounts: number[] = [];
    // Index format per LOD level, parallel to _lodCounts. Levels index the same vertex buffer as the base,
    // so they can never need a wider type than it — but create() does not keep the base index array, so a
    // single per-mesh type could never be widened after the fact if that assumption ever broke. Per-level
    // costs a 3-entry array and mirrors the _lodBuffers/_lodCounts level-0 aliasing exactly.
    private _lodFormats: IndexFormat[] = [];
    private _lod: number = 0;

    constructor() {
        // VERTEX | COPY_DST: the geometry is written after creation, and terrain sculpting rewrites it
        // in place through updateVertexData — which is also what earns it a DYNAMIC_DRAW hint.
        this._vertexBuffer = device.createBuffer({ label: 'mesh.vertices', size: 0, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
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

    /**
     * Bind this mesh's own VAO before writing an index buffer.
     *
     * `ELEMENT_ARRAY_BUFFER` is VAO state on WebGL2, so uploading an index buffer while ANOTHER mesh's
     * VAO happens to be bound rewrites that mesh's index binding. Binding this one first is what keeps
     * the write harmless. WebGPU has neither the binding point nor the coupling, so there is nothing to
     * do there — and doing it anyway would allocate the VAO this class exists to stop allocating.
     */
    private _bindOwnVAO(): void {
        if (device.backend !== 'webgl2') return;
        GLState.bindVAO(this._vao());
    }

    public create(vertices: VertexData, vertex_count: number, indices: IndexData | null = null): Mesh {
        this._bindOwnVAO();

        // No copy when the caller already has a Float32Array — which Geometry.getData now returns.
        this._vertexBuffer = device.reallocateBuffer(this._vertexBuffer, asF32(vertices));
        this._vertexCount = vertex_count;

        // `indices.length`, not just `indices`: an empty array is truthy, so a geometry with no indices
        // used to allocate a zero-length index buffer that no draw could ever use — and that nothing frees.
        // The draw paths already gate on `_indexCount > 0`, so this only skips the pointless allocation.
        if (indices && indices.length > 0) {
            const data = createIndexArray(indices);
            this._indexFormat = indexFormatFor(data);
            this._indexBuffer = device.createBuffer({ label: 'mesh.indices', size: 0, usage: BufferUsage.INDEX });
            this._indexBuffer = device.reallocateBuffer(this._indexBuffer, data);
            this._indexCount = indices.length;
        }

        if (device.backend === 'webgl2') GLState.bindVAO(null);

        return this;
    }

    /**
     * Re-upload interleaved vertex data into the existing vertex buffer at runtime.
     * Expects the same layout and vertex count used in `create()` (position/normal/uv/tangent/bitangent),
     * so the buffer size is unchanged. Used for dynamically deforming meshes (e.g. terrain sculpting).
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
        this._boneIndicesBuffer = device.createBuffer({ label: 'mesh.boneIndices', size: 0, usage: BufferUsage.VERTEX });
        this._boneIndicesBuffer = device.reallocateBuffer(this._boneIndicesBuffer, boneIndexData);

        // Create and bind bone weights buffer
        const boneWeightData = new Float32Array(boneWeights);
        this._boneWeightsBuffer = device.createBuffer({ label: 'mesh.boneWeights', size: 0, usage: BufferUsage.VERTEX });
        this._boneWeightsBuffer = device.reallocateBuffer(this._boneWeightsBuffer, boneWeightData);

        // `indices.length`, not just `indices`: an empty array is truthy, so a geometry with no indices
        // used to allocate a zero-length index buffer that no draw could ever use — and that nothing frees.
        // The draw paths already gate on `_indexCount > 0`, so this only skips the pointless allocation.
        if (indices && indices.length > 0) {
            const data = createIndexArray(indices);
            this._indexFormat = indexFormatFor(data);
            this._indexBuffer = device.createBuffer({ label: 'mesh.indices', size: 0, usage: BufferUsage.INDEX });
            this._indexBuffer = device.reallocateBuffer(this._indexBuffer, data);
            this._indexCount = indices.length;
        }

        this._isAnimated = true;
        if (device.backend === 'webgl2') GLState.bindVAO(null);

        return this;
    }

    /**
     * Upload coarser index sets over this mesh's existing vertex buffer (used by the terrain LOD: the
     * levels only decimate the triangulation, the vertices are shared). Level 0 stays the base index
     * buffer from `create()`; `levels[i]` becomes level i+1. Re-uploading replaces any previous set.
     */
    public setLodIndices(levels: number[][]): void {
        if (!this._indexBuffer) return;
        // The ELEMENT_ARRAY_BUFFER binding belongs to whichever VAO is current, so bind THIS mesh's VAO
        // before uploading: doing it with another mesh's VAO bound would rewrite that mesh's index binding.
        this._bindOwnVAO();

        for (let i = 1; i < this._lodBuffers.length; i++) this._lodBuffers[i].destroy();
        this._lodBuffers = [this._indexBuffer];
        this._lodCounts = [this._indexCount];
        this._lodFormats = [this._indexFormat];
        for (const indices of levels) {
            const data = createIndexArray(indices);
            let buffer = device.createBuffer({ label: 'mesh.lodIndices', size: 0, usage: BufferUsage.INDEX });
            buffer = device.reallocateBuffer(buffer, data) as typeof buffer;
            this._lodBuffers.push(buffer);
            this._lodCounts.push(indices.length);
            this._lodFormats.push(indexFormatFor(data));
        }
        this._lod = Math.min(this._lod, this._lodBuffers.length - 1);

        // Leave this VAO pointing at a valid index buffer (the uploads left the last level bound); every
        // subsequent draw re-binds the selected level anyway, since `hasLods` is now true.
        glDevice().bindIndexBuffer(this._lodBuffers[this._lod] as WebGL2Buffer);
        GLState.bindVAO(null);
    }

    /**
     * Releases every GL object this mesh owns: its VAO, vertex buffer, index buffer, bone buffers and any
     * LOD index buffers. Idempotent.
     *
     * Ownership is exclusive — nothing shares a Mesh's buffers — so unlike textures or shader programs
     * there is no question of whether it is safe to free. It is only ever unsafe to free a mesh something
     * still draws, which is the caller's business.
     *
     * Dropping the last JS reference to a Mesh frees nothing on its own: GL objects have no finalizer, so
     * a mesh discarded without this call leaks for the life of the context.
     */
    public dispose(): void {
        // Level 0 aliases _indexBuffer, so start at 1 — deleting it here and again below is harmless
        // (deleteBuffer on an already-deleted buffer is a no-op) but the aliasing is worth being explicit
        // about, since _lodBuffers[0] === _indexBuffer is load-bearing elsewhere.
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
            // Same trap as the shader program: GLState dedupes bindVertexArray by identity, so a deleted
            // VAO left in the cache would make the next bind of it a no-op.
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

    public draw(topology: PrimitiveTopology = 'triangle-list'): void {
        GLState.bindVAO(this._vao());
        ShaderManager.Instance.flushBound();
        const mode = glTopology(topology);
        const triangles = isTriangleTopology(topology);
        // With LODs, the element binding is VAO state that the last draw may have left on another level,
        // so the selected level's buffer is (re)bound every draw.
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
     * Draw one slice of the index buffer — how a merged, multi-material model draws each of its
     * submeshes with its own material over a single shared vertex buffer.
     *
     * `indexOffset` is in INDICES; `drawElements` wants bytes, hence the multiply by the index size.
     * LODs are ignored on purpose: a LOD level is a whole alternate index buffer, so its ranges would
     * be meaningless. A model with submeshes never gets LODs (LOD baking rejects them upstream).
     */
    public drawRange(indexOffset: number, indexCount: number, topology: PrimitiveTopology = 'triangle-list'): void {
        if (indexCount <= 0 || !this._indexBuffer || this._indexCount <= 0) return;
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
        GLState.bindVAO(this._vao());
        ShaderManager.Instance.flushBound();
        const mode = glTopology(topology);
        // Note this path ignores LODs entirely — it always draws the base index buffer, so _indexFormat
        // (level 0's format) is the right one to read. Pre-existing behaviour; foliage never sets LODs.
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
        // Nothing to configure without a VAO: a WebGPU pipeline carries its vertex layout, and the
        // only reader of this one is the legacy draw path, which that backend never takes. Guarded
        // rather than left to throw because the callers are unconditional — `initializeModel` runs
        // for every model on every backend.
        if (device.backend !== 'webgl2') return;
        GLState.bindVAO(this._vao());

        // The standard attributes, packed in canonical order over only the ones this program declares.
        // The order is the layout's, NOT the shader's reflected enumeration — that is driver- and
        // program-dependent, and trusting it would interleave the same mesh differently for, say, the
        // 'default' and 'pbr' programs. See rhi/vertexLayouts.ts.
        applyVertexLayout(packedModelLayout(attributes), (this._vertexBuffer as WebGL2Buffer).handle);

        // Fallback for any non-standard attribute: trust the reflected layout.
        for (const attr of attributes) {
            if (isModelAttribute(attr.name)) continue;
            // The reflected layout is WebGL2-only, so this whole fallback is: it exists because
            // `vertexAttribPointer` needs four numbers the canonical model layout does not carry.
            if (attr.layout) applyReflectedAttribute(attr.location, attr.layout);
        }

        GLState.bindVAO(null);
    }

    public initializeAnimatedVAO(attributes: any): void {
        if (!this._isAnimated || !this._boneIndicesBuffer || !this._boneWeightsBuffer) {
            throw new Error('Mesh is not animated or bone buffers are not initialized');
        }

        GLState.bindVAO(this._vao());

        // The full interleaved model vertex — position(3), normal(3), uv(2), tangent(3), bitangent(3),
        // 14 floats and a 56-byte stride. Unlike the non-animated path this keeps the WHOLE layout's
        // stride and offsets even when a program declares only part of it, because createAnimated
        // always writes all five attributes.
        const declared = new Map<string, number>();
        for (const attr of attributes) declared.set(attr.name as string, attr.location as number);

        // Only the attributes this program actually declares, at the full layout's offsets. Bone data
        // rides in dedicated buffers and is bound separately below.
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
            // The reflected layout is WebGL2-only, so this whole fallback is: it exists because
            // `vertexAttribPointer` needs four numbers the canonical model layout does not carry.
            if (attr.layout) applyReflectedAttribute(attr.location, attr.layout);
        }

        // Find the bone attributes in the shader
        let boneIdsLocation = -1;
        let weightsLocation = -1;
        for (let attr of attributes) {
            if (attr.name === 'a_boneIds') boneIdsLocation = attr.location;
            else if (attr.name === 'a_weights') weightsLocation = attr.location;
        }

        // The bone attributes ride in dedicated buffers, so each is its own single-attribute layout at
        // the location this program reflected. Indices go through the INTEGER pointer — that is what
        // BONE_INDEX_LAYOUT's sint32x4 selects inside applyVertexLayout, and routing them through the
        // float path would convert the bits rather than reinterpret them, skinning every vertex to
        // joint 0.
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
     * Configure this mesh's VAO to read a per-instance model matrix (mat4) from the given buffer
     * at attribute locations baseLocation..baseLocation+3, advancing once per instance. The caller
     * is responsible for uploading matrices to `buffer` before drawing with `drawInstanced`.
     */
    public setupInstanceMatrixBuffer(buffer: GpuBuffer, baseLocation: number = 5): void {
        // Nothing to configure without a VAO: a WebGPU pipeline carries its vertex layout, and the
        // only reader of this one is the legacy draw path, which that backend never takes. Guarded
        // rather than left to throw because the callers are unconditional — `initializeModel` runs
        // for every model on every backend.
        if (device.backend !== 'webgl2') return;
        GLState.bindVAO(this._vao());
        // Neither API has a mat4 vertex format; both consume one as four consecutive vec4 slots. The
        // per-instance divisor comes from the layout's stepMode.
        applyVertexLayout(instanceMatrixLayout(baseLocation), (buffer as WebGL2Buffer).handle);
    }

    /**
     * Undo {@link setupInstanceMatrixBuffer}: disable the per-instance matrix attributes and reset
     * their divisor back to 0. Leaving locations 5-8 enabled with divisor 1 on a shared mesh VAO
     * would corrupt a later non-instanced draw of the same mesh, so call this after instanced draws.
     */
    public teardownInstanceMatrixBuffer(baseLocation: number = 5): void {
        // Nothing to configure without a VAO: a WebGPU pipeline carries its vertex layout, and the
        // only reader of this one is the legacy draw path, which that backend never takes. Guarded
        // rather than left to throw because the callers are unconditional — `initializeModel` runs
        // for every model on every backend.
        if (device.backend !== 'webgl2') return;
        GLState.bindVAO(this._vao());
        clearVertexLayout(instanceMatrixLayout(baseLocation));
    }

    /** Null until a legacy draw or `initializeVAO` has needed one — see `_vao`. */
    public get vertexArray(): WebGLVertexArrayObject | null { return this._vertexArray; }
    /** The device-owned vertex buffer. Was declared as a raw WebGLBuffer, which the empty-interface
     *  structural match let through even after the field became a wrapper. */
    public get vertexBuffer(): GpuBuffer { return this._vertexBuffer; }
    /**
     * The index buffer and how to read it, for a draw recorded through the RHI.
     *
     * The format is chosen per upload by index range — a mesh over 65535 vertices needs the wider type,
     * and narrowing it silently scrambles geometry.
     */
    public get indexBuffer(): GpuBuffer | null { return this._indexBuffer; }
    public get indexFormat(): IndexFormat { return this._indexFormat; }
    public get indexCount(): number { return this._indexCount; }
    /** The dedicated bone buffers, for a skinned draw recorded through the RHI. */
    public get boneIndicesBuffer(): GpuBuffer | null { return this._boneIndicesBuffer; }
    public get boneWeightsBuffer(): GpuBuffer | null { return this._boneWeightsBuffer; }
    /**
     * The index buffer for the ACTIVE LOD level, with its count and type.
     *
     * LOD levels are alternate index buffers over the same vertices, so only the element binding
     * changes between them — which is exactly what `setIndexBuffer` expresses.
     */
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
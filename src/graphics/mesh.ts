import { gl } from './glContext';
import { GLState } from './systems/glState';
import { frameStats } from './renderStats';
import { createIndexArray, glTypeFor } from './indexFormat';

/** Interleaved vertex data. `Float32Array` is the fast path — it is uploaded without a copy. */
export type VertexData = Float32Array | number[];
export type IndexData = Uint32Array | Uint16Array | number[];

/** Avoids re-allocating when the caller already produced a Float32Array (Geometry.getData does). */
function asF32(data: VertexData): Float32Array {
    return data instanceof Float32Array ? data : new Float32Array(data);
}

export class Mesh {
    private _vertexArray: WebGLVertexArrayObject;
    private _vertexBuffer: WebGLBuffer;
    private _indexBuffer: WebGLBuffer | null;
    private _boneIndicesBuffer: WebGLBuffer | null;
    private _boneWeightsBuffer: WebGLBuffer | null;
    private _vertexCount: number;
    private _indexCount: number;
    // GL element type of _indexBuffer — UNSIGNED_SHORT or UNSIGNED_INT, chosen per upload by index range.
    // Meshes over 65535 vertices need the wider type; narrowing them was silently scrambling geometry.
    private _indexType: number;
    private _isAnimated: boolean;
    // Alternate index buffers over the SAME vertex buffer (level 0 = the base one). Terrain LOD only.
    private _lodBuffers: WebGLBuffer[] = [];
    private _lodCounts: number[] = [];
    // Element type per LOD level, parallel to _lodCounts. Levels index the same vertex buffer as the base,
    // so they can never need a wider type than it — but create() does not keep the base index array, so a
    // single per-mesh type could never be widened after the fact if that assumption ever broke. Per-level
    // costs a 3-entry array and mirrors the _lodBuffers/_lodCounts level-0 aliasing exactly.
    private _lodTypes: number[] = [];
    private _lod: number = 0;

    constructor() {
        this._vertexArray = gl.createVertexArray() as WebGLVertexArrayObject;
        this._vertexBuffer = gl.createBuffer() as WebGLBuffer;
        this._indexBuffer = null;
        this._boneIndicesBuffer = null;
        this._boneWeightsBuffer = null;
        this._vertexCount = 0;
        this._indexCount = 0;
        this._indexType = gl.UNSIGNED_SHORT;
        this._isAnimated = false;
    }

    public create(vertices: VertexData, vertex_count: number, indices: IndexData | null = null): Mesh {
        GLState.bindVAO(this._vertexArray);

        gl.bindBuffer(gl.ARRAY_BUFFER, this._vertexBuffer);
        // No copy when the caller already has a Float32Array — which Geometry.getData now returns.
        gl.bufferData(gl.ARRAY_BUFFER, asF32(vertices), gl.STATIC_DRAW);
        this._vertexCount = vertex_count;

        // `indices.length`, not just `indices`: an empty array is truthy, so a geometry with no indices
        // used to allocate a zero-length index buffer that no draw could ever use — and that nothing frees.
        // The draw paths already gate on `_indexCount > 0`, so this only skips the pointless allocation.
        if (indices && indices.length > 0) {
            const data = createIndexArray(indices);
            this._indexType = glTypeFor(data);
            this._indexBuffer = gl.createBuffer() as WebGLBuffer;
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._indexBuffer);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data, gl.STATIC_DRAW);
            this._indexCount = indices.length;
        }

        GLState.bindVAO(null);

        return this;
    }

    /**
     * Re-upload interleaved vertex data into the existing vertex buffer at runtime.
     * Expects the same layout and vertex count used in `create()` (position/normal/uv/tangent/bitangent),
     * so the buffer size is unchanged. Used for dynamically deforming meshes (e.g. terrain sculpting).
     */
    public updateVertexData(vertices: VertexData): void {
        gl.bindBuffer(gl.ARRAY_BUFFER, this._vertexBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, asF32(vertices));
    }

    public createAnimated(
        vertices: VertexData,
        vertex_count: number,
        boneIndices: VertexData,
        boneWeights: VertexData,
        indices: IndexData | null = null
    ): Mesh {
        GLState.bindVAO(this._vertexArray);
        
        // Create and bind main vertex buffer (positions, normals, uvs, tangents, bitangents)
        gl.bindBuffer(gl.ARRAY_BUFFER, this._vertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
        this._vertexCount = vertex_count;

        // Create and bind bone indices buffer
        this._boneIndicesBuffer = gl.createBuffer() as WebGLBuffer;
        gl.bindBuffer(gl.ARRAY_BUFFER, this._boneIndicesBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Int32Array(boneIndices), gl.STATIC_DRAW);

        // Create and bind bone weights buffer
        this._boneWeightsBuffer = gl.createBuffer() as WebGLBuffer;
        gl.bindBuffer(gl.ARRAY_BUFFER, this._boneWeightsBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(boneWeights), gl.STATIC_DRAW);

        // `indices.length`, not just `indices`: an empty array is truthy, so a geometry with no indices
        // used to allocate a zero-length index buffer that no draw could ever use — and that nothing frees.
        // The draw paths already gate on `_indexCount > 0`, so this only skips the pointless allocation.
        if (indices && indices.length > 0) {
            const data = createIndexArray(indices);
            this._indexType = glTypeFor(data);
            this._indexBuffer = gl.createBuffer() as WebGLBuffer;
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._indexBuffer);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data, gl.STATIC_DRAW);
            this._indexCount = indices.length;
        }

        this._isAnimated = true;
        GLState.bindVAO(null);

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
        GLState.bindVAO(this._vertexArray);

        for (let i = 1; i < this._lodBuffers.length; i++) gl.deleteBuffer(this._lodBuffers[i]);
        this._lodBuffers = [this._indexBuffer];
        this._lodCounts = [this._indexCount];
        this._lodTypes = [this._indexType];
        for (const indices of levels) {
            const data = createIndexArray(indices);
            const buffer = gl.createBuffer() as WebGLBuffer;
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffer);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data, gl.STATIC_DRAW);
            this._lodBuffers.push(buffer);
            this._lodCounts.push(indices.length);
            this._lodTypes.push(glTypeFor(data));
        }
        this._lod = Math.min(this._lod, this._lodBuffers.length - 1);

        // Leave this VAO pointing at a valid index buffer (the uploads left the last level bound); every
        // subsequent draw re-binds the selected level anyway, since `hasLods` is now true.
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._lodBuffers[this._lod]);
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
        for (let i = 1; i < this._lodBuffers.length; i++) gl.deleteBuffer(this._lodBuffers[i]);
        this._lodBuffers = [];
        this._lodCounts = [];
        this._lodTypes = [];
        this._lod = 0;

        if (this._indexBuffer) { gl.deleteBuffer(this._indexBuffer); this._indexBuffer = null; }
        if (this._boneIndicesBuffer) { gl.deleteBuffer(this._boneIndicesBuffer); this._boneIndicesBuffer = null; }
        if (this._boneWeightsBuffer) { gl.deleteBuffer(this._boneWeightsBuffer); this._boneWeightsBuffer = null; }
        if (this._vertexBuffer) { gl.deleteBuffer(this._vertexBuffer); this._vertexBuffer = null!; }

        if (this._vertexArray) {
            // Same trap as the shader program: GLState dedupes bindVertexArray by identity, so a deleted
            // VAO left in the cache would make the next bind of it a no-op.
            if (GLState.currentVAO === this._vertexArray) GLState.reset();
            gl.deleteVertexArray(this._vertexArray);
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

    public draw(mode: number = gl.TRIANGLES): void {
        GLState.bindVAO(this._vertexArray);
        // With LODs, the element binding is VAO state that the last draw may have left on another level,
        // so the selected level's buffer is (re)bound every draw.
        if (this.hasLods) {
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._lodBuffers[this._lod]);
            const lodCount = this._lodCounts[this._lod];
            gl.drawElements(mode, lodCount, this._lodTypes[this._lod], 0);
            frameStats.drawCalls++;
            frameStats.vertices += lodCount;
            if (mode === gl.TRIANGLES) frameStats.triangles += lodCount / 3;
            return;
        }
        const count = (this._indexBuffer && this._indexCount > 0) ? this._indexCount : this._vertexCount;
        if (this._indexBuffer && this._indexCount > 0)
            gl.drawElements(mode, this._indexCount, this._indexType, 0);
        else
            gl.drawArrays(mode, 0, this._vertexCount);
        // Perf stats: every GL draw funnels through here (incl. fullscreen post-process quads).
        frameStats.drawCalls++;
        frameStats.vertices += count;
        if (mode === gl.TRIANGLES) frameStats.triangles += count / 3;
    }

    public drawInstanced(instanceCount: number, mode: number = gl.TRIANGLES): void {
        GLState.bindVAO(this._vertexArray);
        // Note this path ignores LODs entirely — it always draws the base index buffer, so _indexType
        // (level 0's type) is the right one to read. Pre-existing behaviour; foliage never sets LODs.
        const count = (this._indexBuffer && this._indexCount > 0) ? this._indexCount : this._vertexCount;
        if (this._indexBuffer && this._indexCount > 0)
            gl.drawElementsInstanced(mode, this._indexCount, this._indexType, 0, instanceCount);
        else
            gl.drawArraysInstanced(mode, 0, this._vertexCount, instanceCount);
        // Perf stats: instanced draws (PBR batches + foliage).
        frameStats.drawCalls++;
        frameStats.instancedDrawCalls++;
        frameStats.instances += instanceCount;
        frameStats.vertices += count * instanceCount;
        if (mode === gl.TRIANGLES) frameStats.triangles += (count / 3) * instanceCount;
    }

    // Canonical interleaved vertex layout, matching the fixed order Geometry.getData() emits:
    // position, normal, uv, tangent, bitangent. Keyed by both the `a_`-prefixed shader name and
    // the bare name. This is the single source of truth for attribute order/size — NOT the shader's
    // reflected attribute enumeration (gl.getActiveAttrib), whose order is driver/program dependent
    // and would otherwise scramble the VAO for some material programs (e.g. 'default' vs 'pbr').
    private static readonly _CANON_ATTR: Record<string, { order: number; size: number }> = {
        a_position:  { order: 0, size: 3 }, position:  { order: 0, size: 3 },
        a_normal:    { order: 1, size: 3 }, normal:    { order: 1, size: 3 },
        a_texCoord:  { order: 2, size: 2 }, texCoord:  { order: 2, size: 2 },
        a_uv:        { order: 2, size: 2 }, uv:        { order: 2, size: 2 },
        a_tangent:   { order: 3, size: 3 }, tangent:   { order: 3, size: 3 },
        a_bitangent: { order: 4, size: 3 }, bitangent: { order: 4, size: 3 },
    };

    public initializeVAO(attributes: any): void {
        GLState.bindVAO(this._vertexArray);

        gl.bindBuffer(gl.ARRAY_BUFFER, this._vertexBuffer);

        // Split the shader's attributes into the canonical standard set and any unknown extras.
        const known: { location: number; size: number; order: number }[] = [];
        const unknown: any[] = [];
        for (const attr of attributes) {
            const canon = Mesh._CANON_ATTR[attr.name as string];
            if (canon) known.push({ location: attr.location, size: canon.size, order: canon.order });
            else unknown.push(attr);
        }

        // Assign packed offsets in canonical order (position, normal, uv, tangent, bitangent),
        // over only the attributes present — exactly how Geometry.getData() interleaves them.
        known.sort((a, b) => a.order - b.order);
        const floatSize = 4;
        const stride = known.reduce((s, a) => s + a.size, 0) * floatSize;
        let offset = 0;
        for (const attr of known) {
            gl.enableVertexAttribArray(attr.location);
            gl.vertexAttribPointer(attr.location, attr.size, gl.FLOAT, false, stride, offset);
            offset += attr.size * floatSize;
        }

        // Fallback for any non-standard attribute: trust the reflected layout.
        for (const attr of unknown) {
            gl.enableVertexAttribArray(attr.location);
            gl.vertexAttribPointer(attr.location, attr.layout.size, attr.layout.type, false, attr.layout.stride, attr.layout.offset);
        }

        GLState.bindVAO(null);
    }

    public initializeAnimatedVAO(attributes: any): void {
        if (!this._isAnimated || !this._boneIndicesBuffer || !this._boneWeightsBuffer) {
            throw new Error('Mesh is not animated or bone buffers are not initialized');
        }

        GLState.bindVAO(this._vertexArray);

        // Our interleaved main vertex buffer layout (floats):
        // position(3), normal(3), uv(2), tangent(3), bitangent(3) => 14 floats per-vertex
        const floatSize = 4;
        const stride = 14 * floatSize; // 56 bytes
        const offsets: Record<string, { size: number; offset: number }> = {
            'a_position':   { size: 3, offset: 0 * floatSize },
            'a_normal':     { size: 3, offset: 3 * floatSize },
            'a_texCoord':   { size: 2, offset: 6 * floatSize },
            'a_tangent':    { size: 3, offset: 8 * floatSize },
            'a_bitangent':  { size: 3, offset: 11 * floatSize },
        };

        // Set up main vertex buffer attributes (position, normal, uv, tangent, bitangent)
        gl.bindBuffer(gl.ARRAY_BUFFER, this._vertexBuffer);
        for (let attr of attributes) {
            const name: string = attr.name;
            if (name === 'a_boneIds' || name === 'a_weights') continue; // handled below with dedicated buffers

            const layout = offsets[name];
            if (layout) {
                gl.enableVertexAttribArray(attr.location);
                gl.vertexAttribPointer(attr.location, layout.size, gl.FLOAT, false, stride, layout.offset);
            } else {
                // Fallback: if an unexpected attribute appears, try using provided layout info
                gl.enableVertexAttribArray(attr.location);
                gl.vertexAttribPointer(attr.location, attr.layout.size, attr.layout.type, false, attr.layout.stride, attr.layout.offset);
            }
        }

        // Find the bone attributes in the shader
        let boneIdsLocation = -1;
        let weightsLocation = -1;
        for (let attr of attributes) {
            if (attr.name === 'a_boneIds') boneIdsLocation = attr.location;
            else if (attr.name === 'a_weights') weightsLocation = attr.location;
        }

        // Set up bone indices attribute (integers)
        if (boneIdsLocation >= 0) {
            gl.bindBuffer(gl.ARRAY_BUFFER, this._boneIndicesBuffer);
            gl.enableVertexAttribArray(boneIdsLocation);
            gl.vertexAttribIPointer(boneIdsLocation, 4, gl.INT, 0, 0);
        }

        // Set up bone weights attribute (floats)
        if (weightsLocation >= 0) {
            gl.bindBuffer(gl.ARRAY_BUFFER, this._boneWeightsBuffer);
            gl.enableVertexAttribArray(weightsLocation);
            gl.vertexAttribPointer(weightsLocation, 4, gl.FLOAT, false, 0, 0);
        }

        GLState.bindVAO(null);
    }

    /**
     * Configure this mesh's VAO to read a per-instance model matrix (mat4) from the given buffer
     * at attribute locations baseLocation..baseLocation+3, advancing once per instance. The caller
     * is responsible for uploading matrices to `buffer` before drawing with `drawInstanced`.
     */
    public setupInstanceMatrixBuffer(buffer: WebGLBuffer, baseLocation: number = 5): void {
        GLState.bindVAO(this._vertexArray);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        const stride = 16 * 4; // mat4 = 16 floats
        for (let i = 0; i < 4; i++) {
            const loc = baseLocation + i;
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, stride, i * 4 * 4);
            gl.vertexAttribDivisor(loc, 1);
        }
    }

    /**
     * Undo {@link setupInstanceMatrixBuffer}: disable the per-instance matrix attributes and reset
     * their divisor back to 0. Leaving locations 5-8 enabled with divisor 1 on a shared mesh VAO
     * would corrupt a later non-instanced draw of the same mesh, so call this after instanced draws.
     */
    public teardownInstanceMatrixBuffer(baseLocation: number = 5): void {
        GLState.bindVAO(this._vertexArray);
        for (let i = 0; i < 4; i++) {
            const loc = baseLocation + i;
            gl.vertexAttribDivisor(loc, 0);
            gl.disableVertexAttribArray(loc);
        }
    }

    public get vertexArray(): WebGLVertexArrayObject { return this._vertexArray; }
    public get vertexBuffer(): WebGLBuffer { return this._vertexBuffer; }
    public get isAnimated(): boolean { return this._isAnimated; }
}
import { gl } from './renderer';
import { GLState } from './systems/glState';

export class Mesh {
    private _vertexArray: WebGLVertexArrayObject;
    private _vertexBuffer: WebGLBuffer;
    private _indexBuffer: WebGLBuffer | null;
    private _boneIndicesBuffer: WebGLBuffer | null;
    private _boneWeightsBuffer: WebGLBuffer | null;
    private _vertexCount: number;
    private _indexCount: number;
    private _isAnimated: boolean;

    constructor() {
        this._vertexArray = gl.createVertexArray() as WebGLVertexArrayObject;
        this._vertexBuffer = gl.createBuffer() as WebGLBuffer;
        this._indexBuffer = null;
        this._boneIndicesBuffer = null;
        this._boneWeightsBuffer = null;
        this._vertexCount = 0;
        this._indexCount = 0;
        this._isAnimated = false;
    }

    public create(vertices: number[], vertex_count: number, indices: number[] | null = null): Mesh {
        GLState.bindVAO(this._vertexArray);
        
        gl.bindBuffer(gl.ARRAY_BUFFER, this._vertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
        this._vertexCount = vertex_count;

        if (indices) {
            this._indexBuffer = gl.createBuffer() as WebGLBuffer;
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._indexBuffer);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
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
    public updateVertexData(vertices: number[]): void {
        gl.bindBuffer(gl.ARRAY_BUFFER, this._vertexBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array(vertices));
    }

    public createAnimated(
        vertices: number[], 
        vertex_count: number, 
        boneIndices: number[], 
        boneWeights: number[], 
        indices: number[] | null = null
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

        if (indices) {
            this._indexBuffer = gl.createBuffer() as WebGLBuffer;
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._indexBuffer);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
            this._indexCount = indices.length;
        }

        this._isAnimated = true;
        GLState.bindVAO(null);

        return this;
    }

    public draw(mode: number = gl.TRIANGLES): void {
        GLState.bindVAO(this._vertexArray);
        if (this._indexBuffer && this._indexCount > 0)
            gl.drawElements(mode, this._indexCount, gl.UNSIGNED_SHORT, 0);
        else
            gl.drawArrays(mode, 0, this._vertexCount);
    }

    public drawInstanced(instanceCount: number, mode: number = gl.TRIANGLES): void {
        GLState.bindVAO(this._vertexArray);
        if (this._indexBuffer && this._indexCount > 0)
            gl.drawElementsInstanced(mode, this._indexCount, gl.UNSIGNED_SHORT, 0, instanceCount);
        else
            gl.drawArraysInstanced(mode, 0, this._vertexCount, instanceCount);
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
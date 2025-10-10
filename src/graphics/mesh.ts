import { gl } from './renderer';

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
        gl.bindVertexArray(this._vertexArray);
        
        gl.bindBuffer(gl.ARRAY_BUFFER, this._vertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
        this._vertexCount = vertex_count;

        if (indices) {
            this._indexBuffer = gl.createBuffer() as WebGLBuffer;
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._indexBuffer);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
            this._indexCount = indices.length;
        }

        gl.bindVertexArray(null);

        return this;
    }

    public createAnimated(
        vertices: number[], 
        vertex_count: number, 
        boneIndices: number[], 
        boneWeights: number[], 
        indices: number[] | null = null
    ): Mesh {
        gl.bindVertexArray(this._vertexArray);
        
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
        gl.bindVertexArray(null);

        return this;
    }

    public draw(mode: number = gl.TRIANGLES): void {
        gl.bindVertexArray(this._vertexArray);
        if (this._indexBuffer && this._indexCount > 0)
            gl.drawElements(mode, this._indexCount, gl.UNSIGNED_SHORT, 0);
        else
            gl.drawArrays(mode, 0, this._vertexCount);

        gl.bindVertexArray(null);
    }

    public initializeVAO(attributes: any): void {
        gl.bindVertexArray(this._vertexArray);

        gl.bindBuffer(gl.ARRAY_BUFFER, this._vertexBuffer);

        for (let attr of attributes) {
            gl.enableVertexAttribArray(attr.location);
            gl.vertexAttribPointer(attr.location, attr.layout.size, attr.layout.type, false, attr.layout.stride, attr.layout.offset);
        }

        gl.bindVertexArray(null);
    }

    public initializeAnimatedVAO(attributes: any): void {
        if (!this._isAnimated || !this._boneIndicesBuffer || !this._boneWeightsBuffer) {
            throw new Error('Mesh is not animated or bone buffers are not initialized');
        }

        gl.bindVertexArray(this._vertexArray);

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

        gl.bindVertexArray(null);
    }

    public get vertexArray(): WebGLVertexArrayObject { return this._vertexArray; }
    public get vertexBuffer(): WebGLBuffer { return this._vertexBuffer; }
    public get isAnimated(): boolean { return this._isAnimated; }
}
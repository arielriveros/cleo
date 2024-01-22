import { gl } from './renderer';

export class Mesh {
    private _vertexArray: WebGLVertexArrayObject;
    private _vertexBuffer: WebGLBuffer;
    private _indexBuffer: WebGLBuffer | null;
    private _vertexCount: number;
    private _indexCount: number;

    constructor() {
        this._vertexArray = gl.createVertexArray() as WebGLVertexArrayObject;
        this._vertexBuffer = gl.createBuffer() as WebGLBuffer;
        this._indexBuffer = null;
        this._vertexCount = 0;
        this._indexCount = 0;
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

    public get vertexArray(): WebGLVertexArrayObject { return this._vertexArray; }
    public get vertexBuffer(): WebGLBuffer { return this._vertexBuffer; }
}
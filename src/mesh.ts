import { gl } from './renderer';

export class Mesh {
    private _vertexArray: WebGLVertexArrayObject;
    private _vertexBuffer: WebGLBuffer;
    private _indexBuffer: WebGLBuffer | null;

    constructor() {
        this._vertexArray = gl.createVertexArray() as WebGLVertexArrayObject;
        this._vertexBuffer = gl.createBuffer() as WebGLBuffer;
        this._indexBuffer = null;
    }

    public create(vertices: number[], indices: number[] | null = null): Mesh {
        gl.bindVertexArray(this._vertexArray);
        
        gl.bindBuffer(gl.ARRAY_BUFFER, this._vertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);

        if (indices) {
            this._indexBuffer = gl.createBuffer() as WebGLBuffer;
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._indexBuffer);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
        }

        gl.bindVertexArray(null);

        return this;
    }

    public draw(): void {
        gl.bindVertexArray(this._vertexArray);

        if (this._indexBuffer)
            gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
        else
            gl.drawArrays(gl.TRIANGLES, 0, 6);

        gl.bindVertexArray(null);
    }

    public get vertexArray(): WebGLVertexArrayObject { return this._vertexArray; }
    public get vertexBuffer(): WebGLBuffer { return this._vertexBuffer; }
}

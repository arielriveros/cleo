import { gl } from './app';

type AttributeInfo = {
    name: string,   // name of the attribute
    type: string,   // human readable type of the attribute
    size: number    // size of the attribute in bytes
}

export class Shader {
    private _shaderProgram!: WebGLProgram;
    private _vertexShader!: WebGLShader;
    private _fragmentShader!: WebGLShader;
    private _attributes: AttributeInfo[] = [];

    constructor() {
        let vs = gl.createShader(gl.VERTEX_SHADER);
        if (!vs) throw new Error('Error creating vertex shader');
        this._vertexShader = vs;

        const fs = gl.createShader(gl.FRAGMENT_SHADER);
        if (!fs) throw new Error('Error creating fragment shader');
        this._fragmentShader = fs;
    }

    public create(vertexSource: string, fragmentSource: string): void {
        gl.shaderSource(this._vertexShader, vertexSource);
        gl.compileShader(this._vertexShader);
        gl.compileShader(this._vertexShader);
        if (!gl.getShaderParameter(this._vertexShader, gl.COMPILE_STATUS))
            throw new Error(gl.getShaderInfoLog(this._vertexShader) || 'Unknown error creating vertex shader');

        gl.shaderSource(this._fragmentShader, fragmentSource);
        gl.compileShader(this._fragmentShader);
        if (!gl.getShaderParameter(this._fragmentShader, gl.COMPILE_STATUS))
            throw new Error(gl.getShaderInfoLog(this._fragmentShader) || 'Unknown error creating fragment shader');

        this._shaderProgram = gl.createProgram() as WebGLProgram;
        gl.attachShader(this._shaderProgram, this._vertexShader);
        gl.attachShader(this._shaderProgram, this._fragmentShader);
        gl.linkProgram(this._shaderProgram);

        if (!gl.getProgramParameter(this._shaderProgram, gl.LINK_STATUS))
            throw new Error(gl.getProgramInfoLog(this._shaderProgram) || 'Unknown error creating program');

        this.storeAttributes();
    }

    public use(): void {
        // Use the program only if it is not already in use
        if (gl.getParameter(gl.CURRENT_PROGRAM) !== this._shaderProgram)
            gl.useProgram(this._shaderProgram);
    }

    public getAttribLocation(name: string): number {
        return gl.getAttribLocation(this._shaderProgram, name);
    }

    private storeAttributes(): void {
        const numAttribs = gl.getProgramParameter(this._shaderProgram, gl.ACTIVE_ATTRIBUTES);
        for (let i = 0; i < numAttribs; i++) {
            const attribInfo = gl.getActiveAttrib(this._shaderProgram, i);
            if (!attribInfo) break;
            this._attributes.push(
                {
                    name: attribInfo.name,
                    type: this.getAttributeType(attribInfo.type),
                    size: this.getAttributeByteSize(attribInfo.type)
                });
        }

        console.log(this._attributes);
    }

    private getAttributeType(type: number): string {
        switch (type) {
            case gl.FLOAT: return 'float';
            case gl.FLOAT_VEC2: return 'vec2';
            case gl.FLOAT_VEC3: return 'vec3';
            case gl.FLOAT_VEC4: return 'vec4';
            case gl.FLOAT_MAT2: return 'mat2';
            case gl.FLOAT_MAT3: return 'mat3';
            case gl.FLOAT_MAT4: return 'mat4';
            case gl.INT: return 'int';
            case gl.INT_VEC2: return 'ivec2';
            case gl.INT_VEC3: return 'ivec3';
            case gl.INT_VEC4: return 'ivec4';
            case gl.BOOL: return 'bool';
            case gl.BOOL_VEC2: return 'bvec2';
            case gl.BOOL_VEC3: return 'bvec3';
            case gl.BOOL_VEC4: return 'bvec4';
            case gl.SAMPLER_2D: return 'sampler2D';
            case gl.SAMPLER_CUBE: return 'samplerCube';
            default: return 'unknown';
        }
    
    }

    private getAttributeByteSize(type: number): number {
        switch (type) {
            case gl.FLOAT:
            case gl.INT:
            case gl.UNSIGNED_INT:
                return 4;

            case gl.SHORT:
            case gl.UNSIGNED_SHORT:
                return 2;

            case gl.BYTE:
            case gl.UNSIGNED_BYTE:
                return 1;

            case gl.FLOAT_VEC2:
            case gl.INT_VEC2:
            case gl.BOOL_VEC2:
                return 8;

            case gl.FLOAT_VEC3:
            case gl.INT_VEC3:
            case gl.BOOL_VEC3:
                return 12;

            case gl.FLOAT_VEC4:
            case gl.INT_VEC4:
            case gl.BOOL_VEC4:
                return 16;

            default: return 0;
        }
    }
}
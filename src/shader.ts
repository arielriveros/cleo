import { gl } from './renderer';

type AttributeLayout = {
    size: number,
    type: number,
    normalized: boolean,
    stride: number,
    offset: number
}

type AttributeInfo = {
    name: string,       // name of the attribute
    type: string,       // human readable type of the attribute
    byteSize: number,   // size of the attribute in bytes
    location: number    // location of the attribute in the shader program
    layout: AttributeLayout
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

    public createFromFiles(vertexShaderPath: string, fragmentShaderPath: string): void {
        const vertexShaderSource = this.loadShaderSource(vertexShaderPath);
        const fragmentShaderSource = this.loadShaderSource(fragmentShaderPath);
        this.create(vertexShaderSource, fragmentShaderSource);
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

    setUniform(name: string, type: string, value: any) {
        const location = gl.getUniformLocation(this._shaderProgram, name);
        if (!location) throw new Error(`Uniform ${name} not found`);
    
        switch (type) {
            case 'float':
                gl.uniform1f(location, value);
                break;
    
            case 'vec2':
                gl.uniform2fv(location, value);
                break;
    
            case 'vec3':
                gl.uniform3fv(location, value);
                break;
    
            case 'vec4':
                gl.uniform4fv(location, value);
                break;
    
            case 'mat2':
                gl.uniformMatrix2fv(location, false, value);
                break;
    
            case 'mat3':
                gl.uniformMatrix3fv(location, false, value);
                break;
    
            case 'mat4':
                gl.uniformMatrix4fv(location, false, value);
                break;
    
            case 'int':
                gl.uniform1i(location, value);
                break;
    
            case 'ivec2':
                gl.uniform2iv(location, value);
                break;
    
            case 'ivec3':
                gl.uniform3iv(location, value);
                break;
    
            case 'ivec4':
                gl.uniform4iv(location, value);
                break;
    
            case 'bool':
                gl.uniform1i(location, value);
                break;
    
            case 'bvec2':
                gl.uniform2iv(location, value);
                break;
    
            case 'bvec3':
                gl.uniform3iv(location, value);
                break;
    
            case 'bvec4':
                gl.uniform4iv(location, value);
                break;
    
            case 'sampler2D':
                gl.uniform1i(location, value);
                break;
    
            case 'samplerCube':
                gl.uniform1i(location, value);
                break;
    
            default:
                throw new Error(`Unknown uniform type ${type}`);
        }
    }

    private loadShaderSource(path: string): string {
        const request = new XMLHttpRequest();
        request.open('GET', path, false);
        request.send();

        if (request.status !== 200)
            throw new Error(`Error getting shader source: ${path}`);

        return request.responseText;
    }

    private storeAttributes(): void {
        const numAttribs = gl.getProgramParameter(this._shaderProgram, gl.ACTIVE_ATTRIBUTES);
        let attributesStride = 0;
    
        for (let i = 0; i < numAttribs; i++) {
            const attribInfo = gl.getActiveAttrib(this._shaderProgram, i);
            if (!attribInfo) break;
    
            // TODO: Handle other types, 4 is the default for floats
            attributesStride += this.getTypeSize(attribInfo.type) * 4;
        }
    
        let offset = 0; // Start offset at 0
    
        for (let i = 0; i < numAttribs; i++) {
            const attribInfo = gl.getActiveAttrib(this._shaderProgram, i);
            if (!attribInfo) break;
    
            const byteSize = this.getTypeByteSize(attribInfo.type);
    
            this._attributes.push(
                {
                    name: attribInfo.name,
                    type: this.getTypeName(attribInfo.type),
                    byteSize: byteSize,
                    location: gl.getAttribLocation(this._shaderProgram, attribInfo.name),
                    layout: {
                        size: byteSize / 4, // Assuming each component is a 4-byte float
                        type: gl.FLOAT,     // TODO: Handle types other than floats
                        normalized: false,
                        stride: attributesStride,
                        offset: offset,
                    },
                }
            );
    
            // Update the offset for the next attribute
            offset += byteSize;
        }
    
        console.log(this._attributes);
    }

    private getTypeName(type: number): string {
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

    private getTypeByteSize(type: number): number {
        switch (type) {
            case gl.BYTE:
            case gl.UNSIGNED_BYTE:
                return 1;

            case gl.SHORT:
            case gl.UNSIGNED_SHORT:
                return 2;

            case gl.FLOAT:
            case gl.INT:
            case gl.UNSIGNED_INT:
                return 4;

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

    private getTypeSize(type: number): number {
        switch (type) {
            case gl.FLOAT:
            case gl.INT:
            case gl.UNSIGNED_INT:
            case gl.SHORT:
            case gl.UNSIGNED_SHORT:
            case gl.BYTE:
            case gl.UNSIGNED_BYTE:
                return 1;

            case gl.FLOAT_VEC2:
            case gl.INT_VEC2:
            case gl.BOOL_VEC2:
                return 2;

            case gl.FLOAT_VEC3:
            case gl.INT_VEC3:
            case gl.BOOL_VEC3:
                return 3;

            case gl.FLOAT_VEC4:
            case gl.INT_VEC4:
            case gl.BOOL_VEC4:
                return 4;

            default: return 0;
        }
    }

    public get attributes(): AttributeInfo[] { return this._attributes; }
}
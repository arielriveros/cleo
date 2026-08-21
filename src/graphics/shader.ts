import { mat4, vec2, vec3, vec4 } from 'gl-matrix';
import { gl } from './glContext';
import { Loader } from './loader';
import { GLState } from './systems/glState';


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

type UniformInfo = {
    type: string,   // human readable type of the uniform
    size: number,   // size of the uniform
    byteSize: number,   // size of the uniform in bytes
    location: WebGLUniformLocation
}

export class Shader {
    private _shaderProgram!: WebGLProgram;
    private _vertexShader!: WebGLShader;
    private _fragmentShader!: WebGLShader;
    private _attributes: AttributeInfo[] = [];
    private _uniforms: {
        [name: string]: {info: UniformInfo, value: any}
    } = {};

    constructor() {
        let vs = gl.createShader(gl.VERTEX_SHADER);
        if (!vs) throw new Error('Error creating vertex shader');
        this._vertexShader = vs;

        const fs = gl.createShader(gl.FRAGMENT_SHADER);
        if (!fs) throw new Error('Error creating fragment shader');
        this._fragmentShader = fs;
    }

    public create(vertexSource: string, fragmentSource: string): Shader {
        gl.shaderSource(this._vertexShader, vertexSource);
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

        // The linked program keeps its own reference to both shader objects, so dropping ours here frees
        // them as soon as the program is deleted (or immediately, for a program that never links). Nothing
        // reads these fields after this point — they exist only to carry source between the constructor
        // and the link above.
        gl.deleteShader(this._vertexShader);
        gl.deleteShader(this._fragmentShader);
        this._vertexShader = null!;
        this._fragmentShader = null!;

        this.storeAttributes();
        this.storeUniforms();

        return this;
    }

    /**
     * Releases this shader's GL objects. Idempotent, and safe on a shader whose `create()` threw — the
     * constructor allocates the two shader objects before any source is compiled, so a shader that failed
     * to compile still owns GL memory.
     *
     * There is no finalizer for GL objects: dropping the last JS reference to a Shader frees nothing, the
     * program simply leaks for the lifetime of the context. Anything that compiles a program it does not
     * intend to keep must call this.
     */
    public dispose(): void {
        if (this._shaderProgram) {
            // GLState dedupes useProgram by identity, so if this program is the cached one the next
            // useProgram() for it would be SKIPPED and a deleted program left bound. Invalidate first.
            if (GLState.currentProgram === this._shaderProgram) GLState.reset();
            gl.deleteProgram(this._shaderProgram);
            this._shaderProgram = null!;
        }
        // Normally already released at the end of create(); still set if create() never ran or threw.
        if (this._vertexShader) { gl.deleteShader(this._vertexShader); this._vertexShader = null!; }
        if (this._fragmentShader) { gl.deleteShader(this._fragmentShader); this._fragmentShader = null!; }
        this._attributes = [];
        this._uniforms = {};
    }

    public use(): void {
        // Use the program only if it is not already in use (deduped by the GL state cache)
        GLState.useProgram(this._shaderProgram);
    }

    public setUniform(name: string, value: any) {
        const uniform = this._uniforms[name];
        if (!uniform) return;
        uniform.value = value;
        this._setUniform(uniform.info.location, uniform.info.type, value);
    }

    private _setUniform(location: WebGLUniformLocation, type: string, value: any) {
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
    
            // Every sampler type is set identically: the texture UNIT index, as an int.
            case 'sampler2D':
            case 'samplerCube':
            case 'sampler3D':
            case 'sampler2DArray':
            case 'sampler2DArrayShadow':
            case 'sampler2DShadow':
            case 'samplerCubeShadow':
            case 'isampler2D':
            case 'isampler3D':
            case 'isamplerCube':
            case 'isampler2DArray':
            case 'usampler2D':
            case 'usampler3D':
            case 'usamplerCube':
            case 'usampler2DArray':
                gl.uniform1i(location, value);
                break;

            default:
                throw new Error(`Unknown uniform type ${type}`);
        }
    }

    public hasUniform(name: string) {
        return name in this._uniforms;
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
    }

    private storeUniforms(): void {
        const numUniforms = gl.getProgramParameter(this._shaderProgram, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < numUniforms; i++) {
            const uniformInfo = gl.getActiveUniform(this._shaderProgram, i);
            if (!uniformInfo) break;

            const location = gl.getUniformLocation(this._shaderProgram, uniformInfo.name);
            if (!location) continue;

            const type = this.getTypeName(uniformInfo.type);
            const size = uniformInfo.size;
            const byteSize = this.getTypeByteSize(uniformInfo.type);
            const name = uniformInfo.name;

            let defaultValue;

            switch (type) {
                case 'int':
                case 'float':
                    defaultValue = 0;
                    break;
                case 'vec2':
                    defaultValue = vec2.create();
                    break;
                case 'vec3':
                    defaultValue = vec3.create();
                    break;
                case 'vec4':
                    defaultValue = vec4.create();
                    break;
                case 'mat4':
                    defaultValue = mat4.create();
                    break;
                case 'bool':
                    defaultValue = false;
                    break;
                case 'sampler2D':
                case 'samplerCube':
                case 'sampler3D':
                case 'sampler2DArray':
                case 'sampler2DArrayShadow':
                case 'sampler2DShadow':
                case 'samplerCubeShadow':
                case 'isampler2D':
                case 'isampler3D':
                case 'isamplerCube':
                case 'isampler2DArray':
                case 'usampler2D':
                case 'usampler3D':
                case 'usamplerCube':
                case 'usampler2DArray':
                    defaultValue = 0; // texture unit 0
                    break;
                // These are all already handled by _setUniform and named by getTypeName; only this
                // switch was missing them, so declaring e.g. an ivec2 uniform threw at link time
                // even though setting one would have worked fine.
                case 'ivec2':
                    defaultValue = [0, 0];
                    break;
                case 'ivec3':
                    defaultValue = [0, 0, 0];
                    break;
                case 'ivec4':
                    defaultValue = [0, 0, 0, 0];
                    break;
                case 'bvec2':
                    defaultValue = [0, 0];
                    break;
                case 'bvec3':
                    defaultValue = [0, 0, 0];
                    break;
                case 'bvec4':
                    defaultValue = [0, 0, 0, 0];
                    break;
                case 'mat2':
                    defaultValue = [1, 0, 0, 1];
                    break;
                case 'mat3':
                    defaultValue = [1, 0, 0, 0, 1, 0, 0, 0, 1];
                    break;
                default:
                    throw new Error(`Uniform type ${type} not supported`);
            }

            this._uniforms[name] = {
                info: {
                    type: type,
                    size: size,
                    byteSize: byteSize,
                    location: location,
                },
                value: defaultValue
            };
        }
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
            case gl.SAMPLER_3D: return 'sampler3D';
            // WebGL2 sampler types. All are set the same way (a texture unit index via uniform1i);
            // they are listed individually because reflection matches on the exact GL enum.
            case gl.SAMPLER_2D_ARRAY: return 'sampler2DArray';
            case gl.SAMPLER_2D_ARRAY_SHADOW: return 'sampler2DArrayShadow';
            case gl.SAMPLER_2D_SHADOW: return 'sampler2DShadow';
            case gl.SAMPLER_CUBE_SHADOW: return 'samplerCubeShadow';
            case gl.INT_SAMPLER_2D: return 'isampler2D';
            case gl.INT_SAMPLER_3D: return 'isampler3D';
            case gl.INT_SAMPLER_CUBE: return 'isamplerCube';
            case gl.INT_SAMPLER_2D_ARRAY: return 'isampler2DArray';
            case gl.UNSIGNED_INT_SAMPLER_2D: return 'usampler2D';
            case gl.UNSIGNED_INT_SAMPLER_3D: return 'usampler3D';
            case gl.UNSIGNED_INT_SAMPLER_CUBE: return 'usamplerCube';
            case gl.UNSIGNED_INT_SAMPLER_2D_ARRAY: return 'usampler2DArray';
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

            case gl.FLOAT_MAT2:
                return 16;

            case gl.FLOAT_MAT3:
                return 36;

            case gl.FLOAT_MAT4:
                return 64;

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
    public get uniforms(): { [name: string]: {info: UniformInfo, value: any} } { return this._uniforms; }
    public get program(): WebGLProgram { return this._shaderProgram; }
}
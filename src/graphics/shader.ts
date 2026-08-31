import { mat4, vec2, vec3, vec4 } from 'gl-matrix';
import { gl } from './glContext';
import { Loader } from './loader';
import { GLState } from './systems/glState';
import { UniformBlockSet } from './systems/uniformBlocks';


import type { ShaderProgram, AttributeInfo } from './rhi/shaderProgram';

type UniformInfo = {
    type: string,   // human readable type of the uniform
    size: number,   // size of the uniform
    byteSize: number,   // size of the uniform in bytes
    location: WebGLUniformLocation
}

export class Shader implements ShaderProgram {
    private _shaderProgram!: WebGLProgram;
    private _vertexShader!: WebGLShader;
    private _fragmentShader!: WebGLShader;
    private _attributes: AttributeInfo[] = [];
    private _uniforms: {
        [name: string]: {info: UniformInfo, value: any}
    } = {};
    // std140 blocks, for programs generated from WGSL. Null for hand-written GLSL, which has loose
    // uniforms instead. See systems/uniformBlocks.ts.
    private _blocks: UniformBlockSet | null = null;

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

        // The linked program holds its own reference, so dropping ours frees these with the program.
        gl.deleteShader(this._vertexShader);
        gl.deleteShader(this._fragmentShader);
        this._vertexShader = null!;
        this._fragmentShader = null!;

        this.storeAttributes();
        this.storeUniforms();
        // Must follow storeUniforms: `getUniformLocation` returns null for block members, so they are
        // invisible to the loose-uniform path and need reflecting separately.
        this._blocks = UniformBlockSet.reflect(this._shaderProgram);

        return this;
    }

    /**
     * Release this shader's GL objects. Idempotent, and safe on a shader whose `create()` threw. Required:
     * dropping the last JS reference frees nothing, and the program leaks for the context's lifetime.
     */
    public dispose(): void {
        if (this._shaderProgram) {
            // GLState dedupes useProgram by identity, so a deleted program left cached would make the
            // next useProgram a no-op. Invalidate first.
            if (GLState.currentProgram === this._shaderProgram) GLState.reset();
            gl.deleteProgram(this._shaderProgram);
            this._shaderProgram = null!;
        }
        // Normally already released at the end of create(); still set if create() never ran or threw.
        if (this._vertexShader) { gl.deleteShader(this._vertexShader); this._vertexShader = null!; }
        if (this._fragmentShader) { gl.deleteShader(this._fragmentShader); this._fragmentShader = null!; }
        this._attributes = [];
        this._uniforms = {};
        this._blocks?.dispose();
        this._blocks = null;
    }

    public use(): void {
        // Use the program only if it is not already in use (deduped by the GL state cache)
        const switching = GLState.currentProgram !== this._shaderProgram;
        GLState.useProgram(this._shaderProgram);

        // Indexed UNIFORM_BUFFER binding points are global, so another program's blocks displace ours.
        // Only on the switch: nothing can disturb them while this program stays bound.
        if (switching && this._blocks) this._blocks.bind();
    }

    public setUniform(name: string, value: any) {
        const uniform = this._uniforms[name];
        if (!uniform) {
            // Not a loose uniform, but possibly a block member: those have no location, and their
            // writes go to a CPU buffer uploaded by `flush()`.
            this._blocks?.set(name, value);
            return;
        }
        uniform.value = value;
        this._setUniform(uniform.info.location, uniform.info.type, value, uniform.info.size);
    }

    /** Upload any block writes made since the last flush. Call immediately before a draw. */
    public flushUniformBlocks(): void { this._blocks?.flush(); }

    /** Whether this program carries std140 blocks — i.e. whether it was generated from WGSL. */
    public get hasUniformBlocks(): boolean { return this._blocks !== null; }

    // `size` is the ARRAY length GL reported, 1 for a scalar. It matters only for types whose
    // single-element form is not already a `*v` call — a `float[4]` through `uniform1f` writes one.
    private _setUniform(location: WebGLUniformLocation, type: string, value: any, size: number = 1) {
        switch (type) {
            case 'float':
                if (size > 1) gl.uniform1fv(location, value);
                else gl.uniform1f(location, value);
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
                if (size > 1) gl.uniform1iv(location, value);
                else gl.uniform1i(location, value);
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
                if (size > 1) gl.uniform1iv(location, value);
                else gl.uniform1i(location, value);
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
                if (size > 1) gl.uniform1iv(location, value);
                else gl.uniform1i(location, value);
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

            const entry = {
                info: {
                    type: type,
                    size: size,
                    byteSize: byteSize,
                    location: location,
                },
                value: defaultValue
            };
            this._uniforms[name] = entry;

            // GL reports an array uniform as `u_name[0]`, and that is the only name
            // `getUniformLocation` accepts. Alias the stripped name onto the same entry so the bare
            // name works under either layout — loose array here, block member via UniformBlockSet.
            const stripped = name.endsWith('[0]') ? name.slice(0, -3) : null;
            if (stripped && !(stripped in this._uniforms)) this._uniforms[stripped] = entry;
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
            // WebGL2 sampler types, listed individually because reflection matches the exact GL enum.
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
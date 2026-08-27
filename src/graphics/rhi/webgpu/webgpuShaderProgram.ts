// A shader program on WebGPU: the counterpart to `graphics/shader.ts`, sharing only its shape.
// `use()` is bookkeeping, uniforms are bytes at build-time offsets, and attributes come declared off
// the `.wgsl` import rather than being reflected.

import type { Device } from '../device';
import type { ShaderProgram, AttributeInfo } from '../shaderProgram';
import type { UniformBlockLayout } from '../uniformSet';
import { ProgramUniforms } from '../uniformSet';
import { vertexFormatSize } from '../types';
import type { VertexFormat } from '../types';

/** One `@location(N)` vertex input, as the `.wgsl` loader reflects it. */
export interface WgslVertexInput {
    readonly name: string;
    readonly location: number;
    readonly type: string;
}

// WGSL scalar/vector types to the vertex format they arrive as. An unlisted type must throw, not
// default: a wrong byte size is a wrong stride, and a wrong stride draws plausible garbage.
const VERTEX_FORMATS: Readonly<Record<string, VertexFormat>> = {
    'f32': 'float32',
    'vec2<f32>': 'float32x2',
    'vec3<f32>': 'float32x3',
    'vec4<f32>': 'float32x4',
    'vec4<i32>': 'sint32x4',
    'vec4<u32>': 'uint32x4',
};

export class WebGPUShaderProgram implements ShaderProgram {
    public readonly attributes: AttributeInfo[];
    private readonly _uniforms: ProgramUniforms;
    private _disposed = false;

    /** The program name, so a bind group built from it can name its source in the label. */
    public readonly label: string;

    constructor(private readonly _device: Device, label: string,
                vertexInputs: readonly WgslVertexInput[],
                blocks: readonly UniformBlockLayout[],
                /** `minUniformBufferOffsetAlignment`, from the adapter. Spaces a uniform arena's slots. */
                uniformOffsetAlignment?: number,
                /** Told when this program is disposed, so the device can drop it from its registry. */
                private readonly _onDispose?: (program: WebGPUShaderProgram) => void) {
        this.attributes = vertexInputs.map(input => {
            const format = VERTEX_FORMATS[input.type];
            if (!format)
                throw new Error(`${label}: vertex input "${input.name}" has type "${input.type}", ` +
                                'which has no vertex format mapping');
            return {
                name: input.name,
                type: input.type,
                byteSize: vertexFormatSize(format),
                location: input.location,
                // `layout` is deliberately absent — WebGPU carries vertex formats on the pipeline.
            };
        });
        this.label = label;
        this._uniforms = new ProgramUniforms(_device, blocks, label, uniformOffsetAlignment);
    }

    /** The blocks, so a caller can build the uniform bind groups from their buffers. */
    public get uniforms(): ProgramUniforms { return this._uniforms; }

    /** Nothing to do: WebGPU has no current-program state. Present only to satisfy the interface. */
    public use(): void { /* no current-program state on WebGPU */ }

    public setUniform(name: string, value: any): void { this._uniforms.set(name, value); }

    public hasUniform(name: string): boolean {
        return this._uniforms.blocks.some(block => block.has(name));
    }

    public flushUniformBlocks(): void { this._uniforms.flush(this._device); }

    public describeBlockLayout(): unknown[] {
        return this._uniforms.blocks.map(block => ({
            name: block.layout.name,
            group: block.layout.group,
            binding: block.layout.binding,
            size: block.layout.size,
            members: block.layout.flat.map(m => ({ name: m.name, offset: m.offset, size: m.size })),
        }));
    }

    public dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        this._uniforms.destroy();
        this._onDispose?.(this);
    }
}

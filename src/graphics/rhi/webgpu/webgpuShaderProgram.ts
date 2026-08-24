/**
 * A shader program on WebGPU.
 *
 * The counterpart to `graphics/shader.ts`, and it shares no code with it — only the
 * {@link ShaderProgram} shape. That is the whole point of the interface: WebGL2 links a program,
 * reflects its uniforms and dispatches `gl.uniform*` by location; WebGPU has none of those steps.
 *
 * - **`use()` is bookkeeping.** There is no `useProgram`: a pipeline carries its own module, and the
 *   pass binds the pipeline. Nothing to switch, nothing to rebind.
 * - **Uniforms are bytes.** No reflection exists to ask where a member lives, so the offsets come from
 *   the WGSL layout rules at build time and {@link ProgramUniforms} routes a name to the block that
 *   declares it. Both are verified against a real driver — `harness:uniforms` for the offsets,
 *   `harness:webgpu` for the routing.
 * - **Attributes are declared, not discovered.** `vertexInputs` comes off the `.wgsl` import, read
 *   from the same declaration the translator renames for GLSL.
 */

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

/**
 * WGSL scalar/vector types to the vertex format they arrive as.
 *
 * Only the float and signed-integer shapes the engine actually declares. An unlisted type is a
 * mistake worth hearing about rather than guessing at: silently defaulting to `float32x3` would give
 * a wrong byte size, and a wrong byte size is a stride, and a wrong stride draws plausible garbage.
 */
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

    /** The program name. Kept so a bind group built from this program can SAY so - see
     *  `WebGPURenderPipeline.uniformGroupsFor`, where a label naming only the pipeline once hid a
     *  pipeline being fed another program's uniform buffers. */
    public readonly label: string;

    constructor(private readonly _device: Device, label: string,
                vertexInputs: readonly WgslVertexInput[],
                blocks: readonly UniformBlockLayout[]) {
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
                // `layout` is deliberately absent: it is the four arguments `vertexAttribPointer`
                // wants, and WebGPU carries vertex formats on the pipeline instead.
            };
        });
        this.label = label;
        this._uniforms = new ProgramUniforms(_device, blocks, label);
    }

    /** The blocks, so a caller can build the uniform bind groups from their buffers. */
    public get uniforms(): ProgramUniforms { return this._uniforms; }

    /**
     * Nothing to do.
     *
     * Not an oversight and not a TODO: WebGPU has no current-program state. The pipeline carries the
     * module, the pass binds the pipeline, and a program is never "in use" independently of a draw.
     * The method exists because the engine calls it ~30 times a frame and must not learn which
     * backend it is talking to.
     */
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
    }
}
